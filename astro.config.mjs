// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// 作品が THIN_MIN 本未満の出演者・シリーズ・メーカーのページは noindex にしていて（第三者レビュー C-3）、sitemap からも外す。
// ページ側の判定（ActressPage・AxisPage）と同じ数え方で、ビルド時に data/export/works.json を読んで数える。
const THIN_MIN = 3;
function thinPaths() {
  const out = new Set();
  // 読み込み先は src/lib/catalog.ts の loadCatalog と同じ（環境変数 EXPORT_DIR、無ければ data/export）
  const file = join(resolve(process.cwd(), process.env.EXPORT_DIR || 'data/export'), 'works.json');
  if (!existsSync(file)) return out;
  let works = [];
  try { works = JSON.parse(readFileSync(file, 'utf8')); } catch { return out; }
  for (const [axis, key] of [['actress', 'actresses'], ['series', 'series'], ['maker', 'makers']]) {
    const counts = new Map();
    for (const w of Array.isArray(works) ? works : []) {
      if (!w || w.status === 'gone') continue;
      const seen = new Set();
      for (const r of Array.isArray(w[key]) ? w[key] : []) {
        if (!r?.id || seen.has(r.id)) continue;
        seen.add(r.id);
        counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
      }
    }
    for (const [id, n] of counts) if (n < THIN_MIN) out.add(`/${axis}/${encodeURIComponent(id)}/`);
  }
  return out;
}
const thin = thinPaths();

// 静的サイト生成の設定（設計方針 9章）。
// site はホストとドメインが決まるまで仮の値。.invalid は予約済みで実在しないドメイン。
// 確定したら本番のURLに差し替える（canonical や sitemap に使われる。public/robots.txt の Sitemap 行も合わせる）。
export default defineConfig({
  output: 'static',
  site: 'https://avmeguri.com', // 取得予定のドメイン。取得後に実際の値へ
  // URL は末尾スラッシュ付きで統一する（設計方針 2.1 のURL表と同じ形）
  trailingSlash: 'always',
  build: {
    // /about/ は dist/about/index.html、トップは dist/index.html になる
    format: 'directory',
  },
  integrations: [
    sitemap({
      // 中継ページ（/go/）はサイトマップに載せない。noindex・robots.txt の Disallow と揃える。
      // 作品の少ない出演者・シリーズ・メーカー（noindex のページ）も外す。page は https://… から始まる完全なURL。
      filter: (page) => {
        const path = new URL(page).pathname;
        return !path.startsWith('/go/') && !thin.has(path);
      },
    }),
  ],
});
