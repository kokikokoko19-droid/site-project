/**
 * 指定した出演者・シリーズ・メーカーの全作品を取り込む（config/follow.json）。
 * 各 id について ItemList を article / article_id 付き・新しい順で offset を進めながら全件取得し、
 * 正規化して 100 件ごとに upsert する。offset の上限（50000）か total_count に達したら止める。
 * 例外は握りつぶさず上に投げる（途中までに upsert した分は残る）。
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Db } from './db.ts';
import { normalizeItems } from './normalize.ts';
import { MAX_OFFSET, upsertInChunks } from './ingest-windows.ts';
import type { IngestClient, IngestProgress } from './ingest-windows.ts';

export type FollowEntry = { id: string; name?: string };
export type FollowConfig = { actresses: FollowEntry[]; series: FollowEntry[]; makers: FollowEntry[] };

const AXES = [
  { key: 'actresses', article: 'actress', label: '出演者' },
  { key: 'series', article: 'series', label: 'シリーズ' },
  { key: 'makers', article: 'maker', label: 'メーカー' },
] as const;

const emptyConfig = (): FollowConfig => ({ actresses: [], series: [], makers: [] });

/** 設定オブジェクトを検証する。不正なら Error */
export function parseFollowConfig(raw: unknown): FollowConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('follow 設定はオブジェクトで指定してください');
  const obj = raw as Record<string, unknown>;
  const out = emptyConfig();
  for (const { key } of AXES) {
    const list = obj[key] ?? [];
    if (!Array.isArray(list)) throw new Error(`follow 設定の ${key} は配列で指定してください`);
    for (const [i, e] of list.entries()) {
      const id = (e as { id?: unknown } | null)?.id;
      if (e === null || typeof e !== 'object' || typeof id !== 'string' || !/^\d+$/.test(id)) {
        throw new Error(`follow 設定の ${key}[${i}] は { "id": "数字の文字列" } の形で指定してください`);
      }
      const name = (e as { name?: unknown }).name;
      out[key].push({ id, ...(typeof name === 'string' && { name }) });
    }
  }
  return out;
}

/** 設定ファイルを読む。存在しなければ空設定。JSON や形式が不正なら Error */
export function loadFollowConfig(path: string): FollowConfig {
  if (!existsSync(path)) return emptyConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`follow 設定を JSON として読めません（${path}）: ${(e as Error).message}`);
  }
  return parseFollowConfig(raw);
}

export async function ingestFollowed(
  client: IngestClient, db: Db,
  opts: { follow: FollowConfig; hits?: number; onProgress?: (info: IngestProgress) => void; now?: () => Date },
): Promise<{ axes: number; fetched: number; upserted: number }> {
  const hits = opts.hits ?? 100;
  const now = opts.now ?? (() => new Date());
  const notify = opts.onProgress ?? (() => {});
  let axes = 0, fetched = 0, upserted = 0;
  for (const { key, article, label } of AXES) {
    for (const entry of opts.follow[key]) {
      axes += 1;
      let offset = 1;
      while (offset <= MAX_OFFSET) {
        const page = await client.itemList({ article, article_id: entry.id, sort: 'date', hits, offset });
        const works = normalizeItems(page.items, { fetchedAt: now().toISOString() });
        fetched += works.length;
        upserted += upsertInChunks(db, works);
        notify({ kind: 'page', message: `${label} ${entry.id} ${offset} 件目から ${works.length} 件（全 ${page.totalCount} 件）`, offset, totalCount: page.totalCount });
        if (page.items.length === 0 || offset + hits > page.totalCount) break;
        offset += hits;
      }
      if (offset > MAX_OFFSET) notify({ kind: 'warn', message: `${label} ${entry.id} は offset の上限 ${MAX_OFFSET} に達したため打ち切ります` });
    }
  }
  if (axes > 0) db.setMeta('last_ingest_at', now().toISOString());
  notify({ kind: 'done', message: `指定軸の取り込み完了: ${axes} 軸、取得 ${fetched} 件、保存 ${upserted} 件` });
  return { axes, fetched, upserted };
}
