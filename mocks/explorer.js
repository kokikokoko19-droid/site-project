/* 探索ページ: 重み付け並べ替え・絞り込み・検索・ランダム。状態はURLクエリに保持 */
(function () {
  const M = window.MOCK, UI = window.UI, q = UI.q;
  UI.shell('explorer');
  const PAGE = 40; // 一度に描画する件数（スクロールで追加）

  // 並べ替えの軸: 評価・新しさ・価格・長さ・人気
  const AXES = [['e', '評価', 0.4], ['r', '新しさ', 0.2], ['p', '価格の安さ', 0.1], ['l', '長さの好み', 0.1], ['pop', '人気', 0.2]];
  const meanAvg = M.works.filter(w => w.reviewCount).reduce((s, w) => s + w.reviewAvg, 0) / M.works.filter(w => w.reviewCount).length;
  const C = 20; // ベイズ平均の事前件数
  const LEN_TARGET = { short: 50, mid: 110, long: 200 };
  function score(w, st) {
    const bayes = ((w.reviewAvg * w.reviewCount) + (meanAvg * C)) / (w.reviewCount + C) / 5;
    const rec = Math.exp(-((M.NOW - w.releasedAt) / M.DAY) / 365);
    const price = 1 - ((w.onSale ? w.salePrice : w.price) - 300) / 2700;
    const len = Math.max(0, 1 - Math.abs(w.volumeMin - LEN_TARGET[st.len]) / 150);
    const pop = 1 - (w.rank - 1) / (M.works.length - 1);
    return st.w.e * bayes + st.w.r * rec + st.w.p * price + st.w.l * len + st.w.pop * pop;
  }

  // 状態 <-> URL
  const defaults = () => ({ w: { e: 0.4, r: 0.2, p: 0.1, l: 0.1, pop: 0.2 }, len: 'mid', g: [], act: '', ser: '', mak: '', pmin: '', pmax: '', vmin: '', vmax: '', year: '', sale: false, sample: false, lab: [], q: '', sort: '' });
  let st = defaults();
  function readURL() {
    const u = new URLSearchParams(location.search); st = defaults();
    AXES.forEach(([k]) => { if (u.has('w_' + k)) st.w[k] = +u.get('w_' + k); });
    if (u.get('len')) st.len = u.get('len');
    ['act', 'ser', 'mak', 'pmin', 'pmax', 'vmin', 'vmax', 'year', 'q', 'sort'].forEach(k => { if (u.get(k)) st[k] = u.get(k); });
    st.g = u.getAll('g'); st.lab = u.getAll('lab'); st.sale = u.get('sale') === '1'; st.sample = u.get('sample') === '1';
    if (st.sort === 'new') st.w = { e: 0, r: 1, p: 0, l: 0, pop: 0 };
  }
  function writeURL() {
    const u = new URLSearchParams();
    AXES.forEach(([k, , d]) => { if (st.w[k] !== d) u.set('w_' + k, st.w[k]); });
    if (st.len !== 'mid') u.set('len', st.len);
    st.g.forEach(g => u.append('g', g)); st.lab.forEach(l => u.append('lab', l));
    ['act', 'ser', 'mak', 'pmin', 'pmax', 'vmin', 'vmax', 'year', 'q'].forEach(k => { if (st[k]) u.set(k, st[k]); });
    if (st.sale) u.set('sale', '1'); if (st.sample) u.set('sample', '1');
    history.replaceState(null, '', location.pathname + (u.toString() ? '?' + u : ''));
  }

  // 絞り込み
  function matches(w) {
    if (st.g.length && !st.g.every(g => w.genres.includes(g))) return false;
    if (st.act && !w.actresses.includes(st.act)) return false;
    if (st.ser && w.series !== st.ser) return false;
    if (st.mak && w.maker !== st.mak) return false;
    const price = w.onSale ? w.salePrice : w.price;
    if (st.pmin !== '' && price < +st.pmin) return false; if (st.pmax !== '' && price > +st.pmax) return false;
    if (st.vmin !== '' && w.volumeMin < +st.vmin) return false; if (st.vmax !== '' && w.volumeMin > +st.vmax) return false;
    if (st.year && w.releasedAt.getFullYear() !== +st.year) return false;
    if (st.sale && !w.onSale) return false; if (st.sample && !w.hasSample) return false;
    if (st.lab.length && !st.lab.every(l => w.labels.includes(l))) return false;
    if (st.q) { const k = st.q.toLowerCase(); const hay = [w.title, w.maker, w.series || '', ...w.actresses].join(' ').toLowerCase(); if (!hay.includes(k)) return false; }
    return true;
  }
  let current = [], shown = 0;
  function render() {
    current = M.works.filter(matches).map(w => ({ w, s: score(w, st) })).sort((a, b) => b.s - a.s).map(o => o.w);
    q('#count').textContent = current.length;
    q('#query-note').textContent = st.q ? `「${st.q}」で検索中` : '';
    q('#results').innerHTML = ''; shown = 0; more();
    q('#empty').hidden = current.length > 0;
    if (!current.length) {
      const acts = [];
      if (st.g.length) acts.push(['ジャンルを外す', () => { st.g = []; }]);
      if (st.lab.length) acts.push(['ラベルを外す', () => { st.lab = []; }]);
      if (st.act || st.ser || st.mak) acts.push(['出演者・シリーズ・メーカーを外す', () => { st.act = st.ser = st.mak = ''; }]);
      if (st.pmin || st.pmax || st.vmin || st.vmax || st.year) acts.push(['価格・長さ・年を外す', () => { st.pmin = st.pmax = st.vmin = st.vmax = st.year = ''; }]);
      if (st.sale || st.sample) acts.push(['条件を外す', () => { st.sale = st.sample = false; }]);
      if (st.q) acts.push(['検索語を消す', () => { st.q = ''; }]);
      q('#empty-actions').innerHTML = acts.map(([t], i) => `<button class="btn" data-i="${i}">${t}</button>`).join('');
      q('#empty-actions').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { acts[+b.dataset.i][1](); sync(); }));
    }
    writeURL();
  }
  function more() { const next = current.slice(shown, shown + PAGE); q('#results').insertAdjacentHTML('beforeend', next.map(UI.card).join('')); shown += next.length; q('#more').textContent = shown < current.length ? `${shown} / ${current.length} 件を表示中。スクロールで続きを読み込みます` : (current.length ? 'すべて表示しました' : ''); }
  window.addEventListener('scroll', () => { if (shown < current.length && window.innerHeight + window.scrollY > document.body.offsetHeight - 600) more(); });

  // 入力部品の生成
  function buildControls() {
    q('#sliders').innerHTML = AXES.map(([k, name]) => `<label class="slider"><span>${name}</span><b id="v-${k}"></b><input type="range" min="0" max="1" step="0.05" data-k="${k}"></label>`).join('') +
      `<div class="field">長さの好み<div class="chips" id="len-chips">${[['short', '短め'], ['mid', '標準'], ['long', '長め']].map(([v, t]) => `<button class="chip" data-len="${v}">${t}</button>`).join('')}</div></div>`;
    q('#genre-chips').innerHTML = M.GENRES.map(g => `<button class="chip" data-g="${g}">${g}</button>`).join('');
    q('#label-chips').innerHTML = M.LABELS.map(l => `<button class="chip" data-lab="${l}">${l}</button>`).join('');
    const opt = (sel, arr) => { q(sel).insertAdjacentHTML('beforeend', arr.map(v => `<option value="${v}">${v}</option>`).join('')); };
    opt('#f-act', M.ACTRESSES); opt('#f-ser', M.SERIES); opt('#f-mak', M.MAKERS);
    const years = [...new Set(M.works.map(w => w.releasedAt.getFullYear()))].sort((a, b) => b - a); opt('#f-year', years);
    document.querySelectorAll('#sliders input[type=range]').forEach(i => i.addEventListener('input', () => { st.w[i.dataset.k] = +i.value; sync(); }));
    q('#len-chips').addEventListener('click', e => { const b = e.target.closest('[data-len]'); if (b) { st.len = b.dataset.len; sync(); } });
    q('#genre-chips').addEventListener('click', e => { const b = e.target.closest('[data-g]'); if (b) { const g = b.dataset.g; st.g = st.g.includes(g) ? st.g.filter(x => x !== g) : [...st.g, g]; sync(); } });
    q('#label-chips').addEventListener('click', e => { const b = e.target.closest('[data-lab]'); if (b) { const l = b.dataset.lab; st.lab = st.lab.includes(l) ? st.lab.filter(x => x !== l) : [...st.lab, l]; sync(); } });
    [['#f-act', 'act'], ['#f-ser', 'ser'], ['#f-mak', 'mak'], ['#f-year', 'year'], ['#f-pmin', 'pmin'], ['#f-pmax', 'pmax'], ['#f-vmin', 'vmin'], ['#f-vmax', 'vmax']].forEach(([sel, k]) => q(sel).addEventListener('change', e => { st[k] = e.target.value; sync(); }));
    q('#f-sale').addEventListener('change', e => { st.sale = e.target.checked; sync(); });
    q('#f-sample').addEventListener('change', e => { st.sample = e.target.checked; sync(); });
    q('#btn-reset').addEventListener('click', () => { st = defaults(); sync(); });
    q('#btn-random').addEventListener('click', () => { if (current.length) UI.openModal(current[Math.floor(Math.random() * current.length)]); });
  }
  // 状態を部品に反映してから描画
  function sync() {
    AXES.forEach(([k]) => { const i = q(`#sliders input[data-k="${k}"]`); i.value = st.w[k]; q('#v-' + k).textContent = st.w[k].toFixed(2); });
    document.querySelectorAll('[data-len]').forEach(b => b.classList.toggle('on', b.dataset.len === st.len));
    document.querySelectorAll('[data-g]').forEach(b => b.classList.toggle('on', st.g.includes(b.dataset.g)));
    document.querySelectorAll('[data-lab]').forEach(b => b.classList.toggle('on', st.lab.includes(b.dataset.lab)));
    q('#f-act').value = st.act; q('#f-ser').value = st.ser; q('#f-mak').value = st.mak; q('#f-year').value = st.year;
    q('#f-pmin').value = st.pmin; q('#f-pmax').value = st.pmax; q('#f-vmin').value = st.vmin; q('#f-vmax').value = st.vmax;
    q('#f-sale').checked = st.sale; q('#f-sample').checked = st.sample;
    render();
  }
  buildControls(); readURL(); sync();
  // スマホでは絞り込みパネルを畳んで、結果を先に見せる
  if (window.innerWidth < 960) document.querySelectorAll('#panel details').forEach(d => { d.open = false; });
})();
