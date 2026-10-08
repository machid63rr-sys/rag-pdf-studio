"""
ocr_rag/chat/question_parser.py のテスト
"""
import pytest

from ocr_rag.chat.question_parser import (
    find_mentioned_equipment_names, is_manual_request, resolve_equipment_name,
)


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

    # --- 別の語の一部としての出現は、書かれているとは数えない ---

    def test_a_name_inside_another_word_is_not_a_mention(self):
        # 短いタグ名「A」が、「AI」「PDF」に当たって、無関係な質問を絞り込まないようにする
        assert resolve_equipment_name("AIチャットの使い方は？", ["A", "B"]) is None
        assert resolve_equipment_name("PDFの出力方法", ["A", "F"]) is None

    def test_a_name_next_to_japanese_text_is_a_mention(self):
        assert resolve_equipment_name("Aの資料は？", ["A", "B"]) == "A"
        assert resolve_equipment_name("タグAについて教えて", ["A", "B"]) == "A"

    def test_a_name_that_is_a_prefix_of_a_longer_code_is_not_a_mention(self):
        assert resolve_equipment_name("ESP-10の点検周期は？", ["ESP-1", "ESP-10"]) == "ESP-10"
        assert resolve_equipment_name("ESP-10の点検周期は？", ["ESP-1"]) is None

    def test_a_name_inside_a_longer_registered_name_is_not_counted(self):
        # 「OHU-1.1」と書かれた質問は、「OHU-1」も書かれているとは数えない
        assert resolve_equipment_name("OHU-1.1の点検周期は？", ["OHU-1", "OHU-1.1"]) == "OHU-1.1"

    def test_ignores_case_and_full_width_characters(self):
        assert resolve_equipment_name("esp-1の点検周期は？", ["ESP-1", "ESP-2"]) == "ESP-1"
        assert resolve_equipment_name("ＥＳＰ－１の点検周期は？", ["ESP-1", "ESP-2"]) == "ESP-1"
        # 登録が全角でも、質問の半角に当たる。返すのは、登録されている表記
        assert resolve_equipment_name("ESP-1の点検周期は？", ["ＥＳＰ－１", "ＥＳＰ－２"]) == "ＥＳＰ－１"

    def test_japanese_names_match_as_substrings(self):
        assert resolve_equipment_name("1号ポンプの点検は？", ["1号ポンプ", "2号ポンプ"]) == "1号ポンプ"


class TestFindMentionedEquipmentNames:
    CANDIDATES = ["AHU-1", "ESP-1", "ESP-2", "OHU-1", "OHU-1.1"]

    def test_returns_every_name_written_in_the_question(self):
        # resolve_equipment_nameは、複数あるとNone（1つに絞れない）。こちらは全部返す
        found = find_mentioned_equipment_names("ESP-1とESP-2の違いは？", self.CANDIDATES)

        assert sorted(found) == ["ESP-1", "ESP-2"]

    def test_returns_the_registered_spelling_not_the_one_in_the_question(self):
        assert find_mentioned_equipment_names("esp-1について", self.CANDIDATES) == ["ESP-1"]

    def test_falls_back_to_all_prefix_matches_when_no_name_is_written(self):
        # resolve_equipment_nameは、複数に当たるとNone。こちらは「OHUの資料」として、両方を返す
        assert sorted(find_mentioned_equipment_names("OHUについて", self.CANDIDATES)) == ["OHU-1", "OHU-1.1"]

    def test_prefers_written_names_over_prefix_matches(self):
        assert find_mentioned_equipment_names("ESP-1とOHUの関係", self.CANDIDATES) == ["ESP-1"]

    def test_returns_nothing_when_no_name_is_mentioned(self):
        assert find_mentioned_equipment_names("ポンプの異常振動の原因は？", self.CANDIDATES) == []
        assert find_mentioned_equipment_names("ESP-1の点検", []) == []

    def test_ignores_blank_candidates(self):
        assert find_mentioned_equipment_names("何か 質問", ["", " ", "ESP-1"]) == []
