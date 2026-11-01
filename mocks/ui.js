/* 共通部品（ヘッダー、PR帯、年齢確認、フッター、カード、モーダル） */
(function (global) {
  const M = global.MOCK;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const q = (sel, el) => (el || document).querySelector(sel);

  // 画像プレースホルダー（外部画像を使わない）。IDから色相を決める
  function thumbStyle(w, wide) {
    const h = M.hash(w.id) % 360; const h2 = (h + 40) % 360;
    return `background: linear-gradient(145deg, hsl(${h} 28% 30%), hsl(${h2} 24% 16%));`;
  }
  function thumb(w, wide) { return `<div class="thumb${wide ? ' wide' : ''}" style="${thumbStyle(w, wide)}">${esc(w.title.replace('作品 ', '#'))}</div>`; }
  function labels(w, max) { return `<div class="labels">${w.labels.slice(0, max || 3).map(l => `<span class="label${['高評価', 'セール中', '初見向け'].includes(l) ? ' hot' : ''}">${esc(l)}</span>`).join('')}</div>`; }
  function priceHtml(w) { return w.onSale ? `<span class="price"><span class="sale">${M.yen(w.salePrice)}</span> <s class="muted">${M.yen(w.price)}</s></span>` : `<span class="price">${M.yen(w.price)}</span>`; }

  function card(w) {
    return `<article class="card" data-id="${w.id}" tabindex="0" role="button" aria-label="${esc(w.title)}の詳細">
      ${thumb(w)}
      <div class="card-body">
        <div class="card-title">${esc(w.title)}</div>
        <div class="card-meta">${esc(w.actresses.length ? w.actresses.join('、') : w.maker)}</div>
        <div class="card-line">${esc(M.cardText(w))}</div>
        ${labels(w, 3)}
      </div></article>`;
  }

  // 作品詳細（モーダルと作品ページで共用）
  function detail(w, opts) {
    opts = opts || {};
    const gal = w.sampleImages ? `<div class="gallery">${Array.from({ length: w.sampleImages }, (_, i) => `<div>サンプル画像 ${i + 1}</div>`).join('')}</div>` : `<p class="muted">サンプル画像はありません。</p>`;
    const video = w.hasSample ? `<div class="video">公式埋め込み動画<span class="muted">（API の sampleMovieURL を iframe で表示）</span></div>` : '';
    const sim = M.similar(w, 8);
    return `
      <div class="detail">
        <div>${thumb(w, true)}<div style="margin-top:8px">${labels(w, 9)}</div></div>
        <div class="stack" style="gap:16px">
          <p class="lead">${esc(M.pageText(w))}</p>
          <dl class="spec">
            <dt>出演</dt><dd>${esc(w.actresses.join('、') || '―')}</dd>
            <dt>メーカー</dt><dd>${esc(w.maker)}</dd>
            <dt>シリーズ</dt><dd>${esc(w.series || '―')}</dd>
            <dt>収録</dt><dd>${w.volumeMin}分</dd>
            <dt>配信開始</dt><dd>${M.fmtDate(w.releasedAt)}</dd>
            <dt>レビュー</dt><dd>${w.reviewCount ? w.reviewAvg.toFixed(2) + '点・' + w.reviewCount + '件' : 'まだありません'}</dd>
            <dt>価格</dt><dd>${priceHtml(w)}</dd>
          </dl>
          <a class="btn btn-cta btn-block" href="#" onclick="return false">FANZAで見る <small>PR</small></a>
          ${opts.pageLink ? `<a class="btn btn-block" href="work.html?id=${w.id}">作品ページを開く</a>` : ''}
          <div class="axis-links">
            ${w.actresses.map(a => `<a href="explorer.html?act=${encodeURIComponent(a)}">${esc(a)}</a>`).join('')}
            ${w.series ? `<a href="explorer.html?ser=${encodeURIComponent(w.series)}">${esc(w.series)}</a>` : ''}
            <a href="explorer.html?mak=${encodeURIComponent(w.maker)}">${esc(w.maker)}</a>
            ${w.genres.map(g => `<a href="explorer.html?g=${encodeURIComponent(g)}">${esc(g)}</a>`).join('')}
          </div>
        </div>
      </div>
      <div><h3 style="margin-bottom:8px">サンプル</h3>${video}<div style="height:8px"></div>${gal}</div>
      <div class="ad-slot">広告スロット（空）</div>
      <div><div class="section-head"><h3>似た作品</h3><span class="muted">タグの重なりと同出演者・同シリーズで自動選定</span></div><div class="grid">${sim.map(card).join('')}</div></div>`;
  }

  // モーダル
  function ensureModal() {
    if (q('#modal')) return;
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-bg" id="modal" role="dialog" aria-modal="true"><div class="modal"><div class="modal-head"><h2 id="modal-title"></h2><button class="icon-btn" id="modal-close" aria-label="閉じる">✕</button></div><div class="modal-body" id="modal-body"></div></div></div>`);
    q('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.id === 'modal-close') closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  }
  function openModal(w) { ensureModal(); q('#modal-title').textContent = w.title; q('#modal-body').innerHTML = detail(w, { pageLink: true }); q('#modal').classList.add('open'); q('.modal').scrollTop = 0; document.body.style.overflow = 'hidden'; }
  function closeModal() { const m = q('#modal'); if (m) m.classList.remove('open'); document.body.style.overflow = ''; }
  // カードのクリックでモーダル（イベント委任）
  document.addEventListener('click', e => { const c = e.target.closest('.card'); if (c && M.byId[c.dataset.id]) openModal(M.byId[c.dataset.id]); });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('card')) openModal(M.byId[e.target.dataset.id]); });

  // ヘッダー・PR帯・フッター・年齢確認
  function shell(active) {
    const nav = [['top.html', 'トップ'], ['explorer.html', '探索'], ['explorer.html?sort=new', '新着'], ['explorer.html?sale=1', 'セール'], ['explorer.html?lab=高評価', 'ランキング'], ['#', '特集'], ['#', '使い方']];
    const header = `<header class="site-header"><div class="wrap">
        <a class="logo" href="top.html">カタログ<span>（仮）</span></a>
        <form class="search" onsubmit="location.href='explorer.html?q='+encodeURIComponent(this.q.value);return false"><input name="q" type="search" placeholder="タイトル・出演者・シリーズ・メーカーで検索" aria-label="検索"></form>
        <nav class="nav">${nav.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}</nav>
      </div></header>
      <div class="pr-band"><div class="wrap"><b>PR</b>本サイトはFANZAアフィリエイトプログラムを利用しており、作品リンクはPRです。</div></div>`;
    const footer = `<footer class="site-footer"><div class="wrap">
        <div class="links"><a href="#">運営者情報</a><a href="#">利用規約</a><a href="#">プライバシーポリシー</a><a href="#">掲載停止のご依頼</a><a href="#">お問い合わせ</a></div>
        <div>データ更新: ${M.fmtDate(M.NOW)} 06:00（毎日自動更新・モック表示）／画像・動画はDMM.comの提供／18歳未満の方の閲覧はお断りします。</div>
        <div class="ad-slot" style="margin-top:16px">広告スロット（空）</div>
      </div></footer>`;
    const gate = `<div class="age-gate" id="age-gate"><div class="age-box">
        <h2>年齢確認</h2><p class="muted">このサイトは成人向けの作品情報を扱います。あなたは18歳以上ですか。</p>
        <div class="row"><button class="btn btn-cta" id="age-yes">18歳以上です</button><button class="btn" id="age-no">18歳未満です</button></div>
      </div></div>`;
    document.body.insertAdjacentHTML('afterbegin', header);
    document.body.insertAdjacentHTML('beforeend', footer + gate);
    let ok = false; try { ok = localStorage.getItem('age_ok') === '1'; } catch (e) {}
    if (!ok) { q('#age-gate').classList.add('open'); }
    q('#age-yes').addEventListener('click', () => { try { localStorage.setItem('age_ok', '1'); } catch (e) {} q('#age-gate').classList.remove('open'); });
    q('#age-no').addEventListener('click', () => { location.href = 'about:blank'; });
  }

  global.UI = { esc, q, thumb, labels, card, detail, openModal, closeModal, shell };
})(window);
