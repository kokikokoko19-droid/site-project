/**
 * FANZA（DMM Web Service）ItemList の生レスポンスを Work 型へ正規化する（docs/03 の2章に対応）。
 *
 * - 型ゆらぎ（数値の文字列化、時刻形式の違い、キー欠落）はここで吸収する。
 * - comment・URLsp・affiliateURLsp・女優の画像など、Work 型に無い項目は読み捨てる（保存しない）。
 * - content_id が無い項目は作品キーが決まらないので例外を投げる。
 */
import type { Campaign, Delivery, NamedRef, SampleMovie, Work } from './types.ts';

export type NormalizeOptions = { fetchedAt: string };

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 文字列（前後の空白は除く）または有限の数値を文字列にして返す。空や他の型は null */
function toStr(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

/** 数値、または "500~"・"1,980" のような文字列から先頭の数値を取り出す。取れなければ null */
function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** 配列で返るはずの項目から、オブジェクトの要素だけを取り出す（単一オブジェクトは1要素扱い、欠落は空配列） */
function toObjects(v: unknown): any[] {
  const arr = Array.isArray(v) ? v : v !== null && typeof v === 'object' ? [v] : [];
  return arr.filter((e) => e !== null && typeof e === 'object');
}

/** 文字列の配列を取り出す（単一の文字列は1要素扱い、空の要素は除く） */
/** DMM 配信ホストの http URL を https に揃える（公式リファレンスの例は http。ページは https なので混在コンテンツを避ける） */
function toHttpsUrl(v: unknown): string | null {
  const s = toStr(v);
  if (s === null) return null;
  return s.replace(/^http:\/\/((?:[a-z0-9-]+\.)*dmm\.(?:co\.jp|com))\//i, 'https://$1/');
}

function toStrings(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return arr.map((e) => toStr(e)).filter((s): s is string => s !== null);
}

/**
 * volume を分（整数）にする。"120"（分）と "1:29:00"（時:分:秒）の両方を受ける。
 * 秒は四捨五入。コロンが2つの形式以外は、先頭の数値を分とみなす（仕様外の仮定）。
 */
function toVolumeMin(v: unknown): number | null {
  const s = toStr(v);
  if (s === null) return null;
  const hms = s.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (hms) return Math.round((Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3])) / 60);
  const n = toNum(s);
  return n === null ? null : Math.round(n);
}

/**
 * "YYYY-MM-DD HH:MM:SS" / "YYYY/M/D H:MM" を "YYYY-MM-DDTHH:MM:SS"（タイムゾーンなし）にする。
 * 時刻が無ければ 00:00:00 を補う。解釈できない・実在しない日時は null。
 */
function toIsoDateTime(v: unknown): string | null {
  const s = toStr(v);
  const m = s?.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const n = (x: string | undefined): number => Number(x ?? '0');
  const [y, mo, d, h, mi, sec] = [n(m[1]), n(m[2]), n(m[3]), n(m[4]), n(m[5]), n(m[6])] as const;
  const day = new Date(Date.UTC(y, mo - 1, d));
  const valid = day.getUTCMonth() === mo - 1 && day.getUTCDate() === d && h <= 23 && mi <= 59 && sec <= 59;
  return valid ? `${String(y).padStart(4, '0')}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}:${pad2(sec)}` : null;
}

/** iteminfo の [{id, name, ruby?}] を NamedRef[] にする。id は文字列化、ruby があれば保持、他のキーは捨てる */
function toRefs(v: unknown): NamedRef[] {
  const refs: NamedRef[] = [];
  for (const e of toObjects(v)) {
    const id = toStr(e.id);
    const name = toStr(e.name);
    if (id === null || name === null) continue;
    const ruby = toStr(e.ruby);
    refs.push(ruby === null ? { id, name } : { id, name, ruby });
  }
  return refs;
}

function toDelivery(d: any): Delivery {
  return { type: toStr(d.type) ?? '', price: toNum(d.price), listPrice: toNum(d.list_price) };
}

function toCampaign(c: any): Campaign {
  return { title: toStr(c.title) ?? '', begin: toIsoDateTime(c.date_begin), end: toIsoDateTime(c.date_end) };
}

/** size_* のURLだけを sizes に集める。URLが1つも無ければ（公式プレーヤーを出せないので）null */
function toSampleMovie(v: any): SampleMovie | null {
  if (v === null || typeof v !== 'object') return null;
  const sizes: Record<string, string> = {};
  for (const [key, val] of Object.entries(v)) {
    const url = toHttpsUrl(val);
    if (key.startsWith('size_') && url !== null) sizes[key] = url;
  }
  if (Object.keys(sizes).length === 0) return null;
  return { sizes, pcFlag: toNum(v.pc_flag), spFlag: toNum(v.sp_flag) };
}

/** 生の item 1件を Work にする。content_id が無ければ例外 */
export function normalizeItem(raw: any, opts: NormalizeOptions): Work {
  if (raw === null || typeof raw !== 'object') throw new Error('作品データがオブジェクトではありません');
  const contentId = toStr(raw.content_id);
  if (contentId === null) throw new Error('content_id がありません');

  const reviewCount = Math.max(0, Math.trunc(toNum(raw.review?.count) ?? 0));
  const prices = raw.prices;
  const info = raw.iteminfo;
  const large = toStrings(raw.sampleImageURL?.sample_l?.image);

  return {
    contentId,
    productId: toStr(raw.product_id),
    title: toStr(raw.title) ?? '',
    url: toStr(raw.URL),
    affiliateUrl: toStr(raw.affiliateURL),
    volumeMin: toVolumeMin(raw.volume),
    releasedAt: toIsoDateTime(raw.date),
    reviewCount,
    // レビュー0件の平均は意味を持たないので null（review 欠落と同じ扱い）
    reviewAvg: reviewCount > 0 ? toNum(raw.review?.average) : null,
    priceMin: toNum(prices?.price),
    listPrice: toNum(prices?.list_price),
    deliveries: toObjects(prices?.deliveries?.delivery).map((d) => toDelivery(d)),
    imageList: toHttpsUrl(raw.imageURL?.list),
    imageSmall: toHttpsUrl(raw.imageURL?.small),
    imageLarge: toHttpsUrl(raw.imageURL?.large),
    sampleImages: (large.length > 0 ? large : toStrings(raw.sampleImageURL?.sample_s?.image)).map((u) => toHttpsUrl(u) ?? u),
    sampleMovie: toSampleMovie(raw.sampleMovieURL),
    campaigns: toObjects(raw.campaign ?? raw.cdinfo?.campaign).map((c) => toCampaign(c)), // 公式表の階層が判読不可のため cdinfo 配下も見る
    genres: toRefs(info?.genre),
    actresses: toRefs(info?.actress),
    series: toRefs(info?.series),
    makers: toRefs(info?.maker),
    labels: toRefs(info?.label),
    directors: toRefs(info?.director),
    rankPosition: null,
    fetchedAt: opts.fetchedAt,
    status: 'active',
  };
}

/** item の配列を Work の配列にする。1件でも不正なら、何番目かを付けて例外を投げる */
export function normalizeItems(rawItems: any[], opts: NormalizeOptions): Work[] {
  return rawItems.map((raw, i) => {
    try {
      return normalizeItem(raw, opts);
    } catch (e) {
      throw new Error(`items[${i}]: ${(e as Error).message}`);
    }
  });
}
