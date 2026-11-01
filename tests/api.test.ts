// FANZA API クライアントのテスト。fetch / sleep / 時計を差し替えるので、実際の通信は一切しない。
// テストデータはすべて合成（実在の作品名や実際の API 応答は使わない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUrl, createClient } from '../src/data/api.ts';

const API_ID = 'TEST_API_ID_DUMMY';
const AFF_ID = 'testaff-990';
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
// 実応答と同じく request.parameters に API ID が平文で入る、合成レスポンス。
const wrap = (result: object) => ({ request: { parameters: { api_id: API_ID, affiliate_id: AFF_ID } }, result });
const itemsBody = () =>
  wrap({
    status: 200, result_count: 2, total_count: 120, first_position: 1,
    items: [{ content_id: 'test001', title: 'テスト作品A' }, { content_id: 'test002', title: 'テスト作品B' }],
  });
const searchBody = (key: string) =>
  wrap({ status: '200', result_count: 1, total_count: 1, first_position: 1, [key]: [{ id: '1', name: 'テスト' }] });

// 呼ばれた URL を記録する fetch。responders を順に返し、尽きたら最後のものを繰り返す。
function stub(...responders: Array<() => Response>) {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(new URL(String(input)));
    return responders[Math.min(urls.length, responders.length) - 1]!();
  }) as typeof fetch;
  return { fetchImpl, urls };
}
// 待ち時間を記録するだけの sleep を注入したクライアント（既定は間隔 0 で、待たない）。
function make(fetchImpl: typeof fetch, extra: { minIntervalMs?: number; maxRetries?: number } = {}) {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  const client = createClient({ apiId: API_ID, affiliateId: AFF_ID, fetchImpl, sleep, minIntervalMs: 0, ...extra });
  return { client, sleeps };
}
const failure = (p: Promise<unknown>) => p.then(() => assert.fail('reject されるはず'), (e: unknown) => e as Error);

test('itemList: 既定値と指定パラメータが URL のクエリに入る', async () => {
  const { fetchImpl, urls } = stub(() => json(itemsBody()));
  await make(fetchImpl).client.itemList({
    hits: 50, offset: 101, sort: 'date', article: ['genre', 'actress'], article_id: [1, 2],
    cid: 'test001', keyword: 'テスト 検索', gte_date: '2016-04-01T00:00:00', lte_date: '2016-04-30T23:59:59',
  });
  const u = urls[0]!;
  assert.equal(u.origin + u.pathname, 'https://api.dmm.com/affiliate/v3/ItemList');
  const expected = {
    api_id: API_ID, affiliate_id: AFF_ID, output: 'json', site: 'FANZA', service: 'digital', floor: 'videoa',
    hits: '50', offset: '101', sort: 'date', 'article[0]': 'genre', 'article[1]': 'actress',
    'article_id[0]': '1', 'article_id[1]': '2', cid: 'test001', keyword: 'テスト 検索',
    gte_date: '2016-04-01T00:00:00', lte_date: '2016-04-30T23:59:59',
  };
  for (const [k, v] of Object.entries(expected)) assert.equal(u.searchParams.get(k), v, k);
  assert.ok(u.search.includes('article[0]=genre&article[1]=actress'));
});

test('itemList: 指定なしなら既定の site/service/floor だけを付け、単一の article はそのまま', async () => {
  const { fetchImpl, urls } = stub(() => json(itemsBody()));
  const { client } = make(fetchImpl);
  await client.itemList();
  assert.deepEqual([...urls[0]!.searchParams.keys()].sort(), ['affiliate_id', 'api_id', 'floor', 'output', 'service', 'site']);
  await client.itemList({ article: 'genre', article_id: 5 });
  assert.equal(urls[1]!.searchParams.get('article'), 'genre');
  assert.equal(urls[1]!.searchParams.get('article_id'), '5');
});

test('不正な値（hits/offset/sort/日付）は RangeError になり、通信しない', async () => {
  const { fetchImpl, urls } = stub(() => json(itemsBody()));
  const { client } = make(fetchImpl);
  const bad = [
    { hits: 0 }, { hits: 101 }, { hits: 1.5 }, { offset: 0 }, { offset: 50001 }, { sort: 'bogus' },
    { gte_date: '2016-04-01' }, { lte_date: '2016-04-01 00:00:00' }, { gte_date: '2016-13-01T00:00:00' },
  ];
  for (const p of bad) await assert.rejects(() => client.itemList(p as never), RangeError, JSON.stringify(p));
  assert.equal(urls.length, 0);
  await client.itemList({ hits: 100, offset: 50000, sort: '-price' }); // 境界値は通る
  assert.equal(urls.length, 1);
});

test('genre/maker/series の Search: floor_id 必須、hits は 1〜500', async () => {
  const cases = [['genreSearch', 'GenreSearch', 'genre'], ['makerSearch', 'MakerSearch', 'maker'], ['seriesSearch', 'SeriesSearch', 'series']] as const;
  for (const [method, path, key] of cases) {
    const { fetchImpl, urls } = stub(() => json(searchBody(key)));
    const { client } = make(fetchImpl);
    await assert.rejects(() => client[method]({} as never), RangeError);
    await assert.rejects(() => client[method]({ floor_id: 'videoa' }), RangeError); // code ではなく数字の id が必要
    await assert.rejects(() => client[method]({ floor_id: 43, hits: 0 }), RangeError);
    await assert.rejects(() => client[method]({ floor_id: 43, hits: 501 }), RangeError);
    assert.equal(urls.length, 0);
    const r = await client[method]({ floor_id: 43, hits: 500, offset: 1, initial: 'あ' });
    assert.equal(urls[0]!.pathname, `/affiliate/v3/${path}`);
    for (const [k, v] of Object.entries({ floor_id: '43', hits: '500', offset: '1', initial: 'あ', output: 'json', api_id: API_ID })) {
      assert.equal(urls[0]!.searchParams.get(k), v, `${method}:${k}`);
    }
    assert.deepEqual(r, { status: 200, resultCount: 1, totalCount: 1, firstPosition: 1, list: [{ id: '1', name: 'テスト' }] });
  }
});

test('actressSearch は hits が 1〜100、floorList は site 一覧を返す', async () => {
  const a = stub(() => json(searchBody('actress')));
  await assert.rejects(() => make(a.fetchImpl).client.actressSearch({ hits: 101 }), RangeError);
  await assert.rejects(() => make(a.fetchImpl).client.actressSearch({ hits: 0 }), RangeError);
  assert.equal(a.urls.length, 0);
  const r = await make(a.fetchImpl).client.actressSearch({ hits: 100, keyword: 'テスト' });
  assert.equal(a.urls[0]!.searchParams.get('hits'), '100');
  assert.equal(r.list.length, 1);
  const f = stub(() => json(wrap({ site: [{ name: 'テスト', code: 'FANZA', service: [] }] })));
  const fl = await make(f.fetchImpl).client.floorList();
  assert.equal(f.urls[0]!.pathname, '/affiliate/v3/FloorList');
  assert.deepEqual(fl, { status: 200, sites: [{ name: 'テスト', code: 'FANZA', service: [] }] });
});

test('レスポンスの request（API ID 入り）は、どの API の結果にも含まれない', async () => {
  const { fetchImpl } = stub(() => json(itemsBody()));
  const r = await make(fetchImpl).client.itemList();
  assert.deepEqual(Object.keys(r).sort(), ['firstPosition', 'items', 'resultCount', 'status', 'totalCount']);
  assert.equal(r.totalCount, 120);
  assert.ok(!JSON.stringify(r).includes(API_ID) && !JSON.stringify(r).includes('request'));
  const s = await make(stub(() => json(searchBody('genre'))).fetchImpl).client.genreSearch({ floor_id: 43 });
  assert.ok(!JSON.stringify(s).includes(API_ID) && !('request' in s));
});

test('0件で items キーが欠落しても空配列で返し、文字列の status は数値にする', async () => {
  const { fetchImpl } = stub(() => json(wrap({ status: '200', result_count: 0, total_count: 0 })));
  const r = await make(fetchImpl).client.itemList({ offset: 50000 });
  assert.deepEqual(r, { status: 200, resultCount: 0, totalCount: 0, firstPosition: 0, items: [] });
});

test('429 のあと 200 なら再試行して成功し、sleep が呼ばれる', async () => {
  const { fetchImpl, urls } = stub(() => json({}, 429), () => json(itemsBody()));
  const { client, sleeps } = make(fetchImpl);
  const r = await client.itemList();
  assert.equal(urls.length, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(r.items.length, 2);
});

test('5xx が続くと maxRetries 回まで指数バックオフし、最後は Error（URL・ID を含まない）', async () => {
  const { fetchImpl, urls } = stub(() => json(wrap({}), 503));
  const { client, sleeps } = make(fetchImpl, { maxRetries: 3 });
  const e = await failure(client.itemList());
  assert.match(e.message, /HTTP 503/);
  assert.equal(urls.length, 4);
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  assert.ok(!e.message.includes(API_ID) && !e.message.includes('api_id') && e.cause === undefined);
});

test('400 は再試行せず Error（メッセージに URL のクエリ・ID を含まない）', async () => {
  const { fetchImpl, urls } = stub(() => json(wrap({}), 400));
  const { client, sleeps } = make(fetchImpl);
  const e = await failure(client.itemList());
  assert.match(e.message, /HTTP 400/);
  assert.equal(urls.length, 1);
  assert.deepEqual(sleeps, []);
  assert.ok(!e.message.includes(API_ID) && !e.message.includes('api_id') && !e.message.includes('?'));
});

test('通信例外は再試行し、尽きたら固定文言の Error（元の例外が持つ URL は漏らさない）', async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    throw new TypeError(`fetch failed: ${String(input)}`);
  }) as typeof fetch;
  const { client, sleeps } = make(fetchImpl, { maxRetries: 2 });
  const e = await failure(client.itemList());
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.ok(!e.message.includes(API_ID) && !e.message.includes('api_id') && e.cause === undefined);
});

test('連続呼び出しは minIntervalMs の間隔を空ける（前回の開始時刻からの差で待つ）', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { fetchImpl } = stub(() => json(itemsBody()));
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); t.mock.timers.tick(ms); }; // 待った分だけ時計を進める
  const client = createClient({ apiId: API_ID, affiliateId: AFF_ID, fetchImpl, sleep, minIntervalMs: 500 });
  await client.itemList();
  assert.deepEqual(sleeps, []); // 1回目は待たない
  await client.itemList();
  assert.deepEqual(sleeps, [500]); // 2回目は 500ms 待つ
  t.mock.timers.tick(200); // 200ms 経ってから3回目
  await client.itemList();
  assert.deepEqual(sleeps, [500, 300]); // 残りの 300ms だけ待つ
});

test('同時に呼んでも、最小間隔を空けて直列に通信する', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { fetchImpl, urls } = stub(() => json(itemsBody()));
  const { client, sleeps } = make(fetchImpl, { minIntervalMs: 500 });
  await Promise.all([client.itemList(), client.itemList(), client.itemList()]);
  assert.equal(urls.length, 3);
  assert.deepEqual(sleeps, [500, 500]);
});

test('buildUrl: 配列は key[i] に展開し undefined は除く。api_id はマスクしない（内部用）', () => {
  assert.equal(
    buildUrl('ItemList', { api_id: API_ID, article: ['genre', 'actress'], hits: 10, skip: undefined, keyword: 'a b' }),
    `https://api.dmm.com/affiliate/v3/ItemList?api_id=${API_ID}&article[0]=genre&article[1]=actress&hits=10&keyword=a%20b`,
  );
  assert.equal(buildUrl('FloorList', {}, 'https://example.test/v3'), 'https://example.test/v3/FloorList');
});

test('createClient: 必須項目と数値オプション・baseUrl を検証する', () => {
  const base = { apiId: API_ID, affiliateId: AFF_ID };
  assert.throws(() => createClient({ ...base, apiId: '' }), RangeError);
  assert.throws(() => createClient({ ...base, affiliateId: '' }), RangeError);
  assert.throws(() => createClient({ ...base, minIntervalMs: -1 }), RangeError);
  assert.throws(() => createClient({ ...base, maxRetries: 1.5 }), RangeError);
  assert.throws(() => createClient({ ...base, baseUrl: 'not a url' }), RangeError);
});
