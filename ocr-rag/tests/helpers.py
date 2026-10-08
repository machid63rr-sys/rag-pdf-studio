"""
テスト共通の部品（ダミー埋め込みベクトル・テストデータ投入）
"""
import math
import uuid
from concurrent.futures import Executor, Future
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

from psycopg2.extras import RealDictCursor

from ocr_rag.ocr.ocr_pipeline import OcrDraftResult, PageResult
from ocr_rag.rag.rag_retriever import EMBEDDING_DIMENSIONS, to_pgvector_literal


def fake_embedding(cosine_similarity_to_query: float) -> list:
    """
    テスト用の1024次元ダミーベクトル

    コサイン類似度は向き（角度）のみで決まり大きさに依存しないため、単純に
    先頭要素の値を変えるだけでは類似度の差を作れない（例: [1,0,...]と[0.9,0,...]は
    向きが同じで類似度1.0になる）。クエリベクトルを[1,0,0,...]に固定し、
    2次元平面上でcos(theta)=cosine_similarity_to_queryとなる単位ベクトルを作ることで、
    query([1,0,...])との厳密なコサイン類似度を指定値にする。
    """
    sin_component = math.sqrt(max(0.0, 1.0 - cosine_similarity_to_query ** 2))
    return [cosine_similarity_to_query, sin_component] + [0.0] * (EMBEDDING_DIMENSIONS - 2)


def insert_manual_chunk(
    db, title: str, content: str, embedding: list, equipment_names: Sequence[str] = ()
) -> uuid.UUID:
    """1チャンクだけを持つマニュアル文書を直接INSERTする（埋め込みは指定のベクトルをそのまま使う）"""
    with db.get_cursor(cursor_factory=RealDictCursor) as cursor:
        cursor.execute(
            "INSERT INTO m_manual_document (title, source_file_name) VALUES (%s, %s) RETURNING id",
            (title, f"{title}_{uuid.uuid4().hex[:8]}.md"),
        )
        document_id = cursor.fetchone()["id"]
        for name in equipment_names:
            cursor.execute(
                "INSERT INTO r_manual_document_equipment (document_id, equipment_name) VALUES (%s, %s)",
                (str(document_id), name),
            )
        cursor.execute(
            "INSERT INTO m_manual_chunk (document_id, chunk_index, content, embedding) "
            "VALUES (%s, 0, %s, %s::vector)",
            (str(document_id), content, to_pgvector_literal(embedding)),
        )
    return document_id


def insert_extra_chunk(db, document_id, chunk_index: int, content: str, embedding: list) -> None:
    """既存のマニュアル文書に、チャンクを1件足す（insert_manual_chunkは、chunk_index 0の1件だけを作る）"""
    with db.get_cursor() as cursor:
        cursor.execute(
            "INSERT INTO m_manual_chunk (document_id, chunk_index, content, embedding) "
            "VALUES (%s, %s, %s, %s::vector)",
            (str(document_id), chunk_index, content, to_pgvector_literal(embedding)),
        )


class SyncExecutor(Executor):
    """submitされた処理をその場で実行する実行器（スレッドの待ち合わせをせずに、ジョブをテストするため）"""

    def submit(self, fn, /, *args, **kwargs):
        future: Future = Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as e:  # noqa: BLE001 - 実行器と同じく、例外はFutureに入れる
            future.set_exception(e)
        return future


def make_ocr_result(page_count: int = 2) -> OcrDraftResult:
    pages = [
        PageResult(
            page_number=i, final_text=f"ページ{i}の本文",
            segments=[{
                "segment_id": f"seg-{i}", "glm_text": f"ページ{i}の本文", "glm_alt_text": f"ページ{i}の本文",
                "status": "match", "final_text": f"ページ{i}の本文", "reason": None,
            }],
        )
        for i in range(1, page_count + 1)
    ]
    markdown = "\n".join(f"## PDF {p.page_number}ページ目\n\n{p.final_text}\n" for p in pages)
    return OcrDraftResult(markdown=markdown, pages=pages, page_count=page_count)


class FakePipeline:
    """
    run_ocr_pipelineの偽物。実OCR・実LLMは呼ばず、進捗コールバックだけ本物と同じ順序で呼ぶ。

    before_page(page): 各ページの進捗を通知する直前に呼ぶ（テストが途中で状態を覗く・破棄する）
    before_return(): 結果を返す直前に呼ぶ
    error: 設定すると、最初の進捗通知の後でこの例外を投げる
    """

    def __init__(self, page_count: int = 2):
        self.page_count = page_count
        self.result = make_ocr_result(page_count)
        self.error: Optional[Exception] = None
        self.before_page: Optional[Callable[[int], None]] = None
        self.before_return: Optional[Callable[[], None]] = None
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, pdf_path, **kwargs) -> OcrDraftResult:
        self.calls.append({"pdf_path": Path(pdf_path), "pdf_bytes": Path(pdf_path).read_bytes(), **kwargs})
        on_progress = kwargs["on_progress"]
        on_progress(0, self.page_count)
        if self.error is not None:
            raise self.error
        for page in range(1, self.page_count + 1):
            if self.before_page is not None:
                self.before_page(page)
            on_progress(page, self.page_count)
        if self.before_return is not None:
            self.before_return()
        return self.result


class FakeLlm:
    """
    ChatService._call_llm_streamの偽物。実Ollamaは呼ばない。

    渡されたmessagesをcallsに記録し、chunksを順に返す。errorを設定すると、全ての断片を返した後で
    その例外を投げる（途中まで表示された回答が、失敗で終わる場合の確認用）。
    closedは、ジェネレータが閉じられた（正常終了・失敗・close()のいずれでも）ことを表す
    （本物は、閉じるときにOllamaへの接続を閉じる）。
    """

    def __init__(self, chunks: Sequence[str] = ("これは", "回答です。")):
        self.chunks = list(chunks)
        self.error: Optional[Exception] = None
        self.calls: List[List[Dict[str, str]]] = []
        self.closed = False

    def __call__(self, messages: List[Dict[str, str]]):
        self.calls.append(messages)
        self.closed = False
        try:
            yield from self.chunks
            if self.error is not None:
                raise self.error
        finally:
            self.closed = True


def insert_manual_pdf(db, document_id, file_name: str = "原本.pdf") -> None:
    """マニュアル文書に、原本PDFを登録する"""
    with db.get_cursor() as cursor:
        cursor.execute(
            "INSERT INTO m_manual_pdf (document_id, file_name, content) VALUES (%s, %s, %s)",
            (str(document_id), file_name, b"%PDF-1.4 fake"),
        )
