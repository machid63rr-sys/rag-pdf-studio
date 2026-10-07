"""
pytest共通フィクスチャ

DBを使うテストは、専用のテストDB（TEST_DB_NAME、既定 rag_studio_test）をセッション
開始時に作り直し、database/schema.sql を流して使う。接続先はdocker-compose.test.yml
のtest-db（既定 localhost:55432）。TEST_DB_PASSWORDは必須（未設定なら黙って既定値を
使わず、DBを使うテストを失敗させる）。
"""
import os
from pathlib import Path

import psycopg2
import pytest
from fastapi.testclient import TestClient

from ocr_rag.api.app import create_app
from ocr_rag.config import Settings
from ocr_rag.db import Database
from ocr_rag.ocr_jobs import OcrJobRunner
from ocr_rag.rag.rag_retriever import ManualRetriever
from tests.helpers import FakePipeline, SyncExecutor, fake_embedding

SCHEMA_SQL_PATH = Path(__file__).parent.parent.parent / "database" / "schema.sql"

TEST_DB_HOST = os.getenv("TEST_DB_HOST", "localhost")
TEST_DB_PORT = int(os.getenv("TEST_DB_PORT", "55432"))
TEST_DB_NAME = os.getenv("TEST_DB_NAME", "rag_studio_test")
TEST_DB_USER = os.getenv("TEST_DB_USER", "postgres")
TEST_DB_PASSWORD = os.getenv("TEST_DB_PASSWORD")


def _connect(dbname: str):
    return psycopg2.connect(
        host=TEST_DB_HOST, port=TEST_DB_PORT, dbname=dbname,
        user=TEST_DB_USER, password=TEST_DB_PASSWORD,
    )


@pytest.fixture(scope="session")
def _test_database():
    """
    テストDBを作り直し、schema.sqlを流す（テストDB以外には触れない）。

    dbフィクスチャ経由で、DBを使うテストが要求した時だけ実行される
    （OCR系のようにDBを使わないテストはDBが無くても動く）。
    """
    if not TEST_DB_PASSWORD:
        pytest.fail(
            "TEST_DB_PASSWORDが未設定です。docker-compose.test.ymlを起動した時と同じ値を"
            "環境変数にエクスポートしてからテストを実行してください。",
            pytrace=False,
        )

    admin = _connect("postgres")
    admin.autocommit = True
    try:
        with admin.cursor() as cur:
            cur.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()",
                (TEST_DB_NAME,),
            )
            cur.execute(f'DROP DATABASE IF EXISTS "{TEST_DB_NAME}"')
            cur.execute(f'CREATE DATABASE "{TEST_DB_NAME}"')
    finally:
        admin.close()

    conn = _connect(TEST_DB_NAME)
    try:
        with conn.cursor() as cur:
            cur.execute(SCHEMA_SQL_PATH.read_text(encoding="utf-8"))
        conn.commit()
    finally:
        conn.close()

    yield


@pytest.fixture
def db(_test_database):
    """
    テストDBに接続したDatabase（テスト後にプールを閉じる）。

    テストDBはこのプロジェクト専用なので、各テストの開始時に登録データとOCR下書きを
    全て空にする（テスト間で行が残って結果に影響するのを防ぎ、個別の後片付けを不要にする）。
    """
    assert TEST_DB_PASSWORD  # 未設定なら_test_databaseフィクスチャが先に失敗している
    database = Database(
        host=TEST_DB_HOST, port=TEST_DB_PORT, name=TEST_DB_NAME,
        user=TEST_DB_USER, password=TEST_DB_PASSWORD, minconn=1, maxconn=5,
    )
    with database.get_cursor() as cursor:
        cursor.execute("TRUNCATE m_manual_document, t_manual_ocr_draft CASCADE")
    yield database
    database.close()


@pytest.fixture
def settings():
    """APIテスト用の設定（アップロード上限は、上限超過のテストがしやすい1MiB）"""
    return Settings(
        db_host=TEST_DB_HOST, db_port=TEST_DB_PORT, db_name=TEST_DB_NAME,
        db_user=TEST_DB_USER, db_password=TEST_DB_PASSWORD or "",
        ollama_host="http://fake-ollama:11434", embedding_model="bge-m3",
        ocr_model="fake-glm-ocr", vision_model="fake-vision",
        vision_timeout_seconds=7, max_upload_bytes=1024 * 1024,
    )


@pytest.fixture
def api_retriever(db, settings, monkeypatch):
    """埋め込みをダミーに差し替えた検索クラス（実Ollamaを呼ばない）"""
    retriever = ManualRetriever(
        db, ollama_host=settings.ollama_host, embedding_model=settings.embedding_model
    )
    monkeypatch.setattr(retriever, "embed", lambda text: fake_embedding(1.0))
    return retriever


@pytest.fixture
def fake_pipeline():
    """OCR本体の偽物（呼び出しの記録・失敗・途中の操作を、テストから指示できる）"""
    return FakePipeline()


@pytest.fixture
def ocr_jobs(db, settings, fake_pipeline):
    """OCRをその場で（同期的に）実行するジョブ実行器。OCR本体は偽物"""
    return OcrJobRunner(db, settings, pipeline=fake_pipeline, executor=SyncExecutor())


@pytest.fixture
def client(settings, db, api_retriever, ocr_jobs):
    """テストDB・ダミー埋め込み・偽のOCRで組み立てたAPIのクライアント"""
    return TestClient(create_app(settings=settings, db=db, retriever=api_retriever, ocr_jobs=ocr_jobs))
