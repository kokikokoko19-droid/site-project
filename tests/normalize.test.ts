// 実行: node --experimental-strip-types --test tests/normalize.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItem, normalizeItems } from '../src/data/normalize.ts';
import { syntheticItem, syntheticItemList } from '../src/data/synthetic.ts';

const OPTS = { fetchedAt: '2026-11-01T09:00:00' };
/** content_id と title だけの raw に、検証したい項目を足して正規化する */
const norm = (extra: Record<string, any> = {}) => normalizeItem({ content_id: 'abc00001', title: '作品 0001', ...extra }, OPTS);
const U = (name: string) => `https://example.invalid/${name}`;

test('欠落項目は既定値になり、固定値が入る（Work のキー集合もここで確認）', () => {
  assert.deepEqual(norm(), {
    contentId: 'abc00001', productId: null, title: '作品 0001', url: null, affiliateUrl: null,
    volumeMin: null, releasedAt: null, reviewCount: 0, reviewAvg: null, priceMin: null, listPrice: null,
    deliveries: [], imageList: null, imageSmall: null, imageLarge: null, sampleImages: [], sampleMovie: null,
    campaigns: [], genres: [], actresses: [], series: [], makers: [], labels: [], directors: [],
    rankPosition: null, fetchedAt: OPTS.fetchedAt, status: 'active',
  });
});

test('product_id・URL・affiliateURL はそのまま入る', () => {
  const w = norm({ product_id: 'abc00001', URL: U('w'), affiliateURL: U('af') });
  assert.deepEqual([w.productId, w.url, w.affiliateUrl], ['abc00001', U('w'), U('af')]);
});

test('review.average は文字列から数値になる。review 欠落・0件は count 0 / avg null', () => {
  const w = norm({ review: { count: 123, average: '4.84' } });
  assert.deepEqual([w.reviewCount, w.reviewAvg], [123, 4.84]);
  assert.equal(norm({ review: { count: '7', average: '3.5' } }).reviewAvg, 3.5);
  assert.equal(norm({ review: { count: 0, average: '0.00' } }).reviewAvg, null);
  assert.deepEqual([norm().reviewCount, norm().reviewAvg], [0, null]);
});

test('volume は分表記と h:m:s 表記の両方を分（整数）にする', () => {
  assert.equal(norm({ volume: '120' }).volumeMin, 120);
  assert.equal(norm({ volume: '1:29:00' }).volumeMin, 89);
  assert.equal(norm({ volume: '2:00:00' }).volumeMin, 120);
  assert.equal(norm({ volume: '1:29:30' }).volumeMin, 90); // 秒は四捨五入
  assert.equal(norm({ volume: 95 }).volumeMin, 95);
  assert.equal(norm({ volume: '' }).volumeMin, null);
  assert.equal(norm().volumeMin, null);
});

test('prices の文字列（"500~"・"1,980"）は数値になり、deliveries は配列になる', () => {
  const w = norm({
    prices: {
      price: '500~', list_price: '1,980',
      deliveries: { delivery: [{ type: 'hd', price: '980', list_price: '1,980' }, { type: 'stream', price: '500' }] },
    },
  });
  assert.deepEqual([w.priceMin, w.listPrice], [500, 1980]);
  assert.deepEqual(w.deliveries, [
    { type: 'hd', price: 980, listPrice: 1980 },
    { type: 'stream', price: 500, listPrice: null },
  ]);
  assert.equal(norm({ prices: { price: '1,980' } }).priceMin, 1980);
  assert.equal(norm({ prices: { price: 700 } }).priceMin, 700);
  const bare = norm({ prices: { price: '700' } });
  assert.deepEqual([bare.listPrice, bare.deliveries], [null, []]); // list_price・deliveries 欠落
  assert.deepEqual([norm().priceMin, norm().listPrice, norm().deliveries], [null, null, []]);
});

test('date は2形式とも ISO 形式（タイムゾーンなし）になる。欠落・不正は null', () => {
  assert.equal(norm({ date: '2024-05-01 10:00:00' }).releasedAt, '2024-05-01T10:00:00');
  assert.equal(norm({ date: '2024/5/3 9:05' }).releasedAt, '2024-05-03T09:05:00');
  assert.equal(norm({ date: '2024-02-30 00:00:00' }).releasedAt, null);
  assert.equal(norm({ date: 'いつか' }).releasedAt, null);
  assert.equal(norm().releasedAt, null);
});

test('imageURL は欠落したキーだけ null になる', () => {
  const w = norm({ imageURL: { list: U('a.jpg'), large: U('c.jpg') } });
  assert.deepEqual([w.imageList, w.imageSmall, w.imageLarge], [U('a.jpg'), null, U('c.jpg')]);
  assert.deepEqual([norm().imageList, norm().imageSmall, norm().imageLarge], [null, null, null]);
});

test('sampleImageURL は sample_l を優先し、無ければ sample_s、どちらも無ければ空配列', () => {
  const s = { image: [U('s1.jpg'), U('s2.jpg')] };
  const l = { image: [U('l1.jpg')] };
  assert.deepEqual(norm({ sampleImageURL: { sample_s: s, sample_l: l } }).sampleImages, l.image);
  assert.deepEqual(norm({ sampleImageURL: { sample_s: s } }).sampleImages, s.image);
  assert.deepEqual(norm({ sampleImageURL: {} }).sampleImages, []);
  assert.deepEqual(norm().sampleImages, []);
});

test('sampleMovieURL は size_* を sizes に、フラグを数値にする。欠落は null', () => {
  const movie = norm({ sampleMovieURL: { size_476_306: U('m1'), size_720_480: U('m2'), pc_flag: '1', sp_flag: 0 } }).sampleMovie;
  assert.deepEqual(movie, { sizes: { size_476_306: U('m1'), size_720_480: U('m2') }, pcFlag: 1, spFlag: 0 });
  assert.equal(norm().sampleMovie, null);
});

test('campaign は {title, begin, end} になり、欠落は空配列', () => {
  const w = norm({ campaign: [{ date_begin: '2025-01-01 10:00:00', date_end: '2025-01-15 23:59:59', title: 'キャンペーンA' }] });
  assert.deepEqual(w.campaigns, [{ title: 'キャンペーンA', begin: '2025-01-01T10:00:00', end: '2025-01-15T23:59:59' }]);
  assert.deepEqual(norm().campaigns, []);
});

test('iteminfo は NamedRef になる（id は文字列化、ruby は保持、画像などは捨てる）。キー欠落は空配列', () => {
  const w = norm({
    iteminfo: {
      genre: [{ id: 1, name: 'タグ01' }],
      actress: [{ id: 2001, name: '出演者A', ruby: 'しゅつえんしゃA', imageURL: { small: U('x.jpg') } }],
      maker: [{ id: 3001, name: 'メーカーA' }],
      label: [{ id: 4001, name: 'レーベルA' }],
      director: [{ id: 6001, name: '監督A', ruby: 'かんとくA' }],
    },
  });
  assert.deepEqual(w.genres, [{ id: '1', name: 'タグ01' }]);
  assert.deepEqual(w.actresses, [{ id: '2001', name: '出演者A', ruby: 'しゅつえんしゃA' }]);
  assert.deepEqual(w.makers, [{ id: '3001', name: 'メーカーA' }]);
  assert.deepEqual(w.labels, [{ id: '4001', name: 'レーベルA' }]);
  assert.deepEqual(w.directors, [{ id: '6001', name: '監督A', ruby: 'かんとくA' }]);
  assert.deepEqual(w.series, []); // series キーなし
  assert.deepEqual([norm().genres, norm().actresses], [[], []]);
});

test('comment・URLsp・affiliateURLsp など型に無い項目は結果に含まれない', () => {
  const w = norm({ comment: 'ダミーの紹介文', URLsp: U('sp'), affiliateURLsp: U('asp'), number: 'X', service_code: 'digital' });
  assert.ok(!JSON.stringify(w).includes('ダミーの紹介文'));
  assert.deepEqual(Object.keys(w).sort(), Object.keys(norm()).sort());
});

test('content_id が無い項目は例外。normalizeItems では何番目かが付く', () => {
  assert.throws(() => normalizeItem({ title: '作品 0001' }, OPTS), /content_id/);
  assert.throws(() => normalizeItem(null, OPTS));
  assert.throws(() => normalizeItems([{ content_id: 'a1', title: 'x' }, { title: 'y' }], OPTS), /items\[1\].*content_id/);
});

test('syntheticItemList は docs/03 の外枠を返す（request に api_id と affiliate_id が入る）', () => {
  const res = syntheticItemList({ count: 5, offset: 21, total: 23, seed: 7 });
  assert.deepEqual(res.request.parameters.api_id, 'dummy');
  assert.deepEqual(res.request.parameters.affiliate_id, 'dummy-990');
  assert.equal(res.result.status, 200);
  assert.deepEqual([res.result.result_count, res.result.total_count, res.result.first_position], [3, 23, 21]); // total を超える分は返さない
  assert.deepEqual(res.result.items.map((it: any) => it.content_id), ['syn00021', 'syn00022', 'syn00023']);
  assert.equal(syntheticItemList({ count: 4 }).result.total_count, 4);
});

test('synthetic は同じ引数なら同じ結果、シードが違えば別の結果になる', () => {
  assert.deepEqual(syntheticItem(5, 1), syntheticItem(5, 1));
  assert.notDeepEqual(syntheticItem(5, 1), syntheticItem(5, 2));
  assert.deepEqual(syntheticItemList({ count: 2, offset: 3 }).result.items[0], syntheticItem(3)); // 位置が作品番号
});

test('synthetic の500件が例外なく normalize でき、値が仕様の範囲に収まる', () => {
  const works = normalizeItems(syntheticItemList({ count: 500 }).result.items, OPTS);
  assert.equal(works.length, 500);
  assert.equal(new Set(works.map((w) => w.contentId)).size, 500);
  for (const w of works) {
    assert.ok(w.volumeMin === null || (w.volumeMin >= 30 && w.volumeMin <= 300), `volume ${w.volumeMin}`);
    assert.ok(w.priceMin !== null && w.priceMin >= 300 && w.priceMin <= 3000, `price ${w.priceMin}`);
    assert.ok(w.releasedAt === null || (w.releasedAt >= '2021-01-01' && w.releasedAt < '2027-01-01'), `date ${w.releasedAt}`);
    assert.ok(w.reviewCount >= 0 && w.reviewCount <= 500);
    assert.ok(w.reviewAvg === null || (w.reviewAvg >= 1 && w.reviewAvg <= 5), `avg ${w.reviewAvg}`);
    assert.ok(w.title.startsWith('作品 ') && w.contentId.startsWith('syn'));
  }
});

test('synthetic は欠損パターンを仕様どおりの割合（±4ポイント）で混ぜる', () => {
  const N = 2000;
  const items: any[] = syntheticItemList({ count: N }).result.items;
  const patterns: [string, number, (it: any) => boolean][] = [
    ['出演者なし', 0.08, (it) => !it.iteminfo.actress],
    ['review 欠落', 0.15, (it) => !it.review],
    ['sampleMovieURL なし', 0.30, (it) => !it.sampleMovieURL],
    ['campaign なし', 0.85, (it) => !it.campaign],
    ['volume が h:m:s 形式', 0.10, (it) => typeof it.volume === 'string' && it.volume.includes(':')],
    ['sample_l 欠落', 0.20, (it) => !it.sampleImageURL?.sample_l],
    ['series 欠落', 0.40, (it) => !it.iteminfo.series],
  ];
  for (const [label, target, match] of patterns) {
    const rate = items.filter(match).length / N;
    assert.ok(Math.abs(rate - target) <= 0.04, `${label}: ${rate} (目標 ${target})`);
  }
});
