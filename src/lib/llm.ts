/**
 * Claude API（Messages API）の薄い呼び出し。npm の依存は増やさず fetch で直接呼ぶ。
 * - ANTHROPIC_API_KEY が無いときは通信せずに null を返す（呼び出し側はテンプレートの文に切り替える）。
 * - タイムアウト、再試行 1 回（通信失敗・タイムアウト・429・5xx のとき）、出力の最大トークンを固定する。
 * - 失敗は例外にせず null を返し、理由は warn に渡す（秘密情報は出さない）。
 * モデル ID と API の版はこのファイルの定数だけに置く。
 */

/** 使うモデル（Claude Sonnet 5.5）。変えるのはここだけ */
export const CLAUDE_MODEL = 'claude-sonnet-5-5';
export const API_URL = 'https://api.anthropic.com/v1/messages?beta=true';
export const ANTHROPIC_VERSION = '2023-06-01';
/** 安全分類器に断られたときに、同じ呼び出しの中で別のモデルに任せる設定（server-side fallback）。false で無効 */
export const USE_FALLBACKS = true;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** 出力の上限。適応的な思考もこの枠に入るので、3〜5 文の本文に対して余裕を持たせる */
export const MAX_OUTPUT_TOKENS = 2000;
export const TIMEOUT_MS = 60_000;
export const RETRY_DELAY_MS = 2_000;

export type AskOptions = {
  system: string;
  user: string;
  /** 省略すると環境変数 ANTHROPIC_API_KEY。空なら呼ばずに null */
  apiKey?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** 再試行までの待ち（ミリ秒。テストでは 0） */
  retryDelayMs?: number;
  /** テストで差し替える */
  fetchImpl?: typeof fetch;
  warn?: (message: string) => void;
};

type ApiBody = { content?: { type?: string; text?: string }[]; stop_reason?: string | null; error?: { type?: string; message?: string } };

/** 再試行してよい状態か（通信失敗は status が undefined） */
const retryable = (status: number | undefined): boolean => status === undefined || status === 408 || status === 429 || status >= 500;

/** 1 回の呼び出し。成功なら本文、失敗なら理由（status は HTTP の状態。通信失敗なら無し） */
async function once(o: AskOptions, apiKey: string): Promise<{ text: string } | { error: string; status?: number }> {
  const doFetch = o.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    model: CLAUDE_MODEL,
    max_tokens: o.maxTokens ?? MAX_OUTPUT_TOKENS,
    system: o.system,
    // 短い文章なので思考は浅くてよい（サンプリングの引数は現行モデルでは送れない）
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: o.user }],
  };
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  if (USE_FALLBACKS) { headers['anthropic-beta'] = FALLBACK_BETA; body.fallbacks = 'default'; }
  // 応答の本文を読み終えるまでを 1 つの制限時間に収める
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? TIMEOUT_MS);
  let res: Response;
  let json: ApiBody = {};
  try {
    res = await doFetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    try { json = (await res.json()) as ApiBody; } catch { if (ctl.signal.aborted) throw new Error('timeout'); /* 本文が JSON でなくても状態で判断する */ }
  } catch {
    return { error: ctl.signal.aborted ? 'タイムアウト' : '通信に失敗' };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return { error: `HTTP ${res.status}${json.error?.type ? ` ${json.error.type}` : ''}`, status: res.status };
  if (json.stop_reason === 'refusal') return { error: '安全分類器に断られた（refusal）', status: 200 };
  if (json.stop_reason === 'max_tokens') return { error: '出力が上限で途切れた（max_tokens）', status: 200 };
  const text = (json.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('').trim();
  return text === '' ? { error: '本文が空', status: 200 } : { text };
}

/** Claude に 1 回尋ねて本文を返す。キーが無い・失敗したときは null（理由は warn） */
export async function askClaude(o: AskOptions): Promise<string | null> {
  const apiKey = (o.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (apiKey === '') return null;
  const warn = o.warn ?? (() => {});
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await once(o, apiKey);
    if ('text' in r) return r.text;
    last = r.error;
    if (!retryable(r.status)) break;
    if (attempt === 0) {
      warn(`Claude API の呼び出しに失敗（${r.error}）。再試行します。`);
      await new Promise((resolve) => setTimeout(resolve, o.retryDelayMs ?? RETRY_DELAY_MS));
    }
  }
  warn(`Claude API の呼び出しに失敗しました（${last}）。`);
  return null;
}
