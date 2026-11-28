// 探索ページの見た目（カードとモーダルのHTML）。文字は必ず esc() を通す。
// カードは src/components/WorkCard.astro（variant="grid"）と同じクラス構成にしてある（見た目を変えるときは両方を直す）。
// 作品データの名前は index.json の names の添字なので、表示のたびに names から引く。価格の実額は出さない（価格帯だけ）。
import { PRICE_BANDS } from './explorer-core.js';

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HOT = new Set(['高評価', 'セール中', '初見向け']); // 目立たせるラベル（WorkCard.astro と同じ）

/** 配信開始日（YYYY-MM-DD）を「2023年6月16日」にする。無いときは ― */
export function fmtDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '');
  return m ? `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日` : '―';
}

/** 添字から名前を引く（無ければ空文字） */
const nameOf = (names, kind, i) => (i == null ? '' : (names && names[kind] && names[kind][i]) || '');
const namesOf = (names, kind, list) => (list || []).map((i) => nameOf(names, kind, i)).filter(Boolean);

/** 画像は公式配信の直リンクをそのまま表示する（加工は拡大縮小のみ）。http(s) 以外のURLは使わない。無いときは無地の枠 */
function thumbHtml(w) {
  // 公式の小さい縦長画像（…ps.jpg、147×200）は高解像度の画面でぼやけるため、同じ命名規則の横長ジャケット（…pl.jpg、800px 級）を主に使う。
  // 読めないときは onerror で小さい版に戻す（切り取り・加工はしない。object-fit: contain）
  const small = typeof w.img === 'string' && /^https?:\/\//.test(w.img) ? w.img : '';
  const large = /ps\.jpg$/.test(small) ? small.replace(/ps\.jpg$/, 'pl.jpg') : '';
  if (!small) return `<div class="thumb jk"></div>`;
  if (!large) return `<div class="thumb jk"><img src="${esc(small)}" alt="" loading="lazy" decoding="async" width="147" height="200" class="small"></div>`;
  return `<div class="thumb jk"><img src="${esc(large)}" alt="" loading="lazy" decoding="async" width="800" height="538" data-fallback="${esc(small)}" onerror="if(this.dataset.fallback){this.src=this.dataset.fallback;this.width=147;this.height=200;this.classList.add('small');this.removeAttribute('data-fallback');}"></div>`;
}

function labelsHtml(labels, max) {
  if (!labels.length) return '';
  const items = labels.slice(0, max).map((l) => `<span class="label${HOT.has(l) ? ' hot' : ''}">${esc(l)}</span>`);
  return `<div class="labels">${items.join('')}</div>`;
}

/** 評価の表示（rb はレビュー 5 件以上のときだけ 0.5 刻みの数値） */
const rateText = (rb) => `★ ${Number(rb).toFixed(1)}`;

/** 結果グリッドの1枚。リンクは作品ページ。通常のクリックは explorer-ui.js がモーダルに切り替える */
export function cardHtml(w, names) {
  const actors = namesOf(names, 'actress', w.a);
  const meta = actors.length ? actors.join('、') : nameOf(names, 'maker', w.m);
  const rate = w.rb != null ? `<div class="rate">${rateText(w.rb)}</div>` : '';
  return `<a class="card" href="/v/${encodeURIComponent(w.id)}/" data-id="${esc(w.id)}">
    ${thumbHtml(w)}
    <div class="card-body">
      <div class="card-title">${esc(w.t)}</div>
      ${meta ? `<div class="card-meta">${esc(meta)}</div>` : ''}
      ${rate}
      ${labelsHtml(w.lb, 2)}
    </div></a>`;
}

/** 読み込み中の骨組み（カードと同じ大きさ）。n 枚 */
export const skeletonHtml = (n) => Array.from({ length: n }, () =>
  '<div class="sk-card" aria-hidden="true"><div class="thumb"></div><div class="sk-line"></div><div class="sk-line short"></div></div>').join('');

/** モーダルの本文。価格は実額を出さず、価格帯と「価格は作品ページで」。似た作品は出さない（作品ページに任せる） */
export function modalHtml(w, names) {
  const id = encodeURIComponent(w.id);
  const review = w.rb != null ? `${rateText(w.rb)} <span class="muted">（レビュー5件以上の平均を0.5刻みで表示）</span>` : '<span class="muted">レビューが少ないため表示していません</span>';
  const band = w.pb != null && PRICE_BANDS[w.pb] ? `${PRICE_BANDS[w.pb]}${w.sale ? '（セール中）' : ''}` : '―';
  const row = (dt, dd) => `<dt>${dt}</dt><dd>${dd}</dd>`;
  return `
    <div class="mx-top">
      ${thumbHtml(w)}
      <dl class="spec">
        ${row('出演', esc(namesOf(names, 'actress', w.a).join('、') || '―'))}
        ${row('メーカー', esc(nameOf(names, 'maker', w.m) || '―'))}
        ${row('シリーズ', esc(nameOf(names, 'series', w.s) || '―'))}
        ${row('収録', w.v != null ? `${w.v}分` : '―')}
        ${row('配信開始', fmtDate(w.d))}
        ${row('評価', review)}
        ${row('価格帯', `${esc(band)} <span class="muted">価格は作品ページで</span>`)}
      </dl>
    </div>
    ${labelsHtml(w.lb, w.lb.length)}
    <div class="mx-actions">
      <a class="btn btn-block" href="/v/${id}/">作品ページを開く</a>
      ${w.ob === false ? '' : `<a class="btn btn-cta btn-block" href="/go/${id}/" rel="sponsored nofollow">FANZAで見る</a>`}
    </div>`;
}
