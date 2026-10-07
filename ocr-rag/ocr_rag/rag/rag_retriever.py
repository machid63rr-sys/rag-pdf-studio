"""
マニュアルRAG検索（Manual Retriever）

登録済みマニュアルのチャンクを、質問文との意味の近さ（ベクトル検索）で引き当てる。

- 埋め込みモデル: ollamaのbge-m3（1024次元、多言語対応）
- 検索: pgvectorのコサイン距離演算子(`<=>`)によるANN検索（HNSWインデックス）

再ランキング（cross-encoder）は行わない。登録内容を確認する用途では埋め込み検索のみで
実用上の順位が得られることを、実マニュアル（8文書・107チャンク）への10問の検証で確認した
（正解が1位9件・3位以内10件）。精度が不足した場合は、search()の結果を並べ替える
再ランキング段を、このクラスの外側に足せばよい。

m_manual_chunkが空（未登録）の場合、search()は空リストを返す。
"""
import logging
from typing import Dict, List, Optional

import requests
from psycopg2.extras import RealDictCursor

logger = logging.getLogger(__name__)

# bge-m3の出力次元。埋め込みモデルを変更する場合は
# database/schema.sqlのm_manual_chunk.embedding VECTOR(N)定義も合わせて変更すること。
EMBEDDING_DIMENSIONS = 1024


def to_pgvector_literal(embedding: List[float]) -> str:
    """pgvectorのVECTOR型入力文字列形式（例: '[0.1,0.2,...]'）に変換する"""
    return "[" + ",".join(repr(float(v)) for v in embedding) + "]"


class ManualRetriever:
    """マニュアルチャンクのベクトル検索"""

    def __init__(
        self,
        db,
        ollama_host: str,
        embedding_model: str,
        request_timeout_seconds: int = 30,
    ):
        """
        Args:
            db: get_cursor(cursor_factory=...)を持つDatabase
            ollama_host: Ollama APIエンドポイント（例: http://ollama:11434）
            embedding_model: ollamaの埋め込みモデル名
            request_timeout_seconds: Ollama呼び出しタイムアウト（秒）
        """
        self.db = db
        self.ollama_host = ollama_host
        self.embedding_model = embedding_model
        self.request_timeout_seconds = request_timeout_seconds

    def embed(self, text: str) -> List[float]:
        """
        テキストをollamaの埋め込みAPIでベクトル化する

        Returns:
            embedding_model出力次元のfloatリスト

        Raises:
            requests.RequestException: Ollama呼び出し失敗時
            ValueError: 出力次元がEMBEDDING_DIMENSIONSと一致しない場合
                （モデル設定ミス等をサイレントに握り潰さないため即座に停止する）
        """
        try:
            response = requests.post(
                f"{self.ollama_host}/api/embeddings",
                json={"model": self.embedding_model, "prompt": text},
                timeout=self.request_timeout_seconds
            )
            response.raise_for_status()
            embedding = response.json()["embedding"]
        except requests.RequestException as e:
            logger.error(
                f"Ollama embeddings呼び出し失敗 ({self.ollama_host}, model={self.embedding_model}): {e}"
            )
            raise

        if len(embedding) != EMBEDDING_DIMENSIONS:
            raise ValueError(
                f"埋め込みモデル{self.embedding_model}の出力次元が想定と異なります"
                f"（想定: {EMBEDDING_DIMENSIONS}, 実際: {len(embedding)}）。"
                "m_manual_chunk.embeddingのVECTOR次元定義との不整合の可能性があります。"
            )
        return embedding

    def search(
        self,
        query_text: str,
        equipment_name: Optional[str] = None,
        top_k: int = 5
    ) -> List[Dict]:
        """
        query_textに関連するマニュアルチャンクをコサイン距離の近い順に検索する

        equipment_name指定時は、その機器名を持つマニュアルと、機器名が1件も登録されて
        いない汎用マニュアルの両方を検索対象にする。1つのマニュアルに複数の機器名が
        登録されていてよく、そのいずれかが一致すれば対象とする。

        Args:
            query_text: 検索クエリ（空文字・空白のみは不可）
            equipment_name: 対象の個別機器名（例: "ESP-1"）。Noneの場合は絞り込まない
            top_k: 取得件数上限（1以上）

        Returns:
            [{'content', 'document_title', 'document_id', 'similarity'}, ...] 類似度降順。
            m_manual_chunkが空（未登録）の場合は空リスト。similarityは1 - コサイン距離。
            document_idは原本PDFへのリンク用（JSONで返せるようUUIDではなく文字列）
        """
        if not query_text.strip():
            raise ValueError("検索クエリが空です")
        if top_k < 1:
            raise ValueError(f"top_kは1以上を指定してください: {top_k}")

        vector_literal = to_pgvector_literal(self.embed(query_text))

        query = """
            SELECT
                c.content,
                d.title AS document_title,
                d.id::text AS document_id,
                1 - (c.embedding <=> %s::vector) AS similarity
            FROM m_manual_chunk c
            JOIN m_manual_document d ON d.id = c.document_id
            WHERE (
                %s::varchar IS NULL
                OR EXISTS (
                    SELECT 1 FROM r_manual_document_equipment e
                    WHERE e.document_id = d.id AND e.equipment_name = %s
                )
                OR NOT EXISTS (
                    SELECT 1 FROM r_manual_document_equipment e WHERE e.document_id = d.id
                )
            )
            ORDER BY c.embedding <=> %s::vector
            LIMIT %s
        """
        with self.db.get_cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute(
                query, (vector_literal, equipment_name, equipment_name, vector_literal, top_k)
            )
            return cursor.fetchall()
