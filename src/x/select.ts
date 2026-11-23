/**
 * 投稿する作品の選定。乱数は使わず、同じ日（日本時間）・同じ履歴・同じカタログなら同じ結果になる。
 *  1. 直近 dedupDays 日に記録のある作品は除く。
 *  2. ラベル（既定: 新作・セール中・高評価・初見向け）を巡回して1件ずつ選ぶ。ラベルごとの並びは日付のハッシュ順。
 *     巡回の先頭は「日付のハッシュ + その日にすでに記録された件数」で決めるので、1回に1件ずつ投稿しても日の中でラベルが巡る。
 *  3. 直前の投稿と出演者・シリーズが重ならない作品を優先する（直前 = 同じ日の最後の記録、または今回直前に選んだもの）。
 *  4. ラベルの候補が尽きたら、残りの全作品からレビュー件数の多い順で補う。
 *  5. 重ならない作品がどこにも無いときだけ、重なりを許す（件数を満たすことを優先する）。
 */
import type { DerivedLabel } from '../data/types.ts';
import { hash } from '../lib/autotext.ts';
import type { Catalog, CatalogWork } from '../lib/catalog.ts';
import { jstDateKey } from './store.ts';
import type { PostStore } from './store.ts';

export const DEFAULT_MIX: readonly DerivedLabel[] = ['新作', 'セール中', '高評価', '初見向け'];
export const DEFAULT_DEDUP_DAYS = 30;

/** 選定が使う履歴の範囲（テストでは最小限の代用品を渡せる） */
export type SelectStore = Pick<PostStore, 'recentContentIds' | 'contentIdsOn'>;

export type SelectOptions = {
  /** 選ぶ件数。候補が足りなければ、それより少なく返す */
  count: number;
  /** 現在時刻。日付（日本時間）が並びのシードになり、重複排除の基準にもなる */
  now: Date;
  /** 重複を除く日数（既定 30） */
  dedupDays?: number;
  /** 巡回するラベル（既定 新作・セール中・高評価・初見向け） */
  mix?: readonly DerivedLabel[];
};

const cmpId = (a: CatalogWork, b: CatalogWork): number => (a.contentId < b.contentId ? -1 : a.contentId > b.contentId ? 1 : 0);

/** 出演者とシリーズの識別子（空の id は除く。出演者とシリーズの id が偶然同じでも別物として扱う） */
const refKeys = (w: CatalogWork): Set<string> =>
  new Set([...w.actresses.map((r) => (r.id ? `a:${r.id}` : '')), ...w.series.map((r) => (r.id ? `s:${r.id}` : ''))].filter((k) => k !== ''));
const related = (a: CatalogWork, b: CatalogWork): boolean => {
  const keys = refKeys(a);
  for (const k of refKeys(b)) if (keys.has(k)) return true;
  return false;
};

/** key の昇順（同じなら contentId 順）に並べ替えたコピー。鍵は1件ずつ先に計算する */
function sortedBy(list: readonly CatalogWork[], key: (w: CatalogWork) => number): CatalogWork[] {
  return list.map((w) => ({ w, k: key(w) })).sort((a, b) => a.k - b.k || cmpId(a.w, b.w)).map((x) => x.w);
}

export function selectWorks(catalog: Catalog, store: SelectStore, opts: SelectOptions): CatalogWork[] {
  const { count, now } = opts;
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`count には 0 以上の整数を指定してください: ${count}`);
  const mix = [...new Set(opts.mix ?? DEFAULT_MIX)];
  const day = jstDateKey(now);
  const excluded = store.recentContentIds(opts.dedupDays ?? DEFAULT_DEDUP_DAYS, now);
  const earlier = store.contentIdsOn(day);

  const eligible = (w: CatalogWork): boolean => !excluded.has(w.contentId);
  const pools = mix.map((label) => sortedBy(catalog.byLabel(label).filter(eligible), (w) => hash(`${day}|${label}|${w.contentId}`)));
  const fill = catalog.works.filter(eligible).sort((a, b) => b.reviewCount - a.reviewCount || cmpId(a, b));

  const picked: CatalogWork[] = [];
  const used = new Set<string>();
  let prev = earlier.length > 0 ? catalog.byId.get(earlier[earlier.length - 1]) : undefined;
  const start = mix.length > 0 ? (hash(day) + earlier.length) % mix.length : 0;

  while (picked.length < count) {
    const free = (w: CatalogWork): boolean => !used.has(w.contentId);
    const apart = (w: CatalogWork): boolean => free(w) && (prev === undefined || !related(prev, w));
    let next: CatalogWork | undefined;
    // 担当のラベルから順に、直前と重ならない最初の候補
    for (let k = 0; k < pools.length && !next; k++) next = pools[(start + picked.length + k) % pools.length].find(apart);
    next ??= fill.find(apart);
    // 重ならないものが無いときは、重なりを許す（ラベルの順、次に補充の順）
    for (let k = 0; k < pools.length && !next; k++) next = pools[(start + picked.length + k) % pools.length].find(free);
    next ??= fill.find(free);
    if (!next) break;
    picked.push(next);
    used.add(next.contentId);
    prev = next;
  }
  return picked;
}
