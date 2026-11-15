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

/** "12/4" の形（月/日、先頭の0なし）。null や YYYY-MM-DD で始まらない値は空文字 */
export function monthDay(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd(iso) ?? '');
  return m ? `${Number(m[2])}/${Number(m[3])}` : '';
}

/** 割引率（%、整数に丸める）。定価が現在価格より高いときだけ数を返し、それ以外は null */
export function discountRate(price: number | null, list: number | null): number | null {
  if (typeof price !== 'number' || typeof list !== 'number' || !Number.isFinite(price) || !Number.isFinite(list)) return null;
  if (list <= 0 || price < 0 || price >= list) return null;
  const r = Math.round((1 - price / list) * 100);
  return r > 0 ? r : null;
}

/**
 * サンプル画像の大きい版 URL（…/{cid}/{cid}jp-N.jpg）から、小さい版 URL（…/{cid}/{cid}-N.jpg）を組み立てる。
 * どちらも公式配信の同じ画像の別サイズで、こちらで画像を加工するわけではない。
 * 形が合わない URL（すでに小さい版のものを含む）は null を返す（呼び出し側は元の URL をそのまま使う）。
 */
export function sampleSmallUrl(large: string): string | null {
  if (typeof large !== 'string') return null;
  const m = /^(https?:\/\/[^?#]*\/)([^/?#]+)jp-(\d+)\.jpg$/.exec(large.trim());
  return m ? `${m[1]}${m[2]}-${m[3]}.jpg` : null;
}

/** 五十音の行（出演者一覧の行タブ）。並びはこの配列の順 */
export const KANA_ROWS = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ'] as const;
const ROW_CHARS = ['あいうえおぁぃぅぇぉゔ', 'かきくけこゕゖ', 'さしすせそ', 'たちつてとっ', 'なにぬねの', 'はひふへほ', 'まみむめも', 'やゆよゃゅょ', 'らりるれろ', 'わゐゑをんゎ'];

/** 読み（ふりがな。無ければ名前）の先頭の文字から、五十音の行を返す。かなで始まらないときは null */
export function kanaRow(reading: string | null | undefined): (typeof KANA_ROWS)[number] | null {
  const head = [...(reading ?? '').trim()][0];
  if (!head) return null;
  // カタカナはひらがなに、濁点・半濁点は外す（「が」→「か」、「パ」→「は」）
  const code = head.codePointAt(0)!;
  const hira = code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : head;
  const base = hira.normalize('NFD').replace(/[゙゚]/g, '').normalize('NFC');
  const i = ROW_CHARS.findIndex((row) => row.includes(base));
  return i < 0 ? null : KANA_ROWS[i];
}
