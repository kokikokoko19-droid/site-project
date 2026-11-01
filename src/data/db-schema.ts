/**
 * SQLite のスキーマ定義と、Work と行データの相互変換（参照の読み込みを含む）。
 * db.ts から使う内部モジュール。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Campaign, Delivery, NamedRef, SampleMovie, Work, WorkStatus } from './types.ts';

/** node:sqlite にバインドできる値（undefined と boolean は渡せないので使わない） */
export type SqlValue = string | number | null;

/** refs.kind の取りうる値 */
export type RefKind = 'genre' | 'actress' | 'series' | 'maker' | 'label' | 'director';

/** refs.kind と Work のプロパティ名の対応（保存と組み立ての両方で使う） */
export const REF_PROPS = [
  ['genre', 'genres'], ['actress', 'actresses'], ['series', 'series'],
  ['maker', 'makers'], ['label', 'labels'], ['director', 'directors'],
] as const;

/** 作品ごとの参照を種別別に持つ入れ物 */
export type RefMap = Record<RefKind, NamedRef[]>;

export const emptyRefs = (): RefMap => ({
  genre: [], actress: [], series: [], maker: [], label: [], director: [],
});

/** refs と work_refs を結合した1行 */
export type RefJoinRow = {
  content_id: string; kind: RefKind; id: string; name: string; ruby: string | null;
};

/** works テーブルの1行（列名は DDL と同じ） */
export type WorkRow = {
  content_id: string; product_id: string | null; title: string;
  url: string | null; affiliate_url: string | null;
  volume_min: number | null; released_at: string | null;
  review_count: number; review_avg: number | null;
  price_min: number | null; list_price: number | null;
  deliveries_json: string | null;
  image_list: string | null; image_small: string | null; image_large: string | null;
  sample_images_json: string | null; sample_movie_json: string | null;
  campaigns_json: string | null; rank_position: number | null;
  fetched_at: string; status: WorkStatus; gone_at: string | null;
};

const KINDS = "'genre', 'actress', 'series', 'maker', 'label', 'director'";

/**
 * テーブルと索引の作成（何度実行しても安全）。
 * work_refs は upsertWorks の中でしか書かないので外部キーで整合を守る。
 * derived_labels と similar は外から渡されるIDを受けるため外部キーは付けず、purgeGone で明示的に消す。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS works (
  content_id TEXT PRIMARY KEY,
  product_id TEXT, title TEXT NOT NULL, url TEXT, affiliate_url TEXT,
  volume_min INTEGER, released_at TEXT,
  review_count INTEGER NOT NULL DEFAULT 0, review_avg REAL,
  price_min INTEGER, list_price INTEGER,
  deliveries_json TEXT, image_list TEXT, image_small TEXT, image_large TEXT,
  sample_images_json TEXT, sample_movie_json TEXT, campaigns_json TEXT,
  rank_position INTEGER, fetched_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'gone')),
  gone_at TEXT
);
CREATE TABLE IF NOT EXISTS refs (
  kind TEXT NOT NULL CHECK (kind IN (${KINDS})),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  ruby TEXT,
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS work_refs (
  content_id TEXT NOT NULL REFERENCES works(content_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (content_id, kind, ref_id),
  FOREIGN KEY (kind, ref_id) REFERENCES refs(kind, id)
);
CREATE TABLE IF NOT EXISTS derived_labels (
  content_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (content_id, label)
);
CREATE TABLE IF NOT EXISTS similar (
  content_id TEXT NOT NULL,
  similar_id TEXT NOT NULL,
  score REAL NOT NULL,
  PRIMARY KEY (content_id, similar_id)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_works_status ON works(status);
CREATE INDEX IF NOT EXISTS idx_works_released_at ON works(released_at);
CREATE INDEX IF NOT EXISTS idx_work_refs_kind_ref ON work_refs(kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_similar_similar_id ON similar(similar_id);
`;

/** upsert で値を渡す列（status と gone_at は常に 'active' / NULL に戻すので SQL 側で固定） */
const VALUE_COLUMNS = [
  'content_id', 'product_id', 'title', 'url', 'affiliate_url', 'volume_min', 'released_at',
  'review_count', 'review_avg', 'price_min', 'list_price', 'deliveries_json', 'image_list',
  'image_small', 'image_large', 'sample_images_json', 'sample_movie_json', 'campaigns_json',
  'rank_position', 'fetched_at',
] as const;

const OVERWRITE = VALUE_COLUMNS
  .filter((c) => c !== 'content_id' && c !== 'rank_position')
  .map((c) => `${c} = excluded.${c}`);

/** 作品の追加または更新。順位は新しい値が null のとき既存値を残す */
export const UPSERT_WORK_SQL = `
INSERT INTO works (${VALUE_COLUMNS.join(', ')}, status, gone_at)
VALUES (${VALUE_COLUMNS.map(() => '?').join(', ')}, 'active', NULL)
ON CONFLICT(content_id) DO UPDATE SET
  ${OVERWRITE.join(',\n  ')},
  rank_position = COALESCE(excluded.rank_position, works.rank_position),
  status = 'active',
  gone_at = NULL`;

/** Work を UPSERT_WORK_SQL のバインド値に変換する（列名で引くので並びの取り違えが起きない） */
export function workToParams(w: Work): SqlValue[] {
  const v: Record<(typeof VALUE_COLUMNS)[number], unknown> = {
    content_id: w.contentId, product_id: w.productId, title: w.title, url: w.url,
    affiliate_url: w.affiliateUrl, volume_min: w.volumeMin, released_at: w.releasedAt,
    review_count: w.reviewCount, review_avg: w.reviewAvg, price_min: w.priceMin,
    list_price: w.listPrice, deliveries_json: JSON.stringify(w.deliveries),
    image_list: w.imageList, image_small: w.imageSmall, image_large: w.imageLarge,
    sample_images_json: JSON.stringify(w.sampleImages),
    sample_movie_json: w.sampleMovie == null ? null : JSON.stringify(w.sampleMovie),
    campaigns_json: JSON.stringify(w.campaigns), rank_position: w.rankPosition,
    fetched_at: w.fetchedAt,
  };
  // 実行時に undefined が紛れても null として保存する
  return VALUE_COLUMNS.map((c) => (v[c] ?? null) as SqlValue);
}

function parseJson<T>(text: string | null, fallback: T): T {
  return text === null ? fallback : (JSON.parse(text) as T);
}

/** works の1行と参照から Work を組み立てる（JSON 列を復元し、null は null のまま返す） */
export function rowToWork(r: WorkRow, refs: RefMap): Work {
  return {
    contentId: r.content_id,
    productId: r.product_id,
    title: r.title,
    url: r.url,
    affiliateUrl: r.affiliate_url,
    volumeMin: r.volume_min,
    releasedAt: r.released_at,
    reviewCount: r.review_count,
    reviewAvg: r.review_avg,
    priceMin: r.price_min,
    listPrice: r.list_price,
    deliveries: parseJson<Delivery[]>(r.deliveries_json, []),
    imageList: r.image_list,
    imageSmall: r.image_small,
    imageLarge: r.image_large,
    sampleImages: parseJson<string[]>(r.sample_images_json, []),
    sampleMovie: parseJson<SampleMovie | null>(r.sample_movie_json, null),
    campaigns: parseJson<Campaign[]>(r.campaigns_json, []),
    genres: refs.genre,
    actresses: refs.actress,
    series: refs.series,
    makers: refs.maker,
    labels: refs.label,
    directors: refs.director,
    rankPosition: r.rank_position,
    fetchedAt: r.fetched_at,
    status: r.status,
  };
}

const REF_CHUNK = 500; // IN 句に渡す ID の上限（バインド変数の数の制限を避ける）

/** works の行に refs を結合して Work を組み立てる（各種別の中は position 順） */
export function loadWorks(db: DatabaseSync, rows: WorkRow[]): Work[] {
  const refs = new Map<string, RefMap>();
  for (let i = 0; i < rows.length; i += REF_CHUNK) {
    const ids = rows.slice(i, i + REF_CHUNK).map((r) => r.content_id);
    const found = db.prepare(`SELECT wr.content_id, wr.kind, r.id, r.name, r.ruby
      FROM work_refs wr JOIN refs r ON r.kind = wr.kind AND r.id = wr.ref_id
      WHERE wr.content_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY wr.content_id, wr.kind, wr.position`).all(...ids) as RefJoinRow[];
    for (const f of found) {
      let m = refs.get(f.content_id);
      if (!m) refs.set(f.content_id, (m = emptyRefs()));
      m[f.kind].push({ id: f.id, name: f.name, ruby: f.ruby });
    }
  }
  return rows.map((r) => rowToWork(r, refs.get(r.content_id) ?? emptyRefs()));
}
