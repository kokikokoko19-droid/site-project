// ビルド後の検査（dist/ を走査する）。npm の postbuild で自動実行され、npm run check でも単独で実行できる。
//   (a) HTML 内の href / src が「/」で始まる内部リンクの行き先が dist に存在するか
//       （/go/、/data/、/_astro/、/explorer/、/analytics/ も含めてすべて確認する。外部URLは対象外）
//   (b) 本文テキストに「undefined」「null」「NaN」「[object」「不明」が出ていないか（テンプレートの値漏れの検出）
//   (c) /v/（作品ページ）の CTA に rel="sponsored nofollow" が付いているか（CTA があるページのみ）
//   (d) ページ数の集計
// 問題があれば一覧を出して終了コード1、無ければ要約を出して0。外部ライブラリは使わない。
// 速さのため、ファイル一覧を Set にして行き先を引き、禁止語は生のHTMLで先に絞ってから本文を取り出す。
// 使い方: node scripts/check-dist.mjs [検査するディレクトリ。既定は dist]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(process.argv[2] ?? join(root, 'dist'));
const SHOW = 12; // 問題の種類ごとに一覧へ出す件数の上限

/** 本文に出てはいけない語。英字の語は単語として現れたときだけ数える（"nullable" などは対象外） */
const FORBIDDEN = [
  ['undefined', /\bundefined\b/],
  ['null', /\bnull\b/],
  ['NaN', /\bNaN\b/],
  ['[object', /\[object/],
  ['不明', /不明/],
];
const QUICK_WORDS = ['undefined', 'null', 'NaN', '[object', '不明'];
/** 「不明」を含む正当な語（定型文や作品名に出うるもの）。検査の前に取り除く。必要になったらここへ足す */
const ALLOWED_PHRASES = /ご不明|行方不明|正体不明|原因不明|生死不明|意識不明|安否不明|所在不明|身元不明/g;

const LINK = /(?<![\w-])(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const SCRIPT_BODY = /(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi; // リンク抽出の前にスクリプトの中身だけ消す
const HIDDEN_BLOCK = /<(script|style|template)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi;
const TEXT_ATTR = /\b(?:alt|title|aria-label|placeholder|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CTA_TAG = /<a\b(?=[^>]*(?:\bdata-cta\b|\bhref=["']?\/go\/))[^>]*>/gi;
const REL = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

function walk(dir, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 目に見える文字（本文、title、alt などの属性）を1本の文字列にする。スクリプトとスタイルは除く */
function visibleText(html) {
  const h = html.replace(HIDDEN_BLOCK, ' ');
  const attrs = [...h.matchAll(TEXT_ATTR)].map((m) => m[1] ?? m[2]);
  return `${h.replace(/<[^>]*>/g, ' ')} ${attrs.join(' ')}`;
}

/** 種類ごとの集計に1件足す（件数と、先頭数件の例） */
function note(map, key, example) {
  let e = map.get(key);
  if (!e) map.set(key, (e = { count: 0, examples: [] }));
  e.count++;
  if (e.examples.length < 3) e.examples.push(example);
}

const fmt = (n) => n.toLocaleString('ja-JP');

if (!existsSync(distDir)) {
  console.error(`[check-dist] ${distDir} がありません。先に npm run build を実行してください。`);
  process.exit(1);
}

const started = performance.now();
const toUrl = (abs) => abs.slice(distDir.length).replaceAll('\\', '/'); // 例 '/v/abc/index.html'
const allFiles = walk(distDir, []);
const known = new Set(allFiles.map(toUrl));
const htmlFiles = allFiles.filter((f) => f.endsWith('.html'));

/** 行き先 → 存在するか（同じ行き先を何度も調べない）。ディレクトリ形式（/x/ → /x/index.html）も認める */
const exists = new Map();
function targetExists(path) {
  let ok = exists.get(path);
  if (ok === undefined) {
    ok =
      known.has(path) ||
      (path.endsWith('/') ? known.has(`${path}index.html`) : known.has(`${path}/index.html`) || known.has(`${path}.html`));
    exists.set(path, ok);
  }
  return ok;
}

const broken = new Map(); // 行き先 → 参照元
const textHits = new Map(); // 禁止語 → ページ
const relBad = new Map(); // ページ → rel が足りない CTA
const sections = new Map(); // 最初の階層 → ページ数
let linkTotal = 0;
let vPages = 0;
let ctaPages = 0;

for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const u = toUrl(file);
  const page = u.endsWith('/index.html') ? u.slice(0, -'index.html'.length) : u;
  const seg = page.split('/')[1];
  const section = seg === '' ? '(トップ)' : seg.replace(/\.html$/, '');
  sections.set(section, (sections.get(section) ?? 0) + 1);

  // (a) 内部リンク
  for (const m of html.replace(SCRIPT_BODY, '$1$2').matchAll(LINK)) {
    let v = m[1] ?? m[2] ?? m[3] ?? '';
    if (!v.startsWith('/') || v.startsWith('//')) continue; // 外部URL、#、mailto: などは対象外
    const cut = v.search(/[?#]/);
    if (cut >= 0) v = v.slice(0, cut);
    try {
      v = decodeURI(v);
    } catch {
      /* 不正なエンコードはそのまま調べる（見つからなければ報告される） */
    }
    linkTotal++;
    if (!targetExists(v)) note(broken, v, page);
  }

  // (b) 禁止語。生のHTMLで先に絞り、当たったページだけ本文を取り出して確かめる
  if (QUICK_WORDS.some((w) => html.includes(w))) {
    const text = visibleText(html).replace(ALLOWED_PHRASES, ' ');
    for (const [label, re] of FORBIDDEN) {
      const m = re.exec(text);
      if (!m) continue;
      const around = text.slice(Math.max(0, m.index - 12), m.index + 20).replace(/\s+/g, ' ').trim();
      note(textHits, label, `${page}「${around}」`);
    }
  }

  // (c) /v/ の CTA（FANZAへのボタン）。1つでも rel に sponsored と nofollow が無ければ不備
  if (page.startsWith('/v/')) {
    vPages++;
    const tags = html.match(CTA_TAG);
    if (tags) {
      ctaPages++;
      for (const tag of tags) {
        const r = REL.exec(tag);
        const tokens = (r ? (r[1] ?? r[2] ?? r[3]) : '').toLowerCase().split(/\s+/);
        if (!tokens.includes('sponsored') || !tokens.includes('nofollow')) note(relBad, page, tag.slice(0, 90));
      }
    }
  }
}

const elapsed = ((performance.now() - started) / 1000).toFixed(2);
const bySection = [...sections].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${fmt(n)}`).join('／');
console.log(`[check-dist] ${distDir} を検査しました（${elapsed} 秒）`);
console.log(`  HTML ページ: ${fmt(htmlFiles.length)} 件（${bySection}）`);
console.log(`  内部リンク: 延べ ${fmt(linkTotal)} 件、行き先 ${fmt(exists.size)} 種類`);
console.log(`  /v/ の作品ページ: ${fmt(vPages)} 件（CTA あり ${fmt(ctaPages)} 件）`);

const sum = (map) => [...map.values()].reduce((s, e) => s + e.count, 0);
const groups = [
  [
    `リンク切れ: 行き先 ${broken.size} 種類、延べ ${fmt(sum(broken))} 件（dist に無い）`,
    broken,
    (k, e) => `${k}  ← ${fmt(e.count)} 件（例: ${e.examples.join('、')}）`,
  ],
  [
    `本文に出てはいけない語: ${textHits.size} 種類、延べ ${fmt(sum(textHits))} ページ`,
    textHits,
    (k, e) => `「${k}」 ${fmt(e.count)} ページ（例: ${e.examples.join('、')}）`,
  ],
  [
    `CTA の rel 不備（sponsored nofollow が必要）: ${fmt(relBad.size)} ページ`,
    relBad,
    (k, e) => `${k}  ${fmt(e.count)} 件（例: ${e.examples[0]}）`,
  ],
];

let problemCount = 0;
for (const [title, map, line] of groups) {
  if (map.size === 0) continue;
  problemCount += sum(map);
  console.error(`\n■ ${title}`);
  const rows = [...map].sort((a, b) => b[1].count - a[1].count);
  for (const [k, e] of rows.slice(0, SHOW)) console.error(`  ${line(k, e)}`);
  if (rows.length > SHOW) console.error(`  …ほか ${rows.length - SHOW} 件`);
}

if (htmlFiles.length === 0) {
  console.error('\n■ HTML が1件も見つかりません。ビルドが完了しているか確認してください。');
  problemCount++;
}

if (problemCount > 0) {
  console.error(`\n[check-dist] 問題が ${fmt(problemCount)} 件ありました。`);
  process.exitCode = 1;
} else {
  console.log('[check-dist] 問題はありませんでした。');
}
