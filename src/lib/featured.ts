/**
 * トップの目玉（components/FeatureCarousel.astro）に並べる作品を選ぶ。
 * 運営者が config/featured.json に content ID を指定し、足りない枠は「高評価」ラベルの作品で補う。
 * 補った作品は自動選定なので、眉見出しを「運営者が選ぶ」にしない（第三者レビュー B-7）。
 */
import type { Catalog, CatalogWork } from './catalog.ts';

export type FeaturedConfig = { items?: { id?: unknown; comment?: unknown }[] };
export type FeaturedItem = {
  work: CatalogWork;
  /** pick: 運営者の指定／auto: 「高評価」で補ったもの */
  source: 'pick' | 'auto';
  /** 運営者の一言（指定があるときだけ） */
  comment: string | null;
};

export const FEATURED_MIN = 3;
export const FEATURED_MAX = 5;

/**
 * 運営者の指定（存在しない ID・重複は飛ばす）を先に、残りを「高評価」の作品で埋めて最大 max 件にする。
 * 高評価が足りないときは新着で埋め、それでも min に届かなければある分だけ返す。
 */
export function pickFeatured(catalog: Catalog, config: FeaturedConfig | null | undefined, max = FEATURED_MAX): FeaturedItem[] {
  const out: FeaturedItem[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(config?.items) ? config.items : []) {
    if (out.length >= max) break;
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const w = id ? catalog.byId.get(id) : undefined;
    if (!w || seen.has(id)) continue;
    seen.add(id);
    const comment = typeof item.comment === 'string' && item.comment.trim() !== '' ? item.comment.trim() : null;
    out.push({ work: w, source: 'pick', comment });
  }
  for (const w of [...catalog.byLabel('高評価'), ...catalog.recent(max * 2)]) {
    if (out.length >= max) break;
    if (seen.has(w.contentId)) continue;
    seen.add(w.contentId);
    out.push({ work: w, source: 'auto', comment: null });
  }
  return out;
}
