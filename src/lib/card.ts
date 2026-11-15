/**
 * カタログの作品（CatalogWork）を、作品カード（components/WorkCard.astro）の表示形に直す。
 * 一覧・トップ・作品ページ・出演者ページで同じ対応を使うためにここへまとめた。
 * 文言は自動文（データ駆動テンプレ）だけ。公式の紹介文やレビュー本文は使わない。
 */
import type { DerivedLabel } from '../data/types.ts';
import type { CatalogWork } from './catalog.ts';
import { cardText } from './autotext.ts';
import { discountRate, monthDay } from './format.ts';

export interface CardWork {
  id: string;
  title: string;
  imageSmall: string | null;
  actresses: string[];
  maker: string | null;
  cardText: string | null;
  /** カードに出すラベル（優先順に並べ、最大2つ。「〜追い向け」は含めない） */
  labels: DerivedLabel[];
  reviewAvg: number | null;
  reviewCount: number;
  /** セール中のとき、いまの価格・定価・割引率（%）・終了日（"12/4"。無ければ ''）。セールでなければ null */
  sale: { price: number; list: number; off: number | null; end: string } | null;
}

/** カードのラベルの優先順（第三者レビュー A I6: セール中＞高評価＞新作）。ここに無いラベルはカードに出さない */
export const CARD_LABEL_ORDER: DerivedLabel[] = ['セール中', '高評価', '新作', '初見向け', '定番', '長尺', '短尺'];
export const MAX_CARD_LABELS = 2;

/** カード用のラベル。優先順に並べて先頭 max 件。omit のラベルは除く（例: セール一覧では「セール中」を省く） */
export function cardLabels(labels: readonly DerivedLabel[], omit: readonly DerivedLabel[] = [], max = MAX_CARD_LABELS): DerivedLabel[] {
  return CARD_LABEL_ORDER.filter((l) => labels.includes(l) && !omit.includes(l)).slice(0, max);
}

/** 今日を含めて続いているキャンペーンのうち、いちばん早く終わるものの終了日（"12/4"）。無ければ '' */
export function saleEnd(w: CatalogWork, now: Date = new Date()): string {
  // 日付は日本時間で比べる（API の日時は日本時間）
  const today = new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  let best = '';
  for (const c of w.campaigns ?? []) {
    const end = typeof c?.end === 'string' ? c.end.slice(0, 10) : '';
    const begin = typeof c?.begin === 'string' ? c.begin.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || end < today) continue;
    if (begin && begin > today) continue;
    if (best === '' || end < best) best = end;
  }
  return best ? monthDay(best) : '';
}

export function toCard(w: CatalogWork, opts: { omitLabels?: DerivedLabel[] } = {}): CardWork {
  const onSale =
    w.derivedLabels.includes('セール中') && w.listPrice !== null && w.priceMin !== null && w.listPrice > w.priceMin;
  return {
    id: w.contentId,
    title: w.title,
    imageSmall: w.imageSmall,
    actresses: w.actresses.map((a) => a.name),
    maker: w.makers[0]?.name ?? null,
    cardText: cardText(w),
    labels: cardLabels(w.derivedLabels, opts.omitLabels),
    reviewAvg: typeof w.reviewAvg === 'number' && Number.isFinite(w.reviewAvg) ? w.reviewAvg : null,
    reviewCount: w.reviewCount ?? 0,
    sale: onSale
      ? { price: w.priceMin as number, list: w.listPrice as number, off: discountRate(w.priceMin, w.listPrice), end: saleEnd(w) }
      : null,
  };
}
