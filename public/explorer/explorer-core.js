// 探索ページの中核（状態・URL・絞り込み・並べ替え・適用中の条件・データ読み込み）。画面（DOM）には触れない純粋な関数だけを置く。
// 描画とイベントは explorer-ui.js、カードとモーダルのHTMLは explorer-view.js。tests/explorer-core.test.ts が node:test で検証する。
// 作品データ（works-NNN.json）は WorkCardRecord（src/data/types.ts）。出演者・メーカー・シリーズ・ジャンルは index.json の names の添字。

const DAY = 86400000;

/** 並べ替え [URL の値, 表示名]。既定は rec（URL に書かない） */
export const SORTS = [['rec', 'おすすめ'], ['rating', '評価が高い順'], ['new', '新しい順'], ['cheap', '安い順'], ['long', '長い順']];
const SORT_KEYS = SORTS.map(([k]) => k);

/** 価格帯（WorkCardRecord の pb）の表示名 */
export const PRICE_BANDS = ['〜500円', '〜1,000円', '〜2,000円', '2,000円超'];

/** 長さのチップ [URL の値, 表示名, 下限（分。以上）, 上限（分。未満）]。1つだけ選べる */
export const LENGTHS = [['s', '〜60分', null, 60], ['m', '60〜120分', 60, 120], ['l', '120分〜', 120, null], ['xl', '4時間以上', 240, null]];
const LENGTH_KEYS = LENGTHS.map(([k]) => k);

/** 目的別チップ [キー, 表示名, 設定する条件]。押すと条件と並べ替えをまとめて設定し、もう一度押すと外す */
export const PRESETS = [
  ['safe', '外さない1本', { sort: 'rating', rev: true }],
  ['fresh', '新作を追う', { sort: 'new', days: '30' }],
  ['cheap', '安く試す', { sort: 'cheap', sale: true }],
  ['long', 'じっくり長編', { sort: 'rating', len: 'l' }],
];

/** 検索用の正規化（全角・半角をそろえ、小文字にする） */
export const norm = (s) => String(s).normalize('NFKC').toLowerCase();

// ---- 状態 <-> URL ----

export const defaults = () => ({
  sort: 'rec', g: [], act: '', ser: '', mak: '', pb: [], len: '', year: '', days: '',
  sale: false, rev: false, lab: [], q: '',
});

/** 旧 URL の価格の範囲（pmin・pmax、円）を、重なる価格帯にする */
function bandsFromRange(min, max) {
  const lo = [0, 501, 1001, 2001], hi = [500, 1000, 2000, Infinity];
  const a = min === '' ? 0 : Number(min), b = max === '' ? Infinity : Number(max);
  return [0, 1, 2, 3].filter((i) => lo[i] <= b && hi[i] >= a);
}

/** 旧 URL の長さの範囲（vmin・vmax、分）を、いちばん近い長さのチップにする */
function lengthFromRange(min, max) {
  if (min !== '' && Number(min) >= 240) return 'xl';
  if (min !== '' && Number(min) >= 120) return 'l';
  if (max !== '' && Number(max) <= 60) return 's';
  if (min !== '' && Number(min) >= 60 && max !== '' && Number(max) <= 120) return 'm';
  return '';
}

const numOr = (v) => (v !== null && v.trim() !== '' && Number.isFinite(Number(v)) ? String(Number(v)) : '');

/**
 * URLクエリ（location.search）から状態を作る。不正な値は既定値に戻す。
 * 互換: 旧 URL の sort=new はそのまま新しい順。重み（w_*）と len=short|mid|long は読み捨てる。pmin・pmax・vmin・vmax は価格帯と長さのチップに読み替える。
 * sample=1（「サンプル動画あり」。2026-11-28 に動画の表示を廃止）も読み捨てる。
 */
export function readURL(search) {
  const u = new URLSearchParams(search), st = defaults();
  if (SORT_KEYS.includes(u.get('sort'))) st.sort = u.get('sort');
  for (const k of ['act', 'ser', 'mak', 'q']) st[k] = (u.get(k) || '').trim(); // 検索語は前後の空白を落とす
  st.year = /^\d{4}$/.test(u.get('year') || '') ? u.get('year') : '';
  st.days = /^\d{1,4}$/.test(u.get('days') || '') && Number(u.get('days')) > 0 ? String(Number(u.get('days'))) : '';
  st.g = [...new Set(u.getAll('g').filter(Boolean))];
  st.lab = [...new Set(u.getAll('lab').filter(Boolean))];
  st.pb = [...new Set(u.getAll('pb').filter((v) => /^[0-3]$/.test(v)).map(Number))].sort();
  st.len = LENGTH_KEYS.includes(u.get('len')) ? u.get('len') : '';
  st.sale = u.get('sale') === '1';
  st.rev = u.get('rev') === '1';
  const [pmin, pmax, vmin, vmax] = ['pmin', 'pmax', 'vmin', 'vmax'].map((k) => numOr(u.get(k)));
  if (!st.pb.length && (pmin !== '' || pmax !== '')) st.pb = bandsFromRange(pmin, pmax);
  if (!st.len && (vmin !== '' || vmax !== '')) st.len = lengthFromRange(vmin, vmax);
  return st;
}

/** 状態をURLクエリ文字列にする。既定値と同じものは書かない */
export function toQuery(st) {
  const u = new URLSearchParams();
  if (st.sort !== 'rec') u.set('sort', st.sort);
  st.g.forEach((g) => u.append('g', g));
  for (const k of ['act', 'ser', 'mak']) if (st[k]) u.set(k, st[k]);
  [...st.pb].sort().forEach((b) => u.append('pb', String(b)));
  for (const k of ['len', 'year', 'days']) if (st[k]) u.set(k, st[k]);
  for (const k of ['sale', 'rev']) if (st[k]) u.set(k, '1');
  st.lab.forEach((l) => u.append('lab', l));
  if (st.q) u.set('q', st.q);
  return u.toString();
}

/** モーダルの URL の断片（#w=ID）から作品 ID を読む。無ければ null */
export function readHash(hash) {
  const m = /^#w=(.+)$/.exec(hash || '');
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}
export const toHash = (id) => `#w=${encodeURIComponent(id)}`;

// ---- 目的別チップ ----

/** プリセットの条件がすべて満たされているか（並べ替えも含む） */
export function presetActive(st, key) {
  const p = PRESETS.find(([k]) => k === key);
  return !!p && Object.entries(p[2]).every(([k, v]) => st[k] === v);
}

/** プリセットを押したときの次の状態。未適用なら条件と並べ替えを足し、適用中なら外して並べ替えをおすすめに戻す。ほかの条件は残す */
export function applyPreset(st, key) {
  const p = PRESETS.find(([k]) => k === key);
  if (!p) return st;
  const next = { ...st };
  if (presetActive(st, key)) {
    const base = defaults();
    for (const k of Object.keys(p[2])) next[k] = base[k];
  } else {
    Object.assign(next, p[2]);
  }
  return next;
}

// ---- 適用中の条件（× で個別に外すチップ） ----

/** 適用中の条件の一覧 [{ k, v, label }]（並べ替えは含めない。検索語は「検索: …」） */
export function activeChips(st) {
  const out = [];
  if (st.q) out.push({ k: 'q', v: st.q, label: `検索: ${st.q}` });
  st.g.forEach((g) => out.push({ k: 'g', v: g, label: g }));
  for (const [k, name] of [['act', '出演'], ['ser', 'シリーズ'], ['mak', 'メーカー']]) if (st[k]) out.push({ k, v: st[k], label: `${name}: ${st[k]}` });
  st.pb.forEach((b) => out.push({ k: 'pb', v: String(b), label: PRICE_BANDS[b] }));
  if (st.len) out.push({ k: 'len', v: st.len, label: LENGTHS.find(([k]) => k === st.len)[1] });
  if (st.year) out.push({ k: 'year', v: st.year, label: `${st.year}年` });
  if (st.days) out.push({ k: 'days', v: st.days, label: `${st.days}日以内` });
  if (st.sale) out.push({ k: 'sale', v: '1', label: 'セール中' });
  if (st.rev) out.push({ k: 'rev', v: '1', label: '評価あり' });
  st.lab.forEach((l) => out.push({ k: 'lab', v: l, label: l }));
  return out;
}

/** 絞り込みの件数（「絞り込み（n）」に出す数。検索語は含めない） */
export const filterCount = (st) => activeChips(st).filter((c) => c.k !== 'q').length;

/** 適用中の条件を1つ外した次の状態 */
export function removeChip(st, k, v) {
  const next = { ...st }, base = defaults();
  if (Array.isArray(st[k])) next[k] = st[k].filter((x) => String(x) !== String(v));
  else if (k in base) next[k] = base[k];
  return next;
}

// ---- 絞り込みと並べ替え ----

/**
 * 読み込んだ作品に、検索・絞り込み用の値を前もって付ける（_ で始まる項目）。何度呼んでも同じ結果。
 * names は index.json の names（{ actress, maker, series, genre }）。
 */
export function prepare(works, names) {
  const nm = (kind, i) => (i == null ? '' : (names[kind] && names[kind][i]) || '');
  for (const w of works) {
    w.a ||= []; w.g ||= []; w.lb ||= [];
    const t = w.d ? Date.parse(w.d) : NaN;
    w._t = Number.isNaN(t) ? null : t;
    w._y = w._t === null ? 0 : Number(w.d.slice(0, 4));
    w._h = norm([w.t, nm('maker', w.m), nm('series', w.s), ...w.a.map((i) => nm('actress', i))].join(' '));
  }
  return works;
}

/** 名前 → 添字の表（状態は名前で持ち、作品は添字で持つため） */
export function nameIndex(names) {
  const out = {};
  for (const kind of ['actress', 'maker', 'series', 'genre']) out[kind] = new Map(((names && names[kind]) || []).map((n, i) => [n, i]));
  return out;
}

/**
 * 状態から判定関数を作る。ix は nameIndex の結果、now は「〜日以内」の基準（ミリ秒）。
 * 名前が names に無い条件（古いリンクなど）は、該当なしになる。
 */
export function matcher(st, ix, now = Date.now()) {
  const idx = (kind, name) => (ix[kind].has(name) ? ix[kind].get(name) : -1);
  const g = st.g.map((n) => idx('genre', n));
  const act = st.act ? idx('actress', st.act) : null, ser = st.ser ? idx('series', st.ser) : null, mak = st.mak ? idx('maker', st.mak) : null;
  const len = LENGTHS.find(([k]) => k === st.len);
  const since = st.days ? now - Number(st.days) * DAY : null;
  const terms = norm(st.q).split(/\s+/).filter(Boolean);
  return (w) => {
    if (g.length && !g.every((i) => w.g.includes(i))) return false;
    if (act !== null && !w.a.includes(act)) return false;
    if (ser !== null && w.s !== ser) return false;
    if (mak !== null && w.m !== mak) return false;
    if (st.pb.length && !st.pb.includes(w.pb)) return false;
    if (len && (w.v == null || (len[2] !== null && w.v < len[2]) || (len[3] !== null && w.v >= len[3]))) return false;
    if (st.year && w._y !== Number(st.year)) return false;
    if (since !== null && (w._t === null || w._t < since)) return false;
    if (st.sale && !w.sale) return false;
    if (st.rev && w.rb == null) return false;
    if (st.lab.length && !st.lab.every((l) => w.lb.includes(l))) return false;
    return terms.every((t) => w._h.includes(t));
  };
}

/** 値が無い（null）ものを後ろに回す比較。desc は降順 */
const by = (get, desc) => (a, b) => {
  const x = get(a), y = get(b);
  if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
  return desc ? y - x : x - y;
};
const bySc = (a, b) => b.sc - a.sc;
const byNew = by((w) => w._t, true);

/** 並べ替えの比較関数。同順位はおすすめ度、次に新しさで決める（それでも同じなら読み込み順。sort は安定） */
export const COMPARE = {
  rec: (a, b) => bySc(a, b) || byNew(a, b),
  rating: (a, b) => by((w) => w.rb, true)(a, b) || bySc(a, b) || byNew(a, b),
  new: (a, b) => byNew(a, b) || bySc(a, b),
  cheap: (a, b) => by((w) => w.pb, false)(a, b) || bySc(a, b) || byNew(a, b),
  long: (a, b) => by((w) => w.v, true)(a, b) || bySc(a, b) || byNew(a, b),
};

/** 絞り込んで並べる（元の配列は変えない） */
export function run(works, st, ix, now = Date.now()) {
  return works.filter(matcher(st, ix, now)).sort(COMPARE[st.sort] || COMPARE.rec);
}

/** 作品に含まれる配信開始年（新しい順）。index.json に years が無いときの代わり */
export const yearsOf = (works) => [...new Set(works.map((w) => w._y).filter(Boolean))].sort((a, b) => b - a);

/** ジャンルの選択肢 [{ name, n }]（件数の多い順。index.json の names.genre と counts.genre から） */
export function genreItems(index) {
  const names = (index && index.names && index.names.genre) || [], counts = (index && index.counts && index.counts.genre) || [];
  return names.map((name, i) => ({ name, n: counts[i] || 0 }));
}

// ---- データ読み込み ----

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} を取得できませんでした（HTTP ${res.status}）`);
  return res.json();
}

/**
 * index.json を読み、チャンクを並列に取る（Promise.all）。チャンクは新しい順に詰めてあるので、
 * 1 チャンク目が届いた時点で onFirst(index, works) を呼んで描画を始められる。戻り値は全チャンクをつないだ作品（チャンク順）。
 * onIndex(index) は index.json が届いた時点。onProgress(届いた数, 全体)。getJson は差し替え用（テスト）。
 */
export async function loadWorks({ onIndex, onFirst, onProgress, getJson = fetchJson } = {}) {
  const index = await getJson('/data/index.json', { cache: 'no-cache' });
  if (onIndex) onIndex(index);
  const chunks = Array.isArray(index.chunks) ? index.chunks : [];
  // チャンク名は更新しても変わらないので、生成日時をURLに付けて、古い内容がキャッシュから出ないようにする
  const v = encodeURIComponent(index.generatedAt || '');
  let done = 0;
  // チャンクは 1 回だけやり直す（ホストの一時的な 5xx や、ボット対策のページが JSON の代わりに返る瞬間への備え）
  const getChunk = (url) => getJson(url).catch(() => new Promise((r) => setTimeout(r, 800)).then(() => getJson(url)));
  const parts = chunks.map((name, i) => getChunk(`/data/${name}?v=${v}`).then((part) => {
    if (!Array.isArray(part)) throw new Error(`${name} の形式が不正です`);
    done += 1;
    if (onProgress) onProgress(done, chunks.length);
    if (i === 0 && onFirst) onFirst(index, part);
    return part;
  }));
  const all = await Promise.all(parts);
  return { index, works: all.flat() };
}
