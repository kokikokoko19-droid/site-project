// FANZA（DMM Web Service）API v3 クライアント（docs/03_技術調査_FANZA_API.md の 1・4・5 節に準拠）。
// 方針:
// - 作品データは実行時に API から取得するだけで、ここでは保存しない（保存はキャッシュ設計に従う）。
// - URL（クエリに api_id / affiliate_id を含む）と、レスポンスの request キー（request.parameters に
//   API ID が平文で入る）は、例外メッセージにも出力にも含めない。このファイルはログ出力をしない。
// - 入力検証の違反は通信前に RangeError。メソッドは async なので、呼び出し側には reject として届く。

const DEFAULT_BASE_URL = 'https://api.dmm.com/affiliate/v3/';
const SORTS = ['rank', 'price', '-price', 'date', 'review', 'match'] as const;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const BACKOFF_BASE_MS = 1000; // 再試行の待ちは 1秒, 2秒, 4秒 … と倍々（上限 BACKOFF_MAX_MS）
const BACKOFF_MAX_MS = 30_000;
const TIMEOUT_MS = 30_000; // 1回の通信の上限。固まった接続で取得処理全体が止まらないようにする

type Scalar = string | number;
export type ParamValue = Scalar | readonly Scalar[] | null | undefined;
export type Params = Record<string, ParamValue>;
export type RawRecord = Record<string, unknown>;

export type ClientOptions = {
  apiId: string;
  affiliateId: string;
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  maxRetries?: number;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
};
export type ItemListParams = {
  site?: string;
  service?: string;
  floor?: string;
  hits?: number;
  offset?: number;
  sort?: (typeof SORTS)[number];
  article?: string | readonly string[];
  article_id?: Scalar | readonly Scalar[];
  gte_date?: string;
  lte_date?: string;
  cid?: string;
  keyword?: string;
};
export type SearchParams = { floor_id: Scalar; hits?: number; offset?: number; initial?: string };
export type ActressSearchParams = {
  hits?: number;
  offset?: number;
  initial?: string;
  actress_id?: Scalar;
  keyword?: string;
};
type Page = { status: number; resultCount: number; totalCount: number; firstPosition: number };
export type ItemListResult = Page & { items: RawRecord[] };
export type SearchResult = Page & { list: RawRecord[] };
export type FloorListResult = { status: number; sites: RawRecord[] };

// クエリ文字列を組み立てる。配列は key[0]=..&key[1]=.. の形式に展開し、undefined/null は除く。
// 注意: api_id の値をマスクしない内部用（テスト用）関数。戻り値をログや例外に出さないこと。
export function buildUrl(path: string, params: Params, baseUrl: string = DEFAULT_BASE_URL): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const k = encodeURIComponent(key);
    if (typeof value === 'object') {
      value.forEach((v, i) => pairs.push(`${k}[${i}]=${encodeURIComponent(String(v))}`));
    } else {
      pairs.push(`${k}=${encodeURIComponent(String(value))}`);
    }
  }
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return pairs.length > 0 ? `${base}${path}?${pairs.join('&')}` : `${base}${path}`;
}

function checkInt(name: string, v: number | undefined, min: number, max: number): void {
  if (v === undefined) return;
  if (!Number.isInteger(v) || v < min || v > max) {
    const range = Number.isFinite(max) ? `${min}〜${max}` : `${min} 以上`;
    throw new RangeError(`${name} は ${range} の整数で指定してください（指定値: ${String(v)}）`);
  }
}
function checkDate(name: string, v: string | undefined): void {
  if (v !== undefined && !DATE_RE.test(v)) {
    throw new RangeError(`${name} は YYYY-MM-DDTHH:MM:SS 形式で指定してください`);
  }
}
function floorIdOf(v: unknown): string {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  if (!/^\d+$/.test(s)) throw new RangeError('floor_id は FloorList の id（数字）を必須で指定してください');
  return s;
}

const isRecord = (v: unknown): v is RawRecord => typeof v === 'object' && v !== null && !Array.isArray(v);
// 型のゆらぎ（status は int / 文字列など）を数値へ正規化する。解釈できなければ fallback。
function toInt(v: unknown, fallback: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : fallback;
}
// 0件・範囲外は HTTP 200 で配列のキー自体が欠落し得るので、欠落時は空配列にする。
const rowsOf = (v: unknown): RawRecord[] => (Array.isArray(v) ? (v as RawRecord[]) : []);
function pageOf(result: RawRecord, rows: RawRecord[]): Page {
  return {
    status: toInt(result.status, 200),
    resultCount: toInt(result.result_count, rows.length),
    totalCount: toInt(result.total_count, 0),
    firstPosition: toInt(result.first_position, 0),
  };
}

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel(); // 使わない本文を破棄して接続を解放する
  } catch {
    // 破棄に失敗しても処理は続ける
  }
}

async function parseResult(res: Response, path: string): Promise<RawRecord> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`FANZA API: JSON の解析に失敗しました（${path}）`); // 元の例外は本文の断片を含み得るので捨てる
  }
  if (isRecord(body)) delete body.request; // request.parameters に API ID が平文で入る。以降へ渡さない
  const result = isRecord(body) ? body.result : undefined;
  if (!isRecord(result)) throw new Error(`FANZA API: 想定外のレスポンス形式です（${path}）`);
  const status = toInt(result.status, 200);
  if (status >= 400) throw Object.assign(new Error(`FANZA API: status ${status}（${path}）`), { status });
  return result;
}

export function createClient(opts: ClientOptions) {
  const { apiId, affiliateId } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const minIntervalMs = opts.minIntervalMs ?? 1000;
  const maxRetries = opts.maxRetries ?? 3;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!apiId || !affiliateId) throw new RangeError('apiId と affiliateId は必須です');
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    throw new RangeError('minIntervalMs は 0 以上の数値で指定してください');
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError('maxRetries は 0 以上の整数で指定してください');
  }
  try {
    new URL(baseUrl);
  } catch {
    throw new RangeError('baseUrl が URL として不正です');
  }

  // 最小間隔の確保。直前の通信の開始時刻からの差を測り、足りない分だけ待つ。
  // 待ち行列（gate）に並べるので、Promise.all などで同時に呼ばれても間隔を守る。
  let gate: Promise<void> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;
  function throttle(): Promise<void> {
    const turn = gate.then(async () => {
      const wait = lastStart + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
    });
    gate = turn.catch(() => {}); // sleep が失敗しても後続の呼び出しを詰まらせない
    return turn;
  }

  // 1回の API 呼び出し。429・5xx・通信例外は指数バックオフで最大 maxRetries 回再試行し、
  // それ以外の 4xx は再試行しない。エラー文言には URL もレスポンス本文も含めない。
  async function call(path: string, params: Params): Promise<RawRecord> {
    const url = buildUrl(path, { ...params, api_id: apiId, affiliate_id: affiliateId, output: 'json' }, baseUrl);
    for (let attempt = 0; ; attempt++) {
      await throttle();
      let res: Response | undefined;
      try {
        res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        res = undefined; // 通信例外の message / cause は URL（API ID 入り）を含み得るので捨てる
      }
      if (res?.ok) return await parseResult(res, path);
      const status = res?.status ?? 0;
      if (res) await drain(res);
      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable || attempt >= maxRetries) {
        const message = status === 0 ? `FANZA API: 通信に失敗しました（${path}）` : `FANZA API: HTTP ${status}（${path}）`;
        throw Object.assign(new Error(message), { status });
      }
      await sleep(Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt));
    }
  }

  // genre / maker / series の Search 共通。floor_id 必須、hits は 1〜500。
  async function search(path: string, key: string, p: SearchParams): Promise<SearchResult> {
    const floorId = floorIdOf(p?.floor_id);
    checkInt('hits', p.hits, 1, 500);
    checkInt('offset', p.offset, 1, Infinity); // offset の上限は ItemList のみ判明（50000）。他は下限だけ見る
    const result = await call(path, { floor_id: floorId, hits: p.hits, offset: p.offset, initial: p.initial });
    const list = rowsOf(result[key]);
    return { ...pageOf(result, list), list };
  }

  return {
    async itemList(p: ItemListParams = {}): Promise<ItemListResult> {
      checkInt('hits', p.hits, 1, 100);
      checkInt('offset', p.offset, 1, 50000);
      if (p.sort !== undefined && !SORTS.includes(p.sort)) {
        throw new RangeError(`sort は ${SORTS.join('|')} のいずれかを指定してください`);
      }
      checkDate('gte_date', p.gte_date);
      checkDate('lte_date', p.lte_date);
      const result = await call('ItemList', {
        site: p.site ?? 'FANZA',
        service: p.service ?? 'digital',
        floor: p.floor ?? 'videoa',
        hits: p.hits,
        offset: p.offset,
        sort: p.sort,
        article: p.article,
        article_id: p.article_id,
        gte_date: p.gte_date,
        lte_date: p.lte_date,
        cid: p.cid,
        keyword: p.keyword,
      });
      const items = rowsOf(result.items);
      return { ...pageOf(result, items), items };
    },
    async floorList(): Promise<FloorListResult> {
      const result = await call('FloorList', {});
      return { status: toInt(result.status, 200), sites: rowsOf(result.site) };
    },
    genreSearch: (p: SearchParams) => search('GenreSearch', 'genre', p),
    makerSearch: (p: SearchParams) => search('MakerSearch', 'maker', p),
    seriesSearch: (p: SearchParams) => search('SeriesSearch', 'series', p),
    async actressSearch(p: ActressSearchParams = {}): Promise<SearchResult> {
      checkInt('hits', p.hits, 1, 100);
      checkInt('offset', p.offset, 1, Infinity);
      const result = await call('ActressSearch', {
        hits: p.hits,
        offset: p.offset,
        initial: p.initial,
        actress_id: p.actress_id,
        keyword: p.keyword,
      });
      const list = rowsOf(result.actress);
      return { ...pageOf(result, list), list };
    },
  };
}
export type Client = ReturnType<typeof createClient>;
