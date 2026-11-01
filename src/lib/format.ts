/**
 * 表示用の整形関数。欠損（null）は空文字にして、「不明」などの代替表示は出さない。
 * Astro のページ生成とテストの双方から使うため、Node 固有のAPIは使わない。
 */

/** ISO 8601 の日付・日時の先頭10文字（YYYY-MM-DD）。null・空文字は null */
export function ymd(iso: string | null): string | null {
  if (typeof iso !== 'string') return null;
  const head = iso.trim().slice(0, 10);
  return head === '' ? null : head;
}

/** "2026/11/01" の形に整える。null や YYYY-MM-DD で始まらない値は空文字 */
export function fmtDate(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd(iso) ?? '');
  return m ? `${m[1]}/${m[2]}/${m[3]}` : '';
}

/** "1,980円" の形に整える。3桁ごとの区切りは自前で付ける（実行環境の ICU に依存しない）。null は空文字 */
export function yen(n: number | null): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}円`;
}

/** "120分" の形に整える。null と0以下（収録時間として成り立たない値）は空文字 */
export function minutes(n: number | null): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.round(n) <= 0) return '';
  return `${Math.round(n)}分`;
}
