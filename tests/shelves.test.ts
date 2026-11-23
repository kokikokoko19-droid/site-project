import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../src/lib/catalog.ts';
import type { CatalogWork } from '../src/lib/catalog.ts';
import { commentMap, dailyAxisShelves, hash32, neighborRefs, pickDaily, rankRefs, shelfPop, strollShelves } from '../src/lib/shelves.ts';

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

// ジャンル g0..g9 に、g0 は 10 本、g1 は 9 本……と作品数に差を付ける。出演者・シリーズも同様
const works: CatalogWork[] = [];
for (let i = 0; i < 60; i++) {
  const genres = [];
  for (let g = 0; g < 10; g++) if (i % (g + 1) === 0 || i < 10 - g) genres.push({ id: `g${g}`, name: `ジャンル${g}` });
  works.push(mk(`w${i}`, {
    releasedAt: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`,
    genres,
    actresses: [{ id: `a${i % 5}`, name: `出演者${i % 5}` }],
    series: [{ id: `s${i % 3}`, name: `シリーズ${i % 3}` }],
    derivedLabels: i % 4 === 0 ? ['高評価', '定番', 'セール中'] : [],
  }));
}
const c = buildCatalog(works);

describe('pickDaily', () => {
  it('同じ日は同じ結果、日が変われば並びが変わりうる', () => {
    const pool = Array.from({ length: 30 }, (_, i) => `x${i}`);
    assert.deepEqual(pickDaily(pool, 5, '2026-11-15', (x) => x), pickDaily(pool, 5, '2026-11-15', (x) => x));
    const days = new Set(['2026-11-15', '2026-11-16', '2026-11-17'].map((d) => pickDaily(pool, 5, d, (x) => x).join()));
    assert.ok(days.size > 1);
  });
  it('候補が 1 つ減っても、残りの相対順位は変わらない', () => {
    const pool = Array.from({ length: 20 }, (_, i) => `x${i}`);
    const all = pickDaily(pool, 20, '2026-11-15', (x) => x);
    const less = pickDaily(pool.filter((x) => x !== all[0]), 19, '2026-11-15', (x) => x);
    assert.deepEqual(less, all.slice(1));
  });
  it('hash32 は 32bit の符号なし整数', () => {
    const h = hash32('2026-11-15|g1');
    assert.ok(Number.isInteger(h) && h >= 0 && h < 2 ** 32);
  });
});

describe('rankRefs と dailyAxisShelves', () => {
  it('作品数の多い順、同数は id 順', () => {
    const r = rankRefs(c.byGenre, c.refNames.genre);
    for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].count >= r[i].count);
    assert.equal(r[0].id, 'g0');
  });
  it('上位の候補から n 本の棚を作り、表紙は最大 per 枚、件数は総数', () => {
    const s = dailyAxisShelves(c, 'genre', '2026-11-15', { n: 3, pool: 5, per: 10 });
    assert.equal(s.length, 3);
    const top5 = new Set(rankRefs(c.byGenre, c.refNames.genre).slice(0, 5).map((r) => r.id));
    for (const sh of s) {
      assert.ok(top5.has(sh.key.replace('genre-', '')));
      assert.ok(sh.works.length <= 10);
      assert.equal(sh.count, c.byGenre.get(sh.key.replace('genre-', ''))!.length);
      assert.match(sh.href, /^\/genre\/g\d\/$/);
    }
  });
});

describe('strollShelves', () => {
  it('最大 12 本、キーが重ならず、同じ日は同じ', () => {
    const a = strollShelves(c, '2026-11-15');
    const b = strollShelves(c, '2026-11-15');
    assert.deepEqual(a.map((s) => s.key), b.map((s) => s.key));
    assert.ok(a.length <= 12 && a.length >= 8);
    assert.equal(new Set(a.map((s) => s.key)).size, a.length);
    assert.ok(a.some((s) => s.kind === 'new') && a.some((s) => s.kind === 'sale') && a.some((s) => s.kind === 'rated'));
    // 出演者は 5 人いるので 3 本、シリーズは 3 件あるので 2 本
    assert.equal(a.filter((s) => s.kind === 'actress').length, 3);
    assert.equal(a.filter((s) => s.kind === 'series').length, 2);
  });
  it('作品が無ければ空', () => {
    assert.deepEqual(strollShelves(buildCatalog([]), '2026-11-15'), []);
  });
});

describe('neighborRefs', () => {
  const r = rankRefs(c.byGenre, c.refNames.genre).map((x) => x.id);
  it('真ん中なら前後 2 件ずつ', () => {
    const got = neighborRefs(c.byGenre, c.refNames.genre, r[5]).map((x) => x.id);
    assert.deepEqual(got, [r[3], r[4], r[6], r[7]]);
  });
  it('先頭・末尾では反対側から足して 4 件', () => {
    assert.deepEqual(neighborRefs(c.byGenre, c.refNames.genre, r[0]).map((x) => x.id), r.slice(1, 5));
    assert.deepEqual(neighborRefs(c.byGenre, c.refNames.genre, r[r.length - 1]).map((x) => x.id), r.slice(-5, -1));
  });
  it('知らない id や軸が小さいとき', () => {
    assert.deepEqual(neighborRefs(c.byGenre, c.refNames.genre, 'nope'), []);
    assert.equal(neighborRefs(c.bySeries, c.refNames.series, 's0').length, 2);
  });
});

describe('commentMap と shelfPop', () => {
  it('空の一言と壊れた値を飛ばし、棚の中で最初に一言がある作品のものを返す', () => {
    const m = commentMap({ items: [{ id: 'w3', comment: ' 一言 ' }, { id: 'w1', comment: '  ' }, { id: 5 as unknown as string, comment: 'x' }] });
    assert.deepEqual([...m], [['w3', '一言']]);
    assert.equal(shelfPop([c.byId.get('w1')!, c.byId.get('w3')!], m), '一言');
    assert.equal(shelfPop([c.byId.get('w1')!], m), null);
    assert.equal(commentMap(null).size, 0);
  });
});
