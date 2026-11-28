/** src/lib/copy.ts のテスト（運営者の文の検査と読み込み）。実行: node --experimental-strip-types --test tests/copy.test.ts */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COPY_LIMITS, OPERATOR_BANNED_KEYS, cleanText, defaultBannedWords, loadCopy, paragraphs, rejectReason, toMaps, validateCopy } from '../src/lib/copy.ts';

const BANNED = ['禁止語サンプル', 'NGワード'];
const v = (items: unknown[], known?: Parameters<typeof validateCopy>[1]['known']) => validateCopy({ items }, { bannedWords: BANNED, known });

describe('validateCopy', () => {
  it('kind は work と actress だけ。空行は黙って飛ばす', () => {
    const r = v([
      { kind: 'work', id: 'juq00016', text: '一言' },
      { kind: 'actress', id: '1041897', text: '紹介' },
      { kind: 'series', id: 's1', text: '対象外' },
      { kind: '', id: '', text: '' },
      { kind: 'WORK', id: 'abc_1-2', text: '大文字の kind も可' },
    ]);
    assert.deepEqual(r.items.map((i) => `${i.kind}:${i.id}`), ['work:juq00016', 'actress:1041897', 'work:abc_1-2']);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0].reason, /kind/);
  });

  it('id は英数と _ - だけ。数字の id（スプレッドシートの数値）は文字列にする', () => {
    const r = v([
      { kind: 'actress', id: 1041897, text: '数値の id' },
      { kind: 'work', id: '../etc', text: 'x' },
      { kind: 'work', id: 'a b', text: 'x' },
      { kind: 'work', id: 'あいう', text: 'x' },
      { kind: 'work', id: 'x'.repeat(65), text: 'x' },
    ]);
    assert.deepEqual(r.items, [{ kind: 'actress', id: '1041897', text: '数値の id' }]);
    assert.equal(r.warnings.length, 4);
    // 不正な id そのものは警告に出さない
    assert.ok(r.warnings.every((w) => w.id === '(不正な id)'));
  });

  it('長さの上限（作品 400 字、出演者 800 字。絵文字も 1 字）', () => {
    const r = v([
      { kind: 'work', id: 'w1', text: 'あ'.repeat(COPY_LIMITS.work) },
      { kind: 'work', id: 'w2', text: 'あ'.repeat(COPY_LIMITS.work + 1) },
      { kind: 'work', id: 'w3', text: '😀'.repeat(COPY_LIMITS.work) },
      { kind: 'actress', id: 'a1', text: 'い'.repeat(800) },
      { kind: 'actress', id: 'a2', text: 'い'.repeat(801) },
    ]);
    assert.deepEqual(r.items.map((i) => i.id), ['w1', 'w3', 'a1']);
    assert.ok(r.warnings.every((w) => /長すぎる/.test(w.reason)));
  });

  it('HTML のタグ・文字参照と URL を含むものは捨てる', () => {
    const bad = [
      '<b>太字</b>', 'ここで<script>alert(1)</script>', '< img src=x onerror=1>', '<!-- コメント -->', '&lt;b&gt;', '&#60;',
      'https://example.com を見て', 'ｈｔｔｐｓ：／／ｅｘａｍｐｌｅ', 'www.example.net', 'example.com へ', 'javascript:alert(1)', '//evil.test/x',
    ];
    const r = v(bad.map((text, i) => ({ kind: 'work', id: `b${i}`, text })));
    assert.equal(r.items.length, 0);
    assert.equal(r.warnings.length, bad.length);
    // 不等号や記号だけなら残す
    const ok = v([{ kind: 'work', id: 'ok', text: '評価は 4 < 5 で、A&B の組み合わせ。3.5 点。' }]);
    assert.equal(ok.items.length, 1);
  });

  it('禁止語（全角半角・大文字小文字・空白を区別しない）を含むものは捨て、警告に語は出さない', () => {
    const r = v([
      { kind: 'work', id: 'w1', text: 'これは禁止語 サンプルです' },
      { kind: 'work', id: 'w2', text: 'ｎｇワード' },
      { kind: 'work', id: 'w3', text: '問題のない文' },
    ]);
    assert.deepEqual(r.items.map((i) => i.id), ['w3']);
    assert.equal(r.warnings.length, 2);
    assert.ok(r.warnings.every((w) => w.reason === '禁止語を含む'));
  });

  it('ビルド検査で止まる語（null・不明など）は捨てる。「ご不明」などは残す', () => {
    const r = v([
      { kind: 'work', id: 'w1', text: '値は null' },
      { kind: 'work', id: 'w2', text: '詳細は不明' },
      { kind: 'work', id: 'w3', text: '正体不明の魅力' },
    ]);
    assert.deepEqual(r.items.map((i) => i.id), ['w3']);
  });

  it('同じ kind+id は下の行を採る。下の行が捨てられたら前の行も使わない', () => {
    const r = v([
      { kind: 'work', id: 'w1', text: '古い' },
      { kind: 'actress', id: 'w1', text: '別の kind' },
      { kind: 'work', id: 'w1', text: '新しい' },
      { kind: 'work', id: 'w2', text: '採用されない' },
      { kind: 'work', id: 'w2', text: '<b>捨てられる</b>' },
    ]);
    const m = toMaps(r.items);
    assert.equal(m.work.get('w1'), '新しい');
    assert.equal(m.actress.get('w1'), '別の kind');
    assert.equal(m.work.has('w2'), false);
  });

  it('known を渡すとカタログに無い id を無視する（件数だけ数える）', () => {
    const r = v([
      { kind: 'work', id: 'w1', text: 'ある' },
      { kind: 'work', id: 'w9', text: 'ない' },
      { kind: 'actress', id: '1', text: 'ある' },
    ], { work: (id) => id === 'w1', actress: (id) => id === '1' });
    assert.deepEqual(r.items.map((i) => i.id), ['w1', '1']);
    assert.equal(r.unknown, 1);
  });

  it('items が無い応答は例外。配列そのものも受け付ける。行の形が変なものは飛ばす', () => {
    assert.throws(() => validateCopy({ error: 'forbidden' }, { bannedWords: [] }));
    assert.throws(() => validateCopy(null, { bannedWords: [] }));
    const r = validateCopy([null, 1, 'x', { kind: 'work', id: 'w1', text: 'ok' }, { kind: 'work', id: 'w2', text: { a: 1 } }], { bannedWords: [] });
    assert.deepEqual(r.items.map((i) => i.id), ['w1']);
    assert.equal(r.warnings[0].reason, '本文が空');
  });
});

describe('cleanText と paragraphs', () => {
  it('改行をそろえ、制御文字と行末の空白を落とし、3 つ以上の改行は 2 つにする', () => {
    assert.equal(cleanText('  一行目 \r\n二行目​\r\n\r\n\r\n\r\n三段落目\u0007  '), '一行目\n二行目\n\n三段落目');
  });
  it('改行 2 つで段落に分ける', () => {
    assert.deepEqual(paragraphs('一段落目\n続き\n\n二段落目\n\n\n'), ['一段落目\n続き', '二段落目']);
  });
  it('rejectReason: 空は捨てる', () => {
    assert.equal(rejectReason('work', '', []), '本文が空');
    assert.equal(rejectReason('work', 'ok', []), null);
  });
});

describe('loadCopy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copy-test-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('ファイルが無ければ空', () => {
    const m = loadCopy({ path: join(dir, 'none.json'), known: null });
    assert.equal(m.work.size + m.actress.size, 0);
  });

  it('読むときにも検査し直し、カタログに無い id を無視する。2 回目はキャッシュ', () => {
    const file = join(dir, 'copy.json');
    writeFileSync(file, JSON.stringify({ fetchedAt: '2026-11-28T00:00:00Z', items: [
      { kind: 'work', id: 'w1', text: '一言' },
      { kind: 'work', id: 'w2', text: '<i>手で置いた不正な文</i>' },
      { kind: 'work', id: 'zz', text: 'カタログに無い' },
      { kind: 'actress', id: '7', text: '紹介' },
    ] }));
    const known = { work: (id: string) => id !== 'zz', actress: () => true };
    const m = loadCopy({ path: file, known, bannedWords: [] });
    assert.deepEqual([...m.work.keys()], ['w1']);
    assert.equal(m.actress.get('7'), '紹介');
    writeFileSync(file, '{}');
    assert.equal(loadCopy({ path: file, known }), m);
    assert.equal(loadCopy({ path: file, known, force: true }).work.size, 0); // 壊れた形は空（警告だけ）
  });
});

describe('defaultBannedWords', () => {
  it('運営者の文に掛けるのは「未成年を連想させる語」と「運営者が追記する語」だけで、「明らかに性的な語」は掛けない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'banned-'));
    const file = join(dir, 'banned-words.json');
    writeFileSync(file, JSON.stringify({ _説明: 'x', '未成年を連想させる語': ['未成年語A'], '明らかに性的な語': ['性的語B'], '運営者が追記する語': ['追記語C'] }));
    const words = defaultBannedWords(file);
    assert.deepEqual([...words].sort(), ['未成年語A', '追記語C']);
    assert.deepEqual([...OPERATOR_BANNED_KEYS], ['未成年を連想させる語', '運営者が追記する語']);
    assert.deepEqual(defaultBannedWords(join(dir, 'none.json')), []);
  });
});
