"""ocr_rag/ocr/correction_recheck.py のテスト(補正の再チェック: PDFのテキスト層・日本語としての自然さ)"""
import json

import pytest
import requests

from ocr_rag.ocr import correction_recheck
from ocr_rag.ocr.correction_recheck import (
    BASIS_LANGUAGE,
    BASIS_NONE,
    BASIS_TEXT_LAYER,
    RecheckItem,
    recheck_corrections,
)

ITEM = RecheckItem(segment_id="seg-0", primary="# 4.5【点検について】", chosen="# 4.5【点検ついて】", before="", after="定期的に点検を行い")


class _Response:
    def __init__(self, content):
        self._content = content

    def raise_for_status(self):
        pass

    def json(self):
        return {"message": {"content": self._content}}


def _judgments(*pairs):
    return json.dumps({"judgments": [{"segment_id": sid, "better": better, "reason": "理由"} for sid, better in pairs]}, ensure_ascii=False)


def _llm(monkeypatch, *contents):
    """requests.postの偽実装。呼ばれた順に、contentsを返す。送られたリクエストの中身を、リストで返す"""
    sent = []
    queue = list(contents)

    def _post(url, json=None, timeout=None):
        sent.append(json)
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return _Response(item)

    monkeypatch.setattr(correction_recheck.requests, "post", _post)
    return sent


class TestLanguageRecheck:
    def test_cancels_the_correction_only_when_both_orders_say_the_primary_is_better(self, monkeypatch):
        # 1回目: 表記1=主文 → 「1」が主文。2回目: 並びを入れ替え(表記1=補正後)→ 「2」が主文
        sent = _llm(monkeypatch, _judgments(("seg-0", "1")), _judgments(("seg-0", "2")))

        verdict = recheck_corrections([ITEM], None, "http://ollama")["seg-0"]

        assert verdict.keep_chosen is False and verdict.basis == BASIS_LANGUAGE
        first_prompt = sent[0]["messages"][1]["content"]
        second_prompt = sent[1]["messages"][1]["content"]
        assert "表記1: # 4.5【点検について】" in first_prompt and "表記2: # 4.5【点検ついて】" in first_prompt
        assert "表記1: # 4.5【点検ついて】" in second_prompt and "表記2: # 4.5【点検について】" in second_prompt
        assert "images" not in sent[0]["messages"][1]  # 画像は使わない(補正LLMと同じ根拠で、同じ誤りを繰り返さないため)
        assert sent[0]["options"]["temperature"] == 0.0

    def test_keeps_the_correction_when_the_two_orders_disagree(self, monkeypatch):
        # 毎回「表記1」を選ぶ(並び順の偏り)なら、判断できていない。補正は取り消さない
        _llm(monkeypatch, _judgments(("seg-0", "1")), _judgments(("seg-0", "1")))
        assert recheck_corrections([ITEM], None, "http://ollama")["seg-0"].keep_chosen is True

    def test_keeps_the_correction_when_the_chosen_is_better_or_equal(self, monkeypatch):
        _llm(monkeypatch, _judgments(("seg-0", "2")), _judgments(("seg-0", "1")))  # 2回とも補正後が正しい
        assert recheck_corrections([ITEM], None, "http://ollama")["seg-0"].keep_chosen is True
        _llm(monkeypatch, _judgments(("seg-0", "equal")), _judgments(("seg-0", "equal")))
        assert recheck_corrections([ITEM], None, "http://ollama")["seg-0"].keep_chosen is True

    def test_missing_judgment_does_not_cancel(self, monkeypatch):
        _llm(monkeypatch, _judgments(("seg-0", "1")), _judgments())
        verdict = recheck_corrections([ITEM], None, "http://ollama")["seg-0"]
        assert verdict.keep_chosen is True and verdict.basis == BASIS_NONE

    def test_connection_failure_keeps_the_correction_and_says_it_was_not_checked(self, monkeypatch):
        sent = _llm(monkeypatch, requests.ConnectionError("down"))
        verdict = recheck_corrections([ITEM], None, "http://ollama")["seg-0"]
        assert verdict.keep_chosen is True and verdict.basis == BASIS_NONE
        assert len(sent) == 1  # 接続できないなら、2回目は聞かない

    def test_malformed_response_is_retried_then_gives_up_without_cancelling(self, monkeypatch):
        sent = _llm(monkeypatch, "not json", "{}")
        verdict = recheck_corrections([ITEM], None, "http://ollama")["seg-0"]
        assert verdict.keep_chosen is True and verdict.basis == BASIS_NONE
        # 形式不正は、1回だけやり直す。1回目の問い合わせが失敗したなら、並びを入れ替えた2回目は、聞かない
        assert len(sent) == 2

    def test_context_is_included_in_the_prompt(self, monkeypatch):
        sent = _llm(monkeypatch, _judgments(("seg-0", "equal")), _judgments(("seg-0", "equal")))
        recheck_corrections([ITEM], None, "http://ollama")
        assert "後の文脈: 定期的に点検を行い…" in sent[0]["messages"][1]["content"]

    def test_no_items_makes_no_call(self, monkeypatch):
        sent = _llm(monkeypatch)
        assert recheck_corrections([], "text", "http://ollama") == {}
        assert sent == []


class TestTextLayerRecheck:
    LAYER = "4.5【点検について】定期的に点検を行い、結果を記録します。"

    def test_chosen_only_in_layer_confirms_without_calling_the_llm(self, monkeypatch):
        sent = _llm(monkeypatch)
        item = RecheckItem("seg-0", primary="# 4.5【点検ついて】", chosen="# 4.5【点検について】", before="", after="")
        verdict = recheck_corrections([item], self.LAYER, "http://ollama")["seg-0"]
        assert verdict.keep_chosen is True and verdict.basis == BASIS_TEXT_LAYER
        assert sent == []

    def test_primary_only_in_layer_cancels_without_calling_the_llm(self, monkeypatch):
        sent = _llm(monkeypatch)
        verdict = recheck_corrections([ITEM], self.LAYER, "http://ollama")["seg-0"]
        assert verdict.keep_chosen is False and verdict.basis == BASIS_TEXT_LAYER
        assert sent == []

    def test_neither_in_layer_falls_back_to_the_language_check(self, monkeypatch):
        sent = _llm(monkeypatch, _judgments(("seg-0", "equal")), _judgments(("seg-0", "equal")))
        item = RecheckItem("seg-0", primary="# 全く別の主文です", chosen="# 全く別の補正後です", before="", after="")
        verdict = recheck_corrections([item], self.LAYER, "http://ollama")["seg-0"]
        assert verdict.basis == BASIS_LANGUAGE and len(sent) == 2

    def test_both_in_layer_falls_back_to_the_language_check(self, monkeypatch):
        sent = _llm(monkeypatch, _judgments(("seg-0", "equal")), _judgments(("seg-0", "equal")))
        item = RecheckItem("seg-0", primary="定期的に点検", chosen="結果を記録", before="", after="")
        recheck_corrections([item], self.LAYER, "http://ollama")
        assert len(sent) == 2

    def test_only_undecided_items_are_sent_to_the_llm(self, monkeypatch):
        sent = _llm(monkeypatch, _judgments(("seg-1", "equal")), _judgments(("seg-1", "equal")))
        decided = RecheckItem("seg-0", primary="# 4.5【点検ついて】", chosen="# 4.5【点検について】", before="", after="")
        undecided = RecheckItem("seg-1", primary="# 全く別の主文です", chosen="# 全く別の補正後です", before="", after="")
        verdicts = recheck_corrections([decided, undecided], self.LAYER, "http://ollama")
        assert verdicts["seg-0"].basis == BASIS_TEXT_LAYER
        assert "seg-0" not in sent[0]["messages"][1]["content"] and "seg-1" in sent[0]["messages"][1]["content"]
