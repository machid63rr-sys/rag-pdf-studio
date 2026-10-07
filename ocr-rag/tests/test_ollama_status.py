"""
ocr_rag/ollama_status.py のテスト
"""
import pytest
import requests

from ocr_rag import ollama_status


class _Response:
    def __init__(self, models):
        self._models = models

    def raise_for_status(self):
        pass

    def json(self):
        return {"models": [{"name": m} for m in self._models]}


def _tags(monkeypatch, models):
    captured = {}

    def _fake_get(url, timeout=None):
        captured["url"] = url
        captured["timeout"] = timeout
        return _Response(models)

    monkeypatch.setattr(requests, "get", _fake_get)
    return captured


def test_returns_empty_when_all_models_exist(monkeypatch):
    captured = _tags(monkeypatch, ["bge-m3:latest", "glm-ocr:latest", "qwen3.5:9b"])

    missing = ollama_status.find_missing_models("http://o:1", ["bge-m3", "glm-ocr", "qwen3.5:9b"])

    assert missing == []
    assert captured["url"] == "http://o:1/api/tags"


def test_returns_missing_models_in_requested_order(monkeypatch):
    _tags(monkeypatch, ["glm-ocr:latest"])

    assert ollama_status.find_missing_models("http://o", ["bge-m3", "glm-ocr", "qwen3.5:9b"]) == ["bge-m3", "qwen3.5:9b"]


def test_model_without_tag_means_latest(monkeypatch):
    _tags(monkeypatch, ["bge-m3:v2"])  # latest ではない別のタグ

    assert ollama_status.find_missing_models("http://o", ["bge-m3"]) == ["bge-m3"]


def test_explicit_tag_must_match_exactly(monkeypatch):
    _tags(monkeypatch, ["qwen3.5:35b"])

    assert ollama_status.find_missing_models("http://o", ["qwen3.5:9b"]) == ["qwen3.5:9b"]


def test_connection_error_propagates(monkeypatch):
    def _fail(*args, **kwargs):
        raise requests.exceptions.ConnectionError("connection refused")

    monkeypatch.setattr(requests, "get", _fail)

    with pytest.raises(requests.RequestException):
        ollama_status.find_missing_models("http://o", ["bge-m3"])
