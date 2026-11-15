# C. 技術品質（性能・SEO・アクセシビリティ・運用の堅牢さ）第三者レビュー

- レビュー日: 2026-11-15（担当: 技術品質）
- 対象: ローカル配信 http://127.0.0.1:8787/（smoke ビルドの dist。作品 4,096 件、出演者ページ 2,431 件、HTML 8,586 ページ＋/go/ 4,096）と、本番 https://avmeguri.com（ヘッダー・404・ホスト名の確認のみ、3 秒間隔で十数リクエスト）
- 計測条件: Playwright（Chromium）、390×844・DPR3、4G 相当（下り 9Mbps／上り 1.5Mbps／RTT 170ms）、CPU 4 倍減速。ローカルは無圧縮配信なので HTML・JSON の KB は生の大きさ（本番は brotli で約 1/4〜1/5）

## 1. 総評

静的生成で JS が少なく、HTML は軽く、JS 無効でも読める。土台の筋は良い。一方で、公開と運用の「切替」と「規模」に弱点が集まっている。(1) daily.yml の全件再取得は 1 秒 1 件で 60 分の上限を超え、main に入れた初日から毎朝の更新が止まる。(2) daily は noindex・アフィリエイト・GA4 の切替を受け取らず、本公開の切替が人の記憶頼みになっている。(3) 出演者ページの 55%（1,340 件）は作品 1 件の薄いページで、noindex を外す前に閾値で index を絞る必要がある。性能は探索ページ（CLS 0.83、最初の 1 枚まで 5 秒）と見出しフォント（1 ページ 30 件超・約 700KB）を直せば、他のページはほぼ基準内に入る。あわせて、本番の 404・www・ヘッダーを .htaccess のリポジトリ管理にまとめ、inode 上限の対策（/go/ の 1 本化）を早めに決めること。

件数: 重大 3／重要 12／改善 5（計 20）

### 計測値（スマホ幅・4G 相当・ローカル）

| ページ | リクエスト | 転送 計 | HTML | 画像 | フォント | JSON | FCP | LCP | CLS |
|---|---|---|---|---|---|---|---|---|---|
| / | 60 | 1,247KB | 28KB（br 8KB） | 18件 405KB | 37件 726KB | - | 0.54s | 1.48s | 0 |
| /explore/ | 53 | 3,202KB | 40KB | 24件 316KB | 14件 286KB | 6件 2,447KB（br 約 560KB） | 0.56s | **5.80s** | **0.834** |
| /v/125umd01025/ | 69 | 2,837KB | 20KB | 28件 **2,034KB** | 36件 695KB | - | 0.54s | 1.05s | 0.02 |
| /actress/1020685/ | 39 | 796KB | 59KB | 4件 62KB | 30件 587KB | - | 0.55s | 1.37s | 0.003 |
| /new/ | 38 | 651KB | 40KB | 28件 409KB | 5件 114KB | - | 0.54s | **5.30s** | 0 |
| /sale/ | 37 | 686KB | 74KB | 26件 375KB | 6件 149KB | - | 0.53s | 1.77s | 0 |

- 共通: CSS 1 本（21.7KB、gzip 5.3KB）＋ Google Fonts の CSS。JS は events.js（7KB）だけで軽い。作品画像は全ページで width/height 属性なし（ただし `.thumb` の aspect-ratio で枠が確保され、CLS は探索以外ほぼ 0）。
- 探索: 最初のカードが出るまで 5.1 秒（JSON 5 チャンクを **直列に** await）。index.json 123KB は `cache: no-cache` で毎回再検証。
- 本番: HTTP/2・brotli・h3（alt-svc）あり。TTFB はプロキシ越しで 0.6〜1.2 秒（参考値）。
- 規模: dist 244MB、ファイル 12,698＋ディレクトリ 12,691＝**約 2.54 万 inode**（作品 1 件あたり約 6.2）。smoke のビルドは 93 秒、配信 16 秒。

## 2. 指摘一覧

### 重大（公開前に必ず直す）

**C-1 日次更新が 60 分の上限で必ず止まる（--refresh の全件再取得）**
- 場所: .github/workflows/daily.yml「実データを取り込む」、src/data/ingest.ts `refreshExisting`、src/data/api.ts `minIntervalMs = 1000`
- 現象: daily は `--refresh` を上限なしで付けており、active の全作品を 1 件ずつ API で再取得する。API は 1 秒に 1 件なので 4,096 件で約 68 分。これに直近 7 日・人気順・出演者プロフィール最大 1,500 人（約 25 分）が加わる。ジョブの `timeout-minutes: 60` を確実に超える。作品は gone になるまで消えず毎日約 90 件ずつ増えるので、時間は伸びる一方。smoke は `--refresh` なしなので、これまで表面化していない。
- なぜ問題か: daily.yml を main に入れた初日から「取り込み途中で打ち切り → DB の cache 保存も build も deploy も走らない」状態になり、価格・セール・新着が更新されなくなる。
- 直し方の案: `refreshExisting` に `--refresh-limit`（例 1 日 1,500 件、古い取得順に巡回）を付けて日割りにする。セール判定に効く価格はキーワード検索（hits=100）のまとめ取りで更新し、1 件取りは配信終了の確認だけにする。ジョブ内に「経過時間で打ち切って保存する」安全弁も置く。
- 影響度: 高／工数: 中

**C-2 daily.yml が noindex・アフィリエイト・計測の切替を受け取っていない**
- 場所: .github/workflows/daily.yml「サイトをビルドする」（`env:` なし）。smoke.yml だけが `PUBLIC_NOINDEX: '1'` を渡す
- 現象: daily で作った dist は `PUBLIC_NOINDEX`・`AFFILIATE_LINKS`・`PUBLIC_GA4_ID` が未設定でビルドされる。
- なぜ問題か: main に daily.yml を入れて配信用 secrets が揃った朝に、(a) 運営者が意図しない日に noindex が外れる、(b) `/go/` がアフィリエイトでない公式 URL のままになり収益が 0 になる、(c) GA4 が出ず計測できない。本公開の切替が「人の記憶」に頼っている。
- 直し方の案: 3 つを Variables（`vars.PUBLIC_NOINDEX` など）から build ステップに渡し、ステップ要約に「noindex=on/off、affiliate=on/off、GA4=有/無」を必ず出す。check-dist.mjs に「本番配信の dist で AFFILIATE_LINKS=on なのに /go/ の移動先に af_id が無ければ失敗」などの検査を足す。
- 影響度: 高／工数: 小

**C-3 作品 1 件だけの出演者ページ 1,340 件（全体の 55%）が薄く、題名が実態と合わない**
- 場所: /actress/{id}/（スマホ・PC 共通）。例として作品数 1 の出演者ページ
- 現象: 作品数 1 の出演者が 1,338 人、2 件以下が 1,724 人（2,430 人中）。1 件のページでも「〇〇のおすすめ作品ランキング2026」という title・h1 で、「10選」「新着」「全作品」に同じ 1 作品が 3 回並ぶ。本文は約 1,350 字で、ほとんどが共通テンプレ。全件が sitemap に載る。
- なぜ問題か: noindex を外した瞬間に「中身の薄い自動生成ページ」が過半を占め、サイト全体の品質評価（ヘルプフルコンテンツ系の評価）を下げる。「ランキング」と書いて 1 件だけなのは誤認表示でもある。
- 直し方の案: 作品数で段階を分ける。3 件未満は `noindex, follow` にして sitemap から外す（ページ自体は内部リンク用に残す）。title は作品数 10 件以上だけ「おすすめ作品ランキング」、それ未満は「〇〇の出演作品一覧（n 本）」。1〜2 件のページでは 10 選・新着・全作品の重複表示をやめ、1 つの一覧にまとめる。シリーズ（1 件 225）、メーカー（1 件 46）にも同じ閾値を当てる。
- 影響度: 高／工数: 小


### 重要（早めに直す）

**C-4 探索ページの CLS 0.834（スマホ）**
- 場所: /explore/（スマホ）
- 現象: 1.3 秒時点で 0.602、結果の描画時に 0.296 のずれ。原因は `explorer-ui.js` 188 行の `if (window.innerWidth < 960) … d.open = false`。HTML では `<details open>` で描画し、モジュール読み込み後に閉じるため、下の内容が一気に上へ動く。続いて件数表示と「読み込み中」の行が入れ替わる。
- なぜ問題か: Core Web Vitals の基準（0.1 以下）の 8 倍。読み込み中に押そうとした場所が動く。
- 直し方の案: 開閉の初期状態を CSS で決める（スマホでは HTML 側で閉じておき、PC だけ head の小さなインライン JS で `open` を付ける）。結果欄は読み込み中から最終の高さに近い骨組み（カード 6 枚分）を置き、件数行は高さを固定する。
- 影響度: 高／工数: 小

**C-5 見出し用 Web フォントが 1 ページ 30〜37 リクエスト・約 600〜730KB**
- 場所: 全ページの `<head>`（Shippori Mincho B1、wght 500・700、display=swap）
- 現象: 日本語フォントは unicode-range で細かく分割され、見出しに出る文字の数だけ取りに行く。トップで 37 件 726KB と、画像（405KB）より重い。swap なので見出しは後から書体が切り替わる（FOUT）。
- なぜ問題か: 4G の帯域を見出しの装飾に使っている。fonts.gstatic.com が遅いと全ページの見た目がちらつく。
- 直し方の案: Web フォントをやめ、既にある代替（ヒラギノ明朝／游明朝／Noto Serif JP）に任せるのが最も効く。残すならロゴと数字だけに限定し、`&text=` で文字を絞った CSS にする。少なくとも 700 の 1 ウェイトに減らす。
- 影響度: 中／工数: 小

**C-6 探索 JSON の読み込みが直列で、2 万件に耐えない**
- 場所: /explore/（`explorer-core.js` `loadWorks`）、/data/works-*.json・index.json
- 現象: 作品 1 件あたり生 580 バイト（brotli 約 100 バイト）。4,096 件で生 2.38MB・5 チャンク。チャンクは 1 つずつ await。2 万件なら生 約 11.6MB／brotli 約 2MB／20 チャンクの直列取得と全件 JSON.parse・全件ソートになり、低価格の Android で 10 秒超と見込む。index.json（123KB）は出演者名の一覧を含み、出演者数に比例して太る。
- なぜ問題か: 探索は回遊の中心。最初の 1 枚が出るまでが長いと離脱する。
- 直し方の案: (1) チャンクを `Promise.all` で並列にし、1 チャンク目で先に描画する。(2) ジャンル（バイト比 20.6%）・出演者・メーカー・シリーズを文字列から index.json の番号に置き換え、`img`（11.8%）は content_id から組み立てる。これで約 4 割減る。(3) 既定の並びは「直近 90 日」チャンクだけ読み、古い作品は条件を変えたときに読む。(4) 名前の候補は別ファイル（`names.json`）にし、入力が始まってから読む。
- 影響度: 高／工数: 中

**C-7 一覧の 1 枚目が lazy で LCP が 5 秒台（/new/）、作品ページはサンプル画像に 1.6MB**
- 場所: /new/、/explore/（スマホ）、/v/{id}/ の SampleGallery
- 現象: /new/ は 60 枚すべて `loading="lazy"` で、画面内の 1 枚目も遅れて LCP 5.30 秒。作品ページのギャラリーは大きい画像（jp-N.jpg、1 枚約 80KB・533×800）を 20 枚並べ、スクロールすると 2MB。小さい版（-N.jpg）は 1 枚約 5KB。
- なぜ問題か: LCP の基準は 2.5 秒。通信量はスマホ利用のペルソナに直接効く。
- 直し方の案: 一覧・棚の先頭 2〜4 枚は lazy を外し、1 枚目に `fetchpriority="high"`（トップの「今週の1本」は対応済み）。ギャラリーは小さい版を並べ、タップで大きい版を開く（加工にあたらない差し替え）。または最初の 6 枚だけ表示し「すべて見る」で残りを出す。
- 影響度: 中／工数: 小

**C-8 本番の 404 がサーバー既定のページ、www が 200 で二重配信**
- 場所: https://avmeguri.com/存在しないパス/、https://www.avmeguri.com/
- 現象: 404 の本文は LiteSpeed の既定（1,251 バイト、白背景）で、サイトの 404.html（ナビ・PR 帯・noindex あり）が使われていない。www は apex へ転送されず 200（canonical は apex を指すので致命ではない）。dist に `.htaccess` が無く、サーバー側の手置きに頼っている。
- なぜ問題か: 迷った人をサイト内へ戻せない。ホスト名の重複はリンク評価が分散し、計測も割れる。
- 直し方の案: `public/.htaccess` をリポジトリで管理する（`ErrorDocument 404 /404.html`、www→apex と http→https の 301、下の C-9 のヘッダー）。deploy.sh の既定 `DEPLOY_KEEP` から `.htaccess` を外す。
- 影響度: 中／工数: 小

**C-9 セキュリティヘッダーとキャッシュ制御が未設定**
- 場所: 本番の全応答
- 現象: HSTS、X-Content-Type-Options、Referrer-Policy、X-Frame-Options（または CSP の frame-ancestors）が無い。ハッシュ付きの `/_astro/*.css` は `max-age=604800`（7 日）。HTML・JSON・`/explorer/*.js` は Cache-Control なし（Last-Modified だけで、ブラウザの推測キャッシュに任せる）。`/explorer/*.js` はファイル名にハッシュが無い。
- なぜ問題か: JS とデータの形式を変えた日に、古い JS と新しい JSON の組み合わせで探索が壊れる人が出うる。成人向けサイトはクリックジャッキングや埋め込み転用の対象になりやすい。
- 直し方の案: `.htaccess` で `/_astro/` は `max-age=31536000, immutable`、HTML は `no-cache`、`/data/` は `max-age=300`、`/explorer/` は Astro のバンドルに入れてハッシュ化する（当面は `?v=ビルド日時`）。`Strict-Transport-Security: max-age=31536000`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`X-Frame-Options: SAMEORIGIN` を足す。
- 影響度: 中／工数: 小

**C-10 inode とファイル数が 1 年以内に mixhost の上限 20 万に届く**
- 場所: dist の構成、scripts/deploy.sh
- 現象: 今 2.54 万 inode（作品 1 件あたり約 6.2。/v/ と /go/ がそれぞれディレクトリ＋index.html）。作品は 1 日約 90 件ずつ増え、2 万件で約 12.4 万、約 3.8 万件（1 年後）で約 23 万。メール・ログ・バックアップも同じ上限に数えられる。さらにフッターの「データ更新」日時が全ページに入るため、毎日すべての HTML が変わり rsync は全量を送る。
- なぜ問題か: 上限に当たると rsync が途中で失敗し、半分だけ新しいサイトになる。
- 直し方の案: (1) /go/ の 4,096 ファイルを 1 つにまとめる（`.htaccess` の `RewriteRule ^go/([a-z0-9_]+)/$ …` で公式 URL へ 302。アフィリエイト ID は .htaccess に置けるので HTML 不要）。これだけで作品あたり 2 inode 減る。(2) `format: 'file'`（/v/xxx.html）にしてディレクトリを無くす案も検討。(3) 古い作品（例: 配信 3 年以上でレビューなし）はページを作らない方針を決める。(4) 更新日時はフッターでなく /data/meta.json から JS で出すか、トップだけに置く。(5) check-dist.mjs に「ファイル数＋ディレクトリ数」を出し、15 万で警告する。
- 影響度: 高／工数: 中

**C-11 og:image が全 8,586 ページで出ていない**
- 場所: 全ページ（Base.astro の `ogImage` を渡すページが 0）
- 現象: `twitter:card` は `summary_large_image` なのに画像なし。X 投稿（AI 担当範囲）のカードが文字だけになる。
- 直し方の案: 露骨でないサイト共通の OGP 画像（1200×630、ロゴと「PR」）を 1 枚用意し既定にする。作品ジャケットを OGP に使うのは X のセンシティブ判定と規約上の「加工は拡大縮小のみ」を考え、避けるのが無難。
- 影響度: 中／工数: 小

**C-12 軸ページは 60 件で打ち切り、一覧ハブも無い**
- 場所: /genre/{id}/、/maker/{id}/、/series/{id}/、/actress/{id}/（`MAX_WORKS = 60`）
- 現象: 61 件目以降は「探索で見る」（/explore/?g=…、canonical は /explore/）へ送るだけで、静的なページ送りが無い。/actress/・/genre/・/maker/ の一覧ページも無い（出演者への入口はランキングと作品ページのみ）。今は全作品がトップから 7 クリック以内だが、4 件はどこからもリンクされていない。件数が増えると古い作品は「似た作品」の棚以外から辿れなくなる。
- 直し方の案: 軸ページに `/genre/{id}/page/2/` 形式のページ送り（60 件単位、各ページ self canonical）を付ける。`/genre/`・`/maker/`・`/actress/`（五十音・作品数順）の一覧ハブを作り、フッターと探索からリンクする。
- 影響度: 中／工数: 中

**C-13 ジャンル・メーカー・シリーズの title と description が薄い**
- 場所: /genre/{id}/ など
- 現象: title は「名前（ジャンル）｜AVめぐり」（14〜20 字）、description は 35〜40 字の定型、h1 は名前だけ。重複 description は 55 件。
- 直し方の案: 「名前のおすすめ作品・新作一覧（n 本）｜AVめぐり」とし、description に作品数・平均評価・最新の配信日・よく出る出演者数など、ページごとに変わる数値を入れる（自動文の範囲）。
- 影響度: 中／工数: 小

**C-14 年齢確認が背景を閉じ込めない（キーボード・読み上げ）**
- 場所: 全ページの年齢確認（スマホ・PC）
- 現象: `role="dialog" aria-modal="true"` だが、Tab 2 回で背後のヘッダーのリンク・検索欄へフォーカスが抜ける。`main` に inert も aria-hidden も無い。JS 無効では年齢確認が出ず本文が読める（検索エンジンにとっては好都合）。
- 直し方の案: 開いている間は header・main・footer に `inert` を付け、閉じたら外す（数行で済む）。探索の作品モーダルも同じ。JS 無効時の扱いは運営者の判断事項として docs/01 に記録する。
- 影響度: 中／工数: 小

**C-15 /go/ の移動計測が動かない**
- 場所: /go/{id}/（src/pages/go/[id].astro）
- 現象: `window.gtag` を呼ぶが、このページは Base を使わないので gtag.js を読まない。常に未定義で、outbound イベントは一度も送られない。
- 直し方の案: 計測は作品ページの CTA クリック時に `events.js` から `transport_type: 'beacon'` で送る（既に `data-cta` がある）。/go/ 側の呼び出しは消す。
- 影響度: 中／工数: 小


### 改善（余裕があれば）

**C-16 構造化データの追加と sitemap の lastmod**　JSON-LD は作品 CreativeWork（4,096）、出演者 Person＋ItemList（2,431）で形式は妥当。パンくずが HTML にあるので `BreadcrumbList` を足すと検索結果の表示が整う。sitemap は 8,585 URL を 1 ファイルで lastmod なし。作品・軸ページに更新日を入れ、種類ごとに分ける（sitemap-works／-actress）と Search Console で取り込み状況を分けて見られる。影響度 低／工数 小

**C-17 スキップリンクが無い**　全ページでヘッダー（検索欄・ナビ 7 件）を通らないと本文へ行けない。`<a class="skip" href="#main">本文へ</a>` を body の先頭（年齢確認の後）に置く。`main#main` は既にある。影響度 低／工数 小

**C-18 小さなタップ領域**　スマホで高さ 24px 未満の操作要素がトップで 10 個（「もっと見る」系のリンクが高さ 21px）、パンくずのリンクが 25×21px。探索のチェックボックスは 20×20px。`.more` とパンくずに `padding-block: 10px` を足し、チェックボックスはラベル全体を押せる大きさ（高さ 44px）にする。影響度 低／工数 小

**C-19 作品ページの主画像の alt が空**　作品ページのジャケット（主画像）が `alt=""`。カードはすぐ横にタイトルの文字があるので空でよいが、作品ページの主画像は「作品名のパッケージ画像」と入れる。画像が読めないとき（pics.dmm.co.jp の障害、通信の遮断）にも何の枠か分かる。影響度 低／工数 小

**C-20 配信が非原子的**　rsync `--delete` で上書きするため、転送中の数十秒は新旧の HTML・JSON が混ざる（index.json だけ新しく、チャンクは古いなど）。`/data/` のチャンク名に生成日時を入れる（`works-20261115-000.json`）か、新しいディレクトリへ送ってからシンボリックリンクを切り替える。影響度 低／工数 中


## 3. 良い点

- 静的生成＋JS 最小（共通 JS は 7KB だけ）。作品・出演者・新着・セールは JS 無効でも全部読め、HTML は brotli で 6〜16KB。サーバーは HTTP/2・brotli・h3 に対応済み。
- 画像枠を aspect-ratio で先に確保しているので、width/height が無くても探索以外の CLS はほぼ 0。トップの主画像は `fetchpriority="high"`。
- サンプル動画は押すまで iframe を出さない作り。外部プレーヤーの重さと第三者通信を初期表示から外せている。
- /go/ は meta refresh＋JS の二重化、`rel="sponsored nofollow"`、robots.txt の Disallow、sitemap からの除外が一貫している。canonical は全ページで正しく（不一致は 404.html の 1 件だけ。存在しない /404/ を指しているので、404 では canonical を出さないようにする）、title の重複も 2 件だけ。
- 配色のコントラストが良い（本文 15.3:1、弱い補足 #968770 でも 5.4:1、CTA 8.1:1）。フォーカスリングが全要素に出る。モバイルメニューは aria-expanded の同期と Esc 対応がある。check-dist.mjs でリンク切れ・値漏れ・rel を毎回検査している。

## 4. 運営者の要望 1〜3 への見解

**要望 1（「今週の1本」を複数の自動スライドに）**　技術的には賛成。ただし作り方で CLS・LCP・アクセシビリティが崩れやすいので条件を付ける。
- ライブラリは使わず、CSS の `scroll-snap-type: x mandatory` の横並びにする。枠は今の `.thumb.wide`（3:2）のまま高さを固定する。
- 1 枚目だけ `fetchpriority="high"`・eager、2 枚目以降は lazy。枚数は 5 枚まで（ジャケット 1 枚 約 190KB なので、5 枚で約 1MB。スマホで 2 枚目以降を先読みしない）。
- 自動送りは 6 秒以上の間隔。タッチ・ホバー・フォーカス中と `prefers-reduced-motion: reduce` では止め、一時停止ボタンを付ける（WCAG 2.2.2）。各スライドは `role="group" aria-roledescription="スライド" aria-label="1 / 5"`、前後ボタンとドットはどちらも 44px 以上。
- 中身はビルド時に決める（高評価×新しさで 5 件）。JS 無効なら横スクロールの一覧として読める。

**要望 2（探索の「重み」が分かりにくい）**　見せ方は他の担当に任せ、技術面から 2 点。
- 「重み」は内部の値のまま残し、画面は「おすすめ順／新しい順／高評価順／安い順／長い順」のプリセットにする。URL は `?sort=rating` のように短くでき、共有・計測もしやすい。スライダーは「詳しく調整」に畳む。
- 体感を一番悪くしているのは概念より待ち時間とずれ（C-4 の CLS 0.83、C-6 の最初の 1 枚まで 5.1 秒）。こちらを先に直すと、操作の分かりにくさの評価も変わるはず。

**要望 3（新着で項目を選びたい）**　2 段構えを勧める。
- すぐできる: /new/ の各カードに `data-g`（ジャンル番号）を付け、上部のチップ（作品数の多い上位 8〜10 ジャンル）で表示を切り替える。2.4MB の探索 JSON は読まない。チップの状態は `?g=` で URL に残す。
- 検索流入を狙うなら: 作品数が十分な上位ジャンルだけ `/new/genre/{id}/` の静的ページを作る（「ジャンル名 新作」の検索に対応）。作品数 10 件未満の組み合わせは作らない（C-3 と同じ考え方。薄いページを増やさない）。inode が増えるので C-10 と合わせて上限を決める。

## 5. 確認方法

スクリプトはレビュアーの作業用に /tmp/claude-0/-home-user-site-project/4f1d7da2-620a-507d-b275-e31a2336b628/scratchpad/pw/（perf.js、explore.js、a11y.js、gate.js）に置いた。リポジトリには入れていない（一時領域なので消えることがある）。要点は次のとおり。

```bash
# 0) ローカル配信（smoke の artifact を展開して配信）
gh run download <run_id> -n dist-smoke -D live-dist/dist
(cd live-dist/dist && python3 -m http.server 8787 --bind 127.0.0.1)

# 1) 性能（Playwright。プロキシ環境では Chromium に --proxy-server と --proxy-bypass-list=127.0.0.1:8787 を渡す）
#    viewport 390x844・isMobile、CDP の Network.emulateNetworkConditions {latency:170, download:9e6/8, upload:1.5e6/8}、
#    Emulation.setCPUThrottlingRate {rate:4}。LCP と CLS は PerformanceObserver（buffered）、
#    リクエスト数とバイト数は Network.responseReceived / loadingFinished の encodedDataLength を種類別に合計。
node perf.js http://127.0.0.1:8787 / /explore/ /v/125umd01025/ /actress/1020685/ /new/ /sale/
#    探索の CLS の原因は layout-shift エントリの sources（DETAILS 要素）で特定。最初のカードまでの時間は
#    page.waitForFunction(() => document.querySelectorAll('main a[href^="/v/"]').length > 0)
node explore.js

# 2) JSON の大きさと項目別の比率
for f in dist/data/*.json; do echo "$f $(stat -c%s $f) gz=$(gzip -9c $f | wc -c)"; done
#    Python で works-*.json を読み、キーごとの json.dumps の長さを合計して比率を出す

# 3) SEO（dist を走査）: title・description の重複、canonical と実パスの一致、og:image の有無、JSON-LD の @type、
#    軸ごとの作品数分布（works-*.json の a/m/s/g を数える）、内部リンクのグラフ（main 内外の href="/…"）から
#    被リンク 0 の作品とトップからのクリック深さ（幅優先探索）
grep -o '<loc>' dist/sitemap-0.xml | wc -l ; grep -c '<lastmod>' dist/sitemap-0.xml

# 4) アクセシビリティ（自前の Playwright チェック）: 見出しの並び、ランドマーク数、alt の空と欠落、
#    getBoundingClientRect で 24px・44px 未満の操作要素、Tab を 6 回押して :focus-visible の outline の有無、
#    年齢確認を開いた状態で Tab を押し document.activeElement が #age-gate の外に出るか、javaScriptEnabled:false での表示。
#    コントラストは tokens.css の色を WCAG の相対輝度の式で計算。

# 5) 本番（3 秒間隔）
curl -sS -o /dev/null -D - --compressed -H 'Accept-Encoding: br, gzip' https://avmeguri.com/ -w 'http=%{http_version} ttfb=%{time_starttransfer}\n'
#    同様に /_astro/Base.*.css、/data/works-000.json、/explorer/explorer-ui.js、/no-such-page-xyz/（404 本文の大きさ）、
#    https://www.avmeguri.com/（転送の有無）、/new（末尾スラッシュなしの 301）。http:// はこの環境のプロキシが通さないため未確認。

# 6) 運用: smoke の各ステップ時間
gh run view <run_id> --json jobs   # 取り込み 116 秒、ビルド 93 秒、配信 16 秒
#    inode = find dist -type f | wc -l ＋ find dist -type d | wc -l
#    daily の所要時間の見積もりは src/data/ingest.ts の refreshExisting（1 件ずつ）× api.ts の minIntervalMs=1000
```
