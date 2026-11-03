/**
 * FANZA API の取り込み処理（差分更新）。cli.ts はここから呼ぶ。
 * - ingestWindow / ingestRecent: 期間の窓で新着・更新を取り込む（窓の分割は ingest-windows.ts）
 * - refreshExisting: active の作品を1件ずつ再取得して更新し、配信終了（gone）を判定する
 * - ingestRanked: 人気順（sort=rank）の上位を取り込み、順位を付ける
 * - ingestSynthetic: API を使わず合成データを入れる（開発・テスト用）
 * どの関数も処理後に meta の last_ingest_at を更新する。ログは onProgress で渡し、console には出さない。
 * 例外は握りつぶさず上に投げる（途中までに upsert した分は残る）。
 */
import type { Db } from './db.ts';
import { normalizeItems } from './normalize.ts';
import { syntheticItemList } from './synthetic.ts';
import { MAX_OFFSET, ingestWindow, secondsToApiDate, upsertInChunks } from './ingest-windows.ts';
import type { IngestClient, IngestProgress, WindowResult } from './ingest-windows.ts';

export { ingestWindow };
export type { IngestClient, IngestProgress, WindowResult };

/** 各関数に共通の任意オプション（now は時計の差し替え用、onProgress はログの受け口） */
type Common = { now?: () => Date; onProgress?: (info: IngestProgress) => void };
const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 3_600_000;

function checkInt(name: string, v: unknown, min: number): void {
  if (!Number.isInteger(v) || (v as number) < min) throw new RangeError(`${name} は ${min} 以上の整数で指定してください: ${String(v)}`);
}

/**
 * 今日から days 日前〜今日の窓で ingestWindow を呼ぶ。API の日時のタイムゾーンは未確認（docs/03）なので、
 * UTC と JST のどちらで解釈されても取りこぼさないよう、始点は UTC の日付、終点は JST の日付から決めて広めに取る。
 * 重なった分は upsert が上書きするだけで害はない。
 */
export async function ingestRecent(
  client: IngestClient, db: Db, opts: Common & { days: number; hits?: number },
): Promise<WindowResult> {
  checkInt('days', opts.days, 0);
  const t = (opts.now ?? (() => new Date()))().getTime();
  const utcDay = Math.floor(t / DAY_MS) * DAY_MS;
  const jstDay = Math.floor((t + JST_OFFSET_MS) / DAY_MS) * DAY_MS; // JST の今日の 0 時（UTC として表した値）
  return ingestWindow(client, db, {
    gteDate: secondsToApiDate((utcDay - opts.days * DAY_MS) / 1000),
    lteDate: secondsToApiDate((jstDay + DAY_MS) / 1000 - 1),
    hits: opts.hits, onProgress: opts.onProgress, now: opts.now,
  });
}

/**
 * active の作品を cid 指定で1件ずつ再取得する（limit で上限。content_id 昇順の先頭から）。
 * 返ってきた作品は upsert、resultCount が 0 の作品は gone 候補にして、最後に markGone する。
 * markGone には「gone 候補以外の active 全ID」を渡す（limit で確認しなかった作品を巻き込まないため）。
 * 安全装置: 1件も存在を確認できなかったとき（API 全滅の疑い）は markGone を呼ばない。
 */
export async function refreshExisting(
  client: IngestClient, db: Db, opts: Common & { limit?: number } = {},
): Promise<{ checked: number; updated: number; gone: number }> {
  if (opts.limit !== undefined) checkInt('limit', opts.limit, 0);
  const now = opts.now ?? (() => new Date());
  const notify = opts.onProgress ?? (() => {});
  const activeIds = db.listWorks({ status: 'active' }).map((w) => w.contentId);
  const targets = activeIds.slice(0, opts.limit); // limit 未指定なら全件
  const goneIds = new Set<string>();
  let confirmed = 0; // 存在を確認できた件数
  let updated = 0;
  for (const [i, cid] of targets.entries()) {
    const res = await client.itemList({ cid, hits: 1 });
    if (res.items.length > 0) {
      confirmed += 1;
      updated += upsertInChunks(db, normalizeItems(res.items, { fetchedAt: now().toISOString() }));
    } else if (res.resultCount === 0) {
      goneIds.add(cid); // 件数と items が食い違う異常な応答は、gone 候補にも確認済みにも数えない
    }
    if ((i + 1) % 100 === 0) notify({ kind: 'check', message: `再取得 ${i + 1} / ${targets.length} 件` });
  }
  let gone = 0;
  if (confirmed > 0) {
    gone = db.markGone(activeIds.filter((id) => !goneIds.has(id)), now().toISOString());
  } else if (goneIds.size > 0) {
    notify({ kind: 'warn', message: `存在を確認できた作品が 0 件のため、gone 候補 ${goneIds.size} 件は更新しません（API 障害の疑い）` });
  }
  db.setMeta('last_ingest_at', now().toISOString());
  notify({ kind: 'done', message: `再取得完了: 確認 ${targets.length} 件、更新 ${updated} 件、gone ${gone} 件` });
  return { checked: targets.length, updated, gone };
}

/**
 * sort=rank を offset 1 から pages ページ取得し、items を upsert して順位（1 始まり）を付ける。
 * 順位は offset + ページ内の位置（欠けたページがなければ通し番号と同じ）。同じ作品が複数ページに出たら先の順位を採る。
 * total や offset の上限（既定 5000）を超える先は取りに行かない。
 */
export async function ingestRanked(
  client: IngestClient, db: Db, opts: Common & { pages: number; hits?: number; maxOffset?: number },
): Promise<{ ranked: number }> {
  checkInt('pages', opts.pages, 1);
  const hits = opts.hits ?? 100;
  const maxOffset = opts.maxOffset ?? MAX_OFFSET;
  const now = opts.now ?? (() => new Date());
  const notify = opts.onProgress ?? (() => {});
  const seen = new Set<string>();
  let cleared = false; // 最初のページが取れた時点で古い順位を消す（取得失敗時に順位を失わないため）
  for (let p = 0; p < opts.pages; p++) {
    const offset = 1 + p * hits;
    if (offset > maxOffset) {
      notify({ kind: 'warn', message: `offset の上限 ${maxOffset} を超えるため、${p} ページで打ち切ります` });
      break;
    }
    const page = await client.itemList({ sort: 'rank', hits, offset });
    const works = normalizeItems(page.items, { fetchedAt: now().toISOString() });
    if (!cleared) { db.clearRankPositions(); cleared = true; }
    upsertInChunks(db, works);
    const entries: { contentId: string; rankPosition: number }[] = [];
    works.forEach((w, i) => {
      if (seen.has(w.contentId)) return;
      seen.add(w.contentId);
      entries.push({ contentId: w.contentId, rankPosition: offset + i });
    });
    db.setRankPositions(entries);
    notify({ kind: 'rank', message: `人気順 ${offset} 位から ${works.length} 件を取得（全 ${page.totalCount} 件）`, offset, totalCount: page.totalCount });
    if (works.length === 0 || offset + hits > page.totalCount) break; // 空ページ・末尾で止める
  }
  db.setMeta('last_ingest_at', now().toISOString());
  notify({ kind: 'done', message: `人気順の取り込み完了: ${seen.size} 件に順位を付けました` });
  return { ranked: seen.size };
}

/** API を使わず syntheticItemList で count 件を生成し、正規化して upsert する（開発・テスト用） */
export async function ingestSynthetic(
  db: Db, opts: Common & { count: number; seed?: number },
): Promise<{ upserted: number }> {
  checkInt('count', opts.count, 0);
  const now = opts.now ?? (() => new Date());
  const items: unknown[] = syntheticItemList({ count: opts.count, seed: opts.seed }).result.items;
  const upserted = upsertInChunks(db, normalizeItems(items, { fetchedAt: now().toISOString() }));
  db.setMeta('last_ingest_at', now().toISOString());
  opts.onProgress?.({ kind: 'done', message: `合成データ ${upserted} 件を保存しました` });
  return { upserted };
}
