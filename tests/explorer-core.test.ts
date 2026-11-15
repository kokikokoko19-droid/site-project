/** public/explorer/explorer-core.js（探索ページの純粋な関数）のテスト。実行: node --experimental-strip-types --test tests/explorer-core.test.ts */
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-ignore ブラウザ用の素の JS（型定義なし）
import * as core from '../public/explorer/explorer-core.js';

const { activeChips, applyPreset, defaults, filterCount, loadWorks, nameIndex, prepare, presetActive, readHash, readURL, removeChip, run, toHash, toQuery } = core as any;

const NAMES = { actress: ['出演者A', '出演者B'], maker: ['メーカーA', 'メーカーB'], series: ['シリーズA'], genre: ['タグ01', 'タグ02', 'タグ03'] };
const NOW = Date.parse('2026-11-15T00:00:00Z');
/** 中立名のカード。patch で上書きする */
const card = (id: string, patch: Record<string, unknown> = {}) => ({
  id, t: `作品 ${id}`, a: [], m: null, s: null, g: [], d: '2025-01-01', v: 100, sc: 50, rb: null, pb: 1, sale: false, sm: false, lb: [], img: null, ob: true, ...patch,
});
const WORKS = () => prepare([
  card('w1', { a: [0], m: 0, g: [0, 1], d: '2026-11-01', v: 50, sc: 60, rb: 4, pb: 0, sale: true }),
  card('w2', { a: [1], m: 1, s: 0, g: [1], d: '2026-09-01', v: 130, sc: 80, rb: 4.5, pb: 3, sm: true, lb: ['長尺'] }),
  card('w3', { a: [0, 1], m: 0, g: [2], d: null, v: 250, sc: 70, rb: null, pb: null }),
  card('w4', { m: 1, g: [0], d: '2026-10-25', v: null, sc: 40, rb: 4.5, pb: 2, sale: true }),
], NAMES);
const ids = (ws: any[]) => ws.map((w) => w.id);
const IX = nameIndex(NAMES);
const go = (search: string) => ids(run(WORKS(), readURL(search), IX, NOW));

test('readURL / toQuery: 往復で同じ。既定値は書かず、不正な値は捨てる', () => {
  const qs = 'sort=rating&g=タグ01&g=タグ02&act=出演者A&pb=0&pb=2&len=l&year=2026&days=30&sale=1&sample=1&rev=1&lab=長尺&q=作品';
  assert.equal(decodeURIComponent(toQuery(readURL('?' + qs)).replace(/\+/g, ' ')), qs);
  assert.equal(toQuery(readURL('')), '');
  assert.deepEqual(readURL('?sort=xx&pb=9&len=zz&year=20&days=-3'), defaults());
});

test('readURL: 旧 URL との互換（sort=new、重みは読み捨て、価格と長さの範囲はチップに読み替え）', () => {
  assert.equal(readURL('?sort=new').sort, 'new');
  assert.deepEqual(readURL('?w_e=1&w_r=0&len=long'), defaults());
  assert.deepEqual(readURL('?pmax=1000').pb, [0, 1]);
  assert.deepEqual(readURL('?pmin=1500').pb, [2, 3]);
  assert.equal(readURL('?vmin=120').len, 'l');
  assert.equal(readURL('?vmin=240').len, 'xl');
  assert.equal(readURL('?vmax=60').len, 's');
});

test('readHash / toHash: モーダルの #w=ID', () => {
  assert.equal(readHash(toHash('ab/c 1')), 'ab/c 1');
  assert.equal(readHash(''), null);
  assert.equal(readHash('#top'), null);
});

test('run: 並べ替え 5 種（null は後ろ、同順位はおすすめ度）', () => {
  assert.deepEqual(go(''), ['w2', 'w3', 'w1', 'w4']); // おすすめ度の降順
  assert.deepEqual(go('?sort=rating'), ['w2', 'w4', 'w1', 'w3']); // 4.5 同士はおすすめ度で w2 が先、評価なしは最後
  assert.deepEqual(go('?sort=new'), ['w1', 'w4', 'w2', 'w3']); // 日付なしは最後
  assert.deepEqual(go('?sort=cheap'), ['w1', 'w4', 'w2', 'w3']); // 価格帯 0,2,3,なし
  assert.deepEqual(go('?sort=long'), ['w3', 'w2', 'w1', 'w4']); // 長さなしは最後
});

test('run: 絞り込み（ジャンル AND、出演者・シリーズ・メーカーは名前→添字、価格帯 OR、長さ、日数、評価あり、検索語）', () => {
  assert.deepEqual(go('?g=タグ02'), ['w2', 'w1']);
  assert.deepEqual(go('?g=タグ01&g=タグ02'), ['w1']);
  assert.deepEqual(go('?act=出演者A'), ['w3', 'w1']);
  assert.deepEqual(go('?ser=シリーズA'), ['w2']);
  assert.deepEqual(go('?mak=メーカーB'), ['w2', 'w4']);
  assert.deepEqual(go('?mak=存在しない名前'), []);
  assert.deepEqual(go('?pb=0&pb=2'), ['w1', 'w4']);
  assert.deepEqual(go('?len=s'), ['w1']);
  assert.deepEqual(go('?len=m'), []); // 60 以上 120 未満
  assert.deepEqual(go('?len=l'), ['w2', 'w3']);
  assert.deepEqual(go('?len=xl'), ['w3']);
  assert.deepEqual(go('?days=30'), ['w1', 'w4']);
  assert.deepEqual(go('?rev=1'), ['w2', 'w1', 'w4']);
  assert.deepEqual(go('?sale=1&sample=1'), []);
  assert.deepEqual(go('?lab=長尺'), ['w2']);
  assert.deepEqual(go('?year=2026'), ['w2', 'w1', 'w4']);
  assert.deepEqual(go('?q=メーカーＡ'), ['w3', 'w1']); // 全角も正規化してメーカー名に当たる
  assert.deepEqual(go('?q=出演者B シリーズA'), ['w2']);
});

test('applyPreset / presetActive: 目的別チップは条件と並べ替えをまとめて設定し、もう一度押すと外す', () => {
  const base = { ...defaults(), g: ['タグ01'] };
  const safe = applyPreset(base, 'safe');
  assert.deepEqual([safe.sort, safe.rev, safe.g], ['rating', true, ['タグ01']]); // ほかの条件は残す
  assert.equal(presetActive(safe, 'safe'), true);
  assert.deepEqual(applyPreset(safe, 'safe'), base);
  assert.deepEqual([applyPreset(base, 'fresh').sort, applyPreset(base, 'fresh').days], ['new', '30']);
  assert.deepEqual([applyPreset(base, 'cheap').sort, applyPreset(base, 'cheap').sale], ['cheap', true]);
  assert.deepEqual([applyPreset(base, 'long').sort, applyPreset(base, 'long').len], ['rating', 'l']);
  assert.deepEqual(ids(run(WORKS(), applyPreset(defaults(), 'long'), IX, NOW)), ['w2', 'w3']);
});

test('activeChips / removeChip / filterCount: 適用中の条件を一覧にし、1 つずつ外せる。検索語は「検索: …」', () => {
  const st = readURL('?q=作品&g=タグ01&act=出演者A&pb=2&len=l&sale=1&lab=長尺');
  const chips = activeChips(st);
  assert.deepEqual(chips.map((c: any) => c.label), ['検索: 作品', 'タグ01', '出演: 出演者A', '〜2,000円', '120分〜', 'セール中', '長尺']);
  assert.equal(filterCount(st), 6);
  let s = st;
  for (const c of chips) s = removeChip(s, c.k, c.v);
  assert.deepEqual(s, defaults());
  assert.deepEqual(removeChip(st, 'pb', '2').pb, []);
});

test('loadWorks: チャンクを並列に取り、1 チャンク目が届いた時点で onFirst を呼ぶ。戻り値はチャンク順', async () => {
  const calls: string[] = [];
  const resolvers = new Map<string, (v: unknown) => void>();
  const getJson = (url: string) => {
    calls.push(url.replace(/\?.*$/, ''));
    if (url.startsWith('/data/index.json')) return Promise.resolve({ generatedAt: 'x', chunks: ['works-000.json', 'works-001.json'] });
    return new Promise((r) => resolvers.set(url.replace(/\?.*$/, ''), r));
  };
  let first: unknown = null;
  const p = loadWorks({ getJson, onFirst: (_: unknown, part: unknown) => { first = part; } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['/data/index.json', '/data/works-000.json', '/data/works-001.json']); // 2 つ目を待たずに両方を取りに行く
  resolvers.get('/data/works-000.json')!([card('a')]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ids(first as any[]), ['a']);
  resolvers.get('/data/works-001.json')!([card('b')]);
  assert.deepEqual(ids((await p).works), ['a', 'b']);
});
