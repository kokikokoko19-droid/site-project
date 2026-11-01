// @ts-check
import { defineConfig } from 'astro/config';

// 静的サイト生成の設定（設計方針 9章）。
// site はホストとドメインが決まるまで仮の値。.invalid は予約済みで実在しないドメイン。
// 確定したら本番のURLに差し替える（canonical や sitemap を足すときに使う）。
export default defineConfig({
  output: 'static',
  site: 'https://example.invalid',
  // URL は末尾スラッシュ付きで統一する（設計方針 2.1 のURL表と同じ形）
  trailingSlash: 'always',
  build: {
    // /about/ は dist/about/index.html、トップは dist/index.html になる
    format: 'directory',
  },
});
