"""
ocr_rag/rag/manual_pdf.py のテスト（テストDBに対する実DB統合テスト）
"""
import uuid

import pytest
from psycopg2.extras import RealDictCursor

from ocr_rag.rag.manual_pdf import fetch_manual_pdf, save_manual_pdf

PDF_BYTES = b"%PDF-1.4\n%fake manual body\n"


@pytest.fixture
def document_id(db):
    """テスト用のm_manual_documentを1件作成する"""
    source_file_name = f"manual_pdf_test_{uuid.uuid4().hex[:8]}.md"
    with db.get_cursor(cursor_factory=RealDictCursor) as cursor:
        cursor.execute(
            "INSERT INTO m_manual_document (title, source_file_name) VALUES (%s, %s) RETURNING id",
            ("PDFテスト", source_file_name),
        )
        doc_id = cursor.fetchone()["id"]
    return doc_id


class TestSaveAndFetchManualPdf:
    def test_roundtrip_returns_same_bytes(self, db, document_id):
        with db.get_cursor(cursor_factory=RealDictCursor) as cursor:
            save_manual_pdf(cursor, document_id, "AHU-1.pdf", PDF_BYTES)

        with db.get_cursor(cursor_factory=RealDictCursor) as cursor:
            pdf = fetch_manual_pdf(cursor, document_id)

        assert pdf == {"file_name": "AHU-1.pdf", "content": PDF_BYTES}
        assert pdf is not None
        assert isinstance(pdf["content"], bytes)

    def test_save_replaces_existing_pdf(self, db, document_id):
        with db.get_cursor(cursor_factory=RealDictCursor) as cursor:
            save_manual_pdf(cursor, document_id, "old.pdf", PDF_BYTES)
            save_manual_pdf(cursor, document_id, "new.pdf", PDF_BYTES + b"updated")

        with db.get_cursor(cursor_factory=RealDictCursor) as cursor:
            pdf = fetch_manual_pdf(cursor, document_id)
            cursor.execute("SELECT count(*) AS n FROM m_manual_pdf WHERE document_id = %s", (str(document_id),))
            count = cursor.fetchone()["n"]

        assert count == 1
        assert pdf is not None
        assert pdf["file_name"] == "new.pdf"
        assert pdf["content"].endswith(b"updated")

    def test_fetch_returns_none_when_no_pdf(self, db, document_id):
        with db.get_cursor(cursor_factory=RealDictCursor) as cursor:
            assert fetch_manual_pdf(cursor, document_id) is None

    def test_rejects_empty_content(self, db, document_id):
        with db.get_cursor(cursor_factory=RealDictCursor) as cursor:
            with pytest.raises(ValueError, match="空"):
                save_manual_pdf(cursor, document_id, "empty.pdf", b"")

    def test_rejects_non_pdf_content(self, db, document_id):
        with db.get_cursor(cursor_factory=RealDictCursor) as cursor:
            with pytest.raises(ValueError, match="PDF形式ではありません"):
                save_manual_pdf(cursor, document_id, "fake.pdf", b"plain text, not a pdf")

    def test_pdf_is_deleted_with_document(self, db, document_id):
        with db.get_cursor(cursor_factory=RealDictCursor) as cursor:
            save_manual_pdf(cursor, document_id, "AHU-1.pdf", PDF_BYTES)

        with db.get_cursor() as cursor:
            cursor.execute("DELETE FROM m_manual_document WHERE id = %s", (str(document_id),))

        with db.get_cursor(cursor_factory=RealDictCursor) as cursor:
            assert fetch_manual_pdf(cursor, document_id) is None
