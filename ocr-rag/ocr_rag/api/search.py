"""
検索API（機能③: 登録内容の簡易確認）

- POST /search : 質問文で、登録済みマニュアルのチャンクをベクトル検索する（埋め込み検索のみ）

similarityは1 - コサイン距離。該当なしの質問でも上位は返る（足切りはしない）ため、
「該当なし」の判定は表示側で類似度を見て行う。
"""
from typing import List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ocr_rag.api.context import AppContext, get_context

router = APIRouter(tags=["③ RAG（検索）"])

MAX_QUERY_LENGTH = 2000
MAX_TOP_K = 20


class SearchRequest(BaseModel):
    # 画面(/docs)の入力例。equipment_nameを"string"のまま実行すると、その名前で絞り込まれて
    # 結果が空になるため、入力例ではnull（絞り込まない）にしておく
    model_config = ConfigDict(json_schema_extra={"examples": [
        {"query": "ポンプの異常振動の原因と対策は？", "equipment_name": None, "top_k": 5}
    ]})

    query: str = Field(
        max_length=MAX_QUERY_LENGTH,
        description="探したい内容を、普通の文章で入力する（例: ポンプの異常振動の原因と対策は？）",
    )
    # タグ名を指定すると、そのタグ名のマニュアルと、タグ名未設定の汎用マニュアルに絞る
    equipment_name: Optional[str] = Field(
        default=None,
        description="タグ名で絞り込む場合のみ指定（例: ESP-1）。絞り込まないときは null にするか、この行ごと削除する",
    )
    top_k: int = Field(default=5, ge=1, le=MAX_TOP_K, description="返す件数（1〜20）")

    @field_validator("query")
    @classmethod
    def _query_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("検索クエリが空です")
        return value

    @field_validator("equipment_name")
    @classmethod
    def _blank_equipment_name_means_no_filter(cls, value: Optional[str]) -> Optional[str]:
        return value.strip() or None if value is not None else None


class SearchResult(BaseModel):
    content: str = Field(description="該当した本文")
    document_title: str = Field(description="文書名")
    document_id: str = Field(description="文書ID（原本PDFは GET /documents/{id}/pdf で開ける）")
    similarity: float = Field(description="類似度（1に近いほど、質問に近い内容）")


@router.post("/search", response_model=List[SearchResult], summary="登録した内容を検索する")
def search_manuals(body: SearchRequest, ctx: AppContext = Depends(get_context)):
    """質問文に関連するマニュアルチャンクを、類似度の高い順に返す"""
    return ctx.retriever.search(body.query, equipment_name=body.equipment_name, top_k=body.top_k)
