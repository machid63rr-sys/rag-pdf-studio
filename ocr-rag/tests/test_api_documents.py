"""
ocr_rag/api/documents.py のテスト

埋め込み（Ollama）はダミーに差し替え、DBはテストDBの実物を使う。
"""
import requests
from psycopg2.extras import RealDictCursor

PDF_BYTES = b"%PDF-1.4\n%fake manual body\n"
MARKDOWN = "## 6. 故障時の原因と対策\n\n| 不具合 | 原因 |\n|---|---|\n| 運転しない | 電源が入っていない |\n"


def _post_document(client, name="AHU-1.md", content=MARKDOWN.encode("utf-8"), pdf=None, **data):
    files = {"markdown_file": (name, content, "text/markdown")}
    if pdf is not None:
        files["pdf_file"] = pdf
    return client.post("/documents", files=files, data=data)


class TestCreateDocument:
    def test_registers_markdown_with_equipment_names_and_pdf(self, client):
        response = _post_document(
            client, title="AHU-1 空調機", equipment_names=["AHU-1", "AHU-2"],
            pdf=("AHU-1.pdf", PDF_BYTES, "application/pdf"),
        )

        assert response.status_code == 201
        body = response.json()
        assert body["title"] == "AHU-1 空調機"
        assert body["source_file_name"] == "AHU-1.md"
        assert body["equipment_names"] == ["AHU-1", "AHU-2"]
        assert body["chunk_count"] >= 1
        assert body["has_pdf"] is True

    def test_title_defaults_to_file_name_stem(self, client):
        assert _post_document(client, name="R-1チラー.md").json()["title"] == "R-1チラー"

    def test_equipment_names_are_trimmed_deduplicated_and_blank_dropped(self, client):
        response = _post_document(client, equipment_names=[" ESP-1 ", "ESP-1", "", "  ", "ESP-2"])

        assert response.json()["equipment_names"] == ["ESP-1", "ESP-2"]

    def test_no_equipment_names_registers_generic_document(self, client):
        response = _post_document(client)

        assert response.status_code == 201
        assert response.json()["equipment_names"] == []
        assert response.json()["has_pdf"] is False

    def test_utf8_bom_is_removed_from_content(self, client, db):
        _post_document(client, content=b"\xef\xbb\xbf" + "# 見出し\n本文です".encode("utf-8"))

        with db.get_cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute("SELECT content FROM m_manual_chunk")
            contents = [r["content"] for r in cursor.fetchall()]
        assert contents == ["【見出し】\n本文です"]

    def test_re_registering_same_file_name_replaces_document(self, client):
        _post_document(client, content="最初の本文です".encode("utf-8"))
        _post_document(client, content="更新後の本文です".encode("utf-8"))

        documents = client.get("/documents").json()
        assert len(documents) == 1

    def test_re_registering_without_pdf_keeps_previous_pdf(self, client):
        first = _post_document(client, pdf=("AHU-1.pdf", PDF_BYTES, "application/pdf")).json()
        second = _post_document(client).json()

        assert second["id"] != first["id"]
        assert second["has_pdf"] is True

    def test_rejects_unsupported_extension(self, client):
        response = _post_document(client, name="manual.docx")

        assert response.status_code == 400
        assert client.get("/documents").json() == []

    def test_rejects_non_utf8_content(self, client):
        response = _post_document(client, content="日本語".encode("shift_jis"))

        assert response.status_code == 400
        assert "UTF-8" in response.json()["detail"]

    def test_rejects_blank_content(self, client):
        response = _post_document(client, content=b"  \n\n ")

        assert response.status_code == 400

    def test_rejects_pdf_without_pdf_header(self, client):
        response = _post_document(client, pdf=("AHU-1.pdf", b"not a pdf", "application/pdf"))

        assert response.status_code == 400
        assert "PDF形式ではありません" in response.json()["detail"]
        assert client.get("/documents").json() == []

    def test_rejects_too_long_title(self, client):
        assert _post_document(client, title="あ" * 256).status_code == 400

    def test_rejects_too_long_equipment_name(self, client):
        assert _post_document(client, equipment_names=["E" * 256]).status_code == 400

    def test_rejects_markdown_over_upload_limit(self, client, settings):
        response = _post_document(client, content=b"a" * (settings.max_upload_bytes + 1))

        assert response.status_code == 413

    def test_returns_502_and_registers_nothing_when_ollama_is_unreachable(self, client, api_retriever, monkeypatch):
        def _fail(text):
            raise requests.exceptions.ConnectionError("connection refused")

        monkeypatch.setattr(api_retriever, "embed", _fail)

        response = _post_document(client)

        assert response.status_code == 502
        assert client.get("/documents").json() == []


class TestListDocumentsAndEquipmentNames:
    def test_lists_documents_newest_first(self, client):
        _post_document(client, name="old.md", equipment_names=["ESP-1"])
        _post_document(client, name="new.md", equipment_names=["AHU-1"])

        documents = client.get("/documents").json()

        assert [d["source_file_name"] for d in documents] == ["new.md", "old.md"]
        assert documents[0]["equipment_names"] == ["AHU-1"]

    def test_empty_when_nothing_registered(self, client):
        assert client.get("/documents").json() == []
        assert client.get("/equipment-names").json() == []

    def test_equipment_names_are_distinct_and_sorted(self, client):
        _post_document(client, name="a.md", equipment_names=["ESP-2", "AHU-1"])
        _post_document(client, name="b.md", equipment_names=["AHU-1", "ESP-1"])

        names = [r["equipment_name"] for r in client.get("/equipment-names").json()]

        assert names == ["AHU-1", "ESP-1", "ESP-2"]


class TestGetDocumentPdf:
    def test_returns_pdf_inline_with_utf8_file_name(self, client):
        document_id = _post_document(client, pdf=("チラー.pdf", PDF_BYTES, "application/pdf")).json()["id"]

        response = client.get(f"/documents/{document_id}/pdf")

        assert response.status_code == 200
        assert response.content == PDF_BYTES
        assert response.headers["content-type"] == "application/pdf"
        assert response.headers["content-disposition"].startswith("inline; filename*=UTF-8''")

    def test_returns_404_when_document_has_no_pdf(self, client):
        document_id = _post_document(client).json()["id"]

        assert client.get(f"/documents/{document_id}/pdf").status_code == 404

    def test_returns_404_for_unknown_document(self, client):
        assert client.get("/documents/00000000-0000-0000-0000-000000000000/pdf").status_code == 404
