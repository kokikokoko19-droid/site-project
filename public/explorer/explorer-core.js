// 探索ページの中核（状態・URL・スコア・絞り込み・データ読み込み）。画面には触れない。
// 描画とイベントは explorer-ui.js、カードとモーダルのHTMLは explorer-view.js が受け持つ。

/** 並べ替えの軸 [キー, 表示名, 既定の重み]。src/pages/explore.astro のスライダーと同じ並び・既定値にする */
export const AXES = [['e', '評価', 0.4], ['r', '新しさ', 0.2], ['p', '価格の安さ', 0.1], ['l', '長さの好み', 0.1], ['pop', '人気', 0.2]];
export const LENS = ['short', 'mid', 'long'];
const LEN_TARGET = { short: 50, mid: 110, long: 200 }; // 長さの好みごとの目標（分）
const C = 20; // ベイズ平均の事前件数
const DAY = 86400000;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
/** 検索用の正規化（全角・半角をそろえ、小文字にする） */
const norm = (s) => String(s).normalize('NFKC').toLowerCase();
/** 数値として読める文字列だけ通す。それ以外は空（指定なし） */
const numStr = (v) => (v !== null && v.trim() !== '' && Number.isFinite(Number(v)) ? String(Number(v)) : '');

// ---- 状態 <-> URL ----

export const defaults = () => ({
  w: Object.fromEntries(AXES.map(([k, , d]) => [k, d])), len: 'mid', g: [], act: '', ser: '', mak: '',
  pmin: '', pmax: '', vmin: '', vmax: '', year: '', sale: false, sample: false, lab: [], q: '', sort: '',
});

/** URLクエリ（location.search）から状態を作る。不正な値は既定値に戻す */
export function readURL(search) {
  const u = new URLSearchParams(search), st = defaults();
  for (const [k] of AXES) {
    const v = numStr(u.get('w_' + k));
    if (v !== '') st.w[k] = clamp01(Number(v));
  }
  if (LENS.includes(u.get('len'))) st.len = u.get('len');
  for (const k of ['act', 'ser', 'mak', 'q', 'sort']) st[k] = (u.get(k) || '').trim(); // 検索語は前後の空白を落とす
  for (const k of ['pmin', 'pmax', 'vmin', 'vmax', 'year']) st[k] = numStr(u.get(k));
  st.g = [...new Set(u.getAll('g'))];
  st.lab = [...new Set(u.getAll('lab'))];
  st.sale = u.get('sale') === '1';
  st.sample = u.get('sample') === '1';
  if (st.sort === 'new') st.w = { e: 0, r: 1, p: 0, l: 0, pop: 0 }; // 新着順は「新しさ」だけを使う
  return st;
}

/** 状態をURLクエリ文字列にする。既定値と同じものは書かない（sort は読むだけで、重みの形で残す） */
export function toQuery(st) {
  const u = new URLSearchParams();
  for (const [k, , d] of AXES) if (st.w[k] !== d) u.set('w_' + k, String(st.w[k]));
  if (st.len !== 'mid') u.set('len', st.len);
  st.g.forEach((g) => u.append('g', g));
  for (const k of ['act', 'ser', 'mak', 'pmin', 'pmax', 'vmin', 'vmax', 'year']) if (st[k] !== '') u.set(k, st[k]);
  if (st.sale) u.set('sale', '1');
  if (st.sample) u.set('sample', '1');
  st.lab.forEach((l) => u.append('lab', l));
  if (st.q) u.set('q', st.q);
  return u.toString();
}

// ---- スコアと絞り込み ----

/**
 * 読み込んだ作品に、スコアの部品と検索用の値を前もって計算して付ける（_ で始まる項目）。読み込み後に一度だけ呼ぶ。
 * 評価はベイズ平均（事前件数 C、事前平均は全作品の平均）、新しさは指数減衰（1年で 1/e）、
 * 価格は 300〜3000円を 1〜0 に線形（範囲外は丸める）、人気は rk の逆順（rk が無い作品は 0）。値が欠けた項目は 0 点。
 */
export function prepare(works, now = Date.now()) {
  for (const w of works) { w.a ||= []; w.g ||= []; w.lb ||= []; }
  const rated = works.filter((w) => w.ra != null && w.rc > 0);
  const meanAvg = rated.length ? rated.reduce((s, w) => s + w.ra, 0) / rated.length : 0;
  let maxRk = 1;
  for (const w of works) if (w.rk != null && w.rk > maxRk) maxRk = w.rk;
  for (const w of works) {
    const rc = w.ra != null && w.rc > 0 ? w.rc : 0;
    const bayes = ((rc ? w.ra * rc : 0) + meanAvg * C) / (rc + C) / 5;
    const t = w.d ? Date.parse(w.d) : NaN;
    const rec = Number.isNaN(t) ? 0 : Math.exp(-Math.max(0, now - t) / DAY / 365);
    const price = w.p == null ? 0 : clamp01(1 - (w.p - 300) / 2700);
    const pop = w.rk == null ? 0 : maxRk > 1 ? 1 - (w.rk - 1) / (maxRk - 1) : 1;
    w._c = [bayes, rec, price, pop];
    w._y = Number.isNaN(t) ? 0 : Number(w.d.slice(0, 4));
    w._h = norm([w.t, w.m || '', w.s || '', ...w.a].join(' '));
  }
  return works;
}

/** 重み付きスコア。長さの好みだけは選択に応じて毎回計算する */
export function score(w, st) {
  const len = w.v == null ? 0 : Math.max(0, 1 - Math.abs(w.v - LEN_TARGET[st.len]) / 150);
  const c = w._c;
  return st.w.e * c[0] + st.w.r * c[1] + st.w.p * c[2] + st.w.l * len + st.w.pop * c[3];
}

/** 下限・上限（空文字は指定なし）に収まるか。値の無い作品は、どちらかを指定したときは外す */
function inRange(v, min, max) {
  if (min === '' && max === '') return true;
  if (v == null) return false;
  return (min === '' || v >= Number(min)) && (max === '' || v <= Number(max));
}

/** 絞り込み。terms は検索語（空白で区切った AND、正規化済み） */
export function matches(w, st, terms) {
  if (st.g.length && !st.g.every((g) => w.g.includes(g))) return false;
  if (st.act && !w.a.includes(st.act)) return false;
  if (st.ser && w.s !== st.ser) return false;
  if (st.mak && w.m !== st.mak) return false;
  if (!inRange(w.p, st.pmin, st.pmax) || !inRange(w.v, st.vmin, st.vmax)) return false;
  if (st.year !== '' && w._y !== Number(st.year)) return false;
  if (st.sale && !w.sale) return false;
  if (st.sample && !w.sm) return false;
  if (st.lab.length && !st.lab.every((l) => w.lb.includes(l))) return false;
  return terms.every((t) => w._h.includes(t));
}

/** 絞り込んでスコア順に並べる（同点は元の順を保つ） */
export function run(works, st) {
  const terms = norm(st.q).split(/\s+/).filter(Boolean);
  return works.filter((w) => matches(w, st, terms)).map((w) => [w, score(w, st)]).sort((a, b) => b[1] - a[1]).map((o) => o[0]);
}

/** 作品に含まれる配信開始年（新しい順）。index.json に years が無いときの代わり */
export const yearsOf = (works) => [...new Set(works.map((w) => w._y).filter(Boolean))].sort((a, b) => b - a);

// ---- データ読み込み ----

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} を取得できませんでした（HTTP ${res.status}）`);
  return res.json();
}

/** index.json → 各チャンクを順に読み、WorkCardRecord[] を組み立てる。onProgress(読み込み済み, 全体) */
export async function loadWorks(onProgress) {
  const index = await getJson('/data/index.json', { cache: 'no-cache' });
  const chunks = Array.isArray(index.chunks) ? index.chunks : [];
  // チャンク名は更新しても変わらないので、生成日時をURLに付けて、古い内容がキャッシュから出ないようにする
  const v = encodeURIComponent(index.generatedAt || '');
  const works = [];
  for (let i = 0; i < chunks.length; i++) {
    const part = await getJson(`/data/${chunks[i]}?v=${v}`);
    if (!Array.isArray(part)) throw new Error(`${chunks[i]} の形式が不正です`);
    for (const w of part) works.push(w);
    if (onProgress) onProgress(i + 1, chunks.length);
  }
  return { index, works };
}
