"""
補正の再チェック: 補正LLMが主文を書き換えた箇所を、「PDFにそう書かれているか」「日本語として正しいか」で確かめる

背景(2026-10-08): 補正LLM(vision_correction.correct_page_with_vision_llm)が、正しく読めていた主文を、弱い方の候補で
上書きする誤りを、実機の下書きで確認した(助詞が欠ける「〜について」→「〜ついて」、語の一部が落ちる「コントローラ」→「コントロラ」のような誤り)。
補正LLMは、画像を根拠にしたと言いながら、存在しない欄(「図解欄」)を理由に挙げており、同じ画像でもう一度
聞いても、同じ誤りを繰り返す恐れがある。そこで、別の根拠で確かめる。

1. PDFのテキスト層(pdf_text.py): 文字として埋め込まれた文字列に、補正後・主文の表記があるかを照合する。LLMを使わず、確実。
   補正後だけがある→補正を認める。主文だけがある→補正を取り消す。両方・どちらも無い・短すぎる→2へ。
   スキャンしたPDF(テキスト層が無い)では、行わない。
2. 日本語としての自然さ(LLM。画像は使わず、文字だけ): 前後の文脈つきで、主文と補正後の、どちらが日本語として
   正しいかを判定させる。LLMには、表記の並び順に偏りがあるため、並び順を入れ替えて2回聞き、2回とも主文が正しいと
   判定したときだけ、補正を取り消す(判断が割れたら、補正を認める)。画像を使わないのは、補正LLMと同じ根拠で
   同じ誤りを繰り返さないため。型番・数値・コードなど、日本語の自然さで決められないものは、取り消さない。

「取り消す」ことしかしない(補正を増やしたり、別の文字列を作ったりはしない)。確認できなかったとき
(LLMへの接続失敗・応答の形式不正)は、補正を認めたままにし、警告をログに残す(再チェックが無かった従来と同じ結果)。
"""
import json
import logging
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import jsonschema
import requests

from ocr_rag.ocr.pdf_text import appears_in_page, squash_for_search
from ocr_rag.ocr.vision_correction import DEFAULT_VISION_MODEL, DEFAULT_VISION_NUM_CTX, MAX_VISION_ATTEMPTS

logger = logging.getLogger(__name__)

# 確認結果の根拠
BASIS_TEXT_LAYER = "text_layer"
BASIS_LANGUAGE = "language"
BASIS_NONE = "none"  # 確認できなかった(根拠なし)。補正は、認めたまま

_LANGUAGE_RECHECK_TIMEOUT_SECONDS = 120

LANGUAGE_RECHECK_SYSTEM_PROMPT = (
    "あなたは日本語の技術文書(機器のマニュアル)の校正者です。"
    "マニュアルをOCRした結果の一部分について、2通りの表記(表記1・表記2)があります。"
    "前後の文脈の中で、日本語として正しいのはどちらかを判定してください。"
    "助詞が欠けている(例: 「について」が「ついて」になっている)、存在しない語、"
    "送り仮名・用語の誤り、簡体字中国語の字体(例: 压缩机)が混ざっている表記は、誤りです。"
    "型番・数値・記号・コード・固有名詞など、日本語の自然さでは決められないものは、必ず equal としてください。"
    "どちらも日本語として正しい、または、どちらが正しいか判断できない場合も equal としてください。"
    "画像はありません。文字だけで判断し、推測で別の表記を作らないでください。"
    "betterには、表記1が正しいなら \"1\"、表記2が正しいなら \"2\"、同程度・判断できないなら \"equal\" を入れてください。"
    "reasonには、判定の根拠を1文で書いてください(空にしてはいけません)。"
)

LANGUAGE_RECHECK_SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "OCR_Correction_Language_Recheck",
    "type": "object",
    "properties": {
        "judgments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "segment_id": {"type": "string"},
                    "better": {"type": "string", "enum": ["1", "2", "equal"]},
                    "reason": {"type": "string", "minLength": 1, "maxLength": 200},
                },
                "required": ["segment_id", "better", "reason"],
            },
        },
    },
    "required": ["judgments"],
}


@dataclass(frozen=True)
class RecheckItem:
    """再チェックする1箇所。補正が、主文(primary)を、補正後(chosen)に書き換えた箇所"""
    segment_id: str
    primary: str
    chosen: str
    # 前後の文脈(主文の、この箇所の前後の文字。日本語として正しいかの判断に使う)
    before: str
    after: str


@dataclass(frozen=True)
class RecheckVerdict:
    """再チェックの結果。keep_chosen=Falseは、補正を取り消して、主文を残すこと"""
    segment_id: str
    keep_chosen: bool
    basis: str
    reason: str


def _one_line(text: str) -> str:
    return " ".join(text.split())


def _build_user_prompt(items: List[RecheckItem], swapped: bool) -> str:
    lines = ["次の各箇所について、表記1・表記2のうち、前後の文脈の中で日本語として正しいのはどちらか、JSON Schema通りに回答してください。"]
    for item in items:
        first, second = (item.chosen, item.primary) if swapped else (item.primary, item.chosen)
        lines.append(
            f"\n[segment_id: {item.segment_id}]\n"
            f"前の文脈: …{_one_line(item.before)}\n"
            f"表記1: {_one_line(first)}\n"
            f"表記2: {_one_line(second)}\n"
            f"後の文脈: {_one_line(item.after)}…"
        )
    return "\n".join(lines)


def _ask_language_once(
    items: List[RecheckItem], swapped: bool, ollama_host: str, model: str, timeout_seconds: int
) -> Optional[Dict[str, Tuple[str, str]]]:
    """
    並び順を指定して1回聞く。戻り値は、segment_id → (どちらが正しいか("primary"/"chosen"/"equal"), 理由)。
    LLMに接続できない・応答がMAX_VISION_ATTEMPTS回とも形式不正のときは、None。
    """
    user_prompt = _build_user_prompt(items, swapped)
    for attempt in range(1, MAX_VISION_ATTEMPTS + 1):
        try:
            response = requests.post(
                f"{ollama_host}/api/chat",
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": LANGUAGE_RECHECK_SYSTEM_PROMPT},
                        {"role": "user", "content": user_prompt},
                    ],
                    "format": LANGUAGE_RECHECK_SCHEMA,
                    "stream": False,
                    "think": False,
                    # num_ctxは、他の呼び出しと同じ値にする(違うと、Ollamaがモデルをロードし直す)。
                    # temperature=0: 同じ入力に、毎回同じ判定を返させる
                    "options": {"num_ctx": DEFAULT_VISION_NUM_CTX, "temperature": 0.0},
                },
                timeout=timeout_seconds,
            )
            response.raise_for_status()
            parsed = json.loads(response.json()["message"]["content"])
            jsonschema.validate(instance=parsed, schema=LANGUAGE_RECHECK_SCHEMA)
        except requests.RequestException as e:
            logger.error(f"補正の再チェック(日本語)のLLM呼び出しに失敗しました ({ollama_host}, model={model}): {e}")
            return None
        except (json.JSONDecodeError, jsonschema.ValidationError, KeyError) as e:
            logger.warning(f"補正の再チェック(日本語)の応答がJSON Schemaに適合しません (attempt {attempt}/{MAX_VISION_ATTEMPTS}): {e}")
            continue

        resolved: Dict[str, Tuple[str, str]] = {}
        for judgment in parsed["judgments"]:
            better = judgment["better"]
            if better == "equal":
                winner = "equal"
            elif (better == "1") != swapped:
                winner = "primary"  # 並び順どおり(表記1=主文)で表記1、または入れ替え後(表記1=補正後)で表記2
            else:
                winner = "chosen"
            resolved[judgment["segment_id"]] = (winner, judgment["reason"].strip())
        return resolved

    logger.error(f"補正の再チェック(日本語)の応答が{MAX_VISION_ATTEMPTS}回とも形式不正でした。この確認は行いません。")
    return None


def _recheck_by_language(
    items: List[RecheckItem], ollama_host: str, model: str, timeout_seconds: int
) -> Dict[str, RecheckVerdict]:
    """並び順を入れ替えて2回聞き、2回とも主文が正しいとされた箇所だけ、補正を取り消す"""
    first = _ask_language_once(items, False, ollama_host, model, timeout_seconds)
    # 1回目が失敗したなら、2回目も同じ理由で失敗する見込みのため、聞かない(取り消すには、2回の一致が要る)
    second = _ask_language_once(items, True, ollama_host, model, timeout_seconds) if first is not None else None
    if first is None or second is None:
        return {
            item.segment_id: RecheckVerdict(item.segment_id, True, BASIS_NONE, "日本語としての再チェックを行えませんでした")
            for item in items
        }

    verdicts: Dict[str, RecheckVerdict] = {}
    for item in items:
        a = first.get(item.segment_id)
        b = second.get(item.segment_id)
        if a is not None and b is not None and a[0] == "primary" and b[0] == "primary":
            verdicts[item.segment_id] = RecheckVerdict(
                item.segment_id, False, BASIS_LANGUAGE, f"補正後より主文のほうが、日本語として正しいと判定されました(2回とも): {a[1]}"
            )
        else:
            verdicts[item.segment_id] = RecheckVerdict(
                item.segment_id, True, BASIS_LANGUAGE if a is not None and b is not None else BASIS_NONE,
                "日本語としては、補正後を取り消す根拠がありません",
            )
    return verdicts


def recheck_corrections(
    items: List[RecheckItem],
    page_text: Optional[str],
    ollama_host: str,
    model: str = DEFAULT_VISION_MODEL,
    timeout_seconds: int = _LANGUAGE_RECHECK_TIMEOUT_SECONDS,
) -> Dict[str, RecheckVerdict]:
    """
    補正が主文を書き換えた箇所(items)を再チェックし、segment_id → 結果を返す。
    page_text: そのページのPDFのテキスト層(pdf_text.extract_page_texts)。無い(スキャン・取り出せなかった)ときは None。
    """
    if not items:
        return {}

    verdicts: Dict[str, RecheckVerdict] = {}
    pending: List[RecheckItem] = []
    squashed = squash_for_search(page_text) if page_text is not None else None

    for item in items:
        if squashed is not None:
            in_chosen = appears_in_page(squashed, item.chosen)
            in_primary = appears_in_page(squashed, item.primary)
            if in_chosen is True and in_primary is not True:
                verdicts[item.segment_id] = RecheckVerdict(item.segment_id, True, BASIS_TEXT_LAYER, "PDFのテキスト層に、補正後の表記があります")
                continue
            if in_primary is True and in_chosen is not True:
                verdicts[item.segment_id] = RecheckVerdict(item.segment_id, False, BASIS_TEXT_LAYER, "PDFのテキスト層にあるのは、補正前(主文)の表記です")
                continue
        pending.append(item)

    if pending:
        verdicts.update(_recheck_by_language(pending, ollama_host, model, timeout_seconds))
    return verdicts
