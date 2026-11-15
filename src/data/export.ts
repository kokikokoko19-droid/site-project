/**
 * 探索UI・ページ生成用の JSON を出力する（docs/02 5.2 のラベルで絞り込むための軽量データ）。
 * 紹介文・レビュー本文にあたる項目は Work 型に無く、ここでも付けない。
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBlocked, loadBlocklist } from './blocklist.ts';
import type { Blocklist } from './blocklist.ts';
import type { Db } from './db.ts';
import { ALL_LABELS, bayesScore } from './derive.ts';
import { publishFilter } from './policy.ts';
import type { PublishContext } from './policy.ts';
import type { DerivedLabel, PriceBand, Work, WorkCardRecord } from './types.ts';

/** works.json の1件。Work に、派生ラベルと似た作品の ID（score の高い順）を付けたもの */
export type ExportedWork = Work & { derivedLabels: DerivedLabel[]; similarIds: string[] };

/** DB に保存された文字列ラベルのうち既知のものだけを、定義順で返す */
const knownLabels = (names: string[]): DerivedLabel[] => ALL_LABELS.filter((l) => names.includes(l));

/** 名前の一覧の種類（index.json の names のキー） */
export type NameKind = 'actress' | 'maker' | 'series' | 'genre';
const NAME_PICK: Record<NameKind, (w: Work) => { name: string }[]> = {
  actress: (w) => w.actresses, maker: (w) => w.makers.slice(0, 1), series: (w) => w.series.slice(0, 1), genre: (w) => w.genres,
};

/**
 * 名前の一覧（件数の多い順、同数は名前順）と、名前 → 添字の表。カードは添字で名前を指す。
 * 名前で束ねる（探索ページの URL が名前で条件を持つため。同名の別人は同じ添字になる）。メーカー・シリーズは先頭の1件だけ数える。
 */
export function buildNames(works: Work[]): { names: Record<NameKind, string[]>; counts: Record<NameKind, number[]>; index: Record<NameKind, Map<string, number>> } {
  const names = {} as Record<NameKind, string[]>, counts = {} as Record<NameKind, number[]>, index = {} as Record<NameKind, Map<string, number>>;
  for (const kind of Object.keys(NAME_PICK) as NameKind[]) {
    const tally = new Map<string, number>();
    for (const w of works) for (const n of new Set(NAME_PICK[kind](w).map((r) => r.name))) tally.set(n, (tally.get(n) ?? 0) + 1);
    const sorted = [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    names[kind] = sorted.map(([n]) => n);
    counts[kind] = sorted.map(([, c]) => c);
    index[kind] = new Map(sorted.map(([n], i) => [n, i]));
  }
  return { names, counts, index };
}

/** 価格帯（0: 〜500 円、1: 〜1,000 円、2: 〜2,000 円、3: 2,000 円超、null: 価格なし） */
export function priceBand(price: number | null): PriceBand | null {
  if (price === null || !Number.isFinite(price)) return null;
  return price <= 500 ? 0 : price <= 1000 ? 1 : price <= 2000 ? 2 : 3;
}

/** 評価の表示用: レビュー 5 件以上のときだけ、平均を 0.5 刻みに丸める */
export function ratingBand(work: Pick<Work, 'reviewAvg' | 'reviewCount'>): number | null {
  return work.reviewAvg !== null && work.reviewCount >= 5 ? Math.round(work.reviewAvg * 2) / 2 : null;
}

/** おすすめ度の重み（旧探索の既定の重み 評価 0.4・新しさ 0.2・人気 0.2 と同じ考え方。価格と長さは並べ替え・絞り込みに任せ、件数を足す） */
export const SCORE_WEIGHTS = { rating: 0.45, reviews: 0.15, recency: 0.2, popularity: 0.2 } as const;
const DAY_MS = 86_400_000;

export type ScoreContext = { now: number; meanAvg: number; maxReviews: number; maxRank: number };

/** おすすめ度の計算に使う全体の値（評価のある作品の平均、レビュー件数と順位の最大）を求める */
export function scoreContext(works: Work[], now: Date): ScoreContext {
  const rated = works.filter((w) => w.reviewAvg !== null && w.reviewCount > 0);
  return {
    now: now.getTime(),
    meanAvg: rated.length ? rated.reduce((s, w) => s + (w.reviewAvg as number), 0) / rated.length : 3,
    maxReviews: Math.max(0, ...works.map((w) => w.reviewCount)),
    maxRank: Math.max(1, ...works.map((w) => w.rankPosition ?? 1)),
  };
}

/**
 * おすすめ度（0〜100 の整数）。評価はベイズ平均（derive.ts の bayesScore と同じ。1〜5 を 0〜1 に）、件数は対数で 0〜1、
 * 新しさは指数減衰（1 年で 1/e。配信開始前は 1、日付なしは 0）、人気は順位の逆順（順位なしは 0）。
 */
export function recommendScore(w: Work, ctx: ScoreContext): number {
  const W = SCORE_WEIGHTS;
  const bayes = (bayesScore(w, ctx.meanAvg) - 1) / 4;
  const reviews = ctx.maxReviews > 0 ? Math.log1p(w.reviewCount) / Math.log1p(ctx.maxReviews) : 0;
  const t = w.releasedAt ? Date.parse(w.releasedAt.slice(0, 10)) : NaN;
  const recency = Number.isNaN(t) ? 0 : Math.exp(-Math.max(0, ctx.now - t) / DAY_MS / 365);
  const pop = w.rankPosition === null ? 0 : ctx.maxRank > 1 ? 1 - (w.rankPosition - 1) / (ctx.maxRank - 1) : 1;
  const x = W.rating * bayes + W.reviews * reviews + W.recency * recency + W.popularity * pop;
  return Math.round(100 * Math.min(1, Math.max(0, x)));
}

/** 探索UI用の軽量レコード。names は buildNames の index、score は scoreContext の値（d は releasedAt の先頭10文字） */
export function toCardRecord(work: Work, labels: DerivedLabel[], names: Record<NameKind, Map<string, number>>, score: ScoreContext): WorkCardRecord {
  const at = (kind: NameKind, name: string | undefined): number | null => (name === undefined ? null : names[kind].get(name) ?? null);
  const many = (kind: NameKind, refs: { name: string }[]): number[] =>
    [...new Set(refs.map((r) => at(kind, r.name)).filter((i): i is number => i !== null))];
  return {
    id: work.contentId,
    t: work.title,
    a: many('actress', work.actresses),
    m: at('maker', work.makers[0]?.name),
    s: at('series', work.series[0]?.name),
    g: many('genre', work.genres),
    d: work.releasedAt === null ? null : work.releasedAt.slice(0, 10),
    v: work.volumeMin,
    sc: recommendScore(work, score),
    rb: ratingBand(work),
    pb: priceBand(work.priceMin),
    sale: labels.includes('セール中'),
    sm: work.sampleMovie !== null,
    lb: [...labels],
    img: work.imageSmall,
    ob: /^https?:\/\//.test(work.affiliateUrl ?? '') || /^https?:\/\//.test(work.url ?? ''),
  };
}

/** カードの並び: 配信開始日の新しい順（日付なしは最後）、同じ日は id 昇順。works-000.json が直近の作品になる */
export const newestFirst = (a: WorkCardRecord, b: WorkCardRecord): number =>
  a.d === b.d ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.d === null ? 1 : b.d === null ? -1 : a.d < b.d ? 1 : -1;

/** meta に JSON として保存された値を読む。無い・壊れているときは null */
function readJson(db: Db, key: string): unknown {
  const raw = db.getMeta(key);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * active の作品を outDir に出力する。
 * works-000.json…（WorkCardRecord を配信開始日の新しい順に chunkSize 件ずつ）、works.json（全 Work + derivedLabels + similarIds）、
 * actresses.json（ActressProfile[]。works に出てくる出演者のみ）、meta.json（rankings・todays・last_ingest_at・last_derive_at）、index.json（件数・チャンク名・names と counts（カードの添字が指す名前と作品数。件数の多い順）・使われているラベル）。
 * 除外リスト（config/blocklist.json）に該当する作品は、全ての出力（rankings・todays・出演者を含む）から除く。DB は変えない。
 * publish（掲載方針 policy.ts）を渡すと、公開対象の作品だけを全ての出力に出す（除外リストより後に判定しても結果は同じ）。
 * index.json は最後に書く。前回より少なくなって余ったチャンクは消す。now は generatedAt の差し替え用。
 */
export function exportAll(
  db: Db, outDir: string, opts: { chunkSize?: number; now?: Date; blocklist?: Blocklist; publish?: PublishContext } = {},
): { works: number; chunks: number; blocked?: number } {
  const chunkSize = opts.chunkSize ?? 1000;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new RangeError(`chunkSize は1以上の整数で指定してください: ${chunkSize}`);
  const blocklist = opts.blocklist ?? loadBlocklist();
  const published = opts.publish ? publishFilter(opts.publish) : () => true;
  const all = db.listWorks({ status: 'active' }).filter(published);
  const works = all.filter((w) => !isBlocked(w, blocklist));
  const blocked = all.length - works.length;
  const active = new Set(works.map((w) => w.contentId));
  // 派生後に gone になった作品の ID が残っていても、出力には含めない
  const keep = (ids: unknown): string[] => (Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && active.has(id)) : []);

  const now = opts.now ?? new Date();
  const { names, counts, index: nameIndex } = buildNames(works), score = scoreContext(works, now);
  const cards: WorkCardRecord[] = [], full: ExportedWork[] = [];
  for (const w of works) {
    const labels = knownLabels(db.getLabels(w.contentId));
    cards.push(toCardRecord(w, labels, nameIndex, score));
    full.push({ ...w, derivedLabels: labels, similarIds: keep(db.getSimilar(w.contentId).map((s) => s.similarId)) });
  }
  const rk = readJson(db, 'rankings') as Record<string, unknown> | null, todays = readJson(db, 'todays');
  const meta = {
    rankings: rk && typeof rk === 'object'
      ? { byRating: keep(rk.byRating), byRecent: keep(rk.byRecent), byPopularity: keep(rk.byPopularity) } : null,
    todays: Array.isArray(todays) ? keep(todays) : null,
    last_ingest_at: db.getMeta('last_ingest_at'),
    last_derive_at: db.getMeta('last_derive_at'),
  };

  cards.sort(newestFirst);
  mkdirSync(outDir, { recursive: true });
  const write = (name: string, data: unknown): void => writeFileSync(join(outDir, name), JSON.stringify(data));
  const chunks: string[] = [];
  for (let i = 0; i * chunkSize < cards.length; i++) {
    chunks.push(`works-${String(i).padStart(3, '0')}.json`);
    write(chunks[i], cards.slice(i * chunkSize, (i + 1) * chunkSize));
  }
  write('works.json', full);
  // 出演者プロフィール: active の作品に出てくる出演者だけ（画像URLは保存していないので出ない）
  const appearing = new Set(works.flatMap((w) => w.actresses.map((a) => String(a.id))));
  // 該当が0件のときはファイルを作らず、前回の古い出力も消す（プロフィール未取り込みの環境の出力を増やさない）
  const profiles = db.listActressProfiles().filter((a) => appearing.has(a.id));
  if (profiles.length > 0) write('actresses.json', profiles); else rmSync(join(outDir, 'actresses.json'), { force: true });
  write('meta.json', meta);
  write('index.json', {
    generatedAt: now.toISOString(), total: works.length, chunks, names, counts,
    labels: ALL_LABELS.filter((l) => full.some((w) => w.derivedLabels.includes(l))), // 実際に使われているラベルだけ
  });
  for (const f of readdirSync(outDir)) if (/^works-\d+\.json$/.test(f) && !chunks.includes(f)) rmSync(join(outDir, f));
  // blocked は除外があったときだけ付ける（0 件のときの戻り値は従来と同じ）
  return blocked > 0 ? { works: works.length, chunks: chunks.length, blocked } : { works: works.length, chunks: chunks.length };
}
