/**
 * データ駆動の自動文（docs/02 5.1）。作品ページ・カード・X投稿の3種類を、API項目の組み立てだけで作る。
 * 描写は加えない。ジャンル名などは API の値をそのまま並べる。
 * 欠けた項目は句ごと省き、「不明」などの代替表示は出さない。
 * 文型は各5種類で、contentId のハッシュで選ぶ（同じ作品は常に同じ文）。
 */
import type { DerivedLabel } from '../data/types.ts';
import type { CatalogWork } from './catalog.ts';
import { fmtDate, minutes, yen } from './format.ts';

const PAGE_NAMES = 8;     // 作品ページで列挙する出演者名の上限（超えたら「ほか」）
const POST_NAMES = 3;     // X投稿での上限
const POST_MAX = 140;     // X投稿の字数上限（末尾の " #PR" を含む）
const POST_TAG = ' #PR';
const MIN_TITLE = 6;      // 題名に割ける字数がこれより少ないときは、付帯情報をやめて題名だけにする

/** ラベル句（作品ページ用の1文）。先に並べたものを優先し、該当が無ければ空 */
const NOTES: [DerivedLabel, string][] = [
  ['初見向け', 'このシリーズやメーカーを初めて見るなら、評価と長さのバランスからこの1本が入口に向いています'],
  ['新作', '配信が始まったばかりの新作です'],
  ['定番', '配信から時間が経っても見られ続けている定番です'],
  ['長尺', 'まとまった時間を取って見たい長尺作品です'],
  ['短尺', '短い時間で見られる短尺作品です'],
  ['セール中', '期間限定のセール対象です'],
];

/** 文字列のハッシュ（FNV-1a に仕上げの攪拌を加えた符号なし32bit）。下位ビットまで散らして `% 5` でも偏らないようにする */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 文の部品。欠けた項目は '' にしておき、組み立て側が句ごと省く */
type Facts = {
  names: string[];     // 出演者名
  maker: string;       // メーカー名
  series: string;      // シリーズ名
  genres: string[];    // ジャンル名
  min: string;         // "120分"
  date: string;        // "2026/11/01"
  avg: string;         // レビュー平均（小数1桁）。レビューが無ければ ''
  count: number;       // レビュー件数。レビューが無ければ 0
  price: string;       // "1,980円"
  regular: string;     // セール中のときの通常価格（セール中ラベルがあり、定価が現在価格より高いときだけ）
  note: string;        // ラベル句
  tag: string;         // 先頭の派生ラベル（X投稿の頭に置く）
  title: string;
};

/** 前後の空白と、文の区切りになる読点・句点を落とす（部品をつないだときに「、。」「。。」を出さないため） */
const clean = (s: string | null | undefined): string => (s ?? '').replace(/^[\s、。]+|[\s、。]+$/gu, '');
const refs = (xs: readonly { name: string }[]): string[] => xs.map((x) => clean(x.name)).filter((s) => s !== '');

function facts(w: CatalogWork): Facts {
  const avg = w.reviewAvg;
  const hasReview = w.reviewCount > 0 && typeof avg === 'number' && Number.isFinite(avg);
  const sale = w.derivedLabels.includes('セール中') && w.priceMin !== null && w.listPrice !== null && w.listPrice > w.priceMin;
  return {
    names: refs(w.actresses), maker: refs(w.makers)[0] ?? '', series: refs(w.series)[0] ?? '', genres: refs(w.genres),
    min: minutes(w.volumeMin), date: fmtDate(w.releasedAt),
    avg: hasReview ? avg.toFixed(1) : '', count: hasReview ? w.reviewCount : 0,
    price: yen(w.priceMin), regular: sale ? yen(w.listPrice) : '',
    note: NOTES.find(([label]) => w.derivedLabels.includes(label))?.[1] ?? '',
    tag: w.derivedLabels[0] ?? '', title: (w.title ?? '').trim(),
  };
}

const list = (...xs: string[]): string => xs.filter((x) => x !== '').join('、');     // 空でない部分を読点でつなぐ
const cat = (...xs: string[]): string => xs.join('');                                // そのまま続ける
const finish = (sentences: string[]): string => sentences.filter((s) => s !== '').map((s) => `${s}。`).join('');

const who = (f: Facts, max: number): string =>
  f.names.length === 0 ? '' : `${f.names.length > max ? `${f.names.slice(0, max).join('、')}ほか` : f.names.join('、')}出演`;
/** 主語。出演者なしはメーカー名＋「制作」。メーカーも無ければ '' */
const subject = (f: Facts, max: number): string => who(f, max) || (f.maker ? `${f.maker}制作` : '');
const review = (f: Facts): string => (f.avg ? `レビューは${f.avg}点（${f.count}件）` : '');
const priceLine = (f: Facts): string => (f.price === '' ? '' : f.regular ? `セール中は${f.price}（通常${f.regular}）` : `価格は${f.price}`);
const genre = (f: Facts, head: string, max = Infinity): string => (f.genres.length > 0 ? `${head}${f.genres.slice(0, max).join('、')}` : '');
const when = (f: Facts): string => (f.date ? `${f.date}配信開始` : '');

/**
 * 主語＋シリーズ句（句点なし）。出演者ありは「A、B出演、{メーカー}の{シリーズ}の1本」「…、{メーカー}の作品」。
 * 出演者なしは主語がメーカーなので、メーカー名の重複を避けて「{メーカー}制作、{シリーズ}の1本」「{メーカー}制作の作品」にする。
 */
function lead(f: Facts, max: number): string {
  let series = '';
  if (f.series) series = f.maker ? `${f.maker}の${f.series}の1本` : `${f.series}の1本`;
  else if (f.maker) series = `${f.maker}の作品`;
  if (f.names.length > 0) return list(who(f, max), series);
  if (f.maker) return f.series ? `${f.maker}制作、${f.series}の1本` : `${f.maker}制作の作品`;
  return series;
}
/** 「{メーカー}の{シリーズ}から、{出演者}出演の{n}分作品」。欠けた部分は句ごと省く */
function fromClause(f: Facts): string {
  const origin = f.maker ? (f.series ? `${f.maker}の${f.series}` : f.maker) : f.series;
  const w = who(f, PAGE_NAMES), work = f.min ? `${f.min}作品` : '作品';
  const body = w ? `${w}の${work}` : f.min ? work : '';
  return origin && body ? `${origin}から、${body}` : origin ? `${origin}の作品` : body;
}
/** 「{主語…}で、{n}分」。主語が無ければ「収録{n}分」 */
const withMin = (s: string, min: string): string => (s && min ? `${s}で、${min}` : s || (min ? `収録${min}` : ''));

/** 作品ページ用（5文型）。各文型は「句点を付ける前の文」の配列を返す。作品ページは3〜4文に、ラベル文と価格文が付く */
const PAGE: ((f: Facts) => string[])[] = [
  (f) => [lead(f, PAGE_NAMES), list(f.min, when(f)), genre(f, 'ジャンルは'), review(f), f.note],
  (f) => [list(when(f), f.min), lead(f, PAGE_NAMES), review(f), genre(f, 'ジャンルは'), priceLine(f), f.note],
  (f) => [fromClause(f), review(f), genre(f, 'タグは'), f.note, priceLine(f)],
  (f) => [subject(f, PAGE_NAMES), list(f.min && `収録${f.min}`, when(f), f.series && `${f.series}の1本`), f.note, genre(f, 'ジャンルは'), review(f)],
  (f) => [genre(f, 'ジャンルは'), withMin(lead(f, PAGE_NAMES), f.min), priceLine(f), review(f), f.note],
];
/** カード用（5文型）。「・」でつなぐ短い1文 */
const CARD: ((f: Facts) => string[])[] = [
  (f) => [f.min, f.avg && `${f.avg}点`, f.price],
  (f) => [f.series || f.maker, f.min, f.avg && `${f.count}件`],
  (f) => [f.date, f.min, f.price],
  (f) => [f.genres.slice(0, 2).join('・'), f.min],
  (f) => [f.avg && `${f.avg}点（${f.count}件）`, f.min],
];
/** X投稿用（5文型）。q は「題名」（題名が無ければ ''）。字数に収める処理は fitPost */
const POST: ((f: Facts, q: string) => string[])[] = [
  (f, q) => [f.tag, cat(subject(f, POST_NAMES), q, list(f.min, f.avg && `${f.avg}点`))],
  (f, q) => [cat(q, list(f.min, f.avg && `${f.avg}点`)), lead(f, POST_NAMES), f.tag],
  (f, q) => [when(f), cat(subject(f, POST_NAMES), q, f.min), priceLine(f)],
  (f, q) => [f.tag, cat(q, who(f, POST_NAMES) && `（${who(f, POST_NAMES)}）`), review(f)],
  (f, q) => [cat(q, f.min), subject(f, POST_NAMES), genre(f, 'ジャンルは', 3)],
];

export const VARIANT_COUNT = { page: PAGE.length, card: CARD.length, post: POST.length } as const;
const SALT = { page: '', card: 'c', post: 'p' } as const;

/** 文型の番号（0〜4）。contentId のハッシュで選ぶ。カードは contentId + 'c'、X投稿は + 'p' を使い、用途ごとに選びを分ける */
export function variantOf(contentId: string, kind: keyof typeof VARIANT_COUNT): number {
  return hash(contentId + SALT[kind]) % VARIANT_COUNT[kind];
}
function pickOf<T>(table: T[], variant: number): T {
  if (!Number.isInteger(variant)) throw new RangeError(`文型の番号は整数で指定してください: ${variant}`);
  return table[((variant % table.length) + table.length) % table.length];
}

/** 長さを max（UTF-16 の長さ）に収める。超えるときは末尾を「…」にする（サロゲートペアは割らない） */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}
/** 題名だけを切り詰めて max に収める。付帯情報で題名の持ち分が足りないときは、題名だけの文にする */
function fitPost(make: (title: string) => string, title: string): string {
  const max = POST_MAX - POST_TAG.length;
  if (title === '') return clip(make(''), max);
  const room = max - make('').length - 3;          // 「」と句点の分を見込む
  if (room >= MIN_TITLE) {
    const s = make(clip(title, room));
    if (s.length <= max) return s;
  }
  return `「${clip(title, max - 3)}」。`;
}

/** 作品ページ用の文を、文型の番号を指定して作る（テスト用。通常は pageText） */
export function renderPage(w: CatalogWork, variant: number): string {
  return finish(pickOf(PAGE, variant)(facts(w)));
}
export function renderCard(w: CatalogWork, variant: number): string {
  return pickOf(CARD, variant)(facts(w)).filter((p) => p !== '').join('・');
}
export function renderPost(w: CatalogWork, variant: number): string {
  const f = facts(w), make = pickOf(POST, variant);
  return `${fitPost((title) => finish(make(f, title ? `「${title}」` : '')), f.title) || '作品情報。'}${POST_TAG}`;
}

/** 作品ページ用（3〜4文＋ラベル文）。項目が全て欠けたときは空文字 */
export function pageText(w: CatalogWork): string {
  return renderPage(w, variantOf(w.contentId, 'page'));
}
/** カード用（1文）。選んだ文型の項目が全て欠けたときは、次の文型に順に替える。どれも空なら空文字 */
export function cardText(w: CatalogWork): string {
  const start = variantOf(w.contentId, 'card');
  for (let i = 0; i < CARD.length; i++) {
    const s = renderCard(w, start + i);
    if (s !== '') return s;
  }
  return '';
}
/** X投稿用（140字以内、末尾は " #PR"）。長い題名は「…」で切り詰める */
export function postText(w: CatalogWork): string {
  return renderPost(w, variantOf(w.contentId, 'post'));
}
