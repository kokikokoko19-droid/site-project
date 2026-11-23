/**
 * 出演者ページの自動文（データ駆動テンプレ）。作品数・配信日・評価・シリーズ・共演を数値と名前で並べるだけで、描写は加えない。
 * 欠けた項目は句ごと省き、空欄や「不明」は出さない。
 */
import type { ActressProfile } from './catalog.ts';
import type { ActressStat } from './actress-stats.ts';
import { fmtDate } from './format.ts';

const clean = (s: string | null | undefined): string => (s ?? '').trim();
const avgText = (n: number): string => n.toFixed(2);

/** 名前を「A、B、C」とつなぐ */
const join = (xs: string[]): string => xs.join('、');

/** 導入文（2〜3文） */
export function actressIntro(profile: ActressProfile | null, stats: ActressStat): string {
  const name = clean(profile?.name) || stats.name;
  const sentences: string[] = [];

  // 1文目: 作品数と直近の配信
  const latest = fmtDate(stats.latest);
  sentences.push(
    latest
      ? `${name}の出演作品は、当サイトで${stats.works}件を掲載しています。直近の配信開始日は${latest}です。`
      : `${name}の出演作品は、当サイトで${stats.works}件を掲載しています。`,
  );

  // 2文目: 評価（レビューがあるときだけ）
  if (stats.reviewAvg !== null && stats.reviewTotal > 0) {
    sentences.push(`レビューは合計${stats.reviewTotal}件で、平均評価は${avgText(stats.reviewAvg)}です。`);
  }

  // 3文目: 主なシリーズと共演（あるものだけ）
  const parts: string[] = [];
  const series = stats.series.slice(0, 3);
  if (series.length > 0) parts.push(`主なシリーズは${join(series.map((s) => `${s.name}（${s.count}件）`))}`);
  const co = stats.coStars.slice(0, 3);
  if (co.length > 0) parts.push(`共演の多い出演者は${join(co.map((c) => `${c.name}（${c.count}件）`))}`);
  if (parts.length > 0) sentences.push(`${parts.join('、')}です。`);

  return sentences.join('');
}

/** まとめ用の文（1〜2文） */
export function actressSummary(profile: ActressProfile | null, stats: ActressStat): string {
  const name = clean(profile?.name) || stats.name;
  const out: string[] = [];
  if (stats.reviewAvg !== null && stats.reviewTotal > 0) {
    out.push(`${name}の出演${stats.works}作品は、レビュー${stats.reviewTotal}件の平均が${avgText(stats.reviewAvg)}、レビュー件数を考慮したベイズ平均で${avgText(stats.bayes)}です。`);
  } else {
    out.push(`${name}の出演作品は${stats.works}件で、まだレビューは集まっていません。`);
  }
  const tail: string[] = [];
  if (stats.onSale > 0) tail.push(`現在セール中の作品が${stats.onSale}件あります`);
  if (stats.series[0]) tail.push(`${stats.series[0].name}が${stats.series[0].count}件と最も多いシリーズです`);
  if (tail.length > 0) out.push(`${tail.join('。')}。`);
  return out.join('');
}
