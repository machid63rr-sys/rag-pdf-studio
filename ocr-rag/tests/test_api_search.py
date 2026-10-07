"""
ocr_rag/api/search.py のテスト

検索クエリの埋め込みは[1,0,0,...]に固定し、登録済みチャンクの類似度は
tests/helpers.fake_embeddingで厳密に指定する。
"""
import pytest

from tests.helpers import fake_embedding, insert_manual_chunk


def _search(client, query="質問", **body):
    return client.post("/search", json={"query": query, **body})


class TestSearch:
    def test_returns_results_ordered_by_similarity(self, client, db):
        insert_manual_chunk(db, "遠いマニュアル", "遠い内容", fake_embedding(-1.0))
        insert_manual_chunk(db, "近いマニュアル", "近い内容", fake_embedding(1.0))
        insert_manual_chunk(db, "中間のマニュアル", "中間の内容", fake_embedding(0.9))

        response = _search(client)

        assert response.status_code == 200
        results = response.json()
        assert [r["document_title"] for r in results] == ["近いマニュアル", "中間のマニュアル", "遠いマニュアル"]
        assert results[0]["content"] == "近い内容"
        assert results[1]["similarity"] == pytest.approx(0.9, abs=1e-4)
        assert set(results[0]) == {"content", "document_title", "document_id", "similarity"}

    def test_returns_empty_list_when_nothing_registered(self, client):
        assert _search(client).json() == []

    def test_top_k_limits_results(self, client, db):
        for i in range(4):
            insert_manual_chunk(db, f"マニュアル{i}", "内容", fake_embedding(1.0 - i * 0.1))

        assert len(_search(client, top_k=2).json()) == 2
        assert len(_search(client).json()) == 4  # 既定は5件まで

    def test_equipment_name_filters_to_matching_and_generic_manuals(self, client, db):
        insert_manual_chunk(db, "ESP-1", "内容", fake_embedding(1.0), equipment_names=["ESP-1"])
        insert_manual_chunk(db, "ESP-2", "内容", fake_embedding(1.0), equipment_names=["ESP-2"])
        insert_manual_chunk(db, "汎用", "内容", fake_embedding(1.0))

        results = _search(client, equipment_name="ESP-1").json()

        assert {r["document_title"] for r in results} == {"ESP-1", "汎用"}

    @pytest.mark.parametrize("equipment_name", [None, "", "   "])
    def test_blank_equipment_name_means_no_filter(self, client, db, equipment_name):
        insert_manual_chunk(db, "ESP-1", "内容", fake_embedding(1.0), equipment_names=["ESP-1"])
        insert_manual_chunk(db, "ESP-2", "内容", fake_embedding(1.0), equipment_names=["ESP-2"])

        results = _search(client, equipment_name=equipment_name).json()

        assert {r["document_title"] for r in results} == {"ESP-1", "ESP-2"}

    @pytest.mark.parametrize("query", ["", "   ", "\n"])
    def test_blank_query_returns_422(self, client, query):
        assert _search(client, query=query).status_code == 422

    def test_too_long_query_returns_422(self, client):
        assert _search(client, query="あ" * 2001).status_code == 422

    @pytest.mark.parametrize("top_k", [0, -1, 21])
    def test_out_of_range_top_k_returns_422(self, client, top_k):
        assert _search(client, top_k=top_k).status_code == 422
