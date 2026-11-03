# 公式確認: DMM Web サービス（規約・クレジット・API・料率）

確認日: 2026-11-03。運営者が日本の回線で保存した公式ページ5本（規約、クレジット表示、商品情報API、女優検索API、FANZA報酬料率）を PDF からテキスト化して照合した。引用は原文のまま（「」内）。それ以外は要約。公式表に型の列は無いため、型は「記載なし」とし、例の値からの推測は書かない。規約の改定は2026年09月01日。

## 1. 利用規約
規約は第1条3項で「本規約以外のヘルプ、ガイドページも本規約の一部を構成する」とする。ヘルプ・ガイドと「DMMアフィリエイト参加規約」（第3条）は今回未入手。以下は本文のみの判定。

**保存・キャッシュ・蓄積・複製**: 本文に「保存」「キャッシュ」「蓄積」の語は無い。関連するのは次の条文。
- 1条2項「当社が保有する商品またはサービスの情報（商品名、ＵＲＬ、画像、商品説明、価格に関する情報を含むがこれに限られません。以下、「商品情報」といいます）」
- 7条2項「ウェブサービスの使用につき別途定める内容の制約（アプリケーションの利用範囲・仕様、アクセス回数、アクセス時間、情報更新の頻度、アクセスに関する表示、送信データの容量および特定の情報の記載を含むがこれに限られません）をすることができる」
- 9条1項(3)「ウェブサービスを通じて提供されるプログラムを複製、改変、逆アセンブル、逆コンパイル、リバース・エンジニアリングをすること」（対象は「プログラム」。データの複製は対象外と読める）

**第三者提供・共有**:
- 9条1項(8)「不特定または多数人と情報を共有することを可能にする場所にウェブサービスを通じて得た情報またはアプリケーションを保管すること」
- 9条1項(7)「ウェブサービスおよびアプリケーションを通じて得た情報（商品情報、ユーザの情報を含むがこれに限られない）に関し、当社が別途定める目的以外に使用すること」
- 6条2項「ウェブサービスにかかる知的財産権を第三者に譲渡、賃貸、サブライセンスその他の処分をしてはならない」

**商用利用・収入**:
- 8条2項「アプリケーションを制作するにあたり、本プログラムのリンクを設置しなければならない」
- 9条1項(4)「ウェブサービスの使用によって本プログラム以外の方法で収入を得ること（当社が明示的に許可した場合を除く）」
- 9条1項(5)「商品またはサービスについての情報を、本プログラム以外のアフィリエイトプログラムで利用すること（当社が明示的に許可した場合を除く）」
- 9条1項(6)「当社と競合しまたは競合するおそれのあるサービスを提供すること」

**その他の禁止**: 9条1項(1)に「当社との提携関係を表示しまたは暗示する内容」「閲覧者に誤解を与えるおそれのある、または目的とする内容」。9条1項(9)「特定の人のみがアクセスできる環境でウェブサービスを使用すること」（会員限定サイトは不可）。8条5項で DMM がクロール等で監視することに同意する。

**契約解除・停止**:
- 7条3項「直ちに第１項に定める使用許諾を取り消すことができる」
- 13条「理由に拘わらず、…いつでもウェブサービスの提供またはアプリケーションからの当社及び株式会社デジタルコマースが運営するウェブサイトへのアクセスを中断または終了することができる」
- 15条3項「事前に通知することなく」「アプリケーションからのリンク拒否」「ウェブサービス提供の全部または一部の中止」「APIIDの停止または削除」
- 12条「ウェブサービスの仕様の全部または一部をいつでも変更することができる」

### 私たちの方針の判定
| 方針 | 判定 | 根拠 |
|---|---|---|
| 正規化済み項目をDBに保存し毎日更新 | 条件付き | 保存を禁じる条文は無い。保管先が9(8)に当たらないこと（非公開）と、7(2)の「情報更新の頻度」「アクセス回数」の別途制限（ヘルプ側）に従うことが条件 |
| 生応答を保存しない | 可 | 規約上の要件ではない。応答に API ID が入るため安全側の運用として維持 |
| 画像は直リンク | 規約本文に記載なし | 根拠は docs/01 の確認済み（公式ヘルプ）。本文は「画像」を商品情報に含める（1条2項）のみ |
| 公開サイトに作品情報を表示 | 可 | アプリケーションの想定用途。8(2)のリンク、11条のクレジットが条件 |
| 公開リポジトリ・公開ページにDB・全件データを置く | 不可 | 9(8)。docs/01 #22（public/private 未決）は private にする必要がある。サイトで全件ダンプのJSONを配ることも避ける |
| 他の広告（AdSlot に実広告を置く） | 不可（許可がない限り） | 9(4)。許可を得るまで空スロットのまま |
| 取得情報を別のアフィリエイトに流用 | 不可 | 9(5) |

## 2. クレジット表示
原文: 「DMM Webサービスから提供されたAPIを利用して制作されたサイトやアプリケーションには、以下のクレジットを表示してください。」「クレジットを表示する場合は、既定のHTMLソースを利用してください。表示規定が守られなかった場合、HTMLや画像に改変が行われた場合などには、DMM Webサービスが提供するAPIの利用を停止させていただく可能性があります。」位置: 「クレジットの種類を問わず、表示位置は自由ですが、そのアプリケーションやサイトがDMM Webサービスを利用し制作されていることがわかる方法で表示してください。」

FANZA 用の既定ソース（原文）:
- テキスト: `Powered by <a href="https://affiliate.dmm.com/api/">FANZA Webサービス</a>`
- 画像 135×17: `<a href="https://affiliate.dmm.com/api/"><img src="https://p.dmm.co.jp/p/affiliate/web_service/r18_135_17.gif" width="135" height="17" alt="WEB SERVICE BY FANZA" /></a>`
- 画像 88×35: 同じ形式で `r18_88_35.gif`、width="88" height="35"。

**フッターに入れる HTML（Base.astro の TODO の置換先）**: テキスト形式を、改変せずそのまま入れる。
```html
<p>Powered by <a href="https://affiliate.dmm.com/api/">FANZA Webサービス</a></p>
```
既存の「画像・動画はDMM.comの提供」は提携の暗示（9(1)）になり得るため、運営者が文言を判断する。

## 3. 商品情報API（ItemList）
`https://api.dmm.com/affiliate/v3/ItemList?...`

### リクエストパラメータ
| 物理名 | 必須 | 取り得る値・概要 |
|---|---|---|
| api_id | ○ | 登録時のID |
| affiliate_id | ○ | 「登録時に割り振られた990～999までのアフィリエイトID」 |
| site | ○ | 「一般（DMM.com）かアダルト（FANZA）か」。例は FANZA |
| service, floor | 任意 | フロアAPIのコード。例 digital, videoa |
| hits | 任意 | 初期値20、最大100 |
| offset | 任意 | 初期値1、最大50000 |
| sort | 任意 | rank（初期値）, price, -price, date, review, match |
| keyword | 任意 | UTF-8 |
| cid | 任意 | content_id |
| article | 任意 | actress, author, genre, series, maker。複数は `article[0]=genre&article[1]=actress` |
| article_id | 任意 | 上記のID。複数は `article_id[0]=..&article_id[1]=..` |
| gte_date, lte_date | 任意 | ISO8601。例 `2016-04-01T00:00:00`、`2016-04-30T23:59:59`。「タイムゾーンは指定できません」 |
| mono_stock | 任意 | stock, reserve, reserve_empty, mono（通販のみ） |
| output, callback | 任意 | json / xml、JSONP のコールバック名 |

### レスポンス項目
result: status, result_count, total_count, first_position, items。items: service_code, service_name, floor_code, floor_name, category_name, content_id, product_id, title, volume（収録時間 or ページ数）, number（巻数）, review{count, average}, URL, affiliateURL, imageURL{list, small, large}, tachiyomi{URL, affilaiteURL}, sampleImageURL{sample_s.image, sample_l.image}, sampleMovieURL{size_476_306, size_560_360, size_644_414, size_720_480, pc_flag, sp_flag}, prices{price, list_price, deliveries.delivery{type, price}}, date, iteminfo{genre, series, maker, actor, actress, director, author, label, type, color, size（各 name と id）}, cdinfo{kind, jancode, isbn, stock, directory{id, name}}, campaign{date_begin, date_end, title}。

### docs/03・05 との差分
| 項目 | docs/03 の推定 | 公式 | 影響 |
|---|---|---|---|
| sampleMovieURL の形式 | 実装は https 前提。docs/05 は `https://www.dmm.co.jp/litevideo/-/part/=/affi_id=…/cid=…/size=…/` | 例は `http://www.dmm.co.jp/litevideo/-/part/=/cid=15dss145/size=476_306/affi_id=affiliate-990/`（http、順序は cid, size, affi_id）。例の cid は content_id（15dss00145）と表記が異なる | SampleMovie.astro は https 以外を捨てる |
| comment, URLsp, affiliateURLsp | 旧資料のみ | 公式表に無い | 読み捨てのまま問題なし |
| date | `YYYY-MM-DD HH:MM:SS` | 例は `2012/8/3 10:00`（タイムゾーン記載なし） | normalize は両形式対応済み |
| gte_date | `…T00:00:00` | 同じ（タイムゾーン不可） | 変更なし |
| sort, offset | 6値、上限50000 | 一致。初期値は rank、offset 初期値1 | 変更なし |
| article | 5値 | 一致 | 変更なし |
| iteminfo の ruby | actress, director は ruby 付き | 表に ruby 無し。actor, author, type, color, size が追加 | normalize は ruby があれば保持するだけで無害 |
| prices.deliveries | delivery に list_price | 表は type と price のみ | 影響小 |
| price の表記 | `500~` | 例は `300～`（全角チルダ） | toNum は先頭の数値を取るので影響なし |
| number, tachiyomi | 動画では返らないとされた | 表にあり（動画で返るかは不明） | 読まないので影響なし |
| campaign の階層 | 項目直下 | 字下げ上は cdinfo 直下にも読め、判読不可 | 実応答で確認 |
| 型 | 文字列・整数の混在を推定 | 公式表に型の列なし。サンプルJSONの status は 200（数値） | 取り込み層の正規化を維持 |

## 4. 女優検索API（ActressSearch）
### パラメータ
api_id ○, affiliate_id ○（990～999）, initial（50音をUTF-8で指定）, **actress_id**（女優ID）, keyword, gte/lte_bust, gte/lte_waist, gte/lte_hip, gte/lte_height（「バスト90cm以上」等、cm）, gte/lte_birthday（表の物理名は `gte_birshday` と誤記。説明は「yyyymmddの形式で指定」だが例は `1990-01-01` で、形式は判読不可・矛盾）, hits（初期20、最大100）, offset（初期値1。最大の記載なし）, sort（name, -name, bust, -bust, waist, -waist, hip, -hip, height, -height, birthday, -birthday, id, -id。初期値の記載なし）, output, callback。

### レスポンス項目
result: status, result_count, total_count, first_position, actress{id, name, ruby, bust, cup, waist, hip, height, birthday（例 1987-03-24）, blood_type, hobby, prefectures, imageURL{small, large}, listURL{digital, monthly, mono}}。

### 差分
- actress_id で絞れる。ingest-actress.ts の仮定は正しい。
- imageURL は存在する（pics.dmm.co.jp/mono/actjpgs/…）。顔写真なので使わない方針のまま。
- ingest-actress.ts が読む項目名（id, name, ruby, birthday, blood_type, hobby, prefectures, height, bust, waist, hip, cup, listURL）は公式と全て一致。
- サンプルJSONは status が `"200"`（文字列）、total_count が `"20"`（文字列）で、リクエストのエコーに `bust` `waist` と実在しないパラメータ名が出る。例の不整合として扱う。
- listURL の例で、digital は `af_id=affiliate-990`、monthly と mono は `af_id=affiliate-001`。実応答での確認が必要。

## 5. 報酬料率（FANZA）
「DMMアフィリエイトの各料率は変更となる場合があります。」「サービス新規」はグループ共通の欄として印字されている。表の「A → B」は印字のまま（矢印の意味は取得したテキストに説明が無く、判読不可。報酬UPの表示と思われるが未確認）。
| サービス | サービス新規 | ダイレクト報酬 | カテゴリ報酬 |
|---|---|---|---|
| 動画（アダルトビデオ・素人・成人映画・アニメの単品動画） | 1,050円（税抜955円）→ 2,100円（税抜1,909円） | 35％ → 70％ | 10％ → 20％ |
| 月額動画（見放題ch デラックス、VRch、見放題ch） | 同上 | 35％ → 70％ | 10％ → 20％ |
| 同人 | 1,050円 → 1,800円（税抜1,637円） | 20％ → 35％ | 10％ → 17％ |
| FANZAブックス／読み放題 | 1,050円／2,000円（税抜1,819円） | 35％ → 70％ | 10％ → 18％ |
| アダルトPCゲーム／GAME 遊び放題 | --- | 8％／35％ | 8％／8％ |
| 通販（DVD、ブック等／おもちゃ） | --- | 10％／20％ | 3％／15％ |
| FANZA TV 新規無料登録／TV Plus 初回登録 | 2,200円→2,750円／2,200円（対応は字下げからの推定） | --- | --- |

新規入会報酬: あり（FANZA TV の新規無料登録 2,200円→2,750円、月額・動画は「サービス新規」欄の定額）。ダイレクト報酬とカテゴリ報酬の定義は「説明はこちらから」の先にあり未取得。「上記以外のサービスはアフィリエイト対象外」。
