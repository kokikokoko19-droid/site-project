import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateTable, featureMarkdown, main } from '../scripts/draft-feature.ts';
import { checkText } from '../src/lib/ai-text.ts';
import { clearCatalogCache } from '../src/lib/catalog.ts';
import type { CatalogWork } from '../src/lib/catalog.ts';
import { THEMES, THEME_KEYS, featureCandidates, introTemplate, isThemeKey, themeFacts } from '../src/lib/feature-candidates.ts';

function mk(id: string, over: Partial<CatalogWork> = {}): CatalogWork {
  return {
    contentId: id, productId: null, title: `題名-${id}`, url: null, affiliateUrl: null, volumeMin: 120, releasedAt: '2026-01-01',
    reviewCount: 10, reviewAvg: 4.0, priceMin: 1500, listPrice: 2000, deliveries: [], imageList: null, imageSmall: null, imageLarge: null,
    sampleImages: [], sampleMovie: null, campaigns: [], genres: [], actresses: [], series: [], makers: [], labels: [], directors: [],
    rankPosition: null, fetchedAt: '2026-11-01T00:00:00Z', status: 'active', derivedLabels: [], similarIds: [], ...over,
  };
}
const NOW = new Date('2026-11-15T03:00:00Z');
const ids = (l: { contentId: string }[]) => l.map((c) => c.contentId);

describe('特集の候補', () => {
  it('classic: レビュー 100 件以上を評価順（同じなら件数順）。10 件まで', () => {
    const works = [
      mk('a', { reviewCount: 100, reviewAvg: 4.5 }), mk('b', { reviewCount: 99, reviewAvg: 5 }), mk('c', { reviewCount: 300, reviewAvg: 4.5 }),
      mk('d', { reviewCount: 150, reviewAvg: null }), mk('e', { reviewCount: 120, reviewAvg: 4.9 }),
    ];
    assert.deepEqual(ids(featureCandidates({ works }, 'classic', NOW)), ['e', 'c', 'a', 'd']);
    const many = Array.from({ length: 30 }, (_, i) => mk(`w${String(i).padStart(2, '0')}`, { reviewCount: 100 + i }));
    assert.equal(featureCandidates({ works: many }, 'classic', NOW).length, 10);
    assert.equal(featureCandidates({ works: many }, 'classic', NOW, 3).length, 3);
  });

  it('month: 30 日以内・レビュー 5 件以上をベイズ平均順（少数の高評価より件数の多い高評価）', () => {
    const works = [
      mk('few', { releasedAt: '2026-11-10', reviewCount: 5, reviewAvg: 5 }),
      mk('many', { releasedAt: '2026-11-01', reviewCount: 80, reviewAvg: 4.8 }),
      mk('edge', { releasedAt: '2026-10-16', reviewCount: 40, reviewAvg: 4.0 }),   // ちょうど 30 日前は含む
      mk('old', { releasedAt: '2026-10-15', reviewCount: 99, reviewAvg: 5 }),      // 31 日前は除く
      mk('fresh', { releasedAt: '2026-11-14', reviewCount: 4, reviewAvg: 5 }),     // 件数不足
      mk('future', { releasedAt: '2026-11-20', reviewCount: 50, reviewAvg: 5 }),   // 未来は除く
      mk('nodate', { releasedAt: null, reviewCount: 50, reviewAvg: 5 }),
      ...Array.from({ length: 8 }, (_, i) => mk(`low${i}`, { releasedAt: '2025-01-01', reviewCount: 50, reviewAvg: 3 })), // 全体平均を下げる（事前値）
    ];
    assert.deepEqual(ids(featureCandidates({ works }, 'month', NOW)), ['many', 'few', 'edge']);
  });

  it('starter: 60 分以下・レビュー 10 件以上を評価順', () => {
    const works = [
      mk('a', { volumeMin: 60, reviewCount: 10, reviewAvg: 4.2 }), mk('b', { volumeMin: 61, reviewCount: 50, reviewAvg: 5 }),
      mk('c', { volumeMin: 30, reviewCount: 9, reviewAvg: 5 }), mk('d', { volumeMin: null, reviewCount: 50, reviewAvg: 5 }),
      mk('e', { volumeMin: 45, reviewCount: 20, reviewAvg: 4.6 }),
    ];
    assert.deepEqual(ids(featureCandidates({ works }, 'starter', NOW)), ['e', 'a']);
  });

  it('sale: セール中だけを評価順', () => {
    const works = [mk('a', { derivedLabels: ['セール中'], reviewAvg: 4.1 }), mk('b', { reviewAvg: 5 }), mk('c', { derivedLabels: ['新作', 'セール中'], reviewAvg: 4.7 })];
    assert.deepEqual(ids(featureCandidates({ works }, 'sale', NOW)), ['c', 'a']);
  });

  it('出力は content_id・評価・件数・収録時間・価格・配信日だけ（題名を含まない）', () => {
    const [c] = featureCandidates({ works: [mk('a', { reviewCount: 100, priceMin: 990 })] }, 'classic', NOW);
    assert.deepEqual(c, { contentId: 'a', reviewAvg: 4, reviewCount: 100, volumeMin: 120, price: 990, releasedAt: '2026-01-01' });
    assert.ok(!JSON.stringify(c).includes('題名'));
    assert.ok(!candidateTable([c]).includes('題名'));
  });

  it('テーマ名の判定と、導入文のテンプレートが検査に通る', () => {
    assert.ok(isThemeKey('classic') && !isThemeKey('nope'));
    for (const key of THEME_KEYS) {
      const facts = themeFacts(THEMES[key], 10);
      assert.deepEqual(checkText(introTemplate(key), { bannedWords: ['禁止語'], facts, minSentences: 2, maxSentences: 3 }), { ok: true }, key);
    }
  });
});

describe('draft-feature の出力と main', () => {
  it('featureMarkdown は draft: true で works を列挙し、数字だけの ID も文字列にする', () => {
    const md = featureMarkdown(THEMES.classic, '2026-11-15', ['00123', 'abc'], { text: '導入です。二文目です。', source: 'template', reason: null });
    assert.match(md, /\ndraft: true\n/);
    assert.match(md, /works:\n {2}- "00123"\n {2}- "abc"\n/);
    assert.match(md, /### 選んだ理由/);
    assert.match(featureMarkdown(THEMES.sale, '2026-11-15', [], { text: 'x。', source: 'llm', reason: null }), /works: \[\]/);
  });

  const orig = process.cwd();
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedExport = process.env.EXPORT_DIR;
  let dir = '';
  before(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.EXPORT_DIR;
    dir = mkdtempSync(join(tmpdir(), 'feature-'));
    mkdirSync(join(dir, 'data/export'), { recursive: true });
    const works = [mk('x1', { reviewCount: 200, reviewAvg: 4.8 }), mk('x2', { reviewCount: 150, reviewAvg: 4.5 })];
    writeFileSync(join(dir, 'data/export/works.json'), JSON.stringify(works));
    writeFileSync(join(dir, 'data/export/meta.json'), '{}');
    writeFileSync(join(dir, 'data/export/index.json'), '{}');
    process.chdir(dir);
    clearCatalogCache();
  });
  after(() => {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedExport !== undefined) process.env.EXPORT_DIR = savedExport;
  });
  const run = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await main(args, (s) => out.push(s), (s) => err.push(s));
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('--theme が無い・不正なら終了コード 2', async () => {
    assert.equal((await run([])).code, 2);
    assert.equal((await run(['--theme', 'nope'])).code, 2);
  });
  it('--dry-run は書かない。通常は draft の md を作り、題名を含まない。既存は --force なしで上書きしない', async () => {
    const f = join(dir, 'src/content/feature/draft-classic.md');
    const dry = await run(['--theme', 'classic', '--dry-run']);
    assert.equal(dry.code, 0);
    assert.ok(!existsSync(f));
    assert.equal((await run(['--theme', 'classic'])).code, 0);
    const md = readFileSync(f, 'utf8');
    assert.match(md, /draft: true/);
    assert.match(md, /- "x1"\n {2}- "x2"/);
    assert.ok(!md.includes('題名-'));
    assert.equal((await run(['--theme', 'classic'])).code, 2);
    assert.equal((await run(['--theme', 'classic', '--force'])).code, 0);
  });
});
