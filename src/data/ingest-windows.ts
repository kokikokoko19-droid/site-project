/**
 * FANZA API の取り込み（差分更新）のうち、期間の窓で全件を取る部分。
 * ItemList は offset に上限（既定 5000。環境変数 FANZA_MAX_OFFSET）があるので、取り切れない件数の期間は、日付の中点で窓を2分割して取る。
 * 作品データは実行時に API から取得して正規化し、db に入れるだけ（保存はキャッシュ設計に従う）。
 * ログは console ではなく onProgress で呼び出し側へ渡す。例外は握りつぶさず上に投げる。
 */
import { resolveMaxOffset } from './api.ts';
import type { createClient } from './api.ts';
import type { Db } from './db.ts';
import { normalizeItems } from './normalize.ts';
import type { Work } from './types.ts';

/** createClient の戻り値型（テストでは fetch を差し替えたクライアントを渡す） */
export type IngestClient = ReturnType<typeof createClient>;

/** 進捗・警告の通知。message はそのままログに出せる日本語の文 */
export type IngestProgress = {
  kind: 'page' | 'split' | 'warn' | 'check' | 'rank' | 'done';
  message: string;
  gteDate?: string; lteDate?: string; offset?: number; totalCount?: number;
};
export type WindowOptions = {
  gteDate: string; lteDate: string; hits?: number;
  onProgress?: (info: IngestProgress) => void; now?: () => Date;
  /** offset の上限（省略時は MAX_OFFSET） */
  maxOffset?: number;
};
/** windows は実際に取り込んだ窓の数（分割した親の窓は数えない） */
export type WindowResult = { fetched: number; upserted: number; windows: number };

/** offset の上限。環境変数 FANZA_MAX_OFFSET で変えられる（既定 5000。旧仕様に戻すなら 50000） */
export const MAX_OFFSET = resolveMaxOffset();
const UPSERT_CHUNK = 100;        // db.upsertWorks に一度に渡す最大件数
const DAY_SECONDS = 86400;

/** epoch 秒を API 形式 "YYYY-MM-DDTHH:MM:SS"（タイムゾーンなし）にする */
export function secondsToApiDate(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 19);
}

/** API 形式の日時を、UTC として読んだ epoch 秒にする（中点の計算を実行環境のタイムゾーンに左右させない） */
export function apiDateToSeconds(s: string): number {
  const ms = Date.parse(`${s}Z`);
  // 形式違い・存在しない日付（2月30日など）は、API 形式に戻すと元の文字列にならないので弾く
  if (!Number.isFinite(ms) || secondsToApiDate(ms / 1000) !== s) {
    throw new RangeError(`日時は YYYY-MM-DDTHH:MM:SS 形式の実在する日時で指定してください: ${s}`);
  }
  return ms / 1000;
}

/** 窓（両端を含む）を中点で2つに分ける。後半は中点の1秒後から始め、重ならず隙間も出ないようにする */
export function splitWindow(gteDate: string, lteDate: string): [[string, string], [string, string]] {
  const mid = Math.floor((apiDateToSeconds(gteDate) + apiDateToSeconds(lteDate)) / 2);
  return [[gteDate, secondsToApiDate(mid)], [secondsToApiDate(mid + 1), lteDate]];
}

/** 作品を UPSERT_CHUNK 件ずつ db に入れ、処理した件数を返す */
export function upsertInChunks(db: Db, works: Work[]): number {
  let n = 0;
  for (let i = 0; i < works.length; i += UPSERT_CHUNK) n += db.upsertWorks(works.slice(i, i + UPSERT_CHUNK));
  return n;
}

/** offset を 1, 1+hits, … と上限以下で進めたときに取れる最大件数 */
export function fetchCapacity(maxOffset: number, hits: number): number {
  return (Math.floor((maxOffset - 1) / hits) + 1) * hits;
}

/**
 * 期間 [gteDate, lteDate]（両端を含む）の作品を sort=date で先頭から全件取り込む。
 * 最初の応答の totalCount が offset 上限で取り切れない件数なら窓を中点で2分割して再帰する（1日以下の窓は分割せず、
 * 取れる範囲だけ取って警告を通知する）。offset は 1 始まりで hits ずつ進め、上限を超えない。
 */
export async function ingestWindow(client: IngestClient, db: Db, opts: WindowOptions): Promise<WindowResult> {
  const hits = opts.hits ?? 100;
  const maxOffset = opts.maxOffset ?? MAX_OFFSET;
  const capacity = fetchCapacity(maxOffset, hits);
  const now = opts.now ?? (() => new Date());
  const notify = opts.onProgress ?? (() => {});
  if (apiDateToSeconds(opts.gteDate) > apiDateToSeconds(opts.lteDate)) {
    throw new RangeError('gteDate は lteDate 以前の日時で指定してください');
  }
  const stats: WindowResult = { fetched: 0, upserted: 0, windows: 0 };

  // 1つの窓を取り込む。最初の応答で件数を見て、多すぎれば分割して再帰する（その応答の items は使わない）
  async function walk(gteDate: string, lteDate: string): Promise<void> {
    const query = { sort: 'date', gte_date: gteDate, lte_date: lteDate, hits } as const;
    let page = await client.itemList({ ...query, offset: 1 });
    const total = page.totalCount;
    const range = `${gteDate}〜${lteDate}`;
    if (total > capacity) {
      if (apiDateToSeconds(lteDate) - apiDateToSeconds(gteDate) > DAY_SECONDS) {
        notify({ kind: 'split', message: `${range} は ${total} 件あるため、中点で2分割します`, gteDate, lteDate, totalCount: total });
        const [left, right] = splitWindow(gteDate, lteDate);
        await walk(...left);
        await walk(...right);
        return;
      }
      notify({
        kind: 'warn', gteDate, lteDate, totalCount: total,
        message: `${range} は1日以下でも ${total} 件あり分割できないため、先頭 ${capacity} 件までを取り込みます`,
      });
    }
    stats.windows += 1;
    let offset = 1;
    for (;;) {
      stats.fetched += page.items.length;
      stats.upserted += upsertInChunks(db, normalizeItems(page.items, { fetchedAt: now().toISOString() }));
      notify({ kind: 'page', message: `${range}: ${offset} 件目から ${page.items.length} 件を取得（全 ${total} 件）`, gteDate, lteDate, offset, totalCount: total });
      offset += hits;
      if (page.items.length === 0 || offset > maxOffset || offset > total) return; // 空ページ・offset 上限・末尾で止める
      page = await client.itemList({ ...query, offset });
    }
  }

  await walk(opts.gteDate, opts.lteDate);
  db.setMeta('last_ingest_at', now().toISOString());
  notify({ kind: 'done', message: `取り込み完了: ${stats.windows} 窓、取得 ${stats.fetched} 件、保存 ${stats.upserted} 件` });
  return stats;
}
