/**
 * カタログ（data/export の読み込みと、ページ生成用の索引）。Astro のページ生成とテストの双方から使う。
 * Node 固有のAPI（node:fs / node:path）は loadCatalog の読み込み部分だけで使う。
 * 紹介文・レビュー本文にあたる項目は Work 型に無く、ここでも扱わない。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DerivedLabel, NamedRef, Work } from '../data/types.ts';
import { outboundUrl, rewriteAffiliateId, siteAffiliateId } from './links.ts';

/** works.json の1件と同じ形（Work に、派生ラベルと似た作品のID（近い順）を付けたもの） */
/** outboundUrl は「FANZAで見る」の移動先（links.ts の outboundUrl。null ならボタンを出さない）。読み込み時に計算する */
export type CatalogWork = Work & { derivedLabels: DerivedLabel[]; similarIds: string[]; outboundUrl: string | null };

export type CatalogMeta = {
  rankings: { byRating: string[]; byRecent: string[]; byPopularity: string[] } | null;
  todays: string[] | null;
  lastIngestAt: string | null;
  lastDeriveAt: string | null;
  generatedAt: string | null;
};

/** 出演者プロフィール（ActressSearch API 由来。顔写真のURLは持たない）。src/data/types.ts の同名型と同じ形 */
export type ActressProfile = {
  id: string; name: string; ruby: string | null; birthday: string | null; bloodType: string | null;
  hobby: string | null; prefectures: string | null; height: number | null; bust: number | null;
  waist: number | null; hip: number | null; cup: string | null; listUrl: string | null; fetchedAt: string | null;
};

/** 索引のキーは各 NamedRef の id。値は配信開始日の降順（同じ日は時刻の降順。日付なしは末尾） */
export type Catalog = {
  works: CatalogWork[];
  byId: Map<string, CatalogWork>;
  byActress: Map<string, CatalogWork[]>;
  bySeries: Map<string, CatalogWork[]>;
  byMaker: Map<string, CatalogWork[]>;
  byGenre: Map<string, CatalogWork[]>;
  /** id から名前を引く表（同じ id の名前が違うときは、より新しい作品のものを採る） */
  refNames: { actress: Map<string, string>; series: Map<string, string>; maker: Map<string, string>; genre: Map<string, string> };
  meta: CatalogMeta;
  /** 出演者プロフィール（actresses.json が無ければ空） */
  actressProfiles: Map<string, ActressProfile>;
  recent(n: number): CatalogWork[];
  onSale(n?: number): CatalogWork[];
  byLabel(label: DerivedLabel, n?: number): CatalogWork[];
  similar(w: CatalogWork, n?: number): CatalogWork[];
  todays(n?: number): CatalogWork[];
};

/** 並べ替えの鍵。YYYY-MM-DD で始まる値はそのまま使い（同じ形式なら文字列順が時系列順）、null や日付として読めない値は '' */
const dateKey = (w: CatalogWork): string => {
  const s = typeof w.releasedAt === 'string' ? w.releasedAt.trim() : '';
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s : '';
};
/** 配信開始日の降順（同じ日は時刻の降順）。日付なしは末尾。鍵まで同じなら入力順のまま（安定ソート） */
function byDateDesc(a: CatalogWork, b: CatalogWork): number {
  const x = dateKey(a), y = dateKey(b);
  if (x === y) return 0;
  if (x === '') return 1;
  if (y === '') return -1;
  return x < y ? 1 : -1;
}

/** 先頭 n 件のコピー。n を省くと全件。負数や NaN は空 */
function take<T>(list: readonly T[], n?: number): T[] {
  return n === undefined ? list.slice() : list.slice(0, Math.max(0, Math.floor(n)));
}

/** works（並べ済み）を、pick が返す参照の id ごとに分ける。同じ作品に同じ id が2回あっても1回だけ入れる */
function indexBy(works: CatalogWork[], pick: (w: CatalogWork) => NamedRef[], names: Map<string, string>): Map<string, CatalogWork[]> {
  const index = new Map<string, CatalogWork[]>();
  for (const w of works) {
    const seen = new Set<string>();
    for (const ref of pick(w)) {
      if (!ref.id || seen.has(ref.id)) continue;
      seen.add(ref.id);
      if (!names.has(ref.id)) names.set(ref.id, ref.name);
      const list = index.get(ref.id);
      if (list) list.push(w); else index.set(ref.id, [w]);
    }
  }
  return index;
}

/**
 * 作品の配列からカタログを組み立てる（ファイルは読まない）。active の作品だけを対象にし、gone は除く。
 * contentId が重複したときは先のものを採る。works は入力順、各索引と recent などは配信開始日の降順。
 */
export function buildCatalog(input: CatalogWork[], meta: Partial<CatalogMeta> = {}): Catalog {
  const byId = new Map<string, CatalogWork>();
  for (const w of input) if (w.status !== 'gone' && !byId.has(w.contentId)) byId.set(w.contentId, w);
  const works = [...byId.values()];
  const sorted = [...works].sort(byDateDesc);

  const refNames = { actress: new Map<string, string>(), series: new Map<string, string>(), maker: new Map<string, string>(), genre: new Map<string, string>() };
  const byActress = indexBy(sorted, (w) => w.actresses, refNames.actress);
  const bySeries = indexBy(sorted, (w) => w.series, refNames.series);
  const byMaker = indexBy(sorted, (w) => w.makers, refNames.maker);
  const byGenre = indexBy(sorted, (w) => w.genres, refNames.genre);
  const labelIndex = new Map<DerivedLabel, CatalogWork[]>();
  for (const w of sorted) {
    for (const label of new Set(w.derivedLabels)) {
      const list = labelIndex.get(label);
      if (list) list.push(w); else labelIndex.set(label, [w]);
    }
  }

  const full: CatalogMeta = {
    rankings: meta.rankings ?? null, todays: meta.todays ?? null, lastIngestAt: meta.lastIngestAt ?? null,
    lastDeriveAt: meta.lastDeriveAt ?? null, generatedAt: meta.generatedAt ?? null,
  };
  /** ID の並びを作品に引き直す。存在しない ID（gone を含む）・重複・skip は飛ばす */
  const lookup = (ids: readonly string[] | null, skip?: string): CatalogWork[] => {
    const out: CatalogWork[] = [], seen = new Set<string>();
    for (const id of ids ?? []) {
      const w = byId.get(id);
      if (w && id !== skip && !seen.has(id)) { seen.add(id); out.push(w); }
    }
    return out;
  };
  const byLabel = (label: DerivedLabel, n?: number): CatalogWork[] => take(labelIndex.get(label) ?? [], n);
  return {
    works, byId, byActress, bySeries, byMaker, byGenre, refNames, meta: full, actressProfiles: new Map(),
    recent: (n) => take(sorted, n),
    onSale: (n) => byLabel('セール中', n),
    byLabel,
    similar: (w, n) => take(lookup(w.similarIds, w.contentId), n),
    todays: (n) => take(lookup(full.todays), n),
  };
}

const FILES = ['works.json', 'meta.json', 'index.json'] as const;
const GUIDE = 'npm run ingest -- --synthetic 3000 && npm run derive && npm run export';
const cache = new Map<string, Catalog>();

/** 読み込み結果のキャッシュを捨てる（テストや、開発サーバーでデータを入れ替えたときの再読込用） */
export function clearCatalogCache(): void {
  cache.clear();
}

function readJson(dir: string, name: string): unknown {
  const path = join(dir, name);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`${path} を読めません（${why}）。次のコマンドで作り直してください: ${GUIDE}`, { cause: e });
  }
}

const asStrings = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);
const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const ARRAY_KEYS = ['deliveries', 'sampleImages', 'campaigns', 'genres', 'actresses', 'series', 'makers', 'labels', 'directors', 'derivedLabels', 'similarIds'];

/** works.json の1件を検査する。contentId が無ければ形式不正。配列項目が欠けていれば空配列で補う */
function toWork(raw: unknown, i: number): CatalogWork {
  if (typeof raw !== 'object' || raw === null || typeof (raw as { contentId?: unknown }).contentId !== 'string') {
    throw new Error(`works.json の ${i} 件目に contentId がありません。次のコマンドで作り直してください: ${GUIDE}`);
  }
  const w: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of ARRAY_KEYS) if (!Array.isArray(w[key])) w[key] = [];
  // サイト用IDが設定されていれば、アフィリエイトURLとサンプル動画URLのIDを差し替える（未設定なら無変更）
  const siteId = siteAffiliateId();
  if (typeof w.affiliateUrl === 'string') w.affiliateUrl = rewriteAffiliateId(w.affiliateUrl, siteId);
  const sm = w.sampleMovie as { sizes?: Record<string, string> } | null | undefined;
  if (sm && typeof sm === 'object' && sm.sizes && typeof sm.sizes === 'object') {
    w.sampleMovie = { ...sm, sizes: Object.fromEntries(Object.entries(sm.sizes).map(([k, u]) => [k, typeof u === 'string' ? rewriteAffiliateId(u, siteId) : u])) };
  }
  w.outboundUrl = outboundUrl({ affiliateUrl: str(w.affiliateUrl), url: str(w.url) });
  return w as unknown as CatalogWork;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** actresses.json（任意）を読む。無い・壊れているときは空 Map（プロフィールなしで動く） */
function readProfiles(dir: string): Map<string, ActressProfile> {
  const out = new Map<string, ActressProfile>();
  if (!existsSync(join(dir, 'actresses.json'))) return out;
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'actresses.json'), 'utf8'));
    for (const r of Array.isArray(raw) ? raw : []) {
      const id = str(r?.id), name = str(r?.name);
      if (!id || !name) continue;
      out.set(id, {
        id, name, ruby: str(r.ruby), birthday: str(r.birthday), bloodType: str(r.bloodType), hobby: str(r.hobby),
        prefectures: str(r.prefectures), height: num(r.height), bust: num(r.bust), waist: num(r.waist), hip: num(r.hip),
        cup: str(r.cup), listUrl: str(r.listUrl), fetchedAt: str(r.fetchedAt),
      });
    }
  } catch { /* 壊れていても出演者ページは作れるので無視する */ }
  return out;
}

/**
 * data/export の works.json・meta.json・index.json を読んでカタログにする。
 * 出力先は opts.exportDir、無ければ環境変数 EXPORT_DIR、無ければ data/export（相対パスは process.cwd() 基準）。
 * 結果はプロセス内でキャッシュし、同じ出力先なら再読込しない（opts.force で再読込）。
 */
export function loadCatalog(opts: { exportDir?: string; force?: boolean } = {}): Catalog {
  const dir = resolve(process.cwd(), opts.exportDir || process.env.EXPORT_DIR || 'data/export');
  const hit = opts.force ? undefined : cache.get(dir);
  if (hit) return hit;

  const missing = FILES.filter((f) => !existsSync(join(dir, f)));
  if (missing.length > 0) {
    throw new Error(`カタログのデータが見つかりません（${dir} に ${missing.join('、')} がありません）。次のコマンドで作成してください: ${GUIDE}`);
  }
  const rawWorks = readJson(dir, 'works.json');
  if (!Array.isArray(rawWorks)) throw new Error(`${join(dir, 'works.json')} は作品の配列ではありません。次のコマンドで作り直してください: ${GUIDE}`);
  const rawMeta = readJson(dir, 'meta.json') as Record<string, unknown> | null;
  const index = readJson(dir, 'index.json') as Record<string, unknown> | null;
  const m = rawMeta && typeof rawMeta === 'object' ? rawMeta : {};
  const rk = m.rankings && typeof m.rankings === 'object' ? (m.rankings as Record<string, unknown>) : null;

  const catalog = buildCatalog(rawWorks.map(toWork), {
    rankings: rk ? { byRating: asStrings(rk.byRating) ?? [], byRecent: asStrings(rk.byRecent) ?? [], byPopularity: asStrings(rk.byPopularity) ?? [] } : null,
    todays: asStrings(m.todays),
    lastIngestAt: asString(m.last_ingest_at),
    lastDeriveAt: asString(m.last_derive_at),
    generatedAt: asString(index?.generatedAt),
  });
  catalog.actressProfiles = readProfiles(dir);
  cache.set(dir, catalog);
  return catalog;
}
