// 除外リスト（取り下げ対応）のテスト。作品データはすべて合成で、一時ディレクトリにだけ出力する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBlocked, loadBlocklist, parseBlocklist } from '../src/data/blocklist.ts';
import { openDb } from '../src/data/db.ts';
import { exportAll } from '../src/data/export.ts';
import { normalizeItems } from '../src/data/normalize.ts';

const NOW = new Date('2026-11-01T00:00:00.000Z');
const FETCHED = '2026-10-01T00:00:00.000Z';
const actress = (id: number) => ({ id: String(id), name: `出演者${id}` });
// 合成の作品: t-001 は出演者 11、t-002 は出演者 11 と 12、t-003 は出演者 13、t-004 は出演者なし
function setupDb() {
  const db = openDb(':memory:');
  const items = [
    { content_id: 't-001', title: '作品1', iteminfo: { actress: [actress(11)] } },
    { content_id: 't-002', title: '作品2', iteminfo: { actress: [actress(11), actress(12)] } },
    { content_id: 't-003', title: '作品3', iteminfo: { actress: [actress(13)] } },
    { content_id: 't-004', title: '作品4' },
  ];
  db.upsertWorks(normalizeItems(items, { fetchedAt: FETCHED }));
  db.setMeta('rankings', JSON.stringify({ byRating: ['t-001', 't-003'], byRecent: ['t-002', 't-004'], byPopularity: ['t-001', 't-002'] }));
  db.setMeta('todays', JSON.stringify(['t-001', 't-004']));
  return db;
}
function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'blocklist-test-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const read = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const bl = (o: object) => parseBlocklist(JSON.stringify(o));

test('loadBlocklist: ファイルが無ければ空。文字列と { id, note } のどちらも読める。形式不正は例外', () => withDir((dir) => {
  const empty = loadBlocklist(join(dir, 'none.json'));
  assert.equal(empty.contentIds.size + empty.actressIds.size, 0);
  const p = join(dir, 'b.json');
  writeFileSync(p, JSON.stringify({ contentIds: ['a-1', { id: 'a-2', note: 'メモ' }], actressIds: [{ id: 99 }, '98'], reason: '依頼' }));
  const b = loadBlocklist(p);
  assert.deepEqual([...b.contentIds], ['a-1', 'a-2']);
  assert.deepEqual([...b.actressIds], ['99', '98']);
  assert.equal(b.reason, '依頼');
  assert.throws(() => bl({ contentIds: 'a-1' }), TypeError);
  assert.throws(() => bl({ contentIds: [{ note: 'idなし' }] }), TypeError);
  assert.throws(() => parseBlocklist('{'), SyntaxError);
}));

test('loadBlocklist: 同梱の config/blocklist.json は空のリスト', () => {
  const b = loadBlocklist();
  assert.equal(b.contentIds.size + b.actressIds.size, 0);
});

test('isBlocked: contentId の一致、または出演者 id のいずれかの一致', () => {
  const w = (contentId: string, ids: number[]) => ({ contentId, actresses: ids.map((id) => ({ id, name: 'x' })) });
  assert.equal(isBlocked(w('a', [1]), bl({ contentIds: ['a'] })), true);
  assert.equal(isBlocked(w('b', [1, 2]), bl({ actressIds: ['2'] })), true);
  assert.equal(isBlocked(w('b', [1, 2]), bl({ contentIds: ['a'], actressIds: ['3'] })), false);
  assert.equal(isBlocked(w('b', []), bl({})), false);
});

test('exportAll: contentId 指定の作品が works.json・チャンク・meta・index から消え、件数が戻り値に入る。DB は残る', () => withDir((dir) => {
  const db = setupDb();
  const r = exportAll(db, dir, { now: NOW, blocklist: bl({ contentIds: ['t-001'] }) });
  assert.deepEqual(r, { works: 3, chunks: 1, blocked: 1 });
  const ids = (a: { contentId?: string; id?: string }[]) => a.map((x) => x.contentId ?? x.id);
  assert.deepEqual(ids(read(dir, 'works.json')), ['t-002', 't-003', 't-004']);
  assert.deepEqual(ids(read(dir, 'works-000.json')), ['t-002', 't-003', 't-004']);
  const meta = read(dir, 'meta.json');
  assert.deepEqual(meta.rankings, { byRating: ['t-003'], byRecent: ['t-002', 't-004'], byPopularity: ['t-002'] });
  assert.deepEqual(meta.todays, ['t-004']);
  assert.equal(read(dir, 'index.json').total, 3);
  assert.ok(!JSON.stringify(read(dir, 'works.json')).includes('t-001')); // similarIds にも残らない
  assert.equal(db.getWork('t-001')?.status, 'active'); // DB からは消さない
}));

test('exportAll: 出演者 id 指定で、その出演者が出る作品がすべて消え、actresses.json からも外れる', () => withDir((dir) => {
  const db = setupDb();
  const profile = (id: string) => ({ id, name: `出演者${id}`, ruby: null, birthday: null, bloodType: null, hobby: null, prefectures: null, fetchedAt: FETCHED, height: null, bust: null, waist: null, hip: null, cup: null } as never);
  db.upsertActressProfiles([profile('11'), profile('13')]);
  const r = exportAll(db, dir, { now: NOW, blocklist: bl({ actressIds: ['11'] }) });
  assert.deepEqual(r, { works: 2, chunks: 1, blocked: 2 });
  assert.deepEqual(read(dir, 'works.json').map((w: { contentId: string }) => w.contentId), ['t-003', 't-004']);
  assert.deepEqual(read(dir, 'meta.json').rankings.byPopularity, []);
  assert.ok(!read(dir, 'index.json').actresses.includes('出演者12')); // 同じ作品に出る別の出演者も、作品ごと消える
  assert.deepEqual(read(dir, 'actresses.json').map((a: { id: string }) => a.id), ['13']);
}));

test('exportAll: 空のリストなら出力は変わらず、戻り値に blocked も付かない', () => {
  withDir((a) => withDir((b) => {
    const db = setupDb();
    const r1 = exportAll(db, a, { now: NOW });
    const r2 = exportAll(db, b, { now: NOW, blocklist: bl({}) });
    assert.deepEqual(r1, { works: 4, chunks: 1 });
    assert.deepEqual(r2, r1);
    for (const f of ['works.json', 'works-000.json', 'meta.json', 'index.json']) assert.equal(readFileSync(join(a, f), 'utf8'), readFileSync(join(b, f), 'utf8'), f);
  }));
});
