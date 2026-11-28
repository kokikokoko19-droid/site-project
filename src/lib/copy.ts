/**
 * 運営者の文（作品の一言・出演者の紹介）。置き場はリポジトリの外の Google スプレッドシート（docs/07 の 11 章）。
 * 流れ: scripts/fetch-copy.mjs が日次ビルドの前に取得し、ここの validateCopy で検査して data/copy.json に書く
 * （data/ は .gitignore 済み。コミットせず、cache にも入れない）→ ビルド中に loadCopy が 1 回だけ読む。
 * 取得した文は信用しない入力として扱う: 長さの上限、HTML タグ・URL・禁止語・ビルド検査の語を含む文は捨てる、
 * kind は work / actress だけ、id は英数と _ - だけ、同じ kind+id は後勝ち。表示は Astro の既定のエスケープに任せ、set:html は使わない。
 * 警告には kind・id・理由だけを出し、本文や禁止語そのものは出さない（ログに露骨な文を残さない）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadBannedWords } from './ai-text.ts';
import { loadCatalog } from './catalog.ts';

export type CopyKind = 'work' | 'actress';
export type CopyItem = { kind: CopyKind; id: string; text: string };
export type CopyWarning = { kind: string; id: string; reason: string };
export type CopyMaps = { work: Map<string, string>; actress: Map<string, string> };

/** 本文の長さの上限（文字数。サロゲートペアも 1 字） */
export const COPY_LIMITS: Readonly<Record<CopyKind, number>> = { work: 400, actress: 800 };
/** 1 回に受け付ける行数の上限（これを超えた分は読まない） */
export const MAX_ITEMS = 20000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** HTML のタグ・コメント・文字参照らしきもの */
const HTML = /<\s*\/?\s*[a-z!?][^>]*>|<!--|&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i;
/** URL らしきもの（スキームつき、www.、よくあるドメインの形）。照合は NFKC の後 */
const URL_LIKE = /\b(?:https?|ftp|javascript|data):|\/\/[a-z0-9]|\bwww\.|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|jp|co|io|me|info|xyz|tv|cc|ly|site|link|top|biz)\b/i;
/** scripts/check-dist.mjs が本文に出るとビルドを止める語（値漏れの検出）。運営者の文で日次が止まらないよう、先に捨てる */
const DIST_WORDS = /\bundefined\b|\bnull\b|\bNaN\b|\[object/;
const DIST_FUMEI = /不明/;
const DIST_FUMEI_OK = /ご不明|行方不明|正体不明|原因不明|生死不明|意識不明|安否不明|所在不明|身元不明/g;
/** 制御文字（改行とタブ以外）と、幅のない文字・書字方向の制御文字 */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤﻿]/g;

/** 照合用の正規化（全角半角・大文字小文字・空白や区切りの記号をそろえる。ai-text.ts と同じ） */
const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[\s​-‍﻿・._-]/g, '');

/** 本文を整える。改行を LF にそろえ、行末の空白を落とし、3 つ以上続く改行は 2 つ（段落の区切り）にする */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .split('\n').map((l) => l.replace(/[ \t　]+$/u, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 段落に分ける（改行 2 つで区切る）。段落の中の改行 1 つはそのまま残す（表示側で white-space: pre-line） */
export function paragraphs(text: string): string[] {
  return text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p !== '');
}

/** 1 件の本文の検査。捨てる理由（無ければ null）を返す */
export function rejectReason(kind: CopyKind, text: string, bannedWords: readonly string[]): string | null {
  if (text === '') return '本文が空';
  const len = [...text].length;
  if (len > COPY_LIMITS[kind]) return `長すぎる（${len} 字。上限 ${COPY_LIMITS[kind]} 字）`;
  const n = text.normalize('NFKC');
  if (HTML.test(n)) return 'HTML のタグか文字参照を含む';
  if (URL_LIKE.test(n)) return 'URL を含む';
  const key = norm(text);
  for (const w of bannedWords) {
    const k = norm(w);
    if (k !== '' && key.includes(k)) return '禁止語を含む'; // 語そのものは出さない
  }
  if (DIST_WORDS.test(n) || DIST_FUMEI.test(n.replace(DIST_FUMEI_OK, ''))) return 'ビルドの検査で止まる語（undefined・null・NaN・不明など）を含む';
  return null;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/**
 * 取得した JSON（{ items: [{ kind, id, text }] }、または items の配列そのもの）を検査して、使える項目だけを返す。
 * 空行（kind・id・text がすべて空）は黙って飛ばす。同じ kind+id が複数あれば後の行を採る（後の行が捨てられたら、前の行も使わない）。
 * known を渡すと、カタログに無い id を無視する（警告は件数だけ）。
 */
export function validateCopy(
  raw: unknown,
  opts: { bannedWords: readonly string[]; known?: { work: (id: string) => boolean; actress: (id: string) => boolean } },
): { items: CopyItem[]; warnings: CopyWarning[]; unknown: number } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : null;
  if (!list) throw new Error('items の配列がありません');
  const warnings: CopyWarning[] = [];
  const byKey = new Map<string, CopyItem | null>();
  for (const row of list.slice(0, MAX_ITEMS)) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const kind = asString(r.kind).trim().toLowerCase();
    const id = asString(r.id).trim();
    const text = cleanText(asString(r.text));
    if (kind === '' && id === '' && text === '') continue;
    const shownId = ID.test(id) ? id : '(不正な id)';
    if (kind !== 'work' && kind !== 'actress') { warnings.push({ kind: kind.slice(0, 20) || '(空)', id: shownId, reason: 'kind は work か actress' }); continue; }
    if (!ID.test(id)) { warnings.push({ kind, id: shownId, reason: 'id は英数と _ - だけ（64 字まで）' }); continue; }
    const key = `${kind}:${id}`;
    const reason = rejectReason(kind, text, opts.bannedWords);
    if (reason) { warnings.push({ kind, id, reason }); byKey.delete(key); byKey.set(key, null); continue; }
    byKey.delete(key); // 後勝ち（並びも後の行の位置にする）
    byKey.set(key, { kind, id, text });
  }
  let unknown = 0;
  const items: CopyItem[] = [];
  for (const it of byKey.values()) {
    if (!it) continue;
    if (opts.known && !opts.known[it.kind](it.id)) { unknown++; continue; }
    items.push(it);
  }
  if (list.length > MAX_ITEMS) warnings.push({ kind: '-', id: '-', reason: `行が多すぎる（先頭 ${MAX_ITEMS} 行だけ読んだ）` });
  return { items, warnings, unknown };
}

/** 項目の配列を kind ごとの表にする */
export function toMaps(items: readonly CopyItem[]): CopyMaps {
  const out: CopyMaps = { work: new Map(), actress: new Map() };
  for (const it of items) out[it.kind].set(it.id, it.text);
  return out;
}

/** data/copy.json の場所。opts.path、無ければ環境変数 DATA_DIR（既定 data）の下の copy.json（相対パスは process.cwd() 基準） */
export function copyPath(path?: string): string {
  return resolve(process.cwd(), path || join(process.env.DATA_DIR || 'data', 'copy.json'));
}

/** config/banned-words.json（cwd 基準） */
export function defaultBannedWords(): string[] {
  return loadBannedWords(resolve(process.cwd(), 'config/banned-words.json'));
}

/** カタログ（data/export）にある作品と出演者で id を判定する。カタログが読めなければ判定しない */
function catalogKnown(): { work: (id: string) => boolean; actress: (id: string) => boolean } | undefined {
  try {
    const c = loadCatalog();
    return { work: (id) => c.byId.has(id), actress: (id) => c.byActress.has(id) };
  } catch {
    return undefined;
  }
}

const cache = new Map<string, CopyMaps>();
export function clearCopyCache(): void {
  cache.clear();
}

/**
 * ビルド中に運営者の文を読む。ファイルが無い・読めないときは空（警告だけ出してビルドは続ける）。
 * 読むときにも検査し直す（手で置いたファイルでも同じ規則を通す）。カタログに無い id は無視する
 * （known を省くと loadCatalog() の作品と出演者で判定。known: null で判定しない）。
 * 結果はプロセス内でキャッシュし、同じパスなら再読込しない（opts.force で再読込）。
 */
export function loadCopy(opts: {
  path?: string; force?: boolean; bannedWords?: readonly string[];
  known?: { work: (id: string) => boolean; actress: (id: string) => boolean } | null;
} = {}): CopyMaps {
  const file = copyPath(opts.path);
  const hit = opts.force ? undefined : cache.get(file);
  if (hit) return hit;
  let maps: CopyMaps = { work: new Map(), actress: new Map() };
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const known = opts.known === undefined ? catalogKnown() : opts.known ?? undefined;
      const r = validateCopy(raw, { bannedWords: opts.bannedWords ?? defaultBannedWords(), known });
      for (const w of r.warnings) console.warn(`[copy] ${w.kind} ${w.id}: ${w.reason}`);
      if (r.unknown > 0) console.warn(`[copy] カタログに無い id を ${r.unknown} 件無視しました`);
      maps = toMaps(r.items);
    } catch (e) {
      console.warn(`[copy] ${file} を読めませんでした（${(e as Error).message}）。運営者の文なしで続けます`);
    }
  }
  cache.set(file, maps);
  return maps;
}
