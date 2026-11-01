// FANZA API クライアントのテスト。fetch / sleep / 時計を差し替えるので、実際の通信は一切しない。
// テストデータはすべて合成（実在の作品名や実際の API 応答は使わない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUrl, createClient } from '../src/data/api.ts';

const API_ID = 'TEST_API_ID_DUMMY';
const AFF_ID = 'testaff-990';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
// 実応答と同じく request.parameters に API ID が平文で入る、合成レスポンス。
const wrap = (result: object) => ({ request: { parameters: { api_id: API_ID, affiliate_id: AFF_ID } }, result });
const itemsBody = () => wrap({
  status: 200, result_count: 2, total_count: 120, first_position: 1,
  items: [{ content_id: 'test001', title: 'テスト作品A' }, { content_id: 'test002', title: 'テスト作品B' }],
});
const searchBody = (key: string) =>
  wrap({ status: '200', result_count: 1, total_count: 1, first_position: 1, [key]: [{ id: '1', name: 'テスト' }] });
const failure = (p: Promise<unknown>) => p.then(() => assert.fail('reject されるはず'), (e: unknown) => e as Error);

// fetch / sleep を差し替えたクライアント。responders を順に返し（尽きたら最後を繰り返す）、
// 呼ばれた URL と sleep の待ち時間を記録する。minIntervalMs の既定は 0（待たない）。
function make(
  responders: Array<(url: URL) => Response>,
  { tick, ...extra }: { minIntervalMs?: number; maxRetries?: number; tick?: (ms: number) => void } = {},
) {
  const urls: URL[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    return responders[Math.min(urls.length, responders.length) - 1]!(url);
  }) as typeof fetch;
  const sleep = async (ms: number) => { sleeps.push(ms); tick?.(ms); };
  const client = createClient({ apiId: API_ID, affiliateId: AFF_ID, fetchImpl, sleep, minIntervalMs: 0, ...extra });
  return { client, urls, sleeps };
}

test('itemList: 既定値と指定パラメータが URL のクエリに入る', async () => {
  const { client, urls } = make([() => json(itemsBody())]);
  await client.itemList({
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
  const { client, urls } = make([() => json(itemsBody())]);
  await client.itemList();
  assert.deepEqual([...urls[0]!.searchParams.keys()].sort(), ['affiliate_id', 'api_id', 'floor', 'output', 'service', 'site']);
  await client.itemList({ article: 'genre', article_id: 5 });
  const q = urls[1]!.searchParams;
  assert.deepEqual([q.get('article'), q.get('article_id')], ['genre', '5']);
});

test('不正な値（hits/offset/sort/日付）は RangeError になり、通信しない', async () => {
  const { client, urls } = make([() => json(itemsBody())]);
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
    const { client, urls } = make([() => json(searchBody(key))]);
    // 'videoa' は code であって id ではないので不可
    for (const bad of [{}, { floor_id: 'videoa' }, { floor_id: 43, hits: 0 }, { floor_id: 43, hits: 501 }]) {
      await assert.rejects(() => client[method](bad as never), RangeError, `${method}:${JSON.stringify(bad)}`);
    }
    assert.equal(urls.length, 0);
    const r = await client[method]({ floor_id: 43, hits: 500, offset: 1, initial: 'あ' });
    assert.equal(urls[0]!.pathname, `/affiliate/v3/${path}`);
    const q = urls[0]!.searchParams;
    for (const [k, v] of Object.entries({ floor_id: '43', hits: '500', offset: '1', initial: 'あ', output: 'json' })) assert.equal(q.get(k), v, `${method}:${k}`);
    assert.deepEqual(r, { status: 200, resultCount: 1, totalCount: 1, firstPosition: 1, list: [{ id: '1', name: 'テスト' }] });
  }
});

test('actressSearch は hits が 1〜100、floorList は site 一覧を返す', async () => {
  const a = make([() => json(searchBody('actress'))]);
  for (const hits of [0, 101]) await assert.rejects(() => a.client.actressSearch({ hits }), RangeError);
  assert.equal(a.urls.length, 0);
  const r = await a.client.actressSearch({ hits: 100, keyword: 'テスト' });
  assert.equal(a.urls[0]!.searchParams.get('hits'), '100');
  assert.equal(r.list.length, 1);
  const sites = [{ name: 'テスト', code: 'FANZA', service: [] }];
  const f = make([() => json(wrap({ site: sites }))]);
  assert.deepEqual(await f.client.floorList(), { status: 200, sites });
  assert.equal(f.urls[0]!.pathname, '/affiliate/v3/FloorList');
});

test('レスポンスの request（API ID 入り）は、どの API の結果にも含まれない', async () => {
  const r = await make([() => json(itemsBody())]).client.itemList();
  assert.deepEqual(Object.keys(r).sort(), ['firstPosition', 'items', 'resultCount', 'status', 'totalCount']);
  assert.equal(r.totalCount, 120);
  assert.ok(!JSON.stringify(r).includes(API_ID) && !JSON.stringify(r).includes('request'));
  const s = await make([() => json(searchBody('genre'))]).client.genreSearch({ floor_id: 43 });
  assert.ok(!JSON.stringify(s).includes(API_ID) && !('request' in s));
});

test('0件で items キーが欠落しても空配列で返し、文字列の status は数値にする', async () => {
  const { client } = make([() => json(wrap({ status: '200', result_count: 0, total_count: 0 }))]);
  assert.deepEqual(await client.itemList({ offset: 50000 }), { status: 200, resultCount: 0, totalCount: 0, firstPosition: 0, items: [] });
});

test('429 のあと 200 なら再試行して成功し、sleep が呼ばれる', async () => {
  const { client, urls, sleeps } = make([() => json({}, 429), () => json(itemsBody())]);
  const r = await client.itemList();
  assert.equal(urls.length, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(r.items.length, 2);
});

test('5xx が続くと maxRetries 回まで指数バックオフし、最後は Error（URL・ID を含まない）', async () => {
  const { client, urls, sleeps } = make([() => json(wrap({}), 503)], { maxRetries: 3 });
  const e = await failure(client.itemList());
  assert.match(e.message, /HTTP 503/);
  assert.equal(urls.length, 4);
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  assert.ok(!e.message.includes(API_ID) && !e.message.includes('api_id') && e.cause === undefined);
});

test('400 は再試行せず Error（メッセージに URL のクエリ・ID を含まない）', async () => {
  const { client, urls, sleeps } = make([() => json(wrap({}), 400)]);
  const e = await failure(client.itemList());
  assert.match(e.message, /HTTP 400/);
  assert.equal(urls.length, 1);
  assert.deepEqual(sleeps, []);
  assert.ok(!e.message.includes(API_ID) && !e.message.includes('api_id') && !e.message.includes('?'));
});

test('通信例外は再試行し、尽きたら固定文言の Error（元の例外が持つ URL は漏らさない）', async () => {
  const { client, sleeps } = make([(url) => { throw new TypeError(`fetch failed: ${url}`); }], { maxRetries: 2 });
  const e = await failure(client.itemList());
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.ok(!e.message.includes(API_ID) && !e.message.includes('api_id') && e.cause === undefined);
});

test('連続呼び出しは minIntervalMs の間隔を空ける（前回の開始時刻からの差で待つ）', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const tick = (ms: number) => t.mock.timers.tick(ms); // 待った分だけ時計を進める
  const { client, sleeps } = make([() => json(itemsBody())], { minIntervalMs: 500, tick });
  await client.itemList();
  assert.deepEqual(sleeps, []); // 1回目は待たない
  await client.itemList();
  assert.deepEqual(sleeps, [500]); // 2回目は 500ms 待つ
  tick(200); // 200ms 経ってから3回目
  await client.itemList();
  assert.deepEqual(sleeps, [500, 300]); // 残りの 300ms だけ待つ
});

test('同時に呼んでも、直前の通信の開始から minIntervalMs を空けて直列に通信する', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 }); // sleep は既定（モックした setTimeout）
  const starts: number[] = [];
  const fetchImpl = (async () => { starts.push(Date.now()); return json(itemsBody()); }) as typeof fetch;
  const client = createClient({ apiId: API_ID, affiliateId: AFF_ID, fetchImpl, minIntervalMs: 500 });
  let done = false;
  const all = Promise.all([client.itemList(), client.itemList(), client.itemList()]).finally(() => { done = true; });
  for (let i = 0; i < 20 && !done; i++) {
    await new Promise((resolve) => setImmediate(resolve)); // 待ち行列を進めてから
    t.mock.timers.tick(500); // 時計を進める
  }
  await all;
  assert.deepEqual(starts, [0, 500, 1000]); // 3本が同時に動かず、500ms ずつずれる
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
  for (const bad of [{ apiId: '' }, { affiliateId: '' }, { minIntervalMs: -1 }, { maxRetries: 1.5 }, { baseUrl: 'not a url' }]) {
    assert.throws(() => createClient({ ...base, ...bad }), RangeError, JSON.stringify(bad));
  }
});
