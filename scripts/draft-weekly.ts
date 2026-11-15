/**
 * 週次の「運営者から」を下書きして src/content/notes/<今日>.md に書く CLI（docs/07 の 10 章）。
 * 使い方: node --experimental-strip-types scripts/draft-weekly.ts [--dry-run] [--date YYYY-MM-DD]
 *   --dry-run   ファイルを書かず、本文と書き出し先を標準出力に出す
 *   --date      基準日（日本時間。既定は今日）。テストや取り直し用
 * 流れ: data/export から週次統計 → Claude（ANTHROPIC_API_KEY があれば）→ 検査 → 落ちる・キーなしならテンプレート。
 * 運営者が自分で書いた note（source: operator）が同じ週（月曜〜日曜）にあれば、何も書かずに終わる。
 * 環境変数: ANTHROPIC_API_KEY（任意）、EXPORT_DIR（既定 data/export）。値は出力しない。
 * 終了コード: 0 成功（書かなかった場合を含む）、1 実行中のエラー、2 使い方の誤り。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { generateWeekly, loadBannedWords } from '../src/lib/ai-text.ts';
import { loadCatalog } from '../src/lib/catalog.ts';
import { computeWeeklyStats, jstDate } from '../src/lib/weekly-stats.ts';

const NOTES_DIR = 'src/content/notes';
const BANNED_FILE = 'config/banned-words.json';
const DAY = 86_400_000;

/** 日付（YYYY-MM-DD）の日数。曜日の計算用 */
const dayNum = (key: string): number => Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) / DAY;

/** その日を含む週の月曜（YYYY-MM-DD） */
export function mondayOf(key: string): string {
  const n = dayNum(key);
  const back = (((new Date(n * DAY).getUTCDay() + 6) % 7)); // 月曜 0 … 日曜 6
  return new Date((n - back) * DAY).toISOString().slice(0, 10);
}

/** frontmatter の source と date（無ければ null） */
export function readNoteMeta(text: string): { source: string | null; date: string | null } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const pick = (k: string) => new RegExp(`^${k}:\\s*["']?([^"'\\s#]+)`, 'm').exec(fm)?.[1] ?? null;
  return { source: pick('source'), date: pick('date') };
}

/** 基準日と同じ週（月曜〜日曜）に、運営者が書いた note があるか。あればそのファイル名 */
export function operatorNoteInWeek(dir: string, asOf: string): string | null {
  if (!existsSync(dir)) return null;
  const start = dayNum(mondayOf(asOf));
  for (const f of readdirSync(dir).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
    const meta = readNoteMeta(readFileSync(join(dir, f), 'utf8'));
    const d = meta.date ?? f.slice(0, 10);
    if (meta.source === 'operator' && /^\d{4}-\d{2}-\d{2}$/.test(d) && dayNum(d) >= start && dayNum(d) < start + 7) return f;
  }
  return null;
}

/** note の md（frontmatter と本文） */
export function noteMarkdown(date: string, source: 'llm' | 'template', body: string): string {
  return `---\ndate: ${date}\nsource: ${source}\ndraft: false\n---\n\n${body.trim()}\n`;
}

export async function main(argv: string[], out: (s: string) => void = console.log, err: (s: string) => void = console.error): Promise<number> {
  let args;
  try {
    args = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean' }, date: { type: 'string' }, help: { type: 'boolean', short: 'h' } } }).values;
  } catch (e) {
    err(`${e instanceof Error ? e.message : String(e)}\n使い方: draft-weekly.ts [--dry-run] [--date YYYY-MM-DD]`);
    return 2;
  }
  if (args.help) { out('使い方: draft-weekly.ts [--dry-run] [--date YYYY-MM-DD]'); return 0; }
  if (args.date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(args.date) || Number.isNaN(Date.parse(args.date)))) { err(`--date は YYYY-MM-DD で指定してください: ${args.date}`); return 2; }

  const today = args.date ?? jstDate(new Date());
  const dryRun = args['dry-run'] === true;
  const dir = resolve(NOTES_DIR);

  const operator = operatorNoteInWeek(dir, today);
  if (operator) {
    out(`今週は運営者の note（${operator}）があるため、自動生成しません。`);
    return 0;
  }

  const catalog = loadCatalog();
  const stats = computeWeeklyStats(catalog, new Date(`${today}T12:00:00+09:00`));
  // 題名・ジャンル名が出力に混ざっていないかを検査するための一覧
  const forbidden = [...catalog.works.map((w) => w.title), ...catalog.refNames.genre.values()];
  const result = await generateWeekly(stats, {
    bannedWords: loadBannedWords(BANNED_FILE),
    forbidden,
    llm: { warn: (m) => err(m) },
  });

  if (result.source === 'template') {
    err(result.reason ? `LLM の文は検査に落ちたため、テンプレートの文にしました（理由: ${result.reason}）。` : 'LLM を使わず、テンプレートの文にしました（ANTHROPIC_API_KEY が無い、または API が使えませんでした）。');
  }
  const file = join(dir, `${today}.md`);
  if (dryRun) {
    out(`[dry-run] 書き出し先: ${NOTES_DIR}/${today}.md（source: ${result.source}）\n\n${result.text}`);
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, noteMarkdown(today, result.source, result.text), 'utf8');
  out(`書きました: ${NOTES_DIR}/${today}.md（source: ${result.source}）`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
}
