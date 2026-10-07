"""
OCR下書きAPI（機能②: PDF→OCR→Markdown）

- POST   /ocr-drafts                : PDFをアップロードして、OCRをバックグラウンドで開始する（即座に202で返る）
- GET    /ocr-drafts                : 下書きの一覧（破棄済みを除く、新しい順）
- GET    /ocr-drafts/{id}           : 下書きの取得（状態・進捗の確認と、リロード後の復元用）
- PATCH  /ocr-drafts/{id}           : OCR完了後の下書き本文の人手編集を保存する
- POST   /ocr-drafts/{id}/discard   : 下書きの破棄（実行中なら、次のページの区切りで中止される）
- GET    /ocr-drafts/{id}/pdf       : アップロードされた原本PDF

OCRは1ページ数分かかるため、実行はocr_rag/ocr_jobs.pyがバックグラウンドで行う。
状態は QUEUED(待ち) → RUNNING(実行中) → DRAFT(完了。人手で確認・修正) / FAILED(失敗)。
"""
import logging
from datetime import datetime
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from psycopg2 import Binary
from pydantic import BaseModel

from ocr_rag.api.context import AppContext, get_context
from ocr_rag.api.uploads import read_upload_limited, require_pdf_content, validated_file_name

router = APIRouter(prefix="/ocr-drafts", tags=["② OCR（PDF → Markdown）"])
logger = logging.getLogger(__name__)

MAX_LISTED_DRAFTS = 50

_SUMMARY_COLUMNS = """
    id, source_file_name, title, status, page_count, pages_done, error_message,
    (pdf_content IS NOT NULL) AS has_pdf, created_at, updated_at
"""
_DETAIL_COLUMNS = f"{_SUMMARY_COLUMNS}, draft_markdown, diff_segments"


class OcrDraftSummary(BaseModel):
    id: UUID
    source_file_name: str
    title: Optional[str]
    status: str
    page_count: int
    pages_done: int
    error_message: Optional[str]
    has_pdf: bool
    created_at: datetime
    updated_at: datetime


class OcrDraftResponse(OcrDraftSummary):
    draft_markdown: str
    diff_segments: List[dict]


class UpdateDraftRequest(BaseModel):
    draft_markdown: str


def _fetch_draft_row(cursor, draft_id: UUID) -> dict:
    cursor.execute(f"SELECT {_DETAIL_COLUMNS} FROM t_manual_ocr_draft WHERE id = %s", (str(draft_id),))
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"下書き {draft_id} が見つかりません")
    return row


@router.post(
    "", status_code=status.HTTP_202_ACCEPTED, response_model=OcrDraftResponse,
    summary="PDFのOCRを開始する（バックグラウンドで実行。1ページ数分かかります）",
)
def create_ocr_draft(
    file: UploadFile = File(..., description="OCRするPDFファイル"),
    password: Optional[str] = Form(None, description="暗号化PDFの場合のみ、パスワード"),
    ctx: AppContext = Depends(get_context),
):
    """
    PDFを受け取り、下書き（QUEUED）を登録して、OCRを順番待ちに入れる。結果を待たずに返るので、
    状態と進捗は GET /ocr-drafts/{id} で確認する。
    """
    file_name = validated_file_name(file.filename)
    if not file_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="PDFファイルのみ対応しています")

    content = read_upload_limited(file, ctx.settings.max_upload_bytes)
    require_pdf_content(content, file_name)

    with ctx.db.get_cursor() as cursor:
        cursor.execute(
            f"""
            INSERT INTO t_manual_ocr_draft (source_file_name, title, pdf_content)
            VALUES (%s, %s, %s)
            RETURNING {_DETAIL_COLUMNS}
            """,
            (file_name, Path(file_name).stem, Binary(content))
        )
        row = cursor.fetchone()

    # DBへの登録が確定してから、OCRを順番待ちに入れる（先に始まると、行が見つからない）
    ctx.ocr_jobs.submit(row['id'], password)
    return OcrDraftResponse(**row)


@router.get("", response_model=List[OcrDraftSummary], summary="OCR下書きの一覧を見る")
def list_ocr_drafts(ctx: AppContext = Depends(get_context)):
    """破棄されていない下書きを、新しい順に返す（実行中・失敗・確認待ちの下書きを探すため）"""
    with ctx.db.get_cursor() as cursor:
        cursor.execute(
            f"""
            SELECT {_SUMMARY_COLUMNS} FROM t_manual_ocr_draft
            WHERE status <> 'DISCARDED' ORDER BY created_at DESC LIMIT %s
            """,
            (MAX_LISTED_DRAFTS,)
        )
        rows = cursor.fetchall()
    return [OcrDraftSummary(**row) for row in rows]


@router.get("/{draft_id}", response_model=OcrDraftResponse, summary="下書きを取得する（状態・進捗の確認）")
def get_ocr_draft(draft_id: UUID, ctx: AppContext = Depends(get_context)):
    """下書き取得。実行中は status と pages_done / page_count で進捗が分かる"""
    with ctx.db.get_cursor() as cursor:
        row = _fetch_draft_row(cursor, draft_id)
    return OcrDraftResponse(**row)


@router.patch("/{draft_id}", response_model=OcrDraftResponse, summary="下書きの本文を修正して保存する")
def update_ocr_draft(draft_id: UUID, body: UpdateDraftRequest, ctx: AppContext = Depends(get_context)):
    """OCRが完了した（DRAFT）下書きの本文を、人手の修正で置き換える（再OCRはしない）"""
    with ctx.db.get_cursor() as cursor:
        row = _fetch_draft_row(cursor, draft_id)
        if row['status'] != 'DRAFT':
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"この下書きは{row['status']}のため編集できません（OCRが完了した下書きだけ編集できます）"
            )
        cursor.execute(
            f"""
            UPDATE t_manual_ocr_draft SET draft_markdown = %s, updated_at = CURRENT_TIMESTAMP
            WHERE id = %s RETURNING {_DETAIL_COLUMNS}
            """,
            (body.draft_markdown, str(draft_id))
        )
        row = cursor.fetchone()

    return OcrDraftResponse(**row)


@router.post("/{draft_id}/discard", summary="下書きを破棄する（実行中なら中止する）")
def discard_ocr_draft(draft_id: UUID, ctx: AppContext = Depends(get_context)):
    """
    下書きを破棄し、保存してある原本PDFも消す。OCR実行中の場合は、現在のページの処理が
    終わった時点で中止される。
    """
    with ctx.db.get_cursor() as cursor:
        row = _fetch_draft_row(cursor, draft_id)
        if row['status'] == 'DISCARDED':
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="この下書きは既に破棄されています")
        cursor.execute(
            """
            UPDATE t_manual_ocr_draft
            SET status = 'DISCARDED', pdf_content = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = %s
            """,
            (str(draft_id),)
        )

    return {"message": "下書きを破棄しました。"}


@router.get("/{draft_id}/pdf", summary="アップロードした原本PDFを開く")
def get_ocr_draft_pdf(draft_id: UUID, ctx: AppContext = Depends(get_context)):
    """下書きの原本PDFを返す。破棄済みの下書きは404"""
    with ctx.db.get_cursor() as cursor:
        cursor.execute(
            "SELECT source_file_name, pdf_content FROM t_manual_ocr_draft WHERE id = %s", (str(draft_id),)
        )
        row = cursor.fetchone()

    if not row or row['pdf_content'] is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"下書き {draft_id} の原本PDFはありません"
        )

    return Response(
        content=bytes(row['pdf_content']),
        media_type="application/pdf",
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(row['source_file_name'])}"},
    )
