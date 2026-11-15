/** src/data/export.ts のテスト（node:test）。出力先は fs.mkdtempSync の一時ディレクトリ。
 *  実行: node --experimental-strip-types --test tests/export.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/data/db.ts';
import { ALL_LABELS, runDerive } from '../src/data/derive.ts';
import { buildNames, exportAll, priceBand, ratingBand, recommendScore, scoreContext, toCardRecord } from '../src/data/export.ts';
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

const ctxOf = (works: Work[], now = NOW) => ({ names: buildNames(works).index, score: scoreContext(works, now) });

test('toCardRecord: 名前は names の添字、価格は帯、評価は 5 件以上で 0.5 刻み。実額・件数・平均・順位は出ない', () => {
  const w = makeWork(1, {
    actresses: [ref('a1', '出演者A'), ref('a2', '出演者B')], makers: [ref('m1', 'メーカーA')], series: [ref('s1', 'シリーズA'), ref('s2', 'シリーズB')],
    genres: [ref('g1', 'タグ01'), ref('g2', 'タグ02')], volumeMin: 90, reviewCount: 7, reviewAvg: 4.2, priceMin: 500, listPrice: 800,
    imageSmall: 'https://example.invalid/s.jpg', rankPosition: 5, sampleMovie: { sizes: { '476_306': 'https://example.invalid/m' }, pcFlag: 1, spFlag: 1 },
  });
  const other = makeWork(2, { actresses: [ref('a2', '出演者B')], genres: [ref('g2', 'タグ02')], releasedAt: null, priceMin: 2500 });
  const { names, score } = ctxOf([w, other]);
  const card = toCardRecord(w, ['セール中', '新作'], names, score);
  assert.deepEqual({ ...card, sc: 0 }, {
    id: 'w00001', t: '作品 00001', a: [1, 0], m: 0, s: 0, g: [1, 0], d: '2026-01-01', v: 90, sc: 0, rb: 4,
    pb: 0, sale: true, sm: true, lb: ['セール中', '新作'], img: 'https://example.invalid/s.jpg', ob: false,
  });
  assert.ok(Number.isInteger(card.sc) && card.sc >= 0 && card.sc <= 100);
  assert.deepEqual(Object.keys(card).filter((k) => ['p', 'lp', 'rc', 'ra', 'rk'].includes(k)), []);
  const bare = toCardRecord(other, [], names, score);
  assert.deepEqual([bare.d, bare.m, bare.s, bare.sale, bare.sm, bare.a, bare.rb, bare.pb], [null, null, null, false, false, [0], null, 3]);
});

test('priceBand・ratingBand: 境界の値', () => {
  assert.deepEqual([null, 0, 500, 501, 1000, 1001, 2000, 2001].map(priceBand), [null, 0, 0, 1, 1, 2, 2, 3]);
  assert.equal(ratingBand({ reviewAvg: 4.74, reviewCount: 5 }), 4.5);
  assert.equal(ratingBand({ reviewAvg: 4.76, reviewCount: 5 }), 5);
  assert.equal(ratingBand({ reviewAvg: 4.9, reviewCount: 4 }), null);
  assert.equal(ratingBand({ reviewAvg: null, reviewCount: 9 }), null);
});

test('recommendScore: 評価・件数・新しさ・人気が高いほど上がる', () => {
  const base = makeWork(0, { releasedAt: '2025-01-01', reviewCount: 10, reviewAvg: 3.5 });
  const all = [base, makeWork(9, { reviewCount: 200, reviewAvg: 3, rankPosition: 100 })];
  const sc = (patch: Partial<Work>) => recommendScore({ ...base, ...patch }, scoreContext(all, NOW));
  const b = sc({});
  assert.ok(sc({ reviewAvg: 4.8 }) > b);
  assert.ok(sc({ reviewCount: 150 }) > b);
  assert.ok(sc({ releasedAt: '2026-10-20' }) > b);
  assert.ok(sc({ rankPosition: 1 }) > b);
  assert.ok(sc({ releasedAt: null }) < b);
});

test('exportAll: チャンクは配信開始日の新しい順（日付なしは最後）。index.json に names と counts（件数の多い順）が入る', () => withDir((out) => {
  const db = openDb(':memory:');
  const works = Array.from({ length: 2500 }, (_, i) => makeWork(i, {
    releasedAt: i === 7 ? null : new Date(Date.UTC(2020, 0, 1 + (i * 37) % 2000)).toISOString().slice(0, 10),
    genres: [ref(`g${i % 3}`, `タグ0${i % 3}`)], actresses: i % 5 === 4 ? [] : [ref(`a${i % 5}`, `出演者${'ABCDE'[i % 5]}`)],
    series: i % 2 ? [] : [ref('s1', 'シリーズA')], makers: [ref('m1', 'メーカーA')],
  }));
  db.upsertWorks(works);
  assert.deepEqual(exportAll(db, out, { now: NOW }), { works: 2500, chunks: 3 });
  assert.deepEqual(readdirSync(out).sort(), ['index.json', 'meta.json', 'works-000.json', 'works-001.json', 'works-002.json', 'works.json']);
  const chunks = [0, 1, 2].map((i) => read(out, `works-00${i}.json`));
  assert.deepEqual(chunks.map((c) => c.length), [1000, 1000, 500]);
  const flat = chunks.flat();
  assert.deepEqual(new Set(flat.map((r: any) => r.id)), new Set(works.map((w) => w.contentId)));
  const dates = flat.map((r: any) => r.d);
  assert.equal(dates.at(-1), null);
  assert.deepEqual(dates.slice(0, -1), [...dates.slice(0, -1)].sort().reverse());
  const index = read(out, 'index.json');
  assert.deepEqual({ ...index, names: undefined, counts: undefined }, {
    generatedAt: NOW.toISOString(), total: 2500, chunks: ['works-000.json', 'works-001.json', 'works-002.json'], labels: [], names: undefined, counts: undefined,
  });
  assert.deepEqual(index.names, { actress: ['出演者A', '出演者B', '出演者C', '出演者D'], maker: ['メーカーA'], series: ['シリーズA'], genre: ['タグ00', 'タグ01', 'タグ02'] });
  assert.deepEqual(index.counts, { actress: [500, 500, 500, 500], maker: [2500], series: [1250], genre: [834, 833, 833] });
  const first = flat.find((r: any) => r.id === 'w00002');
  assert.deepEqual([first.a, first.g, first.m, first.s], [[2], [2], 0, 0]); // 出演者C・タグ02・メーカーA・シリーズA
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
  const { names, score } = ctxOf(db.listWorks({ status: 'active' }));
  assert.deepEqual(card[0], toCardRecord(db.getWork(card[0].id) as Work, db.getLabels(card[0].id) as DerivedLabel[], names, score));
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

test('exportAll: publish を渡すと、公開対象の作品だけを全ファイル（チャンク・works.json・meta・index・actresses）に出す', () => withDir((out) => {
  const db = openDb(':memory:');
  const policy = { recentMonths: 3, minReviews: 20, includeRanked: true, includeFollowed: true };
  const publish = { now: NOW, policy, follow: { actresses: [], series: [], makers: [{ id: 'm9' }] } };
  const works = [
    makeWork(0, { releasedAt: '2026-10-01T10:00:00', actresses: [ref('a0', '出演者A')] }), // 直近
    makeWork(1, { reviewCount: 30, actresses: [ref('a1', '出演者B')] }), // レビュー多数
    makeWork(2, { rankPosition: 7 }), // 人気順
    makeWork(3, { makers: [ref('m9', 'メーカーZ')] }), // 指定メーカー
    makeWork(4, { reviewCount: 3, actresses: [ref('a4', '出演者X')], makers: [ref('m4', 'メーカーX')] }), // 非公開
  ];
  db.upsertWorks(works);
  db.upsertActressProfiles(['a0', 'a1', 'a4'].map((id) => ({
    id, name: id, ruby: null, birthday: null, bloodType: null, hobby: null, prefectures: null, height: null, bust: null, waist: null, hip: null, cup: null, listUrl: null, fetchedAt: '2026-11-01T00:00:00.000Z',
  })));
  runDerive(db, { now: NOW, publish });
  assert.equal(exportAll(db, out, { now: NOW, publish }).works, 4);
  const hidden = works[4].contentId;
  assert.equal(read(out, 'index.json').total, 4);
  assert.deepEqual(read(out, 'actresses.json').map((a: any) => a.id), ['a0', 'a1']);
  for (const f of readdirSync(out)) {
    const text = readFileSync(join(out, f), 'utf8');
    for (const s of [`"${hidden}"`, '出演者X', 'メーカーX']) assert.ok(!text.includes(s), `${f} に ${s}`);
  }
  assert.equal(exportAll(db, out, { now: NOW }).works, 5); // 渡さなければ active の全件（従来どおり）
}));
