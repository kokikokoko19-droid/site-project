/**
 * X API v2 のクライアント（投稿だけ）。POST /2/tweets を OAuth 1.0a で署名して呼ぶ。
 * 429 と 5xx は指数バックオフ（1秒、2秒、4秒）で最大3回再試行する。403 などそれ以外の4xxは再試行しない。
 * 429 の待ちは短いので、レート制限が続くときは最終的にエラーになり、次回の定時実行に任せる。
 * エラーメッセージには応答本文の要点だけを入れ、認証情報の値は（応答に混ざっていても）伏せる。
 * dryRun のときは通信せず、認証情報も要らない。
 */
import { buildAuthorizationHeader } from './oauth.ts';

export type XClientOptions = {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  /** 通信の実装（テストで差し替える）。省略すると fetch */
  fetchImpl?: typeof fetch;
  /** 待機の実装（テストで差し替える）。省略すると setTimeout */
  sleep?: (ms: number) => Promise<void>;
  /** API のベース URL。省略すると https://api.x.com（署名もこの URL で行う） */
  baseUrl?: string;
  /** true なら通信せず { id: 'dry-run' } を返す。認証情報の検査もしない */
  dryRun?: boolean;
};

export type XClient = { postTweet(text: string): Promise<{ id: string }> };

export const DEFAULT_BASE_URL = 'https://api.x.com';
export const MAX_RETRIES = 3;
export const BACKOFF_BASE_MS = 1000;
const TIMEOUT_MS = 30_000;
const DETAIL_MAX = 200;

/** API が返したエラー（HTTP ステータス付き） */
export class XApiError extends Error {
  status: number;
  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'XApiError';
    this.status = status;
  }
}

/** 文中の認証情報の値と、Authorization ヘッダー形式の oauth_* の値を *** に置き換える */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out.replace(/\b(oauth_(?:consumer_key|nonce|signature|token))="[^"]*"/g, '$1="***"');
}

const clip = (s: string, max: number): string => (Array.from(s).length > max ? `${Array.from(s).slice(0, max).join('')}…` : s);

/** 応答本文の要点を1行にする。JSON なら title・detail・reason・message と errors[].message、そうでなければ先頭部分 */
function summarizeBody(body: string): string {
  let text = body;
  try {
    const j = JSON.parse(body) as Record<string, unknown> | null;
    const errors = Array.isArray(j?.errors) ? (j.errors as unknown[]) : [];
    const parts = [...['title', 'detail', 'reason', 'message'].map((k) => j?.[k]), ...errors.map((e) => (e as { message?: unknown } | null)?.message)]
      .filter((v): v is string => typeof v === 'string' && v !== '');
    if (parts.length > 0) text = parts.join(' / ');
  } catch { /* JSON でなければ本文をそのまま使う */ }
  return clip(text.replace(/\s+/g, ' ').trim(), DETAIL_MAX);
}

/** ステータスごとの確認ポイント（docs/04 の調査にもとづく。未確認の部分は推測を含む） */
function hintFor(status: number): string {
  if (status === 401) return ' 認証情報（4つのキー）が正しいか、アクセストークンを再生成していないかを確認してください。';
  if (status === 403) return ' アプリの権限が Read and write か、従量課金の登録とクレジット残高、同一内容の重複投稿でないかを確認してください。';
  return '';
}

export function createXClient(opts: XClientOptions): XClient {
  const { consumerKey, consumerSecret, accessToken, accessTokenSecret } = opts;
  const dryRun = opts.dryRun === true;
  if (!dryRun) {
    const missing = Object.entries({ consumerKey, consumerSecret, accessToken, accessTokenSecret }).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) throw new Error(`X API の認証情報が足りません: ${missing.join('、')}`);
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const endpoint = `${(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/2/tweets`;
  const secrets = [consumerKey, consumerSecret, accessToken, accessTokenSecret];
  const safe = (s: string): string => redactSecrets(s, secrets);

  async function postTweet(text: string): Promise<{ id: string }> {
    if (typeof text !== 'string' || text.trim() === '') throw new Error('投稿の本文が空です');
    if (dryRun) return { id: 'dry-run' };

    for (let attempt = 0; ; attempt++) {
      // nonce と timestamp は再試行のたびに作り直す（同じ nonce の使い回しは拒否される）
      const authorization = buildAuthorizationHeader({
        method: 'POST', url: endpoint, consumerKey, consumerSecret, token: accessToken, tokenSecret: accessTokenSecret,
      });
      let res: Response;
      let raw: string;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        raw = await res.text();
      } catch (e) {
        // 通信の失敗は再試行しない（POST は重複投稿になり得る）。次回の定時実行に任せる
        throw new Error(safe(`X API に接続できませんでした: ${e instanceof Error ? e.message : String(e)}`), { cause: e });
      }

      if (res.ok) {
        let id: unknown;
        try { id = (JSON.parse(raw) as { data?: { id?: unknown } } | null)?.data?.id; } catch { /* 下で検査する */ }
        if (typeof id === 'string' && id !== '') return { id };
        throw new XApiError(safe(`X API の応答に data.id がありません（${res.status}）: ${summarizeBody(raw)}`), res.status);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        await sleep(BACKOFF_BASE_MS * 2 ** attempt);
        continue;
      }
      const retried = attempt > 0 ? `（${attempt} 回再試行したあと）` : '';
      throw new XApiError(safe(`X API が ${res.status} を返しました${retried}: ${summarizeBody(raw)}${hintFor(res.status)}`), res.status);
    }
  }
  return { postTweet };
}
