"""
マニュアル原本PDF（m_manual_pdf）の保存・取得

検索結果から元のPDFを開くための原本を保持する。1マニュアル=1PDF。
登録API(ocr_rag/api/documents.py)・取り込み(ocr_rag/rag/manual_ingestion.py)から使う。

cursorは呼び出し元のトランザクションに参加させるため、本モジュールでは
commit/接続管理をしない。
"""
from typing import Dict, Optional
from uuid import UUID

from psycopg2 import Binary

PDF_MAGIC = b"%PDF-"


def save_manual_pdf(cursor, document_id: UUID, file_name: str, content: bytes) -> None:
    """
    原本PDFを保存する（既にあれば置き換える）。

    PDFでないバイト列をapplication/pdfとして配信しないよう、PDFヘッダ(%PDF-)を
    検証する。パスワード保護PDFもヘッダは同じため保存できる（閲覧時にブラウザが
    パスワードを要求する）。
    """
    if not content:
        raise ValueError(f"{file_name}: PDFが空です")
    if not content.startswith(PDF_MAGIC):
        raise ValueError(f"{file_name}: PDF形式ではありません（ヘッダ不正）")

    cursor.execute(
        """
        INSERT INTO m_manual_pdf (document_id, file_name, content)
        VALUES (%s, %s, %s)
        ON CONFLICT (document_id) DO UPDATE
            SET file_name = EXCLUDED.file_name, content = EXCLUDED.content,
                created_at = CURRENT_TIMESTAMP
        """,
        (str(document_id), file_name, Binary(content))
    )


def fetch_manual_pdf(cursor, document_id: UUID) -> Optional[Dict]:
    """
    原本PDFを取得する。

    Returns:
        {'file_name': str, 'content': bytes}。原本が登録されていなければNone
        （cursorはRealDictCursor前提）
    """
    cursor.execute(
        "SELECT file_name, content FROM m_manual_pdf WHERE document_id = %s",
        (str(document_id),)
    )
    row = cursor.fetchone()
    if not row:
        return None
    # psycopg2はbyteaをmemoryviewで返すため、呼び出し側が扱いやすいbytesに揃える
    return {'file_name': row['file_name'], 'content': bytes(row['content'])}
