import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { buildCatalog, clearCatalogCache, loadCatalog } from '../src/lib/catalog.ts';
import type { CatalogWork } from '../src/lib/catalog.ts';

const ref = (id: string, name: string) => ({ id, name });
const A = ref('a1', '出演者A'), B = ref('a2', '出演者B'), C = ref('a3', '出演者C'), M1 = ref('m1', 'メーカー01'), M2 = ref('m2', 'メーカー02');
const S1 = ref('s1', 'シリーズ01'), S2 = ref('s2', 'シリーズ02'), T1 = ref('g1', 'タグ01'), T2 = ref('g2', 'タグ02'), T3 = ref('g3', 'タグ03');

/** 中立な名前だけで作った作品。変えたい項目だけ渡す */
function mk(id: string, over: Partial<CatalogWork> = {}): CatalogWork {
  return {
    contentId: id, productId: null, title: `作品 ${id}`, url: null, affiliateUrl: null,
    volumeMin: 120, releasedAt: '2026-10-01', reviewCount: 10, reviewAvg: 4.0, priceMin: 1480, listPrice: 1980,
    deliveries: [], imageList: null, imageSmall: null, imageLarge: null, sampleImages: [], sampleMovie: null, campaigns: [],
    genres: [], actresses: [], series: [], makers: [], labels: [], directors: [],
    rankPosition: null, fetchedAt: '2026-11-01T00:00:00Z', status: 'active',
    derivedLabels: [], similarIds: [], ...over,
  };
}

/** 6件（0004 は gone）。0001 と 0006 は同じ日、0003 は日付なし */
const WORKS = (): CatalogWork[] => [
  mk('0001', { releasedAt: '2026-10-01', actresses: [A], makers: [M1], series: [S1], genres: [T1, T2], derivedLabels: ['新作', 'セール中'], similarIds: ['0002', '0004', '9999', '0003', '0002'] }),
  mk('0002', { releasedAt: '2026-11-01', actresses: [A, B], makers: [M1], series: [S1], genres: [T1], derivedLabels: ['新作'] }),
  mk('0003', { releasedAt: null, actresses: [B], makers: [M2], genres: [T2], derivedLabels: ['セール中', '定番'] }),
  mk('0004', { releasedAt: '2026-12-01', actresses: [A], makers: [M1], series: [S1], genres: [T1], derivedLabels: ['新作', 'セール中'], status: 'gone' }),
  mk('0005', { releasedAt: '2025-05-05', makers: [M2], series: [S2], genres: [T1, T3] }),
  mk('0006', { releasedAt: '2026-10-01', actresses: [C], makers: [M1], genres: [T3], derivedLabels: ['新作'], similarIds: ['0001', '0006'] }),
];
const ids = (list: CatalogWork[] | undefined): string[] => (list ?? []).map((w) => w.contentId);

describe('buildCatalog', () => {
  const input = WORKS();
  const c = buildCatalog(input, { todays: ['0003', '0004', '0001', 'nope'] });

  it('active だけが対象（gone は除く）。works は入力順', () => {
    assert.deepEqual(ids(c.works), ['0001', '0002', '0003', '0005', '0006']);
    assert.equal(c.byId.size, 5);
    assert.equal(c.byId.has('0004'), false);
    assert.equal(c.byId.get('0001'), c.works[0]);
    assert.deepEqual(input.map((w) => w.contentId), ['0001', '0002', '0003', '0004', '0005', '0006']);   // 入力の配列は並べ替えない
  });
  it('byActress: 件数と、配信開始日の降順（null は末尾）', () => {
    assert.equal(c.byActress.size, 3);
    assert.deepEqual(ids(c.byActress.get('a1')), ['0002', '0001']);
    assert.deepEqual(ids(c.byActress.get('a2')), ['0002', '0003']);
    assert.deepEqual(ids(c.byActress.get('a3')), ['0006']);
  });
  it('bySeries / byMaker / byGenre', () => {
    assert.equal(c.bySeries.size, 2);
    assert.deepEqual(ids(c.bySeries.get('s1')), ['0002', '0001']);
    assert.deepEqual(ids(c.bySeries.get('s2')), ['0005']);
    assert.equal(c.byMaker.size, 2);
    assert.deepEqual(ids(c.byMaker.get('m1')), ['0002', '0001', '0006']);   // 0001 と 0006 は同じ日なので入力順
    assert.deepEqual(ids(c.byMaker.get('m2')), ['0005', '0003']);
    assert.equal(c.byGenre.size, 3);
    assert.deepEqual(ids(c.byGenre.get('g1')), ['0002', '0001', '0005']);
    assert.deepEqual(ids(c.byGenre.get('g2')), ['0001', '0003']);
    assert.deepEqual(ids(c.byGenre.get('g3')), ['0006', '0005']);
    assert.equal(c.byGenre.get('nope'), undefined);
  });
  it('refNames は id から名前を引ける', () => {
    const r = c.refNames;
    assert.deepEqual([r.actress.get('a2'), r.series.get('s2'), r.maker.get('m1'), r.genre.get('g3'), r.actress.size], ['出演者B', 'シリーズ02', 'メーカー01', 'タグ03', 3]);
  });
  it('recent: 配信開始日の降順。n が範囲外でも壊れない', () => {
    assert.deepEqual(ids(c.recent(3)), ['0002', '0001', '0006']);
    assert.deepEqual(ids(c.recent(10)), ['0002', '0001', '0006', '0005', '0003']);
    assert.deepEqual(c.recent(0), []); assert.deepEqual(c.recent(-1), []);
  });
  it('同じ日は時刻の降順。日付なし・日付として読めない値は末尾（入力順）', () => {
    const at = (id: string, d: string | null) => mk(id, { releasedAt: d });
    const d = buildCatalog([at('t1', '2026-10-31T13:01:26'), at('t2', '2026-10-31T20:29:18'), at('t3', '2026-10-31'), at('t4', null), at('t5', 'abc')]);
    assert.deepEqual(ids(d.recent(5)), ['t2', 't1', 't3', 't4', 't5']);
  });
  it('onSale / byLabel: ラベル一致（gone は含まない）', () => {
    assert.deepEqual(ids(c.onSale()), ['0001', '0003']);
    assert.deepEqual(ids(c.onSale(1)), ['0001']);
    assert.deepEqual(ids(c.byLabel('新作')), ['0002', '0001', '0006']);
    assert.deepEqual(ids(c.byLabel('新作', 2)), ['0002', '0001']);
    assert.deepEqual(ids(c.byLabel('定番')), ['0003']);
    assert.deepEqual(c.byLabel('高評価'), []);
  });
  it('similar: similarIds の順に引き、存在しない ID・gone・重複・自分自身は飛ばす', () => {
    assert.deepEqual(ids(c.similar(c.byId.get('0001')!)), ['0002', '0003']);
    assert.deepEqual(ids(c.similar(c.byId.get('0001')!, 1)), ['0002']);
    assert.deepEqual(ids(c.similar(c.byId.get('0006')!)), ['0001']);
    assert.deepEqual(c.similar(c.byId.get('0005')!), []);
  });
  it('todays: meta.todays の順（存在しない ID・gone は飛ばす）。無ければ空', () => {
    assert.deepEqual(ids(c.todays()), ['0003', '0001']);
    assert.deepEqual(ids(c.todays(1)), ['0003']);
    assert.deepEqual(buildCatalog(WORKS()).todays(), []);
  });
  it('meta の既定は全て null。渡した値はそのまま持つ', () => {
    assert.deepEqual(buildCatalog([]).meta, { rankings: null, todays: null, lastIngestAt: null, lastDeriveAt: null, generatedAt: null });
    const rankings = { byRating: ['0001'], byRecent: [], byPopularity: [] };
    assert.deepEqual(buildCatalog([], { rankings, generatedAt: '2026-11-01T00:00:00.000Z' }).meta.rankings, rankings);
    assert.equal(c.meta.generatedAt, null);
  });
  it('返す配列は呼ぶたびに別物（書き換えても内部に影響しない）', () => {
    c.recent(5).reverse(); c.onSale().pop(); c.byLabel('新作').length = 0;
    assert.deepEqual(ids(c.recent(2)), ['0002', '0001']);
    assert.deepEqual(ids(c.onSale()), ['0001', '0003']);
  });
  it('contentId が重複したら先のものを採る。空でも動く', () => {
    const d = buildCatalog([mk('x1', { title: '先' }), mk('x1', { title: '後' })]);
    assert.equal(d.works.length, 1); assert.equal(d.byId.get('x1')?.title, '先');
    const e = buildCatalog([]);
    assert.deepEqual([e.works, e.recent(3), e.onSale(), e.todays()], [[], [], [], []]);
  });
});

describe('loadCatalog', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'catalog-test-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  let seq = 0;
  /** 出力一式を新しい一時ディレクトリに書いて、そのパスを返す */
  function writeExport(works: unknown, meta: unknown = {}, index: unknown = {}): string {
    const dir = join(tmp, `export-${seq++}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'works.json'), JSON.stringify(works));
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
    return dir;
  }
  const META = {
    rankings: { byRating: ['0002', '0001'], byRecent: ['0002'], byPopularity: ['0001'] }, todays: ['0001'],
    last_ingest_at: '2026-11-01T00:00:00Z', last_derive_at: '2026-11-01T01:00:00Z',
  };
  const INDEX = { generatedAt: '2026-11-01T02:00:00.000Z', total: 5, chunks: [] };

  it('works.json / meta.json / index.json を読んで組み立てる', () => {
    const c = loadCatalog({ exportDir: writeExport(WORKS(), META, INDEX) });
    assert.deepEqual(ids(c.works), ['0001', '0002', '0003', '0005', '0006']);
    assert.deepEqual(ids(c.byActress.get('a1')), ['0002', '0001']);
    assert.deepEqual(c.meta, {
      rankings: META.rankings, todays: ['0001'], lastIngestAt: '2026-11-01T00:00:00Z',
      lastDeriveAt: '2026-11-01T01:00:00Z', generatedAt: '2026-11-01T02:00:00.000Z',
    });
    assert.deepEqual(ids(c.todays()), ['0001']);
    assert.deepEqual(ids(c.similar(c.byId.get('0001')!)), ['0002', '0003']);
  });
  it('メタが空でも、配列項目が欠けた作品でも読める（null・空配列で補う）', () => {
    const { derivedLabels: _a, similarIds: _b, genres: _c, ...bare } = mk('0101');
    const c = loadCatalog({ exportDir: writeExport([bare]) });
    assert.deepEqual([c.works[0].derivedLabels, c.works[0].similarIds, c.works[0].genres], [[], [], []]);
    assert.deepEqual(c.meta, { rankings: null, todays: null, lastIngestAt: null, lastDeriveAt: null, generatedAt: null });
  });
  it('同じ出力先は再読込しない。force で読み直す', () => {
    const dir = writeExport(WORKS(), META, INDEX);
    const first = loadCatalog({ exportDir: dir });
    writeFileSync(join(dir, 'works.json'), JSON.stringify([mk('0201')]));
    assert.equal(loadCatalog({ exportDir: dir }), first);
    assert.equal(first.works.length, 5);
    const forced = loadCatalog({ exportDir: dir, force: true });
    assert.notEqual(forced, first);
    assert.deepEqual(ids(forced.works), ['0201']);
    assert.equal(loadCatalog({ exportDir: dir }), forced);
    clearCatalogCache();
    assert.notEqual(loadCatalog({ exportDir: dir }), forced);
  });
  it('相対パスは process.cwd() 基準で、絶対パスと同じキャッシュになる', () => {
    const dir = writeExport(WORKS(), META, INDEX);
    assert.equal(loadCatalog({ exportDir: relative(process.cwd(), dir) }), loadCatalog({ exportDir: dir }));
  });
  it('出力先は opts.exportDir、無ければ環境変数 EXPORT_DIR', () => {
    const viaEnv = writeExport([mk('0301')]), viaOpt = writeExport([mk('0302')]);
    const saved = process.env.EXPORT_DIR;
    try {
      process.env.EXPORT_DIR = viaEnv;
      assert.deepEqual(ids(loadCatalog().works), ['0301']);
      assert.deepEqual(ids(loadCatalog({ exportDir: viaOpt }).works), ['0302']);
    } finally {
      if (saved === undefined) delete process.env.EXPORT_DIR; else process.env.EXPORT_DIR = saved;
    }
  });
  it('ファイルが無いときは、作り方（--synthetic）を案内するエラー', () => {
    const none = join(tmp, 'nothing-here');
    assert.throws(() => loadCatalog({ exportDir: none }), (e: unknown) => {
      assert.ok(e instanceof Error);
      for (const s of ['--synthetic', 'npm run derive', 'npm run export', 'works.json', none]) assert.ok(e.message.includes(s), `${s}: ${e.message}`);
      return true;
    });
    const dir = join(tmp, 'partial');
    mkdirSync(dir); writeFileSync(join(dir, 'works.json'), '[]');   // works.json だけある
    assert.throws(() => loadCatalog({ exportDir: dir }), (e: unknown) => e instanceof Error && e.message.includes('--synthetic') && /に meta\.json、index\.json がありません/.test(e.message));
  });
  it('壊れた JSON・形式不正も、再作成を案内するエラー', () => {
    const broken = writeExport([]);
    writeFileSync(join(broken, 'works.json'), '{oops');
    assert.throws(() => loadCatalog({ exportDir: broken }), (e: unknown) => e instanceof Error && e.message.includes('works.json') && e.message.includes('--synthetic'));
    assert.throws(() => loadCatalog({ exportDir: writeExport({ not: 'array' }) }), /配列ではありません.*--synthetic/s);
    assert.throws(() => loadCatalog({ exportDir: writeExport([{ title: '題名のみ' }]) }), /0 件目に contentId がありません.*--synthetic/s);
  });
});
