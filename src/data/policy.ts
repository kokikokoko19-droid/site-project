/**
 * 掲載方針（docs/00 の 2026-11-15 の決定「案 A」）。config/publish.json の値で、サイトに出す作品を決める。
 * - 配信開始日が now から recentMonths か月以内の作品は全件
 * - それより前（配信開始日が無い作品を含む）は、レビュー minReviews 件以上のもの
 * - 別枠: 人気順の上位（rankPosition が数値。includeRanked）と、follow.json の出演者・シリーズ・メーカーの作品（includeFollowed）
 * - status が gone の作品は含めない
 * DB には全件が入っている前提で、derive と export がこの判定で絞る。月の数え方は日本時間の暦日。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FollowConfig } from './ingest-follow.ts';
import type { Work } from './types.ts';

export type PublishPolicy = { recentMonths: number; minReviews: number; includeRanked: boolean; includeFollowed: boolean };
export type PublishContext = { now: Date; follow: FollowConfig; policy: PublishPolicy };

/** 既定の設定ファイル（リポジトリ直下の config/publish.json） */
export const DEFAULT_PUBLISH_PATH = fileURLToPath(new URL('../../config/publish.json', import.meta.url));
export const DEFAULT_POLICY: PublishPolicy = { recentMonths: 3, minReviews: 20, includeRanked: true, includeFollowed: true };

const JST = 9 * 3_600_000;

/** JSON の値を検証して方針にする。欠けた項目は既定値、型が違えば例外（黙って全件公開・全件非公開にしない） */
export function parsePublishPolicy(raw: unknown): PublishPolicy {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('publish: オブジェクトで指定してください');
  const o = raw as Record<string, unknown>, out = { ...DEFAULT_POLICY };
  for (const k of ['recentMonths', 'minReviews'] as const) {
    if (o[k] === undefined) continue;
    if (!Number.isInteger(o[k]) || (o[k] as number) < 0) throw new TypeError(`publish: ${k} は 0 以上の整数で指定してください`);
    out[k] = o[k] as number;
  }
  for (const k of ['includeRanked', 'includeFollowed'] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'boolean') throw new TypeError(`publish: ${k} は true か false で指定してください`);
    out[k] = o[k] as boolean;
  }
  return out;
}

/** 方針を読む。ファイルが無ければ既定値（案 A） */
export function loadPublishPolicy(path: string = DEFAULT_PUBLISH_PATH): PublishPolicy {
  if (!existsSync(path)) return { ...DEFAULT_POLICY };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new SyntaxError(`publish: ${path} を JSON として読めません`); }
  return parsePublishPolicy(raw);
}

/** 直近枠の始まりの日（YYYY-MM-DD。日本時間の今日から recentMonths か月前。月末は丸める: 5/31 の 3 か月前は 2/28 か 2/29） */
export function recentSince(now: Date, months: number): string {
  const t = new Date(now.getTime() + JST); // 日本時間の日付を UTC の項目で読む
  const y = t.getUTCFullYear(), m = t.getUTCMonth() - months, d = t.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // さかのぼった月の末日
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
}

/** 判定関数を作る（follow の ID と境界日を先に求める。多数の作品を判定するときはこちら） */
export function publishFilter(ctx: PublishContext): (work: Work) => boolean {
  const { policy, follow } = ctx, since = recentSince(ctx.now, policy.recentMonths);
  const ids = (list: { id: string }[]) => new Set(list.map((e) => String(e.id)));
  const fa = ids(follow.actresses), fs = ids(follow.series), fm = ids(follow.makers);
  const hit = (refs: { id: string }[], set: Set<string>) => refs.some((r) => set.has(String(r.id)));
  return (w) => {
    if (w.status === 'gone') return false;
    const d = /^\d{4}-\d{2}-\d{2}/.test(w.releasedAt ?? '') ? (w.releasedAt as string).slice(0, 10) : null; // normalize で ISO にそろっている
    if (d !== null && d >= since) return true; // 配信開始前の作品も直近に含める
    if (w.reviewCount >= policy.minReviews) return true;
    if (policy.includeRanked && typeof w.rankPosition === 'number') return true;
    return policy.includeFollowed && (hit(w.actresses, fa) || hit(w.series, fs) || hit(w.makers, fm));
  };
}

/** 1 件の判定 */
export function isPublished(work: Work, ctx: PublishContext): boolean {
  return publishFilter(ctx)(work);
}
