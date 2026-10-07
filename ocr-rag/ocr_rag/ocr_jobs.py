"""
OCR下書きのバックグラウンド実行

OCRは1ページ数分かかる。HTTPの1回の呼び出しで最後まで待たせると、プロキシ・ブラウザの
タイムアウトで壊れやすいため、APIは下書きを登録して即座に返し、実際のOCRはここが
別スレッドで実行する。状態・進捗・結果はt_manual_ocr_draftに書く（画面はそれを見に行く）。

- OCRはGPU（Ollama）を占有するため、同時に1件だけ実行し、残りはQUEUEDで順番を待つ
- 破棄（DISCARDED）されると、次のページの区切りで中止する
- サーバーが停止・再起動すると、実行中・待機中の下書きは再開できない。起動時にFAILEDにして、
  画面に「中断された」と表示させる（黙って放置しない）
"""
import json
import logging
import queue
import tempfile
import threading
from concurrent.futures import Executor, Future
from pathlib import Path
from typing import Any, Callable, Optional, Tuple
from uuid import UUID

import requests

from ocr_rag.config import Settings
from ocr_rag.db import Database
from ocr_rag.ocr.ocr_pipeline import OcrCancelled, OcrDraftResult, run_ocr_pipeline

logger = logging.getLogger(__name__)

INTERRUPTED_MESSAGE = "サーバーの停止または再起動でOCRが中断されました。もう一度OCRしてください。"

PipelineFn = Callable[..., OcrDraftResult]


class DaemonSingleThreadExecutor(Executor):
    """
    処理を、1本のデーモンスレッドで順番に実行する実行器。

    通常のThreadPoolExecutorのスレッドは、プロセスの終了時に実行中の処理の完了を待つため、
    OCR実行中にサーバーを止めると、そのページが終わる(最大数分)まで終了しない。デーモン
    スレッドなら待たず、実行中のOCRはプロセスと一緒に終わる。中断された下書きは、
    次回の起動時にOcrJobRunner.recover_interruptedがFAILEDにする。
    """

    def __init__(self, thread_name: str):
        self._jobs: "queue.Queue[Optional[Tuple[Future, Callable[..., Any], tuple, dict]]]" = queue.Queue()
        self._closed = False
        self._thread = threading.Thread(target=self._work, name=thread_name, daemon=True)
        self._thread.start()

    def submit(self, fn, /, *args, **kwargs):
        if self._closed:
            raise RuntimeError("この実行器は停止済みです")
        future: Future = Future()
        self._jobs.put((future, fn, args, kwargs))
        return future

    def _work(self) -> None:
        while True:
            job = self._jobs.get()
            if job is None:
                return
            future, fn, args, kwargs = job
            if not future.set_running_or_notify_cancel():
                continue
            try:
                future.set_result(fn(*args, **kwargs))
            except BaseException as e:  # noqa: BLE001 - 実行器と同じく、例外はFutureに入れる
                future.set_exception(e)

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        self._closed = True
        if cancel_futures:
            while True:
                try:
                    pending = self._jobs.get_nowait()
                except queue.Empty:
                    break
                if pending is not None:
                    pending[0].cancel()
        self._jobs.put(None)
        if wait:
            self._thread.join()


class OcrJobRunner:
    def __init__(
        self,
        db: Database,
        settings: Settings,
        pipeline: PipelineFn = run_ocr_pipeline,
        executor: Optional[Executor] = None,
    ):
        """
        Args:
            pipeline: OCR本体（既定はrun_ocr_pipeline。テストでは差し替える）
            executor: ジョブを実行する実行器。既定は、1本のデーモンスレッド（OCRを同時に1件だけ実行する）
        """
        self._db = db
        self._settings = settings
        self._pipeline = pipeline
        self._executor = executor or DaemonSingleThreadExecutor("ocr-job")
        self._stopping = threading.Event()

    def recover_interrupted(self) -> int:
        """起動時に呼ぶ。前回のプロセスで中断された（QUEUED/RUNNINGのままの）下書きをFAILEDにする"""
        with self._db.get_cursor() as cursor:
            cursor.execute(
                """
                UPDATE t_manual_ocr_draft
                SET status = 'FAILED', error_message = %s, updated_at = CURRENT_TIMESTAMP
                WHERE status IN ('QUEUED', 'RUNNING')
                """,
                (INTERRUPTED_MESSAGE,)
            )
            count = cursor.rowcount
        if count:
            logger.warning(f"前回中断されたOCR下書き {count}件をFAILEDにしました")
        return count

    def submit(self, draft_id: UUID, password: Optional[str]) -> None:
        """QUEUEDの下書きのOCRを、順番待ちに入れる（パスワードはメモリ上だけで持ち、DBには保存しない）"""
        self._executor.submit(self._run, draft_id, password)

    def shutdown(self) -> None:
        """停止を指示する。実行中のOCRは、次のページの区切りで中止される"""
        self._stopping.set()
        self._executor.shutdown(wait=False, cancel_futures=True)

    def _run(self, draft_id: UUID, password: Optional[str]) -> None:
        try:
            self._execute(draft_id, password)
        except OcrCancelled as e:
            logger.info(f"OCRを中止しました（draft_id={draft_id}）: {e}")
        except Exception as e:
            logger.error(f"OCRに失敗しました（draft_id={draft_id}）: {e}", exc_info=True)
            self._mark_failed(draft_id, e)

    def _execute(self, draft_id: UUID, password: Optional[str]) -> None:
        with self._db.get_cursor() as cursor:
            cursor.execute(
                """
                UPDATE t_manual_ocr_draft SET status = 'RUNNING', updated_at = CURRENT_TIMESTAMP
                WHERE id = %s AND status = 'QUEUED'
                RETURNING pdf_content
                """,
                (str(draft_id),)
            )
            row = cursor.fetchone()
        if row is None:
            return  # 待っている間に破棄された

        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(bytes(row['pdf_content']))
            pdf_path = Path(tmp.name)
        try:
            result = self._pipeline(
                pdf_path,
                password=password, ollama_host=self._settings.ollama_host,
                glm_model=self._settings.ocr_model, vision_model=self._settings.vision_model,
                vision_timeout_seconds=self._settings.vision_timeout_seconds,
                on_progress=self._progress_callback(draft_id),
            )
        finally:
            pdf_path.unlink(missing_ok=True)

        with self._db.get_cursor() as cursor:
            # 最後のページの処理中に破棄された場合は、結果で上書きしない
            cursor.execute(
                """
                UPDATE t_manual_ocr_draft
                SET status = 'DRAFT', draft_markdown = %s, diff_segments = %s::jsonb,
                    page_count = %s, pages_done = %s, error_message = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE id = %s AND status = 'RUNNING'
                """,
                (
                    result.markdown, json.dumps(result.diff_segments, ensure_ascii=False, default=str),
                    result.page_count, result.page_count, str(draft_id),
                )
            )

    def _progress_callback(self, draft_id: UUID) -> Callable[[int, int], None]:
        def callback(done: int, total: int) -> None:
            if self._stopping.is_set():
                raise OcrCancelled("サーバーの停止")
            with self._db.get_cursor() as cursor:
                # 進捗の書き込みと、破棄されていないかの確認を1回のクエリで行う
                cursor.execute(
                    """
                    UPDATE t_manual_ocr_draft
                    SET page_count = %s, pages_done = %s, updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s AND status = 'RUNNING'
                    RETURNING id
                    """,
                    (total, done, str(draft_id))
                )
                if cursor.fetchone() is None:
                    raise OcrCancelled("下書きが破棄されました")

        return callback

    def _mark_failed(self, draft_id: UUID, error: Exception) -> None:
        if isinstance(error, requests.RequestException):
            message = f"Ollamaへの接続・呼び出しに失敗しました（モデル未取得・停止中の可能性があります）: {error}"
        else:
            message = f"{type(error).__name__}: {error}"
        try:
            with self._db.get_cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE t_manual_ocr_draft
                    SET status = 'FAILED', error_message = %s, updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s AND status IN ('QUEUED', 'RUNNING')
                    """,
                    (message, str(draft_id))
                )
        except Exception:
            logger.error(f"失敗の記録に失敗しました（draft_id={draft_id}）", exc_info=True)
