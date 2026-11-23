// 探索ページの画面側（データ読み込み・描画・イベント・モーダル・スマホのシート・戻ったときの復元）。
// 状態・絞り込み・並べ替えは explorer-core.js、カードとモーダルのHTMLは explorer-view.js。
// 入力部品とその選択肢は src/pages/explore.astro がビルド時に作っている。ここでは値の反映とイベントだけを行う。
// 計測（public/analytics/events.js）は .card・#panel .chip・#purpose .chip・#active-chips .chip・data-filter のクラスと属性を見ている。
import {
  activeChips, applyPreset, defaults, filterCount, genreItems, loadWorks, nameIndex, prepare, presetActive,
  readHash, readURL, removeChip, run, toHash, toQuery, yearsOf,
} from './explorer-core.js';
import { cardHtml, esc, modalHtml } from './explorer-view.js';
import { createPicker, norm as pnorm } from './axis-picker.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const PAGE = 40; // 一度に描画する件数（スクロールで追加）
const RESTORE_KEY = 'explore:restore'; // 作品ページから戻ったときの表示件数とスクロール位置（sessionStorage）
const sentinel = $('#more'); // 一覧の末尾。読み込み中・件数・エラーの表示も兼ねる
const panel = $('#panel');

let st = readURL(location.search);
let names = {}, ix = nameIndex({}), works = [], byId = new Map(), current = [], shown = 0;
let ready = false; // 1 チャンク目以降が描ける
let complete = false; // 全チャンクがそろった

// ---- 戻ったときの復元（sessionStorage）----
try { history.scrollRestoration = 'manual'; } catch { /* 古いブラウザは無視 */ }
const restore = (() => {
  try {
    const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (!nav || nav.type !== 'back_forward') return null;
    const saved = JSON.parse(sessionStorage.getItem(RESTORE_KEY) || 'null');
    return saved && saved.qs === location.search && Number.isInteger(saved.shown) ? saved : null;
  } catch { return null; }
})();
function saveRestore() {
  try { sessionStorage.setItem(RESTORE_KEY, JSON.stringify({ qs: location.search, shown, y: Math.round(scrollY) })); } catch { /* 保存できなくても動く */ }
}
addEventListener('pagehide', saveRestore);

// ---- 入力部品への反映 ----
const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
const mark = (b, on) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); };
/** URLにあって選択肢に無い値（古いリンクなど）も、選択中として見せる */
function ensureOption(sel, v) {
  if (v && ![...sel.options].some((o) => o.value === v)) sel.add(new Option(`${v}年`, v));
}

// 出演者・シリーズ・メーカーの検索式部品。選ぶと状態に入れて sync する
const pickers = {};
for (const root of $$('#panel .picker')) {
  const k = root.dataset.axis;
  pickers[k] = createPicker(root, {
    label: root.dataset.label,
    onChange: (v) => {
      if (k === 'genre') { // 「すべてのジャンル」は選ぶたびに足していく（選んだものは上のチップに出る）
        pickers.genre.setValue('');
        if (v && !st.g.includes(v)) { st.g = [...st.g, v]; sync(); }
        return;
      }
      st[k] = v;
      sync();
    },
  });
}
const AXIS_KIND = { act: 'actress', ser: 'series', mak: 'maker', genre: 'genre' };
/** 検索式の候補を index.json の names と counts から作る（件数の多い順） */
function setPickerItems(index) {
  for (const [k, kind] of Object.entries(AXIS_KIND)) {
    const list = (index.names && index.names[kind]) || [], counts = (index.counts && index.counts[kind]) || [];
    pickers[k].setItems(list.map((name, i) => ({ name, n: counts[i] || 0, key: pnorm(name) })));
  }
}

const topGenres = new Set($$('#genre-chips [data-g]').map((b) => b.dataset.g));
const RATING_NOTE = '評価はレビュー5件以上の作品の平均を0.5刻みにしたもの。同じ評価の中は、レビュー数などで補正したおすすめ度の順です。広告費による順位付けはありません。';
const DEFAULT_NOTE = $('#sort-note').textContent;

function syncControls() {
  $$('.sort-select').forEach((s) => { s.value = st.sort; });
  $$('#panel [data-g]').forEach((b) => mark(b, st.g.includes(b.dataset.g)));
  // 上位 12 に無いジャンル（「すべてのジャンル」で選んだもの）は、選択中のチップとして別に出す
  $('#genre-extra').innerHTML = st.g.filter((g) => !topGenres.has(g))
    .map((g) => `<button type="button" class="chip on" data-g="${esc(g)}" aria-pressed="true" aria-label="ジャンル「${esc(g)}」を外す">${esc(g)} ✕</button>`).join('');
  $$('#panel [data-pb]').forEach((b) => mark(b, st.pb.includes(Number(b.dataset.pb))));
  $$('#panel [data-len]').forEach((b) => mark(b, b.dataset.len === st.len));
  $$('#panel [data-lab]').forEach((b) => mark(b, st.lab.includes(b.dataset.lab)));
  $$('#purpose [data-preset]').forEach((b) => mark(b, presetActive(st, b.dataset.preset)));
  for (const k of ['act', 'ser', 'mak']) pickers[k].setValue(st[k]);
  { const s = $('#f-year'); ensureOption(s, st.year); s.value = st.year; }
  for (const k of ['sale', 'sample', 'rev']) $('#f-' + k).checked = st[k];
  const q = $('#f-q');
  if (document.activeElement !== q) q.value = st.q;
  $$('.n-filter').forEach((e) => { e.textContent = String(filterCount(st)); });
  renderActive();
  $('#sort-note').textContent = st.sort === 'rating' ? RATING_NOTE : DEFAULT_NOTE;
}

/** 適用中の条件のチップ（× で個別に外す）。無いときは「条件なし」 */
function renderActive() {
  const chips = activeChips(st), box = $('#active-chips');
  if (!chips.length) { box.innerHTML = '<span class="muted">条件なし（すべての作品）</span>'; return; }
  box.innerHTML = chips.map((c) =>
    `<button type="button" class="chip on" data-rm="${esc(c.k)}" data-v="${esc(c.v)}" aria-label="${esc(c.label)} を外す">${esc(c.label)} <span aria-hidden="true">×</span></button>`).join('')
    + (chips.length > 1 ? '<button type="button" class="chip" data-rm="*">すべて外す</button>' : '');
}

/** 状態を部品とURLに反映してから、一覧を描き直す（データがまだなら、読み込み後に描く）。モーダルの #w=ID は残す */
function sync() {
  syncControls();
  const qs = toQuery(st);
  try { history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash); } catch { /* 履歴を触れない環境では無視する */ }
  if (ready) render();
}

// ---- 一覧 ----
const io = 'IntersectionObserver' in window
  ? new IntersectionObserver((es) => { if (ready && shown < current.length && es.some((e) => e.isIntersecting)) more(); }, { rootMargin: '600px 0px' })
  : null;
if (!io) addEventListener('scroll', () => { if (ready && shown < current.length && innerHeight + scrollY > document.body.offsetHeight - 600) more(); }, { passive: true });

function status() {
  if (!complete) return '作品データを読み込み中…';
  return shown < current.length ? `${shown.toLocaleString('ja-JP')} / ${current.length.toLocaleString('ja-JP')} 件を表示中。スクロールで続きを読み込みます` : (current.length ? 'すべて表示しました' : '');
}

/** 次の n 件を足す。末尾がまだ画面の近くにあれば、観測し直して続けて読み込む */
function more(n = PAGE) {
  const next = current.slice(shown, shown + n);
  $('#results').insertAdjacentHTML('beforeend', next.map((w) => cardHtml(w, names)).join(''));
  shown += next.length;
  sentinel.textContent = status();
  if (io) { io.unobserve(sentinel); io.observe(sentinel); }
}

// 該当なしのとき、外せる条件を案内する [いま効いているか, ボタンの文言, 外す処理]
const RELAX = [
  [(s) => s.g.length, 'ジャンルを外す', (s) => { s.g = []; }],
  [(s) => s.lab.length, 'ラベルを外す', (s) => { s.lab = []; }],
  [(s) => s.act || s.ser || s.mak, '出演者・シリーズ・メーカーを外す', (s) => { s.act = s.ser = s.mak = ''; }],
  [(s) => s.pb.length || s.len || s.year || s.days, '価格・長さ・期間を外す', (s) => { s.pb = []; s.len = s.year = s.days = ''; }],
  [(s) => s.sale || s.sample || s.rev, '条件を外す', (s) => { s.sale = s.sample = s.rev = false; }],
  [(s) => s.q, '検索語を消す', (s) => { s.q = ''; }],
];
function renderEmpty() {
  const box = $('#empty-actions');
  box.textContent = '';
  for (const [active, label, clear] of RELAX) {
    if (!active(st)) continue;
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: label });
    b.addEventListener('click', () => { clear(st); sync(); });
    box.append(b);
  }
}

/** 一覧を描き直す。n は最初に描く件数（戻ったときの復元や、残りのチャンクが届いたときに、表示中の件数を保つ） */
function render(n = PAGE) {
  current = run(works, st, ix);
  const total = current.length.toLocaleString('ja-JP');
  $('#count').textContent = complete ? total : `${total}+`;
  $$('.n-shown').forEach((e) => { e.textContent = complete ? total : `${total}+`; });
  $('#results').textContent = '';
  $('#results').removeAttribute('aria-busy');
  shown = 0;
  more(n);
  $('#empty').hidden = current.length > 0 || !complete;
  if (!current.length) renderEmpty();
}

// ---- モーダル（開くと #w=ID を履歴に積み、「戻る」で閉じる）----
let opener = null;
const modalOpen = () => $('#modal').classList.contains('open');
function showModal(w) {
  if (!modalOpen()) opener = document.activeElement;
  $('#modal-title').textContent = w.t;
  $('#modal-body').innerHTML = modalHtml(w, names);
  $('#modal').classList.add('open');
  $('#modal .modal').scrollTop = 0;
  document.body.style.overflow = 'hidden';
  $('#modal-close').focus();
}
function hideModal() {
  if (!modalOpen()) return;
  $('#modal').classList.remove('open');
  document.body.style.overflow = '';
  if (opener && opener.focus) opener.focus({ preventScroll: true });
}
function openModal(w) {
  try { history.pushState({ modal: w.id }, '', location.pathname + location.search + toHash(w.id)); } catch { /* 履歴を触れなくても開く */ }
  showModal(w);
}
/** 閉じるボタン・背景・Esc。自分で積んだ履歴なら戻る（popstate で閉じる）、そうでなければ #w=ID を外して閉じる */
function closeModal() {
  if (!modalOpen()) return;
  if (history.state && history.state.modal) { history.back(); return; }
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* 無視 */ }
  hideModal();
}
addEventListener('popstate', () => {
  const id = readHash(location.hash), w = id && byId.get(id);
  if (w) showModal(w); else hideModal();
});

// ---- スマホのシート ----
const wide = () => matchMedia('(min-width: 960px)').matches;
let sheetOpener = null;
function openSheet() {
  if (wide()) { // PC は左のパネルを見せるだけ
    panel.scrollIntoView({ block: 'nearest' });
    const first = panel.querySelector('select, summary');
    if (first) first.focus();
    return;
  }
  sheetOpener = document.activeElement;
  panel.classList.add('open');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  $('#sheet-bg').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#sheet-close').focus();
}
function closeSheet() {
  if (!panel.classList.contains('open')) return;
  panel.classList.remove('open');
  panel.removeAttribute('role');
  panel.removeAttribute('aria-modal');
  $('#sheet-bg').hidden = true;
  document.body.style.overflow = '';
  if (sheetOpener && sheetOpener.focus) sheetOpener.focus({ preventScroll: true });
}

// ---- データ読み込み ----
function showError() {
  $('#count').textContent = '–';
  $('#results').textContent = '';
  sentinel.innerHTML = '<span role="alert">作品データを読み込めませんでした。通信状況を確かめて、もう一度お試しください。</span> <button type="button" class="btn" id="btn-retry">再読み込み</button>';
  $('#btn-retry').addEventListener('click', load);
}

function useIndex(index) {
  names = index.names || {};
  ix = nameIndex(names);
  setPickerItems(index);
  // 配信開始年の選択肢。ビルド時に入っていなければ（index.json に years が無いとき）、読み込み後に足す
  for (const y of Array.isArray(index.years) ? index.years : []) ensureOption($('#f-year'), String(y));
  if (!genreItems(index).length) $('#genre-chips').hidden = true;
}

async function load() {
  sentinel.textContent = '作品データを読み込み中…';
  complete = false;
  try {
    const data = await loadWorks({
      onIndex: useIndex,
      onProgress: (done, total) => { if (!complete) sentinel.textContent = `作品データを読み込み中…（${done} / ${total}）`; },
      // 1 チャンク目（直近の作品）が届いたら先に描く。戻ったときの復元は全件がそろってから
      onFirst: (_, part) => {
        if (restore) return;
        works = prepare(part, names);
        ready = true;
        render();
      },
    });
    works = prepare(data.works, names);
    byId = new Map(works.map((w) => [w.id, w]));
    if (!data.index.years || !data.index.years.length) for (const y of yearsOf(works)) ensureOption($('#f-year'), String(y));
    complete = true;
    ready = true;
    syncControls();
    if (restore) {
      render(Math.max(PAGE, restore.shown));
      scrollTo(0, restore.y || 0);
    } else {
      render(Math.max(PAGE, shown));
    }
    // #w=ID 付きで開いたとき（作品ページから戻ったときなど）は、そのモーダルを開く
    const id = readHash(location.hash);
    if (id && byId.has(id)) showModal(byId.get(id));
  } catch (err) {
    console.error(err);
    showError();
  }
}

// ---- イベント ----
const on = (sel, type, fn) => $(sel).addEventListener(type, fn);
on('#panel', 'click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'sheet-close') { closeSheet(); return; }
  if (b.id === 'sheet-apply') { closeSheet(); $('#results').scrollIntoView({ block: 'start' }); return; }
  if (b.dataset.g) st.g = toggle(st.g, b.dataset.g);
  else if (b.dataset.pb) st.pb = toggle(st.pb, Number(b.dataset.pb)).sort();
  else if (b.dataset.len) st.len = st.len === b.dataset.len ? '' : b.dataset.len;
  else if (b.dataset.lab) st.lab = toggle(st.lab, b.dataset.lab);
  else return;
  sync();
});
on('#panel', 'change', (e) => { // 入力部品の id（f-xxx）が、そのまま状態のキー
  const t = e.target, k = t.id.startsWith('f-') ? t.id.slice(2) : '';
  if (!['year', 'sale', 'sample', 'rev'].includes(k)) return;
  st[k] = t.type === 'checkbox' ? t.checked : t.value;
  sync();
});
// 並べ替え（結果の上・パネルの上端・スマホの下端の3か所。どれも同じ状態）
$$('.sort-select').forEach((s) => s.addEventListener('change', () => { st.sort = s.value; sync(); }));
on('#purpose', 'click', (e) => {
  const b = e.target.closest('[data-preset]');
  if (b) { st = applyPreset(st, b.dataset.preset); sync(); }
});
on('#active-chips', 'click', (e) => {
  const b = e.target.closest('[data-rm]');
  if (!b) return;
  st = b.dataset.rm === '*' ? { ...defaults(), sort: st.sort } : removeChip(st, b.dataset.rm, b.dataset.v); // 並べ替えは残す
  sync();
});
// 検索欄: 入力で少し待って絞り込み、送信（Enter）ですぐ反映する。ページは移らない
let qTimer = 0;
const setQuery = () => { clearTimeout(qTimer); const v = $('#f-q').value.trim(); if (v !== st.q) { st.q = v; sync(); } };
on('#f-q', 'input', () => { clearTimeout(qTimer); qTimer = setTimeout(setQuery, 250); });
on('#q-form', 'submit', (e) => { e.preventDefault(); setQuery(); $('#f-q').blur(); });
on('#btn-filter', 'click', openSheet);
on('#bar-filter', 'click', openSheet);
on('#sheet-bg', 'click', closeSheet);
on('#btn-random', 'click', () => { if (current.length) openModal(current[Math.floor(Math.random() * current.length)]); });
on('#results', 'click', (e) => {
  const a = e.target.closest('a.card');
  // 修飾キー付き・中クリックは、ブラウザ標準のリンク動作（新しいタブなど）に任せる
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const w = byId.get(a.dataset.id);
  if (w) { e.preventDefault(); openModal(w); }
});
on('#modal', 'click', (e) => { if (e.target.id === 'modal' || e.target.closest('#modal-close')) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (!modalOpen()) {
    if (e.key === 'Escape' && panel.classList.contains('open')) closeSheet();
    return;
  }
  if (e.key === 'Escape') { closeModal(); return; }
  if (e.key !== 'Tab') return;
  // Tab はモーダルの中だけを回す
  const f = $$('#modal button, #modal a[href]'), first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
// PC 幅に広げたら、開いたままのシートの状態を戻す
matchMedia('(min-width: 960px)').addEventListener('change', (m) => { if (m.matches) closeSheet(); });

// ---- 起動 ----
sync(); // URLの状態を部品に反映する（この時点ではデータが無いので描画は読み込み後）
load();
