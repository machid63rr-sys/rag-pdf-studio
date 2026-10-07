"""
ocr_rag/rag/manual_ingestion.py の ingest_manual_text のテスト

テストDBに対する実DB統合テスト。Ollama埋め込み呼び出しは
ManualRetriever.embedをmonkeypatchして避ける。
"""
import uuid
from typing import Any, Dict

import pytest
import requests
from psycopg2.extras import RealDictCursor

from ocr_rag.rag.manual_ingestion import ingest_manual_text
from ocr_rag.rag.manual_pdf import fetch_manual_pdf
from ocr_rag.rag.rag_retriever import ManualRetriever
from tests.helpers import fake_embedding

PDF_BYTES = b"%PDF-1.4\n%fake manual body\n"


@pytest.fixture
def retriever(db, monkeypatch):
    r = ManualRetriever(db, ollama_host="http://fake-ollama:11434", embedding_model="bge-m3")
    monkeypatch.setattr(r, "embed", lambda text: fake_embedding(1.0))
    return r


def _name(prefix: str = "ingest_test") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}.md"


def _ingest(db, retriever, source_file_name, **overrides):
    kwargs: Dict[str, Any] = dict(
        source_file_name=source_file_name, title="取り込みテスト",
        equipment_names=["AHU-1"], text="本文です",
    )
    kwargs.update(overrides)
    return ingest_manual_text(db, retriever, **kwargs)


def _fetch_all(db, query, params=()):
    with db.get_cursor(cursor_factory=RealDictCursor) as cursor:
        cursor.execute(query, params)
        return cursor.fetchall()


class TestIngestManualText:
    def test_empty_text_raises_runtime_error(self, db, retriever):
        with pytest.raises(RuntimeError, match="有効なテキスト"):
            _ingest(db, retriever, _name(), text="   \n ")

    def test_ingests_document_chunks_and_equipment_names(self, db, retriever):
        name = _name()
        document_id = _ingest(
            db, retriever, name, title="ESPマニュアル",
            equipment_names=["ESP-1", "ESP-1", "ESP-2"],  # 重複は1件にまとめる
            text="0123456789" * 5, chunk_size=20, chunk_overlap=5,
        )

        documents = _fetch_all(
            db, "SELECT id, title, source_file_name FROM m_manual_document WHERE id = %s", (str(document_id),)
        )
        assert len(documents) == 1
        assert documents[0]["title"] == "ESPマニュアル"
        assert documents[0]["source_file_name"] == name

        equipment = _fetch_all(
            db, "SELECT equipment_name FROM r_manual_document_equipment WHERE document_id = %s "
                "ORDER BY equipment_name", (str(document_id),)
        )
        assert [r["equipment_name"] for r in equipment] == ["ESP-1", "ESP-2"]

        chunks = _fetch_all(
            db, "SELECT chunk_index, content FROM m_manual_chunk WHERE document_id = %s "
                "ORDER BY chunk_index", (str(document_id),)
        )
        assert len(chunks) > 1
        assert [c["chunk_index"] for c in chunks] == list(range(len(chunks)))

    def test_no_equipment_names_registers_generic_document(self, db, retriever):
        document_id = _ingest(db, retriever, _name(), equipment_names=[])

        equipment = _fetch_all(
            db, "SELECT 1 FROM r_manual_document_equipment WHERE document_id = %s", (str(document_id),)
        )
        assert equipment == []

    def test_reingest_replaces_previous_chunks(self, db, retriever):
        name = _name()
        _ingest(db, retriever, name, text="最初のバージョンの本文です")
        _ingest(db, retriever, name, text="更新後のバージョンの本文です。内容が変わりました。")

        documents = _fetch_all(db, "SELECT id FROM m_manual_document WHERE source_file_name = %s", (name,))
        assert len(documents) == 1
        chunks = _fetch_all(
            db, "SELECT content FROM m_manual_chunk WHERE document_id = %s", (str(documents[0]["id"]),)
        )
        assert len(chunks) == 1
        assert "更新後" in chunks[0]["content"]

    def test_embedding_failure_keeps_existing_document(self, db, retriever, monkeypatch):
        """Ollamaの失敗で再登録が止まっても、既存の登録済み文書は削除されない"""
        name = _name()
        _ingest(db, retriever, name, text="最初のバージョンの本文です")

        def _fail(text):
            raise requests.exceptions.ConnectionError("connection refused")

        monkeypatch.setattr(retriever, "embed", _fail)

        with pytest.raises(requests.RequestException):
            _ingest(db, retriever, name, text="更新後の本文です")

        chunks = _fetch_all(
            db, "SELECT c.content FROM m_manual_chunk c JOIN m_manual_document d ON d.id = c.document_id "
                "WHERE d.source_file_name = %s", (name,)
        )
        assert [c["content"] for c in chunks] == ["最初のバージョンの本文です"]

    def test_db_failure_rolls_back_replacement(self, db, retriever, monkeypatch):
        """DB書き込みの途中で失敗した場合、旧文書の削除も含めて巻き戻る"""
        name = _name()
        _ingest(db, retriever, name, text="最初のバージョンの本文です")

        # 次元不一致のベクトルでchunkのINSERTだけが失敗する状況を作る
        monkeypatch.setattr(retriever, "embed", lambda text: [1.0, 0.0])
        with pytest.raises(Exception):
            _ingest(db, retriever, name, text="更新後の本文です")

        chunks = _fetch_all(
            db, "SELECT c.content FROM m_manual_chunk c JOIN m_manual_document d ON d.id = c.document_id "
                "WHERE d.source_file_name = %s", (name,)
        )
        assert [c["content"] for c in chunks] == ["最初のバージョンの本文です"]


class TestIngestManualTextPdf:
    def _fetch_pdf(self, db, document_id):
        with db.get_cursor(cursor_factory=RealDictCursor) as cursor:
            return fetch_manual_pdf(cursor, document_id)

    def test_stores_pdf_when_given(self, db, retriever):
        document_id = _ingest(db, retriever, _name(), pdf_file_name="AHU-1.pdf", pdf_content=PDF_BYTES)
        assert self._fetch_pdf(db, document_id) == {"file_name": "AHU-1.pdf", "content": PDF_BYTES}

    def test_no_pdf_when_not_given(self, db, retriever):
        document_id = _ingest(db, retriever, _name())
        assert self._fetch_pdf(db, document_id) is None

    def test_reingest_without_pdf_keeps_previous_pdf(self, db, retriever):
        name = _name()
        first_id = _ingest(db, retriever, name, pdf_file_name="AHU-1.pdf", pdf_content=PDF_BYTES)
        second_id = _ingest(db, retriever, name)  # PDF指定なしの再登録

        assert second_id != first_id  # documentは作り直される
        assert self._fetch_pdf(db, second_id) == {"file_name": "AHU-1.pdf", "content": PDF_BYTES}

    def test_reingest_with_pdf_replaces_previous_pdf(self, db, retriever):
        name = _name()
        new_pdf = PDF_BYTES + b"v2"
        _ingest(db, retriever, name, pdf_file_name="old.pdf", pdf_content=PDF_BYTES)
        document_id = _ingest(db, retriever, name, pdf_file_name="new.pdf", pdf_content=new_pdf)

        assert self._fetch_pdf(db, document_id) == {"file_name": "new.pdf", "content": new_pdf}

    @pytest.mark.parametrize("kwargs", [
        {"pdf_file_name": "AHU-1.pdf"},
        {"pdf_content": PDF_BYTES},
    ])
    def test_rejects_only_one_of_pdf_name_and_content(self, db, retriever, kwargs):
        with pytest.raises(ValueError, match="両方"):
            _ingest(db, retriever, _name(), **kwargs)
