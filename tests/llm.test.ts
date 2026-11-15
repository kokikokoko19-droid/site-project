import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_MODEL, askClaude } from '../src/lib/llm.ts';

const ok = (text: string, stop = 'end_turn') => new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: stop }), { status: 200 });
const fail = (status: number) => new Response(JSON.stringify({ error: { type: 'overloaded_error', message: 'x' } }), { status });
const base = { system: 'S', user: 'U', apiKey: 'test-key', retryDelayMs: 0 };

describe('askClaude', () => {
  it('キーが無ければ通信せず null', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      let called = 0;
      const r = await askClaude({ system: 'S', user: 'U', fetchImpl: (async () => { called++; return ok('x'); }) as typeof fetch });
      assert.equal(r, null);
      assert.equal(called, 0);
    } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
  });

  it('モデル・system・上限・キーをヘッダと本文に載せ、本文を返す', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const r = await askClaude({ ...base, fetchImpl: (async (url: string, init: RequestInit) => { seen = { url, init }; return ok(' こんにちは。 '); }) as unknown as typeof fetch });
    assert.equal(r, 'こんにちは。');
    const { url, init } = seen as unknown as { url: string; init: RequestInit };
    const body = JSON.parse(init.body as string);
    assert.match(url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
    assert.equal(body.model, CLAUDE_MODEL);
    assert.equal(body.system, 'S');
    assert.ok(body.max_tokens > 0);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'U' }]);
    assert.ok(!('temperature' in body));
    assert.equal((init.headers as Record<string, string>)['x-api-key'], 'test-key');
  });

  it('5xx は 1 回だけ再試行して成功すれば本文を返す', async () => {
    let n = 0;
    const warns: string[] = [];
    const r = await askClaude({ ...base, warn: (m) => warns.push(m), fetchImpl: (async () => (++n === 1 ? fail(529) : ok('再試行後。'))) as typeof fetch });
    assert.equal(r, '再試行後。');
    assert.equal(n, 2);
    assert.equal(warns.length, 1);
  });

  it('再試行しても失敗なら null（回数は 2 回まで）。警告にキーを含めない', async () => {
    let n = 0;
    const warns: string[] = [];
    const r = await askClaude({ ...base, warn: (m) => warns.push(m), fetchImpl: (async () => { n++; return fail(500); }) as typeof fetch });
    assert.equal(r, null);
    assert.equal(n, 2);
    assert.ok(warns.every((m) => !m.includes('test-key')));
  });

  it('400 などは再試行しない', async () => {
    let n = 0;
    assert.equal(await askClaude({ ...base, fetchImpl: (async () => { n++; return fail(400); }) as typeof fetch }), null);
    assert.equal(n, 1);
  });

  it('通信失敗・タイムアウトは再試行のうえ null', async () => {
    let n = 0;
    assert.equal(await askClaude({ ...base, fetchImpl: (async () => { n++; throw new TypeError('network'); }) as typeof fetch }), null);
    assert.equal(n, 2);
    const slow = (async (_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      (init.signal as AbortSignal).addEventListener('abort', () => rej(new Error('aborted')));
    })) as unknown as typeof fetch;
    assert.equal(await askClaude({ ...base, timeoutMs: 20, fetchImpl: slow }), null);
  });

  it('途切れ（max_tokens）・拒否（refusal）・空は null', async () => {
    assert.equal(await askClaude({ ...base, fetchImpl: (async () => ok('途中', 'max_tokens')) as typeof fetch }), null);
    assert.equal(await askClaude({ ...base, fetchImpl: (async () => ok('x', 'refusal')) as typeof fetch }), null);
    assert.equal(await askClaude({ ...base, fetchImpl: (async () => ok('  ')) as typeof fetch }), null);
  });
});
