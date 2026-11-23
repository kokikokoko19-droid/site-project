/**
 * OAuth 1.0a（RFC 5849）の署名。X API v2 の User Context 認証（HMAC-SHA1）で使う。
 * Node 組み込みの node:crypto だけで実装する。nonce と timestamp は注入でき、テストで署名を再現できる。
 * 認証情報は戻り値の Authorization ヘッダーの形でしか外に出ない（署名のみで、秘密そのものは含まない）。
 */
import { createHmac, randomBytes } from 'node:crypto';

/** 名前と値の組（パラメータ）。値はエンコード前の文字列 */
export type Param = readonly [name: string, value: string];

/**
 * RFC 5849 3.6 のパーセントエンコード。非予約文字（英数字と - . _ ~）以外をすべて UTF-8 の %XX（大文字16進）にする。
 * encodeURIComponent は ! ' ( ) * を残すため、ここで追加でエンコードする。
 */
export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 名前、次に値の順（エンコード後の文字列を、バイト順に相当する UTF-16 コード単位順で）に並べる比較関数 */
function compareParams(a: Param, b: Param): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

/**
 * RFC 5849 3.4.1.3.2 のパラメータの正規化。名前と値をそれぞれエンコードし、名前→値の順に並べて
 * 「名前=値」を & でつなぐ。同じ名前が複数あれば値の順に並ぶ。
 */
export function normalizeParams(params: readonly Param[]): string {
  return params
    .map(([k, v]): Param => [percentEncode(k), percentEncode(v)])
    .sort(compareParams)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * URL を「署名に使うベース URI」と「クエリのパラメータ」に分ける（RFC 5849 3.4.1.2・3.4.1.3.1）。
 * スキームとホストは小文字、既定ポート（http の 80、https の 443）は除く（WHATWG URL の正規化に任せる）。
 * クエリは application/x-www-form-urlencoded として復号する。フラグメントは含めない。
 */
function splitUrl(url: string): { base: string; query: Param[] } {
  const u = new URL(url);
  return { base: `${u.protocol}//${u.host}${u.pathname}`, query: [...u.searchParams.entries()] };
}

/**
 * 署名ベース文字列（RFC 5849 3.4.1）。HTTP メソッド（大文字）・ベース URI・正規化したパラメータを
 * それぞれエンコードして & でつなぐ。params には oauth_* と本文のパラメータを渡す（URL のクエリは自動で加える）。
 * oauth_signature は署名の対象外なので、渡されても除く。
 */
export function signatureBaseString(method: string, url: string, params: readonly Param[]): string {
  const { base, query } = splitUrl(url);
  const all = [...query, ...params.filter(([k]) => k !== 'oauth_signature')];
  return [method.toUpperCase(), percentEncode(base), percentEncode(normalizeParams(all))].join('&');
}

/** HMAC-SHA1 の署名（RFC 5849 3.4.2）。鍵は「コンシューマーシークレット&トークンシークレット」（それぞれエンコード）。base64 で返す */
export function hmacSha1Signature(baseString: string, consumerSecret: string, tokenSecret: string): string {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac('sha1', key).update(baseString).digest('base64');
}

export type OAuthInput = {
  /** HTTP メソッド（POST など） */
  method: string;
  /** リクエスト先の URL。クエリがあれば署名に含める */
  url: string;
  consumerKey: string;
  consumerSecret: string;
  /** アクセストークン */
  token: string;
  tokenSecret: string;
  /** 省略すると乱数（128 ビットの16進文字列）。再試行のたびに別の値にすること（使い回しはリプレイ扱いになる） */
  nonce?: string;
  /** 秒単位の UNIX 時刻。省略すると現在時刻 */
  timestamp?: string | number;
  /** 署名に含める本文のパラメータ。本文が application/x-www-form-urlencoded のときだけ渡す（JSON 本文は含めない） */
  bodyParams?: readonly Param[];
};

/**
 * Authorization ヘッダーの値（`OAuth oauth_consumer_key="…", …`）を作る。
 * パラメータは名前の昇順、値はすべてパーセントエンコードする。
 */
export function buildAuthorizationHeader(input: OAuthInput): string {
  const oauth: Param[] = [
    ['oauth_consumer_key', input.consumerKey],
    ['oauth_nonce', input.nonce ?? randomBytes(16).toString('hex')],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', String(input.timestamp ?? Math.floor(Date.now() / 1000))],
    ['oauth_token', input.token],
    ['oauth_version', '1.0'],
  ];
  const base = signatureBaseString(input.method, input.url, [...oauth, ...(input.bodyParams ?? [])]);
  const signature = hmacSha1Signature(base, input.consumerSecret, input.tokenSecret);
  const fields = [...oauth, ['oauth_signature', signature] as const].sort(compareParams);
  return `OAuth ${fields.map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`).join(', ')}`;
}
