// 探索ページの見た目（カードとモーダルのHTML）。文字は必ず esc() を通す。
// カードは src/components/WorkCard.astro（variant="grid"）と同じクラス構成にしてある（見た目を変えるときは両方を直す）。

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HOT = new Set(['高評価', 'セール中', '初見向け']); // 目立たせるラベル（WorkCard.astro と同じ）
const yen = (n) => `${n.toLocaleString('ja-JP')}円`;

/** 配信開始日（YYYY-MM-DD）を「2023年6月16日」にする。無いときは ― */
function fmtDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '');
  return m ? `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日` : '―';
}

/** 画像は公式配信の直リンクをそのまま表示する（加工は拡大縮小のみ）。http(s) 以外のURLは使わない。無いときは無地の枠 */
function thumbHtml(w) {
  const src = typeof w.img === 'string' && /^https?:\/\//.test(w.img) ? w.img : '';
  return src
    ? `<div class="thumb"><img src="${esc(src)}" alt="" loading="lazy" decoding="async"></div>`
    : `<div class="thumb"></div>`;
}

function labelsHtml(labels, max) {
  if (!labels.length) return '';
  const items = labels.slice(0, max).map((l) => `<span class="label${HOT.has(l) ? ' hot' : ''}">${esc(l)}</span>`);
  return `<div class="labels">${items.join('')}</div>`;
}

/** 結果グリッドの1枚。リンクは作品ページ。通常のクリックは explorer-ui.js がモーダルに切り替える */
export function cardHtml(w) {
  const meta = w.a.length ? w.a.join('、') : w.m;
  const rate = w.ra != null && w.rc > 0 ? `<div class="rate">★ ${w.ra.toFixed(1)} <span class="dim">${w.rc}件</span></div>` : '';
  return `<a class="card" href="/v/${encodeURIComponent(w.id)}/" data-id="${esc(w.id)}">
    ${thumbHtml(w)}
    <div class="card-body">
      <div class="card-title">${esc(w.t)}</div>
      ${meta ? `<div class="card-meta">${esc(meta)}</div>` : ''}
      ${rate}
      ${labelsHtml(w.lb, 2)}
    </div></a>`;
}

/** モーダルの本文。似た作品は出さない（作品ページに任せる） */
export function modalHtml(w) {
  const id = encodeURIComponent(w.id);
  const review = w.ra != null && w.rc > 0 ? `${w.ra.toFixed(2)}点・${w.rc}件` : 'まだありません';
  // セール中は、いまの価格（p）と定価（lp）を並べる。値引きになっていないときは p だけ
  const price = w.p == null ? '―'
    : w.sale && w.lp != null && w.lp > w.p
      ? `<span class="price"><span class="sale">${yen(w.p)}</span> <s class="muted">${yen(w.lp)}</s></span>`
      : `<span class="price">${yen(w.p)}</span>`;
  const row = (dt, dd) => `<dt>${dt}</dt><dd>${dd}</dd>`;
  return `
    <div class="mx-top">
      ${thumbHtml(w)}
      <dl class="spec">
        ${row('出演', esc(w.a.join('、') || '―'))}
        ${row('メーカー', esc(w.m || '―'))}
        ${row('シリーズ', esc(w.s || '―'))}
        ${row('収録', w.v != null ? `${w.v}分` : '―')}
        ${row('配信開始', fmtDate(w.d))}
        ${row('レビュー', review)}
        ${row('価格', price)}
      </dl>
    </div>
    ${labelsHtml(w.lb, w.lb.length)}
    <div class="mx-actions">
      <a class="btn btn-block" href="/v/${id}/">作品ページを開く</a>
      ${w.ob === false ? '' : `<a class="btn btn-cta btn-block" href="/go/${id}/" rel="sponsored nofollow">FANZAで見る <small>（PR）</small></a>`}
    </div>`;
}
