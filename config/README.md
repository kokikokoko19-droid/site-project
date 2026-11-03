# config

## follow.json（指定軸の取り込み）

指定した出演者・シリーズ・メーカーの全作品を取り込むための設定。`ingest --follow` が読む。

```json
{
  "actresses": [{ "id": "1234", "name": "出演者A" }],
  "series":    [{ "id": "5678", "name": "シリーズB" }],
  "makers":    [{ "id": "9012", "name": "メーカーC" }]
}
```

- `id`: 取り込みに使う ID（文字列。数字のみ）。
- `name`: メモ用。取り込みには使わない（省略可）。
- 空の配列のままなら何もしない。ファイルがなくても空設定として扱う。
- 形式が不正（配列でない、id がない等）なときはエラーで止まる。

### id の調べ方

- 軸ページの URL `/actress/{id}/`（シリーズは `/series/{id}/`、メーカーは `/maker/{id}/`）の数字。
- または、探索ページに表示される ID。

## blocklist.json（除外リスト・取り下げ対応）

DMM からの取り下げ依頼などで、サイトに出さない作品・出演者を指定する。`export` が読み、該当作品を全ての出力（`works.json`、`works-NNN.json`、`meta.json` の rankings・todays、`actresses.json`）から除く。DB の作品データは消さない。

```json
{
  "contentIds": ["abc00001", { "id": "abc00002", "note": "2026-11 取り下げ依頼" }],
  "actressIds": [{ "id": "1234", "note": "本人の依頼" }],
  "reason": "依頼の経緯（メモ用）"
}
```

- `contentIds`: 作品の `content_id`。
- `actressIds`: 出演者の ID。指定すると、その出演者が出る作品がすべて除外される。
- 要素は `"id"` の文字列でも、`{ "id": "...", "note": "..." }` でもよい（`note` と `reason` はメモ用で、動作には使わない）。
- ファイルがなければ空として扱う。形式が不正なときは export がエラーで止まる。
- 追記したら `npm run export` と `npm run build` をやり直して配信する（`docs/07_運用手順.md` の 9 章）。

## 環境変数 FANZA_MAX_OFFSET（offset の上限）

API の `offset` の上限（既定 5000。2026年12月ごろの公式変更に合わせた値）。取り込みの窓分割・打ち切りと、API 呼び出しの引数検証が同じ値を使う。旧仕様（50000）で動かすときだけ指定する。
