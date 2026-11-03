// 探索ページの画面側（データ読み込み・描画・イベント・モーダル）。
// 状態・スコア・絞り込みは explorer-core.js、カードとモーダルのHTMLは explorer-view.js。
// 入力部品とその選択肢は src/pages/explore.astro がビルド時に作っている。ここでは値の反映とイベントだけを行う。
import { AXES, defaults, loadWorks, prepare, readURL, run, toQuery, yearsOf } from './explorer-core.js';
import { cardHtml, modalHtml } from './explorer-view.js';
import { createPicker, tally } from './axis-picker.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const PAGE = 40; // 一度に描画する件数（スクロールで追加）
const sentinel = $('#more'); // 一覧の末尾。読み込み中・件数・エラーの表示も兼ねる

let st = readURL(location.search);
let works = [], byId = new Map(), current = [], shown = 0, ready = false;

// ---- 入力部品への反映 ----
const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
const mark = (b, on) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); };
/** URLにあって選択肢に無い値（古いリンクなど）も、選択中として見せる */
function ensureOption(sel, k, v) {
  if (v && ![...sel.options].some((o) => o.value === v)) sel.add(new Option(k === 'year' ? `${v}年` : v, v));
}

// 出演者・シリーズ・メーカーの検索式部品。選ぶと状態に入れて sync する
const pickers = {};
for (const root of $$('#panel .picker')) {
  const k = root.dataset.axis;
  pickers[k] = createPicker(root, { label: root.dataset.label, onChange: (v) => { st[k] = v; sync(); } });
}

function syncControls() {
  for (const [k] of AXES) {
    $(`#sliders input[data-k="${k}"]`).value = st.w[k];
    $('#v-' + k).textContent = st.w[k].toFixed(2);
  }
  $$('#panel [data-len]').forEach((b) => mark(b, b.dataset.len === st.len));
  $$('#panel [data-g]').forEach((b) => mark(b, st.g.includes(b.dataset.g)));
  $$('#panel [data-lab]').forEach((b) => mark(b, st.lab.includes(b.dataset.lab)));
  for (const k of ['act', 'ser', 'mak']) pickers[k].setValue(st[k]);
  { const s = $('#f-year'); ensureOption(s, 'year', st.year); s.value = st.year; }
  for (const k of ['pmin', 'pmax', 'vmin', 'vmax']) $('#f-' + k).value = st[k];
  $('#f-sale').checked = st.sale;
  $('#f-sample').checked = st.sample;
}

/** 状態を部品とURLに反映してから、一覧を描き直す（データがまだなら、読み込み後に描く） */
function sync() {
  syncControls();
  const qs = toQuery(st);
  try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '')); } catch { /* 履歴を触れない環境では無視する */ }
  if (ready) render();
}

// ---- 一覧 ----
const io = 'IntersectionObserver' in window
  ? new IntersectionObserver((es) => { if (ready && shown < current.length && es.some((e) => e.isIntersecting)) more(); }, { rootMargin: '600px 0px' })
  : null;
if (!io) window.addEventListener('scroll', () => { if (ready && shown < current.length && innerHeight + scrollY > document.body.offsetHeight - 600) more(); }, { passive: true });

/** 次の PAGE 件を足す。末尾がまだ画面の近くにあれば、観測し直して続けて読み込む */
function more() {
  const next = current.slice(shown, shown + PAGE);
  $('#results').insertAdjacentHTML('beforeend', next.map(cardHtml).join(''));
  shown += next.length;
  sentinel.textContent = shown < current.length ? `${shown} / ${current.length} 件を表示中。スクロールで続きを読み込みます` : (current.length ? 'すべて表示しました' : '');
  if (io) { io.unobserve(sentinel); io.observe(sentinel); }
}

// 該当なしのとき、外せる条件を案内する [いま効いているか, ボタンの文言, 外す処理]
const RELAX = [
  [(s) => s.g.length, 'ジャンルを外す', (s) => { s.g = []; }],
  [(s) => s.lab.length, 'ラベルを外す', (s) => { s.lab = []; }],
  [(s) => s.act || s.ser || s.mak, '出演者・シリーズ・メーカーを外す', (s) => { s.act = s.ser = s.mak = ''; }],
  [(s) => [s.pmin, s.pmax, s.vmin, s.vmax, s.year].some((v) => v !== ''), '価格・長さ・年を外す', (s) => { s.pmin = s.pmax = s.vmin = s.vmax = s.year = ''; }],
  [(s) => s.sale || s.sample, '条件を外す', (s) => { s.sale = s.sample = false; }],
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

function render() {
  current = run(works, st);
  $('#count').textContent = current.length.toLocaleString('ja-JP');
  $('#query-note').textContent = st.q ? `「${st.q}」で検索中` : '';
  $('#results').textContent = '';
  shown = 0;
  more();
  $('#empty').hidden = current.length > 0;
  if (!current.length) renderEmpty();
}

// ---- モーダル ----
let opener = null;
const modalOpen = () => $('#modal').classList.contains('open');
function openModal(w) {
  opener = document.activeElement;
  $('#modal-title').textContent = w.t;
  $('#modal-body').innerHTML = modalHtml(w);
  $('#modal').classList.add('open');
  $('#modal .modal').scrollTop = 0;
  document.body.style.overflow = 'hidden';
  $('#modal-close').focus();
}
function closeModal() {
  if (!modalOpen()) return;
  $('#modal').classList.remove('open');
  document.body.style.overflow = '';
  if (opener && opener.focus) opener.focus();
}

// ---- データ読み込み ----
function showError() {
  $('#count').textContent = '–';
  sentinel.innerHTML = '<span role="alert">作品データを読み込めませんでした。通信状況を確かめて、もう一度お試しください。</span> <button type="button" class="btn" id="btn-retry">再読み込み</button>';
  $('#btn-retry').addEventListener('click', load);
}

async function load() {
  sentinel.textContent = '作品データを読み込み中…';
  try {
    const data = await loadWorks((done, total) => { sentinel.textContent = `作品データを読み込み中…（${done} / ${total}）`; });
    works = prepare(data.works);
    byId = new Map(works.map((w) => [w.id, w]));
    // 検索式の候補は、読み込んだカードデータから名前と件数を集計して作る
    pickers.act.setItems(tally(works.flatMap((w) => w.a || [])));
    pickers.ser.setItems(tally(works.map((w) => w.s)));
    pickers.mak.setItems(tally(works.map((w) => w.m)));
    // 配信開始年の選択肢。ビルド時に入っていなければ（index.json に years が無いとき）、ここで足す
    const sel = $('#f-year'), years = Array.isArray(data.index.years) && data.index.years.length ? data.index.years : yearsOf(works);
    for (const y of years) ensureOption(sel, 'year', String(y));
    ready = true;
    sync();
  } catch (err) {
    console.error(err);
    showError();
  }
}

// ---- イベント ----
const on = (sel, type, fn) => $(sel).addEventListener(type, fn);
on('#sliders', 'input', (e) => { const k = e.target.dataset.k; if (k) { st.w[k] = Number(e.target.value); sync(); } });
on('#panel', 'click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.len) st.len = b.dataset.len;
  else if (b.dataset.g) st.g = toggle(st.g, b.dataset.g);
  else if (b.dataset.lab) st.lab = toggle(st.lab, b.dataset.lab);
  else return;
  sync();
});
on('#panel', 'change', (e) => { // 入力部品の id（f-xxx）が、そのまま状態のキー
  const t = e.target, k = t.id.startsWith('f-') ? t.id.slice(2) : '';
  if (!(k in st)) return;
  st[k] = t.type === 'checkbox' ? t.checked : t.value;
  sync();
});
on('#btn-reset', 'click', () => { st = defaults(); sync(); });
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
  if (!modalOpen()) return;
  if (e.key === 'Escape') { closeModal(); return; }
  if (e.key !== 'Tab') return;
  // Tab はモーダルの中だけを回す
  const f = $$('#modal button, #modal a[href]'), first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ---- 起動 ----
sync(); // URLの状態を部品に反映する（この時点ではデータが無いので描画は読み込み後）
// スマホでは絞り込みパネルを畳んで、結果を先に見せる
if (window.innerWidth < 960) $$('#panel details').forEach((d) => { d.open = false; });
load();
