// 指定軸の取り込み（ingest-follow）のテスト。fetch を差し替えた合成レスポンスだけを使い、実際の通信はしない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../src/data/api.ts';
import { openDb } from '../src/data/db.ts';
import { ingestFollowed, loadFollowConfig, parseFollowConfig } from '../src/data/ingest-follow.ts';

const CLIENT_OPTS = { apiId: 'TEST_API_ID_DUMMY', affiliateId: 'testaff-990', minIntervalMs: 0, maxRetries: 0, sleep: async () => {} };

// 軸ごとに total 件ある合成の応答。content_id は article と article_id と位置で一意
function setup(total: number) {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const q = url.searchParams;
    const offset = Number(q.get('offset'));
    const n = Math.max(0, Math.min(Number(q.get('hits')), total - offset + 1));
    const items = Array.from({ length: n }, (_, i) => ({
      content_id: `${q.get('article')}${q.get('article_id')}-${String(offset + i).padStart(4, '0')}`, title: `テスト作品${offset + i}`,
    }));
    const result = { status: 200, result_count: n, total_count: total, first_position: offset, ...(n > 0 && { items }) };
    return new Response(JSON.stringify({ request: { parameters: { api_id: 'TEST_API_ID_DUMMY' } }, result }));
  }) as typeof fetch;
  return { client: createClient({ ...CLIENT_OPTS, fetchImpl }), urls };
}
const entry = (id: string) => ({ id, name: `メモ${id}` });

test('article と article_id が URL に載り、offset が進む', async () => {
  const { client, urls } = setup(250);
  const db = openDb(':memory:');
  const r = await ingestFollowed(client, db, { follow: { actresses: [entry('1234')], series: [], makers: [] }, hits: 100 });
  assert.deepEqual(urls.map((u) => Number(u.searchParams.get('offset'))), [1, 101, 201]);
  for (const u of urls) {
    assert.equal(u.searchParams.get('article'), 'actress');
    assert.equal(u.searchParams.get('article_id'), '1234');
    assert.equal(u.searchParams.get('sort'), 'date');
  }
  assert.deepEqual(r, { axes: 1, fetched: 250, upserted: 250 });
});

test('offset が上限 5000 を超えず、打ち切って警告を通知する。maxOffset=50000 なら旧挙動', async () => {
  const { client, urls } = setup(8000);
  const infos: { kind: string }[] = [];
  const follow = { actresses: [entry('1')], series: [], makers: [] };
  const r = await ingestFollowed(client, openDb(':memory:'), { follow, onProgress: (i) => infos.push(i) });
  const offsets = urls.map((u) => Number(u.searchParams.get('offset')));
  assert.equal(offsets.length, 50);
  assert.equal(offsets.at(-1), 4901);
  assert.ok(offsets.every((o) => o <= 5000));
  assert.equal(r.fetched, 5000);
  assert.equal(infos.filter((i) => i.kind === 'warn').length, 1);
  const old = setup(8000);
  const r2 = await ingestFollowed(old.client, openDb(':memory:'), { follow, maxOffset: 50000 });
  assert.equal(r2.fetched, 8000);
});

test('3 軸 × 2 id で呼び出し数が合う', async () => {
  const { client, urls } = setup(150); // 1 軸あたり 2 ページ
  const db = openDb(':memory:');
  const follow = { actresses: [entry('1'), entry('2')], series: [entry('3'), entry('4')], makers: [entry('5'), entry('6')] };
  const r = await ingestFollowed(client, db, { follow, hits: 100 });
  assert.equal(urls.length, 12);
  assert.deepEqual([...new Set(urls.map((u) => u.searchParams.get('article')))], ['actress', 'series', 'maker']);
  assert.equal(r.axes, 6);
  assert.equal(r.fetched, 900);
  assert.equal(r.upserted, 900);
});

test('空設定では API を呼ばず何もしない', async () => {
  const { client, urls } = setup(100);
  const db = openDb(':memory:');
  const r = await ingestFollowed(client, db, { follow: { actresses: [], series: [], makers: [] } });
  assert.equal(urls.length, 0);
  assert.deepEqual(r, { axes: 0, fetched: 0, upserted: 0 });
});

test('設定ファイル: なければ空、不正なら Error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'follow-'));
  assert.deepEqual(loadFollowConfig(join(dir, 'none.json')), { actresses: [], series: [], makers: [] });
  const ok = join(dir, 'ok.json');
  writeFileSync(ok, JSON.stringify({ actresses: [entry('10')], series: [], makers: [] }));
  assert.equal(loadFollowConfig(ok).actresses[0].id, '10');
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{ not json');
  assert.throws(() => loadFollowConfig(broken), Error);
  assert.throws(() => parseFollowConfig({ actresses: 'x' }), Error);
  assert.throws(() => parseFollowConfig({ series: [{ name: 'idなし' }] }), Error);
  assert.throws(() => parseFollowConfig({ makers: [{ id: 12 }] }), Error);
  assert.throws(() => parseFollowConfig([]), Error);
});
