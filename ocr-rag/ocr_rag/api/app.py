"""
FastAPIアプリの組み立て

起動: uvicorn ocr_rag.api.app:create_app --factory --host 0.0.0.0 --port 8000

create_app()は設定(Settings)・DB・検索クラス・OCRジョブ実行器を組み立てて app.state.ctx に
持たせる。テストでは、これらを引数で差し替える（実Ollama・本番DBを使わずに済ませるため）。
"""
import logging
from contextlib import asynccontextmanager
from typing import Optional

import requests
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from ocr_rag.api import documents, ocr_drafts, search
from ocr_rag.api.context import AppContext
from ocr_rag.config import Settings
from ocr_rag.db import Database
from ocr_rag.ocr_jobs import OcrJobRunner
from ocr_rag.ollama_status import find_missing_models
from ocr_rag.rag.rag_retriever import ManualRetriever

logger = logging.getLogger(__name__)


def create_app(
    settings: Optional[Settings] = None,
    db: Optional[Database] = None,
    retriever: Optional[ManualRetriever] = None,
    ocr_jobs: Optional[OcrJobRunner] = None,
) -> FastAPI:
    resolved_settings = settings or Settings.from_env()
    owns_db = db is None
    resolved_db = db or Database(
        host=resolved_settings.db_host, port=resolved_settings.db_port,
        name=resolved_settings.db_name, user=resolved_settings.db_user,
        password=resolved_settings.db_password,
    )
    resolved_retriever = retriever or ManualRetriever(
        resolved_db, ollama_host=resolved_settings.ollama_host,
        embedding_model=resolved_settings.embedding_model,
    )

    resolved_ocr_jobs = ocr_jobs or OcrJobRunner(resolved_db, resolved_settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        # 前回のプロセスで中断された下書きを、FAILEDにして画面に分かるようにする
        resolved_ocr_jobs.recover_interrupted()
        try:
            yield
        finally:
            resolved_ocr_jobs.shutdown()
            if owns_db:
                resolved_db.close()

    app = FastAPI(title="rag-pdf-studio ocr-rag", lifespan=lifespan)
    app.state.ctx = AppContext(
        settings=resolved_settings, db=resolved_db, retriever=resolved_retriever, ocr_jobs=resolved_ocr_jobs
    )

    app.include_router(ocr_drafts.router)
    app.include_router(documents.router)
    app.include_router(search.router)

    @app.exception_handler(requests.RequestException)
    async def _ollama_unavailable(_: Request, exc: requests.RequestException) -> JSONResponse:
        # OCR・埋め込みはOllamaが無いと動かない。原因が分かる形で返す（500で握り潰さない）
        logger.error(f"Ollamaへの接続・呼び出しに失敗しました: {exc}")
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"detail": f"Ollamaへの接続・呼び出しに失敗しました（モデル未取得・停止中の可能性があります）: {exc}"},
        )

    @app.get("/healthz", tags=["動作確認"], summary="動作確認（DBに接続できるか）")
    def healthz() -> JSONResponse:
        try:
            with resolved_db.get_cursor() as cursor:
                cursor.execute("SELECT 1")
        except Exception as e:
            logger.error(f"healthz: DB接続に失敗しました: {e}")
            return JSONResponse(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                content={"status": "error", "detail": f"DB接続に失敗しました: {e}"},
            )
        return JSONResponse(content={"status": "ok"})

    @app.get("/readyz", tags=["動作確認"], summary="利用できる状態か（DBとOllamaのモデルが揃っているか）")
    def readyz() -> JSONResponse:
        """DBに接続でき、必要な3つのOllamaモデルが全て取得済みなら200。足りないものは503で理由を返す"""
        try:
            with resolved_db.get_cursor() as cursor:
                cursor.execute("SELECT 1")
        except Exception as e:
            logger.error(f"readyz: DB接続に失敗しました: {e}")
            return JSONResponse(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                content={"status": "error", "detail": f"DB接続に失敗しました: {e}", "missing_models": []},
            )
        try:
            missing = find_missing_models(resolved_settings.ollama_host, resolved_settings.required_models)
        except requests.RequestException as e:
            logger.error(f"readyz: Ollamaに接続できません: {e}")
            return JSONResponse(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                content={"status": "error", "detail": f"Ollamaに接続できません: {e}", "missing_models": []},
            )
        if missing:
            return JSONResponse(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                content={
                    "status": "error",
                    "detail": f"Ollamaに未取得のモデルがあります: {', '.join(missing)}",
                    "missing_models": missing,
                },
            )
        return JSONResponse(content={"status": "ok", "missing_models": []})

    return app
