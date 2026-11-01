/* 合成データ（モック用）。露骨な語は一切使わない。シード固定で毎回同じデータになる */
(function (global) {
  // 疑似乱数（mulberry32）
  function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const r = rng(20261101);
  const pick = a => a[Math.floor(r() * a.length)];
  const ri = (a, b) => a + Math.floor(r() * (b - a + 1));
  const pad = (n, w) => String(n).padStart(w, '0');

  const ACTRESSES = Array.from({ length: 20 }, (_, i) => '出演者' + String.fromCharCode(65 + i));
  const MAKERS = Array.from({ length: 8 }, (_, i) => 'メーカー' + String.fromCharCode(65 + i));
  const SERIES = Array.from({ length: 30 }, (_, i) => 'シリーズ' + pad(i + 1, 2));
  const GENRES = Array.from({ length: 20 }, (_, i) => 'タグ' + pad(i + 1, 2));
  const NOW = new Date('2026-11-01T00:00:00');
  const DAY = 864e5;

  // メーカーごとに得意なタグを持たせる（作風の偏りを再現）
  const makerFav = {};
  MAKERS.forEach(m => { const s = new Set(); while (s.size < 4) s.add(pick(GENRES)); makerFav[m] = [...s]; });

  const works = [];
  for (let i = 1; i <= 300; i++) {
    const maker = pick(MAKERS);
    const nAct = r() < 0.08 ? 0 : (r() < 0.75 ? 1 : ri(2, 3));
    const actresses = []; while (actresses.length < nAct) { const a = pick(ACTRESSES); if (!actresses.includes(a)) actresses.push(a); }
    const series = r() < 0.6 ? pick(SERIES) : null;
    const genres = []; const nGen = ri(2, 6);
    while (genres.length < nGen) { const g = r() < 0.5 ? pick(makerFav[maker]) : pick(GENRES); if (!genres.includes(g)) genres.push(g); }
    const days = ri(0, 5 * 365);
    const reviewCount = r() < 0.15 ? 0 : Math.floor(Math.pow(r(), 2) * 500);
    const reviewAvg = reviewCount ? Math.round((1 + Math.pow(r(), 0.5) * 4) * 100) / 100 : 0;
    const price = ri(30, 300) * 10;
    const onSale = r() < 0.15;
    works.push({
      id: 'w' + pad(i, 4), title: '作品 ' + pad(i, 4), actresses, maker, series, genres,
      volumeMin: ri(30, 300), price, salePrice: onSale ? Math.round(price * 0.6 / 10) * 10 : null,
      releasedAt: new Date(NOW.getTime() - days * DAY), reviewCount, reviewAvg, onSale,
      hasSample: r() < 0.7, rank: 0, sampleImages: ri(0, 10),
    });
  }
  // 人気順位: 評価・件数・新しさを混ぜた仮の順位
  works.map(w => ({ w, s: (w.reviewAvg * Math.log1p(w.reviewCount)) + (r() * 3) - (NOW - w.releasedAt) / DAY / 1000 }))
    .sort((a, b) => b.s - a.s).forEach((o, i) => { o.w.rank = i + 1; });

  const bySeries = {}, byActress = {};
  works.forEach(w => { if (w.series) (bySeries[w.series] = bySeries[w.series] || []).push(w); w.actresses.forEach(a => (byActress[a] = byActress[a] || []).push(w)); });

  // ラベル（設計5.2の仮閾値）
  function labelsOf(w) {
    const ageDays = (NOW - w.releasedAt) / DAY; const out = [];
    const isNew = ageDays <= 30, isClassic = ageDays >= 3 * 365 && w.reviewCount >= 50;
    const isTop = w.reviewAvg >= 4.5 && w.reviewCount >= 20, isLong = w.volumeMin >= 180, isShort = w.volumeMin <= 60;
    if (isNew) out.push('新作'); if (isClassic) out.push('定番'); if (isTop) out.push('高評価');
    if (isLong) out.push('長尺'); if (isShort) out.push('短尺'); if (w.onSale) out.push('セール中');
    if (isTop && isClassic && !isLong && !isShort) out.push('初見向け');
    if (w.series && bySeries[w.series].length >= 12) out.push('シリーズ追い向け');
    if (w.actresses.some(a => byActress[a].length >= 20)) out.push('出演者追い向け');
    return out;
  }
  works.forEach(w => { w.labels = labelsOf(w); });
  const LABELS = ['新作', '定番', '高評価', '長尺', '短尺', 'セール中', '初見向け', 'シリーズ追い向け', '出演者追い向け'];

  // 似た作品: タグ集合のJaccard＋同出演者・同シリーズ・同メーカーの加点
  const simCache = {};
  function similar(w, n) {
    if (simCache[w.id]) return simCache[w.id].slice(0, n || 8);
    const g = new Set(w.genres);
    const scored = works.filter(x => x !== w).map(x => {
      const inter = x.genres.filter(t => g.has(t)).length; const uni = new Set([...w.genres, ...x.genres]).size;
      let s = inter / uni;
      if (x.actresses.some(a => w.actresses.includes(a))) s += 0.5;
      if (w.series && x.series === w.series) s += 0.4;
      if (x.maker === w.maker) s += 0.15;
      s -= Math.min(0.1, Math.abs(x.releasedAt - w.releasedAt) / DAY / 3650);
      return { x, s };
    }).sort((a, b) => b.s - a.s).map(o => o.x);
    simCache[w.id] = scored; return scored.slice(0, n || 8);
  }

  // 表示用の整形
  const fmtDate = d => d.getFullYear() + '/' + pad(d.getMonth() + 1, 2) + '/' + pad(d.getDate(), 2);
  const yen = n => n.toLocaleString('ja-JP') + '円';
  const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
  const subject = w => w.actresses.length ? w.actresses.join('、') + '出演' : w.maker + '制作';
  const seriesPart = w => w.series ? '、' + w.maker + 'の' + w.series + 'の1本' : '、' + w.maker + 'の作品';
  const reviewPart = w => w.reviewCount ? 'レビューは' + w.reviewAvg.toFixed(1) + '点（' + w.reviewCount + '件）。' : '';
  const pricePart = w => w.onSale ? 'セール中は' + yen(w.salePrice) + '（通常' + yen(w.price) + '）。' : '価格は' + yen(w.price) + '。';
  const labelLine = w => {
    const l = w.labels; if (!l.length) return '';
    if (l.includes('初見向け')) return 'このシリーズやメーカーを初めて見るなら、評価と長さのバランスからこの1本が入口に向いています。';
    if (l.includes('新作')) return '配信が始まったばかりの新作です。';
    if (l.includes('定番')) return '配信から時間が経っても見られ続けている定番です。';
    if (l.includes('長尺')) return 'まとまった時間を取って見たい長尺作品です。';
    if (l.includes('短尺')) return '短い時間で見られる短尺作品です。';
    if (l.includes('セール中')) return '期間限定のセール対象です。';
    return l[0] + 'に該当します。';
  };
  // 作品ページ用（5文型）
  const PAGE = [
    w => `${subject(w)}${seriesPart(w)}。${w.volumeMin}分、${fmtDate(w.releasedAt)}配信開始。ジャンルは${w.genres.join('、')}。${reviewPart(w)}${labelLine(w)}`,
    w => `${fmtDate(w.releasedAt)}配信開始、${w.volumeMin}分。${subject(w)}${seriesPart(w)}。${reviewPart(w)}ジャンルは${w.genres.join('、')}。${pricePart(w)}${labelLine(w)}`,
    w => `${w.maker}${w.series ? 'の' + w.series : ''}から、${subject(w)}の${w.volumeMin}分作品。${reviewPart(w)}タグは${w.genres.join('、')}。${labelLine(w)}${pricePart(w)}`,
    w => `${subject(w)}。収録${w.volumeMin}分、${fmtDate(w.releasedAt)}配信開始${w.series ? '、' + w.series : ''}。${labelLine(w)}ジャンルは${w.genres.join('、')}。${reviewPart(w)}`,
    w => `ジャンルは${w.genres.join('、')}。${subject(w)}${seriesPart(w)}で、${w.volumeMin}分。${pricePart(w)}${reviewPart(w)}${labelLine(w)}`,
  ];
  // カード用（5文型）
  const CARD = [
    w => `${w.volumeMin}分${w.reviewCount ? '・' + w.reviewAvg.toFixed(1) + '点' : ''}・${yen(w.onSale ? w.salePrice : w.price)}`,
    w => `${w.series || w.maker}・${w.volumeMin}分${w.reviewCount ? '・' + w.reviewCount + '件' : ''}`,
    w => `${fmtDate(w.releasedAt)}・${w.volumeMin}分・${yen(w.onSale ? w.salePrice : w.price)}`,
    w => `${w.genres.slice(0, 2).join('・')}・${w.volumeMin}分`,
    w => `${w.reviewCount ? w.reviewAvg.toFixed(1) + '点（' + w.reviewCount + '件）・' : ''}${w.volumeMin}分`,
  ];
  const pageText = w => PAGE[hash(w.id) % PAGE.length](w);
  const cardText = w => CARD[hash(w.id + 'c') % CARD.length](w);
  // X投稿用（140字以内）
  const postText = w => { const t = `${w.labels[0] ? w.labels[0] + '。' : ''}${subject(w)}「${w.title}」${w.volumeMin}分${w.reviewCount ? '、' + w.reviewAvg.toFixed(1) + '点' : ''}。 #PR`; return t.slice(0, 140); };

  const byId = {}; works.forEach(w => { byId[w.id] = w; });
  global.MOCK = { works, byId, ACTRESSES, MAKERS, SERIES, GENRES, LABELS, NOW, DAY, similar, pageText, cardText, postText, fmtDate, yen, hash };
})(typeof window !== 'undefined' ? window : globalThis);
