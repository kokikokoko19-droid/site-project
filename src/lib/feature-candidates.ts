/**
 * 特集の候補（テーマごとに作品を絞って並べる純粋関数）と、特集の導入文の材料。
 * 出力は content_id・評価・件数・収録時間・価格・配信日だけで、題名は含めない（運営者は /v/ID/ で確認する）。
 */
import { bayesScore } from '../data/derive.ts';
import type { Catalog, CatalogWork } from './catalog.ts';
import { jstDate } from './weekly-stats.ts';

export const THEME_KEYS = ['classic', 'month', 'starter', 'sale'] as const;
export type ThemeKey = (typeof THEME_KEYS)[number];

/** 1 テーマの候補数 */
export const CANDIDATES_PER_THEME = 10;

export type Candidate = {
  contentId: string;
  reviewAvg: number | null;
  reviewCount: number;
  volumeMin: number | null;
  price: number | null;
  releasedAt: string | null;
};

export type Theme = {
  key: ThemeKey;
  /** テーマ名（特集の題名の元） */
  label: string;
  /** 選び方（LLM に渡す事実。検査で許す数字の元でもある） */
  criteria: string;
};

export const THEMES: Record<ThemeKey, Theme> = {
  classic: { key: 'classic', label: 'レビュー100件超の定番', criteria: 'レビューが100件以上集まった作品を、評価の高い順に並べた' },
  month: { key: 'month', label: '今月の高評価', criteria: '配信から30日以内で、レビューが5件以上ある作品を、評価の高い順（件数の少なさを補正した平均）に並べた' },
  starter: { key: 'starter', label: '短くて評価の高い入門向け', criteria: '収録時間が60分以下で、レビューが10件以上ある作品を、評価の高い順に並べた' },
  sale: { key: 'sale', label: 'セール中の高評価', criteria: 'いまセール中の作品を、評価の高い順に並べた' },
};

export function isThemeKey(s: string): s is ThemeKey {
  return (THEME_KEYS as readonly string[]).includes(s);
}

const DAY = 86_400_000;

/** 評価の降順（評価なしは末尾）。同じなら件数の多い順、さらに content_id 順 */
const byRating = (a: CatalogWork, b: CatalogWork): number =>
  (b.reviewAvg ?? -1) - (a.reviewAvg ?? -1) || b.reviewCount - a.reviewCount || (a.contentId < b.contentId ? -1 : a.contentId > b.contentId ? 1 : 0);

/** 配信開始日（YYYY-MM-DD で始まる値）から基準日までの日数。読めなければ null */
function daysSince(releasedAt: string | null, today: string): number | null {
  const m = releasedAt ? /^(\d{4})-(\d{2})-(\d{2})/.exec(releasedAt) : null;
  if (!m) return null;
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!t) return null;
  return (Date.UTC(+t[1], +t[2] - 1, +t[3]) - Date.UTC(+m[1], +m[2] - 1, +m[3])) / DAY;
}

const toCandidate = (w: CatalogWork): Candidate => ({
  contentId: w.contentId, reviewAvg: w.reviewAvg, reviewCount: w.reviewCount, volumeMin: w.volumeMin, price: w.priceMin, releasedAt: w.releasedAt,
});

/** カタログの全作品の評価の平均（評価のある作品だけ。無ければ 3）。ベイズ平均の事前値 */
function meanAvg(works: CatalogWork[]): number {
  const rated = works.filter((w) => w.reviewAvg !== null && w.reviewCount > 0);
  return rated.length === 0 ? 3 : rated.reduce((s, w) => s + (w.reviewAvg as number), 0) / rated.length;
}

/** テーマに合う作品を条件の順に並べて、先頭 n 件（既定 10）を返す。now は「30 日以内」の基準（日本時間の暦日で数える） */
export function featureCandidates(catalog: Pick<Catalog, 'works'>, theme: ThemeKey, now: Date, n = CANDIDATES_PER_THEME): Candidate[] {
  const works = catalog.works;
  const today = jstDate(now);
  let picked: CatalogWork[];
  switch (theme) {
    case 'classic':
      picked = works.filter((w) => w.reviewCount >= 100).sort(byRating);
      break;
    case 'month': {
      const prior = meanAvg(works);
      const score = new Map(works.map((w) => [w.contentId, bayesScore(w, prior)]));
      picked = works
        .filter((w) => { const d = daysSince(w.releasedAt, today); return d !== null && d >= 0 && d <= 30 && w.reviewCount >= 5; })
        .sort((a, b) => (score.get(b.contentId) as number) - (score.get(a.contentId) as number) || b.reviewCount - a.reviewCount || (a.contentId < b.contentId ? -1 : 1));
      break;
    }
    case 'starter':
      picked = works.filter((w) => w.volumeMin !== null && w.volumeMin <= 60 && w.reviewCount >= 10).sort(byRating);
      break;
    case 'sale':
      picked = works.filter((w) => w.derivedLabels.includes('セール中')).sort(byRating);
      break;
  }
  return picked.slice(0, Math.max(0, Math.floor(n))).map(toCandidate);
}

/** LLM に渡す事実の一覧（テーマ名・選び方・候補数）。数字はこの文面のものだけを許す */
export function themeFacts(theme: Theme, count: number): string {
  return [`特集のテーマ: ${theme.label}`, `選び方: ${theme.criteria}`, `候補の数: ${count}`].join('\n');
}

/** 導入文の system プロンプト（固定） */
export const INTRO_SYSTEM = [
  'あなたは、作品カタログサイト「AVめぐり」の運営者として、特集ページの見出しの下に置く導入文を書く。',
  '日本語で書く。',
  '一人称の運営者（サイトを運営している個人）の声で、落ち着いた丁寧な文体にする。',
  '作品名（題名）・ジャンル名・出演者名・性的な語は書かない。年齢を連想させる語も書かない。',
  '与えられた事実の数字以外の事実（数字・日付・固有名詞・出来事）を書かない。数字は与えられた表記のまま使う。',
  '誇張・断定・煽る表現は使わない。箇条書き・見出し・記号による装飾は使わず、地の文だけで書く。',
  '前置き・説明・引用符は付けず、本文だけを出力する。',
  '2〜3 文で書く。テーマの選び方を踏まえて、どんな人が選ぶときの助けになるかを伝える。',
].join('\n');

export const INTRO_REQUEST = '次の事実だけを使って、特集の導入文を書いてください。';

/** API なしの既定の導入文（テーマごと。2〜3 文。数字は選び方にあるものだけ） */
export function introTemplate(theme: ThemeKey): string {
  switch (theme) {
    case 'classic':
      return 'レビューが100件以上集まった作品を、評価の高い順に並べました。多くの人が見て感想を残している作品なので、最初の1本を選ぶときの目安になります。';
    case 'month':
      return '配信から30日以内の作品のうち、レビューが5件以上ある作品を、評価の高い順に並べました。新しい作品を探すときに、まず見てほしい顔ぶれです。';
    case 'starter':
      return '収録時間が60分以下で、レビューが10件以上ある作品を、評価の高い順に並べました。時間に余裕がないときや、はじめて見るときに選びやすい作品です。';
    case 'sale':
      return 'いまセール中の作品を、評価の高い順に並べました。値引きの期間は限られているので、気になる作品があれば早めに作品ページを開いてみてください。';
  }
}
