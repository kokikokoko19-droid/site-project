#!/usr/bin/env node
// 実データ確認（Smoke）用の要約。data/export の JSON から件数だけを数えて Markdown で出す。
// タイトル・出演者名・ジャンル名などの文字列は出さない（ログに残すのは件数と ID だけ）。
// 使い方: node scripts/smoke-summary.mjs [EXPORT_DIR]   （省略時は環境変数 EXPORT_DIR、なければ data/export）
// 終了コード: 0 要約を出せた、1 作品が 0 件（取り込みが空）または works.json がない
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? process.env.EXPORT_DIR ?? 'data/export';
const read = (name) => {
  const p = join(dir, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

const works = read('works.json') ?? [];
const index = read('index.json');
const meta = read('meta.json');
const actresses = read('actresses.json') ?? [];

const count = (pred) => works.filter(pred).length;
const pct = (n) => (works.length === 0 ? '-' : `${Math.round((n / works.length) * 100)}%`);
const row = (label, n) => `| ${label} | ${n} | ${pct(n)} |`;
const isDmmHttps = (u) => typeof u === 'string' && /^https:\/\/([a-z0-9-]+\.)*dmm\.(co\.jp|com)\//.test(u);
const sampleMovieUrls = (w) => Object.values(w.sampleMovie?.sizes ?? {});

const lines = [];
lines.push('## 実データ確認（Smoke）の要約', '');
lines.push(`- 書き出し先: \`${dir}\``);
lines.push(`- 作品数: ${works.length}（index.json の total: ${index?.total ?? '-'}、チャンク数: ${Array.isArray(index?.chunks) ? index.chunks.length : '-'}）`);
lines.push(`- 最終取り込み: ${meta?.last_ingest_at ?? '-'}、最終派生計算: ${meta?.last_derive_at ?? '-'}`);

if (works.length === 0) {
  lines.push('', '**作品が 0 件です。取り込みが空か、書き出しに失敗しています。**');
  console.log(lines.join('\n'));
  process.exit(1);
}

const dates = works.map((w) => w.releasedAt).filter((d) => typeof d === 'string').map((d) => d.slice(0, 10)).sort();
lines.push(`- 配信開始日の範囲: ${dates[0] ?? '-'} 〜 ${dates[dates.length - 1] ?? '-'}（日付あり ${dates.length} 件）`);
const statuses = {};
for (const w of works) statuses[w.status] = (statuses[w.status] ?? 0) + 1;
lines.push(`- status: ${Object.entries(statuses).map(([k, v]) => `${k}=${v}`).join(', ')}`);

lines.push('', '### 項目の埋まり具合', '', '| 項目 | 件数 | 割合 |', '|---|---:|---:|');
lines.push(row('画像（imageLarge）', count((w) => typeof w.imageLarge === 'string')));
lines.push(row('画像（imageList または imageSmall）', count((w) => typeof w.imageList === 'string' || typeof w.imageSmall === 'string')));
lines.push(row('サンプル画像あり', count((w) => Array.isArray(w.sampleImages) && w.sampleImages.length > 0)));
lines.push(row('サンプル動画あり', count((w) => w.sampleMovie !== null && sampleMovieUrls(w).length > 0)));
lines.push(row('商品 URL（url）', count((w) => typeof w.url === 'string')));
lines.push(row('アフィリエイト URL（affiliateUrl）', count((w) => typeof w.affiliateUrl === 'string')));
lines.push(row('価格あり（priceMin）', count((w) => typeof w.priceMin === 'number')));
lines.push(row('定価あり（listPrice）', count((w) => typeof w.listPrice === 'number')));
lines.push(row('配信形式あり（deliveries）', count((w) => Array.isArray(w.deliveries) && w.deliveries.length > 0)));
lines.push(row('レビューあり（reviewCount > 0）', count((w) => w.reviewCount > 0)));
lines.push(row('収録時間あり（volumeMin）', count((w) => typeof w.volumeMin === 'number')));
lines.push(row('出演者あり', count((w) => w.actresses.length > 0)));
lines.push(row('ジャンルあり', count((w) => w.genres.length > 0)));
lines.push(row('シリーズあり', count((w) => w.series.length > 0)));
lines.push(row('メーカーあり', count((w) => w.makers.length > 0)));
lines.push(row('キャンペーンあり', count((w) => Array.isArray(w.campaigns) && w.campaigns.length > 0)));
lines.push(row('人気順の順位あり（rankPosition）', count((w) => typeof w.rankPosition === 'number')));
lines.push(row('派生ラベルあり', count((w) => Array.isArray(w.derivedLabels) && w.derivedLabels.length > 0)));
lines.push(row('似た作品あり', count((w) => Array.isArray(w.similarIds) && w.similarIds.length > 0)));

// 派生ラベルの内訳（ラベル名はこのサイトが付ける語で、作品の文字列ではない）
const labelCounts = {};
for (const w of works) for (const l of w.derivedLabels ?? []) labelCounts[l] = (labelCounts[l] ?? 0) + 1;
lines.push('', '### 派生ラベルの内訳', '');
lines.push(Object.keys(labelCounts).length === 0 ? '- なし' : Object.entries(labelCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`).join('\n'));

// 出演者プロフィール（works に出てくる出演者のうち、プロフィールが取れた数）
const actressIds = new Set();
for (const w of works) for (const a of w.actresses) actressIds.add(String(a.id));
lines.push('', '### 出演者プロフィール', '');
lines.push(`- works に出てくる出演者: ${actressIds.size} 人、プロフィールあり: ${actresses.length} 人`);
lines.push(`- 生年月日あり: ${actresses.filter((a) => a.birthday).length} 人、身長あり: ${actresses.filter((a) => typeof a.height === 'number').length} 人、一覧 URL あり: ${actresses.filter((a) => a.listUrl).length} 人`);

// URL の形（https で dmm のドメインか）。外れたものは ID だけ出す
const badUrl = [];
for (const w of works) {
  for (const [k, u] of [['url', w.url], ['affiliateUrl', w.affiliateUrl], ['imageLarge', w.imageLarge], ['imageList', w.imageList], ['imageSmall', w.imageSmall]]) {
    if (u !== null && u !== undefined && !isDmmHttps(u)) badUrl.push(`${w.contentId}:${k}`);
  }
  for (const u of sampleMovieUrls(w)) if (!isDmmHttps(u)) badUrl.push(`${w.contentId}:sampleMovie`);
  for (const u of w.sampleImages ?? []) if (!isDmmHttps(u)) badUrl.push(`${w.contentId}:sampleImage`);
}
lines.push('', '### URL の形（https かつ dmm.co.jp / dmm.com）', '');
lines.push(badUrl.length === 0 ? '- 全て問題なし' : `- 外れたもの ${badUrl.length} 件: ${badUrl.slice(0, 20).join(', ')}${badUrl.length > 20 ? ' …' : ''}`);

// ランキング・今日の候補
const rk = meta?.rankings && typeof meta.rankings === 'object' ? meta.rankings : {};
lines.push('', '### ランキングと今日の候補', '');
lines.push(`- ランキングの軸: ${Object.keys(rk).length} 個（${Object.entries(rk).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : '?'}`).join(', ') || 'なし'}）`);
lines.push(`- 今日の候補: ${Array.isArray(meta?.todays) ? meta.todays.length : 0} 件`);

// 実物確認に使う ID（文字列はコンテンツ ID だけ）
const pick = (pred, n = 5) => works.filter(pred).slice(0, n).map((w) => w.contentId);
lines.push('', '### 実物確認に使う ID', '');
lines.push(`- サンプル動画あり: ${pick((w) => w.sampleMovie !== null && sampleMovieUrls(w).length > 0).join(', ') || 'なし'}`);
lines.push(`- 人気順の上位: ${works.filter((w) => typeof w.rankPosition === 'number').sort((a, b) => a.rankPosition - b.rankPosition).slice(0, 5).map((w) => w.contentId).join(', ') || 'なし'}`);
lines.push(`- 出演者あり: ${pick((w) => w.actresses.length > 0).join(', ') || 'なし'}`);
lines.push(`- 出演者 ID（プロフィールあり）: ${actresses.slice(0, 5).map((a) => a.id).join(', ') || 'なし'}`);

console.log(lines.join('\n'));
