/**
 * 新着ページ（/new/）の作品の切り分け。期間（今日／7日／30日）と近日配信（配信日が今日より後）、
 * 絞り込みチップの件数（その期間の新着で多い順）を作る。日付は日本時間で比べる。
 */
import type { CatalogWork } from './catalog.ts';

/** 新着の期間タブ。値は日数（今日を含めて何日分か） */
export const NEW_PERIODS = [
  { key: '1', label: '今日', days: 1 },
  { key: '7', label: '7日', days: 7 },
  { key: '30', label: '30日', days: 30 },
] as const;
export const NEW_MAX_DAYS = 30;

/** 日本時間の今日（YYYY-MM-DD） */
export function jstToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD に日数を足す（負数で戻る） */
export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  return new Date(t + n * 86400 * 1000).toISOString().slice(0, 10);
}

/** 作品の配信日（YYYY-MM-DD）。読めなければ '' */
export function releaseDay(w: CatalogWork): string {
  const s = typeof w.releasedAt === 'string' ? w.releasedAt.trim().slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/**
 * 配信日の新しい順に並んだ作品（catalog.recent()）を、近日配信（today より後）と、直近 days 日の新着に分ける。
 * 近日配信は配信日の近い順、新着は新しい順。
 */
export function splitNew(sorted: readonly CatalogWork[], today: string, days = NEW_MAX_DAYS): { upcoming: CatalogWork[]; recent: CatalogWork[] } {
  const from = addDays(today, -(days - 1));
  const upcoming: CatalogWork[] = [];
  const recent: CatalogWork[] = [];
  for (const w of sorted) {
    const d = releaseDay(w);
    if (d === '') continue;
    if (d > today) upcoming.push(w);
    else if (d >= from) recent.push(w);
  }
  return { upcoming: upcoming.reverse(), recent };
}

/** 作品の並びを配信日ごとにまとめる（並び順はそのまま） */
export function groupByDay(works: readonly CatalogWork[]): { day: string; works: CatalogWork[] }[] {
  const out: { day: string; works: CatalogWork[] }[] = [];
  for (const w of works) {
    const d = releaseDay(w);
    const last = out[out.length - 1];
    if (last && last.day === d) last.works.push(w);
    else out.push({ day: d, works: [w] });
  }
  return out;
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
/** "11月14日（金）" の形。読めない値は '' */
export function dayHeading(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return '';
  const wd = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return `${Number(m[2])}月${Number(m[3])}日（${WEEK[wd]}）`;
}

/** 参照（ジャンル・メーカー・出演者）を件数の多い順に数える。同数は名前順 */
export function facetCounts(works: readonly CatalogWork[], pick: (w: CatalogWork) => { id: string; name: string }[]): { id: string; name: string; count: number }[] {
  const m = new Map<string, { id: string; name: string; count: number }>();
  for (const w of works) {
    const seen = new Set<string>();
    for (const r of pick(w)) {
      if (!r?.id || seen.has(r.id)) continue;
      seen.add(r.id);
      const hit = m.get(r.id);
      if (hit) hit.count++;
      else m.set(r.id, { id: r.id, name: r.name, count: 1 });
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
}
