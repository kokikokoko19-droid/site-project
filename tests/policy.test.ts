/** src/data/policy.ts のテスト（掲載方針 案 A）。実行: node --experimental-strip-types --test tests/policy.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_POLICY, isPublished, loadPublishPolicy, parsePublishPolicy, publishFilter, recentSince } from '../src/data/policy.ts';
import type { PublishContext } from '../src/data/policy.ts';
import type { Work } from '../src/data/types.ts';

const NOW = new Date('2026-11-15T03:00:00Z'); // 日本時間 2026-11-15 12:00
const empty = { actresses: [], series: [], makers: [] };
const ctx = (patch: Partial<PublishContext> = {}): PublishContext => ({ now: NOW, follow: empty, policy: { ...DEFAULT_POLICY }, ...patch });

function makeWork(patch: Partial<Work> = {}): Work {
  return {
    contentId: 'p00001', productId: null, title: '作品', url: null, affiliateUrl: null, volumeMin: 120, releasedAt: '2024-01-01T10:00:00',
    reviewCount: 0, reviewAvg: null, priceMin: null, listPrice: null, deliveries: [], imageList: null, imageSmall: null, imageLarge: null,
    sampleImages: [], sampleMovie: null, campaigns: [], genres: [], actresses: [], series: [], makers: [], labels: [], directors: [],
    rankPosition: null, fetchedAt: '2026-11-01T00:00:00.000Z', status: 'active', ...patch,
  };
}

test('recentSince: 日本時間の今日から N か月前。月末は丸める', () => {
  assert.equal(recentSince(NOW, 3), '2026-08-15');
  assert.equal(recentSince(new Date('2026-05-30T16:00:00Z'), 3), '2026-02-28'); // JST 5/31 → 2/28
  assert.equal(recentSince(new Date('2026-11-14T15:30:00Z'), 0), '2026-11-15'); // UTC では 14 日でも JST は 15 日
  assert.equal(recentSince(new Date('2026-02-15T00:00:00Z'), 3), '2025-11-15'); // 年をまたぐ
});

test('isPublished: 直近 3 か月はレビューが無くても全件。境界の日を含み、配信開始前も含む', () => {
  for (const d of ['2026-08-15T00:00:00', '2026-11-01T10:00:00', '2026-12-20T10:00:00']) assert.equal(isPublished(makeWork({ releasedAt: d }), ctx()), true, d);
  assert.equal(isPublished(makeWork({ releasedAt: '2026-08-14T23:59:00' }), ctx()), false);
});

test('isPublished: それより前はレビュー minReviews 件以上だけ。日付の無い作品も同じ扱い', () => {
  assert.equal(isPublished(makeWork({ reviewCount: 19 }), ctx()), false);
  assert.equal(isPublished(makeWork({ reviewCount: 20 }), ctx()), true);
  assert.equal(isPublished(makeWork({ releasedAt: null, reviewCount: 19 }), ctx()), false);
  assert.equal(isPublished(makeWork({ releasedAt: null, reviewCount: 25 }), ctx()), true);
  assert.equal(isPublished(makeWork({ reviewCount: 5 }), ctx({ policy: { ...DEFAULT_POLICY, minReviews: 5 } })), true);
});

test('isPublished: 人気順の上位は別枠（includeRanked で切り替え）', () => {
  const w = makeWork({ rankPosition: 120 });
  assert.equal(isPublished(w, ctx()), true);
  assert.equal(isPublished(w, ctx({ policy: { ...DEFAULT_POLICY, includeRanked: false } })), false);
});

test('isPublished: follow.json の出演者・シリーズ・メーカーの作品は別枠（includeFollowed で切り替え）', () => {
  const follow = { actresses: [{ id: '11' }], series: [{ id: '22' }], makers: [{ id: '33' }] };
  for (const patch of [{ actresses: [{ id: '11', name: 'A' }] }, { series: [{ id: '22', name: 'S' }] }, { makers: [{ id: '33', name: 'M' }] }]) {
    assert.equal(isPublished(makeWork(patch), ctx({ follow })), true);
    assert.equal(isPublished(makeWork(patch), ctx({ follow, policy: { ...DEFAULT_POLICY, includeFollowed: false } })), false);
  }
  assert.equal(isPublished(makeWork({ actresses: [{ id: '12', name: 'B' }] }), ctx({ follow })), false);
});

test('isPublished: gone の作品はどの枠でも含めない', () => {
  const w = makeWork({ status: 'gone', releasedAt: '2026-11-01T00:00:00', reviewCount: 100, rankPosition: 1 });
  assert.equal(isPublished(w, ctx()), false);
  assert.equal(publishFilter(ctx())({ ...w, status: 'active' }), true);
});

test('loadPublishPolicy: 無ければ既定、欠けた項目は既定値、型が違えば例外', () => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-test-'));
  try {
    assert.deepEqual(loadPublishPolicy(join(dir, 'none.json')), DEFAULT_POLICY);
    writeFileSync(join(dir, 'p.json'), '{"recentMonths": 6}');
    assert.deepEqual(loadPublishPolicy(join(dir, 'p.json')), { ...DEFAULT_POLICY, recentMonths: 6 });
    writeFileSync(join(dir, 'bad.json'), '{');
    assert.throws(() => loadPublishPolicy(join(dir, 'bad.json')), SyntaxError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  for (const bad of [null, [], { recentMonths: -1 }, { minReviews: 1.5 }, { includeRanked: 'yes' }]) assert.throws(() => parsePublishPolicy(bad), TypeError);
  assert.deepEqual(loadPublishPolicy(), { recentMonths: 3, minReviews: 20, includeRanked: true, includeFollowed: true }); // config/publish.json
});
