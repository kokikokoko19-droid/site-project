/**
 * 棚の組み立てと「隣の棚」の選び方（トップ、ぶらぶらモード /stroll/、軸ページの「隣の棚へ」）。
 * 体験価値「レンタル店の 18 禁コーナーをスマホの中に作り直す」（docs/08 8 章）の、棚・返却棚・新入荷・ぶらぶらに当たる部分。
 * 日替わりの選び方は日付（YYYY-MM-DD）からの決定的な計算で、同じ日は何度ビルドしても同じ棚になる。
 * 候補ごとに「日付＋id」のハッシュで順位を付ける（rendezvous hashing）ので、候補が 1 つ増減しても他の順位はほぼ変わらない。
 * 文言はテーマ名（API の名前）と件数だけで、紹介文は付けない。
 */
import type { Catalog, CatalogWork } from './catalog.ts';

export type AxisKind = 'actress' | 'series' | 'maker' | 'genre';
export type ShelfKind = AxisKind | 'today' | 'new' | 'popular' | 'sale' | 'rated';

export type ShelfDef = {
  /** ページ内で一意のキー（例: genre-123、new） */
  key: string;
  kind: ShelfKind;
  /** 棚のテーマ名（ジャンル名・出演者名などは API の名前をそのまま） */
  title: string;
  /** その棚のテーマに属する作品の総数（見出しの件数） */
  count: number;
  /** 「この棚をもっと見る →」の行き先 */
  href: string;
  works: CatalogWork[];
};

export type RefItem = { id: string; name: string; count: number };

/** 32bit の FNV-1a。日付と id から決定的な数を作る */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 候補から n 件を日替わりで選ぶ。順位は hash(day + salt + key) の小さい順で、同じ日・同じ候補なら同じ結果。
 * salt は同じ日に別の用途（トップとぶらぶら）で違う並びにしたいときに変える
 */
export function pickDaily<T>(pool: readonly T[], n: number, day: string, key: (x: T) => string, salt = ''): T[] {
  return pool
    .map((x) => ({ x, h: hash32(`${day}|${salt}|${key(x)}`) }))
    .sort((a, b) => a.h - b.h || (key(a.x) < key(b.x) ? -1 : 1))
    .slice(0, Math.max(0, n))
    .map((v) => v.x);
}

/** 索引を作品数の多い順に並べる（同数は id の昇順で決定的に）。minCount 未満は除く */
export function rankRefs(index: Map<string, CatalogWork[]>, names: Map<string, string>, minCount = 1): RefItem[] {
  return [...index]
    .filter(([, works]) => works.length >= minCount)
    .map(([id, works]) => ({ id, name: names.get(id) ?? id, count: works.length }))
    .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 軸の棚の作品の並びと見出し。作品は索引の順（配信開始日の新しい順）で先頭 n 件 */
export function axisShelf(catalog: Catalog, kind: AxisKind, ref: RefItem, n = 10): ShelfDef {
  const works = indexOf(catalog, kind).get(ref.id) ?? [];
  return { key: `${kind}-${ref.id}`, kind, title: ref.name, count: works.length, href: `/${kind}/${encodeURIComponent(ref.id)}/`, works: works.slice(0, n) };
}

export function indexOf(catalog: Catalog, kind: AxisKind): Map<string, CatalogWork[]> {
  return kind === 'actress' ? catalog.byActress : kind === 'series' ? catalog.bySeries : kind === 'maker' ? catalog.byMaker : catalog.byGenre;
}

/** 作品数の多い上位 poolSize 件（minCount 以上）から、日替わりで n 件の軸を選んで棚にする */
export function dailyAxisShelves(catalog: Catalog, kind: AxisKind, day: string, opts: { n: number; pool: number; minCount?: number; per?: number; salt?: string; exclude?: Set<string> }): ShelfDef[] {
  const ranked = rankRefs(indexOf(catalog, kind), catalog.refNames[kind], opts.minCount ?? 4)
    .filter((r) => !opts.exclude?.has(r.id))
    .slice(0, opts.pool);
  return pickDaily(ranked, opts.n, day, (r) => r.id, `${kind}${opts.salt ?? ''}`).map((r) => axisShelf(catalog, kind, r, opts.per ?? 10));
}

/** 人気順（FANZA の人気順位。返却棚に当たる）の作品。順位が無ければ空 */
export function popularWorks(catalog: Catalog, n?: number): CatalogWork[] {
  const out: CatalogWork[] = [];
  for (const id of catalog.meta.rankings?.byPopularity ?? []) {
    const w = catalog.byId.get(id);
    if (w && !out.includes(w)) out.push(w);
    if (n !== undefined && out.length >= n) break;
  }
  return out;
}

/** 「高評価の定番」。両方のラベルを持つ作品を先に、足りなければ高評価だけの作品で補う */
export function ratedClassics(catalog: Catalog, n: number): CatalogWork[] {
  const both = catalog.byLabel('高評価').filter((w) => w.derivedLabels.includes('定番'));
  const out = both.slice(0, n);
  for (const w of catalog.byLabel('高評価')) {
    if (out.length >= n) break;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** 日替わりで作品の並びを選ぶ（同じ日は同じ）。棚の中身を毎日少し入れ替えるときに使う */
export function dailyWorks(works: readonly CatalogWork[], n: number, day: string, salt: string): CatalogWork[] {
  return pickDaily(works, n, day, (w) => w.contentId, salt);
}

export const STROLL_SHELVES = 12;
export const STROLL_PER = 10;

/**
 * ぶらぶらモードの 12 本の棚: ジャンル別 4、出演者別 3、シリーズ別 2、高評価の定番 1、セール 1、新入荷 1。
 * 並びは種類が続かないように交互に置く。作品が足りない種類は飛ばし、その分をジャンル別で補う。
 * 軸の候補は作品数の多い上位から日替わり（トップの棚とは salt を変えて、同じ日でも違う棚が出やすくする）
 */
export function strollShelves(catalog: Catalog, day: string, per = STROLL_PER): ShelfDef[] {
  const MIN = 4; // 棚として眺めるのに必要な最低の表紙数
  const genres = dailyAxisShelves(catalog, 'genre', day, { n: 8, pool: 24, minCount: MIN, per, salt: 'stroll' });
  const actresses = dailyAxisShelves(catalog, 'actress', day, { n: 3, pool: 18, minCount: MIN, per, salt: 'stroll' });
  const series = dailyAxisShelves(catalog, 'series', day, { n: 2, pool: 12, minCount: MIN, per, salt: 'stroll' });
  const rated = ratedClassics(catalog, 30);
  const sale = catalog.onSale();
  const fixed: Record<'rated' | 'sale' | 'new', ShelfDef | null> = {
    rated: rated.length >= MIN ? { key: 'rated', kind: 'rated', title: '高評価の定番', count: rated.length, href: '/ranking/', works: dailyWorks(rated, per, day, 'rated') } : null,
    sale: sale.length >= MIN ? { key: 'sale', kind: 'sale', title: 'セール', count: sale.length, href: '/sale/', works: dailyWorks(sale, per, day, 'sale') } : null,
    new: catalog.works.length >= MIN ? { key: 'new', kind: 'new', title: '新入荷', count: catalog.recent(per).length, href: '/new/', works: catalog.recent(per) } : null,
  };
  // 並びの型。g: ジャンル、a: 出演者、s: シリーズ。足りない枠は後ろのジャンルで埋める
  const pattern = ['new', 'g', 'a', 's', 'g', 'rated', 'a', 'g', 'sale', 's', 'a', 'g'] as const;
  const queues = { g: genres.slice(0, 4), a: actresses, s: series };
  const spare = genres.slice(4);
  const out: ShelfDef[] = [];
  for (const p of pattern) {
    const next = p === 'g' || p === 'a' || p === 's' ? queues[p].shift() : fixed[p];
    if (next) out.push(next);
  }
  while (out.length < STROLL_SHELVES && spare.length > 0) out.push(spare.shift()!);
  return out.slice(0, STROLL_SHELVES);
}

/**
 * 「隣の棚へ」: 同じ軸の中で作品数が近いものを、自分の前後から n 件（既定 4。前後 2 件ずつ）。
 * 端にいるときは反対側から足す。並びは作品数の多い順で、返す順も同じ（多い棚 → 少ない棚）
 */
export function neighborRefs(index: Map<string, CatalogWork[]>, names: Map<string, string>, id: string, n = 4): RefItem[] {
  const ranked = rankRefs(index, names);
  const i = ranked.findIndex((r) => r.id === id);
  if (i < 0) return [];
  // 自分を含む n + 1 件の窓を、自分が真ん中に来るように置き、端では内側へずらす
  const start = Math.max(0, Math.min(i - Math.floor(n / 2), ranked.length - (n + 1)));
  return ranked.slice(start, start + n + 1).filter((r) => r.id !== id);
}

/** config/featured.json の items から、作品 ID → 運営者の一言 の表を作る（空の一言・壊れた値は飛ばす） */
export function commentMap(config: { items?: { id?: unknown; comment?: unknown }[] } | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of Array.isArray(config?.items) ? config.items : []) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const c = typeof item?.comment === 'string' ? item.comment.trim() : '';
    if (id && c && !out.has(id)) out.set(id, c);
  }
  return out;
}

/** 棚に添える運営者の一言（POP）。棚の作品のうち、一言が付いた最初の作品のもの。無ければ null */
export function shelfPop(works: readonly CatalogWork[], comments: Map<string, string>): string | null {
  for (const w of works) {
    const c = comments.get(w.contentId);
    if (c) return c;
  }
  return null;
}
