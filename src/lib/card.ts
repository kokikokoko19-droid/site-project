/**
 * カタログの作品（CatalogWork）を、作品カード（components/WorkCard.astro）の表示形に直す。
 * 一覧・トップ・作品ページ・出演者ページで同じ対応を使うためにここへまとめた。
 * 文言は自動文（データ駆動テンプレ）だけ。公式の紹介文やレビュー本文は使わない。
 */
import type { CatalogWork } from './catalog.ts';
import { cardText } from './autotext.ts';

export interface CardWork {
  id: string;
  title: string;
  imageSmall: string | null;
  actresses: string[];
  maker: string | null;
  cardText: string | null;
  labels: string[];
  reviewAvg: number | null;
  reviewCount: number;
  /** セール中のとき、いまの価格と定価（値札用）。セールでなければ null */
  sale: { price: number; list: number } | null;
}

export function toCard(w: CatalogWork): CardWork {
  const onSale =
    w.derivedLabels.includes('セール中') && w.listPrice !== null && w.priceMin !== null && w.listPrice > w.priceMin;
  return {
    id: w.contentId,
    title: w.title,
    imageSmall: w.imageSmall,
    actresses: w.actresses.map((a) => a.name),
    maker: w.makers[0]?.name ?? null,
    cardText: cardText(w),
    labels: w.derivedLabels,
    reviewAvg: typeof w.reviewAvg === 'number' && Number.isFinite(w.reviewAvg) ? w.reviewAvg : null,
    reviewCount: w.reviewCount ?? 0,
    sale: onSale ? { price: w.priceMin as number, list: w.listPrice as number } : null,
  };
}
