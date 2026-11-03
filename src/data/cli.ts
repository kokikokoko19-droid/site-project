/**
 * データ層の CLI。使い方: node --experimental-strip-types src/data/cli.ts <command> [--flags]
 *   ingest  FANZA API から取り込む。直近の取り込み（--recent-days N、既定 7）に続けて、--follow（config/follow.json の指定軸の全作品。--follow-config で変更）、--refresh（取り込み済みの再取得）、
 *           --ranked-pages N（人気順の上位 N ページ）を行う。--synthetic N なら API を使わず合成データ N 件だけを入れる
 *   derive  ラベル・似た作品・ランキング・今日の候補を再計算する
 *   export  探索UI・ページ生成用の JSON を出力する
 *   all     ingest（上と同じフラグ）→ derive → export
 * 環境変数: FANZA_API_ID, FANZA_AFFILIATE_ID, DB_PATH（既定 data/catalog.sqlite）, EXPORT_DIR（既定 data/export）
 * 終了コード: 0 成功、1 実行中のエラー、2 使い方・設定の誤り（API ID 未設定を含む）。API ID や URL のクエリは出力しない。
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createClient } from './api.ts';
import { openDb } from './db.ts';
import type { Db } from './db.ts';
import { runDerive } from './derive.ts';
import { exportAll } from './export.ts';
import { ingestFollowed, loadFollowConfig } from './ingest-follow.ts';
import { ingestRanked, ingestRecent, ingestSynthetic, refreshExisting } from './ingest.ts';

const USAGE = `使い方: node --experimental-strip-types src/data/cli.ts <command> [--flags]
  ingest  [--recent-days N] [--follow [--follow-config PATH]] [--refresh] [--ranked-pages N] [--synthetic N]
  derive
  export
  all     （ingest と同じフラグ。ingest → derive → export）
環境変数: FANZA_API_ID, FANZA_AFFILIATE_ID, DB_PATH（既定 data/catalog.sqlite）, EXPORT_DIR（既定 data/export）`;

/** 使い方・設定の誤り（終了コード 2） */
class UsageError extends Error {}

type Flags = { follow: boolean; followConfig: string; recentDays: number; refresh: boolean; rankedPages: number | null; synthetic: number | null };

/** フラグの整数を読む（未指定なら fallback） */
function toInt(name: string, v: string | undefined, fallback: number | null, min: number): number | null {
  if (v === undefined) return fallback;
  if (!/^\d+$/.test(v) || Number(v) < min) throw new UsageError(`--${name} には ${min} 以上の整数を指定してください: ${v}`);
  return Number(v);
}

function parseCli(argv: string[]): { command: string | undefined; flags: Flags; help: boolean } {
  try {
    const { values, positionals } = parseArgs({
      args: argv, allowPositionals: true,
      options: {
        'recent-days': { type: 'string' }, refresh: { type: 'boolean' }, follow: { type: 'boolean' }, 'follow-config': { type: 'string' }, 'ranked-pages': { type: 'string' },
        synthetic: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    });
    if (positionals.length > 1) throw new UsageError(`余分な引数があります: ${positionals.slice(1).join(' ')}`);
    const flags: Flags = {
      follow: values.follow === true, followConfig: values['follow-config'] ?? 'config/follow.json',
      recentDays: toInt('recent-days', values['recent-days'], 7, 0) as number, refresh: values.refresh === true,
      rankedPages: toInt('ranked-pages', values['ranked-pages'], null, 1), synthetic: toInt('synthetic', values.synthetic, null, 1),
    };
    return { command: positionals[0], flags, help: values.help === true };
  } catch (e) {
    throw e instanceof UsageError ? e : new UsageError((e as Error).message);
  }
}

/** 文に API ID・アフィリエイト ID の値や URL のクエリが混ざっていても出さない */
function redact(text: string): string {
  let out = text;
  for (const secret of [process.env.FANZA_API_ID, process.env.FANZA_AFFILIATE_ID]) if (secret) out = out.split(secret).join('***');
  return out.replace(/\b(api_id|affiliate_id)=[^&\s"')]*/gi, '$1=***').replace(/(https?:\/\/[^\s?"')]+)\?[^\s"')]*/g, '$1?…');
}

const log = (line: string): void => console.log(redact(line));

/** 取り込み結果のうち、数値・真偽値の項目だけを「名前=値」で並べる */
const summary = (r: unknown): string =>
  Object.entries((r ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean').map(([k, v]) => `${k}=${v}`).join(' ');

async function runIngest(db: Db, f: Flags): Promise<void> {
  const onProgress = (p: { message: string }): void => log(`  ${p.message}`);
  if (f.synthetic !== null) {
    log(`[ingest] 合成データ ${f.synthetic} 件を取り込みます`);
    log(`[ingest] 完了: ${summary(await ingestSynthetic(db, { count: f.synthetic, onProgress }))}`);
    return;
  }
  const client = createClient({ apiId: process.env.FANZA_API_ID as string, affiliateId: process.env.FANZA_AFFILIATE_ID as string });
  log(`[ingest] 直近 ${f.recentDays} 日分を取り込みます`);
  log(`[ingest] 完了: ${summary(await ingestRecent(client, db, { days: f.recentDays, onProgress }))}`);
  if (f.follow) { // 順序は recent → follow → refresh → ranked
    log(`[ingest] 指定軸（${f.followConfig}）の全作品を取り込みます`);
    log(`[ingest] 完了: ${summary(await ingestFollowed(client, db, { follow: loadFollowConfig(f.followConfig), onProgress }))}`);
  }
  if (f.refresh) {
    log('[ingest] 取り込み済みの作品を再取得します');
    log(`[ingest] 完了: ${summary(await refreshExisting(client, db, { onProgress }))}`);
  }
  if (f.rankedPages !== null) { // 順位は最後に付ける（後の upsert で消さないため）
    log(`[ingest] 人気順の上位 ${f.rankedPages} ページを取り込みます`);
    log(`[ingest] 完了: ${summary(await ingestRanked(client, db, { pages: f.rankedPages, onProgress }))}`);
  }
}

/** 終了コードを返す（0 成功、1 実行中のエラー、2 使い方・設定の誤り） */
export async function main(argv: string[]): Promise<number> {
  try {
    const { command, flags, help } = parseCli(argv);
    if (help) { console.log(USAGE); return 0; }
    if (command === undefined || !['ingest', 'derive', 'export', 'all'].includes(command)) {
      throw new UsageError(command === undefined ? 'コマンドを指定してください' : `不明なコマンドです: ${command}`);
    }
    const ingesting = command === 'ingest' || command === 'all';
    const missing = ['FANZA_API_ID', 'FANZA_AFFILIATE_ID'].filter((k) => !process.env[k]);
    if (ingesting && flags.synthetic === null && missing.length > 0) {
      throw new UsageError(`${missing.join(' と ')} が設定されていません。環境変数で指定してください（.env を使う場合は node に --env-file=.env を付けます）。API を使わずに試すなら --synthetic N を指定してください`);
    }
    const dbPath = process.env.DB_PATH || 'data/catalog.sqlite', outDir = process.env.EXPORT_DIR || 'data/export';
    const db = openDb(dbPath);
    try {
      log(`[db] ${dbPath}`);
      if (ingesting) await runIngest(db, flags);
      if (command === 'derive' || command === 'all') {
        const r = runDerive(db);
        log(`[derive] 作品 ${r.works} 件を処理: ラベル付き ${r.labeled} 件、似た作品あり ${r.similar} 件`);
      }
      if (command === 'export' || command === 'all') {
        const r = exportAll(db, outDir);
        log(`[export] 作品 ${r.works} 件を ${r.chunks} 個のチャンクに分けて ${outDir} に出力しました`);
      }
    } finally {
      db.close();
    }
    return 0;
  } catch (e) {
    console.error(`エラー: ${redact(e instanceof Error ? e.message : String(e))}`);
    if (e instanceof UsageError) console.error('使い方は --help で確認できます');
    return e instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
