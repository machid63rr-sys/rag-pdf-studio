"""
マニュアル文書API（機能③: RAG登録）

- POST /documents            : MarkdownをRAGに登録する（機器名・原本PDFは任意）
- GET  /documents            : 登録済み文書の一覧
- GET  /documents/{id}/pdf   : 原本PDFの配信（検索結果の「PDFを開く」用）
- GET  /equipment-names      : 登録済みの機器名の一覧（絞り込みのプルダウン用）

登録は、同じファイル名の文書があれば作り直す（置き換え）。機器名を1件も付けない文書は
機器名未設定の汎用マニュアルとなり、機器名で絞り込んだ検索でも対象に含まれる。
"""
import logging
from datetime import datetime
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from pydantic import BaseModel

from ocr_rag.api.context import AppContext, get_context
from ocr_rag.api.uploads import (
    MAX_NAME_LENGTH, read_upload_limited, require_pdf_content, validated_file_name,
)
from ocr_rag.rag.manual_ingestion import ingest_manual_text
from ocr_rag.rag.manual_pdf import fetch_manual_pdf

router = APIRouter(tags=["③ RAG（登録・一覧）"])
logger = logging.getLogger(__name__)

MARKDOWN_EXTENSIONS = (".md", ".markdown", ".txt")


class DocumentSummary(BaseModel):
    id: UUID
    title: str
    source_file_name: str
    equipment_names: List[str]
    chunk_count: int
    has_pdf: bool
    created_at: datetime


class EquipmentNameInfo(BaseModel):
    equipment_name: str


_SUMMARY_QUERY = """
    SELECT d.id, d.title, d.source_file_name, d.created_at,
           COALESCE(
               (SELECT array_agg(e.equipment_name ORDER BY e.equipment_name)
                FROM r_manual_document_equipment e WHERE e.document_id = d.id),
               ARRAY[]::varchar[]
           ) AS equipment_names,
           (SELECT count(*) FROM m_manual_chunk c WHERE c.document_id = d.id) AS chunk_count,
           EXISTS (SELECT 1 FROM m_manual_pdf p WHERE p.document_id = d.id) AS has_pdf
    FROM m_manual_document d
"""


def _normalize_equipment_names(names: List[str]) -> List[str]:
    """前後の空白を除き、空文字と重複（入力順は維持）を除外する"""
    normalized = list(dict.fromkeys(n.strip() for n in names if n.strip()))
    too_long = [n for n in normalized if len(n) > MAX_NAME_LENGTH]
    if too_long:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"機器名が長すぎます（{MAX_NAME_LENGTH}文字以内）: {too_long[0][:30]}…"
        )
    return normalized


@router.post(
    "/documents", status_code=status.HTTP_201_CREATED, response_model=DocumentSummary,
    summary="Markdownを登録する（RAGに保存）",
)
def create_document(
    markdown_file: UploadFile = File(..., description="登録するMarkdownファイル（.md / .markdown / .txt、UTF-8）"),
    title: Optional[str] = Form(None, description="表示名。省略するとファイル名（拡張子なし）"),
    equipment_names: List[str] = Form(
        [], description="対象の機器名（例: ESP-1）。複数可。省略すると全機器共通の資料として扱う"),
    pdf_file: Optional[UploadFile] = File(None, description="原本PDF（任意）。検索結果から開ける"),
    ctx: AppContext = Depends(get_context),
):
    """
    Markdownをチャンクに分割・埋め込みしてRAGに登録する。同名のファイルが登録済みなら置き換える。
    pdf_fileを省略して置き換えた場合、既存の原本PDFは引き継がれる。
    """
    source_file_name = validated_file_name(markdown_file.filename)
    if not source_file_name.lower().endswith(MARKDOWN_EXTENSIONS):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Markdown（{' / '.join(MARKDOWN_EXTENSIONS)}）のみ対応しています"
        )

    raw = read_upload_limited(markdown_file, ctx.settings.max_upload_bytes)
    try:
        # utf-8-sigは、Windowsのエディタが付けるBOMだけを取り除く。UTF-8以外は文字化けさせずエラーにする
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{source_file_name}: UTF-8として読み込めません"
        ) from None
    if not text.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=f"{source_file_name}: 本文が空です"
        )

    resolved_title = (title or "").strip() or Path(source_file_name).stem
    if len(resolved_title) > MAX_NAME_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"タイトルが長すぎます（{MAX_NAME_LENGTH}文字以内）"
        )
    names = _normalize_equipment_names(equipment_names)

    pdf_file_name: Optional[str] = None
    pdf_content: Optional[bytes] = None
    if pdf_file is not None:
        pdf_file_name = validated_file_name(pdf_file.filename)
        pdf_content = read_upload_limited(pdf_file, ctx.settings.max_upload_bytes)
        require_pdf_content(pdf_content, pdf_file_name)

    document_id = ingest_manual_text(
        ctx.db, ctx.retriever,
        source_file_name=source_file_name, title=resolved_title, equipment_names=names, text=text,
        pdf_file_name=pdf_file_name, pdf_content=pdf_content,
    )

    with ctx.db.get_cursor() as cursor:
        cursor.execute(f"{_SUMMARY_QUERY} WHERE d.id = %s", (str(document_id),))
        row = cursor.fetchone()
    return DocumentSummary(**row)


@router.get("/documents", response_model=List[DocumentSummary], summary="登録済みの文書の一覧を見る")
def list_documents(ctx: AppContext = Depends(get_context)):
    """登録済み文書の一覧（新しい順）"""
    with ctx.db.get_cursor() as cursor:
        cursor.execute(f"{_SUMMARY_QUERY} ORDER BY d.created_at DESC, d.title")
        rows = cursor.fetchall()
    return [DocumentSummary(**row) for row in rows]


@router.get(
    "/equipment-names", response_model=List[EquipmentNameInfo],
    summary="登録済みの機器名の一覧（検索の絞り込み用）",
)
def get_equipment_names(ctx: AppContext = Depends(get_context)):
    """登録済みの機器名の一覧（絞り込みのプルダウン用）"""
    with ctx.db.get_cursor() as cursor:
        cursor.execute(
            "SELECT DISTINCT equipment_name FROM r_manual_document_equipment ORDER BY equipment_name"
        )
        rows = cursor.fetchall()
    return [EquipmentNameInfo(equipment_name=r['equipment_name']) for r in rows]


@router.get("/documents/{document_id}/pdf", summary="原本PDFを開く")
def get_document_pdf(document_id: UUID, ctx: AppContext = Depends(get_context)):
    """原本PDFを返す。原本が登録されていない文書は404"""
    with ctx.db.get_cursor() as cursor:
        pdf = fetch_manual_pdf(cursor, document_id)

    if pdf is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"マニュアル {document_id} の原本PDFは登録されていません"
        )

    # 日本語ファイル名はRFC 5987形式(filename*=UTF-8'')で渡す。inlineでブラウザ内表示させる
    return Response(
        content=pdf['content'],
        media_type="application/pdf",
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(pdf['file_name'])}"},
    )
