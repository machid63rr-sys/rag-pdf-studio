# app (Node / React)

rag-pdf-studio の画面とサーバ。4つの機能のタブ(① MD/HTML → PDF、② PDF → OCR → MD、③ RAG、④ AIチャット)を持つ。

- 全体の説明・起動方法: [../README.md](../README.md)
- 機能①(md-pdf-editorをコピーして組み込んだもの)の使い方・仕様: [../docs/feature-pdf-editor.md](../docs/feature-pdf-editor.md)
- OCR・RAGの処理は、別サービス `ocr-rag`(Python)が行う。このサーバは、`/api/rag/*` をそこへ中継する(`src/server/ragProxy.ts`)

テストは、Node 24が必要なため、Dockerの `test` ステージで実行する(型チェック → ビルド → 全テスト。実Chromiumを使う):

```bash
docker build --target test -t rag-pdf-studio-app:test ./app
```

## ④ AIチャット

登録済みのマニュアル(③)を根拠に、質問へ回答する画面(`src/client/features/chat/`)。質問のたびに、関連する抜粋を探し、それだけを根拠に、ローカルのモデルが回答する。

- 左に会話の履歴(題名は最初の質問の先頭。機器名・日付つき)、右に会話と入力欄を並べる。履歴の削除は、その項目の中で確認する。
- 新しい会話の最初の質問の前だけ、機器名で絞り込める(その機器名の資料と、全機器共通の資料だけが根拠になる)。質問に機器名が書かれていれば、サーバー側がそれを優先する。
- 回答は、届いた分から順に表示する(書式を付けないプレーンテキスト)。回答の下に、根拠にした参照マニュアル(類似度・原本PDFへのリンク・抜粋)を出す。類似度が低い(0.5未満)抜粋には「関連度が低い」と出る。
- 生成中は、「■ 停止」ボタンかESCキー(チャットを開いている間だけ)で止められる。止めた回答と、生成に失敗した回答は、保存されない(質問は残る)。
- Enterで送信、Shift+Enterで改行。日本語入力の変換を確定するEnterでは送信しない。

ocr-ragのAPI(中継するパスは `/api/rag/chat/...`):

| メソッドとパス | 内容 |
|---|---|
| `POST /chat/sessions` | 会話を作る(`equipment_name`は任意) |
| `GET /chat/sessions` | 会話の一覧(新しい順) |
| `DELETE /chat/sessions/{id}` | 会話を削除する |
| `GET /chat/sessions/{id}/messages` | 会話の内容(回答には、参照マニュアルが付く) |
| `POST /chat/sessions/{id}/messages` | 質問を送り、回答を受け取る |

質問への応答は、改行区切りのJSON(`application/x-ndjson`)のストリーム。1行が1イベントで、`manual_references`(参照マニュアル。最初に1回)、`delta`(回答の断片。生成の間、繰り返し)、`done`(完了。最後に1回)、`error`(生成の失敗)のいずれか。画面は、`done` が届いてから、参照マニュアルを回答に付ける。ストリームの開始後の失敗は、HTTPの状態では伝えられないため、`error` で届く。
