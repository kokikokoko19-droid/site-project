import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, mondayOf, noteMarkdown, operatorNoteInWeek, readNoteMeta } from '../scripts/draft-weekly.ts';
import { clearCatalogCache } from '../src/lib/catalog.ts';

describe('週の計算と note の読み取り', () => {
  it('mondayOf は日本の暦どおりに週の月曜を返す', () => {
    assert.equal(mondayOf('2026-11-16'), '2026-11-16'); // 月曜
    assert.equal(mondayOf('2026-11-15'), '2026-11-09'); // 日曜は前の月曜
    assert.equal(mondayOf('2026-11-18'), '2026-11-16');
  });
  it('frontmatter の source と date を読む（引用符あり・なし）', () => {
    assert.deepEqual(readNoteMeta('---\ndate: 2026-11-16\nsource: operator\ndraft: false\n---\n\n本文'), { source: 'operator', date: '2026-11-16' });
    assert.deepEqual(readNoteMeta('---\ndate: "2026-11-16"\nsource: \'llm\'\n---\n'), { source: 'llm', date: '2026-11-16' });
    assert.deepEqual(readNoteMeta('本文だけ'), { source: null, date: null });
  });
  it('noteMarkdown は frontmatter と本文を作る', () => {
    assert.equal(noteMarkdown('2026-11-16', 'llm', ' 本文です。\n'), '---\ndate: 2026-11-16\nsource: llm\ndraft: false\n---\n\n本文です。\n');
  });
});

describe('main（作業ディレクトリを入れ替えて実行）', () => {
  const orig = process.cwd();
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedExport = process.env.EXPORT_DIR;
  let dir = '';
  before(() => {
    delete process.env.ANTHROPIC_API_KEY;
    dir = mkdtempSync(join(tmpdir(), 'weekly-'));
    mkdirSync(join(dir, 'data/export'), { recursive: true });
    writeFileSync(join(dir, 'data/export/works.json'), '[]');
    writeFileSync(join(dir, 'data/export/meta.json'), '{}');
    writeFileSync(join(dir, 'data/export/index.json'), '{}');
    delete process.env.EXPORT_DIR;
    process.chdir(dir);
    clearCatalogCache();
  });
  after(() => {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedExport !== undefined) process.env.EXPORT_DIR = savedExport;
  });
  const run = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await main(args, (s) => out.push(s), (s) => err.push(s));
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('--dry-run は何も書かず、テンプレートの文を出す（キーなし）', async () => {
    const r = await run(['--dry-run', '--date', '2026-11-16']);
    assert.equal(r.code, 0);
    assert.match(r.out, /source: template/);
    assert.ok(!existsSync(join(dir, 'src/content/notes/2026-11-16.md')));
  });
  it('書き出すと frontmatter 付きの md ができ、再実行で上書きされる', async () => {
    assert.equal((await run(['--date', '2026-11-16'])).code, 0);
    const f = join(dir, 'src/content/notes/2026-11-16.md');
    assert.match(readFileSync(f, 'utf8'), /^---\ndate: 2026-11-16\nsource: template\ndraft: false\n---\n\n.+。\n$/s);
    assert.equal((await run(['--date', '2026-11-16'])).code, 0);
  });
  it('同じ週に運営者の note があれば何も書かない（週の外なら書く）', async () => {
    const notes = join(dir, 'src/content/notes');
    writeFileSync(join(notes, '2026-11-18.md'), '---\ndate: 2026-11-18\nsource: operator\ndraft: false\n---\n\n運営者の文。\n');
    assert.equal(operatorNoteInWeek(notes, '2026-11-16'), '2026-11-18.md');
    const r = await run(['--date', '2026-11-22']); // 同じ週の日曜
    assert.match(r.out, /自動生成しません/);
    assert.ok(!existsSync(join(notes, '2026-11-22.md')));
    assert.equal(operatorNoteInWeek(notes, '2026-11-23'), null);
    assert.equal((await run(['--date', '2026-11-23'])).code, 0);
    assert.ok(existsSync(join(notes, '2026-11-23.md')));
    assert.equal(readFileSync(join(notes, '2026-11-18.md'), 'utf8').includes('運営者の文。'), true);
  });
  it('不正な引数は終了コード 2', async () => {
    assert.equal((await run(['--date', '2026/11/16'])).code, 2);
    assert.equal((await run(['--nope'])).code, 2);
  });
});
