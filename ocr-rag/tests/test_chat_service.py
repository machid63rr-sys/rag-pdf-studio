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
    CHAT_SYSTEM_PROMPT, MANUAL_REQUEST_PROMPT, NO_EVIDENCE_ANSWER, TAG_REQUEST_PROMPT, ChatService, EmptyAnswerError,
    TagMatch,
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


class TestFetchTaggedChunks:
    """質問に書かれたタグ名の資料を、類似度に関わらず取り出す（通常の検索で根拠が0件のときの代わり）"""

    def test_finds_the_documents_with_the_tag_even_at_low_similarity(self, chat_service, db):
        document_id = insert_manual_chunk(db, "ABC", "点検の手順", fake_embedding(0.35), equipment_names=["A", "B", "C"])

        chunks = chat_service._fetch_tagged_chunks("タグAの資料は？", ["A"])

        assert chunks == [{
            'document_title': "ABC", 'document_id': str(document_id),
            'similarity': pytest.approx(0.35, abs=1e-4), 'content': "点検の手順", 'has_pdf': False,
        }]

    def test_only_documents_with_the_given_tags_are_returned(self, chat_service, db):
        insert_manual_chunk(db, "Aの資料", "内容", fake_embedding(0.3), equipment_names=["A"])
        insert_manual_chunk(db, "Bの資料", "内容", fake_embedding(0.3), equipment_names=["B"])
        insert_manual_chunk(db, "Cの資料", "内容", fake_embedding(0.3), equipment_names=["C"])
        insert_manual_chunk(db, "タグなしの資料", "内容", fake_embedding(0.9))

        chunks = chat_service._fetch_tagged_chunks("AとBについて", ["A", "B"])

        assert {c['document_title'] for c in chunks} == {"Aの資料", "Bの資料"}

    def test_returns_nothing_without_tag_names(self, chat_service, db):
        insert_manual_chunk(db, "Aの資料", "内容", fake_embedding(0.9), equipment_names=["A"])

        assert chat_service._fetch_tagged_chunks("質問", []) == []

    def test_a_search_failure_is_raised_not_hidden(self, chat_service, db, monkeypatch):
        insert_manual_chunk(db, "Aの資料", "内容", fake_embedding(0.3), equipment_names=["A"])

        def failing_search(*args, **kwargs):
            raise requests.ConnectionError("ollama down")

        monkeypatch.setattr(chat_service.retriever, "search_tagged", failing_search)

        with pytest.raises(requests.ConnectionError, match="ollama down"):
            chat_service._fetch_tagged_chunks("Aの資料は？", ["A"])


class TestTagNamesInQuestion:
    def test_returns_the_registered_tag_names_written_in_the_question(self, chat_service, db):
        insert_manual_chunk(db, "ABC", "内容", fake_embedding(0.9), equipment_names=["A", "B", "C"])

        assert sorted(chat_service._tag_names_in_question("AとCの資料を教えて")) == ["A", "C"]

    def test_a_tag_name_inside_another_word_is_not_a_mention(self, chat_service, db):
        insert_manual_chunk(db, "ABC", "内容", fake_embedding(0.9), equipment_names=["A", "B", "C"])

        assert chat_service._tag_names_in_question("AIの使い方は？") == []

    def test_returns_nothing_when_no_tags_are_registered(self, chat_service, db):
        insert_manual_chunk(db, "タグなしの資料", "内容", fake_embedding(0.9))

        assert chat_service._tag_names_in_question("Aの資料は？") == []


class TestDescribeTagMatch:
    def _chunk(self, document_id):
        return {'document_id': str(document_id)}

    def test_lists_every_tag_of_each_referenced_document_and_the_names_in_the_question(self, chat_service, db):
        with_tags = insert_manual_chunk(db, "ABC", "内容", fake_embedding(0.9), equipment_names=["A", "B", "C"])
        other = insert_manual_chunk(db, "D", "内容", fake_embedding(0.9), equipment_names=["D"])

        match = chat_service._describe_tag_match([self._chunk(with_tags), self._chunk(other)], ["A", "D"])

        assert match == TagMatch(
            names=["A", "D"], tags_by_document={str(with_tags): ["A", "B", "C"], str(other): ["D"]}
        )

    def test_names_that_no_referenced_document_carries_are_left_out(self, chat_service, db):
        with_tags = insert_manual_chunk(db, "ABC", "内容", fake_embedding(0.9), equipment_names=["A"])
        insert_manual_chunk(db, "Zの資料", "内容", fake_embedding(0.9), equipment_names=["Z"])

        match = chat_service._describe_tag_match([self._chunk(with_tags)], ["A", "Z"])

        assert match.names == ["A"]

    def test_is_none_when_only_untagged_documents_are_referenced(self, chat_service, db):
        untagged = insert_manual_chunk(db, "共通の資料", "内容", fake_embedding(0.9))

        assert chat_service._describe_tag_match([self._chunk(untagged)], ["A"]) is None

    def test_is_none_without_chunks_or_tag_names(self, chat_service, db):
        document_id = insert_manual_chunk(db, "ABC", "内容", fake_embedding(0.9), equipment_names=["A"])

        assert chat_service._describe_tag_match([], ["A"]) is None
        assert chat_service._describe_tag_match([self._chunk(document_id)], []) is None


class TestBuildManualContext:
    def _chunk(self, similarity=0.8, title="ESP-1", content="本文", document_id="doc-1"):
        return {'document_title': title, 'similarity': similarity, 'content': content, 'document_id': document_id}

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

    def test_tells_the_model_which_tags_were_named_and_lists_each_documents_tags(self):
        tag_match = TagMatch(names=["A"], tags_by_document={"doc-1": ["A", "B"], "doc-2": ["A"]})

        text = ChatService._build_manual_context(
            [self._chunk(0.8, "資料1", "本文1", "doc-1"), self._chunk(0.7, "資料2", "本文2", "doc-2")], tag_match
        )

        assert "タグ名「A」は、以下の資料に付けられています" in text
        assert "1. 『資料1』（タグ: A、B）（類似度 0.80）\n   本文1" in text
        assert "2. 『資料2』（タグ: A）（類似度 0.70）\n   本文2" in text
        # 類似度が十分に高いときは、「関連が低い」と注意しない
        assert "類似度は最高でも" not in text
        assert "関連度が低く" not in text

    def test_low_similarity_with_a_tag_match_warns_without_telling_the_model_to_deny(self):
        tag_match = TagMatch(names=["A"], tags_by_document={"doc-1": ["A"]})

        text = ChatService._build_manual_context([self._chunk(0.3)], tag_match)

        assert "質問との類似度は最高でも0.30" in text
        assert "直接該当する記載があるとは限りません" in text
        # 「記載がない旨を冒頭に書け」とは言わない（タグの資料があること自体が答えになるため）
        assert "関連度が低く" not in text
        assert "明記してください" not in text

    def test_names_every_tag_written_in_the_question(self):
        tag_match = TagMatch(names=["A", "B"], tags_by_document={})

        assert "タグ名「A」、「B」は、以下の資料に付けられています" in ChatService._build_manual_context(
            [self._chunk(0.3)], tag_match
        )

    def test_leaves_out_the_tag_label_for_a_document_whose_tags_are_unknown(self):
        tag_match = TagMatch(names=["A"], tags_by_document={})

        assert "1. 『ESP-1』（類似度 0.30）" in ChatService._build_manual_context([self._chunk(0.3)], tag_match)


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

    def test_adds_the_tag_instructions_only_when_the_excerpts_were_chosen_by_tag(self, chat_service):
        normal = chat_service._build_messages([], "質問", "抜粋")[0]['content']
        by_tag = chat_service._build_messages(
            [], "質問", "抜粋", tag_match=TagMatch(names=["A"], tags_by_document={})
        )[0]['content']

        assert TAG_REQUEST_PROMPT not in normal
        assert by_tag == f"{CHAT_SYSTEM_PROMPT}{TAG_REQUEST_PROMPT}\n\n抜粋"

    def test_prompts_do_not_limit_the_subject_to_one_industry(self):
        for prompt in (CHAT_SYSTEM_PROMPT, MANUAL_REQUEST_PROMPT, TAG_REQUEST_PROMPT, NO_EVIDENCE_ANSWER):
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

    def test_a_question_naming_only_a_tag_is_answered_from_the_documents_with_that_tag(
        self, chat_service, db, fake_llm
    ):
        # 実データでの再現: タグ名しか書かれていない質問は、類似度が足切り（0.45）に届かない
        document_id = insert_manual_chunk(
            db, "ABC", "点検の手順", fake_embedding(0.38), equipment_names=["A", "B", "C"]
        )

        events = list(chat_service.ask_stream("タグAの資料は？", None, []))

        assert [e['type'] for e in events] == ['manual_references', 'delta', 'delta', 'done']
        references = events[0]['manual_references']
        assert [r['document_title'] for r in references] == ["ABC"]
        assert references[0]['document_id'] == str(document_id)
        assert set(references[0]) == {'document_title', 'document_id', 'similarity', 'content', 'has_pdf'}
        system = fake_llm.calls[0][0]['content']
        assert TAG_REQUEST_PROMPT in system
        assert "タグ名「A」は、以下の資料に付けられています" in system
        assert "質問との類似度は最高でも0.38" in system
        assert "『ABC』（タグ: A、B、C）" in system
        assert events[-1]['full_text'] == "これは回答です。"
        assert events[-1]['manual_references'] == references

    def test_a_tag_name_is_matched_regardless_of_case_and_width(self, chat_service, db, fake_llm):
        insert_manual_chunk(db, "ESP-1の資料", "内容", fake_embedding(0.3), equipment_names=["ESP-1"])

        events = list(chat_service.ask_stream("ｅｓｐ-1について", None, []))

        assert events[0]['manual_references'][0]['document_title'] == "ESP-1の資料"
        assert len(fake_llm.calls) == 1

    def test_evidence_found_by_similarity_is_not_widened_by_the_tag_names(self, chat_service, db, fake_llm):
        insert_manual_chunk(db, "Aの資料", "点検の手順", fake_embedding(0.9), equipment_names=["A"])
        insert_manual_chunk(db, "Bの資料", "別の内容", fake_embedding(0.3), equipment_names=["B"])

        events = list(chat_service.ask_stream("Bの資料と、Aの点検の手順は？", None, []))

        # 類似度で見つかったAの資料だけが根拠。タグ名のBの資料は、足されない
        assert [r['document_title'] for r in events[0]['manual_references']] == ["Aの資料"]
        system = fake_llm.calls[0][0]['content']
        assert "Bの資料" not in system
        # 質問に書かれたAが、根拠の資料に付いているので、そのタグ名はLLMに伝える
        assert "タグ名「A」は、以下の資料に付けられています" in system
        assert "『Aの資料』（タグ: A）" in system

    def test_the_model_is_told_the_tag_even_when_the_evidence_was_found_by_similarity(
        self, chat_service, db, fake_llm
    ):
        # 実モデルは、これを伝えないと「Aという名称は資料に無い」と答えた
        insert_manual_chunk(db, "ABC", "電源の仕様", fake_embedding(0.6), equipment_names=["A", "B", "C"])

        list(chat_service.ask_stream("Aの電源電圧は？", None, []))

        system = fake_llm.calls[0][0]['content']
        assert TAG_REQUEST_PROMPT in system
        assert "『ABC』（タグ: A、B、C）" in system
        assert "類似度は最高でも" not in system  # 類似度は十分に高いので、注意書きは付けない

    def test_a_direct_manual_request_naming_a_tag_is_told_the_tag_instead_of_denying(
        self, chat_service, db, fake_llm
    ):
        insert_manual_chunk(db, "ABC", "内容", fake_embedding(0.3), equipment_names=["A", "B", "C"])

        events = list(chat_service.ask_stream("Cのマニュアルを見せて", None, []))

        assert events[0]['manual_references'][0]['document_title'] == "ABC"
        system = fake_llm.calls[0][0]['content']
        assert MANUAL_REQUEST_PROMPT in system and TAG_REQUEST_PROMPT in system
        assert "『ABC』（タグ: A、B、C）" in system
        # 「記載がない旨を冒頭に明記せよ」は、タグの資料があるのに矛盾するため、言わない
        assert "関連度が低く" not in system

    def test_no_tag_information_when_the_question_names_no_tag(self, chat_service, db, fake_llm):
        insert_manual_chunk(db, "ABC", "点検の手順", fake_embedding(0.9), equipment_names=["A", "B", "C"])

        list(chat_service.ask_stream("点検の手順は？", None, []))

        system = fake_llm.calls[0][0]['content']
        assert TAG_REQUEST_PROMPT not in system
        assert "タグ:" not in system

    def test_no_tag_information_when_the_tagged_documents_are_not_the_evidence(self, chat_service, db, fake_llm):
        # Bと書かれていても、根拠が、タグなしの共通の資料だけなら、タグ名の質問として扱わない
        insert_manual_chunk(db, "共通の資料", "点検の手順", fake_embedding(0.9))
        insert_manual_chunk(db, "Aの資料", "別の内容", fake_embedding(0.3), equipment_names=["A"])

        list(chat_service.ask_stream("Bの点検の手順は？", None, []))

        assert TAG_REQUEST_PROMPT not in fake_llm.calls[0][0]['content']

    def test_an_unrelated_question_still_gets_no_entry_even_with_tags_registered(
        self, chat_service, db, fake_llm
    ):
        insert_manual_chunk(db, "Aの資料", "内容", fake_embedding(0.2), equipment_names=["A"])

        events = list(chat_service.ask_stream("今日の天気は？", None, []))

        assert fake_llm.calls == []
        assert events[-1]['full_text'] == NO_EVIDENCE_ANSWER

    def test_a_tag_only_in_the_session_does_not_make_an_unrelated_question_answerable(
        self, chat_service, db, fake_llm
    ):
        insert_manual_chunk(db, "Aの資料", "内容", fake_embedding(0.2), equipment_names=["A"])

        events = list(chat_service.ask_stream("今日の天気は？", "A", []))

        assert fake_llm.calls == []
        assert events[-1]['full_text'] == NO_EVIDENCE_ANSWER

    def test_a_tag_name_inside_another_word_does_not_count_as_naming_the_tag(self, chat_service, db, fake_llm):
        insert_manual_chunk(db, "Aの資料", "内容", fake_embedding(0.2), equipment_names=["A"])

        events = list(chat_service.ask_stream("AIとは何ですか？", None, []))

        assert fake_llm.calls == []
        assert events[-1]['full_text'] == NO_EVIDENCE_ANSWER

    def test_a_tag_lookup_failure_is_raised_and_the_model_is_not_asked_to_improvise(
        self, chat_service, db, fake_llm, monkeypatch
    ):
        insert_manual_chunk(db, "Aの資料", "内容", fake_embedding(0.2), equipment_names=["A"])

        def failing_search(*args, **kwargs):
            raise requests.ConnectionError("ollama down")

        monkeypatch.setattr(chat_service.retriever, "search_tagged", failing_search)

        with pytest.raises(requests.ConnectionError):
            list(chat_service.ask_stream("Aの資料は？", None, []))

        assert fake_llm.calls == []

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
