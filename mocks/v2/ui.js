/* 共通部品 v2（ヘッダー、PR帯、年齢確認、フッター、カード、棚、発見、モーダル）。API は v1 と同じ名前を保つ */
(function (global) {
  const M = global.MOCK;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const q = (sel, el) => (el || document).querySelector(sel);

  // 印（朱印風のロゴマーク）。本番は SVG ファイルにする
  const mark = (cls) => `<svg class="${cls || 'mark'}" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="13.6" fill="none" stroke="var(--seal)" stroke-width="2.2" stroke-dasharray="48 2.5 22 1.5 10 1.2" transform="rotate(-24 16 16)"/>
      <text x="16" y="21.6" text-anchor="middle" font-size="15.5" font-weight="700" fill="var(--seal)" style="font-family: var(--font-display)">巡</text>
    </svg>`;

  // 表紙の仮置き（外部画像を使わない）。IDから色相を決め、帯に番号を出す
  function thumbStyle(w) {
    const h = M.hash(w.id) % 360; const h2 = (h + 40) % 360;
    return `background: linear-gradient(160deg, hsl(${h} 30% 32%), hsl(${h2} 26% 14%));`;
  }
  function thumb(w, wide) { return `<div class="thumb${wide ? ' wide' : ''}" style="${thumbStyle(w)}" data-obi="No. ${esc(w.id.slice(1))}"></div>`; }
  function labels(w, max) { return `<div class="labels">${w.labels.slice(0, max || 2).map(l => `<span class="label${['高評価', 'セール中', '初見向け'].includes(l) ? ' hot' : ''}">${esc(l)}</span>`).join('')}</div>`; }
  function rate(w) { return w.reviewCount ? `<div class="rate">★ ${w.reviewAvg.toFixed(1)} <span class="dim">${w.reviewCount}件</span></div>` : `<div class="rate dim" style="font-family:var(--font)">レビューはまだありません</div>`; }
  function priceHtml(w) { return w.onSale ? `<span class="price"><span class="sale">${M.yen(w.salePrice)}</span><s>${M.yen(w.price)}</s></span>` : `<span class="price">${M.yen(w.price)}</span>`; }
  const who = w => esc(w.actresses.length ? w.actresses.join('、') : w.maker);

  // 格子用のカード（表紙・題名・出演・評価・ラベル2つ）
  function card(w) {
    return `<article class="card" data-id="${w.id}" tabindex="0" role="button" aria-label="${esc(w.title)}の詳細">
      ${thumb(w)}
      <div class="card-body">
        <div class="card-title">${esc(w.title)}</div>
        <div class="card-meta">${who(w)}</div>
        ${rate(w)}
        ${labels(w, 2)}
      </div></article>`;
  }
  // 棚用（横並び。セールは値札を付ける）
  function shelfCard(w, opts) {
    opts = opts || {};
    const tag = opts.tag && w.onSale ? `<span class="tag">${M.yen(w.salePrice)}<s>${M.yen(w.price)}</s></span>` : '';
    const sub = opts.sub ? opts.sub(w) : who(w);
    return `<article class="card" data-id="${w.id}" tabindex="0" role="button" aria-label="${esc(w.title)}の詳細">
      ${tag}${thumb(w)}
      <div class="card-body"><div class="card-title">${esc(w.title)}</div><div class="card-meta">${esc(sub)}</div></div></article>`;
  }
  function shelf(items, opts) { return `<div class="shelf-wrap"><div class="shelf">${items.map(w => shelfCard(w, opts)).join('')}</div></div>`; }
  // 今日の発見（理由つき）
  function find(w) {
    return `<article class="find card" data-id="${w.id}" tabindex="0" role="button" aria-label="${esc(w.title)}の詳細">
      ${thumb(w)}
      <div>
        <div class="who">${who(w)}</div>
        <h3>${esc(w.title)}</h3>
        <p class="why">${esc(M.cardText(w))}</p>
        ${rate(w)}
      </div></article>`;
  }

  // 作品詳細（モーダルと作品ページで共用）
  function detail(w, opts) {
    opts = opts || {};
    const gal = w.sampleImages ? `<div class="gallery">${Array.from({ length: w.sampleImages }, (_, i) => `<div>${i + 1}</div>`).join('')}</div>` : `<p class="muted">サンプル画像はありません。</p>`;
    const video = w.hasSample ? `<div class="video"><div class="play">▶</div><div>サンプル動画を再生<span class="dim">　公式プレーヤー（DMM.com）を読み込みます</span></div></div>` : '';
    const sim = M.similar(w, 8);
    const axis = `<div class="axis-links">
        ${w.actresses.map(a => `<a href="explorer.html?act=${encodeURIComponent(a)}"><span class="k">出演</span>${esc(a)}</a>`).join('')}
        ${w.series ? `<a href="explorer.html?ser=${encodeURIComponent(w.series)}"><span class="k">シリーズ</span>${esc(w.series)}</a>` : ''}
        <a href="explorer.html?mak=${encodeURIComponent(w.maker)}"><span class="k">メーカー</span>${esc(w.maker)}</a>
        ${w.genres.map(g => `<a href="explorer.html?g=${encodeURIComponent(g)}">${esc(g)}</a>`).join('')}
      </div>`;
    return `
      <div class="detail">
        <div class="stack" style="gap:12px">${thumb(w, true)}${gal}</div>
        <div class="stack">
          <p class="lead">${esc(M.pageText(w))}</p>
          <dl class="spec">
            <dt>出演</dt><dd>${esc(w.actresses.join('、') || '―')}</dd>
            <dt>メーカー</dt><dd>${esc(w.maker)}</dd>
            <dt>シリーズ</dt><dd>${esc(w.series || '―')}</dd>
            <dt>収録</dt><dd class="num">${w.volumeMin}分</dd>
            <dt>配信開始</dt><dd class="num">${M.fmtDate(w.releasedAt)}</dd>
            <dt>レビュー</dt><dd class="num">${w.reviewCount ? w.reviewAvg.toFixed(2) + '点・' + w.reviewCount + '件' : 'まだありません'}</dd>
          </dl>
          <div class="cta-box">
            <div class="row" style="justify-content:space-between"><span class="dim" style="font-size:12px;letter-spacing:.08em">価格</span>${priceHtml(w)}</div>
            <a class="btn btn-cta btn-block" href="#" onclick="return false">FANZAで見る <small>PR</small></a>
            ${opts.pageLink ? `<a class="btn btn-block" href="work.html?id=${w.id}">作品ページを開く</a>` : ''}
            <p class="note">価格と配信形式はデータ更新時点のものです。最新は販売ページで確認してください。</p>
          </div>
          ${axis}
        </div>
      </div>
      ${video ? `<div><div class="section-head"><h3>サンプル動画</h3></div>${video}</div>` : ''}
      <div class="ad-slot">広告スロット（空）</div>
      <div><div class="section-head"><h3>似た作品</h3><span class="sub">ジャンルの重なりと同じ出演者・シリーズから</span></div>${shelf(sim)}</div>`;
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
  document.addEventListener('click', e => { const c = e.target.closest('.card'); if (c && M.byId[c.dataset.id]) openModal(M.byId[c.dataset.id]); });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('card')) openModal(M.byId[e.target.dataset.id]); });

  // ヘッダー・PR帯・フッター・年齢確認
  function shell(active) {
    const nav = [['top.html', 'トップ', 'top'], ['explorer.html', '探索', 'explore'], ['explorer.html?sort=new', '新着', 'new'], ['explorer.html?sale=1', 'セール', 'sale'], ['explorer.html?lab=高評価', 'ランキング', 'rank'], ['#', '特集', 'feature'], ['#', '使い方', 'guide']];
    const header = `<header class="site-header"><div class="wrap">
        <a class="logo" href="top.html">${mark()}AVめぐり<span class="tagline">AV女優とおすすめ作品を見て回るカタログ</span></a>
        <form class="search" onsubmit="location.href='explorer.html?q='+encodeURIComponent(this.q.value);return false"><input name="q" type="search" placeholder="作品名・出演者・シリーズ・メーカー" aria-label="検索"></form>
        <nav class="nav">${nav.map(([h, t, k]) => `<a href="${h}" class="${k === active ? 'on' : ''}">${t}</a>`).join('')}</nav>
      </div></header>
      <div class="pr-band"><div class="wrap"><b>PR</b>本サイトはFANZAアフィリエイトプログラムを利用しており、作品リンクはPRです。</div></div>`;
    const footer = `<footer class="site-footer"><div class="wrap"><div class="cols">
        <div>
          <div class="brand">${mark()}AVめぐり</div>
          <div>AV女優とおすすめ作品を見て回るカタログ。作品データは毎朝6時に更新。画像と動画は公式配信の直リンクで、転載も加工もしていません。18歳未満の方の閲覧はお断りします。</div>
          <div class="credit" style="margin-top:8px">Powered by <a href="https://affiliate.dmm.com/api/">FANZA Webサービス</a></div>
        </div>
        <div class="links"><a href="#">運営者情報</a><a href="#">利用規約</a><a href="#">プライバシーポリシー</a><a href="#">掲載停止のご依頼</a><a href="#">お問い合わせ</a></div>
      </div><div class="ad-slot" style="margin-top:16px">広告スロット（空）</div></div></footer>`;
    const gate = `<div class="age-gate" id="age-gate"><div class="age-box">
        ${mark('mark')}<h2>年齢確認</h2><p class="muted">AVめぐりは成人向けの作品情報を扱います。<br>あなたは18歳以上ですか。</p>
        <div class="row"><button class="btn btn-cta" id="age-yes">18歳以上です</button><button class="btn" id="age-no">18歳未満です</button></div>
      </div></div>`;
    document.body.insertAdjacentHTML('afterbegin', header);
    document.body.insertAdjacentHTML('beforeend', footer + gate);
    let ok = false; try { ok = localStorage.getItem('age_ok') === '1'; } catch (e) {}
    if (!ok) { q('#age-gate').classList.add('open'); }
    q('#age-yes').addEventListener('click', () => { try { localStorage.setItem('age_ok', '1'); } catch (e) {} q('#age-gate').classList.remove('open'); });
    q('#age-no').addEventListener('click', () => { location.href = 'about:blank'; });
  }

  global.UI = { esc, q, mark, thumb, labels, rate, card, shelf, find, detail, openModal, closeModal, shell };
})(window);
