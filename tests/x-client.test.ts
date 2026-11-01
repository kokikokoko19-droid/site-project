import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCatalog } from '../src/lib/catalog.ts';
import type { CatalogWork } from '../src/lib/catalog.ts';
import { main } from '../src/x/cli.ts';
import { XApiError, createXClient, redactSecrets } from '../src/x/client.ts';
import type { XClientOptions } from '../src/x/client.ts';
import { buildAuthorizationHeader } from '../src/x/oauth.ts';
import { openPostStore } from '../src/x/store.ts';

const CREDS = { consumerKey: 'ck-AAAA1111', consumerSecret: 'cs-BBBB2222', accessToken: 'at-CCCC3333', accessTokenSecret: 'ats-DDDD4444' };
const OK = { status: 201, text: JSON.stringify({ data: { id: '1234567890123456789', text: 'x' } }) };
type Reply = { status: number; text?: string };

/** 応答を順に返す偽の fetch（最後の応答は使い回す）。呼び出しを calls に記録する */
function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(r.text ?? '{}', { status: r.status });
  }) as typeof fetch;
  return { impl, calls };
}
/** 偽の fetch と、待ち時間を記録する sleep を付けたクライアント */
function setup(replies: Reply[], over: Partial<XClientOptions> = {}) {
  const f = fakeFetch(replies), sleeps: number[] = [];
  const client = createXClient({ ...CREDS, fetchImpl: f.impl, sleep: async (ms) => { sleeps.push(ms); }, ...over });
  return { client, calls: f.calls, sleeps };
}
const headerOf = (init: RequestInit): string => (init.headers as Record<string, string>).Authorization;
const field = (header: string, name: string): string => new RegExp(`${name}="([^"]*)"`).exec(header)![1];
/** ヘッダーと同じ nonce・時刻で署名し直す。URL・メソッド・鍵の取り違えがなければ元のヘッダーと一致する */
const resign = (url: string, header: string): string => buildAuthorizationHeader({
  method: 'POST', url, consumerKey: CREDS.consumerKey, consumerSecret: CREDS.consumerSecret, token: CREDS.accessToken,
  tokenSecret: CREDS.accessTokenSecret, nonce: field(header, 'oauth_nonce'), timestamp: field(header, 'oauth_timestamp'),
});

describe('postTweet（成功）', () => {
  it('POST /2/tweets に JSON { text } を OAuth 1.0a の署名つきで送り、data.id を返す', async () => {
    const { client, calls, sleeps } = setup([OK]);
    assert.deepEqual(await client.postTweet('こんにちは #PR'), { id: '1234567890123456789' });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0], header = headerOf(init);
    assert.equal(url, 'https://api.x.com/2/tweets');
    assert.equal(init.method, 'POST');
    assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/json');
    assert.equal(init.body, JSON.stringify({ text: 'こんにちは #PR' }));
    assert.match(header, /^OAuth oauth_consumer_key="ck-AAAA1111", oauth_nonce="[0-9a-f]{32}", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d{10}", oauth_token="at-CCCC3333", oauth_version="1\.0"$/);
    assert.equal(header, resign(url, header));
    assert.deepEqual(sleeps, []);
  });
  it('baseUrl を変えると、その URL に送り、署名もその URL で行う（末尾のスラッシュは除く）', async () => {
    const { client, calls } = setup([OK], { baseUrl: 'http://127.0.0.1:9999/' });
    await client.postTweet('本文');
    assert.equal(calls[0].url, 'http://127.0.0.1:9999/2/tweets');
    assert.equal(headerOf(calls[0].init), resign(calls[0].url, headerOf(calls[0].init)));
  });
});

describe('postTweet（再試行）', () => {
  it('429 のあとに 200 なら、1秒待って再試行し、nonce は作り直す', async () => {
    const { client, calls, sleeps } = setup([{ status: 429, text: '{"title":"Too Many Requests"}' }, OK]);
    assert.deepEqual(await client.postTweet('本文'), { id: '1234567890123456789' });
    assert.deepEqual([calls.length, sleeps], [2, [1000]]);
    assert.notEqual(field(headerOf(calls[0].init), 'oauth_nonce'), field(headerOf(calls[1].init), 'oauth_nonce'));
  });
  it('5xx が続いても、1秒・2秒・4秒の指数バックオフで3回まで再試行して成功できる', async () => {
    const { client, calls, sleeps } = setup([{ status: 500 }, { status: 502 }, { status: 503 }, OK]);
    assert.deepEqual(await client.postTweet('本文'), { id: '1234567890123456789' });
    assert.deepEqual([calls.length, sleeps], [4, [1000, 2000, 4000]]);
  });
  for (const status of [429, 500, 503]) {
    it(`${status} が続くと、再試行は3回まで（計4回）で、XApiError を投げる`, async () => {
      const { client, calls, sleeps } = setup([{ status, text: '{"detail":"busy"}' }]);
      await assert.rejects(client.postTweet('本文'), (e: unknown) => {
        assert.ok(e instanceof XApiError && e.status === status);
        assert.match(e.message, new RegExp(`${status}.*3 回再試行.*busy`));
        return true;
      });
      assert.deepEqual([calls.length, sleeps], [4, [1000, 2000, 4000]]);
    });
  }
});

describe('postTweet（再試行しない・エラー）', () => {
  it('403 は再試行せず、本文の要点を含む Error を投げる。キー類は応答に混ざっていても伏せる', async () => {
    const body = JSON.stringify({ title: 'Forbidden', detail: `token ${CREDS.accessToken} / ${CREDS.consumerSecret} is not permitted`, status: 403 });
    const { client, calls, sleeps } = setup([{ status: 403, text: body }]);
    await assert.rejects(client.postTweet('本文'), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /403.*Forbidden.*\*\*\*.*is not permitted/);
      for (const secret of Object.values(CREDS)) assert.ok(!e.message.includes(secret), `${secret} がメッセージに含まれている`);
      return true;
    });
    assert.deepEqual([calls.length, sleeps], [1, []]);
  });
  for (const status of [400, 401, 404]) {
    it(`${status} も再試行しない`, async () => {
      const { client, calls } = setup([{ status, text: '{"errors":[{"message":"bad request"}]}' }]);
      await assert.rejects(client.postTweet('本文'), new RegExp(`${status}.*bad request`));
      assert.equal(calls.length, 1);
    });
  }
  it('JSON でない長い応答本文は、1行に畳んで200字までにする', async () => {
    const { client } = setup([{ status: 403, text: `<html>\n${'あ'.repeat(500)}\n</html>` }]);
    await assert.rejects(client.postTweet('本文'), (e: unknown) => e instanceof Error && !e.message.includes('\n') && e.message.length < 400);
  });
  it('成功の応答に data.id が無ければエラー。本文が空なら通信しない', async () => {
    const { client, calls } = setup([{ status: 201, text: '{"data":{}}' }]);
    await assert.rejects(client.postTweet('本文'), /data\.id/);
    await assert.rejects(client.postTweet('  '), /空/);
    assert.equal(calls.length, 1);
  });
  it('通信の失敗は再試行せず、メッセージから認証情報を伏せて Error にする', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; throw new TypeError(`fetch failed (${CREDS.accessToken})`); }) as typeof fetch;
    const client = createXClient({ ...CREDS, fetchImpl, sleep: async () => { throw new Error('待たないはず'); } });
    await assert.rejects(client.postTweet('本文'), (e: unknown) => e instanceof Error && e.message.includes('接続できませんでした') && !e.message.includes(CREDS.accessToken));
    assert.equal(calls, 1);
  });
});

describe('dryRun と認証情報の検査', () => {
  it('dryRun は通信せず { id: "dry-run" } を返す。認証情報が空でもよい', async () => {
    const { client, calls, sleeps } = setup([OK], { dryRun: true, consumerKey: '', consumerSecret: '', accessToken: '', accessTokenSecret: '' });
    assert.deepEqual(await client.postTweet('本文 #PR'), { id: 'dry-run' });
    assert.equal(calls.length + sleeps.length, 0);
  });
  it('dryRun でないのに認証情報が足りなければ、作る時点でエラー（足りない項目名だけを示す）', () => {
    assert.throws(() => createXClient({ ...CREDS, accessToken: '', consumerSecret: '' }),
      (e: unknown) => e instanceof Error && /consumerSecret、accessToken/.test(e.message) && !e.message.includes(CREDS.consumerKey));
    assert.equal(redactSecrets('a SECRET b oauth_token="xyz"', ['SECRET', undefined, '']), 'a *** b oauth_token="***"');
  });
});

describe('CLI（post）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-cli-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const NOW = new Date('2026-11-01T03:00:00Z'), DAY = '2026-11-01'; // 日本時間 12:00
  const KEYS = { X_API_KEY: CREDS.consumerKey, X_API_SECRET: CREDS.consumerSecret, X_ACCESS_TOKEN: CREDS.accessToken, X_ACCESS_TOKEN_SECRET: CREDS.accessTokenSecret };
  const work = (id: string, label: string): CatalogWork => ({
    contentId: id, title: `作品 ${id}`, volumeMin: 100, reviewCount: 5, reviewAvg: 4, releasedAt: '2026-10-01', priceMin: 1, listPrice: 1, status: 'active',
    derivedLabels: [label], genres: [], actresses: [], series: [], makers: [], deliveries: [], campaigns: [], labels: [], directors: [], sampleImages: [], similarIds: [],
  }) as unknown as CatalogWork;
  const catalog = buildCatalog(['新作', 'セール中', '高評価', '初見向け'].map((l, i) => work(`W${i}`, l)));
  let n = 0;
  /** 偽の fetch・sleep・時計で main を動かす。db を渡すと同じ履歴を引き継ぐ */
  async function cli(args: string[], env: Record<string, string> = KEYS, replies: Reply[] = [OK], db = join(dir, `h${n++}.sqlite`)) {
    const f = fakeFetch(replies), out: string[] = [], err: string[] = [], sleeps: number[] = [];
    const code = await main(args, { DB_PATH: db, ...env }, { catalog, fetchImpl: f.impl, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); }, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n'), calls: f.calls, sleeps, db };
  }
  const recorded = (db: string, dryRun: boolean): number => { const s = openPostStore(db); try { return s.countPostsOn(DAY, dryRun); } finally { s.close(); } };
  const textOf = (c: { init: RequestInit }): string => JSON.parse(String(c.init.body)).text;

  it('認証情報が足りなければ --dry-run 以外は終了コード 2（通信も記録もしない。値は出力しない）', async () => {
    const r = await cli(['post', '--count', '1'], { X_API_KEY: CREDS.consumerKey });
    assert.equal(r.code, 2);
    assert.match(r.err, /X_API_SECRET.*X_ACCESS_TOKEN.*X_ACCESS_TOKEN_SECRET/);
    assert.ok(!r.err.includes(CREDS.consumerKey) && r.calls.length === 0 && recorded(r.db, false) === 0);
  });
  it('--dry-run は認証情報なしで動き、通信せず、本文を出力して dry_run=1 で記録する', async () => {
    const r = await cli(['post', '--count', '2', '--dry-run'], {});
    assert.equal(r.code, 0);
    assert.equal(r.calls.length + r.sleeps.length, 0);
    assert.equal((r.out.match(/ #PR/g) ?? []).length, 2);
    assert.deepEqual([recorded(r.db, true), recorded(r.db, false)], [2, 0]);
  });
  it('本投稿: 件数分を投稿し、2件目以降は 60 秒あけ、実投稿として記録する', async () => {
    const r = await cli(['post', '--count', '3']);
    assert.equal(r.code, 0);
    assert.deepEqual([r.calls.length, r.sleeps, recorded(r.db, false)], [3, [60000, 60000], 3]);
    assert.ok(r.calls.every((c) => textOf(c).endsWith(' #PR')));
  });
  it('1日の上限（X_DAILY_MAX）を超えて投稿しない。上限に達していれば何もせず終了コード 0。不正な値は 2', async () => {
    const env = { ...KEYS, X_DAILY_MAX: '2' };
    const first = await cli(['post', '--count', '3'], env);
    assert.equal(first.calls.length, 2);
    const second = await cli(['post'], env, [OK], first.db);
    assert.deepEqual([second.code, second.calls.length, recorded(first.db, false)], [0, 0, 2]);
    assert.match(second.out, /上限/);
    assert.equal((await cli(['post'], { ...KEYS, X_DAILY_MAX: '0' })).calls.length, 0);
    assert.equal((await cli(['post'], { ...KEYS, X_DAILY_MAX: 'abc' })).code, 2);
  });
  it('API が 403 なら終了コード 1。表示にキーを含めず、失敗した投稿は記録しない', async () => {
    const r = await cli(['post', '--count', '2'], KEYS, [{ status: 403, text: `{"detail":"${CREDS.accessToken} denied"}` }]);
    assert.equal(r.code, 1);
    assert.ok(r.err.includes('403') && !Object.values(CREDS).some((s) => r.err.includes(s)));
    assert.deepEqual([r.calls.length, recorded(r.db, false)], [1, 0]);
  });
  it('--with-url は SITE_URL が無ければ 2。あれば本文の末尾に作品ページの URL を付け、--kind は区分として記録する', async () => {
    assert.equal((await cli(['post', '--with-url'])).code, 2);
    assert.equal((await cli(['post', '--kind', 'weekly', '--dry-run'], {})).code, 2);
    const r = await cli(['post', '--count', '1', '--with-url', '--kind', 'feature'], { ...KEYS, SITE_URL: 'https://example.com/' });
    assert.match(textOf(r.calls[0]), / #PR\nhttps:\/\/example\.com\/v\/W\d\/$/);
    assert.equal(recorded(r.db, false), 1);
  });
});
