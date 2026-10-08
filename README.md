# rag-pdf-studio

スキャンPDFを **OCRしてMarkdownにし**、整えて **MD/PDFで出力**し、**RAG（pgvector）に登録して検索で確認**し、登録した内容を根拠に **AIチャットで質問**できるアプリ。
ブラウザの1つの画面に、次の4つの機能がタブで並ぶ。

| 機能 | 内容 |
|---|---|
| **① MD/HTML → PDF** | MarkdownまたはHTMLを取り込み、見たまま編集して、元のファイルとPDFを同時に出力する |
| **② PDF → OCR → MD** | PDFをOCRし、結果の「確認が必要な箇所」を原本PDFと見比べて直し、Markdownとして保存する。結果は、①（PDFにして出力）や③（RAG登録）へ渡せる |
| **③ RAG（登録・確認）** | Markdown（とタグ名・原本PDF）をRAGに登録する。登録済みの一覧と、質問文での簡易検索で、登録内容を確認する |
| **④ AIチャット** | 登録した資料について質問する。質問のたびに自動でRAG検索し、見つかった抜粋だけを根拠に、ローカルのLLMが回答する。参照した抜粋と原本PDFも見られる |

OCR・RAGは、**ローカルのモデル（Ollama）で動く**。クラウドには送らない。初回の起動でだけインターネットが要り、以降はオフラインで動く。

## 起動

必要なものは Docker（Docker Compose v2）だけ。

```bash
cp .env.example .env            # DB_PASSWORD に、好きな値を設定する（必須）
docker compose up -d --build    # NVIDIA GPUがあれば: 下の「GPUを使う」を先に設定する
```

ブラウザで **http://localhost:8090** を開く（Chrome または Edge。WSL2でも、Windowsのブラウザから同じURLで開ける）。

- **初回だけ、インターネットが必要**: イメージのビルドと、Ollamaのモデル約10GB（`qwen3.5:9b` 6.6GB、`glm-ocr` 2.2GB、`bge-m3` 1.2GB）の取得。
  取得は `ollama-init` が行い、完了するまで、ocr-rag・appは起動しない。取得状況は `docker compose logs -f ollama-init` で見られる。
  取得に失敗した場合は、取れなかったモデルと対処を表示して終了する（もう一度 `docker compose up -d` で、取得済みのモデルは飛ばして続きから取得する）。
- **2回目以降はオフラインで起動できる**: モデルは名前付きボリューム（`ollama-data`）に残り、取得済みなら取得しない。
- **GPUが無い環境でも動く**が、OCRは大幅に遅くなる（GPUでも1ページ数分かかる）。
- **GPUを使う（NVIDIA）**: 既定ではGPUを割り当てないため、OCRはCPUで動く。GPUがあるPCでは、`.env` に
  `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` を書く（`.env.example` の末尾に、コメントアウトした行がある）。
  以降は `docker compose up -d` だけでGPUが使われる（`docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d` でも同じ）。
  前提は、NVIDIAドライバと NVIDIA Container Toolkit。使われているかは、OCR中に `docker compose exec ollama ollama ps` の `PROCESSOR` が `100% GPU` になっているかで確認できる。
- **VRAMは8GB程度が目安**: 主文を読む `qwen3.5:9b`（約5.6GB）と `glm-ocr`（約2.9GB）を、同時に載せると8GBを超える。Ollamaは足りない分をCPUに載せるため、
  `PROCESSOR` が `xx%/yy% CPU/GPU` になり、遅くなる。他のコンテナ（別のOllamaなど）がGPUを使っている場合も、同じ理由でCPUに流れる。
- 停止は `docker compose down`（データは残る）。**`docker compose down -v` は、モデル（再取得が必要）と登録したデータを消す**。
- 認証機能は無い。既定では、このPCからのみ接続できる（`.env` の `BIND_ADDR`）。複数人で共有する場合は、認証を別途用意する。

## 画面の使い方

### ② PDF → OCR → MD

1. PDFを選んで「OCRを開始」。OCRは**バックグラウンドで実行**され、1ページ数分かかる。画面には進捗（n / Nページ）が出る。画面を閉じても、リロードしても続く（「OCR履歴」から開き直せる）。
2. 完了すると「確認・修正」の画面になる。左に**確認が必要な箇所**（AIが画像を見ても判定できなかった箇所）、右に本文エディタ。
   各箇所から「本文の該当箇所へ」「PDFのpNを開く」で、原本と見比べて直す。直したら「修正を保存」。表の崩れは警告される。
   「書式付き」のツールバーから、表・コードブロック・区切り線・改ページを入れて、内容を足すこともできる（①の編集画面と同じ部品）。
3. 出力: 「Markdownを保存(.md)」、「① PDFにして出力へ」（①の編集画面で開く）、「③ RAGに登録へ」（③の登録フォームに、本文・登録名・原本PDFを入れる）。

OCRの結果には**誤読が残ることがある**ため、人が確認してから使う前提。複雑な表では、表の骨格の崩れが残る場合がある（下の「既知の課題」）。

### ③ RAG（登録・確認）

- **登録**: Markdownファイル（または貼り付け）と、登録名・題名・タグ名（複数可。画面の項目名は「タグ名登録」）・原本PDF（任意）を指定して登録する。
  タグ名は、資料に付ける名前（分類のラベル）。APIの項目名・DBの列名は、元の呼び名のまま `equipment_name(s)`。
  同じ登録名で登録し直すと置き換わる（原本PDFは、新しく付けなければ引き継がれる）。タグ名を付けない資料は、共通（タグなし）の扱い。
- **確認（一覧・検索）**: 登録済みの文書の一覧（タグ名・チャンク数・原本PDF）と、質問文での簡易検索。結果は類似度つきで、類似度が0.5未満のものには「関連度が低い」と出る（しきい値は暫定）。

### ④ AIチャット

- **質問する**: 質問を入力して送信（Enterで送信、Shift+Enterで改行）。質問のたびに、登録済みのマニュアルが**自動で検索**され、その抜粋だけを根拠に回答する。
  回答は生成と同時に表示される。生成中は「■ 停止」かESCキーで止められる（止めた回答は保存されない）。
- **根拠の確認**: 回答の下に「参照マニュアル」として、根拠にした抜粋（文書名・類似度・本文）と「原本PDFを開く」が出る。
- **根拠が無いときは答えない**: 類似度0.45未満の抜粋は根拠にしない（暫定のしきい値）。根拠にできる抜粋が1件も無いときは、モデルを呼ばずに、固定の
  「登録された資料には、その記載がありません」を返す（参照マニュアルは出ない）。実モデルで、指示だけでは、モデルが資料に無い回答を作り、存在しない資料を引用したため。
  ③の検索画面の「関連度が低い」（0.5未満）は、表示上の目安で、別の値。
- **汎用の資料Q&A**: 回答の指示（プロンプト）は、特定の業界・用途に限っていない。登録した資料（マニュアル・仕様書・手順書など）であれば、何についても質問できる。
- **タグ名で絞る**: 会話を始めるときにタグ名を選ぶと、そのタグ名の資料と共通（タグなし）の資料だけを検索する。質問文にタグ名（例: ESP-1）があれば、そちらが優先される。
- **タグ名を尋ねる**: 「Aの資料は？」のようにタグ名しか書かれていない質問は、本文との意味の近さが低く（実測で0.35〜0.41）、そのままだと「記載がありません」になる。
  そのため、類似度で根拠が見つからないときは、**質問に書かれたタグ名が付いた資料**（文書ごとに、質問に最も近い1か所）を根拠にする。
  質問に書かれたタグ名が、根拠にした資料に付いているときは、そのタグ名もモデルに伝える（伝えないと「Aという名称は資料に無い」と答える）。
  タグ名は、全角半角・大文字小文字を区別せず、別の語の一部（タグ「A」に対する「AI」）は含めない。会話で選んだタグ名だけでは、この扱いにしない（範囲外の質問まで、根拠を見つけたことにしないため）。
- **履歴**: 左に会話の一覧が出る。開き直して続きを質問でき、削除もできる。認証が無いため、会話は、この画面を使う全員で共有される。
- 回答を作るモデルは、既定ではOCRの主文を読むモデル（`qwen3.5:9b`）と同じ（`.env` の `CHAT_MODEL` で変えられる）。**OCRの実行中は、同じモデル・GPUを使うため、回答が遅くなる**。

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
主なもの: `HOST_PORT`（既定 8090）、`BIND_ADDR`、モデル名（`EMBEDDING_MODEL` `OCR_MODEL` `OCR_VISION_MODEL` `CHAT_MODEL`）、`OCR_VISION_TIMEOUT_SECONDS`、`MAX_UPLOAD_BYTES`。

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
| `GET /documents` / `GET /documents/{id}/pdf` / `GET /equipment-names` | 登録済みの一覧 / 原本PDF / タグ名の一覧 |
| `POST /search` | 検索（`query` `equipment_name` `top_k`）。埋め込み検索のみ |
| `POST /chat/sessions` / `GET /chat/sessions` | 会話を作る（任意で `equipment_name`）/ 会話の一覧（新しい順） |
| `DELETE /chat/sessions/{id}` / `GET /chat/sessions/{id}/messages` | 会話を削除する / メッセージ（回答には参照マニュアルの控えつき） |
| `POST /chat/sessions/{id}/messages` | 質問を送り、回答をストリーミングで受け取る（`application/x-ndjson`。下記） |
| `GET /healthz` / `GET /readyz` | DB接続の確認 / DBと必要なモデルが揃っているかの確認 |

チャットの回答は、改行区切りのJSONで届く: `{"type":"manual_references",...}`（最初に1回。参照マニュアル、無ければ `null`）→
`{"type":"delta","text":"..."}`（生成の間、くり返し）→ `{"type":"done","message_id":...}`（完了。この時点で回答が保存される）。
ストリームを始めた後の失敗は、HTTPのステータスで表せないため、`{"type":"error","detail":"..."}` が届く（その回答は保存されない。質問は残る）。

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

### 既にあるDBの更新

`database/schema.sql` は、**空のDBへの初回起動でだけ**適用される。機能を足す前に作ったDBには、新しいテーブルが入らない（該当の機能のAPIは、`503` で
「テーブルが不足しています」と返す）。`database/migrations/` のSQLを、日付の順に、1回ずつ流す（何度流しても安全）。

```bash
# 2026-10-08 チャット（④）の会話履歴のテーブル
docker compose exec -T postgres psql -U postgres -d ragstudio < database/migrations/20261008_add_chat_tables.sql
```

起動に失敗する典型例: `DB_PASSWORD` を設定していないシェルで起動した（`ConfigError`）、`ocr-rag` ディレクトリに入っていない（`No module named 'ocr_rag'`）、DBが動いていない（`Connection refused`）。

## 由来

異常検知システム（`anomaly-detection`、コミット `523b094`）のOCR・RAG部分と、md-pdf-editor（コミット `fead8e7`）を、**コピーして**再作成したもの。元のリポジトリは変更していない。

元システムからの主な変更:
- 系統・ユーザー・認証を削除。登録・検索はタグ名だけで絞る
- チャットは、異常検知システムのチャット（`src/llm/chat_service.py`・`chat.py`・`ChatWidget.tsx`）を作り直したもの。会話の保存・回答のストリーミング・停止・参照マニュアルと原本PDFへのリンク・タグ名の解決は引き継ぎ、
  異常イベント・過去事例の検索、運用上のミスの判定、系統、リランクを除いた。浮動ウィジェットではなく、他の機能と同じタブにした。
  元は空調設備の保守員向けのプロンプトだったが、このアプリは特定の業界に限らず使えることを目的とするため、業界を限定しない表現にした
  （OCRのプロンプトは、元のまま「空調設備の機器マニュアル」と書いてある。他の業界の資料で使う場合は、`ocr-rag/ocr_rag/ocr/` のプロンプトの見直しが要る）
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
- **図・吹き出しのあるPDFのOCR精度**: 図のあるページでは、比較用のGLM-OCRが最後まで出力できず、食い違い（=自動修正の対象）が増える。補正LLMが、正しい主文を壊す誤りへの対策を2つ入れている。
  - 補正案が、主文・比較候補のどちらとも大きく異なる（類似度0.6未満。文字化けの恐れ）ときは、採用せず、主文を残して要確認にする。
  - 補正が主文を書き換えた箇所は、**再チェック**する（`ocr/correction_recheck.py`）。PDFにテキスト層があるページは、その文字列に補正後・主文のどちらの表記があるかを照合する（LLMなし）。
    決まらない箇所は、画像を使わず、前後の文脈つきで「日本語として正しいのはどちらか」をLLMに判定させる（並び順を入れ替えて2回聞き、2回とも主文が正しいときだけ、補正を取り消して主文に戻し、要確認にする）。
  - **再チェックのLLMの判定は、実モデルでは未確認**（単体テストは、LLMを偽物にしている）。実PDFで、誤った補正を取り消せるか・正しい補正を取り消していないかを確認すること。
    図の中の小さな文字の誤読は防げない。スキャンしたPDF（テキスト層が無い）は、日本語の判定だけになる。
  - 大きいモデルに替えたときの効果は未計測（`OCR_VISION_MODEL` で替えられる。`CHAT_MODEL` は未指定だと同じモデルになる）。
- **実モデル（約10GB）の初回取得の所要時間は未計測**（開発機では、極小モデルで取得の流れを確認した）。
- **GPU上書き**（`docker-compose.gpu.yml`）: RTX 3070 Laptop（VRAM 8GB、WSL2）で、OllamaがCUDAのGPUを認識し、`glm-ocr`（num_ctx 16384）が `100% GPU` で載ることを確認した。
  `qwen3.5:9b` を含むOCR全体を通したGPU上の所要時間と、VRAMが他のプロセスと競合する状況での挙動は未計測。
- 検索の類似度のしきい値（③の「関連度が低い」0.5、④で根拠にする下限0.45）は暫定。実際のマニュアルで再確認が必要。
- ④チャットは、追質問の検索に、前の質問を足していない（「その対策は？」のような短い追質問は、検索に当たりにくいことがある。実モデルでは、直前の話題に当たって答えられた）。
  履歴の「原本PDFを開く」は、同じ登録名で登録し直すと、文書IDが変わって404になる。
- OCRの画面とチャットは、同じモデル・GPUを使う。OCRの実行中にチャットで質問すると、回答が遅くなる（OCR1ページ分の処理が終わるまで待つ）。
- スキーマ変更の仕組み（マイグレーションの管理）は未整備。`schema.sql` は、空のDBへの初回起動で適用される。既にあるDBは、`database/migrations/` のSQLを手で流す（上の「既にあるDBの更新」）。
- 完全にネットが無い環境への配布（`docker save/load` でのイメージ・モデルの持ち込み）は未対応。
- OCRが完了しても、別のタブにいると気づけない（タブの表示は変わらない）。
- ブラウザ: ①のフォルダへの直接出力は、Chrome・Edgeのみ（詳細は [docs/feature-pdf-editor.md](docs/feature-pdf-editor.md)）。
- 認証が無い。複数人で共有する場合は、別途用意が要る。
