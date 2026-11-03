/**
 * 出演者プロフィール（ActressSearch）の取り込み。
 * works に出てくる出演者 id を1件ずつ actress_id 付きで問い合わせ、正規化して actress_profiles に保存する。
 * 顔写真（imageURL）は規約上使わないので、正規化の時点で捨てる。
 * 仮定: ActressSearch は actress_id で絞り込める（docs/03 の記述に基づく。実 API での確認は未了）。
 * 例外は握りつぶさず上に投げる（途中までに upsert した分は残る）。
 */
import type { Db } from './db.ts';
import type { IngestClient, IngestProgress } from './ingest-windows.ts';
import { syntheticActressList } from './synthetic.ts';
import type { ActressProfile } from './types.ts';

export type ActressIngestOptions = {
  ids?: string[]; hits?: number; onProgress?: (info: IngestProgress) => void; now?: () => Date;
};
export type ActressIngestResult = { requested: number; upserted: number; missing: number };

/** 空文字・空白のみ・null・undefined は null、それ以外は文字列にして前後の空白を除く */
function toText(v: unknown): string | null {
  if (v === null || v === undefined || typeof v === 'object') return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** 数値化できるものだけ数値にする（空文字・0 以下・非数は null） */
function toNum(v: unknown): number | null {
  const s = toText(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** listURL（{ digital, monthly, mono }）から、digital を優先して1つ選ぶ */
function pickListUrl(v: unknown): string | null {
  if (v === null || typeof v !== 'object') return toText(v);
  const o = v as Record<string, unknown>;
  return toText(o.digital) ?? toText(o.monthly) ?? toText(o.mono);
}

/** API の出演者1件を ActressProfile にする。id か name が無ければ null。imageURL は読まない */
export function normalizeActress(raw: unknown, fetchedAt: string): ActressProfile | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = toText(r.id), name = toText(r.name);
  if (id === null || name === null) return null;
  return {
    id, name, ruby: toText(r.ruby), birthday: toText(r.birthday), bloodType: toText(r.blood_type),
    hobby: toText(r.hobby), prefectures: toText(r.prefectures), height: toNum(r.height),
    bust: toNum(r.bust), waist: toNum(r.waist), hip: toNum(r.hip), cup: toText(r.cup),
    listUrl: pickListUrl(r.listURL), fetchedAt,
  };
}

/** works に出てくる出演者 id（重複なし、昇順） */
export function actressIdsInWorks(db: Db): string[] {
  const ids = new Set<string>();
  for (const w of db.listWorks()) for (const a of w.actresses) ids.add(String(a.id));
  return [...ids].sort();
}

/** 取り込み後の共通処理（保存と meta 更新） */
function save(db: Db, profiles: ActressProfile[], now: Date): number {
  const upserted = db.upsertActressProfiles(profiles);
  db.setMeta('last_actress_ingest_at', now.toISOString());
  return upserted;
}

/** ids 省略時は works の出演者全員。1件ずつ問い合わせ、該当 id の行だけ保存する */
export async function ingestActressProfiles(
  client: IngestClient, db: Db, opts: ActressIngestOptions = {},
): Promise<ActressIngestResult> {
  const now = (opts.now ?? (() => new Date()))();
  const ids = [...new Set(opts.ids ?? actressIdsInWorks(db))];
  const profiles: ActressProfile[] = [];
  let missing = 0;
  for (const [i, id] of ids.entries()) {
    const res = await client.actressSearch({ actress_id: id, hits: opts.hits });
    const found = res.list.map((x) => normalizeActress(x, now.toISOString())).find((p) => p?.id === id);
    if (found) profiles.push(found); else missing++;
    if ((i + 1) % 50 === 0) opts.onProgress?.({ kind: 'page', message: `出演者 ${i + 1}/${ids.length} 件を処理しました` });
  }
  const upserted = save(db, profiles, now);
  opts.onProgress?.({ kind: 'done', message: `出演者プロフィール ${upserted} 件を保存しました（該当なし ${missing} 件）` });
  return { requested: ids.length, upserted, missing };
}

/** API を使わず syntheticActressList で works の出演者全員分（または ids）を合成して保存する（開発・テスト用） */
export async function ingestSyntheticActressProfiles(
  db: Db, opts: Omit<ActressIngestOptions, 'hits'> & { seed?: number } = {},
): Promise<ActressIngestResult> {
  const now = (opts.now ?? (() => new Date()))();
  const ids = [...new Set(opts.ids ?? actressIdsInWorks(db))];
  const rows: unknown[] = syntheticActressList({ ids, seed: opts.seed }).result.actress;
  const profiles = rows.map((x) => normalizeActress(x, now.toISOString())).filter((p): p is ActressProfile => p !== null);
  const upserted = save(db, profiles, now);
  opts.onProgress?.({ kind: 'done', message: `合成の出演者プロフィール ${upserted} 件を保存しました` });
  return { requested: ids.length, upserted, missing: ids.length - upserted };
}
