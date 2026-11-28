// 運営者の文（作品の一言・出演者の紹介）を Google スプレッドシートの Apps Script から取得し、data/copy.json に書く（docs/07 の 11 章）。
//   - 環境変数 COPY_FEED_URL（?token=... つきの URL。GitHub の Secrets）が空なら何もせず終了する。
//   - 取得はタイムアウト 20 秒、失敗したら 1 回だけ再試行。検査は src/lib/copy.ts の validateCopy（長さ・HTML・URL・禁止語・kind・id・後勝ち）。
//   - 失敗しても終了コードは 0（日次を止めない）。既存の data/copy.json があればそのまま残す。
//   - ログと要約には件数と kind・id・理由だけを出す。本文・禁止語・URL（トークンを含む）は出さない。
// 依存なし。src/lib/copy.ts を読むので、実行は node --experimental-strip-types scripts/fetch-copy.mjs（npm run fetch:copy）。
import { mkdirSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { copyPath, defaultBannedWords, validateCopy } from '../src/lib/copy.ts';

const TIMEOUT_MS = 20_000;
const RETRY_WAIT_MS = 3_000;
const MAX_BYTES = 5 * 1024 * 1024;
const inActions = process.env.GITHUB_ACTIONS === 'true';

function warn(message) {
  console.warn(inActions ? `::warning title=運営者の文::${message}` : `[fetch-copy] ${message}`);
}
function summary(line) {
  console.log(`[fetch-copy] ${line}`);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) {
    try { appendFileSync(file, `運営者の文: ${line}\n`); } catch { /* 要約に書けなくても続ける */ }
  }
}

async function fetchOnce(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow', headers: { accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new Error('応答が大きすぎる');
  let json;
  try { json = JSON.parse(body); } catch { throw new Error('応答が JSON ではない（ウェブアプリのアクセスできるユーザーが「全員」になっているか確認）'); }
  if (json && typeof json === 'object' && !Array.isArray(json) && 'error' in json) {
    throw new Error(`Apps Script がエラーを返した（${String(json.error).slice(0, 40)}。token の不一致など）`);
  }
  return json;
}

/** エラーの説明（URL やトークンを含みうる cause は出さない） */
const describe = (e) => (e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'タイムアウト（20 秒）' : String(e?.message ?? e).slice(0, 200));

async function main() {
  const url = (process.env.COPY_FEED_URL ?? '').trim();
  if (url === '') {
    summary('COPY_FEED_URL が未登録のため取得しませんでした');
    return;
  }
  if (!/^https:\/\//.test(url)) {
    warn('COPY_FEED_URL が https:// で始まっていません。取得をやめ、前回の data/copy.json があればそのまま使います');
    summary('取得せず（URL の形式が不正）');
    return;
  }
  let json;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      json = await fetchOnce(url);
      break;
    } catch (e) {
      if (attempt === 1) {
        console.warn(`[fetch-copy] 取得に失敗しました（${describe(e)}）。もう 1 回だけ試します`);
        await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
      } else {
        warn(`取得に失敗しました（${describe(e)}）。前回の data/copy.json があればそのまま使います`);
        summary('取得に失敗（前回のものがあればそれを使用）');
        return;
      }
    }
  }

  let result;
  try {
    result = validateCopy(json, { bannedWords: defaultBannedWords() });
  } catch (e) {
    warn(`応答の形が違います（${describe(e)}）。前回の data/copy.json があればそのまま使います`);
    summary('取得に失敗（応答の形が不正）');
    return;
  }
  for (const w of result.warnings) warn(`${w.kind} ${w.id} を捨てました: ${w.reason}`);

  const out = copyPath();
  mkdirSync(dirname(out), { recursive: true });
  // 書きかけのファイルを読まれないよう、一時ファイルに書いてから置き換える
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, JSON.stringify({ fetchedAt: new Date().toISOString(), items: result.items }));
  renameSync(tmp, out);
  const work = result.items.filter((i) => i.kind === 'work').length;
  const actress = result.items.length - work;
  summary(`work ${work} 件・actress ${actress} 件を取り込みました（捨てた行 ${result.warnings.length} 件）`);
}

main().catch((e) => {
  warn(`想定外のエラー（${describe(e)}）。前回の data/copy.json があればそのまま使います`);
  process.exitCode = 0;
});
