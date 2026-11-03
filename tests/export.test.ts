/** src/data/export.ts のテスト（node:test）。出力先は fs.mkdtempSync の一時ディレクトリ。
 *  実行: node --experimental-strip-types --test tests/export.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/data/db.ts';
import { ALL_LABELS, runDerive } from '../src/data/derive.ts';
import { exportAll, toCardRecord } from '../src/data/export.ts';
import { normalizeItems } from '../src/data/normalize.ts';
import { syntheticItemList } from '../src/data/synthetic.ts';
import type { DerivedLabel, Work } from '../src/data/types.ts';

const NOW = new Date('2026-11-01T00:00:00Z');
const ref = (id: string, name: string) => ({ id, name });
const read = (dir: string, name: string): any => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const keysOf = (v: unknown): string[] => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : []);
const synthetic = (count: number): Work[] => normalizeItems(syntheticItemList({ count }).result.items, { fetchedAt: '2026-11-01T00:00:00.000Z' });

/** 出力先に「まだ存在しない入れ子のディレクトリ」を渡して fn を実行し、終わったら一時ディレクトリごと消す */
function withDir(fn: (out: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'export-test-'));
  try { fn(join(dir, 'out', 'nested')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** 中立名の作品。patch で上書きする */
function makeWork(n: number, patch: Partial<Work> = {}): Work {
  const p = String(n).padStart(5, '0');
  return {
    contentId: `w${p}`, productId: `w${p}`, title: `作品 ${p}`, url: null, affiliateUrl: null, volumeMin: 120, releasedAt: '2026-01-01T10:00:00',
    reviewCount: 0, reviewAvg: null, priceMin: null, listPrice: null, deliveries: [], imageList: null, imageSmall: null, imageLarge: null,
    sampleImages: [], sampleMovie: null, campaigns: [], genres: [], actresses: [], series: [], makers: [], labels: [], directors: [],
    rankPosition: null, fetchedAt: '2026-11-01T00:00:00.000Z', status: 'active', ...patch,
  };
}

test('toCardRecord: 項目の対応（d は日付10文字、sale と sm は真偽、m と s は先頭の名前）', () => {
  const w = makeWork(1, {
    actresses: [ref('a1', '出演者A'), ref('a2', '出演者B')], makers: [ref('m1', 'メーカーA')], series: [ref('s1', 'シリーズA'), ref('s2', 'シリーズB')],
    genres: [ref('g1', 'タグ01'), ref('g2', 'タグ02')], volumeMin: 90, reviewCount: 7, reviewAvg: 4.2, priceMin: 500, listPrice: 800,
    imageSmall: 'https://example.invalid/s.jpg', rankPosition: 5, sampleMovie: { sizes: { '476_306': 'https://example.invalid/m' }, pcFlag: 1, spFlag: 1 },
  });
  assert.deepEqual(toCardRecord(w, ['セール中', '新作']), {
    id: 'w00001', t: '作品 00001', a: ['出演者A', '出演者B'], m: 'メーカーA', s: 'シリーズA', g: ['タグ01', 'タグ02'], v: 90, d: '2026-01-01',
    rc: 7, ra: 4.2, p: 500, lp: 800, sale: true, sm: true, img: 'https://example.invalid/s.jpg', rk: 5, lb: ['セール中', '新作'], ob: false,
  });
  const bare = toCardRecord(makeWork(2, { releasedAt: null }), []);
  assert.deepEqual([bare.d, bare.m, bare.s, bare.sale, bare.sm, bare.a], [null, null, null, false, false, []]);
});

test('exportAll: 2500件は1000件ずつ3ファイルに分かれ、index.json に件数・チャンク名・名前一覧が入る', () => withDir((out) => {
  const db = openDb(':memory:');
  const works = Array.from({ length: 2500 }, (_, i) => makeWork(i, {
    genres: [ref(`g${i % 3}`, `タグ0${i % 3}`)], actresses: [ref(`a${i % 5}`, `出演者${'ABCDE'[i % 5]}`)],
    series: i % 2 ? [] : [ref('s1', 'シリーズA')], makers: [ref('m1', 'メーカーA')],
  }));
  db.upsertWorks(works);
  assert.deepEqual(exportAll(db, out, { now: NOW }), { works: 2500, chunks: 3 });
  assert.deepEqual(readdirSync(out).sort(), ['index.json', 'meta.json', 'works-000.json', 'works-001.json', 'works-002.json', 'works.json']);
  const chunks = [0, 1, 2].map((i) => read(out, `works-00${i}.json`));
  assert.deepEqual(chunks.map((c) => c.length), [1000, 1000, 500]);
  assert.deepEqual(chunks.flat().map((r: any) => r.id), works.map((w) => w.contentId)); // content_id 昇順で、つなぐと全件
  assert.deepEqual(read(out, 'index.json'), {
    generatedAt: NOW.toISOString(), total: 2500, chunks: ['works-000.json', 'works-001.json', 'works-002.json'],
    genres: ['タグ00', 'タグ01', 'タグ02'], actresses: ['出演者A', '出演者B', '出演者C', '出演者D', '出演者E'],
    series: ['シリーズA'], makers: ['メーカーA'], labels: [], // 派生前はラベルなし
  });
  assert.equal(read(out, 'works.json').length, 2500);
}));

test('exportAll: works.json は全 Work + derivedLabels + similarIds、紹介文にあたる項目は出ない', () => withDir((out) => {
  const db = openDb(':memory:');
  const raw = syntheticItemList({ count: 40 }).result.items.map((it: any) => ({ ...it, comment: '説明文ダミー', review_text: 'レビュー本文ダミー' }));
  db.upsertWorks(normalizeItems(raw, { fetchedAt: '2026-11-01T00:00:00.000Z' }));
  runDerive(db, { now: NOW });
  exportAll(db, out, { now: NOW });
  const exported = read(out, 'works.json'), card = read(out, 'works-000.json');
  assert.equal(exported.length, 40);
  for (const e of exported) {
    const { derivedLabels, similarIds, ...work } = e;
    assert.deepEqual(work, JSON.parse(JSON.stringify(db.getWork(e.contentId))));
    assert.deepEqual(derivedLabels, db.getLabels(e.contentId));
    assert.deepEqual(similarIds, db.getSimilar(e.contentId).map((s) => s.similarId));
    assert.equal(similarIds.length, 8);
  }
  assert.ok(exported.some((e: any) => e.derivedLabels.length > 0));
  assert.deepEqual(card[0], toCardRecord(db.getWork(card[0].id) as Work, db.getLabels(card[0].id) as DerivedLabel[]));
  const used = new Set(exported.flatMap((e: any) => e.derivedLabels));
  assert.deepEqual(read(out, 'index.json').labels, ALL_LABELS.filter((l) => used.has(l))); // 使われているラベルだけ、定義順
  for (const f of readdirSync(out)) {
    const text = readFileSync(join(out, f), 'utf8');
    assert.ok(!text.includes('ダミー'), f);
    assert.equal(keysOf(JSON.parse(text)).some((k) => /comment|review_text/i.test(k)), false, f);
  }
}));

test('exportAll: meta.json に rankings・todays・取り込み/派生の時刻が入り、gone の作品は全ファイルから外れる', () => withDir((out) => {
  const db = openDb(':memory:');
  const works = synthetic(30), ids = works.map((w) => w.contentId);
  db.upsertWorks(works);
  exportAll(db, out); // 派生前は rankings・todays・時刻が null
  assert.deepEqual(read(out, 'meta.json'), { rankings: null, todays: null, last_ingest_at: null, last_derive_at: null });
  db.setMeta('last_ingest_at', '2026-10-31T00:00:00.000Z');
  runDerive(db, { now: NOW });
  db.markGone(ids.slice(1), '2026-11-02T00:00:00.000Z'); // 派生のあとで ids[0] が gone になった
  assert.equal(exportAll(db, out).works, 29);
  const meta = read(out, 'meta.json');
  assert.deepEqual([meta.last_ingest_at, meta.last_derive_at], ['2026-10-31T00:00:00.000Z', NOW.toISOString()]);
  assert.deepEqual(Object.keys(meta.rankings), ['byRating', 'byRecent', 'byPopularity']);
  for (const list of Object.values(meta.rankings) as string[][]) assert.deepEqual([...list].sort(), ids.slice(1).sort());
  for (const f of readdirSync(out)) assert.ok(!readFileSync(join(out, f), 'utf8').includes(`"${ids[0]}"`), f);
}));

test('exportAll: 出力先を作り、前回の余ったチャンクだけを消す。0件でも出力でき、chunkSize が不正なら例外', () => withDir((out) => {
  const db = openDb(':memory:');
  db.upsertWorks(Array.from({ length: 5 }, (_, i) => makeWork(i)));
  assert.deepEqual(exportAll(db, out, { chunkSize: 2 }), { works: 5, chunks: 3 });
  writeFileSync(join(out, 'keep.txt'), 'x');
  assert.deepEqual(exportAll(db, out, { chunkSize: 5 }), { works: 5, chunks: 1 });
  assert.deepEqual(readdirSync(out).sort(), ['index.json', 'keep.txt', 'meta.json', 'works-000.json', 'works.json']);
  for (const bad of [0, -1, 1.5]) assert.throws(() => exportAll(db, out, { chunkSize: bad }), RangeError);
  assert.deepEqual(exportAll(openDb(':memory:'), out), { works: 0, chunks: 0 });
  assert.deepEqual([read(out, 'works.json'), read(out, 'index.json').chunks, readdirSync(out).includes('works-000.json')], [[], [], false]);
}));
