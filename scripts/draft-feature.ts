/**
 * 特集の下書きを作る CLI（docs/07 の 10 章）。候補の作品を出し、src/content/feature/draft-<テーマ>.md を draft: true で書く。
 * 使い方: node --experimental-strip-types scripts/draft-feature.ts --theme <classic|month|starter|sale> [--dry-run] [--force]
 *   --theme    テーマ（classic: レビュー100件超の定番、month: 今月の高評価、starter: 短くて評価の高い入門向け、sale: セール中の高評価）
 *   --dry-run  ファイルを書かず、候補と下書きを標準出力に出す
 *   --force    既存の draft-<テーマ>.md を上書きする（既定は上書きしない）
 * 導入文は、ANTHROPIC_API_KEY があれば Claude が非露骨の範囲で下書きし、検査に落ちる・キーなしならテンプレート。
 * 本文は見出しと「選んだ理由」の空欄だけ。選んだ理由は運営者が書く。題名は出さない（作品は /v/ID/ で確認する）。
 * 終了コード: 0 成功、1 実行中のエラー、2 使い方の誤り。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { generateChecked, loadBannedWords } from '../src/lib/ai-text.ts';
import type { Generated } from '../src/lib/ai-text.ts';
import { loadCatalog } from '../src/lib/catalog.ts';
import { INTRO_REQUEST, INTRO_SYSTEM, THEMES, THEME_KEYS, featureCandidates, introTemplate, isThemeKey, themeFacts } from '../src/lib/feature-candidates.ts';
import type { Candidate, Theme } from '../src/lib/feature-candidates.ts';
import { jstDate } from '../src/lib/weekly-stats.ts';

const FEATURE_DIR = 'src/content/feature';
const BANNED_FILE = 'config/banned-words.json';

/** YAML の二重引用符つき文字列（content_id は数字だけのものも文字列にするため必ず囲む） */
const q = (s: string): string => JSON.stringify(s);

/** 候補の表（題名なし。c.price は円） */
export function candidateTable(list: Candidate[]): string {
  const cell = (v: number | null, unit = ''): string => (v === null ? '-' : `${v}${unit}`);
  const head = 'content_id\t評価\t件数\t収録\t価格\t配信日';
  return [head, ...list.map((c) => [c.contentId, cell(c.reviewAvg), c.reviewCount, cell(c.volumeMin, '分'), cell(c.price, '円'), (c.releasedAt ?? '-').slice(0, 10)].join('\t'))].join('\n');
}

/** 下書きの md（draft: true）。本文は見出しと「選んだ理由」の空欄 */
export function featureMarkdown(theme: Theme, date: string, ids: string[], intro: Generated): string {
  const worksYaml = ids.length === 0 ? 'works: []' : `works:\n${ids.map((id) => `  - ${q(id)}`).join('\n')}`;
  return [
    '---',
    `# 自動の下書き（導入文の出どころ: ${intro.source === 'llm' ? 'Claude' : 'テンプレート'}）。works は候補の上位。運営者が作品を見て入れ替え、title と本文を決めてから draft を false にする。`,
    `title: ${q(`（下書き）${theme.label}`)}`,
    `description: ${q(`${theme.label}。運営者が選んだ作品と、その理由。`)}`,
    `date: ${date}`,
    'draft: true',
    worksYaml,
    `intro: ${q(intro.text)}`,
    '---',
    '',
    `## ${theme.label}`,
    '',
    '### 選んだ理由',
    '',
    '<!-- TODO: 運営者が記入（作品ごとに /v/ID/ を開いて確かめ、選んだ理由を書く） -->',
    '',
  ].join('\n');
}

export async function main(argv: string[], out: (s: string) => void = console.log, err: (s: string) => void = console.error): Promise<number> {
  const usage = `使い方: draft-feature.ts --theme <${THEME_KEYS.join('|')}> [--dry-run] [--force]`;
  let args;
  try {
    args = parseArgs({ args: argv, options: { theme: { type: 'string' }, 'dry-run': { type: 'boolean' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }).values;
  } catch (e) {
    err(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
    return 2;
  }
  if (args.help) { out(usage); return 0; }
  if (!args.theme || !isThemeKey(args.theme)) { err(`--theme にはテーマを指定してください（${THEME_KEYS.join('、')}）。\n${usage}`); return 2; }
  const theme = THEMES[args.theme];
  const dryRun = args['dry-run'] === true;
  const dir = resolve(FEATURE_DIR);
  const file = join(dir, `draft-${theme.key}.md`);
  if (!dryRun && existsSync(file) && args.force !== true) {
    err(`${FEATURE_DIR}/draft-${theme.key}.md は既にあります。上書きするときは --force を付けてください。`);
    return 2;
  }

  const catalog = loadCatalog();
  const now = new Date();
  const list = featureCandidates(catalog, theme.key, now);
  out(`テーマ: ${theme.label}（候補 ${list.length} 件）`);
  out(list.length > 0 ? candidateTable(list) : '（条件に合う作品がありません）');

  const forbidden = [...catalog.works.map((w) => w.title), ...catalog.refNames.genre.values(), ...catalog.refNames.actress.values()];
  const intro = await generateChecked({
    system: INTRO_SYSTEM,
    facts: themeFacts(theme, list.length),
    request: INTRO_REQUEST,
    template: introTemplate(theme.key),
    check: { bannedWords: loadBannedWords(BANNED_FILE), forbidden, minSentences: 2, maxSentences: 3 },
    llm: { warn: (m) => err(m) },
  });
  if (intro.source === 'template') {
    err(intro.reason ? `LLM の導入文は検査に落ちたため、テンプレートにしました（理由: ${intro.reason}）。` : '導入文は LLM を使わず、テンプレートにしました（ANTHROPIC_API_KEY が無い、または API が使えませんでした）。');
  }
  const md = featureMarkdown(theme, jstDate(now), list.map((c) => c.contentId), intro);
  if (dryRun) {
    out(`\n[dry-run] 書き出し先: ${FEATURE_DIR}/draft-${theme.key}.md\n\n${md}`);
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, md, 'utf8');
  out(`\n書きました: ${FEATURE_DIR}/draft-${theme.key}.md（draft: true、導入文: ${intro.source}）`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
}
