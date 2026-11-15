import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../src/lib/catalog.ts';
import type { CatalogWork } from '../src/lib/catalog.ts';
import { pickFeatured } from '../src/lib/featured.ts';

function mk(id: string, over: Partial<CatalogWork> = {}): CatalogWork {
  return {
    contentId: id, productId: null, title: `作品 ${id}`, url: null, affiliateUrl: null,
    volumeMin: 120, releasedAt: '2026-10-01', reviewCount: 10, reviewAvg: 4.0, priceMin: 1480, listPrice: 1980,
    deliveries: [], imageList: null, imageSmall: null, imageLarge: null, sampleImages: [], sampleMovie: null, campaigns: [],
    genres: [], actresses: [], series: [], makers: [], labels: [], directors: [],
    rankPosition: null, fetchedAt: '2026-11-01T00:00:00Z', status: 'active',
    derivedLabels: [], similarIds: [], outboundUrl: null, ...over,
  };
}

const works = [
  mk('h1', { derivedLabels: ['高評価'], releasedAt: '2026-10-05' }),
  mk('h2', { derivedLabels: ['高評価'], releasedAt: '2026-10-04' }),
  mk('n1', { releasedAt: '2026-10-09' }),
  mk('n2', { releasedAt: '2026-10-08' }),
  mk('n3', { releasedAt: '2026-10-07' }),
  mk('n4', { releasedAt: '2026-10-06' }),
];
const c = buildCatalog(works);

describe('pickFeatured', () => {
  it('指定が無ければ高評価、続けて新着で 5 件まで補い、すべて auto', () => {
    const got = pickFeatured(c, { items: [] });
    assert.deepEqual(got.map((x) => x.work.contentId), ['h1', 'h2', 'n1', 'n2', 'n3']);
    assert.ok(got.every((x) => x.source === 'auto' && x.comment === null));
  });
  it('運営者の指定を先に置き、存在しない ID・重複は飛ばす。一言は空白なら null', () => {
    const got = pickFeatured(c, { items: [{ id: 'n4', comment: ' 一言 ' }, { id: 'nope' }, { id: 'n4' }, { id: 'h2', comment: '  ' }] });
    assert.deepEqual(got.map((x) => [x.work.contentId, x.source, x.comment]), [
      ['n4', 'pick', '一言'], ['h2', 'pick', null], ['h1', 'auto', null], ['n1', 'auto', null], ['n2', 'auto', null],
    ]);
  });
  it('設定が無い・壊れていても動く。上限を超える指定は切る', () => {
    assert.equal(pickFeatured(c, null).length, 5);
    assert.equal(pickFeatured(c, { items: 'x' as never }).length, 5);
    const many = { items: ['n1', 'n2', 'n3', 'n4', 'h1', 'h2'].map((id) => ({ id })) };
    assert.deepEqual(pickFeatured(c, many).map((x) => x.source), ['pick', 'pick', 'pick', 'pick', 'pick']);
  });
});
