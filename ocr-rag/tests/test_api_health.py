"""
ocr_rag/api/app.py の /healthz・/readyz・エラー応答のテスト
"""
from typing import cast

import pytest
import requests
from fastapi.testclient import TestClient

from ocr_rag.api import app as app_module
from ocr_rag.api.app import create_app
from ocr_rag.db import Database


class _BrokenDb:
    def get_cursor(self, *args, **kwargs):
        raise RuntimeError("接続できません")


class TestHealthz:
    def test_ok_when_db_is_reachable(self, client):
        response = client.get("/healthz")

        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    def test_503_when_db_is_unreachable(self, settings, api_retriever, ocr_jobs):
        broken = TestClient(create_app(
            settings=settings, db=cast(Database, _BrokenDb()), retriever=api_retriever, ocr_jobs=ocr_jobs
        ))

        response = broken.get("/healthz")

        assert response.status_code == 503
        assert "接続できません" in response.json()["detail"]


class TestReadyz:
    def test_ok_when_all_models_exist(self, client, settings, monkeypatch):
        captured = {}

        def _fake_find(host, required):
            captured["host"], captured["required"] = host, required
            return []

        monkeypatch.setattr(app_module, "find_missing_models", _fake_find)

        response = client.get("/readyz")

        assert response.status_code == 200
        assert response.json() == {"status": "ok", "missing_models": []}
        assert captured["host"] == settings.ollama_host
        assert captured["required"] == ["bge-m3", "fake-glm-ocr", "fake-vision", "fake-chat"]

    def test_503_lists_missing_models(self, client, monkeypatch):
        monkeypatch.setattr(app_module, "find_missing_models", lambda host, required: ["glm-ocr"])

        response = client.get("/readyz")

        assert response.status_code == 503
        assert response.json()["missing_models"] == ["glm-ocr"]
        assert "glm-ocr" in response.json()["detail"]

    def test_503_when_ollama_is_unreachable(self, client, monkeypatch):
        def _fail(host, required):
            raise requests.exceptions.ConnectionError("connection refused")

        monkeypatch.setattr(app_module, "find_missing_models", _fail)

        response = client.get("/readyz")

        assert response.status_code == 503
        assert "Ollamaに接続できません" in response.json()["detail"]

    def test_503_when_db_is_unreachable(self, settings, api_retriever, ocr_jobs):
        broken = TestClient(create_app(
            settings=settings, db=cast(Database, _BrokenDb()), retriever=api_retriever, ocr_jobs=ocr_jobs
        ))

        response = broken.get("/readyz")

        assert response.status_code == 503
        assert "DB接続に失敗" in response.json()["detail"]


@pytest.mark.parametrize("model_names,expected", [
    (("a", "a", "b", "b"), ["a", "b"]),
    (("a", "b", "c", "c"), ["a", "b", "c"]),
    (("a", "b", "c", "d"), ["a", "b", "c", "d"]),
])
def test_required_models_are_distinct_and_ordered(settings, model_names, expected):
    from dataclasses import replace
    s = replace(
        settings, embedding_model=model_names[0], ocr_model=model_names[1],
        vision_model=model_names[2], chat_model=model_names[3],
    )

    assert s.required_models == expected
