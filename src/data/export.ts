/**
 * 探索UI・ページ生成用の JSON を出力する（docs/02 5.2 のラベルで絞り込むための軽量データ）。
 * 紹介文・レビュー本文にあたる項目は Work 型に無く、ここでも付けない。
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.ts';
import { ALL_LABELS } from './derive.ts';
import type { DerivedLabel, Work, WorkCardRecord } from './types.ts';

/** works.json の1件。Work に、派生ラベルと似た作品の ID（score の高い順）を付けたもの */
export type ExportedWork = Work & { derivedLabels: DerivedLabel[]; similarIds: string[] };

/** DB に保存された文字列ラベルのうち既知のものだけを、定義順で返す */
const knownLabels = (names: string[]): DerivedLabel[] => ALL_LABELS.filter((l) => names.includes(l));

/** 探索UI用の軽量レコード（d は releasedAt の先頭10文字、sale は 'セール中' の有無、sm はサンプル動画の有無） */
export function toCardRecord(work: Work, labels: DerivedLabel[]): WorkCardRecord {
  return {
    id: work.contentId,
    t: work.title,
    a: work.actresses.map((x) => x.name),
    m: work.makers[0]?.name ?? null,
    s: work.series[0]?.name ?? null,
    g: work.genres.map((x) => x.name),
    v: work.volumeMin,
    d: work.releasedAt === null ? null : work.releasedAt.slice(0, 10),
    rc: work.reviewCount,
    ra: work.reviewAvg,
    p: work.priceMin,
    lp: work.listPrice,
    sale: labels.includes('セール中'),
    sm: work.sampleMovie !== null,
    img: work.imageSmall,
    rk: work.rankPosition,
    lb: [...labels],
  };
}

/** meta に JSON として保存された値を読む。無い・壊れているときは null */
function readJson(db: Db, key: string): unknown {
  const raw = db.getMeta(key);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * active の作品を outDir に出力する。
 * works-000.json…（WorkCardRecord を chunkSize 件ずつ）、works.json（全 Work + derivedLabels + similarIds）、
 * meta.json（rankings・todays・last_ingest_at・last_derive_at）、index.json（件数・チャンク名・絞り込み用の名前一覧）。
 * index.json は最後に書く。前回より少なくなって余ったチャンクは消す。now は generatedAt の差し替え用。
 */
export function exportAll(
  db: Db, outDir: string, opts: { chunkSize?: number; now?: Date } = {},
): { works: number; chunks: number } {
  const chunkSize = opts.chunkSize ?? 1000;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new RangeError(`chunkSize は1以上の整数で指定してください: ${chunkSize}`);
  const works = db.listWorks({ status: 'active' });
  const active = new Set(works.map((w) => w.contentId));
  // 派生後に gone になった作品の ID が残っていても、出力には含めない
  const keep = (ids: unknown): string[] => (Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && active.has(id)) : []);

  const cards: WorkCardRecord[] = [], full: ExportedWork[] = [];
  for (const w of works) {
    const labels = knownLabels(db.getLabels(w.contentId));
    cards.push(toCardRecord(w, labels));
    full.push({ ...w, derivedLabels: labels, similarIds: keep(db.getSimilar(w.contentId).map((s) => s.similarId)) });
  }
  const rk = readJson(db, 'rankings') as Record<string, unknown> | null, todays = readJson(db, 'todays');
  const meta = {
    rankings: rk && typeof rk === 'object'
      ? { byRating: keep(rk.byRating), byRecent: keep(rk.byRecent), byPopularity: keep(rk.byPopularity) } : null,
    todays: Array.isArray(todays) ? keep(todays) : null,
    last_ingest_at: db.getMeta('last_ingest_at'),
    last_derive_at: db.getMeta('last_derive_at'),
  };

  mkdirSync(outDir, { recursive: true });
  const write = (name: string, data: unknown): void => writeFileSync(join(outDir, name), JSON.stringify(data));
  const chunks: string[] = [];
  for (let i = 0; i * chunkSize < cards.length; i++) {
    chunks.push(`works-${String(i).padStart(3, '0')}.json`);
    write(chunks[i], cards.slice(i * chunkSize, (i + 1) * chunkSize));
  }
  write('works.json', full);
  write('meta.json', meta);
  const names = (pick: (w: Work) => { name: string }[]): string[] => [...new Set(works.flatMap((w) => pick(w).map((r) => r.name)))].sort();
  write('index.json', {
    generatedAt: (opts.now ?? new Date()).toISOString(), total: works.length, chunks,
    genres: names((w) => w.genres), actresses: names((w) => w.actresses), series: names((w) => w.series), makers: names((w) => w.makers),
    labels: ALL_LABELS.filter((l) => full.some((w) => w.derivedLabels.includes(l))), // 実際に使われているラベルだけ
  });
  for (const f of readdirSync(outDir)) if (/^works-\d+\.json$/.test(f) && !chunks.includes(f)) rmSync(join(outDir, f));
  return { works: works.length, chunks: chunks.length };
}
