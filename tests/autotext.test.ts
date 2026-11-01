import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VARIANT_COUNT, cardText, hash, pageText, postText, renderCard, renderPage, renderPost, variantOf } from '../src/lib/autotext.ts';
import type { CatalogWork } from '../src/lib/catalog.ts';
import { fmtDate, minutes, yen, ymd } from '../src/lib/format.ts';

/** 中立な名前だけで作った作品。変えたい項目だけ渡す */
function mk(over: Partial<CatalogWork> = {}): CatalogWork {
  return {
    contentId: 'w0001', productId: null, title: '作品 0001', url: null, affiliateUrl: null,
    volumeMin: 120, releasedAt: '2026-11-01', reviewCount: 120, reviewAvg: 4.25, priceMin: 1480, listPrice: 1980,
    deliveries: [], imageList: null, imageSmall: null, imageLarge: null, sampleImages: [], sampleMovie: null, campaigns: [],
    genres: [{ id: 'g1', name: 'タグ01' }, { id: 'g2', name: 'タグ02' }],
    actresses: [{ id: 'a1', name: '出演者A' }, { id: 'a2', name: '出演者B' }],
    series: [{ id: 's1', name: 'シリーズ01' }], makers: [{ id: 'm1', name: 'メーカー01' }], labels: [], directors: [],
    rankPosition: null, fetchedAt: '2026-11-01T00:00:00Z', status: 'active',
    derivedLabels: ['新作', 'セール中'], similarIds: [], ...over,
  };
}
const refs = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix}${String(i + 1).padStart(2, '0')}` }));
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const KINDS = ['page', 'card', 'post'] as const;

const BAD = ['不明', 'null', 'undefined', 'NaN', '―', '。。', '、。', '・・'];
/** 欠損の代替表示・区切りの連続・区切りで始まる文が無いこと */
function assertClean(text: string, where: string): void {
  for (const bad of BAD) assert.ok(!text.includes(bad), `${where}: 「${bad}」を含みます: ${text}`);
  assert.ok(!/^[、。・]|・$/.test(text), `${where}: 区切りで始まる／終わっています: ${text}`);
  assert.ok(!text.split('。').some((s) => s.startsWith('、')), `${where}: 読点から始まる文があります: ${text}`);
}

const CASES: Record<string, CatalogWork> = {
  全部あり: mk(),
  出演者なし: mk({ actresses: [] }),
  レビューなし: mk({ reviewCount: 0, reviewAvg: null }),
  シリーズなし: mk({ series: [] }),
  価格なし: mk({ priceMin: null, listPrice: null }),
  尺なし: mk({ volumeMin: null }),
  日付なし: mk({ releasedAt: null }),
  ジャンルなし: mk({ genres: [] }),
  メーカーなし: mk({ makers: [] }),
  出演者もメーカーもなし: mk({ actresses: [], makers: [] }),
  ラベルなし: mk({ derivedLabels: [] }),
  全部なし: mk({ actresses: [], makers: [], series: [], genres: [], volumeMin: null, releasedAt: null, reviewCount: 0, reviewAvg: null, priceMin: null, listPrice: null, derivedLabels: [] }),
};

describe('欠損時の自動文', () => {
  for (const [name, w] of Object.entries(CASES)) {
    it(`${name}: 全文型で不正な文字列・区切りが出ない`, () => {
      for (const v of range(VARIANT_COUNT.page)) assertClean(renderPage(w, v), `page#${v}`);
      for (const v of range(VARIANT_COUNT.card)) assertClean(renderCard(w, v), `card#${v}`);
      for (const v of range(VARIANT_COUNT.post)) {
        const t = renderPost(w, v);
        assertClean(t, `post#${v}`);
        assert.ok(t.length <= 140 && t.endsWith(' #PR'), `post#${v}: ${t}`);
      }
      assertClean(pageText(w), 'pageText'); assertClean(cardText(w), 'cardText'); assertClean(postText(w), 'postText');
    });
  }
  it('全部なしでも例外にならず、投稿は題名だけになる（ページ・カードは空）', () => {
    const w = CASES['全部なし'];
    assert.equal(pageText(w), ''); assert.equal(cardText(w), '');
    assert.equal(postText(w), '「作品 0001」。 #PR');
  });
  it('欠けた項目の句だけが消える', () => {
    const has = (w: CatalogWork, s: string) => range(5).forEach((v) => assert.ok(!renderPage(w, v).includes(s), `page#${v} に ${s}`));
    has(CASES['レビューなし'], 'レビュー'); has(CASES['価格なし'], '円'); has(CASES['尺なし'], '分');
    has(CASES['日付なし'], '配信開始'); has(CASES['ジャンルなし'], 'ジャンル'); has(CASES['ジャンルなし'], 'タグは');
    assert.ok(!cardText(CASES['レビューなし']).includes('点'));
    assert.ok(!postText(CASES['価格なし']).includes('円'));
  });
  it('レビュー件数があっても平均が無ければレビュー句は出さない', () => {
    const w = mk({ reviewCount: 5, reviewAvg: null });
    for (const v of range(5)) assert.ok(!renderPage(w, v).includes('レビュー') && !renderCard(w, v).includes('件'));
  });
  it('項目の末尾の読点・句点は落として組み立てる', () => {
    const w = mk({ makers: [{ id: 'm', name: 'メーカー01。' }], genres: [{ id: 'g', name: 'タグ01、' }], actresses: [{ id: 'a', name: '出演者A、' }] });
    for (const v of range(5)) assertClean(renderPage(w, v), `page#${v}`);
  });
  it('カードは選んだ文型が空でも、次の文型で埋める', () => {
    const onlyDate = mk({ actresses: [], makers: [], series: [], genres: [], volumeMin: null, reviewCount: 0, reviewAvg: null, priceMin: null, listPrice: null });
    for (const i of range(20)) assert.equal(cardText({ ...onlyDate, contentId: `w${i}` }), '2026/11/01');
  });
});

describe('各句の組み立て', () => {
  it('全部あり: 出演者・シリーズ・尺・日付・ジャンル・レビュー・ラベルが全文型に入る', () => {
    for (const v of range(5)) {
      const t = renderPage(CASES['全部あり'], v);
      for (const s of ['出演者A、出演者B出演', '120分', 'タグ01、タグ02', 'レビューは4.3点（120件）。', '配信が始まったばかりの新作です。', 'シリーズ01']) assert.ok(t.includes(s), `page#${v} に ${s}: ${t}`);
      const sentences = t.split('。').filter(Boolean).length;
      assert.ok(sentences >= 3 && sentences <= 6, `page#${v} は ${sentences} 文: ${t}`);
    }
    assert.ok(renderPage(CASES['全部あり'], 0).startsWith('出演者A、出演者B出演、メーカー01のシリーズ01の1本。120分、2026/11/01配信開始。'));
    for (const v of [1, 2, 4]) assert.ok(renderPage(CASES['全部あり'], v).includes('セール中は1,480円（通常1,980円）。'));
  });
  it('シリーズなしは「{メーカー}の作品」、出演者なしはメーカー名＋「制作」で名前を重ねない', () => {
    assert.ok(renderPage(CASES['シリーズなし'], 0).startsWith('出演者A、出演者B出演、メーカー01の作品。'));
    for (const v of range(5)) {
      const t = renderPage(CASES['出演者なし'], v);
      assert.ok(t.includes('メーカー01') && !t.includes('出演'), `page#${v}: ${t}`);
      assert.equal(t.split('メーカー01').length - 1, 1, `page#${v} でメーカー名が重なる: ${t}`);
    }
    assert.ok(renderPage(CASES['出演者なし'], 0).startsWith('メーカー01制作、シリーズ01の1本。'));
  });
  it('価格句: セール中は通常価格つき、定価が無い・高くないときは単価のみ', () => {
    assert.ok(renderPage(mk({ listPrice: 1480 }), 1).includes('価格は1,480円。'));
    assert.ok(!renderPage(mk({ listPrice: null }), 1).includes('通常'));
    assert.ok(renderPage(mk({ derivedLabels: ['新作'] }), 1).includes('価格は1,480円。'));   // 定価が高くてもセール中ラベルが無ければ単価のみ
    assert.ok(renderPage(mk(), 1).includes('セール中は1,480円（通常1,980円）。'));
  });
  it('ラベル句: 優先順に1つだけ。高評価などは句なし', () => {
    const note = (labels: CatalogWork['derivedLabels']) => renderPage(mk({ derivedLabels: labels }), 0);
    assert.ok(note(['新作', '初見向け']).endsWith('入口に向いています。'));
    assert.ok(note(['定番', '長尺']).endsWith('見られ続けている定番です。'));
    assert.ok(note(['長尺']).endsWith('長尺作品です。') && note(['短尺']).endsWith('短尺作品です。'));
    assert.ok(note(['セール中']).endsWith('期間限定のセール対象です。'));
    for (const l of ['高評価', 'シリーズ追い向け', '出演者追い向け'] as const) assert.ok(note([l]).endsWith('レビューは4.3点（120件）。'), l);
  });
  it('出演者が多いときは「ほか」で省く（ページは8人、投稿は3人まで）', () => {
    const w = mk({ actresses: refs('出演者', 12) });
    assert.ok(renderPage(w, 0).startsWith('出演者01、出演者02、出演者03、出演者04、出演者05、出演者06、出演者07、出演者08ほか出演、'));
    assert.ok(!renderPage(w, 0).includes('出演者09'));
    assert.ok(renderPost(w, 0).includes('出演者01、出演者02、出演者03ほか出演') && !renderPost(w, 0).includes('出演者04'));
  });
});

describe('X投稿', () => {
  it('長い題名は「…」で切り詰め、140字以内で #PR を残す', () => {
    const w = mk({ title: '長い題名'.repeat(60), actresses: refs('出演者', 12) });
    for (const v of range(5)) {
      const t = renderPost(w, v);
      assert.ok(t.length <= 140 && t.endsWith(' #PR') && t.includes('…」'), `post#${v} (${t.length}): ${t}`);
    }
  });
  it('サロゲートペアを割らない', () => {
    const w = mk({ title: '\u{20000}'.repeat(200) });
    for (const v of range(5)) { const t = renderPost(w, v); assert.ok(t.isWellFormed() && t.length <= 140, `post#${v}`); }
  });
  it('付帯情報が長すぎるときは題名だけにして収める', () => {
    const w = mk({ makers: [{ id: 'm', name: 'メーカー'.repeat(30) }], series: [{ id: 's', name: 'シリーズ'.repeat(30) }], title: '題名'.repeat(30) });
    for (const v of range(5)) { const t = renderPost(w, v); assert.ok(t.length <= 140 && t.endsWith(' #PR'), `post#${v} (${t.length})`); }
    assert.ok(postText(w).includes('「題名'));
  });
  it('題名が短ければそのまま入る', () => assert.equal(renderPost(mk(), 0), '新作。出演者A、出演者B出演「作品 0001」120分、4.3点。 #PR'));
});

describe('文型の選び方', () => {
  it('同じ作品は常に同じ文（複製しても、何度呼んでも）', () => {
    const w = mk();
    for (const f of [pageText, cardText, postText]) assert.equal(f(w), f(structuredClone(w)));
    assert.equal(pageText(w), pageText(w));
  });
  it('contentId のハッシュで選ぶ。カードは + c、投稿は + p', () => {
    assert.equal(variantOf('w0001', 'page'), hash('w0001') % 5);
    assert.equal(variantOf('w0001', 'card'), hash('w0001c') % 5);
    assert.equal(variantOf('w0001', 'post'), hash('w0001p') % 5);
    assert.ok(Number.isInteger(hash('w0001')) && hash('w0001') >= 0 && hash('w0001') <= 0xffffffff);
    assert.notEqual(hash('w0001'), hash('w0002'));
  });
  it('300件で5種すべてが使われ、極端に偏らない', () => {
    for (const kind of KINDS) {
      const counts = new Array<number>(VARIANT_COUNT[kind]).fill(0);
      for (const i of range(300)) counts[variantOf(`w${String(i).padStart(4, '0')}`, kind)]++;
      assert.equal(VARIANT_COUNT[kind], 5);
      assert.ok(counts.every((c) => c >= 30), `${kind}: ${counts.join(',')}`);
    }
  });
  it('同じ作品でも文型ごとに文が違い、違う作品では実際に文型が分かれる', () => {
    const w = mk();
    assert.equal(new Set(range(5).map((v) => renderPage(w, v))).size, 5);
    assert.equal(new Set(range(5).map((v) => renderCard(w, v))).size, 5);
    assert.equal(new Set(range(5).map((v) => renderPost(w, v))).size, 5);
    const texts = range(300).map((i) => pageText(mk({ contentId: `w${String(i).padStart(4, '0')}` })));
    assert.equal(new Set(texts).size, 5);
  });
  it('文型の番号は整数のみ。範囲外は巡回する', () => {
    assert.throws(() => renderPage(mk(), 1.5), RangeError);
    assert.equal(renderPage(mk(), 5), renderPage(mk(), 0));
    assert.equal(renderPage(mk(), -1), renderPage(mk(), 4));
  });
});

describe('format', () => {
  it('fmtDate / ymd', () => {
    assert.equal(fmtDate('2026-11-01'), '2026/11/01');
    assert.equal(fmtDate('2026-11-01T09:00:00+09:00'), '2026/11/01');
    assert.equal(fmtDate(null), ''); assert.equal(fmtDate(''), ''); assert.equal(fmtDate('abc'), '');
    assert.equal(ymd('2026-11-01T09:00:00Z'), '2026-11-01'); assert.equal(ymd('2026-11-01'), '2026-11-01');
    assert.equal(ymd(null), null); assert.equal(ymd(''), null);
  });
  it('yen / minutes', () => {
    assert.equal(yen(1980), '1,980円'); assert.equal(yen(980), '980円'); assert.equal(yen(1234567), '1,234,567円'); assert.equal(yen(0), '0円');
    assert.equal(yen(null), ''); assert.equal(yen(Number.NaN), '');
    assert.equal(minutes(120), '120分'); assert.equal(minutes(null), ''); assert.equal(minutes(0), '');
  });
});
