/**
 * X 自動投稿の CLI。使い方: node --experimental-strip-types src/x/cli.ts post [--count 3] [--with-url] [--dry-run] [--kind daily]
 *   post  作品を選んで X に投稿する。--count 件（既定 3）。1日（日本時間）の上限 X_DAILY_MAX（既定 5）を超えない範囲で投稿する。
 *         --with-url   本文の末尾に作品ページの URL を付ける（URL 付きは単価が高い。docs/02 8.2）
 *         --dry-run    通信せず、本文を標準出力に出して履歴に dry_run=1 で記録する（認証情報は要らない）
 *         --kind       履歴に残す区分（daily | feature | sale。既定 daily）。sale は「セール中」の作品だけから選ぶ
 * 環境変数: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET（--dry-run 以外で必須）、SITE_URL（--with-url で必須）、
 *   DB_PATH（既定 data/catalog.sqlite）, EXPORT_DIR（既定 data/export）, X_DAILY_MAX（既定 5。0 で投稿を止める）
 *   .env を使うときは node に --env-file=.env を付ける。
 * 終了コード: 0 成功（上限に達して投稿しなかった場合を含む）、1 実行中のエラー、2 使い方・設定の誤り（認証情報の不足を含む）。
 * 認証情報の値は出力しない。投稿は2件目以降、前の投稿から 60 秒以上あける。
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadCatalog } from '../lib/catalog.ts';
import type { Catalog } from '../lib/catalog.ts';
import { createXClient, redactSecrets } from './client.ts';
import { composePost, normalizeSiteUrl } from './compose.ts';
import { selectWorks } from './select.ts';
import { POST_KINDS, jstDateKey, openPostStore } from './store.ts';
import type { PostKind } from './store.ts';

export const POST_INTERVAL_MS = 60_000;
const DEFAULT_COUNT = 3;
const DEFAULT_DAILY_MAX = 5;
const CRED_KEYS = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'] as const;

const USAGE = `使い方: node --experimental-strip-types src/x/cli.ts post [--count 3] [--with-url] [--dry-run] [--kind daily]
環境変数: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET（--dry-run 以外で必須）, SITE_URL（--with-url で必須）,
  DB_PATH（既定 data/catalog.sqlite）, EXPORT_DIR（既定 data/export）, X_DAILY_MAX（既定 ${DEFAULT_DAILY_MAX}）`;

/** 使い方・設定の誤り（終了コード 2） */
class UsageError extends Error {}

type Env = Record<string, string | undefined>;
type Options = { count: number; withUrl: boolean; dryRun: boolean; kind: PostKind; help: boolean };

/** テストで差し替える部分。fetchImpl・sleep は投稿の通信と待機、catalog を渡すと EXPORT_DIR からは読まない */
export type CliDeps = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  catalog?: Catalog;
  out?: (line: string) => void;
  err?: (line: string) => void;
};

function toInt(name: string, v: string, min: number): number {
  if (!/^\d+$/.test(v) || Number(v) < min) throw new UsageError(`${name} には ${min} 以上の整数を指定してください: ${v}`);
  return Number(v);
}

function parseCli(argv: string[]): Options {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true,
      options: { count: { type: 'string' }, 'with-url': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, kind: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { values, positionals } = parsed;
  const kind = values.kind ?? 'daily';
  if (values.help) return { count: DEFAULT_COUNT, withUrl: false, dryRun: false, kind: 'daily', help: true };
  if (positionals[0] !== 'post' || positionals.length > 1) throw new UsageError(positionals.length === 0 ? 'コマンド post を指定してください' : `不明なコマンドか、余分な引数があります: ${positionals.join(' ')}`);
  if (!(POST_KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kind は ${POST_KINDS.join('・')} のどれかにしてください: ${kind}`);
  return {
    count: values.count === undefined ? DEFAULT_COUNT : toInt('--count', values.count, 1),
    withUrl: values['with-url'] === true, dryRun: values['dry-run'] === true, kind: kind as PostKind, help: false,
  };
}

async function runPost(o: Options, env: Env, deps: CliDeps, out: (line: string) => void): Promise<number> {
  const missing = CRED_KEYS.filter((k) => !env[k]);
  if (!o.dryRun && missing.length > 0) {
    throw new UsageError(`X の認証情報が設定されていません（環境変数 ${missing.join('、')}）。投稿せずに確認するなら --dry-run を付けてください`);
  }
  if (o.withUrl) {
    try { normalizeSiteUrl(env.SITE_URL ?? ''); } catch (e) { throw new UsageError(`--with-url には環境変数 SITE_URL が必要です（${(e as Error).message}）`); }
  }
  const dailyMax = env.X_DAILY_MAX ? toInt('X_DAILY_MAX', env.X_DAILY_MAX, 0) : DEFAULT_DAILY_MAX;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const catalog = deps.catalog ?? loadCatalog({ exportDir: env.EXPORT_DIR || undefined });
  const store = openPostStore(env.DB_PATH || 'data/catalog.sqlite');
  try {
    const today = jstDateKey(now());
    const done = store.countPostsOn(today, o.dryRun);
    const room = dailyMax - done;
    if (room <= 0) {
      out(`本日（${today}）の${o.dryRun ? ' dry-run の' : ''}記録が ${done} 件で、上限 ${dailyMax} 件に達しているため、投稿しません`);
      return 0;
    }
    const n = Math.min(o.count, room);
    if (n < o.count) out(`1日の上限 ${dailyMax} 件に収めるため、${o.count} 件を ${n} 件に減らします（本日の記録 ${done} 件）`);
    const works = selectWorks(catalog, store, { count: n, now: now(), mix: o.kind === 'sale' ? ['セール中'] : undefined });
    if (works.length === 0) throw new Error('投稿できる作品がありません（カタログが空か、候補がすべて直近の投稿と重複しています）');
    if (works.length < n) out(`候補が足りないため、${n} 件のところ ${works.length} 件になります`);

    const client = createXClient({
      consumerKey: env.X_API_KEY ?? '', consumerSecret: env.X_API_SECRET ?? '', accessToken: env.X_ACCESS_TOKEN ?? '',
      accessTokenSecret: env.X_ACCESS_TOKEN_SECRET ?? '', fetchImpl: deps.fetchImpl, sleep, dryRun: o.dryRun,
    });
    let posted = 0;
    for (const [i, work] of works.entries()) {
      const text = composePost(work, { withUrl: o.withUrl, siteUrl: env.SITE_URL ?? '' });
      if (o.dryRun) out(`[dry-run ${i + 1}/${works.length}] ${work.contentId}\n${text}`);
      else if (posted > 0) await sleep(POST_INTERVAL_MS);
      const { id } = await client.postTweet(text);
      try {
        store.recordPost({ contentId: work.contentId, postedAt: now(), tweetId: o.dryRun ? null : id, text, kind: o.kind, dryRun: o.dryRun });
      } catch (e) {
        throw new Error(`${o.dryRun ? '' : `投稿は成功しましたが（tweet_id=${id}）、`}履歴に記録できませんでした: ${(e as Error).message}`);
      }
      posted++;
      if (!o.dryRun) out(`投稿しました ${i + 1}/${works.length}: ${work.contentId} tweet_id=${id}`);
    }
    out(o.dryRun ? `完了: ${posted} 件を dry-run として記録しました（投稿はしていません）` : `完了: ${posted} 件を投稿しました`);
    return 0;
  } finally {
    store.close();
  }
}

/** 終了コードを返す（0 成功、1 実行中のエラー、2 使い方・設定の誤り）。env と deps はテストで差し替える */
export async function main(argv: string[], env: Env = process.env, deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  try {
    const o = parseCli(argv);
    if (o.help) { out(USAGE); return 0; }
    return await runPost(o, env, deps, out);
  } catch (e) {
    err(`エラー: ${redactSecrets(e instanceof Error ? e.message : String(e), CRED_KEYS.map((k) => env[k]))}`);
    if (e instanceof UsageError) err('使い方は --help で確認できます');
    return e instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
