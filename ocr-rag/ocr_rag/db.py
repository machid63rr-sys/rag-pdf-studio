"""
PostgreSQL接続プール

get_cursor()はコンテキストを抜けるときにcommitし、例外ならrollbackする。
ManualRetriever / ingest_manual_text等は、get_cursor(cursor_factory=...)を持つ
オブジェクトを渡されて使う（このクラス、またはテスト用の同形クラス）。
"""
from contextlib import contextmanager
from typing import Any, Generator

from psycopg2 import pool
from psycopg2.extras import RealDictCursor


class Database:
    """psycopg2のスレッドセーフな接続プールの薄いラッパー"""

    def __init__(
        self, *, host: str, port: int, name: str, user: str, password: str,
        minconn: int = 1, maxconn: int = 10,
    ):
        self._pool = pool.ThreadedConnectionPool(
            minconn, maxconn,
            host=host, port=port, dbname=name, user=user, password=password,
        )

    @contextmanager
    def get_connection(self) -> Generator[Any, None, None]:
        """接続を取得する。正常終了でcommit、例外でrollbackし、プールへ返却する"""
        conn = self._pool.getconn()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            self._pool.putconn(conn)

    @contextmanager
    def get_cursor(self, cursor_factory=RealDictCursor) -> Generator[Any, None, None]:
        """カーソルを取得する（既定はdict形式で結果を返すRealDictCursor）"""
        with self.get_connection() as conn:
            cursor = conn.cursor(cursor_factory=cursor_factory)
            try:
                yield cursor
            finally:
                cursor.close()

    def close(self) -> None:
        """プールの全接続を閉じる"""
        self._pool.closeall()
