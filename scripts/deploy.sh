#!/usr/bin/env bash
# dist/ を mixhost などの共用サーバーへ rsync over SSH で同期する。
#
# 使い方:
#   scripts/deploy.sh --dry-run   転送内容だけ表示する（何も書き換えない）
#   scripts/deploy.sh             本番へ転送する
#
# 環境変数（値はログやコミットに出さない）:
#   DEPLOY_HOST       必須。接続先のホスト名
#   DEPLOY_USER       必須。SSH のユーザー名
#   DEPLOY_PATH       必須。サーバー側の公開ディレクトリ（絶対パス）
#   DEPLOY_KEY_FILE   必須。SSH 秘密鍵のファイルパス
#   DEPLOY_PORT       任意。SSH のポート（既定 22）
#   DEPLOY_KEEP       任意。--delete で消さないもの（カンマ区切り。既定 .htaccess,.well-known）
#   DEPLOY_CHECK_URL  任意。転送後に確認する URL。200 以外なら終了コード 1
#   DIST_DIR          任意。転送元（既定 dist）
#
# 終了コード: 0 成功 / 1 転送または確認の失敗 / 2 設定不足・使い方の誤り
set -euo pipefail

dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -h|--help)
      sed -n '2,19p' "$0"
      exit 0
      ;;
    *)
      echo "不明な引数: $arg（使えるのは --dry-run のみ）" >&2
      exit 2
      ;;
  esac
done

# 必須変数の確認。値は表示せず、名前だけ出す。
missing=()
for name in DEPLOY_HOST DEPLOY_USER DEPLOY_PATH DEPLOY_KEY_FILE; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "必須の環境変数が設定されていません: ${missing[*]}" >&2
  exit 2
fi

port="${DEPLOY_PORT:-22}"
keep="${DEPLOY_KEEP:-.htaccess,.well-known}"
dist_dir="${DIST_DIR:-dist}"

for cmd in rsync ssh; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "$cmd が見つかりません。インストールしてから再実行してください。" >&2
    exit 2
  fi
done

if [ ! -d "$dist_dir" ]; then
  echo "転送元のディレクトリがありません: $dist_dir（先に npm run build を実行してください）" >&2
  exit 2
fi

if [ ! -f "$DEPLOY_KEY_FILE" ]; then
  echo "秘密鍵のファイルがありません: $DEPLOY_KEY_FILE" >&2
  exit 2
fi

# 保護するもの。--exclude で転送から外し、--filter 'P ...' で --delete の対象からも外す。
# 先頭に / を付けて、転送のルート直下のものだけに限る。
protect_args=()
IFS=',' read -r -a keep_items <<< "$keep"
for item in "${keep_items[@]}"; do
  # 前後の空白を除き、先頭と末尾の / も除く
  item="${item#"${item%%[![:space:]]*}"}"
  item="${item%"${item##*[![:space:]]}"}"
  item="${item#/}"
  item="${item%/}"
  [ -z "$item" ] && continue
  protect_args+=(--exclude "/$item" --filter "P /$item")
done

# 初回の接続で host key を確認しない設定にはしない。known_hosts に登録済みであることが前提。
ssh_cmd="ssh -i $DEPLOY_KEY_FILE -p $port -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes"

rsync_args=(-rlptz --omit-dir-times --delete --human-readable --itemize-changes)
if [ "$dry_run" -eq 1 ]; then
  rsync_args+=(--dry-run)
  echo "--dry-run: 転送内容だけ表示します。何も書き換えません。"
fi

# 転送先の末尾のスラッシュは揃える（中身を同期するため）
dest="${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH%/}/"

echo "転送元: ${dist_dir%/}/"
echo "転送先: ${DEPLOY_HOST}（ポート ${port}）の公開ディレクトリ"
echo "消さないもの: $keep"

rsync "${rsync_args[@]}" "${protect_args[@]}" -e "$ssh_cmd" "${dist_dir%/}/" "$dest"

if [ "$dry_run" -eq 1 ]; then
  echo "--dry-run のため、確認の URL は呼びません。"
  exit 0
fi

# 転送後の確認（任意）。200 以外なら失敗にする。
if [ -n "${DEPLOY_CHECK_URL:-}" ]; then
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$DEPLOY_CHECK_URL" || true)"
  echo "確認 URL の応答: $status"
  if [ "$status" != "200" ]; then
    echo "確認 URL が 200 ではありません（$status）。配信の結果を確認してください。" >&2
    exit 1
  fi
fi

echo "配信が完了しました。"
