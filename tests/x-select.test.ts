import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DerivedLabel } from '../src/data/types.ts';
import { postText } from '../src/lib/autotext.ts';
import { buildCatalog } from '../src/lib/catalog.ts';
import type { CatalogWork } from '../src/lib/catalog.ts';
import { composePost } from '../src/x/compose.ts';
import { selectWorks } from '../src/x/select.ts';
import { jstDateKey, openPostStore } from '../src/x/store.ts';
import type { PostStore } from '../src/x/store.ts';

const ref = (id: string, name: string) => ({ id, name });
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-01T03:00:00Z'); // 日本時間 12:00
const MIX: DerivedLabel[] = ['新作', 'セール中', '高評価', '初見向け'];

/** 中立な名前だけで作った作品。変えたい項目だけ渡す */
function mk(id: string, over: Partial<CatalogWork> = {}): CatalogWork {
  return {
    contentId: id, productId: null, title: `作品 ${id}`, url: null, affiliateUrl: null, volumeMin: 120, releasedAt: '2026-10-01',
    reviewCount: 10, reviewAvg: 4.0, priceMin: 1480, listPrice: 1980, deliveries: [], imageList: null, imageSmall: null, imageLarge: null,
    sampleImages: [], sampleMovie: null, campaigns: [], genres: [], actresses: [], series: [], makers: [], labels: [], directors: [],
    rankPosition: null, fetchedAt: '2026-11-01T00:00:00Z', status: 'active', derivedLabels: [], similarIds: [], ...over,
  };
}
/** 4ラベル × n 件（ID は ラベル番号+連番。出演者は作品ごとに別） */
const labeled = (n: number): CatalogWork[] => MIX.flatMap((label, li) => Array.from({ length: n }, (_, i) =>
  mk(`${li}${String(i).padStart(2, '0')}`, { derivedLabels: [label], actresses: [ref(`act${li}${i}`, `出演者${li}${i}`)] })));
const ids = (l: CatalogWork[]): string[] => l.map((w) => w.contentId);
const post = (s: PostStore, id: string, at: Date, dryRun = false): void =>
  s.recordPost({ contentId: id, postedAt: at, tweetId: dryRun ? null : '1', text: 'x', kind: 'daily', dryRun });
const shares = (a: CatalogWork, b: CatalogWork): boolean =>
  a.actresses.some((x) => b.actresses.some((y) => x.id === y.id)) || a.series.some((x) => b.series.some((y) => x.id === y.id));
const adjacent = (l: CatalogWork[]): number => l.slice(1).filter((w, i) => shares(l[i], w)).length;

describe('投稿履歴（store）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-store-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('日付キーは日本時間（UTC+9）', () => {
    assert.equal(jstDateKey(new Date('2026-11-01T14:59:59Z')), '2026-11-01');
    assert.equal(jstDateKey(new Date('2026-11-01T15:00:00Z')), '2026-11-02');
  });
  it('recentContentIds は days 日前ちょうどを含み、それより前は含まない', () => {
    const s = openPostStore(':memory:');
    post(s, 'edge', new Date(NOW.getTime() - 30 * DAY)); post(s, 'old', new Date(NOW.getTime() - 30 * DAY - 1)); post(s, 'new', NOW);
    assert.deepEqual([...s.recentContentIds(30, NOW)].sort(), ['edge', 'new']);
    assert.throws(() => s.recentContentIds(-1), RangeError);
    s.close(); s.close(); // 2回閉じても落ちない
  });
  it('countPostsOn は日本時間の日付で数え、実投稿と dry-run を分ける。contentIdsOn は古い順', () => {
    const s = openPostStore(':memory:');
    post(s, 'a', new Date('2026-11-01T14:59:59Z')); post(s, 'b', new Date('2026-11-01T15:00:00Z'), true);
    post(s, 'c', new Date('2026-11-01T00:00:00Z')); post(s, 'd', new Date('2026-11-02T00:00:00Z'));
    assert.deepEqual([s.countPostsOn('2026-11-01'), s.countPostsOn('2026-11-01', true)], [2, 0]);
    assert.deepEqual([s.countPostsOn('2026-11-02'), s.countPostsOn('2026-11-02', true)], [1, 1]);
    assert.deepEqual(s.contentIdsOn('2026-11-01'), ['c', 'a']);
    assert.throws(() => s.countPostsOn('2026/11/01'), RangeError);
    assert.throws(() => s.recordPost({ contentId: 'z', postedAt: NOW, tweetId: null, text: 'x', kind: 'bogus' as never, dryRun: true }), RangeError);
    s.close();
  });
  it('既存の DB を開いても x_posts テーブルしか作らず、他のテーブルは変えない。履歴はファイルに残る', () => {
    const path = join(dir, 'sub', 'catalog.sqlite');
    openPostStore(path).close(); // 親ディレクトリも作る
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE x_posts; CREATE TABLE works (id TEXT); INSERT INTO works VALUES ('w1')");
    raw.close();
    const s = openPostStore(path);
    post(s, 'p1', NOW); s.close();
    const again = openPostStore(path);
    assert.deepEqual([...again.recentContentIds(1, NOW)], ['p1']);
    again.close();
    const check = new DatabaseSync(path);
    assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name), ['works', 'x_posts']);
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM works').get()!.n, 1);
    check.close();
  });
});

describe('selectWorks', () => {
  it('直近 30 日に投稿した作品を除く（40 日前の投稿は対象に戻る）。dry-run の記録も除く', () => {
    const cat = buildCatalog(labeled(3)), s = openPostStore(':memory:');
    for (const id of ['000', '100']) post(s, id, new Date(NOW.getTime() - 5 * DAY));
    post(s, '200', new Date(NOW.getTime() - 5 * DAY), true); post(s, '300', new Date(NOW.getTime() - 40 * DAY));
    const all = ids(selectWorks(cat, s, { count: 100, now: NOW }));
    assert.equal(all.length, 9);
    assert.ok(!all.some((id) => ['000', '100', '200'].includes(id)) && all.includes('300'));
    assert.equal(selectWorks(cat, s, { count: 100, now: NOW, dedupDays: 1 }).length, 12); // 1 日なら 5 日前の投稿も対象に戻る
  });
  it('ラベルを順に巡る: 4件なら各ラベル1件、8件なら各ラベル2件', () => {
    const cat = buildCatalog(labeled(5)), s = openPostStore(':memory:');
    for (const d of [1, 2, 3, 4, 5]) {
      const now = new Date(`2026-11-0${d}T03:00:00Z`);
      const count = (n: number): Record<string, number> => selectWorks(cat, s, { count: n, now }).reduce((m, w) => ({ ...m, [w.derivedLabels[0]]: (m[w.derivedLabels[0]] ?? 0) + 1 }), {} as Record<string, number>);
      assert.deepEqual(count(4), { 新作: 1, セール中: 1, 高評価: 1, 初見向け: 1 });
      assert.deepEqual(count(8), { 新作: 2, セール中: 2, 高評価: 2, 初見向け: 2 });
    }
  });
  it('1回に1件ずつ投稿しても、その日のうちにラベルが巡る（履歴の件数で先頭をずらす）', () => {
    const cat = buildCatalog(labeled(5)), s = openPostStore(':memory:');
    const labels = [0, 1, 2, 3].map(() => {
      const [w] = selectWorks(cat, s, { count: 1, now: NOW });
      post(s, w.contentId, NOW);
      return w.derivedLabels[0];
    });
    assert.equal(new Set(labels).size, 4);
  });
  it('ラベルの候補が足りなければ、残りをレビュー件数の多い順で補う。件数が候補より多ければ全部返す', () => {
    const labelled = MIX.map((label, i) => mk(`L${i}`, { derivedLabels: [label], reviewCount: 1 }));
    const rest = [20, 90, 50, 70].map((n) => mk(`R${n}`, { reviewCount: n }));
    const cat = buildCatalog([...labelled, ...rest]), s = openPostStore(':memory:');
    const got = ids(selectWorks(cat, s, { count: 7, now: NOW }));
    assert.deepEqual(got.slice(0, 4).sort(), ['L0', 'L1', 'L2', 'L3']);
    assert.deepEqual(got.slice(4), ['R90', 'R70', 'R50']);
    assert.equal(selectWorks(cat, s, { count: 99, now: NOW }).length, 8);
    assert.deepEqual(selectWorks(buildCatalog([]), s, { count: 3, now: NOW }), []);
    assert.throws(() => selectWorks(cat, s, { count: -1, now: NOW }), RangeError);
  });
  it('mix を指定すると、そのラベルだけを巡る', () => {
    const cat = buildCatalog(labeled(5)), s = openPostStore(':memory:');
    const got = selectWorks(cat, s, { count: 5, now: NOW, mix: ['セール中'] });
    assert.ok(got.every((w) => w.derivedLabels[0] === 'セール中'));
  });
  it('同じ出演者・同じシリーズの作品を続けて選ばない（日をまたぐ検査も含む）', () => {
    const [A, B, C, S] = [ref('A', '出演者A'), ref('B', '出演者B'), ref('C', '出演者C'), ref('S', 'シリーズS')];
    const many = (p: string, label: DerivedLabel, n: number, over: Partial<CatalogWork>): CatalogWork[] =>
      Array.from({ length: n }, (_, i) => mk(`${p}${i}`, { derivedLabels: [label], ...over }));
    const cat = buildCatalog([...many('n', '新作', 8, { actresses: [A] }), ...many('s', 'セール中', 8, { actresses: [A] }),
      ...many('h', '高評価', 4, { actresses: [B], series: [S] }), ...many('f', '初見向け', 4, { actresses: [C], series: [S] })]);
    for (let d = 1; d <= 9; d++) { // 出演者A どうし、シリーズS どうし（出演者が違っても）が並ばない
      const got = selectWorks(cat, openPostStore(':memory:'), { count: 8, now: new Date(`2026-11-0${d}T03:00:00Z`) });
      assert.equal(got.length, 8);
      assert.equal(adjacent(got), 0, ids(got).join(','));
    }
    const s = openPostStore(':memory:');
    post(s, 'n0', new Date(NOW.getTime() - 3600_000)); // 同じ日の直前の投稿は出演者A
    const first = selectWorks(cat, s, { count: 1, now: NOW })[0];
    assert.ok(!shares(cat.byId.get('n0')!, first), first.contentId);
    // 前日の投稿とは比べない・避けようがないときは重なりを許して件数を満たす
    assert.equal(selectWorks(buildCatalog(many('x', '新作', 3, { actresses: [A] })), openPostStore(':memory:'), { count: 3, now: NOW }).length, 3);
  });
  it('決定的: 同じ入力は同じ結果、同じ日本時間の日付なら時刻が違っても同じ、日が変われば変わる', () => {
    const cat = buildCatalog(labeled(10)), s = openPostStore(':memory:');
    const run = (iso: string): string => ids(selectWorks(cat, s, { count: 6, now: new Date(iso) })).join(',');
    assert.equal(run('2026-11-01T03:00:00Z'), run('2026-11-01T03:00:00Z'));
    assert.equal(run('2026-10-31T15:00:00Z'), run('2026-11-01T14:59:59Z'));
    assert.ok(new Set([1, 2, 3, 4, 5, 6, 7, 8].map((d) => run(`2026-11-0${d}T03:00:00Z`))).size > 1);
  });
});

describe('composePost', () => {
  const long = mk('LONG001', { title: 'あ'.repeat(200), actresses: [ref('A', '出演者A')], derivedLabels: ['新作'] });
  it('URL なしは自動文そのもの（末尾 " #PR"、140 字以内）', () => {
    const w = mk('W1', { reviewAvg: 4.5, reviewCount: 10 });
    assert.equal(composePost(w, { withUrl: false, siteUrl: 'https://example.com' }), postText(w));
    assert.ok(postText(w).endsWith(' #PR') && composePost(long, { withUrl: false, siteUrl: '' }).length <= 140);
  });
  it('URL ありは末尾に改行と /v/{contentId}/ を付ける（SITE_URL の末尾のスラッシュは重ねない）', () => {
    const w = mk('W1');
    assert.equal(composePost(w, { withUrl: true, siteUrl: ' https://example.com// ' }), `${postText(w)}\nhttps://example.com/v/W1/`);
  });
  it('140 字を超えるときは、本文側を「…」で切り詰め、" #PR" と URL は残す', () => {
    const url = 'https://example.com/v/LONG001/';
    const text = composePost(long, { withUrl: true, siteUrl: 'https://example.com' });
    assert.ok(text.length <= 140 && text.endsWith(` #PR\n${url}`) && text.includes('…'), text);
    assert.ok(text.length > 130, '切り詰めすぎない');
    const emoji = composePost(mk('E1', { title: '😀'.repeat(200) }), { withUrl: true, siteUrl: 'https://example.com' });
    assert.ok(emoji.isWellFormed() && emoji.length <= 140, 'サロゲートペアを割らない');
  });
  it('SITE_URL が無効・長すぎるときはエラー', () => {
    assert.throws(() => composePost(long, { withUrl: true, siteUrl: '' }), /SITE_URL/);
    assert.throws(() => composePost(long, { withUrl: true, siteUrl: 'example.com' }), /SITE_URL/);
    assert.throws(() => composePost(long, { withUrl: true, siteUrl: `https://example.com/${'p'.repeat(120)}` }), /長すぎ/);
  });
});
