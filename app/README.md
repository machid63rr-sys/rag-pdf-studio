# app (Node / React)

rag-pdf-studio の画面とサーバ。3つの機能のタブ(① MD/HTML → PDF、② PDF → OCR → MD、③ RAG)を持つ。

- 全体の説明・起動方法: [../README.md](../README.md)
- 機能①(md-pdf-editorをコピーして組み込んだもの)の使い方・仕様: [../docs/feature-pdf-editor.md](../docs/feature-pdf-editor.md)
- OCR・RAGの処理は、別サービス `ocr-rag`(Python)が行う。このサーバは、`/api/rag/*` をそこへ中継する(`src/server/ragProxy.ts`)

テストは、Node 24が必要なため、Dockerの `test` ステージで実行する(型チェック → ビルド → 全テスト。実Chromiumを使う):

```bash
docker build --target test -t rag-pdf-studio-app:test ./app
```
