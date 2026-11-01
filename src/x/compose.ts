/**
 * X 投稿の本文を組み立てる。本文は自動文（postText。末尾は " #PR"）で、URL 付きのときだけ末尾に作品ページの URL を足す。
 * 全体が POST_MAX（140）字を超えるときは、" #PR" と URL を残して本文側を「…」で切り詰める。ハッシュタグは #PR のみ。
 * 字数は UTF-16 の長さで数える。日本語は X では1字が2として数えられるので、140 字なら 280 を超えない。
 * URL は X 側では 23 字換算だが、ここでは実際の長さで数える（安全側）。
 */
import { postText } from '../lib/autotext.ts';
import type { CatalogWork } from '../lib/catalog.ts';

export const POST_MAX = 140;
const TAG = ' #PR';
/** 本文側に最低限残したい字数。URL が長くてこれを残せないときは組み立てない */
const MIN_BODY = 10;

/** max（UTF-16 の長さ）に収める。超えるときは末尾を「…」にする（サロゲートペアは割らない） */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** SITE_URL を整える（前後の空白と末尾のスラッシュを除く）。http(s) で始まる URL でなければ Error */
export function normalizeSiteUrl(raw: string): string {
  const site = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+\S*$/.test(site)) throw new Error('URL 付きの投稿には、http(s) で始まる SITE_URL が必要です');
  return site;
}

export function composePost(work: CatalogWork, opts: { withUrl: boolean; siteUrl: string }): string {
  const body = postText(work);
  const tail = opts.withUrl ? `\n${normalizeSiteUrl(opts.siteUrl)}/v/${encodeURIComponent(work.contentId)}/` : '';
  if (body.length + tail.length <= POST_MAX) return body + tail;

  const core = body.endsWith(TAG) ? body.slice(0, -TAG.length) : body;
  const room = POST_MAX - TAG.length - tail.length;
  if (room < MIN_BODY) throw new Error(`SITE_URL が長すぎて、本文を ${POST_MAX} 字に収められません（URL 部分が ${tail.length} 字）`);
  return `${clip(core, room)}${TAG}${tail}`;
}
