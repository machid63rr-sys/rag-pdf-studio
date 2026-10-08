"""
ocr_rag/api/chat.py のテスト

会話の保存・ストリーミングの形式・検索の絞り込みを、実DB・ダミーの埋め込み・偽のLLMで確認する。
検索・LLM呼び出しの中身は、test_chat_service.py で確認している。
"""
import json
import uuid
from pathlib import Path

import pytest
import requests

from ocr_rag.chat.chat_service import NO_EVIDENCE_ANSWER
from tests.conftest import SCHEMA_SQL_PATH
from tests.helpers import fake_embedding, insert_manual_chunk, insert_manual_pdf

MIGRATION_SQL_PATH = SCHEMA_SQL_PATH.parent / "migrations" / "20261008_add_chat_tables.sql"


def _create_session(client, **body) -> dict:
    response = client.post("/chat/sessions", json=body)
    assert response.status_code == 201
    return response.json()


def _ask(client, session_id, question="質問") -> list:
    """質問を送り、ストリーム（改行区切りのJSON）の全イベントを返す"""
    response = client.post(f"/chat/sessions/{session_id}/messages", json={"question": question})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def _messages(client, session_id) -> list:
    response = client.get(f"/chat/sessions/{session_id}/messages")
    assert response.status_code == 200
    return response.json()


@pytest.fixture
def manual(db):
    """質問に関連するとみなされる資料を1件登録する（根拠が無いと、LLMは呼ばれず、固定の回答になる）"""
    return insert_manual_chunk(db, "ESP-1", "点検の手順", fake_embedding(0.9))


class TestCreateSession:
    def test_creates_a_session_without_equipment_name(self, client):
        body = _create_session(client)

        assert body["equipment_name"] is None
        assert body["title"] is None
        assert uuid.UUID(body["session_id"])

    def test_creates_a_session_with_trimmed_equipment_name(self, client):
        assert _create_session(client, equipment_name="  ESP-1 ")["equipment_name"] == "ESP-1"

    @pytest.mark.parametrize("equipment_name", ["", "   "])
    def test_blank_equipment_name_means_no_filter(self, client, equipment_name):
        assert _create_session(client, equipment_name=equipment_name)["equipment_name"] is None

    def test_too_long_equipment_name_returns_422(self, client):
        assert client.post("/chat/sessions", json={"equipment_name": "あ" * 256}).status_code == 422


class TestListAndDeleteSessions:
    def test_lists_sessions_newest_first(self, client):
        first = _create_session(client)["session_id"]
        second = _create_session(client, equipment_name="ESP-1")["session_id"]

        sessions = client.get("/chat/sessions").json()

        assert [s["session_id"] for s in sessions] == [second, first]
        assert sessions[0]["equipment_name"] == "ESP-1"

    def test_lists_nothing_at_first(self, client):
        assert client.get("/chat/sessions").json() == []

    def test_delete_removes_the_session_and_its_messages(self, client, db, manual):
        session_id = _create_session(client)["session_id"]
        _ask(client, session_id)

        response = client.delete(f"/chat/sessions/{session_id}")

        assert response.status_code == 204
        assert client.get("/chat/sessions").json() == []
        with db.get_cursor() as cursor:
            cursor.execute("SELECT count(*) AS n FROM t_chat_message")
            assert cursor.fetchone()["n"] == 0

    def test_delete_unknown_session_returns_404(self, client):
        assert client.delete(f"/chat/sessions/{uuid.uuid4()}").status_code == 404

    def test_invalid_session_id_returns_422(self, client):
        assert client.delete("/chat/sessions/not-a-uuid").status_code == 422


class TestListMessages:
    def test_unknown_session_returns_404(self, client):
        assert client.get(f"/chat/sessions/{uuid.uuid4()}/messages").status_code == 404

    def test_new_session_has_no_messages(self, client):
        assert _messages(client, _create_session(client)["session_id"]) == []


class TestPostMessage:
    def test_streams_references_deltas_then_done(self, client, manual):
        session_id = _create_session(client)["session_id"]

        events = _ask(client, session_id, "点検の手順は？")

        assert [e["type"] for e in events] == ["manual_references", "delta", "delta", "done"]
        assert events[0]["manual_references"][0]["document_title"] == "ESP-1"
        assert "".join(e["text"] for e in events if e["type"] == "delta") == "これは回答です。"
        assert uuid.UUID(events[-1]["message_id"])
        assert events[-1]["created_at"]

    def test_saves_the_question_and_the_answer_with_its_references(self, client, db, manual):
        document_id = manual
        insert_manual_pdf(db, document_id)
        session_id = _create_session(client)["session_id"]

        done = _ask(client, session_id, "点検の手順は？")[-1]

        user, assistant = _messages(client, session_id)
        assert (user["role"], user["content"], user["manual_references"]) == ("user", "点検の手順は？", None)
        assert (assistant["role"], assistant["content"]) == ("assistant", "これは回答です。")
        assert assistant["message_id"] == done["message_id"]
        [reference] = assistant["manual_references"]
        assert reference["document_title"] == "ESP-1"
        assert reference["document_id"] == str(document_id)
        assert reference["content"] == "点検の手順"
        assert reference["has_pdf"] is True
        assert reference["similarity"] == pytest.approx(0.9, abs=1e-4)

    def test_without_relevant_manuals_it_answers_no_entry_without_calling_the_model(self, client, fake_llm):
        session_id = _create_session(client)["session_id"]

        events = _ask(client, session_id)

        assert events[0] == {"type": "manual_references", "manual_references": None}
        assert events[-1]["type"] == "done"
        assert fake_llm.calls == []
        user, assistant = _messages(client, session_id)
        assert assistant["content"] == NO_EVIDENCE_ANSWER
        assert assistant["manual_references"] is None

    def test_title_is_the_first_question_and_is_not_overwritten(self, client, manual):
        session_id = _create_session(client)["session_id"]

        _ask(client, session_id, "最初の質問")
        _ask(client, session_id, "二つ目の質問")

        [session] = client.get("/chat/sessions").json()
        assert session["title"] == "最初の質問"

    def test_long_question_is_cut_to_fit_the_title(self, client):
        session_id = _create_session(client)["session_id"]

        _ask(client, session_id, "あ" * 1000)

        assert client.get("/chat/sessions").json()[0]["title"] == "あ" * 255

    def test_gives_the_model_the_previous_turns_but_not_the_question_twice(self, client, fake_llm, manual):
        session_id = _create_session(client)["session_id"]
        _ask(client, session_id, "最初の質問")

        _ask(client, session_id, "二つ目の質問")

        contents = [m["content"] for m in fake_llm.calls[1][1:]]
        assert contents == ["最初の質問", "これは回答です。", "二つ目の質問"]

    def test_narrows_the_search_with_the_session_equipment_name(self, client, db):
        insert_manual_chunk(db, "ESP-1", "内容", fake_embedding(0.9), equipment_names=["ESP-1"])
        insert_manual_chunk(db, "ESP-2", "内容", fake_embedding(0.9), equipment_names=["ESP-2"])
        session_id = _create_session(client, equipment_name="ESP-1")["session_id"]

        references = _ask(client, session_id)[0]["manual_references"]

        assert [r["document_title"] for r in references] == ["ESP-1"]

    def test_unknown_session_returns_404_and_saves_nothing(self, client, db, fake_llm):
        response = client.post(f"/chat/sessions/{uuid.uuid4()}/messages", json={"question": "質問"})

        assert response.status_code == 404
        assert fake_llm.calls == []
        with db.get_cursor() as cursor:
            cursor.execute("SELECT count(*) AS n FROM t_chat_message")
            assert cursor.fetchone()["n"] == 0

    @pytest.mark.parametrize("question", ["", "   ", "\n"])
    def test_blank_question_returns_422(self, client, question):
        session_id = _create_session(client)["session_id"]

        response = client.post(f"/chat/sessions/{session_id}/messages", json={"question": question})

        assert response.status_code == 422
        assert _messages(client, session_id) == []

    def test_too_long_question_returns_422(self, client):
        session_id = _create_session(client)["session_id"]

        response = client.post(f"/chat/sessions/{session_id}/messages", json={"question": "あ" * 2001})

        assert response.status_code == 422

    def test_llm_failure_is_an_error_event_and_only_the_question_is_saved(self, client, fake_llm, manual):
        fake_llm.error = RuntimeError("モデルが応答しません")
        session_id = _create_session(client)["session_id"]

        events = _ask(client, session_id, "質問")

        assert events[-1] == {"type": "error", "detail": "モデルが応答しません"}
        assert "done" not in [e["type"] for e in events]
        assert [(m["role"], m["content"]) for m in _messages(client, session_id)] == [("user", "質問")]

    def test_unreachable_ollama_is_an_error_event_that_says_what_failed(self, client, fake_llm, manual):
        fake_llm.error = requests.ConnectionError("connection refused")
        session_id = _create_session(client)["session_id"]

        events = _ask(client, session_id)

        assert events[-1]["type"] == "error"
        assert events[-1]["detail"].startswith("Ollamaへの接続・呼び出しに失敗しました")
        assert "connection refused" in events[-1]["detail"]
        assert [m["role"] for m in _messages(client, session_id)] == ["user"]

    def test_search_failure_is_an_error_event_and_the_model_is_not_called(self, client, fake_llm, monkeypatch):
        def failing_search(*args, **kwargs):
            raise requests.ConnectionError("embedding down")

        monkeypatch.setattr(client.app.state.ctx.retriever, "search", failing_search)
        session_id = _create_session(client)["session_id"]

        events = _ask(client, session_id)

        assert events[-1]["type"] == "error"
        assert "embedding down" in events[-1]["detail"]
        assert fake_llm.calls == []
        assert [m["role"] for m in _messages(client, session_id)] == ["user"]

    def test_empty_answer_is_an_error_event_and_is_not_saved(self, client, fake_llm, manual):
        fake_llm.chunks = [""]
        session_id = _create_session(client)["session_id"]

        events = _ask(client, session_id)

        assert events[-1]["type"] == "error"
        assert "空の回答" in events[-1]["detail"]
        assert [m["role"] for m in _messages(client, session_id)] == ["user"]

    def test_closes_the_llm_stream_when_the_answer_is_complete(self, client, fake_llm, manual):
        _ask(client, _create_session(client)["session_id"])

        assert fake_llm.closed is True


class TestOutdatedSchema:
    """chat用のテーブルが無いDB（機能を足す前に作ったDB）の扱いと、マイグレーションSQLの確認"""

    def _drop_chat_tables(self, db):
        with db.get_cursor() as cursor:
            cursor.execute("DROP TABLE t_chat_message, t_chat_session")

    def _apply(self, db, path: Path):
        with db.get_cursor() as cursor:
            cursor.execute(path.read_text(encoding="utf-8"))

    def test_missing_tables_return_503_that_says_what_to_do(self, client, db):
        self._drop_chat_tables(db)
        try:
            response = client.get("/chat/sessions")

            assert response.status_code == 503
            assert "database/migrations" in response.json()["detail"]
        finally:
            self._apply(db, MIGRATION_SQL_PATH)

    def test_migration_creates_the_tables_and_is_safe_to_run_twice(self, client, db):
        self._drop_chat_tables(db)

        self._apply(db, MIGRATION_SQL_PATH)
        self._apply(db, MIGRATION_SQL_PATH)

        session_id = _create_session(client)["session_id"]
        assert [m["role"] for m in _messages(client, session_id)] == []
        assert _ask(client, session_id)[-1]["type"] == "done"
