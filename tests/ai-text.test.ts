import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkText, generateWeekly, loadBannedWords, numberTokens, splitSentences, weekIndex, weeklyTemplate } from '../src/lib/ai-text.ts';
import { factsText } from '../src/lib/weekly-stats.ts';
import type { WeeklyStats } from '../src/lib/weekly-stats.ts';

const STATS: WeeklyStats = {
  asOf: '2026-11-16', total: 1234, newCount: 18, saleCount: 42, saleDiscountMedian: 30, reviewOver20: 310, highRatedNew: 4,
  topActresses: [{ name: '出演者A', count: 55 }], topSeries: [{ name: 'シリーズA', count: 21 }], topMakers: [{ name: 'メーカーA', count: 99 }],
  updatedAt: '2026-11-15T21:00:00Z',
};
const BANNED = ['禁止語甲', '禁止語乙'];
const facts = factsText(STATS);
const opts = { bannedWords: BANNED, facts, minSentences: 3, maxSentences: 5 };
const GOOD = '今週の新着は18件でした。公開中の作品は全部で1,234件です。セール中は42件あります。探索ページでは評価で絞り込めます。';

const reply = (text: string) => (async () => new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }), { status: 200 })) as typeof fetch;

describe('検査', () => {
  it('良い文は通る（カンマ付きの数字も、与えた数字なら通る）', () => assert.deepEqual(checkText(GOOD, opts), { ok: true }));
  it('禁止語（全角半角・空白の違いを無視）で落ちる。理由に語を出さない', () => {
    const r = checkText(GOOD.replace('探索', '禁止 語甲'), opts);
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes('禁止語甲'));
    assert.equal(checkText('ＪＫ' + GOOD, { ...opts, bannedWords: ['jk'] }).ok, false);
  });
  it('与えていない 2 桁以上の数字で落ちる（1 桁は許す）', () => {
    assert.equal(checkText(GOOD.replace('42件', '43件'), opts).ok, false);
    assert.equal(checkText(GOOD.replace('18件', '３５件'), opts).ok, false); // 全角も数える
    assert.equal(checkText(GOOD.replace('評価で', '2026年に評価で'), opts).ok, false);
    assert.equal(checkText(GOOD.replace('評価で', '3つの条件で'), opts).ok, true);
    assert.equal(checkText(GOOD.replace('18件', '4.5件'), opts).ok, false); // 小数は桁数に数える
  });
  it('文の数が 3〜5 の外なら落ちる', () => {
    assert.equal(checkText('新着は18件でした。公開中は1234件です。', opts).ok, false);
    assert.equal(checkText('一。二。三。四。五。六。', { ...opts, facts: '' }).ok, false);
    assert.equal(splitSentences('甲です。乙ですか？丙です！').length, 3);
  });
  it('題名・ジャンル名、不明・null・URL、見出しで落ちる', () => {
    assert.equal(checkText(GOOD + 'タグ名甲の話です。', { ...opts, forbidden: ['タグ名甲'], maxSentences: 9 }).ok, false);
    assert.equal(checkText(GOOD.replace('評価', '不明'), opts).ok, false);
    assert.equal(checkText(GOOD.replace('探索', 'https://example.com 探索'), opts).ok, false);
    assert.equal(checkText('# 見出し\n' + GOOD, opts).ok, false);
  });
  it('数字の取り出し', () => assert.deepEqual(numberTokens('１２,３４５件と4.5と7'), ['12345', '4.5', '7']));
});

describe('禁止語ファイルの読み込み', () => {
  it('説明（_ で始まるキー）を除き、配列の文字列をすべて集める。無ければ空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'banned-'));
    try {
      const p = join(dir, 'b.json');
      writeFileSync(p, JSON.stringify({ _説明: ['無視'], 甲: ['あ', ' い '], 乙: [], 丙: ['う', 3, ''] }));
      assert.deepEqual(loadBannedWords(p), ['あ', 'い', 'う']);
      assert.deepEqual(loadBannedWords(join(dir, 'none.json')), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('同梱の config/banned-words.json が読め、空でない', () => assert.ok(loadBannedWords('config/banned-words.json').length > 10));
});

describe('週次のテンプレート', () => {
  it('3 種類の文型が週ごとに変わり、同じ週は同じ文', () => {
    const texts = [0, 1, 2].map((i) => weeklyTemplate({ ...STATS, asOf: ['2026-11-09', '2026-11-16', '2026-11-23'][i] }));
    assert.equal(new Set(texts).size, 3);
    assert.equal(weeklyTemplate({ ...STATS, asOf: '2026-11-16' }), weeklyTemplate({ ...STATS, asOf: '2026-11-18' }));
    assert.equal(weekIndex('2026-11-16') - weekIndex('2026-11-09'), 1);
  });
  it('どの週・どの統計でも、検査に通り、「不明」や null を出さない', () => {
    const sparse: WeeklyStats = { asOf: '2026-11-16', total: 0, newCount: 0, saleCount: 0, saleDiscountMedian: null, reviewOver20: 0, highRatedNew: 0, topActresses: [], topSeries: [], topMakers: [], updatedAt: null };
    const noMed: WeeklyStats = { ...STATS, saleDiscountMedian: null, topActresses: [], highRatedNew: 0 };
    for (const base of [STATS, sparse, noMed]) {
      for (let day = 0; day < 70; day += 7) {
        const asOf = new Date(Date.UTC(2026, 10, 2 + day)).toISOString().slice(0, 10);
        const s = { ...base, asOf };
        const t = weeklyTemplate(s);
        const r = checkText(t, { bannedWords: BANNED, facts: factsText(s), minSentences: 3, maxSentences: 5 });
        assert.deepEqual(r, { ok: true }, `${asOf}: ${t}`);
        assert.ok(!/不明|null|undefined|NaN/.test(t));
      }
    }
  });
});

describe('週次の生成（LLM の応答を差し替えて確かめる）', () => {
  const llm = (text: string) => ({ apiKey: 'k', retryDelayMs: 0, fetchImpl: reply(text) });
  const run = (text: string) => generateWeekly(STATS, { bannedWords: BANNED, llm: llm(text) });

  it('検査に通る応答はそのまま使う', async () => {
    const r = await run(GOOD);
    assert.equal(r.source, 'llm');
    assert.equal(r.text, GOOD);
  });
  it('禁止語を含む応答はテンプレートに差し替える', async () => {
    const r = await run(GOOD.replace('探索', '禁止語乙の'));
    assert.equal(r.source, 'template');
    assert.equal(r.text, weeklyTemplate(STATS));
    assert.ok(r.reason && !r.reason.includes('禁止語乙'));
  });
  it('余計な数字を含む応答はテンプレートに差し替える', async () => {
    const r = await run(GOOD.replace('42件', '420件'));
    assert.equal(r.source, 'template');
    assert.match(r.reason ?? '', /数字/);
  });
  it('文が多すぎる・少なすぎる応答もテンプレートに差し替える', async () => {
    assert.equal((await run('新着は18件でした。')).source, 'template');
    assert.equal((await run('一。二。三。四。五。六。')).source, 'template');
  });
  it('API の失敗・キーなしはテンプレート（理由なし）', async () => {
    const down = (async () => new Response('{}', { status: 400 })) as typeof fetch;
    const a = await generateWeekly(STATS, { bannedWords: BANNED, llm: { apiKey: 'k', retryDelayMs: 0, fetchImpl: down } });
    assert.equal(a.source, 'template');
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const b = await generateWeekly(STATS, { bannedWords: BANNED });
      assert.deepEqual([b.source, b.reason], ['template', null]);
    } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
  });
});
