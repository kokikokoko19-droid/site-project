/** src/data/db.ts のテスト（node:test。基本は ':memory:'、最後の1件だけファイルDB）。
 *  実行: node --experimental-strip-types --test tests/db.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb, type Db } from '../src/data/db.ts';
import type { NamedRef, Work } from '../src/data/types.ts';

const id = (n: number) => `cid${String(n).padStart(4, '0')}`;
const ref = (rid: string, name: string, ruby: string | null = null): NamedRef => ({ id: rid, name, ruby });
const ids = (ws: Work[]) => ws.map((w) => w.contentId);
const sim = (a: number, b: number, score: number) => ({ contentId: id(a), similarId: id(b), score });
const T0 = '2026-01-01T00:00:00.000Z', NOW = '2026-11-01T00:00:00.000Z';

/** 全項目に値を持つ作品（名前は中立なダミー） */
function makeWork(n: number, patch: Partial<Work> = {}): Work {
  const p = String(n).padStart(4, '0');
  const img = (suffix: string) => `https://example.com/img/${p}${suffix}.jpg`;
  return {
    contentId: id(n), productId: `pid${p}`, title: `作品 ${p}`,
    url: `https://example.com/works/${p}`, affiliateUrl: `https://example.com/aff/${p}`,
    volumeMin: 120, releasedAt: '2026-01-15', reviewCount: 12, reviewAvg: 4.25, priceMin: 980, listPrice: 1980,
    deliveries: [{ type: 'stream', price: 980, listPrice: 1980 }, { type: 'download', price: null, listPrice: null }],
    imageList: img('l'), imageSmall: img('s'), imageLarge: img('b'), sampleImages: [img('-1'), img('-2')],
    sampleMovie: { sizes: { '476_306': 'https://example.com/m/476', '720_480': 'https://example.com/m/720' }, pcFlag: 1, spFlag: null },
    campaigns: [{ title: 'キャンペーン01', begin: '2026-01-01', end: null }],
    genres: [ref('g02', 'タグ02'), ref('g01', 'タグ01', 'たぐぜろいち')], // 並びが id 順でないことも確かめる
    actresses: [ref('a01', '出演者A', 'しゅつえんしゃえー')], series: [ref('s01', 'シリーズ01')],
    makers: [ref('m01', 'メーカー01')], labels: [ref('l01', 'レーベル01')], directors: [ref('d01', '監督01')],
    rankPosition: 7, fetchedAt: NOW, status: 'active',
    ...patch,
  };
}

/** 任意項目をすべて null / 空にするパッチ */
const EMPTY: Partial<Work> = {
  productId: null, url: null, affiliateUrl: null, volumeMin: null, releasedAt: null, reviewAvg: null,
  priceMin: null, listPrice: null, deliveries: [], imageList: null, imageSmall: null, imageLarge: null,
  sampleImages: [], sampleMovie: null, campaigns: [], genres: [], actresses: [], series: [],
  makers: [], labels: [], directors: [], rankPosition: null,
};

function memDb(t: { after: (fn: () => void) => void }): Db {
  const db = openDb(':memory:');
  t.after(() => db.close());
  return db;
}

test('upsert した作品が getWork で全項目一致する（null と空配列も保たれる）', (t) => {
  const db = memDb(t);
  const [full, empty] = [makeWork(1), makeWork(2, EMPTY)];
  assert.equal(db.upsertWorks([full, empty]), 2);
  assert.deepEqual(db.getWork(id(1)), full);
  assert.deepEqual(db.getWork(id(2)), empty);
  assert.equal(db.getWork('存在しないID'), null);
});

test('同じ content_id の再 upsert は1行のまま2回目の値に更新される', (t) => {
  const db = memDb(t);
  db.upsertWorks([makeWork(1)]);
  const second = makeWork(1, {
    title: '作品 0001（更新）', reviewCount: 99, reviewAvg: null, priceMin: 500,
    genres: [ref('g03', 'タグ03')], actresses: [], fetchedAt: '2026-11-02T00:00:00.000Z', rankPosition: 3,
  });
  assert.equal(db.upsertWorks([second]), 1);
  assert.equal(db.countWorks(), 1);
  assert.deepEqual(db.getWork(id(1)), second);
});

test('rankPosition が null の upsert は既存の順位を保ち、setRankPositions で更新できる', (t) => {
  const db = memDb(t);
  db.upsertWorks([makeWork(1, { rankPosition: 7 })]);
  db.upsertWorks([makeWork(1, { title: '作品 0001（更新）', rankPosition: null })]);
  assert.equal(db.getWork(id(1))?.title, '作品 0001（更新）');
  assert.equal(db.getWork(id(1))?.rankPosition, 7);
  db.setRankPositions([{ contentId: id(1), rankPosition: 3 }, { contentId: id(99), rankPosition: 1 }]);
  assert.equal(db.getWork(id(1))?.rankPosition, 3);
});

test('参照マスタ: 名前は更新、ふりがなは null で消えない、同一作品内の重複は先頭だけ', (t) => {
  const db = memDb(t);
  db.upsertWorks([makeWork(1, { genres: [ref('g01', 'タグ01', 'たぐ'), ref('g01', 'タグ01重複'), ref('g02', 'タグ02')] })]);
  assert.deepEqual(db.getWork(id(1))?.genres, [ref('g01', 'タグ01', 'たぐ'), ref('g02', 'タグ02')]);
  db.upsertWorks([makeWork(2, { genres: [ref('g01', 'タグ01改')] })]);
  assert.deepEqual(db.getWork(id(2))?.genres, [ref('g01', 'タグ01改', 'たぐ')]);
  assert.equal(db.getWork(id(1))?.genres[0].name, 'タグ01改'); // マスタは作品間で共有される
});

test('markGone は指定外の active だけを gone にし、既存の gone_at は更新しない', (t) => {
  const db = memDb(t);
  db.upsertWorks([1, 2, 3, 4].map((n) => makeWork(n)));
  assert.equal(db.markGone([id(1), id(2)], T0), 2);
  assert.deepEqual([1, 2, 3, 4].map((n) => db.getWork(id(n))?.status), ['active', 'active', 'gone', 'gone']);
  assert.equal(db.markGone([id(1)], '2026-10-25T00:00:00.000Z'), 1); // id2 だけが新たに gone
  assert.equal(db.countWorks('gone'), 3);
  assert.equal(db.purgeGone(30, NOW), 2); // id3, id4 は T0 のまま（更新されていれば 0 件になる）
  assert.equal(db.getWork(id(2))?.status, 'gone');
});

test('purgeGone は古い gone だけを関連行ごと消す', (t) => {
  const db = memDb(t);
  db.upsertWorks([1, 2, 3, 4].map((n) => makeWork(n)));
  db.replaceDerivedLabels([1, 2, 3, 4].map((n) => ({ contentId: id(n), labels: ['新作'] })));
  db.replaceSimilar([sim(1, 3, 0.9), sim(1, 2, 0.5), sim(3, 1, 0.8)]);
  db.markGone([id(1), id(2), id(4)], T0); // id3 が古い gone
  db.markGone([id(1), id(2)], '2026-10-25T00:00:00.000Z'); // id4 が新しい gone
  assert.equal(db.purgeGone(30, NOW), 1);
  assert.equal(db.getWork(id(3)), null);
  assert.equal(db.getWork(id(4))?.status, 'gone');
  assert.deepEqual([db.getLabels(id(3)), db.getLabels(id(4))], [[], ['新作']]);
  assert.deepEqual(db.getSimilar(id(1)).map((s) => s.similarId), [id(2)]); // 消えた作品を指す行も消える
  assert.deepEqual(db.getSimilar(id(3)), []);
  assert.equal(db.purgeGone(30, NOW), 0);
  assert.throws(() => db.purgeGone(-1, NOW), RangeError);
  assert.throws(() => db.purgeGone(30, 'いつか'), RangeError);
});

test('listWorks は status で絞り込み、limit / offset で切り出せる', (t) => {
  const db = memDb(t);
  db.upsertWorks([5, 3, 1, 4, 2].map((n) => makeWork(n))); // 投入順は昇順でなくてよい
  db.markGone([id(1), id(2), id(3)], T0); // id4, id5 が gone
  assert.deepEqual(ids(db.listWorks()), [1, 2, 3, 4, 5].map((n) => id(n)));
  assert.deepEqual(ids(db.listWorks({ status: 'gone' })), [id(4), id(5)]);
  assert.deepEqual(ids(db.listWorks({ limit: 2, offset: 2 })), [id(3), id(4)]);
  assert.deepEqual(ids(db.listWorks({ offset: 3 })), [id(4), id(5)]);
  assert.deepEqual(ids(db.listWorks({ status: 'active', limit: 1, offset: 1 })), [id(2)]);
  assert.deepEqual(db.listWorks({ limit: 0 }), []);
  assert.deepEqual([db.countWorks(), db.countWorks('active'), db.countWorks('gone')], [5, 3, 2]);
  assert.deepEqual(db.listWorks({ limit: 1 })[0], db.getWork(id(1))); // 一覧にも参照が結合される
  assert.throws(() => db.listWorks({ limit: -1 }), RangeError);
});

test('derived_labels の置換と取得（渡した作品の分だけ置き換わる）', (t) => {
  const db = memDb(t);
  db.replaceDerivedLabels([{ contentId: id(1), labels: ['新作', '高評価'] }, { contentId: id(2), labels: ['長尺'] }]);
  assert.deepEqual(db.getLabels(id(1)), ['新作', '高評価']); // 登録順
  db.replaceDerivedLabels([{ contentId: id(1), labels: ['定番'] }]);
  assert.deepEqual([db.getLabels(id(1)), db.getLabels(id(2))], [['定番'], ['長尺']]); // 渡していない作品は不変
  db.replaceDerivedLabels([{ contentId: id(1), labels: ['短尺', '短尺', 'セール中'] }]);
  assert.deepEqual(db.getLabels(id(1)), ['短尺', 'セール中']); // 重複は1つ
  db.replaceDerivedLabels([{ contentId: id(1), labels: [] }]);
  assert.deepEqual([db.getLabels(id(1)), db.getLabels('存在しないID')], [[], []]);
});

test('similar の置換と取得（score の高い順、渡した作品の分だけ置き換わる）', (t) => {
  const db = memDb(t);
  db.replaceSimilar([sim(1, 2, 0.5), sim(1, 3, 0.9), sim(2, 1, 0.8)]);
  assert.deepEqual(db.getSimilar(id(1)), [sim(1, 3, 0.9), sim(1, 2, 0.5)]);
  db.replaceSimilar([sim(1, 4, 0.7), sim(1, 4, 0.6)]); // 同じ組が重なったら後のものが残る
  assert.deepEqual(db.getSimilar(id(1)), [sim(1, 4, 0.6)]);
  assert.deepEqual(db.getSimilar(id(2)), [sim(2, 1, 0.8)]); // 渡していない作品は不変
  assert.deepEqual(db.getSimilar('存在しないID'), []);
});

test('meta の設定・上書き・取得', (t) => {
  const db = memDb(t);
  assert.equal(db.getMeta('last_fetch'), null);
  db.setMeta('last_fetch', T0); db.setMeta('last_fetch', NOW); db.setMeta('empty', '');
  assert.deepEqual([db.getMeta('last_fetch'), db.getMeta('empty'), db.getMeta('other')], [NOW, '', null]);
});

test('upsertWorks の途中で失敗したら全体が巻き戻り、その後も使える', (t) => {
  const db = memDb(t);
  const broken = makeWork(2, { title: undefined as unknown as string }); // NOT NULL 違反
  assert.throws(() => db.upsertWorks([makeWork(1), broken]), /NOT NULL/);
  assert.equal(db.countWorks(), 0);
  assert.equal(db.upsertWorks([makeWork(1)]), 1);
});

test('ファイルDB: 親ディレクトリを作り、開き直してもデータが残り、再取得で gone_at が消える', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'db-test-'));
  const file = join(dir, 'sub', 'works.sqlite');
  let second: Db | undefined, raw: DatabaseSync | undefined;
  t.after(() => { raw?.close(); second?.close(); rmSync(dir, { recursive: true, force: true }); });

  const first = openDb(file);
  first.upsertWorks([makeWork(1), makeWork(2)]);
  first.replaceDerivedLabels([{ contentId: id(1), labels: ['新作'] }]);
  first.replaceSimilar([{ contentId: id(1), similarId: id(2), score: 0.5 }]);
  first.setMeta('k', 'v');
  first.markGone([id(1)], T0);
  first.close(); first.close(); // 二重 close は無害

  second = openDb(file); // スキーマ作成が2回目でも壊れない
  raw = new DatabaseSync(file);
  assert.deepEqual([second.countWorks(), second.getMeta('k'), second.getWork(id(2))?.status], [2, 'v', 'gone']);
  second.upsertWorks([makeWork(2)]);
  const row = { ...raw.prepare('SELECT status, gone_at FROM works WHERE content_id = ?').get(id(2)) };
  assert.deepEqual(row, { status: 'active', gone_at: null });

  second.markGone([], T0); // 全件 gone → purge で関連行も残らない
  assert.equal(second.purgeGone(30, NOW), 2);
  const count = (table: string) => (raw!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  assert.deepEqual(['works', 'work_refs', 'derived_labels', 'similar'].map(count), [0, 0, 0, 0]);
});
