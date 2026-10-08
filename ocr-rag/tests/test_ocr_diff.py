"""src/manuals/ocr_diff.py のテスト（純粋関数なのでユニットテストのみ）"""
from ocr_rag.ocr.ocr_diff import candidate_similarity, diff_page, normalize_for_diff


class TestNormalizeForDiff:
    def test_removes_leading_markdown_marks(self):
        assert normalize_for_diff("## 見出し") == "見出し"
        assert normalize_for_diff("| 列A | 列B |") == "列A 列B"

    def test_collapses_whitespace(self):
        assert normalize_for_diff("a   b\tc") == "a b c"

    def test_normalizes_fullwidth_to_halfwidth(self):
        # NFKC正規化で全角英数字は半角に統一される
        assert normalize_for_diff("ＡＢＣ１２３") == "ABC123"

    def test_blank_line_becomes_empty_string(self):
        assert normalize_for_diff("   ") == ""


class TestCandidateSimilarity:
    """補正LLMの出力が、候補を土台にした修正か、候補と無関係な文字列(文字化け)かを見分ける"""

    def test_same_text_is_1(self):
        assert candidate_similarity("圧縮機高圧異常", ["圧縮機高圧異常"]) == 1.0

    def test_whitespace_newline_and_markdown_marks_are_not_differences(self):
        # LLMは、候補を写すときに、空白・改行の位置を変えることがある
        assert candidate_similarity("SAMPLE 保持フレーム", ["SAMPLE\n保持フレーム\n"]) == 1.0
        assert candidate_similarity("# Description", ["Description\n"]) == 1.0

    def test_uses_the_closest_candidate(self):
        assert candidate_similarity("コントロラのバッテリ", ["コントローラのバッテリ", "コントロラのバッテリ"]) == 1.0

    def test_one_character_fix_stays_high(self):
        assert candidate_similarity("パネルの枚数により表面積が決まります。", ["バネルの枚数により表面積が決まります。"]) > 0.9

    def test_garbled_text_unrelated_to_candidates_is_low(self):
        """実機の図入りPDFで、正しく読めていた表を置き換えた文字化けの例(内容は、一般的な語に置き換えてある)"""
        garbled = "©ネルeリ角\n.................................. ネルeン貤"
        primary = "| 対策 | | --- | --- | | ①パネルの損傷 ………………………………パネルを取り替える | | ②シールが破損または変形 …………………シール を取り替える"
        alt = "① パネルの損傷………………………………パネルを取り替える\n② シールが破損または変形………………………………シールを取り替える\n"
        assert candidate_similarity(garbled, [primary, alt]) < 0.5

    def test_no_candidates_is_0(self):
        assert candidate_similarity("何か", []) == 0.0


class TestDiffPage:
    """
    2026-09-29(3): 低信頼度検出はtesseractとの比較からGLM-OCR自体を異なる
    temperature/seedで2回実行してのdiffに変更した(tesseractの日本語認識精度が
    低く、GLM-OCRが正しく読めている箇所まで軒並み要確認扱いになっていたため)。

    2026-09-29(2): 行単位diffだと改行位置の違いだけでページ全体が1つの巨大な
    不一致ブロックになってしまい「間違った箇所だけ抜粋する」という目的を
    果たせなかった。単語単位diffに変更し、実際に食い違っている単語だけを
    小さく抜粋できることを確認するテスト群。
    """

    def test_identical_text_is_all_match(self):
        text = "見出し\n本文1行目"
        segments = diff_page(text, text)
        assert all(s.is_match for s in segments)

    def test_detects_only_the_mismatched_word_not_whole_line(self):
        """1つの単語だけが違う場合、一致した単語まで巻き込んで不一致にしない"""
        glm = "R-1温度は25.0度です"
        glm_alt = "R-1温度は2S.0度です"
        segments = diff_page(glm, glm_alt)

        mismatches = [s for s in segments if not s.is_match]
        assert len(mismatches) == 1
        assert mismatches[0].glm_text == "R-1温度は25.0度です"  # 単語境界が無い日本語文なので1トークン扱い

    def test_detects_mismatched_word_in_multiword_line(self):
        """英数字を含み単語区切りがある行では、食い違った単語だけが抜粋される"""
        glm = "code 05 broken wire"
        glm_alt = "code 05 broker wire"
        segments = diff_page(glm, glm_alt)

        matches = [s for s in segments if s.is_match]
        mismatches = [s for s in segments if not s.is_match]
        assert len(mismatches) == 1
        assert mismatches[0].glm_text.strip() == "broken"
        assert mismatches[0].glm_alt_text.strip() == "broker"
        # 前後の一致した単語("code 05"/"wire")は巻き込まれず別セグメントのまま
        assert any("code" in s.glm_text for s in matches)
        assert any("wire" in s.glm_text for s in matches)

    def test_ignores_markdown_formatting_noise(self):
        """表Markdownと表でないプレーンテキストで、内容が同じなら一致扱いにする"""
        glm = "| R-1温度 | 25.0 |"
        glm_alt = "R-1温度  25.0"
        segments = diff_page(glm, glm_alt)

        assert all(s.is_match for s in segments)

    def test_concatenating_all_segments_reconstructs_original_text(self):
        """
        segmentのglm_textを順番に連結するだけで元テキストを過不足なく再構成できる
        （最終的なdraft_markdown組み立てがこの性質に依存している、ocr_pipeline.py参照）
        """
        glm = "# 見出し\n\n本文です。詳細は下記の通り。\n\n| 列A | 列B |\n| 05 | 破損 |"
        glm_alt = "見出し\n本文です。詳細は下記の通り。\n05 破損"
        segments = diff_page(glm, glm_alt)

        assert "".join(s.glm_text for s in segments) == glm

    def test_segment_ids_are_sequential(self):
        segments = diff_page("code 05 broken", "code 05 broker")
        assert [s.segment_id for s in segments] == [f"seg-{i}" for i in range(len(segments))]
