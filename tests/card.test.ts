import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cardLabels, saleEnd, toCard } from '../src/lib/card.ts';
import type { CatalogWork } from '../src/lib/catalog.ts';

function mk(over: Partial<CatalogWork> = {}): CatalogWork {
  return {
    contentId: 'w0001', productId: null, title: '作品 0001', url: null, affiliateUrl: null,
    volumeMin: 120, releasedAt: '2026-11-01', reviewCount: 10, reviewAvg: 4.2, priceMin: 1400, listPrice: 2000,
    deliveries: [], imageList: null, imageSmall: null, imageLarge: null, sampleImages: [], sampleMovie: null, campaigns: [],
    genres: [], actresses: [], series: [], makers: [], labels: [], directors: [],
    rankPosition: null, fetchedAt: '2026-11-01T00:00:00Z', status: 'active',
    derivedLabels: [], similarIds: [], outboundUrl: null, ...over,
  };
}

describe('cardLabels', () => {
  it('セール中＞高評価＞新作の順に最大2つ。「〜追い向け」は出さない', () => {
    assert.deepEqual(cardLabels(['新作', '高評価', 'セール中']), ['セール中', '高評価']);
    assert.deepEqual(cardLabels(['新作', '長尺']), ['新作', '長尺']);
    assert.deepEqual(cardLabels(['シリーズ追い向け', '出演者追い向け']), []);
  });
  it('省くラベルを指定できる', () => {
    assert.deepEqual(cardLabels(['セール中', '高評価', '新作'], ['セール中']), ['高評価', '新作']);
  });
});

describe('saleEnd', () => {
  const now = new Date('2026-11-15T03:00:00Z');
  it('続いているキャンペーンのうち最も早い終了日を月/日で返す', () => {
    const w = mk({ campaigns: [{ title: 'A', begin: '2026-11-01T00:00:00', end: '2026-11-30T23:59:59' }, { title: 'B', begin: null, end: '2026-11-20T23:59:59' }] });
    assert.equal(saleEnd(w, now), '11/20');
  });
  it('終わったもの・始まっていないもの・終了日なしは数えない', () => {
    const w = mk({ campaigns: [{ title: 'A', begin: null, end: '2026-11-14T23:59:59' }, { title: 'B', begin: '2026-11-20T00:00:00', end: '2026-11-25T00:00:00' }, { title: 'C', begin: null, end: null }] });
    assert.equal(saleEnd(w, now), '');
  });
});

describe('toCard', () => {
  it('セール中は価格・定価・割引率を持つ。セールでなければ null', () => {
    assert.deepEqual(toCard(mk({ derivedLabels: ['セール中'] })).sale, { price: 1400, list: 2000, off: 30, end: '' });
    assert.equal(toCard(mk()).sale, null);
  });
  it('横長の大きいジャケット（imageLarge）を持ち、無ければ null', () => {
    assert.equal(toCard(mk({ imageLarge: 'https://example.invalid/x/xpl.jpg' })).imageLarge, 'https://example.invalid/x/xpl.jpg');
    assert.equal(toCard(mk()).imageLarge, null);
  });
});
