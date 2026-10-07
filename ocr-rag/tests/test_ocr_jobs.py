"""
ocr_rag/ocr_jobs.py のテスト

OCR本体は偽物（tests/helpers.FakePipeline）。実行器は、通常はその場で実行する
SyncExecutor、スレッドの動作確認では本物のThreadPoolExecutorを使う。
"""
import threading
import time
from concurrent.futures import CancelledError, ThreadPoolExecutor
from typing import Optional

import pytest
import requests

from ocr_rag.ocr_jobs import INTERRUPTED_MESSAGE, DaemonSingleThreadExecutor, OcrJobRunner
from ocr_rag.ocr.ocr_pipeline import OcrCancelled
from tests.helpers import FakePipeline, SyncExecutor

PDF_BYTES = b"%PDF-1.4\n%fake manual body\n"


def _insert_draft(db, status="QUEUED", pdf: Optional[bytes] = PDF_BYTES):
    with db.get_cursor() as cursor:
        cursor.execute(
            "INSERT INTO t_manual_ocr_draft (source_file_name, title, status, pdf_content) "
            "VALUES ('manual.pdf', 'manual', %s, %s) RETURNING id",
            (status, pdf),
        )
        return cursor.fetchone()["id"]


def _row(db, draft_id):
    with db.get_cursor() as cursor:
        cursor.execute(
            "SELECT status, page_count, pages_done, draft_markdown, error_message FROM t_manual_ocr_draft "
            "WHERE id = %s", (str(draft_id),)
        )
        return cursor.fetchone()


def _set_status(db, draft_id, status):
    with db.get_cursor() as cursor:
        cursor.execute("UPDATE t_manual_ocr_draft SET status = %s WHERE id = %s", (status, str(draft_id)))


@pytest.fixture
def pipeline():
    return FakePipeline(page_count=3)


@pytest.fixture
def runner(db, settings, pipeline):
    return OcrJobRunner(db, settings, pipeline=pipeline, executor=SyncExecutor())


class TestRun:
    def test_completes_draft_with_result(self, db, runner, pipeline):
        draft_id = _insert_draft(db)

        runner.submit(draft_id, None)

        row = _row(db, draft_id)
        assert row["status"] == "DRAFT"
        assert row["page_count"] == 3 and row["pages_done"] == 3
        assert row["draft_markdown"] == pipeline.result.markdown
        assert row["error_message"] is None

    def test_progress_is_visible_while_running(self, db, runner, pipeline):
        draft_id = _insert_draft(db)
        seen = []
        pipeline.before_page = lambda page: seen.append(_row(db, draft_id))

        runner.submit(draft_id, None)

        # 各ページの処理の前には、RUNNINGで、前のページまでの進捗が書かれている
        assert [(r["status"], r["pages_done"], r["page_count"]) for r in seen] == [
            ("RUNNING", 0, 3), ("RUNNING", 1, 3), ("RUNNING", 2, 3)
        ]

    def test_pdf_and_password_are_passed_to_pipeline(self, db, runner, pipeline):
        draft_id = _insert_draft(db)

        runner.submit(draft_id, "secret")

        assert pipeline.calls[0]["pdf_bytes"] == PDF_BYTES
        assert pipeline.calls[0]["password"] == "secret"
        assert not pipeline.calls[0]["pdf_path"].exists()

    def test_failure_marks_failed_with_message(self, db, runner, pipeline):
        draft_id = _insert_draft(db)
        pipeline.error = RuntimeError("PDFから画像を抽出できませんでした")

        runner.submit(draft_id, None)

        row = _row(db, draft_id)
        assert row["status"] == "FAILED"
        assert row["error_message"] == "RuntimeError: PDFから画像を抽出できませんでした"

    def test_ollama_failure_message_mentions_ollama(self, db, runner, pipeline):
        draft_id = _insert_draft(db)
        pipeline.error = requests.exceptions.ConnectionError("connection refused")

        runner.submit(draft_id, None)

        assert "Ollamaへの接続・呼び出しに失敗しました" in _row(db, draft_id)["error_message"]

    def test_queued_draft_discarded_while_waiting_is_skipped(self, db, runner, pipeline):
        draft_id = _insert_draft(db, status="DISCARDED", pdf=None)

        runner.submit(draft_id, None)

        assert pipeline.calls == []
        assert _row(db, draft_id)["status"] == "DISCARDED"

    def test_discard_during_run_cancels_at_next_page_boundary(self, db, runner, pipeline):
        draft_id = _insert_draft(db)
        pipeline.before_page = lambda page: _set_status(db, draft_id, "DISCARDED") if page == 2 else None

        runner.submit(draft_id, None)

        row = _row(db, draft_id)
        assert row["status"] == "DISCARDED"
        assert row["draft_markdown"] == ""  # 結果で上書きされない
        assert row["pages_done"] == 1       # 破棄を検知したページ以降の進捗は書かれない

    def test_result_does_not_overwrite_draft_discarded_during_last_page(self, db, runner, pipeline):
        draft_id = _insert_draft(db)
        pipeline.before_return = lambda: _set_status(db, draft_id, "DISCARDED")

        runner.submit(draft_id, None)

        row = _row(db, draft_id)
        assert row["status"] == "DISCARDED"
        assert row["draft_markdown"] == ""

    def test_shutdown_cancels_running_job_and_leaves_it_for_recovery(self, db, settings, pipeline):
        runner = OcrJobRunner(db, settings, pipeline=pipeline, executor=SyncExecutor())
        draft_id = _insert_draft(db)
        runner.shutdown()

        runner.submit(draft_id, None)

        # 停止による中止は失敗にせず、RUNNINGのまま残す（次回の起動時にrecover_interruptedがFAILEDにする）
        assert _row(db, draft_id)["status"] == "RUNNING"
        assert runner.recover_interrupted() == 1
        assert _row(db, draft_id)["status"] == "FAILED"

    def test_runs_in_background_thread_and_serializes_jobs(self, db, settings):
        pipeline = FakePipeline(page_count=1)
        active = {"now": 0, "max": 0}

        def _slow(page):
            active["now"] += 1
            active["max"] = max(active["max"], active["now"])
            time.sleep(0.05)
            active["now"] -= 1

        pipeline.before_page = _slow
        executor = ThreadPoolExecutor(max_workers=1)
        runner = OcrJobRunner(db, settings, pipeline=pipeline, executor=executor)
        ids = [_insert_draft(db) for _ in range(3)]

        for draft_id in ids:
            runner.submit(draft_id, None)
        deadline = time.time() + 10
        while time.time() < deadline and any(_row(db, i)["status"] != "DRAFT" for i in ids):
            time.sleep(0.05)
        executor.shutdown(wait=True)

        assert [_row(db, i)["status"] for i in ids] == ["DRAFT"] * 3
        assert active["max"] == 1  # OCRは同時に1件だけ


class TestRecoverInterrupted:
    def test_marks_queued_and_running_as_failed_and_keeps_others(self, db, runner):
        queued = _insert_draft(db, status="QUEUED")
        running = _insert_draft(db, status="RUNNING")
        done = _insert_draft(db, status="DRAFT")
        failed = _insert_draft(db, status="FAILED")

        assert runner.recover_interrupted() == 2

        assert _row(db, queued)["status"] == "FAILED"
        assert _row(db, queued)["error_message"] == INTERRUPTED_MESSAGE
        assert _row(db, running)["status"] == "FAILED"
        assert _row(db, done)["status"] == "DRAFT"
        assert _row(db, failed)["status"] == "FAILED"

    def test_returns_zero_when_nothing_to_recover(self, runner):
        assert runner.recover_interrupted() == 0


def test_ocr_cancelled_is_not_recorded_as_failure(db, settings):
    """パイプラインが自分でOcrCancelledを投げても、失敗扱い(FAILED)にはならない"""
    pipeline = FakePipeline()
    pipeline.error = OcrCancelled("中止")
    runner = OcrJobRunner(db, settings, pipeline=pipeline, executor=SyncExecutor())
    draft_id = _insert_draft(db)

    runner.submit(draft_id, None)

    assert _row(db, draft_id)["status"] == "RUNNING"


class TestDaemonSingleThreadExecutor:
    def test_runs_jobs_in_order_on_a_daemon_thread(self):
        executor = DaemonSingleThreadExecutor("ocr-job-test")
        seen = []

        futures = [executor.submit(lambda i=i: seen.append((i, threading.current_thread().daemon, threading.current_thread().name))) for i in range(3)]
        for future in futures:
            future.result(timeout=5)
        executor.shutdown()

        assert seen == [(0, True, "ocr-job-test"), (1, True, "ocr-job-test"), (2, True, "ocr-job-test")]

    def test_exception_is_stored_in_future_and_next_job_still_runs(self):
        executor = DaemonSingleThreadExecutor("ocr-job-test")

        def _fail():
            raise ValueError("失敗")

        failing = executor.submit(_fail)
        following = executor.submit(lambda: "次の処理")

        with pytest.raises(ValueError, match="失敗"):
            failing.result(timeout=5)
        assert following.result(timeout=5) == "次の処理"
        executor.shutdown()

    def test_shutdown_cancels_waiting_jobs_but_not_the_running_one(self):
        executor = DaemonSingleThreadExecutor("ocr-job-test")
        started, release = threading.Event(), threading.Event()
        running = executor.submit(lambda: (started.set(), release.wait(5), "完了")[2])
        assert started.wait(5)
        waiting = executor.submit(lambda: "実行されない")

        executor.shutdown(wait=False, cancel_futures=True)
        release.set()

        assert running.result(timeout=5) == "完了"
        with pytest.raises(CancelledError):
            waiting.result(timeout=5)

    def test_submit_after_shutdown_raises(self):
        executor = DaemonSingleThreadExecutor("ocr-job-test")
        executor.shutdown()

        with pytest.raises(RuntimeError, match="停止済み"):
            executor.submit(lambda: None)

    def test_runner_uses_it_by_default(self, db, settings, pipeline):
        runner = OcrJobRunner(db, settings, pipeline=pipeline)
        draft_id = _insert_draft(db)

        runner.submit(draft_id, None)
        deadline = time.time() + 10
        while time.time() < deadline and _row(db, draft_id)["status"] != "DRAFT":
            time.sleep(0.05)
        runner.shutdown()

        assert _row(db, draft_id)["status"] == "DRAFT"
