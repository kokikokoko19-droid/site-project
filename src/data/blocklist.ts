/**
 * 除外リスト（取り下げ対応）。config/blocklist.json に書いた作品・出演者を、export の出力から除く。
 * DB の作品データは消さない（依頼の撤回時に復帰できるようにするため）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Work } from './types.ts';

export type Blocklist = { contentIds: Set<string>; actressIds: Set<string>; reason: string };

/** 既定の設定ファイル（リポジトリ直下の config/blocklist.json。実行時の cwd に左右されない） */
export const DEFAULT_BLOCKLIST_PATH = fileURLToPath(new URL('../../config/blocklist.json', import.meta.url));

export const emptyBlocklist = (): Blocklist => ({ contentIds: new Set(), actressIds: new Set(), reason: '' });

/** 要素は "id" の文字列、数値、または { id, note? } のいずれか。id は文字列にそろえる */
function idsOf(v: unknown, key: string): Set<string> {
  if (v === undefined) return new Set();
  if (!Array.isArray(v)) throw new TypeError(`blocklist: ${key} は配列で指定してください`);
  const out = new Set<string>();
  for (const e of v) {
    const id = typeof e === 'object' && e !== null ? (e as { id?: unknown }).id : e;
    if ((typeof id !== 'string' && typeof id !== 'number') || String(id).trim() === '') {
      throw new TypeError(`blocklist: ${key} の要素には id が必要です`);
    }
    out.add(String(id).trim());
  }
  return out;
}

/** JSON のテキストを除外リストにする。形式が不正なら例外（取り下げの漏れを黙って通さない） */
export function parseBlocklist(text: string): Blocklist {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SyntaxError('blocklist: JSON として読めません'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('blocklist: オブジェクトで指定してください');
  const o = raw as Record<string, unknown>;
  return {
    contentIds: idsOf(o.contentIds, 'contentIds'),
    actressIds: idsOf(o.actressIds, 'actressIds'),
    reason: typeof o.reason === 'string' ? o.reason : '',
  };
}

/** 除外リストを読む。ファイルが無ければ空のリスト */
export function loadBlocklist(path: string = DEFAULT_BLOCKLIST_PATH): Blocklist {
  if (!existsSync(path)) return emptyBlocklist();
  return parseBlocklist(readFileSync(path, 'utf8'));
}

/** contentId が一致する、または出演者 id のいずれかが一致する作品は除外対象 */
export function isBlocked(work: Pick<Work, 'contentId' | 'actresses'>, blocklist: Blocklist): boolean {
  if (blocklist.contentIds.has(work.contentId)) return true;
  return work.actresses.some((a) => blocklist.actressIds.has(String(a.id)));
}
