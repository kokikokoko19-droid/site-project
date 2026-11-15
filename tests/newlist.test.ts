import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../src/lib/catalog.ts';
import type { CatalogWork } from '../src/lib/catalog.ts';
import { addDays, dayHeading, facetCounts, groupByDay, jstToday, splitNew } from '../src/lib/newlist.ts';

function mk(id: string, releasedAt: string | null, genres: { id: string; name: string }[] = []): CatalogWork {
  return {
    contentId: id, productId: null, title: `作品 ${id}`, url: null, affiliateUrl: null,
    volumeMin: 120, releasedAt, reviewCount: 0, reviewAvg: null, priceMin: null, listPrice: null,
    deliveries: [], imageList: null, imageSmall: null, imageLarge: null, sampleImages: [], sampleMovie: null, campaigns: [],
    genres, actresses: [], series: [], makers: [], labels: [], directors: [],
    rankPosition: null, fetchedAt: '2026-11-01T00:00:00Z', status: 'active',
    derivedLabels: [], similarIds: [], outboundUrl: null,
  };
}
const G1 = { id: 'g1', name: 'タグ1' }, G2 = { id: 'g2', name: 'タグ2' };

describe('newlist', () => {
  it('jstToday は日本時間の日付、addDays は月をまたぐ', () => {
    assert.equal(jstToday(new Date('2026-11-14T15:30:00Z')), '2026-11-15');
    assert.equal(addDays('2026-11-01', -1), '2026-10-31');
    assert.equal(addDays('2026-11-15', -29), '2026-10-17');
  });
  it('splitNew: 今日より後は近日配信（近い順）、30 日より前と日付なしは外す', () => {
    const c = buildCatalog([
      mk('f2', '2026-11-20T10:00:00'), mk('f1', '2026-11-16'), mk('t', '2026-11-15T00:00:00'),
      mk('d29', '2026-10-17'), mk('d30', '2026-10-16'), mk('x', null),
    ]);
    const { upcoming, recent } = splitNew(c.recent(100), '2026-11-15');
    assert.deepEqual(upcoming.map((w) => w.contentId), ['f1', 'f2']);
    assert.deepEqual(recent.map((w) => w.contentId), ['t', 'd29']);
  });
  it('groupByDay と dayHeading', () => {
    const g = groupByDay([mk('a', '2026-11-14'), mk('b', '2026-11-14T09:00:00'), mk('c', '2026-11-13')]);
    assert.deepEqual(g.map((x) => [x.day, x.works.length]), [['2026-11-14', 2], ['2026-11-13', 1]]);
    assert.equal(dayHeading('2026-11-14'), '11月14日（土）');
    assert.equal(dayHeading(''), '');
  });
  it('facetCounts は多い順、同数は名前順。1 作品内の重複は 1 回', () => {
    const got = facetCounts([mk('a', null, [G2, G2]), mk('b', null, [G1, G2]), mk('c', null, [G1])], (w) => w.genres);
    assert.deepEqual(got, [{ id: 'g1', name: 'タグ1', count: 2 }, { id: 'g2', name: 'タグ2', count: 2 }]);
  });
});
