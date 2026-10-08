"""src/manuals/vision_correction.py のテスト（requests.postをmonkeypatchし実Ollama無しで検証）"""
import json
from unittest.mock import MagicMock

import pytest
import requests

from ocr_rag.ocr import vision_correction as vc
from ocr_rag.ocr.ocr_diff import DiffSegment


def _segments():
    return [
        DiffSegment(segment_id="seg-0", glm_text="見出し", glm_alt_text="見出し", is_match=True),
        DiffSegment(segment_id="seg-1", glm_text="R-1温度 25.0", glm_alt_text="R-1温度 2S.0", is_match=False),
    ]


def _fake_response(payload: dict):
    response = MagicMock()
    response.raise_for_status.return_value = None
    response.json.return_value = {"message": {"content": json.dumps(payload)}}
    return response


class TestBuildUserPrompt:
    def test_prompt_does_not_claim_glm_ocr_was_run_twice(self):
        """
        2026-09-30(12): 主文がvision LLMになり、候補Bの出所もGLM-OCRとは限らなくなったため、
        「GLM-OCRを2回実行した」という誤った前提をLLMに伝えない。
        """
        prompt = vc._build_user_prompt([s for s in _segments() if not s.is_match])

        assert "GLM" not in prompt
        assert "候補A(主文): R-1温度 25.0" in prompt
        assert "候補B(別の読み取り): R-1温度 2S.0" in prompt


class TestPromptAndSchemaHardening:
    def test_reason_schema_forbids_empty_string_but_corrected_text_may_be_empty(self):
        """
        2026-09-30: reasonの空はSchemaで禁止する。corrected_textは「画像にその箇所が
        存在しない」を空文字で表現させるため空を許す(空の場合はocr_pipeline側で要確認になる)。
        """
        item = vc.CORRECTION_SCHEMA["properties"]["corrections"]["items"]["properties"]
        assert item["reason"]["minLength"] == 1
        assert "minLength" not in item["corrected_text"]
        assert vc.FULL_PAGE_OCR_VERIFY_SCHEMA["properties"]["reason"]["minLength"] == 1

    def test_correction_prompt_covers_known_failure_modes(self):
        prompt = vc.VISION_CORRECTION_SYSTEM_PROMPT
        assert "両方とも誤っている" in prompt  # どちらの候補も正しいとは限らない
        assert "簡体字" in prompt  # 簡体字混入は誤り
        assert "箇条書きの記号" in prompt  # 書式だけの違いは内容の違いではない
        assert "reason" in prompt and "空にしてはいけません" in prompt

    def test_prompts_forbid_html_line_break_tags(self):
        """セル内改行に<br>を使わせない（人手確認済みマニュアルの書式・画面表示に合わせる）"""
        assert "<br>" in vc.FULL_PAGE_OCR_PROMPT
        assert "<br>" in vc.VISION_CORRECTION_SYSTEM_PROMPT


class TestCorrectPageWithVisionLlm:
    def test_whitespace_only_reason_is_treated_as_empty(self, tmp_path, monkeypatch):
        """minLength:1を空白1文字で回避された場合も、reasonは空として扱う(実機で確認した挙動)"""
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")

        monkeypatch.setattr(
            vc.requests, "post",
            lambda url, json, timeout: _fake_response({
                "corrections": [
                    {"segment_id": "seg-1", "corrected_text": "R-1温度 25.0",
                     "still_uncertain": False, "reason": " "}
                ]
            })
        )

        results = vc.correct_page_with_vision_llm(image_path, _segments(), "http://fake-ollama:11434")

        assert results[0].reason == ""

    def test_returns_empty_list_when_no_mismatches(self, tmp_path, monkeypatch):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")
        all_match = [DiffSegment(segment_id="seg-0", glm_text="a", glm_alt_text="a", is_match=True)]

        results = vc.correct_page_with_vision_llm(image_path, all_match, "http://fake-ollama:11434")

        assert results == []

    def test_applies_correction_for_mismatched_segment(self, tmp_path, monkeypatch):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")
        captured = {}

        def _fake_post(url, json, timeout):
            captured['url'] = url
            captured['json'] = json
            return _fake_response({
                "corrections": [
                    {"segment_id": "seg-1", "corrected_text": "R-1温度 25.0",
                     "still_uncertain": False, "reason": "画像では25.0と読める"}
                ]
            })

        monkeypatch.setattr(requests, "post", _fake_post)

        results = vc.correct_page_with_vision_llm(image_path, _segments(), "http://fake-ollama:11434")

        assert len(results) == 1
        assert results[0].segment_id == "seg-1"
        assert results[0].corrected_text == "R-1温度 25.0"
        assert results[0].still_uncertain is False
        assert captured['url'] == "http://fake-ollama:11434/api/chat"
        assert captured['json']['messages'][1]['images'] == [captured['json']['messages'][1]['images'][0]]
        assert captured['json']['format'] == vc.CORRECTION_SCHEMA
        assert captured['json']['think'] is False
        assert captured['json']['options']['num_ctx'] > 4096

    def test_marks_uncertain_when_llm_cannot_decide(self, tmp_path, monkeypatch):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")

        monkeypatch.setattr(requests, "post", lambda *a, **k: _fake_response({
            "corrections": [
                {"segment_id": "seg-1", "corrected_text": "R-1温度 25.0",
                 "still_uncertain": True, "reason": "画像が不鮮明で判読できない"}
            ]
        }))

        results = vc.correct_page_with_vision_llm(image_path, _segments(), "http://fake-ollama:11434")

        assert results[0].still_uncertain is True

    def test_retries_once_on_invalid_json_then_succeeds(self, tmp_path, monkeypatch):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")
        call_count = {"n": 0}

        def _fake_post(*a, **k):
            call_count["n"] += 1
            if call_count["n"] == 1:
                response = MagicMock()
                response.raise_for_status.return_value = None
                response.json.return_value = {"message": {"content": "not valid json"}}
                return response
            return _fake_response({
                "corrections": [
                    {"segment_id": "seg-1", "corrected_text": "R-1温度 25.0",
                     "still_uncertain": False, "reason": "2回目で成功"}
                ]
            })

        monkeypatch.setattr(requests, "post", _fake_post)

        results = vc.correct_page_with_vision_llm(image_path, _segments(), "http://fake-ollama:11434")

        assert call_count["n"] == 2
        assert results[0].still_uncertain is False

    def test_marks_all_uncertain_after_max_attempts_exhausted(self, tmp_path, monkeypatch):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")

        def _fake_post(*a, **k):
            response = MagicMock()
            response.raise_for_status.return_value = None
            response.json.return_value = {"message": {"content": "not valid json"}}
            return response

        monkeypatch.setattr(requests, "post", _fake_post)

        results = vc.correct_page_with_vision_llm(image_path, _segments(), "http://fake-ollama:11434")

        assert len(results) == 1
        assert results[0].segment_id == "seg-1"
        assert results[0].still_uncertain is True

    def test_missing_segment_in_response_is_marked_uncertain(self, tmp_path, monkeypatch):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")

        monkeypatch.setattr(requests, "post", lambda *a, **k: _fake_response({"corrections": []}))

        results = vc.correct_page_with_vision_llm(image_path, _segments(), "http://fake-ollama:11434")

        assert results[0].still_uncertain is True
        assert results[0].corrected_text == "R-1温度 25.0"  # 元の主文候補を暫定採用

    def test_raises_on_connection_failure(self, tmp_path, monkeypatch):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")

        monkeypatch.setattr(
            requests, "post",
            lambda *a, **k: (_ for _ in ()).throw(requests.ConnectionError("refused"))
        )

        with pytest.raises(requests.RequestException):
            vc.correct_page_with_vision_llm(image_path, _segments(), "http://fake-ollama:11434")


def _fake_chat_content_response(content: str):
    response = MagicMock()
    response.raise_for_status.return_value = None
    response.json.return_value = {"message": {"content": content}}
    return response


class TestOcrFullPageWithVisionLlm:
    def test_returns_stripped_content_on_success(self, tmp_path, monkeypatch):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")
        captured = {}

        def _fake_post(url, json, timeout):
            captured['url'] = url
            captured['json'] = json
            return _fake_chat_content_response("  # 見出し\n本文です。  ")

        monkeypatch.setattr(requests, "post", _fake_post)

        text = vc.ocr_full_page_with_vision_llm(image_path, "http://fake-ollama:11434")

        assert text == "# 見出し\n本文です。"
        assert captured['url'] == "http://fake-ollama:11434/api/chat"
        assert captured['json']['messages'][0]['images'] == [captured['json']['messages'][0]['images'][0]]
        assert captured['json']['think'] is False

    def test_上限で打ち切られたら_本文は返し_使ったトークン数を警告に残す(self, tmp_path, monkeypatch, caplog):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")
        response = _fake_chat_content_response("途中までの本文")
        response.json.return_value.update({"done_reason": "length", "prompt_eval_count": 9000, "eval_count": 7384})
        monkeypatch.setattr(requests, "post", lambda *a, **k: response)

        with caplog.at_level("WARNING"):
            text = vc.ocr_full_page_with_vision_llm(image_path, "http://fake-ollama:11434")

        assert text == "途中までの本文"
        assert "done_reason=length" in caplog.text
        assert "prompt_eval_count=9000" in caplog.text
        assert "eval_count=7384" in caplog.text
        assert "OCR_VISION_NUM_CTX" in caplog.text

    def test_正常終了なら_打ち切りの警告は出さない(self, tmp_path, monkeypatch, caplog):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")
        response = _fake_chat_content_response("本文")
        response.json.return_value.update({"done_reason": "stop"})
        monkeypatch.setattr(requests, "post", lambda *a, **k: response)

        with caplog.at_level("WARNING"):
            vc.ocr_full_page_with_vision_llm(image_path, "http://fake-ollama:11434")

        assert "done_reason=length" not in caplog.text

    def test_returns_none_on_empty_response(self, tmp_path, monkeypatch):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")

        monkeypatch.setattr(requests, "post", lambda *a, **k: _fake_chat_content_response("   "))

        assert vc.ocr_full_page_with_vision_llm(image_path, "http://fake-ollama:11434") is None

    def test_returns_none_on_connection_failure(self, tmp_path, monkeypatch):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")

        monkeypatch.setattr(
            requests, "post",
            lambda *a, **k: (_ for _ in ()).throw(requests.ConnectionError("refused"))
        )

        assert vc.ocr_full_page_with_vision_llm(image_path, "http://fake-ollama:11434") is None


class TestVerifyFullPageOcrWithVisionLlm:
    def test_returns_true_when_llm_confirms_match(self, tmp_path, monkeypatch):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")

        monkeypatch.setattr(
            requests, "post",
            lambda *a, **k: _fake_response({
                "matches_image": True, "corrected_text": "書き起こしテキスト", "reason": "画像と一致"
            })
        )

        matches, corrected_text, reason = vc.verify_full_page_ocr_with_vision_llm(
            image_path, "書き起こしテキスト", "http://fake-ollama:11434"
        )

        assert matches is True
        assert corrected_text == "書き起こしテキスト"
        assert reason == "画像と一致"

    def test_returns_corrected_text_when_llm_finds_mismatch(self, tmp_path, monkeypatch):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")

        monkeypatch.setattr(
            requests, "post",
            lambda *a, **k: _fake_response({
                "matches_image": False, "corrected_text": "R-1温度 25.0", "reason": "表の数値が画像と異なる"
            })
        )

        matches, corrected_text, reason = vc.verify_full_page_ocr_with_vision_llm(
            image_path, "R-1温度 2S.0", "http://fake-ollama:11434"
        )

        assert matches is False
        assert corrected_text == "R-1温度 25.0"
        assert reason == "表の数値が画像と異なる"

    def test_returns_original_text_after_max_attempts_on_invalid_json(self, tmp_path, monkeypatch):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")

        monkeypatch.setattr(requests, "post", lambda *a, **k: _fake_chat_content_response("not valid json"))

        matches, corrected_text, reason = vc.verify_full_page_ocr_with_vision_llm(
            image_path, "書き起こしテキスト", "http://fake-ollama:11434"
        )

        assert matches is False
        assert corrected_text == "書き起こしテキスト"  # 有効な修正案が無いため元のテキストのまま

    def test_returns_original_text_on_connection_failure(self, tmp_path, monkeypatch):
        image_path = tmp_path / "page-1.png"
        image_path.write_bytes(b"fake-png")

        monkeypatch.setattr(
            requests, "post",
            lambda *a, **k: (_ for _ in ()).throw(requests.ConnectionError("refused"))
        )

        matches, corrected_text, reason = vc.verify_full_page_ocr_with_vision_llm(
            image_path, "書き起こしテキスト", "http://fake-ollama:11434"
        )

        assert matches is False
        assert corrected_text == "書き起こしテキスト"
