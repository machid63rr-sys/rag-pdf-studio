"""
src/manuals/ocr_pipeline.py のテスト

低レベルのOCR/vision呼び出し（ocr_full_page_with_vision_llm, ocr_with_glm,
correct_page_with_vision_llm, verify_full_page_ocr_with_vision_llm）は
monkeypatchで差し替え、オーケストレーションロジック（主文・比較材料の選択、
ページ数・セグメント数、最終Markdown組み立て）のみを検証する。
実OCR/実LLM呼び出しはしない。

2026-09-30(12)決定: 主文はvision LLM(temperature=0のフルページOCR)、比較候補は
GLM-OCR(1回実行)。ocr_full_page_with_vision_llmのモックはtemperature引数で
1回目(主文、既定0.0)/2回目(自己比較用、ocr_pipeline.VISION_ALT_TEMPERATURE)の
呼び分けができるようにしている。
"""
import pytest

from ocr_rag.ocr import correction_recheck, ocr_pipeline
from ocr_rag.ocr.correction_recheck import BASIS_LANGUAGE, BASIS_NONE, RecheckVerdict
from ocr_rag.ocr.vision_correction import MISSING_JUDGMENT_REASON, VisionCorrectionResult


def _fake_convert_pdf_to_images(pdf_path, output_dir, dpi=300, password=None):
    images = []
    for name in ("page-1.png", "page-2.png"):
        p = output_dir / name
        p.touch()
        images.append(p)
    return images


def _vision_ocr_by_temperature(mapping):
    """temperature引数で主文(既定0.0)/自己比較用(VISION_ALT_TEMPERATURE)の
    戻り値を出し分けるocr_full_page_with_vision_llmの偽実装"""
    def _fake(image_path, host, model=None, timeout_seconds=None, temperature=0.0, seed=1):
        return mapping[temperature]
    return _fake


def _glm_returns(text, is_complete=True):
    def _fake(image_path, host, model=None, timeout_seconds=None, temperature=0.0, seed=1):
        return text, is_complete
    return _fake


def _keep_all_corrections(items, page_text, ollama_host, model=None, timeout_seconds=None):
    """補正の再チェックの偽実装(既定): 何も取り消さない。実際のLLM・PDFには接続しない"""
    return {item.segment_id: RecheckVerdict(item.segment_id, True, BASIS_NONE, "") for item in items}


def _setup(monkeypatch, vision_mapping, glm=("", True), page_texts=None):
    monkeypatch.setattr(ocr_pipeline, "convert_pdf_to_images", _fake_convert_pdf_to_images)
    monkeypatch.setattr(ocr_pipeline, "ocr_full_page_with_vision_llm", _vision_ocr_by_temperature(vision_mapping))
    monkeypatch.setattr(ocr_pipeline, "ocr_with_glm", _glm_returns(*glm))
    # PDFのテキスト層の取り出しと、補正の再チェックは、既定では、外部(pdftotext・LLM)を使わない偽実装にする
    monkeypatch.setattr(ocr_pipeline, "extract_page_texts", lambda *a, **k: page_texts)
    monkeypatch.setattr(ocr_pipeline, "recheck_corrections", _keep_all_corrections)


def _fix_first_mismatch(corrected_text):
    def _fake_correct(image_path, segments, ollama_host, model=None, timeout_seconds=None):
        mismatched = [s for s in segments if not s.is_match]
        return [
            VisionCorrectionResult(
                segment_id=mismatched[0].segment_id, corrected_text=corrected_text,
                still_uncertain=False, reason="画像から読み取れる"
            )
        ]
    return _fake_correct


class TestJoinPreservingStructure:
    def test_joins_match_segments_without_extra_spaces(self):
        """match/needs_reviewのglm_textは既に元テキストの空白・改行を含んでいるため単純連結でよい"""
        result = ocr_pipeline._join_preserving_structure(["見出し\n", "本文です。"])
        assert result == "見出し\n本文です。"

    def test_inserts_space_when_correction_would_glue_words(self):
        """auto_correctedのcorrected_textは元の空白を保持しない場合があり、単語がくっつくのを防ぐ"""
        result = ocr_pipeline._join_preserving_structure(["code", "05", "broken"])
        assert result == "code 05 broken"

    def test_does_not_add_space_when_already_present(self):
        result = ocr_pipeline._join_preserving_structure(["R-1温度 ", "25.0"])
        assert result == "R-1温度 25.0"


class TestNormalizeOcrMarkup:
    def test_replaces_br_variants_with_single_space(self):
        text = "水温は？<br>圧縮機は？<BR/>バルブは？ <br /> 配管は？"
        assert ocr_pipeline.normalize_ocr_markup(text) == "水温は？ 圧縮機は？ バルブは？ 配管は？"

    def test_replaces_nbsp_with_single_space(self):
        assert ocr_pipeline.normalize_ocr_markup("| &nbsp;&nbsp;目視では認められない |") == "|  目視では認められない |"

    def test_converts_latex_circled_numbers_to_unicode(self):
        text = "$\\textcircled{1}$と$\\textcircled{2}$の運転確認、\\textcircled{20}"
        assert ocr_pipeline.normalize_ocr_markup(text) == "①と②の運転確認、⑳"

    def test_keeps_out_of_range_circled_number_unchanged(self):
        text = "$\\textcircled{21}$"
        assert ocr_pipeline.normalize_ocr_markup(text) == text

    def test_leaves_text_without_br_unchanged(self):
        text = "| 原因 | 対策 |\n|---|---|\n| ①損傷 | 交換する |"
        assert ocr_pipeline.normalize_ocr_markup(text) == text

    def test_repairs_broken_table_structure(self):
        """2026-10-05: ヘッダ行の末尾に区切り行の断片が混入した表を、表として成立する形に直す"""
        text = "| 原因 | 対策 | :--- | : |\n| --- | --- |\n| ①損傷 | 交換する |"
        assert ocr_pipeline.normalize_ocr_markup(text) == "| 原因 | 対策 |\n| --- | --- |\n| ①損傷 | 交換する |"


class TestRunOcrPipelineWithVisionLlmAsPrimary:
    def test_br_tags_do_not_cause_false_mismatch_and_are_removed(self, tmp_path, monkeypatch):
        """
        2026-09-30: 片方の候補にだけ<br>があっても差分の食い違いとして誤検出せず(補正LLMを
        呼ばない)、最終テキストにも<br>が残らない。
        """
        _setup(monkeypatch, {0.0: "| 水温は？<br>圧縮機は？ |"}, glm=("| 水温は？ 圧縮機は？ |", True))
        correct_calls = []
        monkeypatch.setattr(
            ocr_pipeline, "correct_page_with_vision_llm",
            lambda *a, **k: correct_calls.append(1) or []
        )

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        assert correct_calls == []
        assert "<br" not in result.markdown
        assert "水温は？ 圧縮機は？" in result.pages[0].final_text

    def test_broken_table_is_repaired_consistently_in_markdown_and_segments(self, tmp_path, monkeypatch):
        """
        2026-10-05: 表の修復は差分判定の前(入口)で行うため、draft_markdownとsegmentsのfinal_textが
        同じ修復済みテキストになり（「本文の該当箇所へ」の位置合わせが壊れない）、
        崩れた表の構造差が要確認として誤検出されない(補正LLMを呼ばない)。
        """
        broken = "| 表示 | 名称 | :--- | : |\n| --- | --- |\n| E001 | 高圧異常 |"
        _setup(monkeypatch, {0.0: broken}, glm=("| 表示 | 名称 |\n| --- | --- |\n| E001 | 高圧異常 |", True))
        correct_calls = []
        monkeypatch.setattr(
            ocr_pipeline, "correct_page_with_vision_llm",
            lambda *a, **k: correct_calls.append(1) or []
        )

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        repaired = "| 表示 | 名称 |\n| --- | --- |\n| E001 | 高圧異常 |"
        assert correct_calls == []
        assert result.pages[0].final_text == repaired
        assert repaired in result.markdown
        assert "".join(s["final_text"] for s in result.pages[0].segments) == repaired

    def test_markdown_does_not_start_with_temp_file_name_heading(self, tmp_path, monkeypatch):
        """
        2026-10-05: APIはアップロードを一時ファイル(tmpXXXX.pdf)で渡すため、ファイル名由来の
        見出しを本文に出すと一時ファイル名が表示されてしまう。本文はページ見出しから始める。
        """
        _setup(monkeypatch, {0.0: "同じ内容"}, glm=("同じ内容", True))

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "tmpyoed0ms8.pdf")

        assert "tmpyoed0ms8" not in result.markdown
        assert result.markdown.startswith("## PDF 1ページ目\n")

    def test_br_in_llm_corrected_text_is_removed(self, tmp_path, monkeypatch):
        _setup(monkeypatch, {0.0: "R-1温度 2S.0"}, glm=("R-1温度 25.0", True))
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fix_first_mismatch("25.0<br>(℃)"))

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        assert "<br" not in result.pages[0].final_text
        assert result.pages[0].final_text == "R-1温度 25.0 (℃)"

    def test_matching_page_needs_no_correction_call(self, tmp_path, monkeypatch):
        """主文(vision LLM)と比較(GLM-OCR)が完全一致するページは補正を呼ばない"""
        _setup(monkeypatch, {0.0: "同じ内容"}, glm=("同じ内容", True))
        correct_calls = []
        monkeypatch.setattr(
            ocr_pipeline, "correct_page_with_vision_llm",
            lambda *a, **k: correct_calls.append(1) or []
        )

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        assert result.page_count == 2
        assert correct_calls == []
        assert all(seg["status"] == "match" for page in result.pages for seg in page.segments)
        assert "同じ内容" in result.markdown
        assert "## PDF 1ページ目" in result.markdown
        assert "## PDF 2ページ目" in result.markdown

    def test_primary_text_is_vision_llm_not_glm(self, tmp_path, monkeypatch):
        """
        2026-09-30(12)の中核: GLM-OCRが誤読・欠落する①をvision LLMが読めている場合、
        不一致箇所は主文(vision LLM側)が暫定採用される（GLMが主文だと①が消える）。
        """
        _setup(monkeypatch, {0.0: "①コネクションの損傷"}, glm=("コネクションの損傷", True))

        def _uncertain(image_path, segments, ollama_host, model=None, timeout_seconds=None):
            return [
                VisionCorrectionResult(
                    segment_id=s.segment_id, corrected_text="", still_uncertain=True, reason="判読不能"
                )
                for s in segments if not s.is_match
            ]

        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _uncertain)

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        assert "①コネクションの損傷" in result.pages[0].final_text

    def test_mismatched_page_applies_correction_only_to_differing_words(self, tmp_path, monkeypatch):
        """
        2026-09-29(2): 単語単位diffのため、一致した「R-1温度」は巻き込まれず、
        食い違った数値部分だけがセグメント化されて補正対象になる。
        """
        _setup(monkeypatch, {0.0: "R-1温度 2S.0"}, glm=("R-1温度 25.0", True))
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fix_first_mismatch("25.0"))

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        match_seg, corrected_seg = result.pages[0].segments
        assert match_seg["status"] == "match"
        assert corrected_seg["status"] == "auto_corrected"
        assert corrected_seg["final_text"] == "25.0"
        assert result.pages[0].final_text == "R-1温度 25.0"

    def test_correction_unrelated_to_both_candidates_is_not_adopted(self, tmp_path, monkeypatch):
        """
        2026-10-08: 実機の図入りPDFで、主文では正しく読めていた表を、補正LLMが
        候補と無関係な文字化けに置き換え、本文から正しい内容が消えた。候補のどちらとも大きく異なる提案は
        採用せず、主文を残して要確認にする。
        """
        primary = "①パネルの損傷……………………………パネルを取り替える"
        alt = "① パネルの損傷…………………………………パネルを取り替える"
        garbled = "©ネルeリ角\n.................................. ネルeン貤"
        _setup(monkeypatch, {0.0: primary}, glm=(alt, True))
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fix_first_mismatch(garbled))

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        segment = next(seg for seg in result.pages[0].segments if seg["status"] != "match")
        assert segment["status"] == "needs_review"
        assert segment["final_text"] in primary  # 主文の該当箇所を残す
        assert "採用せず主文を残しました" in segment["reason"]
        assert "ネルeリ角" in segment["reason"]  # 何を提案されたかは、人が確認できるよう示す
        assert "画像から読み取れる" not in segment["reason"]  # LLMが付けた理由は、使わない
        assert "ネルeリ角" not in result.markdown
        assert "パネルの損傷" in result.markdown

    def test_correction_that_only_changes_whitespace_of_a_candidate_is_adopted(self, tmp_path, monkeypatch):
        """空白・改行の位置が違うだけの写し(候補と同じ内容)は、これまでどおり自動修正として採用する"""
        _setup(monkeypatch, {0.0: "SAMPLE\n保持フレーム"}, glm=("SAMPLE 保持フレムー", True))
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fix_first_mismatch("保持  フレーム"))

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        statuses = [seg["status"] for seg in result.pages[0].segments]
        assert "auto_corrected" in statuses
        assert "needs_review" not in statuses

    def test_language_recheck_restores_primary_when_correction_picked_the_weaker_candidate(self, tmp_path, monkeypatch):
        """
        2026-10-08: 実機で、補正LLMが、正しく読めていた主文(「〜について」)を、弱い方の候補
        (助詞が欠けた「〜ついて」)で上書きした。日本語として正しいかの再チェックが、主文のほうが正しいと判定したら、補正を取り消す。
        """
        _setup(monkeypatch, {0.0: "# 4.5【点検について】"}, glm=("# 4.5【点検ついて】", True))
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fix_first_mismatch("# 4.5【点検ついて】"))
        received = []

        def _veto(items, page_text, ollama_host, model=None, timeout_seconds=None):
            received.extend(items)
            return {
                item.segment_id: RecheckVerdict(item.segment_id, False, BASIS_LANGUAGE, "「について」が正しい表記です")
                for item in items
            }

        monkeypatch.setattr(ocr_pipeline, "recheck_corrections", _veto)

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        segment = next(seg for seg in result.pages[0].segments if seg["status"] != "match")
        assert segment["status"] == "needs_review"
        assert "点検について" in segment["final_text"]
        assert "補正案を取り消し" in segment["reason"] and "点検ついて" in segment["reason"]
        assert "点検について" in result.markdown and "点検ついて" not in result.markdown
        # 再チェックには、主文・補正後が、そのまま渡る
        assert "点検について" in received[0].primary
        assert "点検ついて" in received[0].chosen

    def test_recheck_receives_context_around_the_correction(self, tmp_path, monkeypatch):
        _setup(monkeypatch, {0.0: "前の文です。 R-1温度 2S.0 後の文です。"}, glm=("前の文です。 R-1温度 25.0 後の文です。", True))
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fix_first_mismatch("25.0"))
        received = []
        monkeypatch.setattr(
            ocr_pipeline, "recheck_corrections",
            lambda items, *a, **k: received.extend(items) or _keep_all_corrections(items, *a, **k),
        )

        ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        assert "前の文です。 R-1温度" in received[0].before
        assert "後の文です。" in received[0].after

    def test_text_layer_that_has_the_primary_wording_cancels_the_correction_without_review(self, tmp_path, monkeypatch):
        """PDFのテキスト層に主文の表記がある(補正後には無い)なら、主文が正しいと確認できたので、要確認にもしない"""
        layer = "4.5【点検について】定期的に点検を行い、結果を記録します。"
        _setup(monkeypatch, {0.0: "# 4.5【点検について】"}, glm=("# 4.5【点検ついて】", True), page_texts=[layer, layer])
        monkeypatch.setattr(ocr_pipeline, "recheck_corrections", correction_recheck.recheck_corrections)
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fix_first_mismatch("# 4.5【点検ついて】"))

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        statuses = [seg["status"] for seg in result.pages[0].segments]
        assert "needs_review" not in statuses and "auto_corrected" not in statuses
        assert "点検について" in result.pages[0].final_text
        cancelled = next(seg for seg in result.pages[0].segments if seg["reason"])
        assert "PDFのテキスト層" in cancelled["reason"]

    def test_text_layer_that_has_the_corrected_wording_confirms_the_correction(self, tmp_path, monkeypatch):
        layer = "R-1温度 25.0 度で運転します。これはテキスト層の文字列です。"
        _setup(monkeypatch, {0.0: "R-1温度 2S.0 度で運転します。"}, glm=("R-1温度 25.0 度で運転します。", True), page_texts=[layer, layer])
        monkeypatch.setattr(ocr_pipeline, "recheck_corrections", correction_recheck.recheck_corrections)
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fix_first_mismatch("25.0"))

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        corrected = next(seg for seg in result.pages[0].segments if seg["status"] == "auto_corrected")
        assert corrected["final_text"] == "25.0"
        # 補正後が、PDFのテキスト層にもあるなら、その確認の結果を、判定理由に残す
        assert "PDFのテキスト層" in corrected["reason"]

    def test_pages_without_a_text_layer_get_none(self, tmp_path, monkeypatch):
        """スキャンしたPDF(テキスト層が無い・ほぼ空のページ)では、テキスト層との照合をしない(Noneを渡す)"""
        _setup(monkeypatch, {0.0: "R-1温度 2S.0"}, glm=("R-1温度 25.0", True), page_texts=["", "　\n"])
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fix_first_mismatch("25.0"))
        page_texts_seen = []
        monkeypatch.setattr(
            ocr_pipeline, "recheck_corrections",
            lambda items, page_text, *a, **k: page_texts_seen.append(page_text) or _keep_all_corrections(items, page_text, *a, **k),
        )

        ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        assert page_texts_seen == [None, None]

    def test_correction_that_only_changes_whitespace_is_not_rechecked(self, tmp_path, monkeypatch):
        """主文と同じ内容(空白・改行の違いだけ)への補正は、書き換えではないため、再チェックしない"""
        _setup(monkeypatch, {0.0: "SAMPLE\n保持フレーム"}, glm=("SAMPLE 保持フレムー", True))
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fix_first_mismatch("保持  フレーム"))
        calls = []
        monkeypatch.setattr(ocr_pipeline, "recheck_corrections", lambda items, *a, **k: calls.append(items) or {})

        ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        assert calls == []

    def test_still_uncertain_falls_back_to_primary_text_not_llm_guess(self, tmp_path, monkeypatch):
        """still_uncertain=Trueの場合、LLMの提案は採用せず主文(vision LLM)を暫定採用する"""
        _setup(monkeypatch, {0.0: "候補A"}, glm=("候補B", True))

        def _fake_correct(image_path, segments, ollama_host, model=None, timeout_seconds=None):
            return [
                VisionCorrectionResult(
                    segment_id=segments[0].segment_id, corrected_text="LLMの推測(不確か)",
                    still_uncertain=True, reason="画像が不鮮明"
                )
            ]

        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fake_correct)

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        segment = result.pages[0].segments[0]
        assert segment["status"] == "needs_review"
        assert segment["final_text"] == "候補A"

    def test_empty_corrected_text_is_not_trusted_even_when_confident(self, tmp_path, monkeypatch):
        """
        実機検証で、vision LLMがstill_uncertain=falseなのにcorrected_textが空文字
        という壊れた応答を返す不具合を確認した。空文字を「確信あり」として鵜呑みに
        すると正しく読めていた内容まで消えてしまうため、needs_reviewに倒す。
        """
        _setup(monkeypatch, {0.0: "正しい内容"}, glm=("誤読された内容", True))

        def _fake_correct(image_path, segments, ollama_host, model=None, timeout_seconds=None):
            return [
                VisionCorrectionResult(
                    segment_id=segments[0].segment_id, corrected_text="",
                    still_uncertain=False, reason=""
                )
            ]

        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fake_correct)

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        segment = result.pages[0].segments[0]
        assert segment["status"] == "needs_review"
        assert segment["final_text"] == "正しい内容"
        assert "corrected_text" in segment["reason"]  # 「応答が空」ではなく実際の条件を示す

    def test_uncertain_without_reason_is_reported_as_uncertain_not_empty_response(self, tmp_path, monkeypatch):
        """LLMがstill_uncertain=trueをreason無しで返したケースを「応答が空」と誤って報告しない"""
        _setup(monkeypatch, {0.0: "候補A"}, glm=("候補B", True))

        def _fake_correct(image_path, segments, ollama_host, model=None, timeout_seconds=None):
            return [
                VisionCorrectionResult(
                    segment_id=segments[0].segment_id, corrected_text="候補A",
                    still_uncertain=True, reason=""
                )
            ]

        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fake_correct)

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        segment = result.pages[0].segments[0]
        assert segment["status"] == "needs_review"
        assert "still_uncertain" in segment["reason"]
        assert "応答が空" not in segment["reason"]

    def test_glm_is_called_once_per_page(self, tmp_path, monkeypatch):
        """2026-09-30(12): GLM-OCRは2回実行から比較用の1回実行に変更した"""
        _setup(monkeypatch, {0.0: "同じ内容"})
        call_count = {"n": 0}

        def _fake_glm(image_path, host, model=None, timeout_seconds=None, temperature=0.0, seed=1):
            call_count["n"] += 1
            return "同じ内容", True

        monkeypatch.setattr(ocr_pipeline, "ocr_with_glm", _fake_glm)
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", lambda *a, **k: [])

        ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        assert call_count["n"] == 2  # 2ページ分、各ページ1回

    def test_model_names_are_passed_through_so_they_can_be_swapped_by_env(self, tmp_path, monkeypatch):
        """主文モデル(vision_model)と比較モデル(glm_model)は引数で差し替えられる"""
        monkeypatch.setattr(ocr_pipeline, "convert_pdf_to_images", _fake_convert_pdf_to_images)
        seen = {"vision": set(), "glm": set()}

        def _fake_vision(image_path, host, model=None, timeout_seconds=None, temperature=0.0, seed=1):
            seen["vision"].add(model)
            return "同じ内容"

        def _fake_glm(image_path, host, model=None, timeout_seconds=None, temperature=0.0, seed=1):
            seen["glm"].add(model)
            return "同じ内容", True

        monkeypatch.setattr(ocr_pipeline, "ocr_full_page_with_vision_llm", _fake_vision)
        monkeypatch.setattr(ocr_pipeline, "ocr_with_glm", _fake_glm)
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", lambda *a, **k: [])

        ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf", glm_model="my-ocr", vision_model="my-vision")

        assert seen == {"vision": {"my-vision"}, "glm": {"my-ocr"}}

    def test_truncated_glm_response_is_still_used_as_comparison(self, tmp_path, monkeypatch):
        """
        2026-09-29(10)の考え方を維持: GLM-OCRが打ち切られても部分応答は別モデルの
        読み取りとして比較材料に使う（自己検証は呼ばれない）。
        """
        _setup(monkeypatch, {0.0: "R-1温度 25.0"}, glm=("R-1温度 2S.0", False))
        verify_calls = []
        monkeypatch.setattr(
            ocr_pipeline, "verify_full_page_ocr_with_vision_llm",
            lambda *a, **k: verify_calls.append(1) or (True, "", "")
        )
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fix_first_mismatch("25.0"))

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        assert verify_calls == []
        mismatches = [s for s in result.pages[0].segments if s["status"] != "match"]
        assert len(mismatches) == 1
        assert mismatches[0]["status"] == "auto_corrected"
        assert result.pages[0].final_text == "R-1温度 25.0"


class TestSelfCompareFallback:
    def test_broken_glm_comparison_is_abandoned_for_vision_self_compare(self, tmp_path, monkeypatch):
        """
        2026-09-29(11)決定: GLM-OCRとのdiffで判定漏れ(MISSING_JUDGMENT_REASON)が
        MAX_UNRESOLVED_SEGMENTS_FOR_PARTIAL_DIFF件を超えた場合、比較材料の構造が
        壊れている兆候とみなし、vision LLM自身の2回目の読み取り結果とdiffする。
        """
        # 4箇所が食い違う「壊れた」GLM応答を模擬(間に一致するアンカー語を挟み、
        # SequenceMatcherが1つの巨大なreplaceブロックにまとめてしまわないようにする)
        same = "ok1 fix1 ok2 fix2 ok3 fix3 ok4 fix4"
        _setup(
            monkeypatch,
            {0.0: same, ocr_pipeline.VISION_ALT_TEMPERATURE: same},
            glm=("ok1 bad1 ok2 bad2 ok3 bad3 ok4 bad4", False),
        )
        verify_calls = []
        monkeypatch.setattr(
            ocr_pipeline, "verify_full_page_ocr_with_vision_llm",
            lambda *a, **k: verify_calls.append(1) or (True, "", "")
        )
        correct_calls = []

        def _fake_correct(image_path, segments, ollama_host, model=None, timeout_seconds=None):
            mismatched = [s for s in segments if not s.is_match]
            correct_calls.append(len(mismatched))
            return [
                VisionCorrectionResult(
                    segment_id=s.segment_id, corrected_text=s.glm_text,
                    still_uncertain=True, reason=MISSING_JUDGMENT_REASON
                )
                for s in mismatched
            ]

        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fake_correct)

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        assert verify_calls == []  # 自己比較が成功するため自己検証は呼ばれない
        assert len(correct_calls) == 2  # ページ1のGLM比較で1回(判定漏れ多発)、ページ2も同様。自己比較は一致で呼ばれない
        page1_segments = result.pages[0].segments
        assert not any(seg["segment_id"] == ocr_pipeline.REVIEW_MARKER_SEGMENT_ID for seg in page1_segments)
        assert result.pages[0].final_text == same  # GLMの誤読("bad1"等)ではなく主文が採用される
        assert all(seg["status"] == "match" for seg in page1_segments)

    def test_uncertain_with_empty_text_also_counts_as_broken_comparison(self, tmp_path, monkeypatch):
        """
        2026-09-30(13): 補正LLMが「判定漏れ」ではなく「判定不能+補正テキスト空」で返しても、
        要確認が閾値を超えたら壊れた比較とみなし、vision LLMの自己比較に切り替える
        （実機で、この壊れ方が検知をすり抜けて要確認が9件出た）。
        """
        same = "ok1 fix1 ok2 fix2 ok3 fix3 ok4 fix4"
        _setup(
            monkeypatch,
            {0.0: same, ocr_pipeline.VISION_ALT_TEMPERATURE: same},
            glm=("ok1 bad1 ok2 bad2 ok3 bad3 ok4 bad4", False),
        )

        def _uncertain_and_empty(image_path, segments, ollama_host, model=None, timeout_seconds=None):
            return [
                VisionCorrectionResult(
                    segment_id=s.segment_id, corrected_text="", still_uncertain=True,
                    reason="指定された候補は正しいではありませんでした"  # 判定漏れ(MISSING)ではない
                )
                for s in segments if not s.is_match
            ]

        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _uncertain_and_empty)

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        assert result.pages[0].final_text == same
        assert all(seg["status"] == "match" for seg in result.pages[0].segments)

    def test_empty_glm_response_goes_straight_to_self_compare(self, tmp_path, monkeypatch):
        """GLM-OCRの結果が空なら比較材料にならないため、最初からvision LLMの自己比較を行う"""
        _setup(
            monkeypatch,
            {0.0: "R-1温度 25.0", ocr_pipeline.VISION_ALT_TEMPERATURE: "R-1温度 2S.0"},
            glm=("", False),
        )
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fix_first_mismatch("25.0"))

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        mismatches = [s for s in result.pages[0].segments if s["status"] != "match"]
        assert len(mismatches) == 1
        assert mismatches[0]["status"] == "auto_corrected"
        assert result.pages[0].final_text == "R-1温度 25.0"

    def test_self_verification_approves_without_review_marker(self, tmp_path, monkeypatch):
        """
        比較材料(GLM・自己2回目)が両方得られなくても、画像との自己検証で一致が
        確認できればneeds_reviewマーカーを立てない（人手確認の手間を減らす）。
        """
        _setup(monkeypatch, {0.0: "vision LLMが読み取った完全な内容", ocr_pipeline.VISION_ALT_TEMPERATURE: None})
        monkeypatch.setattr(
            ocr_pipeline, "verify_full_page_ocr_with_vision_llm",
            lambda image_path, ocr_text, host, model=None, timeout_seconds=None: (True, ocr_text, "画像と一致")
        )
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", lambda *a, **k: [])

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        assert all(seg["status"] == "match" for seg in result.pages[0].segments)
        assert "vision LLMが読み取った完全な内容" in result.pages[0].final_text

    def test_self_verification_localizes_mismatch_instead_of_flagging_whole_page(self, tmp_path, monkeypatch):
        """
        2026-09-29(7)決定: 検証で不一致が見つかっても、ページ全体をneeds_review
        扱いにはせず、corrected_textとのdiffで実際に食い違った箇所だけをセグメント化する。
        """
        _setup(monkeypatch, {0.0: "R-1温度 25.0", ocr_pipeline.VISION_ALT_TEMPERATURE: None})
        monkeypatch.setattr(
            ocr_pipeline, "verify_full_page_ocr_with_vision_llm",
            lambda image_path, ocr_text, host, model=None, timeout_seconds=None: (False, "R-1温度 2S.0", "数値が画像と異なる")
        )
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", _fix_first_mismatch("25.0"))

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        page1_segments = result.pages[0].segments
        assert not any(seg["segment_id"] == ocr_pipeline.REVIEW_MARKER_SEGMENT_ID for seg in page1_segments)
        assert any(seg["status"] == "match" for seg in page1_segments)
        mismatches = [s for s in page1_segments if s["status"] != "match"]
        assert len(mismatches) == 1
        assert mismatches[0]["status"] == "auto_corrected"
        assert result.pages[0].final_text == "R-1温度 25.0"

    def test_whole_page_review_only_when_verification_call_itself_fails(self, tmp_path, monkeypatch):
        """検証呼び出し自体が失敗し有効な修正案が得られなかった場合のみ、ページ全体をneeds_review扱いにする"""
        _setup(monkeypatch, {0.0: "vision LLMが読み取った内容", ocr_pipeline.VISION_ALT_TEMPERATURE: None})
        monkeypatch.setattr(
            ocr_pipeline, "verify_full_page_ocr_with_vision_llm",
            lambda image_path, ocr_text, host, model=None, timeout_seconds=None: (
                False, ocr_text, "vision LLMへの接続に失敗したため検証できませんでした"
            )
        )
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", lambda *a, **k: [])

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        marker = result.pages[0].segments[0]
        assert marker["segment_id"] == ocr_pipeline.REVIEW_MARKER_SEGMENT_ID
        assert marker["status"] == "needs_review"
        assert "再照合にも失敗" in marker["reason"]
        assert "vision LLMが読み取った内容" in result.pages[0].final_text


class TestVisionLlmFailure:
    def test_glm_result_is_adopted_provisionally_with_whole_page_review(self, tmp_path, monkeypatch):
        """
        vision LLMのフルページOCR自体が失敗した場合のみ、GLM-OCRの結果を暫定の主文と
        し、ページ全体を要確認扱いにする（サイレントに採用しない）。
        """
        _setup(monkeypatch, {0.0: None}, glm=("GLMが読めた内容", True))
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", lambda *a, **k: [])

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        marker = result.pages[0].segments[0]
        assert marker["segment_id"] == ocr_pipeline.REVIEW_MARKER_SEGMENT_ID
        assert marker["status"] == "needs_review"
        assert "vision LLMによるOCRが失敗" in marker["reason"]
        assert "GLMが読めた内容" in result.pages[0].final_text

    def test_blank_page_is_marked_explicitly(self, tmp_path, monkeypatch):
        _setup(monkeypatch, {0.0: None}, glm=("", True))
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", lambda *a, **k: [])

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        assert "テキストを検出できませんでした" in result.markdown
        assert result.pages[0].segments[0]["status"] == "needs_review"  # 空白ページも保守的に要確認


class TestOcrDraftResult:
    def test_diff_segments_property_includes_page_number(self, tmp_path, monkeypatch):
        _setup(monkeypatch, {0.0: "同じ内容"}, glm=("同じ内容", True))
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", lambda *a, **k: [])

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        pages_seen = {seg["page"] for seg in result.diff_segments}
        assert pages_seen == {1, 2}


class TestOnProgress:
    def test_reports_zero_then_each_completed_page(self, tmp_path, monkeypatch):
        _setup(monkeypatch, {0.0: "同じ内容"}, glm=("同じ内容", True))
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", lambda *a, **k: [])
        calls = []

        ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf", on_progress=lambda done, total: calls.append((done, total)))

        assert calls == [(0, 2), (1, 2), (2, 2)]

    def test_progress_is_optional(self, tmp_path, monkeypatch):
        _setup(monkeypatch, {0.0: "同じ内容"}, glm=("同じ内容", True))
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", lambda *a, **k: [])

        result = ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf")

        assert result.page_count == 2

    def test_cancel_from_progress_stops_before_next_page(self, tmp_path, monkeypatch):
        """on_progressでOcrCancelledを投げると、そのページの区切りで中止され、次のページはOCRされない"""
        pages_ocred = []

        def _fake_vision(image_path, host, model=None, timeout_seconds=None, temperature=0.0, seed=1):
            pages_ocred.append(image_path.name)
            return "同じ内容"

        monkeypatch.setattr(ocr_pipeline, "convert_pdf_to_images", _fake_convert_pdf_to_images)
        monkeypatch.setattr(ocr_pipeline, "ocr_full_page_with_vision_llm", _fake_vision)
        monkeypatch.setattr(ocr_pipeline, "ocr_with_glm", _glm_returns("同じ内容", True))
        monkeypatch.setattr(ocr_pipeline, "correct_page_with_vision_llm", lambda *a, **k: [])

        def _cancel_after_first_page(done, total):
            if done == 1:
                raise ocr_pipeline.OcrCancelled("破棄された")

        with pytest.raises(ocr_pipeline.OcrCancelled):
            ocr_pipeline.run_ocr_pipeline(tmp_path / "manual.pdf", on_progress=_cancel_after_first_page)

        assert pages_ocred == ["page-1.png"]
