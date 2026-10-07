"""
アップロードされたファイルの検証（サイズ上限・ファイル名・PDF形式）
"""
from pathlib import PurePath
from typing import Optional

from fastapi import HTTPException, UploadFile, status

from ocr_rag.rag.manual_pdf import PDF_MAGIC

# source_file_name / title（VARCHAR(255)）に収まる長さ
MAX_NAME_LENGTH = 255


def read_upload_limited(upload: UploadFile, max_bytes: int) -> bytes:
    """アップロードを読み込む。上限を超える場合は、全体を読み込まずに413で拒否する"""
    content = upload.file.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise HTTPException(
            # 413の定数名はStarletteの版で異なる（REQUEST_ENTITY_TOO_LARGE→CONTENT_TOO_LARGE）ため数値で指定する
            status_code=413,
            detail=f"ファイルが大きすぎます（上限 {max_bytes // (1024 * 1024)}MB）"
        )
    return content


def validated_file_name(filename: Optional[str]) -> str:
    """
    アップロードされたファイル名から、保存に使う名前（パス区切りを除いた末尾の名前）を返す。
    空・長すぎる名前は400で拒否する。
    """
    name = PurePath((filename or "").replace("\\", "/")).name
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="ファイル名がありません")
    if len(name) > MAX_NAME_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"ファイル名が長すぎます（{MAX_NAME_LENGTH}文字以内）"
        )
    return name


def require_pdf_content(content: bytes, file_name: str) -> None:
    """PDFのヘッダ(%PDF-)を検証する。パスワード保護PDFもヘッダは同じなので通る"""
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"{file_name}: PDFが空です")
    if not content.startswith(PDF_MAGIC):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=f"{file_name}: PDF形式ではありません"
        )
