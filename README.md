# rag-pdf-studio

スキャンPDFを **OCRしてMarkdownにし**、整えて **MD/PDFで出力**し、**RAG（pgvector）に登録して検索で確認**するアプリ。
ブラウザの1つの画面に、次の3つの機能がタブで並ぶ。

| 機能 | 内容 |
|---|---|
| **① MD/HTML → PDF** | MarkdownまたはHTMLを取り込み、見たまま編集して、元のファイルとPDFを同時に出力する |
| **② PDF → OCR → MD** | PDFをOCRし、結果の「確認が必要な箇所」を原本PDFと見比べて直し、Markdownとして保存する。結果は、①（PDFにして出力）や③（RAG登録）へ渡せる |
| **③ RAG（登録・確認）** | Markdown（と機器名・原本PDF）をRAGに登録する。登録済みの一覧と、質問文での簡易検索で、登録内容を確認する |

OCR・RAGは、**ローカルのモデル（Ollama）で動く**。クラウドには送らない。初回の起動でだけインターネットが要り、以降はオフラインで動く。

## 起動

必要なものは Docker（Docker Compose v2）だけ。

```bash
cp .env.example .env            # DB_PASSWORD に、好きな値を設定する（必須）
docker compose up -d --build    # NVIDIA GPUがあれば: docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

ブラウザで **http://localhost:8090** を開く（Chrome または Edge。WSL2でも、Windowsのブラウザから同じURLで開ける）。

- **初回だけ、インターネットが必要**: イメージのビルドと、Ollamaのモデル約10GB（`qwen3.5:9b` 6.6GB、`glm-ocr` 2.2GB、`bge-m3` 1.2GB）の取得。
  取得は `ollama-init` が行い、完了するまで、ocr-rag・appは起動しない。取得状況は `docker compose logs -f ollama-init` で見られる。
  取得に失敗した場合は、取れなかったモデルと対処を表示して終了する（もう一度 `docker compose up -d` で、取得済みのモデルは飛ばして続きから取得する）。
- **2回目以降はオフラインで起動できる**: モデルは名前付きボリューム（`ollama-data`）に残り、取得済みなら取得しない。
- **GPUが無い環境でも動く**が、OCRは大幅に遅くなる（GPUでも1ページ数分かかる）。
- 停止は `docker compose down`（データは残る）。**`docker compose down -v` は、モデル（再取得が必要）と登録したデータを消す**。
- 認証機能は無い。既定では、このPCからのみ接続できる（`.env` の `BIND_ADDR`）。複数人で共有する場合は、認証を別途用意する。

## 画面の使い方

### ② PDF → OCR → MD

1. PDFを選んで「OCRを開始」。OCRは**バックグラウンドで実行**され、1ページ数分かかる。画面には進捗（n / Nページ）が出る。画面を閉じても、リロードしても続く（「OCR履歴」から開き直せる）。
2. 完了すると「確認・修正」の画面になる。左に**確認が必要な箇所**（AIが画像を見ても判定できなかった箇所）、右に本文エディタ。
   各箇所から「本文の該当箇所へ」「PDFのpNを開く」で、原本と見比べて直す。直したら「修正を保存」。表の崩れは警告される。
3. 出力: 「Markdownを保存(.md)」、「① PDFにして出力へ」（①の編集画面で開く）、「③ RAGに登録へ」（③の登録フォームに、本文・登録名・原本PDFを入れる）。

OCRの結果には**誤読が残ることがある**ため、人が確認してから使う前提。複雑な表では、表の骨格の崩れが残る場合がある（下の「既知の課題」）。

### ③ RAG（登録・確認）

- **登録**: Markdownファイル（または貼り付け）と、登録名・題名・機器名（複数可）・原本PDF（任意）を指定して登録する。
  同じ登録名で登録し直すと置き換わる（原本PDFは、新しく付けなければ引き継がれる）。機器名を付けない資料は、全機器共通の扱い。
- **確認（一覧・検索）**: 登録済みの文書の一覧（機器名・チャンク数・原本PDF）と、質問文での簡易検索。結果は類似度つきで、類似度が0.5未満のものには「関連度が低い」と出る（しきい値は暫定）。

### ① MD/HTML → PDF

使い方と仕様は [docs/feature-pdf-editor.md](docs/feature-pdf-editor.md)。

## 構成

```
app/        画面（React）とサーバ（Node）。PDF生成(Chromium)と、/api/rag/* の中継
ocr-rag/    OCR・RAG登録・検索のAPI（Python/FastAPI）
database/   スキーマ（pgvector）。初回の起動で自動適用される
scripts/    ollama-init.sh（モデルの初回取得）
docs/       設計・仕様
```

compose は5つのサービスを起動する: `app`（公開は、ブラウザ用の1ポートのみ）、`ocr-rag`、`postgres`（pgvector）、`ollama`、`ollama-init`（一回限り）。
全体の構成と設計の判断は [docs/architecture.md](docs/architecture.md)、OCRの決定の経緯は [docs/ocr-design-history.md](docs/ocr-design-history.md)。

## 設定

すべて `.env`（`.env.example` をコピー）で設定する。`DB_PASSWORD` 以外は省略できる。変数の意味は `.env.example` のコメントを参照。
主なもの: `HOST_PORT`（既定 8090）、`BIND_ADDR`、モデル名（`EMBEDDING_MODEL` `OCR_MODEL` `OCR_VISION_MODEL`）、`OCR_VISION_TIMEOUT_SECONDS`、`MAX_UPLOAD_BYTES`。

## ocr-rag の API

画面からは `/api/rag/*` として使う（appが、許可したパスだけを中継する）。

| メソッド・パス | 内容 |
|---|---|
| `POST /ocr-drafts` | PDFのOCRを開始する（即座に `202`。実行はバックグラウンド） |
| `GET /ocr-drafts` / `GET /ocr-drafts/{id}` | 下書きの一覧 / 状態・進捗・結果 |
| `PATCH /ocr-drafts/{id}` | OCR完了後の本文の修正を保存する |
| `POST /ocr-drafts/{id}/discard` | 破棄する（実行中なら、現在のページの終了時に中止） |
| `GET /ocr-drafts/{id}/pdf` | アップロードした原本PDF |
| `POST /documents` | MDをRAG登録する（multipart: `markdown_file`、任意で `title` `equipment_names`（複数）`pdf_file`）。同名は置き換え |
| `GET /documents` / `GET /documents/{id}/pdf` / `GET /equipment-names` | 登録済みの一覧 / 原本PDF / 機器名の一覧 |
| `POST /search` | 検索（`query` `equipment_name` `top_k`）。埋め込み検索のみ |
| `GET /healthz` / `GET /readyz` | DB接続の確認 / DBと必要な3モデルが揃っているかの確認 |

OCRの状態は `QUEUED`（順番待ち）→ `RUNNING`（実行中）→ `DRAFT`（完了。人が確認・修正）/ `FAILED`（失敗。理由つき）/ `DISCARDED`（破棄）。
OCRは、GPUを占有するため、同時に1件だけ実行する。Ollamaに繋がらない場合は `502`、モデルが足りない場合は `/readyz` が `503` で、足りないモデルを返す。
`ocr-rag` を直接使う開発時は、`http://127.0.0.1:8100/docs`（操作画面）が使える（compose では公開していない）。

## 開発

### テスト

```bash
# ocr-rag（Python）: テスト専用の使い捨てのDBを使う
cd ocr-rag
pip install -r requirements-dev.txt
export TEST_DB_PASSWORD=<任意の値>
docker compose -f docker-compose.test.yml up -d
python -m pytest                      # 238件
docker compose -f docker-compose.test.yml down

# app（Node 24が必要なため、Dockerで実行する。型チェック → ビルド → 全テスト（実Chromium））
docker build --target test -t rag-pdf-studio-app:test ./app      # 1106件
```

### ocr-rag を、composeを使わずに起動する

```bash
cd ocr-rag
python3 -m venv ../.venv && . ../.venv/bin/activate && pip install -r requirements.txt     # poppler-utils(pdftoppm)も必要
export DB_PASSWORD=<任意の値> DB_HOST=localhost DB_PORT=55433 DB_NAME=ragstudio OLLAMA_HOST=http://localhost:11434
docker run -d --name rag-pdf-studio-db -e POSTGRES_PASSWORD=$DB_PASSWORD -e POSTGRES_DB=ragstudio -p 127.0.0.1:55433:5432 \
  -v rag-pdf-studio-pgdata:/var/lib/postgresql/data pgvector/pgvector:0.8.6-pg15
docker exec -i rag-pdf-studio-db psql -U postgres -d ragstudio -q < ../database/schema.sql       # 初回のみ。DBの起動を数秒待つ
uvicorn ocr_rag.api.app:create_app --factory --host 127.0.0.1 --port 8100
```

起動に失敗する典型例: `DB_PASSWORD` を設定していないシェルで起動した（`ConfigError`）、`ocr-rag` ディレクトリに入っていない（`No module named 'ocr_rag'`）、DBが動いていない（`Connection refused`）。

## 由来

異常検知システム（`anomaly-detection`、コミット `523b094`）のOCR・RAG部分と、md-pdf-editor（コミット `fead8e7`）を、**コピーして**再作成したもの。元のリポジトリは変更していない。

元システムからの主な変更:
- 系統・ユーザー・認証を削除。登録・検索は機器名だけで絞る
- 動画リンク、リランク（cross-encoder、torch依存）、tesseractを削除
- OCRを、HTTPの1回の呼び出しで待たせる方式から、バックグラウンド実行＋進捗取得に変更
- 「下書き→保存＝RAG登録」の一体フローをやめ、MDを直接登録する `POST /documents` を新設
- 取り込みは、埋め込み（Ollama）を先に全チャンク分行ってからDBに書く（Ollama停止時に、既存の登録を消さない）

コピー方式のため、修正は元のリポジトリとこのリポジトリで、別々に行う必要がある。

## 確認済みのことと、既知の課題

確認済み:
- ocr-rag 238テスト、app 1106テスト（実Chromium）が通る。型検査（pyright、tsc）もエラー0件。
- 実PDF・実Ollamaでの通し確認: OCR（1ページ約3分）→ 確認 → ③へ受け渡し → 登録 → 検索を、画面操作（実Chromium）で通した。待機中・実行中の破棄、リロード後の復元も動作した。
- `docker compose up` の通し確認（極小モデル）: 初回のモデル取得 → 起動 → app経由の中継 → 失敗の明示、2回目以降の取得スキップ（ネットに出られない状態でも成功）、取得失敗時の日本語エラー、ocr-ragのarm64ビルド。
- 検索の精度（リランクなし）: 8文書・107チャンクの10問で、正解が1位9件・3位以内10件。

既知の課題・未確認:
- **OCRの表の崩れ**: 複雑な表のページで、誤読や、表の骨格の崩れが残ることがある（元システムの既知の課題を引き継いでいる）。「確認が必要な箇所」に出るので、人が確認して直す。
- **実モデル（約10GB）の初回取得の所要時間は未計測**（開発機では、極小モデルで取得の流れを確認した）。
- **GPU上書き**（`docker-compose.gpu.yml`）は、書式の有効性は確認したが、GPU上でのOllama起動は未確認（開発機のGPUが他で使用中のため）。
- 検索の類似度のしきい値（0.5）は暫定。実際のマニュアルで再確認が必要。
- スキーマ変更の仕組み（マイグレーション）は未整備。`schema.sql` は、空のDBへの初回起動で適用される。
- 完全にネットが無い環境への配布（`docker save/load` でのイメージ・モデルの持ち込み）は未対応。
- OCRが完了しても、別のタブにいると気づけない（タブの表示は変わらない）。
- ブラウザ: ①のフォルダへの直接出力は、Chrome・Edgeのみ（詳細は [docs/feature-pdf-editor.md](docs/feature-pdf-editor.md)）。
- 認証が無い。複数人で共有する場合は、別途用意が要る。
