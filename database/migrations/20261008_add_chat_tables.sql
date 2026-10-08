-- ============================================================================
-- マイグレーション: チャット（機能④）の会話履歴テーブルを追加する
-- 日付: 2026-10-08
--
-- 対象: この変更より前に作ったデータベース（database/schema.sql は空のDBへの初回起動でだけ
-- 適用されるため、すでにあるDBには自動では入らない）。何度流しても安全（IF NOT EXISTS）。
-- 新しく作るDBは schema.sql が同じ内容を含むため、このファイルは不要。
--
--   docker compose exec -T postgres psql -U postgres -d ragstudio \
--     < database/migrations/20261008_add_chat_tables.sql
-- ============================================================================

-- チャットの会話。認証が無いため、会話は、この画面を使う全員で共有される
CREATE TABLE IF NOT EXISTS t_chat_session (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 会話を始めるときに選んだ機器名。NULLは絞り込まない（質問文に機器名があれば、そちらを優先して絞る）
    equipment_name VARCHAR(255),
    -- 履歴一覧に出す題名（最初の質問の先頭。要約はしない）
    title VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_session_created_at ON t_chat_session (created_at DESC);

CREATE TABLE IF NOT EXISTS t_chat_message (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES t_chat_session(id) ON DELETE CASCADE,
    role VARCHAR(10) NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    -- 回答(assistant)だけに設定する、回答を作った時点の参照マニュアルの控え
    -- （[{document_title, document_id, similarity, content, has_pdf}]。後から検索し直さない）
    manual_references JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_message_session ON t_chat_message (session_id, created_at);
