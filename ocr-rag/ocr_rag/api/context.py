"""
各エンドポイントが使う依存物（設定・DB・検索）

app.py（組み立て）とルーター群の間で循環importにならないよう、別モジュールにしている。
"""
from dataclasses import dataclass

from fastapi import Request

from ocr_rag.config import Settings
from ocr_rag.db import Database
from ocr_rag.ocr_jobs import OcrJobRunner
from ocr_rag.rag.rag_retriever import ManualRetriever


@dataclass(frozen=True)
class AppContext:
    settings: Settings
    db: Database
    retriever: ManualRetriever
    ocr_jobs: OcrJobRunner


def get_context(request: Request) -> AppContext:
    """FastAPIのDepends用: create_app()が組み立てたAppContextを返す"""
    return request.app.state.ctx
