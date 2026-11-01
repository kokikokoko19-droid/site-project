// FANZA 取り込み処理（差分更新）のテスト。fetch を差し替えた合成レスポンスだけを使うので、実際の通信は一切しない。
// テストデータはすべて合成（実在の作品名や実際の API 応答は使わない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/data/api.ts';
import { openDb } from '../src/data/db.ts';
import type { Db } from '../src/data/db.ts';
import { ingestRanked, ingestRecent, ingestSynthetic, ingestWindow, refreshExisting } from '../src/data/ingest.ts';
import type { IngestProgress } from '../src/data/ingest.ts';
import { normalizeItems } from '../src/data/normalize.ts';

type Item = { content_id: string; title: string };
type Reply = { total: number; items?: Item[]; resultCount?: number };
const CLIENT_OPTS = { apiId: 'TEST_API_ID_DUMMY', affiliateId: 'testaff-990', minIntervalMs: 0, maxRetries: 0, sleep: async () => {} };
const oneDay = ['2026-10-01T00:00:00', '2026-10-01T23:59:59'] as const;

// respond の返す内容を、実応答と同じ外枠（request に API ID が入る）の ItemList 応答にして返すクライアント。
// 呼ばれた URL を urls に記録する。items を省くと、実 API の 0 件と同じく items のキー自体が欠落する。
function setup(respond: (q: URLSearchParams) => Reply) {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const r = respond(url.searchParams);
    const result = {
      status: 200, result_count: r.resultCount ?? r.items?.length ?? 0, total_count: r.total,
      first_position: Number(url.searchParams.get('offset') ?? 1), ...(r.items && { items: r.items }),
    };
    return new Response(JSON.stringify({ request: { parameters: { api_id: 'TEST_API_ID_DUMMY' } }, result }));
  }) as typeof fetch;
  return { client: createClient({ ...CLIENT_OPTS, fetchImpl }), urls };
}
// total 件のうち、リクエストの offset から hits 件ぶんの合成 item。content_id は「並び順＋窓の始点＋位置」で窓ごとに重ならない。
function pageItems(q: URLSearchParams, total: number): Item[] {
  const offset = Number(q.get('offset'));
  const n = Math.max(0, Math.min(Number(q.get('hits')), total - offset + 1));
  const prefix = `${q.get('sort')}${(q.get('gte_date') ?? '').replace(/\D/g, '')}`;
  return Array.from({ length: n }, (_, i) => ({ content_id: `${prefix}-${String(offset + i).padStart(6, '0')}`, title: `テスト作品${offset + i}` }));
}
// 標準の応答: cid 指定ならその作品を1件、それ以外は total 件のうち該当ページ
const standard = (total: number) => (q: URLSearchParams): Reply =>
  q.has('cid') ? { total: 1, items: [{ content_id: q.get('cid')!, title: `新-${q.get('cid')}` }] } : { total, items: pageItems(q, total) };
// 再取得用の応答: goneIds の cid は 0 件（items なし）、それ以外は返す
const refreshApi = (...goneIds: string[]) => (q: URLSearchParams): Reply =>
  goneIds.includes(q.get('cid')!) ? { total: 0, resultCount: 0 } : standard(1)(q);
const offsetsOf = (urls: URL[]) => urls.map((u) => Number(u.searchParams.get('offset')));
const secs = (s: string) => Date.parse(`${s}Z`) / 1000;
// 既存の active 作品を ids の分だけ入れる
function seed(db: Db, ids: string[]): void {
  const items = ids.map((content_id) => ({ content_id, title: `旧-${content_id}` }));
  db.upsertWorks(normalizeItems(items, { fetchedAt: '2026-10-01T00:00:00.000Z' }));
}

test('ingestWindow: offset は 1 始まりで hits ずつ進む（total 250・hits 100 なら 1, 101, 201 の3回）', async () => {
  const db = openDb(':memory:');
  const { client, urls } = setup(standard(250));
  const r = await ingestWindow(client, db, { gteDate: oneDay[0], lteDate: oneDay[1] });
  assert.deepEqual(offsetsOf(urls), [1, 101, 201]);
  assert.deepEqual(r, { fetched: 250, upserted: 250, windows: 1 });
  assert.equal(db.countWorks('active'), 250);
  const q = urls[0]!.searchParams;
  assert.deepEqual([q.get('sort'), q.get('hits'), q.get('gte_date'), q.get('lte_date')], ['date', '100', ...oneDay]);
});

test('ingestWindow: 最初の応答の total が 60000 なら中点で分割し、分割後の窓は 50000 未満として取得する', async () => {
  const db = openDb(':memory:');
  const whole = ['2026-10-01T00:00:00', '2026-10-31T23:59:59'] as const;
  const span = (q: URLSearchParams) => secs(q.get('lte_date')!) - secs(q.get('gte_date')!);
  // 10日を超える窓は 60000 件、それ以下は 120 件（全体は 31 日なので、最初の応答は 60000 になり、再帰して分割される）
  const { client, urls } = setup((q) => { const total = span(q) > 10 * 86400 ? 60000 : 120; return { total, items: pageItems(q, total) }; });
  const infos: IngestProgress[] = [];
  const r = await ingestWindow(client, db, { gteDate: whole[0], lteDate: whole[1], onProgress: (i) => infos.push(i) });
  const windows = [...new Set(urls.map((u) => `${u.searchParams.get('gte_date')}|${u.searchParams.get('lte_date')}`))]
    .map((s) => s.split('|') as [string, string]);
  assert.deepEqual(windows[0], [...whole]); // 最初に全体の窓を問い合わせる
  const leaves = windows.filter(([g, l]) => secs(l) - secs(g) <= 10 * 86400).sort((a, b) => secs(a[0]) - secs(b[0]));
  assert.ok(leaves.length >= 2); // 分割後の窓（total は 120 で 50000 未満）
  assert.equal(leaves[0]![0], whole[0]);
  assert.equal(leaves.at(-1)![1], whole[1]);
  leaves.slice(1).forEach(([g], i) => assert.equal(secs(g) - secs(leaves[i]![1]), 1)); // 重ならず、隙間もない
  assert.deepEqual(r, { fetched: leaves.length * 120, upserted: leaves.length * 120, windows: leaves.length });
  assert.equal(db.countWorks('active'), leaves.length * 120);
  assert.ok(infos.some((i) => i.kind === 'split'));
});

test('ingestWindow: 1日以下の窓は分割せず、offset が 50000 を超えないよう取れる範囲だけ取り、警告を通知する', async () => {
  const db = openDb(':memory:');
  const { client, urls } = setup(standard(60000));
  const infos: IngestProgress[] = [];
  const r = await ingestWindow(client, db, { gteDate: oneDay[0], lteDate: oneDay[1], onProgress: (i) => infos.push(i) });
  const offsets = offsetsOf(urls);
  assert.equal(offsets.length, 500); // 1, 101, …, 49901
  assert.equal(offsets.at(-1), 49901);
  assert.ok(offsets.every((o) => o <= 50000));
  assert.deepEqual(r, { fetched: 50000, upserted: 50000, windows: 1 });
  assert.equal(infos.filter((i) => i.kind === 'warn').length, 1);
});

test('refreshExisting: result_count が 0 の作品だけが gone になり、返ってきた作品は更新される', async () => {
  const db = openDb(':memory:');
  seed(db, ['t-001', 't-002', 't-003']);
  const { client, urls } = setup(refreshApi('t-002'));
  assert.deepEqual(await refreshExisting(client, db), { checked: 3, updated: 2, gone: 1 });
  assert.deepEqual(urls.map((u) => u.searchParams.get('cid')), ['t-001', 't-002', 't-003']); // 1件ずつ
  assert.deepEqual(db.listWorks({ status: 'gone' }).map((w) => w.contentId), ['t-002']);
  assert.equal(db.getWork('t-001')!.title, '新-t-001');
});

test('refreshExisting: 確認できた作品が 0 件（API 全滅の疑い）なら markGone を呼ばず、全件 active のまま', async () => {
  const db = openDb(':memory:');
  seed(db, ['t-001', 't-002', 't-003']);
  let calls = 0;
  const spy: Db = { ...db, markGone: (ids, now) => { calls += 1; return db.markGone(ids, now); } };
  const { client } = setup(() => ({ total: 0, resultCount: 0 }));
  const infos: IngestProgress[] = [];
  const r = await refreshExisting(client, spy, { onProgress: (i) => infos.push(i) });
  assert.deepEqual(r, { checked: 3, updated: 0, gone: 0 });
  assert.equal(calls, 0);
  assert.equal(db.countWorks('active'), 3);
  assert.ok(infos.some((i) => i.kind === 'warn'));
});

test('refreshExisting: limit で確認しなかった作品は gone にならない', async () => {
  const db = openDb(':memory:');
  seed(db, ['t-001', 't-002', 't-003', 't-004']);
  const { client, urls } = setup(refreshApi('t-002'));
  assert.deepEqual(await refreshExisting(client, db, { limit: 2 }), { checked: 2, updated: 1, gone: 1 });
  assert.equal(urls.length, 2);
  assert.deepEqual(db.listWorks({ status: 'active' }).map((w) => w.contentId), ['t-001', 't-003', 't-004']);
});

test('ingestRanked: sort=rank で offset 1 から取り、rankPosition が 1 始まりの通し番号で付く', async () => {
  const db = openDb(':memory:');
  const { client, urls } = setup(standard(5));
  assert.deepEqual(await ingestRanked(client, db, { pages: 5, hits: 3 }), { ranked: 5 });
  // total（5件）を超える先は取りに行かない
  assert.deepEqual(urls.map((u) => [u.searchParams.get('sort'), u.searchParams.get('offset')]), [['rank', '1'], ['rank', '4']]);
  assert.deepEqual(db.listWorks().map((w) => w.rankPosition), [1, 2, 3, 4, 5]); // content_id 昇順 = 順位順
  const second = setup(standard(5)); // pages が小さければそのページ数で止まる
  assert.deepEqual(await ingestRanked(second.client, openDb(':memory:'), { pages: 1, hits: 3 }), { ranked: 3 });
  assert.equal(second.urls.length, 1);
});

test('ingestSynthetic: API を使わず count 件を生成して upsert する', async () => {
  const db = openDb(':memory:');
  assert.deepEqual(await ingestSynthetic(db, { count: 40, seed: 7 }), { upserted: 40 });
  assert.equal(db.countWorks('active'), 40);
});

test('last_ingest_at: どの取り込みも、処理後に now の時刻で更新する', async () => {
  const db = openDb(':memory:');
  const { client } = setup(standard(1));
  assert.equal(db.getMeta('last_ingest_at'), null);
  const steps: Array<(now: () => Date) => Promise<unknown>> = [
    (now) => ingestSynthetic(db, { count: 1, now }),
    (now) => ingestWindow(client, db, { gteDate: oneDay[0], lteDate: oneDay[1], now }),
    (now) => ingestRecent(client, db, { days: 1, now }),
    (now) => ingestRanked(client, db, { pages: 1, now }),
    (now) => refreshExisting(client, db, { now }),
  ];
  for (const [i, step] of steps.entries()) {
    const iso = `2026-11-01T0${i}:00:00.000Z`;
    await step(() => new Date(iso));
    assert.equal(db.getMeta('last_ingest_at'), iso);
  }
});

test('ingestRecent: days 日前の 00:00:00 から今日の 23:59:59 まで（始点は UTC、終点は JST の日付）の窓で取得する', async () => {
  const { client, urls } = setup(standard(1));
  // 2026-11-01 20:00 UTC は JST では 2026-11-02 05:00。どちらの日付で解釈されても取りこぼさない窓になる
  await ingestRecent(client, openDb(':memory:'), { days: 7, now: () => new Date('2026-11-01T20:00:00Z') });
  const q = urls[0]!.searchParams;
  assert.deepEqual([q.get('gte_date'), q.get('lte_date')], ['2026-10-25T00:00:00', '2026-11-02T23:59:59']);
});

test('API の失敗は握りつぶさず上に投げ、last_ingest_at も更新しない', async () => {
  const db = openDb(':memory:');
  seed(db, ['t-001']);
  const client = createClient({ ...CLIENT_OPTS, fetchImpl: (async () => new Response('{}', { status: 500 })) as typeof fetch });
  await assert.rejects(ingestWindow(client, db, { gteDate: oneDay[0], lteDate: oneDay[1] }), /HTTP 500/);
  await assert.rejects(refreshExisting(client, db), /HTTP 500/);
  assert.equal(db.getMeta('last_ingest_at'), null);
  assert.equal(db.countWorks('active'), 1); // 失敗時に gone にしない
});

test('不正な引数（窓の前後逆・日付形式・存在しない日付・days）は RangeError で、通信しない', async () => {
  const db = openDb(':memory:');
  const { client, urls } = setup(standard(1));
  await assert.rejects(ingestWindow(client, db, { gteDate: oneDay[1], lteDate: oneDay[0] }), RangeError);
  await assert.rejects(ingestWindow(client, db, { gteDate: '2026-10-01', lteDate: oneDay[1] }), RangeError);
  await assert.rejects(ingestWindow(client, db, { gteDate: '2026-02-30T00:00:00', lteDate: oneDay[1] }), RangeError);
  await assert.rejects(ingestRecent(client, db, { days: -1 }), RangeError);
  assert.equal(urls.length, 0);
});
