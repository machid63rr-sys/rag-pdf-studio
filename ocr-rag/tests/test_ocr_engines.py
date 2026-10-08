"""
ocr_engines.py（GLM-OCR呼び出し）のテスト

Ollama(requests.post)を偽物にして、サーバーエラー(5xx)・完了しない応答・接続エラーの扱いを確認する。
"""
import pytest
import requests

from ocr_rag.ocr import ocr_engines
from ocr_rag.ocr.ocr_engines import GLM_OCR_MAX_ATTEMPTS, ocr_with_glm


class _FakeResponse:
    def __init__(self, status_code=200, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data if json_data is not None else {}
        self.text = text

    def json(self):
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} Error", response=self)


def _ok(text: str, done: bool = True) -> _FakeResponse:
    return _FakeResponse(200, {"response": text, "done": done})


@pytest.fixture
def image_path(tmp_path):
    path = tmp_path / "page.png"
    path.write_bytes(b"not-a-real-png")  # 中身は読まれず、base64にされて偽物のOllamaへ渡るだけ
    return path


def _install_fake_post(monkeypatch, responses):
    """requests.postを、responsesを順に返す偽物にする。戻り値は、送られたリクエストのjsonの記録"""
    sent = []
    queue = list(responses)

    def fake_post(url, json=None, timeout=None):
        sent.append(json)
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(ocr_engines.requests, "post", fake_post)
    return sent


class TestServerError:
    def test_500のあと温度とseedを変えて再試行し_成功すればその結果を返す(self, monkeypatch, image_path):
        sent = _install_fake_post(monkeypatch, [
            _FakeResponse(500, text='{"error":"internal"}'),
            _ok("書き起こした本文"),
        ])

        text, complete = ocr_with_glm(image_path, "http://ollama:11434", temperature=0.0, seed=1)

        assert (text, complete) == ("書き起こした本文", True)
        assert len(sent) == 2
        assert sent[0]["options"]["temperature"] == 0.0 and sent[0]["options"]["seed"] == 1
        assert sent[1]["options"]["temperature"] == 0.3 and sent[1]["options"]["seed"] == 3

    def test_500が続いても例外にせず_空の未完了として返す(self, monkeypatch, image_path):
        # 通常プロンプトGLM_OCR_MAX_ATTEMPTS回 + プレーンテキストのフォールバック1回
        responses = [_FakeResponse(500, text="boom") for _ in range(GLM_OCR_MAX_ATTEMPTS + 1)]
        sent = _install_fake_post(monkeypatch, responses)

        text, complete = ocr_with_glm(image_path, "http://ollama:11434")

        assert (text, complete) == ("", False)
        assert len(sent) == GLM_OCR_MAX_ATTEMPTS + 1

    def test_500の本文をログに残す(self, monkeypatch, image_path, caplog):
        _install_fake_post(monkeypatch, [_FakeResponse(500, text="runner terminated"), _ok("本文")])

        with caplog.at_level("WARNING"):
            ocr_with_glm(image_path, "http://ollama:11434")

        assert "HTTP 500" in caplog.text
        assert "runner terminated" in caplog.text

    def test_先に得たdone_falseの部分応答は_後の500があっても残す(self, monkeypatch, image_path):
        _install_fake_post(monkeypatch, [
            _ok("途中まで", done=False),
            _FakeResponse(500, text="boom"),
            _FakeResponse(500, text="boom"),
            _FakeResponse(500, text="boom"),
        ])

        text, complete = ocr_with_glm(image_path, "http://ollama:11434")

        assert (text, complete) == ("途中まで", False)


class TestOutputLimit:
    def test_上限で打ち切られても_完了として返し_警告を残す(self, monkeypatch, image_path, caplog):
        # 上限での打ち切りは、done:trueで返る。繰り返しの暴走を止める役目もあるため、完了として扱う(従来どおり)
        response = _FakeResponse(200, {
            "response": "本文", "done": True, "done_reason": "length", "prompt_eval_count": 4143, "eval_count": 2048,
        })
        _install_fake_post(monkeypatch, [response])

        with caplog.at_level("WARNING"):
            text, complete = ocr_with_glm(image_path, "http://ollama:11434")

        assert (text, complete) == ("本文", True)
        assert "done_reason=length" in caplog.text
        assert "GLM_OCR_NUM_PREDICT" in caplog.text
        assert "eval_count=2048" in caplog.text

    def test_リクエストに上限の値が入る(self, monkeypatch, image_path):
        sent = _install_fake_post(monkeypatch, [_ok("本文")])

        ocr_with_glm(image_path, "http://ollama:11434")

        assert sent[0]["options"]["num_predict"] == ocr_engines.DEFAULT_GLM_OCR_NUM_PREDICT


class TestOtherErrorsStillRaise:
    def test_400は例外のまま(self, monkeypatch, image_path):
        # コンテキスト長の超過("request exceeds the available context size")等は、設定の誤りなので隠さない
        _install_fake_post(monkeypatch, [_FakeResponse(400, text="bad request")])

        with pytest.raises(requests.HTTPError):
            ocr_with_glm(image_path, "http://ollama:11434")

    def test_接続エラーは例外のまま(self, monkeypatch, image_path):
        _install_fake_post(monkeypatch, [requests.ConnectionError("refused")])

        with pytest.raises(requests.ConnectionError):
            ocr_with_glm(image_path, "http://ollama:11434")
