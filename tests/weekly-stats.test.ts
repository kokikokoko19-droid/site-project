import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../src/lib/catalog.ts';
import type { CatalogWork } from '../src/lib/catalog.ts';
import { computeWeeklyStats, factsText, jstDate, updatedLabel } from '../src/lib/weekly-stats.ts';

const ref = (id: string, name: string) => ({ id, name });
function mk(id: string, over: Partial<CatalogWork> = {}): CatalogWork {
  return {
    contentId: id, productId: null, title: `題名-${id}`, url: null, affiliateUrl: null, volumeMin: 120, releasedAt: '2026-01-01',
    reviewCount: 10, reviewAvg: 4.0, priceMin: 1500, listPrice: 2000, deliveries: [], imageList: null, imageSmall: null, imageLarge: null,
    sampleImages: [], sampleMovie: null, campaigns: [], genres: [], actresses: [], series: [], makers: [], labels: [], directors: [],
    rankPosition: null, fetchedAt: '2026-11-01T00:00:00Z', status: 'active', derivedLabels: [], similarIds: [], ...over,
  };
}
const NOW = new Date('2026-11-15T03:00:00Z'); // 日本時間 11/15 12:00

describe('週次の集計', () => {
  const A = ref('a1', '出演者A'), B = ref('a2', '出演者B'), M = ref('m1', 'メーカーA'), S = ref('s1', 'シリーズA');
  const works = [
    mk('1', { releasedAt: '2026-11-15', reviewCount: 5, reviewAvg: 4.5, actresses: [A], makers: [M], genres: [ref('g1', 'タグ')] }),
    mk('2', { releasedAt: '2026-11-08T10:00:00', reviewCount: 2, reviewAvg: 5, actresses: [A, B], series: [S] }),         // 7 日前は新着。件数が少ないので高評価に数えない
    mk('3', { releasedAt: '2026-11-07', reviewCount: 30, actresses: [A] }),                                                   // 8 日前は新着でない
    mk('4', { releasedAt: '2026-11-20', reviewCount: 50 }),                                                                  // 未来は新着でない
    mk('5', { releasedAt: null, reviewCount: 21, derivedLabels: ['セール中'], priceMin: 1000, listPrice: 2000 }),             // 50%
    mk('6', { derivedLabels: ['セール中'], priceMin: 1500, listPrice: 2000 }),                                               // 25%
    mk('7', { derivedLabels: ['セール中'], priceMin: 1500, listPrice: null }),                                               // 割引は読めない
    mk('8', { status: 'gone', reviewCount: 99, actresses: [B] }),
  ];
  const stats = computeWeeklyStats(buildCatalog(works, { lastIngestAt: '2026-11-14T21:30:00Z' }), NOW);

  it('件数を数える（gone は除く）', () => {
    assert.equal(stats.asOf, '2026-11-15');
    assert.equal(stats.total, 7);
    assert.equal(stats.newCount, 2);
    assert.equal(stats.highRatedNew, 1);
    assert.equal(stats.reviewOver20, 3); // 3・4・5（20 ちょうどは数えない）
    assert.equal(stats.saleCount, 3);
  });
  it('割引率の中央値（読み取れるものだけ）', () => assert.equal(stats.saleDiscountMedian, 38)); // 25 と 50 の中央 37.5 を丸める
  it('上位は作品数の降順で、名前を持つ', () => {
    assert.deepEqual(stats.topActresses, [{ name: '出演者A', count: 3 }, { name: '出演者B', count: 1 }]);
    assert.deepEqual(stats.topSeries, [{ name: 'シリーズA', count: 1 }]);
    assert.deepEqual(stats.topMakers, [{ name: 'メーカーA', count: 1 }]);
  });
  it('更新日は日本時間で数える', () => {
    assert.equal(updatedLabel(stats), '11月15日'); // UTC 11/14 21:30 = 日本時間 11/15 6:30
    assert.equal(jstDate(new Date('2026-11-14T15:00:00Z')), '2026-11-15');
  });
  it('事実の一覧に題名・ジャンル名を含めず、「不明」「null」を出さない', () => {
    const t = factsText(stats);
    assert.ok(!t.includes('題名-') && !t.includes('タグ'));
    assert.ok(!/不明|null|undefined/.test(t));
    assert.match(t, /出演者A（3作品）/);
  });
  it('作品が無いカタログでも動き、無い項目は行ごと省く', () => {
    const empty = computeWeeklyStats(buildCatalog([]), NOW);
    assert.equal(empty.total, 0);
    assert.equal(empty.saleDiscountMedian, null);
    assert.equal(updatedLabel(empty), null);
    const t = factsText(empty);
    assert.ok(!t.includes('セール') && !t.includes('更新日') && !t.includes('作品数の多い'));
  });
});
