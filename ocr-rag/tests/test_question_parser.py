"""
ocr_rag/chat/question_parser.py のテスト
"""
import pytest

from ocr_rag.chat.question_parser import is_manual_request, resolve_equipment_name


class TestIsManualRequest:
    @pytest.mark.parametrize("question", [
        "ESP-1のマニュアルを見せて", "取説はある？", "取扱説明書を表示して", "AHU-1の説明書はありますか",
    ])
    def test_true_for_direct_requests_about_the_manual_itself(self, question):
        assert is_manual_request(question) is True

    @pytest.mark.parametrize("question", ["ポンプの異常振動の原因は？", "E011の対処方法", ""])
    def test_false_for_questions_about_the_content(self, question):
        assert is_manual_request(question) is False


class TestResolveEquipmentName:
    CANDIDATES = ["AHU-1", "ESP-1", "ESP-2", "OHU-1", "OHU-1.1"]

    def test_resolves_exact_name_in_question(self):
        assert resolve_equipment_name("ESP-1の点検周期は？", self.CANDIDATES) == "ESP-1"

    def test_returns_none_when_question_mentions_several_names(self):
        assert resolve_equipment_name("ESP-1とESP-2の違いは？", self.CANDIDATES) is None

    def test_returns_none_when_no_name_is_mentioned(self):
        assert resolve_equipment_name("ポンプの異常振動の原因は？", self.CANDIDATES) is None

    def test_resolves_by_unique_prefix_when_no_exact_match(self):
        assert resolve_equipment_name("AHUの調子が悪い", self.CANDIDATES) == "AHU-1"

    def test_prefix_is_case_insensitive(self):
        assert resolve_equipment_name("ahuの調子が悪い", self.CANDIDATES) == "AHU-1"

    def test_returns_none_when_prefix_matches_several_names(self):
        assert resolve_equipment_name("ESPの調子が悪い", self.CANDIDATES) is None

    def test_ignores_tokens_shorter_than_three_characters(self):
        # 「ES」だけで、ESP-1・ESP-2に当てはまってしまわないようにする
        assert resolve_equipment_name("ESの調子", ["ESP-1"]) is None

    def test_ignores_blank_candidates(self):
        assert resolve_equipment_name("何か質問", ["", "ESP-1"]) is None

    def test_returns_none_without_candidates(self):
        assert resolve_equipment_name("ESP-1の点検", []) is None
