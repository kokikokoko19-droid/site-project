/** 派生計算（ラベル docs/02 5.2、似た作品 4.4、ランキング、今日の候補）。純粋関数で、DB に触れるのは runDerive だけ。日付は日本時間の暦日で数える */
import { DEFAULT_THRESHOLDS } from './types.ts';
import type { Db } from './db.ts';
import type { DerivedLabel, LabelThresholds, Similar, Work } from './types.ts';

/** ラベルの並び順（DerivedLabel の定義順）。出力はこの順にそろう */
export const ALL_LABELS: readonly DerivedLabel[] = [
  '新作', '定番', '高評価', '長尺', '短尺', 'セール中', '初見向け', 'シリーズ追い向け', '出演者追い向け',
];
const DAY = 86_400_000, JST = 9 * 3_600_000, YEAR = 365.25 * DAY;

/** 日付・日時の文字列をミリ秒にする。タイムゾーン指定がなければ日本時間として読む。読めなければ null */
function toMs(s: string | null | undefined): number | null {
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s) : null;
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) - JST;
  const ms = s ? Date.parse(s) : NaN;
  return Number.isNaN(ms) ? null : ms;
}
const jstDay = (ms: number): number => Math.floor((ms + JST) / DAY); // 日本時間の暦日番号（1970-01-01 が 0）

/** セール中: 今日を含むキャンペーン期間がある（片側 null は無期限、両方 null は数えない）、または priceMin < listPrice */
function onSale(w: Work, today: number): boolean {
  if (w.priceMin !== null && w.listPrice !== null && w.priceMin < w.listPrice) return true;
  return w.campaigns.some((c) => {
    const b = toMs(c.begin), e = toMs(c.end);
    return (b !== null || e !== null) && (b === null || jstDay(b) <= today) && (e === null || today <= jstDay(e));
  });
}

export type LabelContext = {
  now: Date; thresholds?: LabelThresholds;
  seriesCounts: Map<string, number>;  // シリーズ ID → active の作品数（自分を含む）
  actressCounts: Map<string, number>; // 出演者 ID → active の作品数（自分を含む）
};

/** 作品のルールラベル。releasedAt が読めない作品には 新作・定番・初見向け を付けない（配信開始前の作品にも 新作 は付けない） */
export function computeLabels(work: Work, ctx: LabelContext): DerivedLabel[] {
  const t = { ...DEFAULT_THRESHOLDS, ...ctx.thresholds }, today = jstDay(ctx.now.getTime());
  const rel = toMs(work.releasedAt), relDay = rel === null ? null : jstDay(rel), v = work.volumeMin;
  const d = new Date(today * DAY); // 暦日を UTC の 0 時として扱い、classicYears 年さかのぼった日（定番の境界）を求める
  d.setUTCFullYear(d.getUTCFullYear() - Math.floor(t.classicYears));
  const classicDay = Math.floor(d.getTime() / DAY) - Math.round((t.classicYears % 1) * 365.25);
  const top = work.reviewAvg !== null && work.reviewAvg >= t.topAvg && work.reviewCount >= t.topReviews;
  const classic = relDay !== null && relDay <= classicDay && work.reviewCount >= t.classicReviews;
  const long = v !== null && v >= t.longMin, short = v !== null && v > 0 && v <= t.shortMin; // 0 分は未入力とみなす
  const most = (refs: { id: string }[], counts: Map<string, number>): number =>
    Math.max(0, ...refs.map((r) => counts.get(r.id) ?? 0));
  const checks: [DerivedLabel, boolean][] = [
    ['新作', relDay !== null && today - relDay >= 0 && today - relDay <= t.newDays],
    ['定番', classic], ['高評価', top], ['長尺', long], ['短尺', short], ['セール中', onSale(work, today)],
    ['初見向け', top && classic && !long && !short],
    ['シリーズ追い向け', most(work.series, ctx.seriesCounts) >= t.seriesFollow],
    ['出演者追い向け', most(work.actresses, ctx.actressCounts) >= t.actressFollow],
  ];
  return checks.filter(([, ok]) => ok).map(([label]) => label);
}

/** シリーズ・出演者ごとの作品数（1作品は同じ ID を1回だけ数える） */
export function buildRefCounts(works: Work[]): Pick<LabelContext, 'seriesCounts' | 'actressCounts'> {
  const count = (refsOf: (w: Work) => { id: string }[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const w of works) for (const id of new Set(refsOf(w).map((r) => r.id))) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  };
  return { seriesCounts: count((w) => w.series), actressCounts: count((w) => w.actresses) };
}

/** 点数: ジャンルの Jaccard + 同出演者 0.5 + 同シリーズ 0.4 + 同メーカー 0.15 - 発売時期の差（10年で 0.1、上限 0.1）。flags: 1 同出演者、2 同シリーズ、4 同メーカー */
function combine(inter: number, na: number, nb: number, flags: number, dt: number | null): number {
  const union = na + nb - inter, bonus = (flags & 1 ? 0.5 : 0) + (flags & 2 ? 0.4 : 0) + (flags & 4 ? 0.15 : 0);
  return (union === 0 ? 0 : inter / union) + bonus - (dt === null ? 0 : 0.1 * Math.min(1, dt / (10 * YEAR)));
}

const better = (x: Similar, y: Similar): boolean => x.score > y.score || (x.score === y.score && x.similarId < y.similarId);

/** score 降順（同点は similarId 昇順）で上位 n 件だけを保つ挿入 */
function pushTop(top: Similar[], s: Similar, n: number): void {
  if (top.length >= n && !better(s, top[n - 1])) return;
  let i = top.length;
  while (i > 0 && better(s, top[i - 1])) i--;
  top.splice(i, 0, s);
  if (top.length > n) top.pop();
}

/**
 * 「作品の添字 i と件数 n から似た作品を返す関数」を作る。ジャンルは名前、出演者・シリーズ・メーカーは ID で比べる。
 * 転置インデックスで共通のキーを持つ作品だけを数える。共通のない作品の点数は 0 以下なので、上位 n 件が正の点数で埋まらないときだけ全件を比べる。
 */
function similarFinder(works: Work[]): (i: number, n: number) => Similar[] {
  const feats = works.map((w) => {
    const keys = [...new Set([...w.genres.map((g) => 'g' + g.name), ...w.actresses.map((a) => 'a' + a.id),
      ...w.series.map((s) => 's' + s.id), ...w.makers.map((m) => 'm' + m.id)])];
    return { id: w.contentId, t: toMs(w.releasedAt), keys, ng: keys.filter((k) => k[0] === 'g').length };
  });
  const index = new Map<string, number[]>(); // キー → そのキーを持つ作品の添字
  feats.forEach((f, i) => f.keys.forEach((k) => { const l = index.get(k); if (l) l.push(i); else index.set(k, [i]); }));
  const inter = new Int32Array(feats.length), flags = new Uint8Array(feats.length), seen = new Uint8Array(feats.length);
  return (i, n) => {
    const f = feats[i], top: Similar[] = [], touched: number[] = [];
    if (n <= 0) return top;
    for (const k of f.keys) for (const j of index.get(k) as number[]) {
      if (!seen[j]) { seen[j] = 1; touched.push(j); }
      if (k[0] === 'g') inter[j]++; else flags[j] |= k[0] === 'a' ? 1 : k[0] === 's' ? 2 : 4;
    }
    const consider = (j: number): void => {
      const g = feats[j];
      if (g.id === f.id) return; // 自分自身は除く
      const score = combine(inter[j], f.ng, g.ng, flags[j], f.t === null || g.t === null ? null : Math.abs(f.t - g.t));
      if (top.length < n || score >= top[n - 1].score) pushTop(top, { contentId: f.id, similarId: g.id, score }, n);
    };
    for (const j of touched) consider(j);
    if (top.length < n || top[n - 1].score <= 0) for (let j = 0; j < feats.length; j++) if (!seen[j]) consider(j);
    for (const j of touched) { inter[j] = 0; flags[j] = 0; seen[j] = 0; }
    return top;
  };
}

/** 似た作品の上位 n 件（score 降順）。candidates に work 自身が含まれていても除く */
export function computeSimilar(work: Work, candidates: Work[], n = 8): Similar[] {
  return similarFinder([work, ...candidates])(0, n);
}

/** 全作品の似た作品（全作品に computeSimilar を呼んだ場合と同じ結果を、転置インデックスで速く求める） */
export function computeSimilarAll(works: Work[], n = 8): Similar[] {
  const find = similarFinder(works);
  return works.flatMap((_, i) => find(i, n));
}

/** ベイズ平均: 件数の少ない作品の平均を全体平均 meanAvg に寄せる。avg が null なら meanAvg 扱い */
export function bayesScore(work: Work, meanAvg: number, C = 20): number {
  return ((work.reviewAvg ?? meanAvg) * work.reviewCount + meanAvg * C) / (work.reviewCount + C);
}

const cmpNullLast = (a: number | null, b: number | null, asc: boolean): number =>
  a === null || b === null ? (a === b ? 0 : a === null ? 1 : -1) : asc ? a - b : b - a;

/**
 * content_id の並び。byRating はベイズ平均（全体平均は評価のある作品の平均）の降順、byRecent は発売日の降順、
 * byPopularity は人気順位の昇順（null は末尾）。同順位は content_id 昇順。
 */
export function computeRankings(works: Work[]): { byRating: string[]; byRecent: string[]; byPopularity: string[] } {
  const rated = works.filter((w) => w.reviewAvg !== null && w.reviewCount > 0);
  const meanAvg = rated.length === 0 ? 3 : rated.reduce((s, w) => s + (w.reviewAvg as number), 0) / rated.length;
  const score = new Map(works.map((w) => [w.contentId, bayesScore(w, meanAvg)]));
  const ids = (cmp: (a: Work, b: Work) => number): string[] =>
    [...works].sort((a, b) => cmp(a, b) || (a.contentId < b.contentId ? -1 : a.contentId > b.contentId ? 1 : 0)).map((w) => w.contentId);
  return {
    byRating: ids((a, b) => (score.get(b.contentId) as number) - (score.get(a.contentId) as number) || b.reviewCount - a.reviewCount),
    byRecent: ids((a, b) => cmpNullLast(toMs(a.releasedAt), toMs(b.releasedAt), false)),
    byPopularity: ids((a, b) => cmpNullLast(a.rankPosition, b.rankPosition, true)),
  };
}

/** 文字列から決定的な乱数列を作る（FNV-1a でシード化した mulberry32） */
function seededRng(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 今日の候補: 高評価か定番の作品から n 件。dateKey（YYYY-MM-DD）が同じなら入力の並びによらず同じ結果。定番の判定は dateKey の日付が基準 */
export function pickTodays(works: Work[], dateKey: string, n = 10, thresholds?: LabelThresholds): string[] {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? toMs(dateKey) : null;
  if (day === null) throw new RangeError(`dateKey は YYYY-MM-DD 形式で指定してください: ${dateKey}`);
  const ctx: LabelContext = { now: new Date(day), thresholds, seriesCounts: new Map(), actressCounts: new Map() };
  const pool = works.filter((w) => computeLabels(w, ctx).some((l) => l === '高評価' || l === '定番')).map((w) => w.contentId).sort();
  const rng = seededRng(dateKey);
  for (let i = 0; i < Math.min(n, pool.length); i++) { // 先頭から n 件分だけ部分シャッフル
    const j = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, n));
}

/** active の全作品から派生データを再計算して保存する。labeled / similar は、ラベル・似た作品が1件以上付いた作品の数。今日の候補の日付は日本時間の now から決める */
export function runDerive(
  db: Db, opts: { now?: Date; thresholds?: LabelThresholds; similarN?: number } = {},
): { works: number; labeled: number; similar: number } {
  const now = opts.now ?? new Date(), works = db.listWorks({ status: 'active' });
  const ctx: LabelContext = { now, thresholds: opts.thresholds, ...buildRefCounts(works) };
  const entries = works.map((w) => ({ contentId: w.contentId, labels: computeLabels(w, ctx) as string[] }));
  const similar = computeSimilarAll(works, opts.similarN ?? 8);
  db.replaceDerivedLabels(entries); // ラベルが0件の作品も渡して、前回のラベルを消す
  db.replaceSimilar(similar);
  db.setMeta('rankings', JSON.stringify(computeRankings(works)));
  db.setMeta('todays', JSON.stringify(pickTodays(works, new Date(now.getTime() + JST).toISOString().slice(0, 10), 10, opts.thresholds)));
  db.setMeta('last_derive_at', now.toISOString());
  const labeled = entries.filter((e) => e.labels.length > 0).length;
  return { works: works.length, labeled, similar: new Set(similar.map((s) => s.contentId)).size };
}
