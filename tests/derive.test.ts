/** src/data/derive.ts のテスト（node:test）。
 *  実行: node --experimental-strip-types --test tests/derive.test.ts */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/data/db.ts';
import {
  ALL_LABELS, bayesScore, buildRefCounts, computeLabels, computeRankings, computeSimilar, computeSimilarAll, pickTodays, runDerive,
} from '../src/data/derive.ts';
import { normalizeItems } from '../src/data/normalize.ts';
import { syntheticItemList } from '../src/data/synthetic.ts';
import { DEFAULT_THRESHOLDS, type DerivedLabel, type Work } from '../src/data/types.ts';

const NOW = new Date('2026-11-01T00:00:00Z'); // 日本時間では 2026-11-01 09:00
const ago = (d: number): string => new Date(Date.UTC(2026, 10, 1 - d)).toISOString().slice(0, 10); // NOW から d 日前の日付
const ref = (id: string, name: string) => ({ id, name });
const G = (...n: number[]) => n.map((i) => ref(`g${i}`, `タグ${String(i).padStart(2, '0')}`));
const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

/** 中立名の作品。patch で上書きする */
function makeWork(n: number, patch: Partial<Work> = {}): Work {
  const p = String(n).padStart(4, '0');
  return {
    contentId: `w${p}`, productId: `w${p}`, title: `作品 ${p}`, url: null, affiliateUrl: null, volumeMin: 120, releasedAt: '2026-01-01',
    reviewCount: 0, reviewAvg: null, priceMin: null, listPrice: null, deliveries: [], imageList: null, imageSmall: null, imageLarge: null,
    sampleImages: [], sampleMovie: null, campaigns: [], genres: [], actresses: [], series: [], makers: [], labels: [], directors: [],
    rankPosition: null, fetchedAt: '2026-11-01T00:00:00.000Z', status: 'active', ...patch,
  };
}
const labelsOf = (w: Work, ctx: object = {}): DerivedLabel[] =>
  computeLabels(w, { now: NOW, seriesCounts: new Map(), actressCounts: new Map(), ...ctx });
/** [作品の上書き, そのラベルが付くか] の表を順に確かめる */
function table(label: DerivedLabel, rows: [Partial<Work>, boolean][], ctx: object = {}): void {
  rows.forEach(([patch, want], i) => assert.equal(labelsOf(makeWork(i, patch), ctx).includes(label), want, `${label} 行${i} ${JSON.stringify(patch)}`));
}

test('境界値: 新作（30日以内）・定番（3年以上かつ50件以上）・高評価（4.5以上かつ20件以上）・長尺（180分以上）・短尺（60分以下）', () => {
  table('新作', [
    [{ releasedAt: ago(0) }, true], [{ releasedAt: ago(29) }, true], [{ releasedAt: ago(30) }, true], [{ releasedAt: ago(31) }, false],
    [{ releasedAt: ago(-1) }, false], [{ releasedAt: null }, false], [{ releasedAt: `${ago(29)}T23:59:59` }, true], [{ releasedAt: `${ago(31)}T00:00:00` }, false],
  ]); // 配信開始前（未来日）と日付なしは付かない
  table('定番', [
    [{ reviewCount: 50, releasedAt: '2023-11-01' }, true], [{ reviewCount: 50, releasedAt: '2023-11-02' }, false],
    [{ reviewCount: 49, releasedAt: '2020-01-01' }, false], [{ reviewCount: 50, releasedAt: null }, false],
  ]);
  table('高評価', [
    [{ reviewAvg: 4.5, reviewCount: 20 }, true], [{ reviewAvg: 4.49, reviewCount: 20 }, false],
    [{ reviewAvg: 4.5, reviewCount: 19 }, false], [{ reviewAvg: null, reviewCount: 100 }, false],
  ]);
  table('長尺', [[{ volumeMin: 179 }, false], [{ volumeMin: 180 }, true], [{ volumeMin: null }, false]]);
  table('短尺', [[{ volumeMin: 60 }, true], [{ volumeMin: 61 }, false], [{ volumeMin: 0 }, false], [{ volumeMin: null }, false]]); // 0分は未入力扱い
});

test('セール中は2条件（今日を含む期間 / priceMin < listPrice）、初見向けは高評価かつ定番かつ標準尺', () => {
  const camp = (begin: string | null, end: string | null): Partial<Work> => ({ campaigns: [{ title: 'キャンペーンA', begin, end }] });
  table('セール中', [
    [camp(`${ago(2)}T12:00:00`, `${ago(-5)}T23:59:59`), true], [camp(`${ago(10)}T00:00:00`, `${ago(1)}T23:59:59`), false], // 期間内、昨日終了
    [camp(`${ago(-1)}T00:00:00`, `${ago(-9)}T00:00:00`), false], [camp(`${ago(0)}T18:00:00`, null), true],               // 明日開始、今日開始
    [camp(null, `${ago(0)}T00:00:00`), true], [camp(null, null), false],                                                  // 今日終了、期間不明
    [{ campaigns: [{ title: 'A', begin: ago(10), end: ago(5) }, { title: 'B', begin: ago(1), end: ago(-1) }] }, true],     // 複数のうち1つが期間内
    [{ priceMin: 800, listPrice: 1000 }, true], [{ priceMin: 1000, listPrice: 1000 }, false],
    [{ priceMin: null, listPrice: 1000 }, false], [{ priceMin: 800, listPrice: null }, false],
  ]);
  const base = { reviewAvg: 4.6, reviewCount: 100, releasedAt: '2020-01-01', volumeMin: 120 };
  table('初見向け', [
    [base, true], [{ ...base, volumeMin: null }, true], [{ ...base, reviewAvg: 4.0 }, false],
    [{ ...base, releasedAt: ago(10) }, false], [{ ...base, releasedAt: null }, false], [{ ...base, volumeMin: 180 }, false], [{ ...base, volumeMin: 60 }, false],
  ]);
});

test('追い向け・順序・閾値: 作品数は自分を含み、ラベルは定義順、閾値は差し替えられる', () => {
  const w = makeWork(1, { series: [ref('s1', 'シリーズA'), ref('s2', 'シリーズB')], actresses: [ref('a1', '出演者A')] });
  const ctx = (s: number, a: number) => ({ seriesCounts: new Map([['s1', s], ['s2', 3]]), actressCounts: new Map([['a1', a]]) });
  assert.deepEqual([11, 12].map((n) => labelsOf(w, ctx(n, 0)).includes('シリーズ追い向け')), [false, true]); // 複数シリーズは最大を見る
  assert.deepEqual([19, 20].map((n) => labelsOf(w, ctx(0, n)).includes('出演者追い向け')), [false, true]);
  const counts = buildRefCounts([w, makeWork(2, { series: [ref('s1', 'シリーズA'), ref('s1', 'シリーズA')] })]);
  assert.deepEqual([counts.seriesCounts.get('s1'), counts.actressCounts.get('a1')], [2, 1]); // 同じ ID を重ねても1回
  const all = makeWork(3, { releasedAt: ago(1), volumeMin: 200, priceMin: 1, listPrice: 2, reviewAvg: 4.9, reviewCount: 99, series: [ref('s1', 'A')] });
  assert.deepEqual(labelsOf(all, ctx(12, 0)), ['新作', '高評価', '長尺', 'セール中', 'シリーズ追い向け']);
  const old = makeWork(4, { releasedAt: ago(40) });
  assert.deepEqual([labelsOf(old), labelsOf(old, { thresholds: { ...DEFAULT_THRESHOLDS, newDays: 45 } })], [[], ['新作']]);
});

test('似た作品: 同出演者が上位に来て、点数は Jaccard + 加点 - 発売時期の差。上位 n 件で同点は similarId 昇順', () => {
  const base = { genres: G(1, 2), releasedAt: '2026-01-01' };
  const target = makeWork(0, { ...base, genres: G(1, 2, 3), actresses: [ref('a1', '出演者A')], series: [ref('s1', 'シリーズA')], makers: [ref('m1', 'メーカーA')] });
  const cands = [
    makeWork(1, base), makeWork(2, { ...base, actresses: [ref('a1', '出演者A')] }), makeWork(3, { ...base, series: [ref('s1', 'シリーズA')] }),
    makeWork(4, { ...base, makers: [ref('m1', 'メーカーA')] }), makeWork(5, { ...base, releasedAt: '2016-01-01' }),
    makeWork(6, { ...base, releasedAt: '2021-01-01' }), makeWork(7, { ...base, releasedAt: null }), makeWork(8, { ...base, genres: G(9) }),
  ];
  const r = computeSimilar(target, [target, ...cands]); // 自分自身が混ざっていても除く
  assert.deepEqual(r.map((s) => s.similarId), ['w0002', 'w0003', 'w0004', 'w0001', 'w0007', 'w0006', 'w0005', 'w0008']);
  const s = Object.fromEntries(r.map((x) => [x.similarId, x.score]));
  near(s.w0002, 2 / 3 + 0.5); near(s.w0003, 2 / 3 + 0.4); near(s.w0004, 2 / 3 + 0.15); near(s.w0001, 2 / 3);
  near(s.w0005, 2 / 3 - 0.1); near(s.w0006, 2 / 3 - (0.1 * 1826) / 3652.5); near(s.w0007, 2 / 3); near(s.w0008, 0);
  const same = Array.from({ length: 20 }, (_, i) => makeWork(i + 1, { genres: G(1) })); // 全員同点
  const top = computeSimilar(makeWork(0, { genres: G(1) }), same);
  assert.deepEqual(top.map((x) => x.similarId), same.slice(0, 8).map((w) => w.contentId)); // 既定は8件
  assert.deepEqual(computeSimilar(makeWork(0, { genres: G(1) }), [...same].reverse()), top);
  assert.deepEqual([3, 0].map((n) => computeSimilar(target, same, n).length), [3, 0]);
});

/** 点数の式をそのまま書いた総当たり（照合用）。点数の降順の並びを返す */
function brute(w: Work, all: Work[], n: number): number[] {
  const names = (x: Work) => new Set(x.genres.map((g) => g.name));
  const share = (a: { id: string }[], b: { id: string }[]) => a.some((x) => b.some((y) => y.id === x.id));
  return all.filter((c) => c.contentId !== w.contentId).map((c) => {
    const a = names(w), b = names(c), inter = [...a].filter((x) => b.has(x)).length, union = a.size + b.size - inter;
    const yrs = w.releasedAt && c.releasedAt ? Math.abs(Date.parse(w.releasedAt) - Date.parse(c.releasedAt)) / (365.25 * 86_400_000) : 0;
    return (union ? inter / union : 0) + (share(w.actresses, c.actresses) ? 0.5 : 0) + (share(w.series, c.series) ? 0.4 : 0)
      + (share(w.makers, c.makers) ? 0.15 : 0) - 0.1 * Math.min(1, yrs / 10);
  }).sort((x, y) => y - x).slice(0, n);
}

test('computeSimilarAll は総当たりと同じ点数列になり、全作品に computeSimilar を呼んだ結果と一致する', () => {
  let seed = 12345;
  const rnd = (k: number): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % k; };
  const works = Array.from({ length: 120 }, (_, i) => makeWork(i, {
    genres: i % 15 === 0 ? [] : G(...Array.from({ length: 1 + rnd(4) }, () => rnd(14))), // 共通要素の少ない作品も混ぜる
    actresses: rnd(3) === 0 ? [ref(`a${rnd(10)}`, '出演者')] : [], series: rnd(4) === 0 ? [ref(`s${rnd(5)}`, 'シリーズ')] : [],
    makers: [ref(`m${rnd(4)}`, 'メーカー')], releasedAt: rnd(10) === 0 ? null : `${2014 + rnd(13)}-0${1 + rnd(9)}-1${rnd(9)}`,
  }));
  for (const n of [1, 8, 200]) {
    const all = computeSimilarAll(works, n);
    assert.deepEqual(all, works.flatMap((w) => computeSimilar(w, works, n)));
    for (const w of works) {
      const got = all.filter((s) => s.contentId === w.contentId).map((s) => s.score), want = brute(w, works, n);
      assert.equal(got.length, want.length, `${w.contentId} n=${n}`);
      got.forEach((g, k) => near(g, want[k]));
    }
  }
});

test('bayesScore は件数の少ない 5.0 が件数の多い 4.6 に負ける。computeRankings は評価順・新着順・人気順（null は末尾）', () => {
  const few = makeWork(1, { reviewAvg: 5.0, reviewCount: 2 }), many = makeWork(2, { reviewAvg: 4.6, reviewCount: 200 });
  assert.ok(bayesScore(few, 4.0) < bayesScore(many, 4.0));
  near(bayesScore(few, 4.0), (5.0 * 2 + 4.0 * 20) / 22);
  near(bayesScore(makeWork(3), 4.0), 4.0); // avg が null・0件なら全体平均そのもの
  const rest = Array.from({ length: 6 }, (_, i) => makeWork(10 + i, { reviewAvg: 3.8, reviewCount: 50 })); // 全体平均を 4.0 前後にする
  assert.deepEqual(computeRankings([few, many, ...rest]).byRating.slice(0, 2), ['w0002', 'w0001']);
  const r = computeRankings([
    makeWork(1, { releasedAt: '2026-03-01', rankPosition: 3, reviewAvg: 4.0, reviewCount: 30 }),
    makeWork(2, { releasedAt: '2026-05-01', rankPosition: null, reviewAvg: 3.0, reviewCount: 30 }),
    makeWork(3, { releasedAt: null, rankPosition: 1, reviewAvg: 4.8, reviewCount: 30 }),
    makeWork(4, { releasedAt: '2026-05-01', rankPosition: 2, reviewAvg: 4.0, reviewCount: 30 }),
  ]);
  assert.deepEqual([r.byRating, r.byRecent, r.byPopularity], [ // 同順位は content_id 昇順
    ['w0003', 'w0001', 'w0004', 'w0002'], ['w0002', 'w0004', 'w0001', 'w0003'], ['w0003', 'w0004', 'w0001', 'w0002']]);
});

test('pickTodays: 高評価か定番だけから n 件。同じ日付なら入力順によらず同じ結果', () => {
  const good = Array.from({ length: 30 }, (_, i) => makeWork(i, { reviewAvg: 4.8, reviewCount: 30, releasedAt: ago(5) })); // 高評価
  const classic = makeWork(30, { reviewAvg: 3.0, reviewCount: 80, releasedAt: '2019-01-01' });                               // 定番
  const plain = Array.from({ length: 20 }, (_, i) => makeWork(100 + i, { reviewAvg: 3.0, reviewCount: 5 }));                 // どちらでもない
  const all = [...good, classic, ...plain], a = pickTodays(all, '2026-11-01');
  assert.equal(new Set(a).size, 10);
  assert.deepEqual(pickTodays([...all].reverse(), '2026-11-01'), a);
  assert.notDeepEqual(pickTodays(all, '2026-11-02'), a);
  assert.ok(a.every((id) => [...good, classic].some((w) => w.contentId === id)));
  assert.deepEqual([pickTodays(all, '2026-11-01', 100).length, pickTodays([], '2026-11-01').length], [31, 0]); // 候補が足りなければある分だけ
  assert.throws(() => pickTodays(all, '2026/11/01'), RangeError);
});

test('runDerive: ラベル・似た作品・メタ情報を保存し、gone は対象外、再実行で古い値を置き換える', () => {
  const db = openDb(':memory:');
  const a = makeWork(1, { releasedAt: ago(3), genres: G(1, 2), series: [ref('s1', 'シリーズA')] });
  const b = makeWork(2, { releasedAt: '2020-01-01', reviewAvg: 4.7, reviewCount: 120, genres: G(1, 2), series: [ref('s1', 'シリーズA')] });
  db.upsertWorks([a, b, makeWork(3, { genres: G(1, 2) })]);
  db.markGone(['w0001', 'w0002'], '2026-11-01T00:00:00.000Z'); // w0003 を gone にする
  assert.deepEqual(runDerive(db, { now: NOW }), { works: 2, labeled: 2, similar: 2 });
  assert.deepEqual([db.getLabels('w0001'), db.getLabels('w0002')], [['新作'], ['定番', '高評価', '初見向け']]);
  assert.deepEqual(db.getSimilar('w0001').map((s) => s.similarId), ['w0002']);
  assert.equal(db.getMeta('last_derive_at'), NOW.toISOString());
  const rk = JSON.parse(db.getMeta('rankings') as string);
  assert.deepEqual(Object.keys(rk).sort(), ['byPopularity', 'byRating', 'byRecent']); // gone の作品は含まない
  for (const list of Object.values(rk) as string[][]) assert.deepEqual([...list].sort(), ['w0001', 'w0002']);
  assert.deepEqual(JSON.parse(db.getMeta('todays') as string), ['w0002']);
  db.upsertWorks([{ ...a, releasedAt: '2026-01-01' }]); // 新作でなくなった作品は、ラベルが0件でも前回の値を消す
  assert.equal(runDerive(db, { now: NOW }).labeled, 1);
  assert.deepEqual(db.getLabels('w0001'), []);
});

test('runDerive: 合成データ80件で全作品に似た作品が付き、similarN で件数を変えて再実行できる', () => {
  const db = openDb(':memory:');
  const works = normalizeItems(syntheticItemList({ count: 80 }).result.items, { fetchedAt: '2026-11-01T00:00:00.000Z' });
  db.upsertWorks(works);
  const r = runDerive(db, { now: NOW });
  assert.deepEqual([r.works, r.similar], [80, 80]);
  for (const w of works) {
    const sim = db.getSimilar(w.contentId);
    assert.equal(sim.length, 8);
    assert.ok(sim.every((s, i) => s.similarId !== w.contentId && (i === 0 || sim[i - 1].score >= s.score)));
    assert.ok(db.getLabels(w.contentId).every((l) => (ALL_LABELS as readonly string[]).includes(l)));
  }
  assert.equal(r.labeled, works.filter((w) => db.getLabels(w.contentId).length > 0).length);
  const ids = works.map((w) => w.contentId).sort(), rk = JSON.parse(db.getMeta('rankings') as string);
  for (const list of Object.values(rk) as string[][]) assert.deepEqual([...list].sort(), ids);
  assert.deepEqual(runDerive(db, { now: NOW, similarN: 3 }), r);
  assert.ok(works.every((w) => db.getSimilar(w.contentId).length === 3));
});
