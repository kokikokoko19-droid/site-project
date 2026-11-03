/**
 * 出演者ごとの集計（作品数・レビュー・直近の配信・共演・シリーズ）。
 * ベイズ平均は事前の重みを 20 件分とし、事前平均はカタログ全体のレビュー加重平均を使う。
 */
import type { Catalog, CatalogWork } from './catalog.ts';

export const PRIOR_WEIGHT = 20;

type Ref = { id: string; name: string; count: number };

export type ActressStat = {
  id: string;
  name: string;
  works: number;
  reviewTotal: number;
  reviewAvg: number | null;
  bayes: number;
  latest: string | null;
  onSale: number;
  coStars: Ref[];
  series: Ref[];
};

/** カタログ全体のレビュー加重平均。レビューが1件も無ければ 0 */
export function globalMeanAvg(catalog: Catalog): number {
  let sum = 0, n = 0;
  for (const w of catalog.works) {
    if (w.reviewAvg !== null && w.reviewCount > 0) { sum += w.reviewAvg * w.reviewCount; n += w.reviewCount; }
  }
  return n > 0 ? sum / n : 0;
}

/** ベイズ平均。avg が null（レビューなし）のときは事前平均そのもの */
export function bayesAvg(avg: number | null, count: number, meanAvg: number): number {
  if (avg === null || count <= 0) return meanAvg;
  return (avg * count + meanAvg * PRIOR_WEIGHT) / (count + PRIOR_WEIGHT);
}

/** 作品単位のベイズ平均（おすすめ作品の並べ替えに使う） */
export function workBayes(w: CatalogWork, meanAvg: number): number {
  return bayesAvg(w.reviewAvg, w.reviewCount, meanAvg);
}

/** list の作品に付く参照を、件数の多い順に上位 n 件。同数は先に現れた順。exclude は除く */
function countRefs(list: CatalogWork[], pick: (w: CatalogWork) => { id: string; name: string }[], exclude?: string): Ref[] {
  const m = new Map<string, Ref>();
  for (const w of list) {
    const seen = new Set<string>();
    for (const r of pick(w)) {
      if (!r.id || r.id === exclude || seen.has(r.id)) continue;
      seen.add(r.id);
      const hit = m.get(r.id);
      if (hit) hit.count++; else m.set(r.id, { id: r.id, name: r.name, count: 1 });
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/** 全出演者の集計 */
export function actressStats(catalog: Catalog): Map<string, ActressStat> {
  const meanAvg = globalMeanAvg(catalog);
  const out = new Map<string, ActressStat>();
  for (const [id, works] of catalog.byActress) {
    let sum = 0, reviewTotal = 0, onSale = 0;
    let latest: string | null = null;
    for (const w of works) {
      if (w.reviewAvg !== null && w.reviewCount > 0) { sum += w.reviewAvg * w.reviewCount; reviewTotal += w.reviewCount; }
      if (w.derivedLabels.includes('セール中')) onSale++;
      const d = typeof w.releasedAt === 'string' ? w.releasedAt.slice(0, 10) : '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (latest === null || d > latest)) latest = d;
    }
    const reviewAvg = reviewTotal > 0 ? sum / reviewTotal : null;
    out.set(id, {
      id,
      name: catalog.refNames.actress.get(id) ?? id,
      works: works.length,
      reviewTotal,
      reviewAvg,
      bayes: bayesAvg(reviewAvg, reviewTotal, meanAvg),
      latest,
      onSale,
      coStars: countRefs(works, (w) => w.actresses, id),
      series: countRefs(works, (w) => w.series),
    });
  }
  return out;
}

/** ベイズ平均の降順。作品数が minWorks 未満は除く。同点は作品数の多い順 */
export function rankActresses(stats: Map<string, ActressStat>, opts: { minWorks?: number } = {}): ActressStat[] {
  const { minWorks = 3 } = opts;
  return [...stats.values()]
    .filter((s) => s.works >= minWorks)
    .sort((a, b) => b.bayes - a.bayes || b.works - a.works);
}
