#!/bin/bash
# 必要なOllamaモデルを、未取得のものだけ取得する（docker-compose.ymlのollama-initが実行する）。
#
# 「初回だけネットに繋ぎ、以降はオフライン」を成立させるため、取得済みのモデルは
# pullしない（オフラインで再起動したときに、レジストリへの問い合わせで失敗しないように）。
# 1つでも取得できなかったら、理由を表示して非0で終了する。これによりocr-rag・appは起動せず、
# `docker compose up` が失敗として見える（モデルが無いまま起動して、OCR実行時に初めて壊れるのを防ぐ）。
#
# 環境変数:
#   OLLAMA_HOST          Ollamaの場所（ollamaコマンドが使う。例: http://ollama:11434）
#   REQUIRED_MODELS      必要なモデルを空白で区切った一覧（例: "bge-m3 glm-ocr qwen3.5:9b"）
#   OLLAMA_WAIT_SECONDS  Ollamaの起動を待つ上限秒数（既定 120）
#   REGISTRY_CHECK_SECONDS  取得前に、レジストリへ接続できるかを確認する上限秒数（既定 10）
#
# 注意: 一覧の変数名を OLLAMA_MODELS にしないこと（Ollama自身が「モデルの保存先」として使う変数名）。

# pipefail: pullの出力を整形するパイプラインでも、pull自体の失敗を見逃さない
set -u -o pipefail

WAIT_SECONDS="${OLLAMA_WAIT_SECONDS:-120}"

if [ -z "${REQUIRED_MODELS:-}" ]; then
  echo "[ollama-init] エラー: 環境変数 REQUIRED_MODELS（必要なモデルの一覧）が設定されていません。" >&2
  exit 2
fi

# タグ省略のモデル名は、Ollamaでは :latest として扱われる
normalize() {
  case "$1" in
    *:*) echo "$1" ;;
    *) echo "$1:latest" ;;
  esac
}

# 取得済みのモデル名（NAME列）を1行ずつ出す。Ollamaに接続できなければ失敗する
installed_models() {
  ollama list | awk 'NR > 1 { print $1 }'
}

# 取得済みか。grep -q は最初の一致で読み込みをやめ、上流がSIGPIPE(141)で終わって、
# pipefailのもとで「未取得」と誤判定されるため、-qは使わず最後まで読ませる
has_model() {
  installed_models | grep -Fx -- "$(normalize "$1")" >/dev/null
}

# モデルを取得するレジストリのホスト。"ホスト名/名前" の形（例: hf.co/org/model）ならそのホスト、
# それ以外はOllamaの公式レジストリ
registry_host_of() {
  case "$1" in
    */*)
      case "${1%%/*}" in
        *.*) echo "${1%%/*}"; return ;;
      esac
      ;;
  esac
  echo "registry.ollama.ai"
}

# レジストリに接続できるか。届かない環境で ollama pull を実行すると、失敗せずに接続を再試行し続け、
# 長時間待たされる（取得済みのモデルのpullですら、そうなる）ため、取得の前に確認する。
# プロキシ経由の環境では、ここからの直接の接続確認ができないため、確認を省略する。
registry_reachable() {
  if [ -n "${HTTPS_PROXY:-}${https_proxy:-}${HTTP_PROXY:-}${http_proxy:-}" ]; then
    return 0
  fi
  timeout "${REGISTRY_CHECK_SECONDS:-10}" bash -c 'exec 3<>"/dev/tcp/$1/443"' _ "$1" 2>/dev/null
}

# ollama pull の出力は、進捗バーを端末の制御文字で上書きし続ける形式で、そのままログに出すと
# 数GBのモデルで数万行になる。制御文字を改行に直したうえで、進捗は各レイヤーで10%進むごとに
# 1行だけ、それ以外（manifestの取得・検証・成功・エラー）は同じ内容を1回だけ表示する。
pull_model() {
  ollama pull "$1" 2>&1 \
    | sed -e 's/\x1b\[1G/\n/g' -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' \
    | awk '
        /^pulling [0-9a-f]+: *[0-9]+%/ {
          layer = $2
          match($0, /[0-9]+%/)
          step = int(substr($0, RSTART, RLENGTH - 1) / 10)
          if (!(layer in progress) || step > progress[layer]) {
            progress[layer] = step
            print
            fflush()
          }
          next
        }
        {
          key = $0
          gsub(/[^ -~]/, "", key)   # スピナーなどの記号を除いて比較する
          gsub(/ +$/, "", key)
          if (key ~ /[^ ]/ && !(key in printed)) {
            printed[key] = 1
            print
            fflush()
          }
        }'
}

echo "[ollama-init] Ollama（${OLLAMA_HOST:-未設定}）の起動を待っています（最大 ${WAIT_SECONDS} 秒）..."
waited=0
until ollama list >/dev/null 2>&1; do
  if [ "$waited" -ge "$WAIT_SECONDS" ]; then
    echo "[ollama-init] エラー: ${WAIT_SECONDS} 秒待ってもOllamaに接続できませんでした。ollamaコンテナのログを確認してください。" >&2
    exit 1
  fi
  sleep 2
  waited=$((waited + 2))
done
echo "[ollama-init] Ollamaに接続できました。"

failed=""
seen=" "
for model in $REQUIRED_MODELS; do
  # 同じモデルが複数の用途に指定されている（例: OCRの主文とチャットが同じ）場合は、1回だけ扱う
  case "$seen" in
    *" $model "*) continue ;;
  esac
  seen="$seen$model "

  if has_model "$model"; then
    echo "[ollama-init] $model: 取得済みのため、取得しません。"
    continue
  fi

  registry="$(registry_host_of "$model")"
  if ! registry_reachable "$registry"; then
    echo "[ollama-init] $model: 未取得ですが、取得先（$registry）に接続できません。" >&2
    failed="$failed $model"
    continue
  fi

  echo "[ollama-init] $model: 未取得です。取得します（モデルによっては数GBあり、数分〜数十分かかります）..."
  if pull_model "$model" && has_model "$model"; then
    echo "[ollama-init] $model: 取得しました。"
  else
    echo "[ollama-init] $model: 取得に失敗しました。" >&2
    failed="$failed $model"
  fi
done

if [ -n "$failed" ]; then
  echo "" >&2
  echo "[ollama-init] ===== 取得できなかったモデル:${failed} =====" >&2
  echo "[ollama-init] 初回だけは、インターネットへの接続が必要です（モデルを取得するため）。" >&2
  echo "[ollama-init] 接続できる環境で、もう一度 'docker compose up -d' を実行してください（取得済みのモデルはスキップされます）。" >&2
  echo "[ollama-init] モデル名が正しいかも確認してください（.env の EMBEDDING_MODEL / OCR_MODEL / OCR_VISION_MODEL / CHAT_MODEL）。" >&2
  exit 1
fi

echo "[ollama-init] 必要なモデルがすべて揃いました: $REQUIRED_MODELS"
