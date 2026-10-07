"""
ocr_rag/api/ocr_drafts.py のテスト

OCR本体は偽物（tests/helpers.FakePipeline）に差し替え、ジョブをその場で実行する。
API自体の責務（バリデーション・登録・状態の遷移・一覧・原本PDF・エラー応答）を検証する。
"""
import uuid
from typing import Optional

import pytest
import requests

PDF_BYTES = b"%PDF-1.4\n%fake manual body\n"


def _post_pdf(client, name="R-1.pdf", content=PDF_BYTES, **data):
    return client.post("/ocr-drafts", files={"file": (name, content, "application/pdf")}, data=data)


def _insert_draft(db, status="DRAFT", markdown="下書き本文", pdf: Optional[bytes] = PDF_BYTES, file_name="manual_test.pdf"):
    with db.get_cursor() as cursor:
        cursor.execute(
            "INSERT INTO t_manual_ocr_draft "
            "(source_file_name, title, draft_markdown, diff_segments, page_count, pages_done, status, pdf_content) "
            "VALUES (%s, %s, %s, %s::jsonb, 1, 1, %s, %s) RETURNING id",
            (file_name, "manual_test", markdown, '[{"page": 1, "segment_id": "seg-0", "status": "match"}]',
             status, pdf),
        )
        return cursor.fetchone()["id"]


class TestCreateOcrDraft:
    def test_returns_202_with_queued_draft_then_job_completes(self, client):
        response = _post_pdf(client)

        assert response.status_code == 202
        body = response.json()
        assert body["status"] == "QUEUED"
        assert body["source_file_name"] == "R-1.pdf"
        assert body["title"] == "R-1"
        assert body["has_pdf"] is True
        assert body["draft_markdown"] == ""
        assert body["diff_segments"] == []

        # テストのジョブ実行器はその場で実行するので、次に取得した時点で完了している
        finished = client.get(f"/ocr-drafts/{body['id']}").json()
        assert finished["status"] == "DRAFT"
        assert finished["page_count"] == 2 and finished["pages_done"] == 2
        assert "ページ1の本文" in finished["draft_markdown"]
        assert finished["diff_segments"][0]["segment_id"] == "seg-1"
        assert finished["error_message"] is None

    def test_passes_settings_password_and_pdf_to_pipeline(self, client, settings, fake_pipeline):
        _post_pdf(client, password="pw")

        call = fake_pipeline.calls[0]
        assert call["pdf_bytes"] == PDF_BYTES
        assert call["password"] == "pw"
        assert call["ollama_host"] == settings.ollama_host
        assert call["glm_model"] == settings.ocr_model
        assert call["vision_model"] == settings.vision_model
        assert call["vision_timeout_seconds"] == settings.vision_timeout_seconds
        assert not call["pdf_path"].exists()  # 処理後に一時ファイルが残らない

    def test_rejects_non_pdf_extension(self, client, fake_pipeline):
        response = _post_pdf(client, name="manual.txt")

        assert response.status_code == 400
        assert fake_pipeline.calls == []

    def test_rejects_content_without_pdf_header(self, client, fake_pipeline):
        response = _post_pdf(client, content=b"plain text, not a pdf")

        assert response.status_code == 400
        assert "PDF形式ではありません" in response.json()["detail"]
        assert fake_pipeline.calls == []

    def test_rejects_file_over_upload_limit(self, client, settings, fake_pipeline):
        response = _post_pdf(client, content=PDF_BYTES + b"x" * settings.max_upload_bytes)

        assert response.status_code == 413
        assert fake_pipeline.calls == []

    def test_strips_directories_from_file_name(self, client):
        response = _post_pdf(client, name="../../etc/R-1.pdf")

        assert response.status_code == 202
        assert response.json()["source_file_name"] == "R-1.pdf"

    def test_pipeline_failure_is_recorded_as_failed_with_reason(self, client, fake_pipeline):
        fake_pipeline.error = RuntimeError("pdftoppmに失敗しました")

        draft_id = _post_pdf(client).json()["id"]

        failed = client.get(f"/ocr-drafts/{draft_id}").json()
        assert failed["status"] == "FAILED"
        assert "pdftoppmに失敗しました" in failed["error_message"]

    def test_ollama_failure_message_mentions_ollama(self, client, fake_pipeline):
        fake_pipeline.error = requests.exceptions.ConnectionError("connection refused")

        draft_id = _post_pdf(client).json()["id"]

        assert "Ollama" in client.get(f"/ocr-drafts/{draft_id}").json()["error_message"]


class TestListOcrDrafts:
    def test_lists_newest_first_without_discarded_and_without_body(self, client, db):
        old_id = _insert_draft(db, file_name="old.pdf")
        discarded_id = _insert_draft(db, status="DISCARDED", file_name="discarded.pdf", pdf=None)
        new_id = _insert_draft(db, status="RUNNING", file_name="new.pdf")

        drafts = client.get("/ocr-drafts").json()

        assert [d["id"] for d in drafts] == [str(new_id), str(old_id)]
        assert str(discarded_id) not in [d["id"] for d in drafts]
        assert drafts[0]["status"] == "RUNNING"
        assert "draft_markdown" not in drafts[0]
        assert drafts[0]["has_pdf"] is True

    def test_empty(self, client):
        assert client.get("/ocr-drafts").json() == []


class TestGetOcrDraft:
    def test_returns_draft(self, client, db):
        draft_id = _insert_draft(db)

        response = client.get(f"/ocr-drafts/{draft_id}")

        assert response.status_code == 200
        assert response.json()["draft_markdown"] == "下書き本文"
        assert response.json()["diff_segments"][0]["segment_id"] == "seg-0"

    def test_unknown_id_returns_404(self, client):
        assert client.get(f"/ocr-drafts/{uuid.uuid4()}").status_code == 404

    def test_invalid_id_returns_422(self, client):
        assert client.get("/ocr-drafts/not-a-uuid").status_code == 422


class TestUpdateOcrDraft:
    def test_updates_markdown(self, client, db):
        draft_id = _insert_draft(db)

        response = client.patch(f"/ocr-drafts/{draft_id}", json={"draft_markdown": "修正後の本文"})

        assert response.status_code == 200
        assert response.json()["draft_markdown"] == "修正後の本文"
        assert client.get(f"/ocr-drafts/{draft_id}").json()["draft_markdown"] == "修正後の本文"

    @pytest.mark.parametrize("status", ["QUEUED", "RUNNING", "FAILED", "DISCARDED"])
    def test_only_completed_drafts_can_be_edited(self, client, db, status):
        draft_id = _insert_draft(db, status=status)

        response = client.patch(f"/ocr-drafts/{draft_id}", json={"draft_markdown": "x"})

        assert response.status_code == 409

    def test_unknown_id_returns_404(self, client):
        response = client.patch(f"/ocr-drafts/{uuid.uuid4()}", json={"draft_markdown": "x"})
        assert response.status_code == 404


class TestDiscardOcrDraft:
    @pytest.mark.parametrize("status", ["QUEUED", "RUNNING", "DRAFT", "FAILED"])
    def test_discards_draft_in_any_live_status_and_removes_pdf(self, client, db, status):
        draft_id = _insert_draft(db, status=status)

        response = client.post(f"/ocr-drafts/{draft_id}/discard")

        assert response.status_code == 200
        assert client.get(f"/ocr-drafts/{draft_id}").json()["status"] == "DISCARDED"
        assert client.get(f"/ocr-drafts/{draft_id}").json()["has_pdf"] is False
        assert client.get(f"/ocr-drafts/{draft_id}/pdf").status_code == 404

    def test_discarding_twice_returns_409(self, client, db):
        draft_id = _insert_draft(db)
        client.post(f"/ocr-drafts/{draft_id}/discard")

        assert client.post(f"/ocr-drafts/{draft_id}/discard").status_code == 409

    def test_unknown_id_returns_404(self, client):
        assert client.post(f"/ocr-drafts/{uuid.uuid4()}/discard").status_code == 404


class TestGetOcrDraftPdf:
    def test_returns_original_pdf_inline(self, client, db):
        draft_id = _insert_draft(db, file_name="チラー.pdf")

        response = client.get(f"/ocr-drafts/{draft_id}/pdf")

        assert response.status_code == 200
        assert response.content == PDF_BYTES
        assert response.headers["content-type"] == "application/pdf"
        assert response.headers["content-disposition"].startswith("inline; filename*=UTF-8''")

    def test_unknown_id_returns_404(self, client):
        assert client.get(f"/ocr-drafts/{uuid.uuid4()}/pdf").status_code == 404
