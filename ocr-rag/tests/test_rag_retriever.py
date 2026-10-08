"""
ocr_rag/rag/rag_retriever.py のテスト

Ollamaへの実HTTP呼び出しはrequests.postをmonkeypatchして検証する。pgvectorのコサイン
距離検索自体は実DB（テストDB、schema.sqlでpgvector拡張・m_manual_chunk等を作成済み）で検証する。
"""
import pytest
import requests

from ocr_rag.rag.rag_retriever import ManualRetriever, to_pgvector_literal
from tests.helpers import fake_embedding, insert_extra_chunk, insert_manual_chunk


@pytest.fixture
def retriever(db):
    return ManualRetriever(db, ollama_host="http://fake-ollama:11434", embedding_model="bge-m3")


@pytest.fixture
def query_matches_unit_vector(retriever, monkeypatch):
    """検索クエリの埋め込みを[1,0,0,...]に固定する"""
    monkeypatch.setattr(retriever, "embed", lambda text: fake_embedding(1.0))


@pytest.fixture
def manual_chunk_factory(db):
    """1チャンクだけを持つマニュアル文書を作る（登録データは各テストの開始時にdbが空にする）"""
    def _make(title, content, embedding, equipment_names=()):
        return insert_manual_chunk(db, title, content, embedding, equipment_names)

    return _make


# =============================================================================
# embed()
# =============================================================================

class TestEmbed:
    def test_calls_ollama_embeddings_endpoint(self, retriever, monkeypatch):
        captured = {}

        class _FakeResponse:
            def raise_for_status(self):
                pass

            def json(self):
                return {"embedding": fake_embedding(0.5)}

        def _fake_post(url, json=None, timeout=None):
            captured["url"] = url
            captured["json"] = json
            return _FakeResponse()

        monkeypatch.setattr(requests, "post", _fake_post)

        result = retriever.embed("テスト文章")

        assert result == fake_embedding(0.5)
        assert captured["url"] == "http://fake-ollama:11434/api/embeddings"
        assert captured["json"] == {"model": "bge-m3", "prompt": "テスト文章"}

    def test_propagates_request_exception(self, retriever, monkeypatch):
        def _fake_post(*args, **kwargs):
            raise requests.exceptions.ConnectionError("connection refused")

        monkeypatch.setattr(requests, "post", _fake_post)

        with pytest.raises(requests.RequestException):
            retriever.embed("テスト文章")

    def test_dimension_mismatch_raises_value_error(self, retriever, monkeypatch):
        class _FakeResponse:
            def raise_for_status(self):
                pass

            def json(self):
                return {"embedding": [0.1, 0.2, 0.3]}  # 想定次元(1024)と不一致

        monkeypatch.setattr(requests, "post", lambda *a, **k: _FakeResponse())

        with pytest.raises(ValueError, match="出力次元"):
            retriever.embed("テスト文章")


# =============================================================================
# to_pgvector_literal()
# =============================================================================

class TestToPgvectorLiteral:
    def test_formats_as_bracketed_csv(self):
        assert to_pgvector_literal([0.1, -0.2, 3.0]) == "[0.1,-0.2,3.0]"


# =============================================================================
# search()
# =============================================================================

@pytest.mark.usefixtures("query_matches_unit_vector")
class TestSearch:
    def test_returns_empty_list_when_no_chunks(self, retriever):
        assert retriever.search("何らかの質問", top_k=5) == []

    def test_orders_by_similarity_descending(self, retriever, manual_chunk_factory):
        manual_chunk_factory("近いマニュアル", "近い内容", fake_embedding(1.0))
        manual_chunk_factory("中間のマニュアル", "中間の内容", fake_embedding(0.9))
        manual_chunk_factory("遠いマニュアル", "遠い内容", fake_embedding(-1.0))

        results = retriever.search("クエリ", top_k=5)

        assert [r["document_title"] for r in results] == ["近いマニュアル", "中間のマニュアル", "遠いマニュアル"]
        assert results[0]["similarity"] > results[1]["similarity"] > results[2]["similarity"]

    def test_similarity_is_one_minus_cosine_distance(self, retriever, manual_chunk_factory):
        manual_chunk_factory("マニュアル", "内容", fake_embedding(0.9))

        results = retriever.search("クエリ", top_k=5)

        assert results[0]["similarity"] == pytest.approx(0.9, abs=1e-4)

    def test_limits_results_to_top_k(self, retriever, manual_chunk_factory):
        for i in range(4):
            manual_chunk_factory(f"マニュアル{i}", "内容", fake_embedding(1.0 - i * 0.1))

        results = retriever.search("クエリ", top_k=2)

        assert [r["document_title"] for r in results] == ["マニュアル0", "マニュアル1"]

    def test_returns_content_and_document_id_as_string_for_pdf_link(
        self, retriever, manual_chunk_factory
    ):
        document_id = manual_chunk_factory("リンク用マニュアル", "本文の内容", fake_embedding(1.0))

        results = retriever.search("クエリ", top_k=5)

        assert results[0]["content"] == "本文の内容"
        assert results[0]["document_id"] == str(document_id)
        assert isinstance(results[0]["document_id"], str)  # JSONでそのまま返せる

    def test_equipment_name_filters_to_matching_and_untagged_manuals(
        self, retriever, manual_chunk_factory
    ):
        manual_chunk_factory("ESP-1マニュアル", "ESP-1の内容", fake_embedding(1.0), equipment_names=["ESP-1"])
        manual_chunk_factory("タグ名未設定マニュアル", "汎用内容", fake_embedding(1.0))
        manual_chunk_factory("ESP-2マニュアル", "ESP-2の内容", fake_embedding(1.0), equipment_names=["ESP-2"])

        results = retriever.search("クエリ", equipment_name="ESP-1", top_k=5)

        assert {r["document_title"] for r in results} == {"ESP-1マニュアル", "タグ名未設定マニュアル"}

    def test_manual_with_multiple_equipment_names_matches_any_of_them(
        self, retriever, manual_chunk_factory
    ):
        manual_chunk_factory(
            "R-1/R-2共通マニュアル", "共通の内容", fake_embedding(1.0), equipment_names=["R-1", "R-2"]
        )
        manual_chunk_factory("ESP-1マニュアル", "ESP-1の内容", fake_embedding(1.0), equipment_names=["ESP-1"])

        for name in ("R-1", "R-2"):
            results = retriever.search("クエリ", equipment_name=name, top_k=5)
            assert {r["document_title"] for r in results} == {"R-1/R-2共通マニュアル"}

        results = retriever.search("クエリ", equipment_name="ESP-1", top_k=5)
        assert {r["document_title"] for r in results} == {"ESP-1マニュアル"}

    def test_no_equipment_name_filter_returns_all_manuals(self, retriever, manual_chunk_factory):
        manual_chunk_factory("ESP-1マニュアル", "ESP-1の内容", fake_embedding(1.0), equipment_names=["ESP-1"])
        manual_chunk_factory("ESP-2マニュアル", "ESP-2の内容", fake_embedding(1.0), equipment_names=["ESP-2"])
        manual_chunk_factory("タグ名未設定マニュアル", "汎用内容", fake_embedding(1.0))

        results = retriever.search("クエリ", top_k=5)

        assert {r["document_title"] for r in results} == {"ESP-1マニュアル", "ESP-2マニュアル", "タグ名未設定マニュアル"}

    @pytest.mark.parametrize("query", ["", "   ", "\n"])
    def test_rejects_blank_query(self, retriever, query):
        with pytest.raises(ValueError, match="検索クエリが空"):
            retriever.search(query)

    @pytest.mark.parametrize("top_k", [0, -1])
    def test_rejects_non_positive_top_k(self, retriever, top_k):
        with pytest.raises(ValueError, match="top_k"):
            retriever.search("クエリ", top_k=top_k)


# =============================================================================
# search_tagged()
# =============================================================================

@pytest.mark.usefixtures("query_matches_unit_vector")
class TestSearchTagged:
    def test_returns_only_manuals_with_one_of_the_tag_names(self, retriever, manual_chunk_factory):
        manual_chunk_factory("Aの資料", "内容", fake_embedding(0.3), equipment_names=["A"])
        manual_chunk_factory("A・Bの資料", "内容", fake_embedding(0.3), equipment_names=["A", "B"])
        manual_chunk_factory("Cの資料", "内容", fake_embedding(0.3), equipment_names=["C"])

        results = retriever.search_tagged("クエリ", ["B", "C"])

        assert {r["document_title"] for r in results} == {"A・Bの資料", "Cの資料"}

    def test_excludes_manuals_without_any_tag_unlike_search(self, retriever, manual_chunk_factory):
        manual_chunk_factory("Aの資料", "内容", fake_embedding(0.3), equipment_names=["A"])
        manual_chunk_factory("タグなしの資料", "内容", fake_embedding(1.0))

        assert [r["document_title"] for r in retriever.search_tagged("クエリ", ["A"])] == ["Aの資料"]

    def test_returns_low_similarity_chunks_without_a_cutoff(self, retriever, manual_chunk_factory):
        manual_chunk_factory("Aの資料", "内容", fake_embedding(0.1), equipment_names=["A"])

        results = retriever.search_tagged("クエリ", ["A"])

        assert results[0]["similarity"] == pytest.approx(0.1, abs=1e-4)

    def test_returns_only_the_closest_chunk_of_each_manual(self, retriever, manual_chunk_factory, db):
        document_id = manual_chunk_factory("Aの資料", "遠い内容", fake_embedding(0.2), equipment_names=["A"])
        insert_extra_chunk(db, document_id, 1, "近い内容", fake_embedding(0.8))
        insert_extra_chunk(db, document_id, 2, "中くらいの内容", fake_embedding(0.5))
        manual_chunk_factory("A・Bの資料", "別の資料の内容", fake_embedding(0.4), equipment_names=["A", "B"])

        results = retriever.search_tagged("クエリ", ["A"])

        # 複数のタグ名が付いた文書も、複数のタグ名に当たっても、1回だけ。類似度の降順
        assert [(r["document_title"], r["content"]) for r in results] == [
            ("Aの資料", "近い内容"), ("A・Bの資料", "別の資料の内容"),
        ]
        results = retriever.search_tagged("クエリ", ["A", "B"])
        assert [r["document_title"] for r in results] == ["Aの資料", "A・Bの資料"]

    def test_result_has_the_same_shape_as_search(self, retriever, manual_chunk_factory):
        document_id = manual_chunk_factory("Aの資料", "本文", fake_embedding(0.5), equipment_names=["A"])

        result = retriever.search_tagged("クエリ", ["A"])[0]

        assert set(result) == {"content", "document_title", "document_id", "similarity"}
        assert result["document_id"] == str(document_id)

    def test_limits_the_number_of_manuals(self, retriever, manual_chunk_factory):
        for i in range(4):
            manual_chunk_factory(f"資料{i}", "内容", fake_embedding(0.5 - i * 0.1), equipment_names=["A"])

        results = retriever.search_tagged("クエリ", ["A"], top_k=2)

        assert [r["document_title"] for r in results] == ["資料0", "資料1"]

    def test_returns_nothing_when_no_manual_has_the_tag(self, retriever, manual_chunk_factory):
        manual_chunk_factory("Aの資料", "内容", fake_embedding(1.0), equipment_names=["A"])

        assert retriever.search_tagged("クエリ", ["Z"]) == []

    def test_rejects_blank_query_empty_tags_and_non_positive_top_k(self, retriever):
        with pytest.raises(ValueError, match="検索クエリが空"):
            retriever.search_tagged("  ", ["A"])
        with pytest.raises(ValueError, match="タグ名"):
            retriever.search_tagged("クエリ", [])
        with pytest.raises(ValueError, match="top_k"):
            retriever.search_tagged("クエリ", ["A"], top_k=0)
