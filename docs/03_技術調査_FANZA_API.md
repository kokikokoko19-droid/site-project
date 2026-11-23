# 技術調査: FANZA（DMM Web Service）API v3

調査日: 2026-11-01。公式リファレンス（affiliate.dmm.com/api/v3/）は国外IPから地域制限で閲覧できず、第三者の公開ライブラリと技術記事から復元した。**すべて公式で要確認**。「一致」は独立した複数資料で一致、「単一」は1資料のみ。

## 1. エンドポイントとパラメータ
- `GET https://api.dmm.com/affiliate/v3/{ItemList|FloorList|ActressSearch|GenreSearch|MakerSearch|SeriesSearch|AuthorSearch}`（一致）。
- 共通: `api_id`, `affiliate_id`, `output=json|xml`, `callback`（JSONP）。
- ItemList: `hits`（既定20、最大100）, `offset`（既定1、最大50000、1始まり）, `sort`=`rank`(既定)|`price`|`-price`|`date`|`review`|`match`, `article`=`actress|author|genre|series|maker` と `article_id`（複数は `article[0]=..&article[1]=..`）, `gte_date`/`lte_date`=`2016-04-01T00:00:00` 形式, `cid`=content_id, `keyword`。
- 動画の指定: `site=FANZA&service=digital&floor=videoa`（一致）。FloorList 上の floor_id は 43（videoc=44, nikkatsu=45, anime=46, vr=91 は参考値）。

## 2. ItemList レスポンス
外枠: `{"request":{"parameters":{入力のエコー}},"result":{status,result_count,total_count,first_position,items[]}}`。
**注意: `request.parameters` に api_id と affiliate_id が平文で入る。生応答を保存・ログ出力しない。**

| 項目 | 型 | 内容 | 欠損 | 根拠 |
|---|---|---|---|---|
| content_id, product_id, title, URL, service_*, floor_*, category_name | 文字列 | content_id が作品キー（=cid）。videoa では product_id=content_id | ほぼ常在 | 一致 |
| volume | 文字列 | 分数（"120"）。素人系は "1:29:00" 形式の例あり | 任意 | 複数 |
| review | {count:int, average:文字列} | average は "4.84" のような文字列 | 任意 | 一致 |
| affiliateURL | 文字列 | `https://al.fanza.co.jp/?lurl=<URLエンコード>&af_id=<リクエストのID>&ch=api` | 基本あり | 単一 |
| imageURL | {list, small, large} | `pics.dmm.co.jp/digital/video/<cid>/<cid>pt|ps|pl.jpg`。素人系は命名が異なるため **URLを組み立てずAPI値を使う** | 任意 | 一致 |
| sampleImageURL | {sample_s, sample_l:{image[]}} | 枚数は作品ごと。sample_l が無い例あり | 任意 | 複数 |
| sampleMovieURL | {size_476_306, size_560_360, size_644_414, size_720_480, pc_flag, sp_flag} | mp4ではなく公式プレーヤー（litevideo）のURL。詳細は docs/05 | 作品により無し | キー一致、URL形式は単一 |
| prices | {price, list_price, deliveries.delivery[{type, price, list_price}]} | price は "500~" のような文字列。type: 4k, hd, download, stream, iosdl, androiddl | list_price/deliveries は任意 | 複数 |
| date | "YYYY-MM-DD HH:MM:SS" | 配信開始。タイムゾーン不明 | 任意 | 単一 |
| iteminfo | genre/maker/label/series/director/actress: [{id:int, name}] | actress, director は ruby 付き。キー単位で欠落あり（素人系に actress 無し等） | 任意 | 一致 |
| campaign | [{date_begin, date_end, title}] | セール情報。無ければキーごと無い | 任意 | 複数 |

動画では返らないとされる項目: number, jancode, maker_product, isbn, stock, directory, cdinfo, tachiyomi。旧資料のみ: URLsp, affiliateURLsp, **comment（紹介文相当の疑い。保存・表示しない）**。

## 3. 補助API
- FloorList: 引数なし。`site[].service[].floor[] = {id(文字列), name, code}`。
- ActressSearch: `hits` 20/最大100、`initial`、`actress_id`、`keyword`、寸法と誕生日の範囲、`sort`。応答: id(文字列), name, ruby, bust/cup/waist/hip/height, birthday, blood_type, hobby, prefectures, imageURL（**顔写真。使用しない**）, listURL{digital, monthly, mono}。null や "" やキー欠落が多い。
- Genre/Maker/Series/AuthorSearch: `floor_id` 必須、`hits` 既定100/最大500、`initial` はひらがな。応答は共通ヘッダ＋ `genre[]{genre_id, name, ruby, list_url}` 等。

## 4. 制限
- hits 上限: ItemList と Actress は100、他4APIは500。offset 上限: ItemList 50000（一致）。
- 不正な値は HTTP 400 系。認証なしは `400 BAD REQUEST`。
- レート制限: 「一定時間内の回数制限あり、超過でエラー、待てば復旧」（公式ヘルプ）。数値は非公開。cid 単位で約6,000件を1秒間隔で取得した実装例あり。

## 5. 実装上の注意
- 全件取得は offset を hits ずつ進める。offset 上限 50000 のため、`gte_date`/`lte_date` の期間窓と `sort=date` で分割し、窓ごとに total_count<50000 を確認、content_id で重複排除。
- affiliateURL のドメインは FANZA=al.fanza.co.jp。af_id はリクエストの ID がそのまま入る。API用IDは末尾990〜999、リンク用は末尾001（公式ヘルプ）。**API用IDの入ったURLを公開してよいか、サイト用IDへ差し替えるべきかは要確認。**
- 型のゆらぎ: status は ItemList=int、他=文字列。id は iteminfo=int、FloorList/Actress=文字列。average・price は文字列。取り込み層で正規化する。
- 0件・範囲外は HTTP 200 で items キーが欠落し得る。
- 売上本数・お気に入り数の項目は無い。
- 第三者ライブラリにある「詳細ページのHTML解析（説明文・mp4取得）」はAPI外で規約方針に反するため採用しない。
- 実応答は露骨な語を含み得るため、テストデータは合成で作る。

## 6. 公式で要確認（docs/01 に転記）
1. 各項目の型と必須/任意（review, sampleMovieURL, sample_l, campaign, affiliateURL, iteminfo）。
2. date の書式とタイムゾーン、gte/lte_date の境界、sort=date の向き、offset>50000 の挙動。
3. レート制限の数値、超過時のHTTPコード、復旧時間。
4. データ保存・キャッシュの可否、クレジット表示の要否と文言。
5. 画像・sampleMovieURL の利用範囲。iframe 利用が「公式の埋め込みツール」と同等か。
6. API用ID入り affiliateURL の公開可否と、リンク用IDへの差し替え可否（報酬計上との関係）。
7. 海外IP（GitHub Actions 等）から api.dmm.com を呼べるか。

出典: py-dmmjp（PyPI、docs と tests）, dmm-api（docs.rs）, DMMcomLabo/dmm-go-sdk, dmm-search3（PyPI）, takelushi/dmm-api-py, mgmyst/dmm-web-service-api-reference, support.dmm.com/affiliate/article/47548・44077・44088, Qiita の実装記事2本。
