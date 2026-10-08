"""
チャットAPI（機能④: 登録したマニュアルへの質問）

- POST   /chat/sessions                       : 会話を作る（機器名の絞り込みは任意）
- GET    /chat/sessions                       : 会話の一覧（新しい順）
- DELETE /chat/sessions/{id}                  : 会話を削除する（メッセージも消える）
- GET    /chat/sessions/{id}/messages         : 会話のメッセージ全件
- POST   /chat/sessions/{id}/messages         : 質問を送り、回答をストリーミングで受け取る

質問ごとに、登録済みマニュアルを自動で検索し、その抜粋を根拠に回答する（ChatService）。
認証が無いため、会話は、この画面を使う全員で共有される。
OCRと違い、同期的に呼ぶ（会話の応答として、すぐに表示する必要があるため）。
"""
import json
import logging
from datetime import datetime
from typing import AsyncIterator, List, Optional
from uuid import UUID

import requests
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ocr_rag.api.context import AppContext, get_context
from ocr_rag.api.uploads import MAX_NAME_LENGTH

router = APIRouter(tags=["④ チャット"])
logger = logging.getLogger(__name__)

MAX_QUESTION_LENGTH = 2000
MAX_TITLE_LENGTH = 255


class CreateSessionRequest(BaseModel):
    model_config = ConfigDict(json_schema_extra={"examples": [{"equipment_name": None}]})

    equipment_name: Optional[str] = Field(
        default=None,
        max_length=MAX_NAME_LENGTH,
        description="機器名で絞り込む場合のみ指定（例: ESP-1）。絞り込まないときは null",
    )

    @field_validator("equipment_name")
    @classmethod
    def _blank_means_no_filter(cls, value: Optional[str]) -> Optional[str]:
        return value.strip() or None if value is not None else None


class PostMessageRequest(BaseModel):
    question: str = Field(max_length=MAX_QUESTION_LENGTH, description="質問文")

    @field_validator("question")
    @classmethod
    def _must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("質問文が空です")
        return value.strip()


class ChatSession(BaseModel):
    session_id: UUID
    equipment_name: Optional[str]
    title: Optional[str]
    created_at: datetime


class ChatMessage(BaseModel):
    message_id: UUID
    role: str
    content: str
    manual_references: Optional[List[dict]]
    created_at: datetime


def _session_not_found(session_id: UUID) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"チャット {session_id} が見つかりません")


def _session_summary(row: dict) -> ChatSession:
    return ChatSession(
        session_id=row['id'], equipment_name=row['equipment_name'], title=row['title'], created_at=row['created_at'],
    )


@router.post("/chat/sessions", status_code=status.HTTP_201_CREATED, response_model=ChatSession, summary="会話を作る")
def create_session(body: CreateSessionRequest, ctx: AppContext = Depends(get_context)):
    with ctx.db.get_cursor() as cursor:
        cursor.execute(
            "INSERT INTO t_chat_session (equipment_name) VALUES (%s) RETURNING id, equipment_name, title, created_at",
            (body.equipment_name,),
        )
        return _session_summary(cursor.fetchone())


@router.get("/chat/sessions", response_model=List[ChatSession], summary="会話の一覧を見る")
def list_sessions(ctx: AppContext = Depends(get_context)):
    """会話の一覧（新しい順）。まだ質問が無く、題名の付いていない会話も含む"""
    with ctx.db.get_cursor() as cursor:
        cursor.execute(
            "SELECT id, equipment_name, title, created_at FROM t_chat_session ORDER BY created_at DESC"
        )
        return [_session_summary(row) for row in cursor.fetchall()]


@router.delete("/chat/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT, summary="会話を削除する")
def delete_session(session_id: UUID, ctx: AppContext = Depends(get_context)):
    with ctx.db.get_cursor() as cursor:
        cursor.execute("DELETE FROM t_chat_session WHERE id = %s", (str(session_id),))
        if cursor.rowcount == 0:
            raise _session_not_found(session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/chat/sessions/{session_id}/messages", response_model=List[ChatMessage], summary="会話のメッセージを見る"
)
def list_messages(session_id: UUID, ctx: AppContext = Depends(get_context)):
    with ctx.db.get_cursor() as cursor:
        cursor.execute("SELECT 1 FROM t_chat_session WHERE id = %s", (str(session_id),))
        if cursor.fetchone() is None:
            raise _session_not_found(session_id)
        cursor.execute(
            """
            SELECT id, role, content, manual_references, created_at
            FROM t_chat_message WHERE session_id = %s ORDER BY created_at, role DESC
            """,
            (str(session_id),),
        )
        rows = cursor.fetchall()
    return [
        ChatMessage(
            message_id=row['id'], role=row['role'], content=row['content'],
            manual_references=row['manual_references'], created_at=row['created_at'],
        )
        for row in rows
    ]


def _to_jsonb(value: Optional[list]) -> Optional[str]:
    return None if value is None else json.dumps(value, ensure_ascii=False)


@router.post(
    "/chat/sessions/{session_id}/messages",
    summary="質問を送り、回答をストリーミングで受け取る",
    responses={200: {"content": {"application/x-ndjson": {}}, "description": "改行区切りのJSON（下記のイベント）"}},
)
async def post_message(
    session_id: UUID, body: PostMessageRequest, http_request: Request, ctx: AppContext = Depends(get_context)
):
    """
    質問に、登録済みマニュアルの検索を踏まえた回答を、ストリーミングで返す

    レスポンスは改行区切りのJSON（application/x-ndjson）で、1行が1イベント。
    最初に {"type": "manual_references", "manual_references": [...] | null} を1回、
    続けて {"type": "delta", "text": "..."} を生成の間くり返し、
    最後に {"type": "done", "message_id": "...", "created_at": "..."} を1回送る。
    生成に失敗したときは、doneの代わりに {"type": "error", "detail": "..."} を送る。

    ストリームを始めた後は、HTTPのステータスで失敗を表せない（ヘッダーを送信済みのため）。
    呼び出し側は、イベントのtypeがerrorでないかを確認すること。
    回答は、生成が最後まで終わったときだけ保存する（停止・失敗した回答は保存しない）。
    質問は、生成の前に保存する（生成に失敗しても、質問は残す）。
    """
    question = body.question

    def load_session_and_history() -> tuple:
        with ctx.db.get_cursor() as cursor:
            cursor.execute(
                "SELECT id, equipment_name, title FROM t_chat_session WHERE id = %s", (str(session_id),)
            )
            session_row = cursor.fetchone()
            if session_row is None:
                return None, []
            cursor.execute(
                "SELECT role, content FROM t_chat_message WHERE session_id = %s ORDER BY created_at, role DESC",
                (str(session_id),),
            )
            return session_row, cursor.fetchall()

    session_row, history = await run_in_threadpool(load_session_and_history)
    if session_row is None:
        raise _session_not_found(session_id)

    def save_question() -> None:
        with ctx.db.get_cursor() as cursor:
            cursor.execute(
                "INSERT INTO t_chat_message (session_id, role, content) VALUES (%s, 'user', %s)",
                (str(session_id), question),
            )
            # 題名は、最初の質問だけで決める（以降の質問では上書きしない）
            if not session_row['title']:
                cursor.execute(
                    "UPDATE t_chat_session SET title = %s WHERE id = %s",
                    (question[:MAX_TITLE_LENGTH], str(session_id)),
                )

    await run_in_threadpool(save_question)

    def save_answer(event: dict) -> dict:
        with ctx.db.get_cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO t_chat_message (session_id, role, content, manual_references)
                VALUES (%s, 'assistant', %s, %s::jsonb)
                RETURNING id, created_at
                """,
                (str(session_id), event['full_text'], _to_jsonb(event['manual_references'])),
            )
            row = cursor.fetchone()
        return {'message_id': str(row['id']), 'created_at': row['created_at'].isoformat()}

    def advance(generator) -> Optional[dict]:
        """
        next()の包み。終わりは、StopIterationではなくNoneで返す（イベントは常にdictなので、
        Noneは終わりだけを表せる）。run_in_threadpoolの中でStopIterationを投げると、
        PEP 479でRuntimeErrorに化けて、呼び出し側のexcept StopIterationで捕まえられなくなる
        """
        try:
            return next(generator)
        except StopIteration:
            return None

    async def stream() -> AsyncIterator[str]:
        # ask_streamは同期のジェネレータ（中でrequests・psycopg2のブロッキング呼び出しをする）。
        # next()をスレッドへ逃がしつつ、1イベントごとに、クライアントの切断を確認する
        generator = ctx.chat.ask_stream(
            question=question, session_equipment_name=session_row['equipment_name'], history=history
        )
        try:
            while True:
                if await http_request.is_disconnected():
                    logger.info(f"クライアントの切断により、チャットの回答を中断しました（session={session_id}）")
                    return
                event = await run_in_threadpool(advance, generator)
                if event is None:
                    return
                if event['type'] == 'done':
                    saved = await run_in_threadpool(save_answer, event)
                    yield json.dumps({'type': 'done', **saved}, ensure_ascii=False) + "\n"
                else:
                    yield json.dumps(event, ensure_ascii=False) + "\n"
        except requests.RequestException as e:
            logger.error(f"チャットの回答の生成で、Ollamaの呼び出しに失敗しました（session={session_id}）: {e}")
            detail = (
                "Ollamaへの接続・呼び出しに失敗しました（モデル未取得・停止中・OCRの実行中で混み合っている"
                f"可能性があります）: {e}"
            )
            yield json.dumps({'type': 'error', 'detail': detail}, ensure_ascii=False) + "\n"
        except Exception as e:
            logger.error(f"チャットの回答の生成に失敗しました（session={session_id}）: {e}", exc_info=True)
            yield json.dumps({'type': 'error', 'detail': str(e)}, ensure_ascii=False) + "\n"
        finally:
            # Starlette（StreamingResponse）は、クライアントの切断を検知すると、上のis_disconnected()
            # より先に、このasyncジェネレータ自体をCancelledErrorで終わらせることがある
            # （BaseExceptionなので、上のexcept Exceptionでは捕まらず、ここへ素通りしてくる）。
            # whileの中だけでclose()すると、その経路では呼ばれず、OllamaがLLMの生成を最後まで続けてしまう。
            # どの終わり方でも必ずOllamaの呼び出しを打ち切れるよう、finallyでclose()する。
            # close()はソケットを閉じるだけで、すぐ終わる（ネットワークI/Oをしない）。
            # run_in_threadpoolに逃がすと、キャンセル済みの状態では実行されないため、直接呼ぶ
            generator.close()

    return StreamingResponse(stream(), media_type="application/x-ndjson")
