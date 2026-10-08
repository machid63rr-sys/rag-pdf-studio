-- ============================================================================
-- rag-pdf-studio スキーマ
--
-- マニュアルのRAG登録（pgvector）とOCR下書きのテーブル。
-- pgvector拡張が前提（postgres:15イメージではなくpgvector/pgvectorイメージを使う）。
-- 埋め込みモデルはollamaのbge-m3（1024次元）。モデルを変える場合は
-- m_manual_chunk.embeddingのVECTOR(N)とocr_rag/rag/rag_retriever.pyの
-- EMBEDDING_DIMENSIONSを合わせて変更すること。
--
-- このファイルは空のDBに1回流す（compose環境ではpostgresコンテナの初回起動時に自動適用）。
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- マニュアル文書。source_file_nameが同じ文書を再登録すると、既存を削除して作り直す
-- （部分更新はしない）ため、一意制約で同名の重複を防ぐ
CREATE TABLE m_manual_document (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    source_file_name VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- マニュアル文書↔タグ名（例: AHU-1, ESP-1）の多対多中間テーブル。
-- 1マニュアルが複数のタグ名を持ってよい。行が1件も無いマニュアルはタグ名未設定の
-- 汎用マニュアル扱い（タグ名で絞り込んだ検索でも対象に含める）。
-- 列名のequipment_nameは、画面・ドキュメントで「タグ名」と呼ぶもの（元は「機器名」。名前だけの変更で
-- 稼働中のDBの移行とAPIの互換が壊れるのを避けるため、識別子はそのままにしている）。
CREATE TABLE r_manual_document_equipment (
    document_id UUID NOT NULL REFERENCES m_manual_document(id) ON DELETE CASCADE,
    equipment_name VARCHAR(255) NOT NULL,
    PRIMARY KEY (document_id, equipment_name)
);

CREATE INDEX idx_manual_document_equipment_lookup
ON r_manual_document_equipment (equipment_name);

-- 原本PDF。検索結果から元のPDFを開くために保持する。1マニュアル=1PDF
CREATE TABLE m_manual_pdf (
    document_id UUID PRIMARY KEY REFERENCES m_manual_document(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    content BYTEA NOT NULL CHECK (octet_length(content) > 0),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- マニュアルチャンク（埋め込みベクトル検索の対象）
CREATE TABLE m_manual_chunk (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES m_manual_document(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding VECTOR(1024) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (document_id, chunk_index)
);

-- HNSW: IVFFlatと違い、事前にある程度のデータ件数が無くても使える
CREATE INDEX idx_manual_chunk_embedding
ON m_manual_chunk USING hnsw (embedding vector_cosine_ops);

-- OCR下書き。OCRは数分かかりうる重い処理のため、バックグラウンドで実行し、状態・進捗・結果を
-- ここに永続化する。リロード・タブクローズ後も、再実行せずに状態と結果を復元できる。
CREATE TABLE t_manual_ocr_draft (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_file_name VARCHAR(255) NOT NULL,
    title VARCHAR(255),
    draft_markdown TEXT NOT NULL DEFAULT '',
    -- ページ・セグメントごとの「一致/自動修正/要確認」ステータスと両OCR候補・
    -- vision LLMの判定理由。画面の差分ハイライトはこのJSONをそのまま描画に使う
    -- （構造はocr_rag/ocr/ocr_diff.pyのDiffSegmentに対応）
    diff_segments JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- 対象PDFのページ数（QUEUED中は0=未確定。PDFを画像にした時点で確定する）と、OCR済みのページ数
    page_count INTEGER NOT NULL DEFAULT 0,
    pages_done INTEGER NOT NULL DEFAULT 0,
    -- QUEUED: OCR待ち / RUNNING: OCR実行中 / DRAFT: OCR完了（人手で確認・修正する）
    -- FAILED: OCR失敗（error_messageに理由） / DISCARDED: 破棄
    status VARCHAR(20) NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'RUNNING', 'DRAFT', 'FAILED', 'DISCARDED')),
    error_message TEXT,
    -- アップロードされた原本PDF。OCR実行・確認画面での閲覧・RAG登録への引き継ぎに使う。破棄すると消す
    pdf_content BYTEA,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_manual_ocr_draft_created_at ON t_manual_ocr_draft (created_at DESC);

-- ============================================================================
-- チャット（機能④）。既にあるDBへは database/migrations/20261008_add_chat_tables.sql を流す
-- ============================================================================

-- チャットの会話。認証が無いため、会話は、この画面を使う全員で共有される
CREATE TABLE t_chat_session (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 会話を始めるときに選んだタグ名。NULLは絞り込まない（質問文にタグ名があれば、そちらを優先して絞る）
    equipment_name VARCHAR(255),
    -- 履歴一覧に出す題名（最初の質問の先頭。要約はしない）
    title VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_chat_session_created_at ON t_chat_session (created_at DESC);

CREATE TABLE t_chat_message (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES t_chat_session(id) ON DELETE CASCADE,
    role VARCHAR(10) NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    -- 回答(assistant)だけに設定する、回答を作った時点の参照マニュアルの控え
    -- （[{document_title, document_id, similarity, content, has_pdf}]。後から検索し直さない）
    manual_references JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_chat_message_session ON t_chat_message (session_id, created_at);
