"""
チャット（機能④）の回答の生成

質問文で登録済みの資料（マニュアル等）を検索（ManualRetriever、埋め込み検索のみ）し、その抜粋を根拠に、
ローカルのLLM（Ollama /api/chat）が回答する。クラウドのAPIへは接続しない。

回答の根拠は、検索で見つかった抜粋だけに限る。類似度がしきい値に届かない抜粋は、根拠として
使わず、参照マニュアルとしても出さない（無関係な資料を、根拠のように見せないため）。
根拠になる抜粋が1件も無いときは、LLMを呼ばず、固定の「記載がありません」を返す（NO_EVIDENCE_ANSWER）。
LLMに「抜粋が無ければ、無いと答えよ」と指示するだけでは、実モデル（qwen3.5:9b）が架空の回答を作り、
存在しない資料を引用することを確認したため。
「マニュアルを見せて」のような直接の質問だけは、しきい値を外す（is_manual_request参照）。

タグ名（資料に付けた名前。内部の識別子はequipment_name）は、埋め込みの対象ではないため、「Aの資料は？」の
ようにタグ名しか書かれていない質問は、資料があっても類似度がしきい値に届かない（実測で0.35〜0.41）。
そこで、通常の検索で根拠が0件になったときだけ、質問に書かれたタグ名が付いた資料を根拠にする
（_fetch_tagged_chunks）。
また、質問に書かれたタグ名が、根拠にした資料に付いているときは、どの経路で見つけた根拠でも、
そのタグ名をLLMに伝える（_describe_tag_match）。伝えないと、LLMは「Aという名称は資料に無い」と答える
（実モデルで確認）。タグ名が書かれていない質問の回答は、変えない。

会話の保存は、api/chat.py（ルーター）が行う。このクラスは検索とLLMの呼び出しだけを担当する。
元は異常検知システム（anomaly-detection）のチャット（src/llm/chat_service.py）で、
異常イベント・系統・認証に関する部分を除き、この画面に合わせて作り直した。元は空調設備の保守員向けだったが、
このアプリは特定の業界に限らず、登録された資料一般に使えることを目的とするため、プロンプトも業界を限定しない。
"""
import json
import logging
from contextlib import closing
from dataclasses import dataclass
from typing import Dict, Generator, List, Optional

import requests

from ocr_rag.chat.question_parser import (
    find_mentioned_equipment_names, is_manual_request, resolve_equipment_name,
)
from ocr_rag.db import Database
from ocr_rag.ocr.vision_correction import DEFAULT_VISION_NUM_CTX
from ocr_rag.rag.rag_retriever import ManualRetriever

logger = logging.getLogger(__name__)

CHAT_SYSTEM_PROMPT = (
    # 特定の業界・用途に限らず、登録された資料（マニュアル・仕様書・手順書など）一般に使えるようにする
    "あなたは、登録された資料（マニュアル・仕様書・手順書など）をもとに質問に答えるAIアシスタントです。"
    "回答に使ってよい材料は、「関連資料の抜粋」に書かれている内容だけです。"
    "抜粋に出てくる対象（機器・製品・手順など）と関係のない、他の資料の内容を混ぜて回答しないでください。"
    "質問には直接答えてください。前置きや、回答の方法の説明はいりません。"
    "抜粋に書かれていない・触れられていない内容は、推測で断定せず、"
    "「資料にはその記載がありません」のように、正直にそのまま伝えてください。"
    "もっともらしい説明を新しく作り出さないでください。"
    "抜粋に書かれていないページ番号・章番号・型番・数値を、書き足さないでください。"
    # 実際には存在しないタグ名・用語を自分で作り出したうえで「それは書かれていない」と否定する
    # 回答が確認された（anomaly-detection側）ため、否定の仕方も明示的に禁止する
    "「〇〇についての記載はありません」と否定する場合も、その〇〇（名称・用語等）自体を"
    "新しく作り出さないでください。抜粋に実際に登場する語句以外を、存在しないことの"
    "説明のためだけに挙げるのも禁止です。"
    "回答の中で、どの文書（『文書名』）の内容かが分かるようにしてください。"
    # 実モデルが、プロンプト内の見出し名をそのまま回答に出すことがあったため
    "「関連資料の抜粋」という見出しの名前は、回答の中で口にしないでください。"
    # 画面は回答をプレーンテキストで表示する（Markdownとして描画しない）
    "回答はMarkdown記法（#や**、-の箇条書き等）を使わず、プレーンテキストで書いてください。"
    "見出しが必要な場合は「【見出し】」の形式を使い、箇条書きは「・」または番号（1.）を使ってください。"
)

# 「マニュアルを見せて」のような直接の質問のときだけ、CHAT_SYSTEM_PROMPTの後ろに足す。
# 常にsystemに入れておくと、実モデルが通常の質問にまで当てはめ、回答に「記載があります」などの
# 前置きを付けるため。直接の質問は、上の「関係のある内容だけ」というルールを当てはめると、
# 「記載がありません」と拒否してしまう
MANUAL_REQUEST_PROMPT = (
    "今回のユーザーは、資料（マニュアル等）そのものの有無や表示を直接尋ねています。"
    "「関連資料の抜粋」の内容が質問の話題と直接関係なくても、拒否しないでください。"
    "抜粋にその対象の記載が実際にあるかどうかを一言で伝え、記載がある場合は、"
    "どの文書（『文書名』）に記載があるかを伝えて、その抜粋が回答の下に"
    "「参照マニュアル」として表示されることを案内してください。"
)

# 質問にタグ名が書かれていて、そのタグが付いた資料を根拠にしたとき（_describe_tag_match）だけ、
# CHAT_SYSTEM_PROMPTの後ろに足す。どのタグ名かは、抜粋の見出し（_build_manual_context）に書く。
# 実モデルは、これが無いと、タグ名を本文の中から探し、「Aという名称は資料に無い」と答える。
# 抜粋が、質問との意味の近さではなく、タグが付いていることで選ばれた場合は、質問に答えているとは限らない
TAG_REQUEST_PROMPT = (
    "今回のユーザーは、資料に付けられたタグ名を挙げて質問しています。"
    "タグ名は、資料に付けた名前（分類のラベル）で、資料の本文に出てくる語とは限りません。"
    "「関連資料の抜粋」では、『文書名』の後ろの「タグ:」に、その文書に付けられたタグ名を示しています。"
    "質問に出てきたタグ名が付いた資料は、そのタグ名で指された対象の資料として扱ってください。"
    "本文にタグ名と同じ語が見当たらなくても、そのことを回答に書かないでください。"
    "タグ名だけを尋ねている場合（例:「Aの資料は？」「Bに関する情報」）は、そのタグが付いた資料（『文書名』）が"
    "登録されていることと、抜粋から分かる内容の概要を答えてください。"
    "タグ名のほかに具体的な質問があり、抜粋にその答えが無いときは、答えが資料に無い旨を、"
    "そのタグが付いた資料の文書名を挙げて伝えてください。"
    "抜粋に書かれていないタグ名を、新しく作り出さないでください。"
)

# 根拠になる抜粋が1件も無いときの回答（LLMは呼ばない）
NO_EVIDENCE_ANSWER = (
    "登録された資料には、その記載がありません。質問に十分関連する内容を見つけられませんでした。"
    "質問の言い方を変えるか、タグ名で絞り込んで、もう一度お試しください。"
)


@dataclass(frozen=True)
class TagMatch:
    """質問に書かれたタグ名が、根拠にした資料に付いていること（LLMに、そのタグ名を伝えるための情報）"""

    # 質問に書かれていたタグ名のうち、根拠にした資料のどれかに付いているもの
    names: List[str]
    # 根拠にした文書ID → その文書に付いているタグ名の全て（抜粋の見出しに出す。画面へ返す参照マニュアルには含めない）
    tags_by_document: Dict[str, List[str]]


class EmptyAnswerError(RuntimeError):
    """LLMが空の回答を返した（回答として保存・表示しない）"""


class ChatService:
    """マニュアルのRAG検索を踏まえた回答の生成"""

    # 回答の根拠にする抜粋の件数の上限
    MAX_MANUAL_REFERENCES = 5

    # 抜粋を根拠として使う類似度の下限（暫定）。実測（登録済みの文書を4チャンクに分けた小さな例）で、
    # 該当する記載を含むチャンクの類似度は、質問が短いと0.47まで下がり（0.5だと正解を落とす）、
    # 範囲外の質問の最大は0.42だった。8文書・107チャンクの検証（該当あり0.58〜0.78、範囲外0.38〜0.43）
    # とも矛盾しない。③の検索画面の「関連度が低い」（0.5未満。ragRules.tsのLOW_SIMILARITY_THRESHOLD）は、
    # 表示上の目安で別の値。実際のマニュアルで再確認が要る
    RELEVANCE_THRESHOLD = 0.45

    # LLMに渡す会話履歴の文字数の上限。会話が長くなるほど、履歴を毎回送り直す分が
    # コンテキストを使い切り、回答が途中で打ち切られる。トークナイザーを使わないため、
    # 1文字≒1トークンとして安全側に見積もる。表示・保存は全履歴のままで、LLMへ渡すときだけ絞る
    MAX_HISTORY_CHARS = 3000

    # 回答の最大トークン数。解説的な長い回答が途中で切れないよう、余裕を持たせる
    MAX_ANSWER_TOKENS = 4000

    # OCRの主文（vision LLM）と同じコンテキスト長にする。違う値で呼ぶと、Ollamaは同じモデルを
    # ロードし直す（OCRとチャットを行き来するたびに、数十秒の待ちが入る）
    NUM_CTX = DEFAULT_VISION_NUM_CTX

    def __init__(
        self,
        db: Database,
        retriever: ManualRetriever,
        ollama_host: str,
        chat_model: str,
        request_timeout_seconds: int = 120,
    ):
        """
        Args:
            db: タグ名の候補・原本PDFの有無の確認に使う
            retriever: マニュアルの検索
            ollama_host: Ollama APIのURL
            chat_model: 回答を作るOllamaのモデル名
            request_timeout_seconds: Ollamaの応答を待つ時間（秒）。ストリーミングでは、次の断片が
                届くまでの待ち時間として働く
        """
        self.db = db
        self.retriever = retriever
        self.ollama_host = ollama_host
        self.chat_model = chat_model
        self.request_timeout_seconds = request_timeout_seconds

    # ---- 検索 ----

    def _equipment_name_candidates(self) -> List[str]:
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT DISTINCT equipment_name FROM r_manual_document_equipment")
            return [row['equipment_name'] for row in cursor.fetchall()]

    def _resolve_equipment_name(self, question: str, session_equipment_name: Optional[str]) -> Optional[str]:
        """
        検索を絞るタグ名を決める。質問文での明示的な言及を最優先し（会話のタグ名と違う対象を
        尋ねているときに、会話のタグ名に引きずられないため）、無ければ会話のタグ名にする
        """
        resolved = resolve_equipment_name(question, self._equipment_name_candidates())
        return resolved or session_equipment_name

    def _with_pdf_flags(self, chunks: List[Dict]) -> List[Dict]:
        """検索結果を、画面に出す参照マニュアルの形（原本PDFの有無つき）にする"""
        if not chunks:
            return []
        document_ids = list({chunk['document_id'] for chunk in chunks})
        with self.db.get_cursor() as cursor:
            cursor.execute(
                "SELECT document_id::text AS document_id FROM m_manual_pdf WHERE document_id = ANY(%s::uuid[])",
                (document_ids,),
            )
            with_pdf = {row['document_id'] for row in cursor.fetchall()}
        return [
            {
                'document_title': chunk['document_title'],
                'document_id': chunk['document_id'],
                'similarity': float(chunk['similarity']),
                'content': chunk['content'],
                'has_pdf': chunk['document_id'] in with_pdf,
            }
            for chunk in chunks
        ]

    def _fetch_manual_chunks(
        self, question: str, session_equipment_name: Optional[str], relax_threshold: bool
    ) -> List[Dict]:
        """
        質問文で関連するマニュアルの抜粋を検索する（失敗は例外のまま伝える）

        検索に失敗したときに、失敗をモデルに伝えて回答を続けさせると、モデルが根拠なく回答を
        作ってしまう。回答せず、失敗として画面に伝える。

        Args:
            relax_threshold: Trueなら、類似度の足切りをしない（is_manual_request参照）
        """
        equipment_name = self._resolve_equipment_name(question, session_equipment_name)
        candidates = self.retriever.search(
            question, equipment_name=equipment_name, top_k=self.MAX_MANUAL_REFERENCES
        )
        if not relax_threshold:
            candidates = [c for c in candidates if c['similarity'] >= self.RELEVANCE_THRESHOLD]
        return self._with_pdf_flags(candidates)

    def _tag_names_in_question(self, question: str) -> List[str]:
        """質問文に書かれたタグ名（会話に設定したタグ名は含めない）"""
        return find_mentioned_equipment_names(question, self._equipment_name_candidates())

    def _fetch_tagged_chunks(self, question: str, tag_names: List[str]) -> List[Dict]:
        """
        質問文に書かれたタグ名が付いた資料の抜粋を、類似度に関わらず検索する（失敗は例外のまま伝える）

        タグ名は埋め込みの対象ではないため、タグ名しか書かれていない質問は、そのタグの資料があっても
        類似度が足切りに届かない。通常の検索で根拠が0件のときの代わりとして使う。
        会話に設定したタグ名は使わない（質問が、そのタグの資料を指しているとは限らないため。
        範囲外の質問まで、根拠を見つけたことにしない）。呼び出し側が、質問に書かれたタグ名を渡す。

        Returns:
            参照マニュアルの形の抜粋。tag_namesが空、または、そのタグが付いた資料が無いときは空リスト
        """
        if not tag_names:
            return []
        candidates = self.retriever.search_tagged(question, tag_names, top_k=self.MAX_MANUAL_REFERENCES)
        return self._with_pdf_flags(candidates)

    def _describe_tag_match(self, chunks: List[Dict], tag_names: List[str]) -> Optional[TagMatch]:
        """
        質問に書かれたタグ名が、根拠にした資料に付いているかを調べ、付いていればLLMに伝える情報にする

        タグ名が付いていない資料（例: タグなしの共通の資料）だけが根拠のときは、タグ名の質問として扱わない。
        """
        if not chunks or not tag_names:
            return None
        with self.db.get_cursor() as cursor:
            cursor.execute(
                """
                SELECT document_id::text AS document_id, array_agg(equipment_name ORDER BY equipment_name) AS names
                FROM r_manual_document_equipment WHERE document_id = ANY(%s::uuid[]) GROUP BY document_id
                """,
                (list({chunk['document_id'] for chunk in chunks}),),
            )
            tags_by_document = {row['document_id']: list(row['names']) for row in cursor.fetchall()}
        carried = {name for tags in tags_by_document.values() for name in tags}
        matched_names = [name for name in tag_names if name in carried]
        if not matched_names:
            return None
        return TagMatch(names=matched_names, tags_by_document=tags_by_document)

    @classmethod
    def _build_manual_context(cls, chunks: List[Dict], tag_match: Optional[TagMatch] = None) -> str:
        """
        検索で見つかった抜粋（1件以上）を、システムプロンプトに入れる「関連資料の抜粋」の文章にする

        tag_matchがあるとき（質問に書かれたタグ名が、根拠にした資料に付いている）は、どのタグ名かを見出しに書き、
        各抜粋に、その文書のタグ名を付ける（「Aが付いた資料は？」に、抜粋から答えられるように）。
        """
        lines = [f"【関連資料の抜粋（類似度上位{len(chunks)}件）】"]
        best_similarity = max(chunk['similarity'] for chunk in chunks)
        if tag_match is not None:
            tag_list = "、".join(f"「{name}」" for name in tag_match.names)
            lines.append(
                f"※質問に書かれたタグ名{tag_list}は、以下の資料に付けられています"
                "（『文書名』の後ろに、その文書のタグ名を示します）。"
            )
            if best_similarity < cls.RELEVANCE_THRESHOLD:
                # 低い類似度でも、「記載がない旨を冒頭に書け」とは言わない（タグの資料があること自体が答えになるため）
                lines.append(
                    f"ただし、質問との類似度は最高でも{best_similarity:.2f}で、"
                    "質問の内容に直接該当する記載があるとは限りません。"
                )
        elif best_similarity < cls.RELEVANCE_THRESHOLD:
            # 足切りを外した質問（is_manual_request）でだけ起こる。LLMが自発的に断ってくれることを
            # 当てにせず、明示的に指示する
            lines.append(
                f"※以下の抜粋はいずれも関連度が低く（最高でも類似度{best_similarity:.2f}）、"
                "質問に直接該当する記載は見つかりませんでした。参考程度に留め、"
                "回答の冒頭で「資料には本件に直接該当する記載がない」旨を明記してください。"
            )
        for i, chunk in enumerate(chunks, 1):
            tags = tag_match.tags_by_document.get(chunk['document_id'], []) if tag_match is not None else []
            tag_label = f"（タグ: {'、'.join(tags)}）" if tags else ""
            lines.append(f"{i}. 『{chunk['document_title']}』{tag_label}（類似度 {chunk['similarity']:.2f}）")
            lines.append(f"   {chunk['content']}")
        return "\n".join(lines)

    # ---- LLM ----

    @classmethod
    def _trim_history(cls, history: List[Dict]) -> List[Dict]:
        """LLMに渡す会話履歴を、直近からMAX_HISTORY_CHARS文字分に絞る（直近の1件は必ず残す）"""
        trimmed: List[Dict] = []
        total_chars = 0
        for message in reversed(history):
            total_chars += len(message['content'])
            if total_chars > cls.MAX_HISTORY_CHARS and trimmed:
                break
            trimmed.append(message)
        trimmed.reverse()
        return trimmed

    def _build_messages(
        self, history: List[Dict], question: str, manual_context: str, manual_request: bool = False,
        tag_match: Optional[TagMatch] = None,
    ) -> List[Dict]:
        """
        Ollama /api/chat のmessagesを組み立てる

        /api/chat はステートレスなため、毎回、会話の履歴を送り直す。抜粋は、今回の質問に対する
        ものだけをsystemに入れる（過去の質問の抜粋は送り直さない）。
        """
        system_prompt = (
            f"{CHAT_SYSTEM_PROMPT}{MANUAL_REQUEST_PROMPT if manual_request else ''}"
            f"{TAG_REQUEST_PROMPT if tag_match is not None else ''}"
        )
        messages = [{"role": "system", "content": f"{system_prompt}\n\n{manual_context}"}]
        messages.extend({"role": m['role'], "content": m['content']} for m in self._trim_history(history))
        messages.append({"role": "user", "content": question})
        return messages

    def _call_llm_stream(self, messages: List[Dict]) -> Generator[str, None, None]:
        """
        Ollama（/api/chat、stream=True）を呼び、回答の断片を順にyieldする（連結すると全文）

        自由文の回答なので、JSON Schemaでの構造の強制（format）はしない。
        """
        response = None
        try:
            response = requests.post(
                f"{self.ollama_host}/api/chat",
                json={
                    "model": self.chat_model,
                    "messages": messages,
                    "stream": True,
                    # qwen3.5は既定で思考モードが有効で、内部推論がnum_predictを使い切り、
                    # 最終回答が空になることがあるため無効にする
                    "think": False,
                    "options": {"num_predict": self.MAX_ANSWER_TOKENS, "num_ctx": self.NUM_CTX},
                },
                timeout=self.request_timeout_seconds,
                stream=True,
            )
            response.raise_for_status()
            for line in response.iter_lines():
                if not line:
                    continue
                chunk = json.loads(line)
                content = chunk.get("message", {}).get("content", "")
                if content:
                    yield content
                if chunk.get("done"):
                    break
        except requests.RequestException as e:
            logger.error(f"Ollamaの呼び出しに失敗しました ({self.ollama_host}, model={self.chat_model}): {e}")
            raise
        finally:
            # 呼び出し側が、クライアントの切断（停止ボタン・ESC）でこのジェネレータをclose()すると、
            # yieldの位置にGeneratorExitが投げ込まれる。finallyは正常終了でも中断でも必ず実行されるので、
            # ここでOllamaへの接続を閉じれば、Ollama側が切断を検知して生成を打ち切る
            # （「停止したのに、裏でLLMの生成が続く」状態を防ぐ）
            if response is not None:
                response.close()

    def ask_stream(
        self, question: str, session_equipment_name: Optional[str], history: List[Dict]
    ) -> Generator[Dict, None, None]:
        """
        質問に対して、RAG検索を踏まえた回答をストリーミングで生成する

        呼び出し側（api/chat.py）は、このイベントの列をそのままHTTPレスポンスにして順に送り、
        画面は、受け取るたびに回答を書き足していく（生成の完了を待たずに表示するため）。
        Iteratorではなく、Generatorを返すのは、呼び出し側がクライアントの切断時に
        close()して打ち切るため。

        Args:
            question: 質問文
            session_equipment_name: 会話に設定されたタグ名（無ければNone）。質問文にタグ名があれば、そちらが優先される
            history: この会話の既存のメッセージ（[{'role', 'content'}]、時系列順。今回の質問は含まない）

        Raises:
            requests.RequestException: 検索の埋め込み・LLMの呼び出しに失敗したとき
            EmptyAnswerError: LLMが空の回答を返したとき

        Yields:
            {'type': 'manual_references', 'manual_references': [...] | None} を最初に1回
            （根拠にした抜粋。類似度で見つかったもの。無ければ、質問に書かれたタグ名が付いた資料のもの。
            それも1件も無いときはNone。その場合、LLMは呼ばず、NO_EVIDENCE_ANSWERを返す）、
            続けて {'type': 'delta', 'text': str} を回答の生成の間くり返し、
            最後に {'type': 'done', 'full_text': str, 'manual_references': [...] | None}
        """
        manual_request = is_manual_request(question)
        manual_references = self._fetch_manual_chunks(
            question, session_equipment_name, relax_threshold=manual_request
        )
        tag_names = self._tag_names_in_question(question)
        if not manual_references:
            # 類似度では根拠が見つからなくても、質問に書かれたタグ名の資料があれば、それを根拠にする
            manual_references = self._fetch_tagged_chunks(question, tag_names)
        if not manual_references:
            yield {'type': 'manual_references', 'manual_references': None}
            yield {'type': 'delta', 'text': NO_EVIDENCE_ANSWER}
            yield {'type': 'done', 'full_text': NO_EVIDENCE_ANSWER, 'manual_references': None}
            return

        tag_match = self._describe_tag_match(manual_references, tag_names)
        yield {'type': 'manual_references', 'manual_references': manual_references}

        messages = self._build_messages(
            history, question, self._build_manual_context(manual_references, tag_match), manual_request, tag_match
        )
        full_text_parts = []
        # このジェネレータがclose()されたとき（クライアントの切断）に、Ollamaへの接続を確実に閉じる
        with closing(self._call_llm_stream(messages)) as llm_stream:
            for delta in llm_stream:
                full_text_parts.append(delta)
                yield {'type': 'delta', 'text': delta}

        full_text = ''.join(full_text_parts)
        if not full_text.strip():
            # 空の回答を、正常な回答として保存・表示しない（原因が分かるエラーにする）
            raise EmptyAnswerError(
                f"モデル（{self.chat_model}）が空の回答を返しました。もう一度質問してください。"
                "続く場合は、モデルの状態（Ollamaのログ）を確認してください。"
            )

        yield {'type': 'done', 'full_text': full_text, 'manual_references': manual_references}
