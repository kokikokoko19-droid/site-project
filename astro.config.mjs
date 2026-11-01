// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// 静的サイト生成の設定（設計方針 9章）。
// site はホストとドメインが決まるまで仮の値。.invalid は予約済みで実在しないドメイン。
// 確定したら本番のURLに差し替える（canonical や sitemap に使われる。public/robots.txt の Sitemap 行も合わせる）。
export default defineConfig({
  output: 'static',
  site: 'https://example.invalid',
  // URL は末尾スラッシュ付きで統一する（設計方針 2.1 のURL表と同じ形）
  trailingSlash: 'always',
  build: {
    // /about/ は dist/about/index.html、トップは dist/index.html になる
    format: 'directory',
  },
  integrations: [
    sitemap({
      // 中継ページ（/go/）はサイトマップに載せない。noindex・robots.txt の Disallow と揃える。
      // page は https://… から始まる完全なURL。パスの先頭が /go/ のものだけを外す。
      filter: (page) => !new URL(page).pathname.startsWith('/go/'),
    }),
  ],
});
