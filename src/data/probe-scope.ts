/**
 * 母集団の規模を測る（未確認事項 #30）。API から直近 N か月の作品を月ごとに数え、レビュー件数の分布を出す。DB には保存しない。
 * 使い方: node --experimental-strip-types src/data/probe-scope.ts [--months N] [--interval MS]
 * 環境変数: FANZA_API_ID, FANZA_AFFILIATE_ID（必須）, FANZA_BASE_URL（試験用。通常は未設定）
 * 出力: 月ごとの表と、絞り込み方針ごとの件数（Markdown）。API ID や URL は出さない。
 */
import { parseArgs } from 'node:util';
import { createClient } from './api.ts';
import { normalizeItems } from './normalize.ts';
import type { Work } from './types.ts';

const THRESHOLDS = [1, 5, 10, 20, 50] as const;
type MonthStat = { month: string; total: number; sample: number; rev: Record<number, number> };

/** 月の初日と末日（UTC）を API の日付形式で */
function monthRange(d: Date): { gte: string; lte: string; key: string } {
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const mm = String(m + 1).padStart(2, '0');
  return { gte: `${y}-${mm}-01T00:00:00`, lte: `${y}-${mm}-${String(last).padStart(2, '0')}T23:59:59`, key: `${y}-${mm}` };
}
/** 月を前半（1〜15日）と後半に分ける（1 窓 5,000 件の上限に収めるため） */
function halves(r: { gte: string; lte: string }): Array<{ gte: string; lte: string }> {
  const ym = r.gte.slice(0, 7);
  return [{ gte: r.gte, lte: `${ym}-15T23:59:59` }, { gte: `${ym}-16T00:00:00`, lte: r.lte }];
}

export function tally(works: Work[], stat: MonthStat): void {
  for (const w of works) {
    stat.total++;
    if (w.sampleMovie) stat.sample++;
    for (const t of THRESHOLDS) if (w.reviewCount >= t) stat.rev[t]++;
  }
}

/** 絞り込み方針ごとの件数。recentMonths か月は全件、それより前はレビュー minReviews 件以上 */
export function policyCount(stats: MonthStat[], recentMonths: number, minReviews: number | null): number {
  // minReviews が null なら「直近 recentMonths か月だけ」、0 なら全件、それ以外はその件数以上
  return stats.reduce((sum, s, i) => sum + (i < recentMonths ? s.total : (minReviews === null ? 0 : minReviews === 0 ? s.total : (s.rev[minReviews] ?? 0))), 0);
}

export function renderReport(stats: MonthStat[]): string {
  const lines: string[] = [];
  lines.push('## 月ごとの件数（配信開始日ベース、新しい月から）', '', '| 月 | 全件 | サンプル動画 | レビュー1+ | 5+ | 10+ | 20+ | 50+ |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const s of stats) lines.push(`| ${s.month} | ${s.total} | ${s.sample} | ${s.rev[1]} | ${s.rev[5]} | ${s.rev[10]} | ${s.rev[20]} | ${s.rev[50]} |`);
  const all = stats.reduce((a, s) => a + s.total, 0);
  lines.push(`| 合計 | ${all} | ${stats.reduce((a, s) => a + s.sample, 0)} | ${THRESHOLDS.map((t) => stats.reduce((a, s) => a + s.rev[t], 0)).join(' | ')} |`);
  lines.push('', '## 絞り込み方針ごとの作品数と見積もり', '', '| 方針 | 作品数 | 静的ページ数の目安（作品＋中継） | 探索 JSON の目安 |', '|---|---:|---:|---:|');
  const policies: Array<[string, number]> = [
    ['36か月 全件', policyCount(stats, 0, 0)],
    ['36か月 レビュー5件以上', policyCount(stats, 0, 5)],
    ['36か月 レビュー10件以上', policyCount(stats, 0, 10)],
    ['36か月 レビュー20件以上', policyCount(stats, 0, 20)],
    ['直近3か月 全件 ＋ それ以前 10件以上', policyCount(stats, 3, 10)],
    ['直近6か月 全件 ＋ それ以前 10件以上', policyCount(stats, 6, 10)],
    ['直近6か月 全件 ＋ それ以前 20件以上', policyCount(stats, 6, 20)],
    ['直近12か月 全件 ＋ それ以前 20件以上', policyCount(stats, 12, 20)],
    ['直近12か月 全件のみ', policyCount(stats, 12, null)],
    ['直近3か月 全件 ＋ それ以前 20件以上', policyCount(stats, 3, 20)],
  ];
  for (const [name, n] of policies) lines.push(`| ${name} | ${n.toLocaleString('ja-JP')} | ${(n * 2).toLocaleString('ja-JP')} | 約 ${Math.round((n * 330) / 1024 / 1024 * 10) / 10} MB |`);
  lines.push('', '※ 探索 JSON は 1 作品あたり約 330 バイト（カード用レコード）で概算。人気順や指定軸の全作品はこの数に加算される。');
  return lines.join('\n');
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { months: { type: 'string' }, interval: { type: 'string' } } });
  const months = Number(values.months ?? 36), interval = Number(values.interval ?? 1000);
  const apiId = process.env.FANZA_API_ID, affiliateId = process.env.FANZA_AFFILIATE_ID;
  if (!apiId || !affiliateId) { console.error('FANZA_API_ID と FANZA_AFFILIATE_ID を設定してください'); return 2; }
  const client = createClient({ apiId, affiliateId, minIntervalMs: interval, ...(process.env.FANZA_BASE_URL ? { baseUrl: process.env.FANZA_BASE_URL } : {}) });
  const now = new Date();
  const stats: MonthStat[] = [];
  let calls = 0;
  for (let i = 0; i < months; i++) {
    const r = monthRange(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)));
    const stat: MonthStat = { month: r.key, total: 0, sample: 0, rev: Object.fromEntries(THRESHOLDS.map((t) => [t, 0])) as Record<number, number> };
    for (const h of halves(r)) {
      let offset = 1;
      for (;;) {
        const page = await client.itemList({ sort: 'date', gte_date: h.gte, lte_date: h.lte, hits: 100, offset });
        calls++;
        tally(normalizeItems(page.items, { fetchedAt: now.toISOString() }), stat);
        offset += 100;
        if (page.items.length < 100 || offset > page.totalCount || offset > 5000) {
          if (offset > 5000 && offset <= page.totalCount) console.log(`  注意: ${h.gte.slice(0, 10)}〜 は ${page.totalCount} 件あり、5,000 件までしか数えていません`);
          break;
        }
      }
    }
    console.log(`  ${r.key}: 全 ${stat.total} 件、レビュー10件以上 ${stat.rev[10]} 件（呼び出し累計 ${calls}）`);
    stats.push(stat);
  }
  console.log('');
  console.log(renderReport(stats));
  console.log(`\n呼び出し回数: ${calls}`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) process.exitCode = await main();
