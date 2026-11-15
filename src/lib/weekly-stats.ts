/**
 * 週次の事実の集計（「運営者から」の下書きの材料）。カタログ（data/export の works.json・meta.json・index.json）から数えるだけで、
 * 題名・ジャンル名は扱わない。名前を出すのは出演者・シリーズ・メーカーの上位だけ。
 * 日付は日本時間の暦日で数える。純粋関数（ファイルは読まない）。
 */
import type { Catalog, CatalogWork } from './catalog.ts';

const DAY = 86_400_000;
const JST = 9 * 3_600_000;

/** 新着とみなす日数（配信開始日から今日まで） */
export const NEW_DAYS = 7;
/** 「レビューが多い」とみなす件数（これを超えたものを数える） */
export const REVIEW_OVER = 20;
/** 「評価の高い新着」の条件（平均がこれ以上で、件数がこれ以上） */
export const HIGH_NEW_AVG = 4.0;
export const HIGH_NEW_MIN_REVIEWS = 3;
/** 上位に出す名前の数 */
export const TOP_N = 3;

export type TopRef = { name: string; count: number };

export type WeeklyStats = {
  /** 集計の基準日（日本時間 YYYY-MM-DD） */
  asOf: string;
  /** 公開作品の総数 */
  total: number;
  /** 新着（配信開始から 7 日以内）の件数 */
  newCount: number;
  /** セール中の件数 */
  saleCount: number;
  /** セール中の作品の割引率（%）の中央値。割引が読み取れる作品が無ければ null */
  saleDiscountMedian: number | null;
  /** レビューが 20 件を超えた作品数 */
  reviewOver20: number;
  /** 評価の高い新着の件数 */
  highRatedNew: number;
  topActresses: TopRef[];
  topSeries: TopRef[];
  topMakers: TopRef[];
  /** データの更新日時（ISO 8601。分からなければ null） */
  updatedAt: string | null;
};

/** 日本時間の暦日（YYYY-MM-DD） */
export function jstDate(d: Date): string {
  return new Date(d.getTime() + JST).toISOString().slice(0, 10);
}

/** YYYY-MM-DD を UTC の 0 時のミリ秒にする（日数の差を取るための物差し） */
function dayNumber(key: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY : null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 値が最も多い順に上位 n 件（同数は名前順）。名前が空の参照は数えない */
function top(index: Map<string, CatalogWork[]>, names: Map<string, string>, n: number): TopRef[] {
  const out: TopRef[] = [];
  for (const [id, list] of index) {
    const name = (names.get(id) ?? '').trim();
    if (name !== '' && list.length > 0) out.push({ name, count: list.length });
  }
  return out.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, n);
}

/** 割引率（%）。定価が現在価格より高いときだけ読み取れる */
function discountPercent(w: CatalogWork): number | null {
  if (w.priceMin === null || w.listPrice === null || w.priceMin <= 0 || w.listPrice <= w.priceMin) return null;
  return (1 - w.priceMin / w.listPrice) * 100;
}

export function computeWeeklyStats(catalog: Catalog, now: Date): WeeklyStats {
  const asOf = jstDate(now);
  const today = dayNumber(asOf) as number;
  let newCount = 0, highRatedNew = 0, reviewOver20 = 0;
  for (const w of catalog.works) {
    if (w.reviewCount > REVIEW_OVER) reviewOver20++;
    const day = w.releasedAt ? dayNumber(w.releasedAt) : null;
    if (day !== null && today - day >= 0 && today - day <= NEW_DAYS) {
      newCount++;
      if (w.reviewAvg !== null && w.reviewAvg >= HIGH_NEW_AVG && w.reviewCount >= HIGH_NEW_MIN_REVIEWS) highRatedNew++;
    }
  }
  const sale = catalog.onSale();
  const med = median(sale.map(discountPercent).filter((x): x is number => x !== null));
  return {
    asOf,
    total: catalog.works.length,
    newCount,
    saleCount: sale.length,
    saleDiscountMedian: med === null ? null : Math.round(med),
    reviewOver20,
    highRatedNew,
    topActresses: top(catalog.byActress, catalog.refNames.actress, TOP_N),
    topSeries: top(catalog.bySeries, catalog.refNames.series, TOP_N),
    topMakers: top(catalog.byMaker, catalog.refNames.maker, TOP_N),
    updatedAt: catalog.meta.lastIngestAt ?? catalog.meta.generatedAt,
  };
}

/** データ更新日の表示（「11月15日」。日本時間）。分からなければ null */
export function updatedLabel(stats: WeeklyStats): string | null {
  if (!stats.updatedAt) return null;
  const ms = Date.parse(stats.updatedAt);
  if (Number.isNaN(ms)) return null;
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(jstDate(new Date(ms)));
  return m ? `${Number(m[1])}月${Number(m[2])}日` : null;
}

const refsText = (xs: TopRef[]): string => xs.map((x) => `${x.name}（${x.count}作品）`).join('、');

/**
 * LLM に渡す「事実の一覧」。数字はカンマなしで書く。検査で許す数字は、この文面に出てくる数字だけ。
 * 値が無い項目は行ごと省く（「不明」「null」は出さない）。
 */
export function factsText(stats: WeeklyStats): string {
  const lines = [
    `公開作品の総数: ${stats.total}`,
    `新着（配信開始から${NEW_DAYS}日以内）の件数: ${stats.newCount}`,
  ];
  if (stats.saleCount > 0) {
    lines.push(`セール中の件数: ${stats.saleCount}`);
    if (stats.saleDiscountMedian !== null) lines.push(`セール中の割引率の中央値（%）: ${stats.saleDiscountMedian}`);
  }
  if (stats.reviewOver20 > 0) lines.push(`レビューが${REVIEW_OVER}件を超えた作品の数: ${stats.reviewOver20}`);
  if (stats.highRatedNew > 0) lines.push(`評価の高い新着（平均${HIGH_NEW_AVG}以上）の件数: ${stats.highRatedNew}`);
  if (stats.topActresses.length > 0) lines.push(`作品数の多い出演者: ${refsText(stats.topActresses)}`);
  if (stats.topSeries.length > 0) lines.push(`作品数の多いシリーズ: ${refsText(stats.topSeries)}`);
  if (stats.topMakers.length > 0) lines.push(`作品数の多いメーカー: ${refsText(stats.topMakers)}`);
  const label = updatedLabel(stats);
  if (label) lines.push(`データの更新日: ${label}`);
  return lines.join('\n');
}
