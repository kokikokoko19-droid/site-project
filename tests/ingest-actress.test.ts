// 出演者プロフィールの取り込み（ingest-actress）のテスト。fetch を差し替えた合成レスポンスだけを使い、通信はしない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../src/data/api.ts';
import { openDb } from '../src/data/db.ts';
import { exportAll } from '../src/data/export.ts';
import { actressIdsInWorks, ingestActressProfiles, ingestSyntheticActressProfiles, normalizeActress } from '../src/data/ingest-actress.ts';
import { normalizeItems } from '../src/data/normalize.ts';
import { syntheticActressList, syntheticItemList } from '../src/data/synthetic.ts';

const CLIENT_OPTS = { apiId: 'TEST_API_ID_DUMMY', affiliateId: 'testaff-990', minIntervalMs: 0, maxRetries: 0, sleep: async () => {} };
const AT = '2026-11-03T00:00:00.000Z';
const NOW = () => new Date(AT);

/** actress_id に応じて、その1人だけを返す fetch の差し替え。imageURL つき */
function setup() {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const id = url.searchParams.get('actress_id') as string;
    const body = syntheticActressList({ ids: [id], seed: 3 });
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  return { client: createClient({ ...CLIENT_OPTS, fetchImpl }), urls };
}

/** 合成の作品を入れた DB */
function dbWithWorks(count: number) {
  const db = openDb(':memory:');
  db.upsertWorks(normalizeItems(syntheticItemList({ count }).result.items, { fetchedAt: AT }));
  return db;
}

test('正規化: 数値化・null化・imageURL の除外', () => {
  const p = normalizeActress({
    id: 101, name: '出演者X', ruby: '', birthday: null, blood_type: 'A', hobby: '',
    prefectures: '東京都', height: '160', bust: '84', waist: '', hip: '0',
    imageURL: { small: 'https://example.invalid/a.jpg' },
    listURL: { digital: 'https://example.invalid/l', monthly: '', mono: '' },
  }, AT);
  assert.deepEqual(p, {
    id: '101', name: '出演者X', ruby: null, birthday: null, bloodType: 'A', hobby: null,
    prefectures: '東京都', height: 160, bust: 84, waist: null, hip: null, cup: null,
    listUrl: 'https://example.invalid/l', fetchedAt: AT,
  });
  assert.ok(!JSON.stringify(p).includes('imageURL') && !JSON.stringify(p).includes('a.jpg'));
  assert.equal(normalizeActress({ name: 'ID無し' }, AT), null);
});

test('ids 省略時は works の出演者全員が対象になり、DB に画像URLなしで保存される', async () => {
  const db = dbWithWorks(30);
  const expected = actressIdsInWorks(db);
  assert.ok(expected.length > 1);
  const { client, urls } = setup();
  const res = await ingestActressProfiles(client, db, { now: NOW });
  assert.equal(res.requested, expected.length);
  assert.equal(res.upserted, expected.length);
  assert.deepEqual(urls.map((u) => u.searchParams.get('actress_id')).sort(), expected);
  assert.deepEqual(db.listActressProfiles().map((a) => a.id).sort(), expected);
  assert.equal(db.getMeta('last_actress_ingest_at'), AT);
  const one = db.getActressProfile(expected[0] as string);
  assert.ok(one && !('imageURL' in one) && one.fetchedAt === AT);
  assert.equal(db.getActressProfile('no-such-id'), null);
  db.close();
});

test('ids 指定時はその分だけ問い合わせ、応答に該当 id が無ければ missing に数える', async () => {
  const db = dbWithWorks(5);
  const fetchImpl = (async () => new Response(JSON.stringify(syntheticActressList({ ids: ['999'] })))) as typeof fetch;
  const client = createClient({ ...CLIENT_OPTS, fetchImpl });
  const res = await ingestActressProfiles(client, db, { ids: ['999', '888'], now: NOW });
  assert.deepEqual(res, { requested: 2, upserted: 1, missing: 1 });
  assert.deepEqual(db.listActressProfiles().map((a) => a.id), ['999']);
  db.close();
});

test('合成経路: works の出演者全員分が入り、欠損パターンが混ざる', async () => {
  const db = dbWithWorks(40);
  const expected = actressIdsInWorks(db);
  const res = await ingestSyntheticActressProfiles(db, { now: NOW });
  assert.equal(res.upserted, expected.length);
  const list = db.listActressProfiles();
  assert.ok(list.some((a) => a.birthday === null) && list.some((a) => a.cup === null) && list.some((a) => a.hobby === null));
  assert.ok(list.every((a) => a.name.startsWith('出演者')));
  db.close();
});

test('export: actresses.json に works に出てくる出演者だけが出る', async () => {
  const db = dbWithWorks(20);
  await ingestSyntheticActressProfiles(db, { now: NOW });
  db.upsertActressProfiles([{ ...(db.listActressProfiles()[0] as object), id: 'unused-1', name: '出演者Z' } as never]);
  const dir = mkdtempSync(join(tmpdir(), 'actress-export-'));
  try {
    exportAll(db, join(dir, 'out'), { now: new Date(AT) });
    const out = JSON.parse(readFileSync(join(dir, 'out', 'actresses.json'), 'utf8')) as { id: string }[];
    assert.deepEqual(out.map((a) => a.id), actressIdsInWorks(db).filter((id) => db.getActressProfile(id)));
    assert.ok(!out.some((a) => a.id === 'unused-1'));
    assert.ok(!readFileSync(join(dir, 'out', 'actresses.json'), 'utf8').includes('imageURL'));
  } finally { rmSync(dir, { recursive: true, force: true }); db.close(); }
});
