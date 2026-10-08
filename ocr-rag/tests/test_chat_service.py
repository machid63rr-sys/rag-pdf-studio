"""
ocr_rag/chat/chat_service.py のテスト

検索は実DB（ダミーの埋め込み）で、Ollamaの呼び出しだけを偽物にして確認する。
検索クエリの埋め込みは[1,0,0,...]に固定し、登録済みチャンクの類似度は
tests/helpers.fake_embeddingで厳密に指定する。
"""
import json

import pytest
import requests

from ocr_rag.chat.chat_service import (
    CHAT_SYSTEM_PROMPT, MANUAL_REQUEST_PROMPT, NO_EVIDENCE_ANSWER, ChatService, EmptyAnswerError,
)
from ocr_rag.ocr.vision_correction import DEFAULT_VISION_NUM_CTX
from tests.helpers import fake_embedding, insert_manual_chunk, insert_manual_pdf


def _chunks(service, question="質問", session_equipment_name=None, relax_threshold=False):
    return service._fetch_manual_chunks(question, session_equipment_name, relax_threshold)


class TestFetchManualChunks:
    def test_returns_chunks_in_the_shape_shown_on_screen(self, chat_service, db):
        document_id = insert_manual_chunk(db, "ESP-1", "点検の手順", fake_embedding(0.9))

        chunks = _chunks(chat_service)

        assert chunks == [{
            'document_title': "ESP-1", 'document_id': str(document_id),
            'similarity': pytest.approx(0.9, abs=1e-4), 'content': "点検の手順", 'has_pdf': False,
        }]

    def test_marks_which_documents_have_an_original_pdf(self, chat_service, db):
        with_pdf = insert_manual_chunk(db, "原本あり", "内容", fake_embedding(0.9))
        insert_manual_chunk(db, "原本なし", "内容", fake_embedding(0.8))
        insert_manual_pdf(db, with_pdf)

        chunks = _chunks(chat_service)

        assert {c['document_title']: c['has_pdf'] for c in chunks} == {"原本あり": True, "原本なし": False}

    def test_drops_chunks_below_the_relevance_threshold(self, chat_service, db):
        # 境界は、単精度の丸め（pgvector）を避けて、わずかに上と下で確かめる
        insert_manual_chunk(db, "関連あり", "内容", fake_embedding(0.6))
        insert_manual_chunk(db, "しきい値の少し上", "内容", fake_embedding(ChatService.RELEVANCE_THRESHOLD + 0.01))
        insert_manual_chunk(db, "しきい値の少し下", "内容", fake_embedding(ChatService.RELEVANCE_THRESHOLD - 0.01))
        insert_manual_chunk(db, "関連が低い", "内容", fake_embedding(0.3))

        chunks = _chunks(chat_service)

        assert [c['document_title'] for c in chunks] == ["関連あり", "しきい値の少し上"]

    def test_relaxing_the_threshold_keeps_low_relevance_chunks(self, chat_service, db):
        insert_manual_chunk(db, "関連が低い", "内容", fake_embedding(0.3))

        chunks = _chunks(chat_service, relax_threshold=True)

        assert [c['document_title'] for c in chunks] == ["関連が低い"]

    def test_returns_at_most_the_reference_limit(self, chat_service, db):
        for i in range(ChatService.MAX_MANUAL_REFERENCES + 3):
            insert_manual_chunk(db, f"マニュアル{i}", "内容", fake_embedding(0.9))

        assert len(_chunks(chat_service)) == ChatService.MAX_MANUAL_REFERENCES

    def test_returns_no_chunks_when_nothing_is_registered(self, chat_service):
        assert _chunks(chat_service) == []

    def test_a_search_failure_is_raised_not_hidden(self, chat_service, monkeypatch):
        def failing_search(*args, **kwargs):
            raise requests.ConnectionError("ollama down")

        monkeypatch.setattr(chat_service.retriever, "search", failing_search)

        with pytest.raises(requests.ConnectionError, match="ollama down"):
            _chunks(chat_service)

    def _register_two_machines(self, db):
        insert_manual_chunk(db, "ESP-1", "内容", fake_embedding(0.9), equipment_names=["ESP-1"])
        insert_manual_chunk(db, "ESP-2", "内容", fake_embedding(0.9), equipment_names=["ESP-2"])
        insert_manual_chunk(db, "汎用", "内容", fake_embedding(0.9))

    def _titles(self, chunks):
        return {c['document_title'] for c in chunks}

    def test_equipment_name_in_question_narrows_the_search(self, chat_service, db):
        self._register_two_machines(db)

        result = _chunks(chat_service, question="ESP-1の点検周期は？")

        assert self._titles(result) == {"ESP-1", "汎用"}

    def test_session_equipment_name_is_used_when_question_names_none(self, chat_service, db):
        self._register_two_machines(db)

        result = _chunks(chat_service, question="点検周期は？", session_equipment_name="ESP-2")

        assert self._titles(result) == {"ESP-2", "汎用"}

    def test_equipment_name_in_question_wins_over_the_session_one(self, chat_service, db):
        self._register_two_machines(db)

        result = _chunks(chat_service, question="ESP-1の点検周期は？", session_equipment_name="ESP-2")

        assert self._titles(result) == {"ESP-1", "汎用"}

    def test_searches_all_machines_without_any_equipment_name(self, chat_service, db):
        self._register_two_machines(db)

        assert self._titles(_chunks(chat_service, question="点検周期は？")) == {"ESP-1", "ESP-2", "汎用"}


class TestBuildManualContext:
    def _chunk(self, similarity=0.8, title="ESP-1", content="本文"):
        return {'document_title': title, 'similarity': similarity, 'content': content}

    def test_lists_each_chunk_with_title_and_similarity(self):
        text = ChatService._build_manual_context([
            self._chunk(0.8, "ESP-1", "点検の手順"), self._chunk(0.6, "ESP-2", "清掃の手順"),
        ])

        assert "【関連資料の抜粋（類似度上位2件）】" in text
        assert "1. 『ESP-1』（類似度 0.80）\n   点検の手順" in text
        assert "2. 『ESP-2』（類似度 0.60）\n   清掃の手順" in text
        assert "関連度が低く" not in text

    def test_warns_the_model_when_even_the_best_chunk_is_low_relevance(self):
        text = ChatService._build_manual_context([self._chunk(0.3), self._chunk(0.2)])

        assert "関連度が低く（最高でも類似度0.30）" in text
        assert "直接該当する記載がない" in text


class TestBuildMessages:
    def test_puts_prompt_and_excerpts_in_system_then_history_then_the_question(self, chat_service):
        history = [{'role': 'user', 'content': "前の質問"}, {'role': 'assistant', 'content': "前の回答"}]

        messages = chat_service._build_messages(history, "今回の質問", "【関連マニュアル抜粋】")

        assert messages[0]['role'] == 'system'
        assert messages[0]['content'] == f"{CHAT_SYSTEM_PROMPT}\n\n【関連マニュアル抜粋】"
        assert messages[1:] == [
            {'role': 'user', 'content': "前の質問"},
            {'role': 'assistant', 'content': "前の回答"},
            {'role': 'user', 'content': "今回の質問"},
        ]

    def test_adds_the_direct_manual_request_instructions_only_for_such_questions(self, chat_service):
        normal = chat_service._build_messages([], "質問", "抜粋")[0]['content']
        direct = chat_service._build_messages([], "質問", "抜粋", manual_request=True)[0]['content']

        assert MANUAL_REQUEST_PROMPT not in normal
        assert direct == f"{CHAT_SYSTEM_PROMPT}{MANUAL_REQUEST_PROMPT}\n\n抜粋"

    def test_prompts_do_not_limit_the_subject_to_one_industry(self):
        for prompt in (CHAT_SYSTEM_PROMPT, MANUAL_REQUEST_PROMPT, NO_EVIDENCE_ANSWER):
            assert "空調" not in prompt
            assert "保守" not in prompt

    def test_works_without_history(self, chat_service):
        messages = chat_service._build_messages([], "質問", "抜粋")

        assert [m['role'] for m in messages] == ['system', 'user']

    def test_keeps_only_the_most_recent_messages_within_the_history_budget(self):
        budget = ChatService.MAX_HISTORY_CHARS
        history = [
            {'role': 'user', 'content': "古い" * budget},
            {'role': 'assistant', 'content': "新しい回答" },
            {'role': 'user', 'content': "新しい質問"},
        ]

        trimmed = ChatService._trim_history(history)

        assert [m['content'] for m in trimmed] == ["新しい回答", "新しい質問"]

    def test_always_keeps_the_latest_message_even_if_it_exceeds_the_budget(self):
        history = [{'role': 'user', 'content': "あ" * (ChatService.MAX_HISTORY_CHARS * 2)}]

        assert ChatService._trim_history(history) == history


class _FakeResponse:
    """requests.post(stream=True)の戻り値の偽物"""

    def __init__(self, lines):
        self._lines = lines
        self.closed = False

    def raise_for_status(self):
        pass

    def iter_lines(self):
        yield from self._lines

    def close(self):
        self.closed = True


def _ndjson(*events):
    return [json.dumps(event).encode() for event in events]


class TestCallLlmStream:
    def _service(self, db, api_retriever):
        # この群は、LLMの偽物に差し替えない（requests.postを差し替えて、Ollamaへの要求を確認する）
        return ChatService(db, api_retriever, ollama_host="http://fake-ollama:11434", chat_model="qwen-test")

    def test_yields_the_deltas_and_asks_ollama_for_a_free_text_stream(self, db, api_retriever, monkeypatch):
        captured = {}
        response = _FakeResponse(_ndjson(
            {"message": {"content": "自由文"}, "done": False},
            {"message": {"content": "の回答です"}, "done": False},
            {"message": {"content": ""}, "done": True},
        ))

        def fake_post(url, json=None, timeout=None, stream=None):
            captured.update(url=url, json=json, timeout=timeout, stream=stream)
            return response

        monkeypatch.setattr(requests, "post", fake_post)
        messages = [{"role": "system", "content": "sys"}, {"role": "user", "content": "usr"}]

        result = list(self._service(db, api_retriever)._call_llm_stream(messages))

        assert result == ["自由文", "の回答です"]
        assert captured["url"] == "http://fake-ollama:11434/api/chat"
        assert captured["stream"] is True
        body = captured["json"]
        assert (body["model"], body["messages"], body["stream"]) == ("qwen-test", messages, True)
        assert body["think"] is False
        assert "format" not in body  # 自由文の回答には、JSON Schemaの制約をかけない
        # OCRの主文と同じコンテキスト長（違うと、Ollamaがモデルをロードし直す）
        assert body["options"]["num_ctx"] == DEFAULT_VISION_NUM_CTX
        assert response.closed is True

    def test_closes_the_connection_when_the_generator_is_closed_midway(self, db, api_retriever, monkeypatch):
        response = _FakeResponse(_ndjson(
            {"message": {"content": "一"}, "done": False}, {"message": {"content": "二"}, "done": False},
        ))
        monkeypatch.setattr(requests, "post", lambda *args, **kwargs: response)
        stream = self._service(db, api_retriever)._call_llm_stream([{"role": "user", "content": "u"}])

        assert next(stream) == "一"
        stream.close()

        assert response.closed is True

    def test_propagates_request_failures(self, db, api_retriever, monkeypatch):
        def fake_post(*args, **kwargs):
            raise requests.ConnectionError("connection refused")

        monkeypatch.setattr(requests, "post", fake_post)

        with pytest.raises(requests.RequestException):
            list(self._service(db, api_retriever)._call_llm_stream([{"role": "user", "content": "u"}]))


class TestAskStream:
    def test_streams_references_then_deltas_then_done(self, chat_service, db, fake_llm):
        insert_manual_chunk(db, "ESP-1", "点検の手順", fake_embedding(0.9))

        events = list(chat_service.ask_stream("点検の手順は？", None, []))

        assert [e['type'] for e in events] == ['manual_references', 'delta', 'delta', 'done']
        assert events[0]['manual_references'][0]['document_title'] == "ESP-1"
        assert events[-1]['full_text'] == "これは回答です。"
        assert events[-1]['manual_references'] == events[0]['manual_references']

    def test_gives_the_model_the_excerpts_the_history_and_the_question(self, chat_service, db, fake_llm):
        insert_manual_chunk(db, "ESP-1", "点検の手順", fake_embedding(0.9))
        history = [{'role': 'user', 'content': "前の質問"}, {'role': 'assistant', 'content': "前の回答"}]

        list(chat_service.ask_stream("点検の手順は？", None, history))

        messages = fake_llm.calls[0]
        assert "『ESP-1』" in messages[0]['content'] and "点検の手順" in messages[0]['content']
        assert MANUAL_REQUEST_PROMPT not in messages[0]['content']
        assert [m['content'] for m in messages[1:]] == ["前の質問", "前の回答", "点検の手順は？"]

    def test_without_relevant_chunks_it_answers_no_entry_and_does_not_call_the_model(
        self, chat_service, db, fake_llm
    ):
        insert_manual_chunk(db, "無関係", "内容", fake_embedding(0.2))

        events = list(chat_service.ask_stream("無関係な質問", None, []))

        # 根拠が無いのに回答を作らせない（実モデルは、指示しても架空の回答を作った）
        assert fake_llm.calls == []
        assert [e['type'] for e in events] == ['manual_references', 'delta', 'done']
        assert events[0]['manual_references'] is None
        assert events[1]['text'] == NO_EVIDENCE_ANSWER
        assert events[-1] == {'type': 'done', 'full_text': NO_EVIDENCE_ANSWER, 'manual_references': None}

    def test_nothing_registered_also_answers_no_entry(self, chat_service, fake_llm):
        events = list(chat_service.ask_stream("質問", None, []))

        assert fake_llm.calls == []
        assert events[-1]['full_text'] == NO_EVIDENCE_ANSWER

    def test_direct_manual_request_keeps_low_relevance_chunks_and_adds_its_instructions(
        self, chat_service, db, fake_llm
    ):
        insert_manual_chunk(db, "ESP-1", "内容", fake_embedding(0.3))

        events = list(chat_service.ask_stream("ESP-1のマニュアルを見せて", None, []))

        assert events[0]['manual_references'][0]['document_title'] == "ESP-1"
        system = fake_llm.calls[0][0]['content']
        assert MANUAL_REQUEST_PROMPT in system
        assert "関連度が低く" in system

    def test_a_search_failure_is_raised_and_the_model_is_not_asked_to_improvise(
        self, chat_service, fake_llm, monkeypatch
    ):
        def failing_search(*args, **kwargs):
            raise requests.ConnectionError("ollama down")

        monkeypatch.setattr(chat_service.retriever, "search", failing_search)

        with pytest.raises(requests.ConnectionError):
            list(chat_service.ask_stream("質問", None, []))

        assert fake_llm.calls == []

    def test_empty_answer_is_an_error_not_a_saved_answer(self, chat_service, db, fake_llm):
        insert_manual_chunk(db, "ESP-1", "内容", fake_embedding(0.9))
        fake_llm.chunks = ["", "  "]

        with pytest.raises(EmptyAnswerError, match="空の回答"):
            list(chat_service.ask_stream("質問", None, []))

    def test_llm_failure_propagates_after_the_partial_answer(self, chat_service, db, fake_llm):
        insert_manual_chunk(db, "ESP-1", "内容", fake_embedding(0.9))
        fake_llm.error = requests.ConnectionError("ollama down")
        events = []

        with pytest.raises(requests.ConnectionError):
            for event in chat_service.ask_stream("質問", None, []):
                events.append(event)

        assert [e['type'] for e in events] == ['manual_references', 'delta', 'delta']

    def test_closing_the_stream_closes_the_llm_stream(self, chat_service, db, fake_llm):
        insert_manual_chunk(db, "ESP-1", "内容", fake_embedding(0.9))
        stream = chat_service.ask_stream("質問", None, [])
        next(stream)  # manual_references
        next(stream)  # 最初のdelta（LLMが開始される）
        assert fake_llm.closed is False

        stream.close()

        assert fake_llm.closed is True
