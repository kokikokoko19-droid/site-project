/**
 * AI が書く非露骨の短い文（週次の「運営者から」、特集の導入文）の、検査とテンプレートへの差し替え。
 * 流れ: LLM に頼む → 検査（禁止語・文の数・与えていない数字・題名やジャンル名の混入）→ 落ちたら数字だけの定型文に差し替える。
 * LLM が使えない（キーなし・失敗）ときも同じ定型文になる。性的に露骨な語は生成せず、保存しない。
 */
import { readFileSync } from 'node:fs';
import { askClaude } from './llm.ts';
import type { AskOptions } from './llm.ts';
import { REVIEW_OVER, HIGH_NEW_AVG, factsText, updatedLabel } from './weekly-stats.ts';
import type { TopRef, WeeklyStats } from './weekly-stats.ts';

/** 文章の種類ごとの system プロンプトに共通する決まり */
const COMMON_RULES = [
  '日本語で書く。',
  '一人称の運営者（サイトを運営している個人）の声で、落ち着いた丁寧な文体にする。',
  '作品名（題名）・ジャンル名・性的な語は書かない。年齢を連想させる語も書かない。',
  '与えられた事実の数字以外の事実（数字・日付・固有名詞・出来事）を書かない。数字は与えられた表記のまま使い、年は書かない。',
  '誇張・断定・煽る表現は使わない。箇条書き・見出し・記号による装飾は使わず、地の文だけで書く。',
  '前置き・説明・引用符は付けず、本文だけを出力する。',
];

/** 週次の「運営者から」の system プロンプト（固定） */
export const WEEKLY_SYSTEM = [
  'あなたは、作品カタログサイト「AVめぐり」の運営者として、トップページに載せる「運営者から」の短い文を書く。',
  ...COMMON_RULES,
  '3〜5 文で書く。',
  '今週のデータの動き（与えられた事実）を、読み手が作品を探す助けになる形で伝える。',
  '最後の 1 文で、サイトの使い方を 1 つだけ紹介する（探索ページで評価やセールの有無で絞り込める、など。与えられた事実に使い方が無くてもよい）。',
].join('\n');

export type CheckOptions = {
  /** 禁止語（config/banned-words.json） */
  bannedWords: string[];
  /** 書いてはいけない文字列（題名・ジャンル名。2 文字以上のものだけ使う） */
  forbidden?: string[];
  /** 与えた事実の文面。ここに出てくる数字だけを許す */
  facts: string;
  minSentences: number;
  maxSentences: number;
};

export type CheckResult = { ok: true } | { ok: false; reason: string };

/** 照合用の正規化（全角半角・大文字小文字・空白や区切りの記号をそろえる） */
const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[\s​-‍﻿・._-]/g, '');

/** 文に分ける（。！？ で区切る） */
export function splitSentences(text: string): string[] {
  return text.trim().split(/(?<=[。！？!?])/u).map((s) => s.trim()).filter((s) => s !== '');
}

/** 数字の並び（小数を含む。カンマ区切りは外す）。2 桁以上のものだけが検査の対象 */
export function numberTokens(text: string): string[] {
  const t = text.normalize('NFKC').replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  return t.match(/\d+(?:\.\d+)?/g) ?? [];
}

const digits = (token: string): number => token.replace('.', '').length;

/** 文の検査。落ちたときは理由を返す */
export function checkText(text: string, o: CheckOptions): CheckResult {
  const t = text.trim();
  if (t === '') return { ok: false, reason: '本文が空' };
  const n = norm(t);
  for (const w of o.bannedWords) {
    const k = norm(w);
    if (k !== '' && n.includes(k)) return { ok: false, reason: '禁止語を含む' }; // 語そのものは出さない
  }
  for (const f of o.forbidden ?? []) {
    const k = norm(f);
    if (k.length >= 2 && n.includes(k)) return { ok: false, reason: '題名またはジャンル名を含む' };
  }
  const count = splitSentences(t).length;
  if (count < o.minSentences || count > o.maxSentences) return { ok: false, reason: `文の数が範囲外（${count} 文）` };
  const allowed = new Set(numberTokens(o.facts));
  for (const tok of numberTokens(t)) {
    if (digits(tok) >= 2 && !allowed.has(tok)) return { ok: false, reason: `与えていない数字を含む（${tok}）` };
  }
  if (/不明|null|undefined|NaN|https?:/i.test(t)) return { ok: false, reason: '「不明」やURLなどの不適切な語を含む' };
  if (/^\s*([#>*\-・]|\d+[.)])\s/m.test(t)) return { ok: false, reason: '見出しや箇条書きを含む' };
  return { ok: true };
}

/** config/banned-words.json を読む。値が文字列の配列であるキーをすべて集める（先頭が `_` のキーは説明）。無ければ空 */
export function loadBannedWords(path: string): string[] {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  const json = JSON.parse(raw) as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, v] of Object.entries(json)) {
    if (key.startsWith('_') || !Array.isArray(v)) continue;
    for (const w of v) if (typeof w === 'string' && w.trim() !== '') out.push(w.trim());
  }
  return out;
}

export type Generated = { text: string; source: 'llm' | 'template'; /** テンプレートに切り替えた理由（キーなしは null） */ reason: string | null };

export type GenerateOptions = {
  system: string;
  /** 事実の一覧（LLM に渡す。検査で許す数字の元でもある） */
  facts: string;
  /** user メッセージの先頭に付ける依頼文 */
  request: string;
  /** API を使わない（または検査に落ちた）ときの文 */
  template: string;
  check: Omit<CheckOptions, 'facts'>;
  /** テストで fetch やキーを差し替える */
  llm?: Partial<Omit<AskOptions, 'system' | 'user'>>;
};

/** LLM（あれば）→ 検査 → 落ちたらテンプレート。例外にはしない */
export async function generateChecked(o: GenerateOptions): Promise<Generated> {
  const answer = await askClaude({ ...o.llm, system: o.system, user: `${o.request}\n\n${o.facts}` });
  if (answer === null) return { text: o.template, source: 'template', reason: null };
  const r = checkText(answer, { ...o.check, facts: o.facts });
  if (r.ok) return { text: answer.trim(), source: 'llm', reason: null };
  return { text: o.template, source: 'template', reason: r.reason };
}

/** 週次の依頼文 */
export const WEEKLY_REQUEST = '次の事実だけを使って、今週の「運営者から」を書いてください。';

// ---- 週次のテンプレート（API なしの既定）----

/** 基準日の週番号（1970-01-05 の月曜から数えた週。日付が読めなければ 0） */
export function weekIndex(asOf: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf);
  if (!m) return 0;
  return Math.floor((Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000 - 4) / 7);
}

type Key = 'new' | 'total' | 'sale' | 'review' | 'high' | 'top' | 'update';
const USAGE = [
  '探索ページでは、評価やセールの有無で作品を絞り込めます。',
  '気になる作品は、作品ページから似た作品までたどれます。',
  '探索ページの並べ替えを新着順にすると、今週の動きがそのまま見られます。',
];

/** 上位の名前の文。出演者・シリーズ・メーカーのうち、あるものだけを並べる */
function topSentence(v: number, s: WeeklyStats): string | null {
  const parts: [string, TopRef | undefined][] = [['出演者', s.topActresses[0]], ['シリーズ', s.topSeries[0]], ['メーカー', s.topMakers[0]]];
  const have = parts.filter((p): p is [string, TopRef] => p[1] !== undefined);
  if (have.length === 0) return null;
  const list = have.map(([kind, r]) => `${kind}は${r.name}（${r.count}作品）`).join('、');
  return [`作品数の多さでは、${list}が目立ちます。`, `いちばん作品数が多いのは、${list}です。`, `掲載数で見ると、${list}が上位です。`][v];
}

/** 項目ごとの文（3 つの言い回し）。出す事実が無い項目は null */
function phrase(key: Key, v: number, s: WeeklyStats): string | null {
  switch (key) {
    case 'new':
      if (s.newCount === 0) return ['今週は新しく加わった作品がありませんでした。', '今週の新着はありませんでした。', '新着の追加は今週はありませんでした。'][v];
      return [`今週の新着は${s.newCount}件でした。`, `この1週間で新しく加わった作品は${s.newCount}件です。`, `新着は${s.newCount}件ありました。`][v];
    case 'total':
      return [`公開中の作品は全部で${s.total}件です。`, `いま公開している作品は合わせて${s.total}件になりました。`, `掲載している作品は${s.total}件です。`][v];
    case 'sale': {
      if (s.saleCount === 0) return null;
      const med = s.saleDiscountMedian;
      return [
        med === null ? `セール中の作品は${s.saleCount}件です。` : `セール中の作品は${s.saleCount}件で、割引率の中央値は${med}%です。`,
        med === null ? `セール対象は${s.saleCount}件あります。` : `セール対象は${s.saleCount}件あり、割引率は中央値で${med}%です。`,
        med === null ? `いまセール中なのは${s.saleCount}件です。` : `いまセール中なのは${s.saleCount}件で、中央値の割引率は${med}%です。`,
      ][v];
    }
    case 'review':
      if (s.reviewOver20 === 0) return null;
      return [
        `レビューが${REVIEW_OVER}件を超えた作品は${s.reviewOver20}件あります。`,
        `評価の件数が${REVIEW_OVER}件を超えた作品は${s.reviewOver20}件で、選ぶときの目安になります。`,
        `${REVIEW_OVER}件を超えるレビューが集まった作品は${s.reviewOver20}件です。`,
      ][v];
    case 'high':
      if (s.highRatedNew === 0) return null;
      return [
        `新着のうち、評価が平均${HIGH_NEW_AVG}以上のものは${s.highRatedNew}件です。`,
        `評価の高い新着（平均${HIGH_NEW_AVG}以上）は${s.highRatedNew}件でした。`,
        `新着の中で平均${HIGH_NEW_AVG}以上の評価を得ているのは${s.highRatedNew}件です。`,
      ][v];
    case 'top':
      return topSentence(v, s);
    case 'update': {
      const label = updatedLabel(s);
      return label ? [`データは${label}時点のものです。`, `掲載のデータは${label}に更新しました。`, `${label}までの情報を反映しています。`][v] : null;
    }
  }
}

/** 変種ごとの項目の並び（先頭から、出せるものを選ぶ） */
const ORDER: Key[][] = [
  ['new', 'total', 'sale', 'review', 'high', 'top', 'update'],
  ['sale', 'new', 'high', 'top', 'total', 'review', 'update'],
  ['review', 'top', 'new', 'sale', 'total', 'high', 'update'],
];
/** 必ず出す項目（事実が無くても文になる） */
const REQUIRED: Key[] = ['new', 'total'];

/**
 * 週次統計から 3〜5 文の「運営者から」を組み立てる。文型は週番号で 3 種類を回す。
 * 必ず出すのは「新着」「総数」と、最後の使い方 1 文。残りは出せる事実から並び順に最大 2 つ。
 */
export function weeklyTemplate(stats: WeeklyStats): string {
  const w = weekIndex(stats.asOf);
  const v = ((w % 3) + 3) % 3;
  const usage = USAGE[((Math.floor(w / 3) % 3) + 3) % 3];
  const keys: Key[] = [...REQUIRED];
  for (const k of ORDER[v]) {
    if (keys.length >= 4) break;
    if (!keys.includes(k) && phrase(k, v, stats) !== null) keys.push(k);
  }
  const sentences = ORDER[v].filter((k) => keys.includes(k)).map((k) => phrase(k, v, stats) as string);
  return [...sentences, usage].join('');
}

/** 週次の本文を作る（LLM → 検査 → テンプレート） */
export function generateWeekly(stats: WeeklyStats, o: { bannedWords: string[]; forbidden?: string[]; llm?: GenerateOptions['llm'] }): Promise<Generated> {
  return generateChecked({
    system: WEEKLY_SYSTEM,
    facts: factsText(stats),
    request: WEEKLY_REQUEST,
    template: weeklyTemplate(stats),
    check: { bannedWords: o.bannedWords, forbidden: o.forbidden, minSentences: 3, maxSentences: 5 },
    llm: o.llm,
  });
}
