"""
不一致セグメントの画像根拠修正（既存のvision対応LLM = qwen3.5:9b を使用、新規モデル追加不要）

ocr_diff.pyが検出した不一致セグメント(is_match=False)を、該当ページの
画像とあわせてvision対応LLMに渡し、画像に写っている実際の文字を根拠にどちらの候補が
正しいか（あるいは両方とも誤りで正しい文字列は何か）を判定させる。テキストのみでの
自動修正はしない（画像根拠が無いと"それっぽいが間違った"方向に補正するリスクがある、
特に故障コード表の数字）。

画像を見ても判定できない場合はstill_uncertain=Trueとし、下書きは自動置換せず
「要人手確認」として残す（人手レビューはゼロにしない、という方針）。

2026-09-29(5): GLM-OCR(0.9B専用OCRモデル)が生成打ち切り(done:false)で
完全に失敗したページに対する最終手段として、qwen3.5:9b(汎用vision対応LLM)に
ページ画像をそのままフルページOCRさせるocr_full_page_with_vision_llm()を追加した。
表組みや丸数字等の複雑な内容は0.9Bモデルには荷が重いが、より大きい汎用vision LLMなら
正しく読み取れることを人手での書き起こし作業（過去のマニュアル取込時、実際にAIが
画像を直接見て書き起こしていた）で確認済み。

2026-09-29(6): 上記フォールバックが成功しても機械的に毎回needs_reviewを立てると
人手確認の手間が減らないため、verify_full_page_ocr_with_vision_llm()を追加した。
書き起こし結果を画像と再度照合させ、内容の欠落・誤読が無いと確認できた場合のみ
needs_reviewマーカーを外し、確認が取れない場合（画像との不一致、JSON検証失敗、
接続失敗）は保守的にneeds_reviewを残す（サイレントに承認しない）。

2026-09-29(8): 実機検証で、qwen3.5:9bのフルページOCR/検証結果に日本語であるべき
漢字が簡体字中国語の字体で混入する不具合（例: 圧縮機→压缩机）、および
think:false指定にもかかわらず書き起こし本文の末尾に「誤植なので修正が必要」等の
自己レビューコメントが混入する不具合を確認した。両プロンプトに、日本語字体を
明示指定し簡体字を禁止する指示・書き起こし以外の内容を含めない指示を追加した。

2026-09-29(9): 上記対応後の実機検証で、①②③や(ア)(イ)等の番号付き見出しを含む
ページで、見出しとその本文の順序が入れ替わって書き起こされる不具合を確認した
（diff_page()は同じ順序で書かれている前提のため、入力段階で順序が崩れると
最終テキストの再構成も崩れる）。両プロンプトに、画像上の実際の順序通りに
書き起こす指示・見出しと本文の順序を入れ替えない指示を追加した。

2026-09-29(11): GLM-OCRの部分応答を比較材料にする方式(2026-09-29(10))は、
GLM-OCRが表を書いている途中で打ち切られた場合、部分応答自体の表構造が壊れており
（セル区切りの不整合等）、qwen3.5:9bのフルページOCR結果とのdiffで大量の
細かい不一致が生じ、correct_page_with_vision_llm()が一部しか判定を返せない
（MISSING_JUDGMENT_REASON多発）ことが実機検証で判明した。ocr_pipeline.py側で
この判定漏れの件数から比較材料の適否を診断し、不適と判断した場合はGLM-OCRの
部分応答を使わず、ocr_full_page_with_vision_llm()を異なるtemperature/seedで
もう一度呼び出してqwen3.5:9b自身の2回の結果同士をdiffする方式に切り替える。

2026-09-30(12): 主文をGLM-OCRからvision LLMに切り替えた(ocr_pipeline.py参照)。
補正プロンプトの候補A/Bは「GLM-OCR 1回目/2回目」から中立表現(主文/別の読み取り)に変更した。
"""
import base64
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import jsonschema
import requests

from ocr_rag.ocr.ocr_diff import DiffSegment

logger = logging.getLogger(__name__)

DEFAULT_VISION_MODEL = "qwen3.5:9b"
DEFAULT_VISION_TIMEOUT_SECONDS = 120
# 2026-09-29: 実機で、num_ctx未指定時にollamaがqwen3.5:9bをコンテキスト長4096で
# ロードし、画像1枚+複数セグメント分のプロンプトで4096を超えて
# "request exceeds the available context size" 400エラーになる不具合を確認した
# （ocr_engines.pyのGLM-OCR側と同じ既知の対策）
DEFAULT_VISION_NUM_CTX = 16384
MAX_VISION_ATTEMPTS = 2  # 失敗時は1回だけリトライする

# ocr_pipeline.pyが「比較材料として使い物にならない(構造が不整合)」を検知するための
# 判定漏れ理由の正規文字列。文字列リテラルの重複を避けるためここでexportする。
MISSING_JUDGMENT_REASON = "vision LLM応答にこのセグメントの判定が含まれていません"

FULL_PAGE_OCR_PROMPT = (
    "この画像は空調設備の機器マニュアルの1ページです。"
    "文章はMarkdown形式で、表組みは表として、見出しは#で、忠実に書き起こしてください。"
    "画像に無い内容を補完したり要約したりせず、実際に書かれている文字だけを出力してください。"
    "内容は1回だけ出力し、同じ内容を繰り返さないでください。"
    "この文書は日本語です。漢字は必ず日本語の字体（例: 圧縮機・電源・熱源機・減少・増加）で"
    "出力し、簡体字中国語の字体（例: 压缩机・电源・热源机・减少・增加）を絶対に使わないでください。"
    "出力は書き起こしたテキストのみとし、注釈・断り書き・自己レビュー・修正提案などの"
    "テキスト以外の内容は一切含めないでください。"
    "画像上の文章を上から下へ、同じ行内では左から右へ、実際に書かれている順序の通りに"
    "書き起こしてください。①②③や(ア)(イ)のような番号付き見出しがあっても、"
    "見出しとその本文の順序を絶対に入れ替えたり、後の見出しの内容を先に書いたりしないでください。"
    "表のセル内で文が改行されていても、<br>などのHTMLタグは使わず、同じセル内に続けて書いてください。"
)

FULL_PAGE_OCR_VERIFY_SYSTEM_PROMPT = (
    "あなたは空調設備マニュアルの画像とOCR書き起こし結果を照合する専門家です。"
    "添付画像に実際に書かれている内容と、渡された書き起こしテキストを比較し、"
    "内容の欠落・誤字・意味の変化・文の順序の入れ替わりが無いか確認してください。"
    "改行位置や見出し記号などの些細な体裁の違いは無視してよいですが、"
    "文字・数値・表の内容の誤りや欠落、見出しと本文の順序の入れ替わりは見逃さないでください。"
    "この文書は日本語です。書き起こしテキストに簡体字中国語の字体（例: 压缩机・电源・"
    "热源机・减少・增加）が混入している場合は誤りとして扱い、対応する日本語の字体"
    "（例: 圧縮機・電源・熱源機・減少・増加）に修正してください。"
    "問題が無い場合、corrected_textには渡された書き起こしテキストをそのまま返してください。"
    "問題がある箇所を見つけた場合のみ、その箇所を画像に忠実な内容・正しい順序へ修正したうえで、"
    "それ以外の問題ない部分は変更せずcorrected_textに全文を返してください"
    "（部分的な抜粋ではなく、書き起こしテキスト全体を返すこと）。"
    "corrected_textには書き起こしたテキストのみを含め、注釈・断り書き・自己レビューなど"
    "テキスト以外の内容は一切含めないでください。"
)

FULL_PAGE_OCR_VERIFY_SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Full_Page_OCR_Verification",
    "type": "object",
    "properties": {
        "matches_image": {"type": "boolean"},
        "corrected_text": {"type": "string"},
        "reason": {"type": "string", "minLength": 1, "maxLength": 300},
    },
    "required": ["matches_image", "corrected_text", "reason"],
}

VISION_CORRECTION_SYSTEM_PROMPT = (
    "あなたは空調設備マニュアルの画像とOCR結果を照合する専門家です。"
    "添付画像に実際に書かれている文字だけを根拠に判定してください。"
    "画像に無い情報を推測で補ってはいけません。"
    "候補AとBのどちらかが正しいとは限らず、両方とも誤っている場合もあります。"
    "どちらの候補も画像と一致しない場合は、画像から読み取れる正しいテキストをcorrected_textに"
    "書いてください。"
    "この文書は日本語です。漢字は日本語の字体で扱い、簡体字中国語の字体（例: 压缩机・电源・"
    "热源机・减少・增加）が候補に含まれていればそれは誤りです。日本語の字体（例: 圧縮機・電源・"
    "熱源機・減少・増加）の候補、または画像どおりの字体を採用してください。"
    "箇条書きの記号（●・■など）、表の罫線、改行位置、全角半角、空白の違いだけで内容が同じ場合は、"
    "内容の違いではありません。その場合は内容が画像と一致する方をcorrected_textにそのまま返してください。"
    "画像を見ても判定できない場合は、最も確からしい候補をcorrected_textに入れ、"
    "still_uncertainをtrueにしてください。"
    "画像にその箇所自体が存在しない場合のみ、corrected_textを空文字にしてください。"
    "表のセル内の改行を表すために<br>などのHTMLタグを使ってはいけません（続けて書いてください）。"
    "reasonには、判定の根拠を画像の内容に即して1文で必ず書いてください（空にしてはいけません）。"
)

CORRECTION_SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "OCR_Segment_Correction",
    "type": "object",
    "properties": {
        "corrections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "segment_id": {"type": "string"},
                    "corrected_text": {"type": "string"},
                    "still_uncertain": {"type": "boolean"},
                    "reason": {"type": "string", "minLength": 1, "maxLength": 300},
                },
                "required": ["segment_id", "corrected_text", "still_uncertain", "reason"],
            },
        },
    },
    "required": ["corrections"],
}


@dataclass(frozen=True)
class VisionCorrectionResult:
    """1不一致セグメントに対するvision LLMの判定結果"""
    segment_id: str
    corrected_text: str
    still_uncertain: bool
    reason: str


def _build_user_prompt(segments: List[DiffSegment]) -> str:
    lines = ["このページ内で、2通りの読み取り結果が一致しなかった箇所は以下の通りです。"]
    for s in segments:
        lines.append(
            f"\n[segment_id: {s.segment_id}]\n"
            f"候補A(主文): {s.glm_text}\n"
            f"候補B(別の読み取り): {s.glm_alt_text}"
        )
    lines.append(
        "\n添付画像を根拠に、各segment_idについて正しいテキスト(corrected_text)・"
        "画像でも判定できないか(still_uncertain)・判定理由(reason)をJSON Schema通りに返してください。"
    )
    return "\n".join(lines)


def _call_vision_llm(
    image_b64: str, user_prompt: str, ollama_host: str, model: str, timeout_seconds: int
) -> str:
    try:
        response = requests.post(
            f"{ollama_host}/api/chat",
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": VISION_CORRECTION_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt, "images": [image_b64]},
                ],
                "format": CORRECTION_SCHEMA,
                "stream": False,
                # qwen3.5はデフォルトでthinkingモードが有効で、内部推論トークンが
                # num_predictを消費し尽くし最終回答(content)が空になる事例があるため無効化する
                "think": False,
                "options": {"num_ctx": DEFAULT_VISION_NUM_CTX},
            },
            timeout=timeout_seconds,
        )
        response.raise_for_status()
        return response.json()["message"]["content"]
    except requests.RequestException as e:
        logger.error(f"vision LLM呼び出し失敗 ({ollama_host}, model={model}): {e}")
        raise


def _validate_response(response_text: str) -> Dict:
    diagnosis = json.loads(response_text)
    jsonschema.validate(instance=diagnosis, schema=CORRECTION_SCHEMA)
    return diagnosis


def correct_page_with_vision_llm(
    image_path: Path,
    segments: List[DiffSegment],
    ollama_host: str,
    model: str = DEFAULT_VISION_MODEL,
    timeout_seconds: int = DEFAULT_VISION_TIMEOUT_SECONDS,
) -> List[VisionCorrectionResult]:
    """
    1ページ分の不一致セグメントを、そのページ画像1枚とあわせて1回のLLM呼び出しに
    バッチ化して判定させる（セグメント単位で毎回呼ぶとレイテンシが線形悪化するため）。

    is_match=Falseのセグメントのみ対象とする。JSON Schema検証に
    MAX_VISION_ATTEMPTS回失敗した場合は、クラッシュさせず全セグメントを
    still_uncertain=Trueとして返す（人手確認に委ねる。サイレントフォールバックでは
    なく、理由付きで明示的に「要確認」フラグを立てる）。
    """
    mismatched = [s for s in segments if not s.is_match]
    if not mismatched:
        return []

    image_b64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
    user_prompt = _build_user_prompt(mismatched)

    for attempt in range(1, MAX_VISION_ATTEMPTS + 1):
        response_text = _call_vision_llm(image_b64, user_prompt, ollama_host, model, timeout_seconds)
        try:
            parsed = _validate_response(response_text)
        except (json.JSONDecodeError, jsonschema.ValidationError) as e:
            logger.warning(
                f"vision LLM応答がJSON Schemaに適合しません (attempt {attempt}/{MAX_VISION_ATTEMPTS}): {e}"
            )
            continue

        by_id = {c["segment_id"]: c for c in parsed["corrections"]}
        results = []
        for s in mismatched:
            c = by_id.get(s.segment_id)
            if c is None:
                # LLMがこのsegment_idについて回答しなかった場合も要確認扱いにする
                results.append(VisionCorrectionResult(
                    segment_id=s.segment_id, corrected_text=s.glm_text,
                    still_uncertain=True, reason=MISSING_JUDGMENT_REASON
                ))
            else:
                results.append(VisionCorrectionResult(
                    segment_id=s.segment_id, corrected_text=c["corrected_text"],
                    still_uncertain=c["still_uncertain"],
                    # minLength:1だけではモデルが空白1文字で回避することを実機で確認した
                    # (Ollamaのpatternは400エラーで使えない)ため、空白のみのreasonは空として扱う
                    reason=c["reason"].strip()
                ))
        return results

    logger.error(
        f"vision LLM応答が{MAX_VISION_ATTEMPTS}回ともJSON Schemaに適合しませんでした"
        f"（image={image_path}）。全セグメントを要確認扱いにします。"
    )
    return [
        VisionCorrectionResult(
            segment_id=s.segment_id, corrected_text=s.glm_text,
            still_uncertain=True, reason="vision LLM応答の形式検証に失敗したため未判定"
        )
        for s in mismatched
    ]


def ocr_full_page_with_vision_llm(
    image_path: Path,
    ollama_host: str,
    model: str = DEFAULT_VISION_MODEL,
    timeout_seconds: int = DEFAULT_VISION_TIMEOUT_SECONDS,
    temperature: float = 0.0,
    seed: int = 1,
) -> Optional[str]:
    """
    ページ画像をvision LLMにそのまま渡し、JSON Schema制約無しの自由記述でMarkdown
    書き起こしをさせる。2026-09-30(12)以降、これが全ページの主文を得る標準経路
    （それ以前はGLM-OCRが打ち切られたページの最終手段だった）。

    失敗（接続エラー・空応答）した場合はNoneを返す。呼び出し側(ocr_pipeline.py)は
    これをサイレントに正としては扱わず、既存の「打ち切りマーカー」による
    要確認フラグと組み合わせて使うこと。

    temperature/seed: 2026-09-29(11)決定。GLM-OCRの結果が比較材料として
    使えない(構造が不整合)場合、この関数をもう一度異なるtemperature/seedで
    呼び出し、vision LLM自身の2回の読み取り結果同士をdiffする
    （ocr_engines.py ocr_with_glmの2回実行と同じ考え方）。
    """
    image_b64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
    try:
        response = requests.post(
            f"{ollama_host}/api/chat",
            json={
                "model": model,
                "messages": [{"role": "user", "content": FULL_PAGE_OCR_PROMPT, "images": [image_b64]}],
                "stream": False,
                "think": False,
                "options": {"num_ctx": DEFAULT_VISION_NUM_CTX, "temperature": temperature, "seed": seed},
            },
            timeout=timeout_seconds,
        )
        response.raise_for_status()
        text = response.json()["message"]["content"].strip()
        return text or None
    except requests.RequestException as e:
        logger.error(f"vision LLMによる代替OCR呼び出し失敗 ({ollama_host}, model={model}, image={image_path}): {e}")
        return None


def verify_full_page_ocr_with_vision_llm(
    image_path: Path,
    ocr_text: str,
    ollama_host: str,
    model: str = DEFAULT_VISION_MODEL,
    timeout_seconds: int = DEFAULT_VISION_TIMEOUT_SECONDS,
) -> Tuple[bool, str, str]:
    """
    ocr_full_page_with_vision_llm()の書き起こし結果を、同じ画像と再度照合させて
    検証する。corrected_textも同時に取得することで、呼び出し側(ocr_pipeline.py)が
    ocr_text/corrected_textを既存のdiff_page()+セグメント単位補正にそのまま
    通せるようにする（2026-09-29(7)決定）。matches_image=Falseの場合でも
    ページ全体をneeds_review扱いにせず、実際に食い違った箇所だけを特定できる
    （ページ単位で一律要確認にすると、正しく読めている大部分まで巻き込んで
    目視確認の手間が減らないという実機フィードバックへの対処）。

    JSON Schema検証に失敗・接続失敗した場合は、corrected_text=ocr_textを返し、
    呼び出し側がページ全体を要確認扱いにできるようにする（保守的に倒す）。

    Returns:
        (matches_image, corrected_text, reason)
    """
    image_b64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
    user_prompt = f"書き起こしテキスト:\n{ocr_text}\n\n添付画像と照合し、JSON Schema通りに回答してください。"

    for attempt in range(1, MAX_VISION_ATTEMPTS + 1):
        try:
            response = requests.post(
                f"{ollama_host}/api/chat",
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": FULL_PAGE_OCR_VERIFY_SYSTEM_PROMPT},
                        {"role": "user", "content": user_prompt, "images": [image_b64]},
                    ],
                    "format": FULL_PAGE_OCR_VERIFY_SCHEMA,
                    "stream": False,
                    "think": False,
                    "options": {"num_ctx": DEFAULT_VISION_NUM_CTX},
                },
                timeout=timeout_seconds,
            )
            response.raise_for_status()
            parsed = json.loads(response.json()["message"]["content"])
            jsonschema.validate(instance=parsed, schema=FULL_PAGE_OCR_VERIFY_SCHEMA)
            return bool(parsed["matches_image"]), parsed["corrected_text"], parsed["reason"].strip()
        except requests.RequestException as e:
            logger.error(f"vision LLMによるOCR検証呼び出し失敗 ({ollama_host}, model={model}, image={image_path}): {e}")
            return False, ocr_text, "vision LLMへの接続に失敗したため検証できませんでした"
        except (json.JSONDecodeError, jsonschema.ValidationError, KeyError) as e:
            logger.warning(
                f"vision LLMによるOCR検証応答がJSON Schemaに適合しません (attempt {attempt}/{MAX_VISION_ATTEMPTS}): {e}"
            )
            continue

    logger.error(f"vision LLMによるOCR検証が{MAX_VISION_ATTEMPTS}回とも失敗しました（image={image_path}）。要確認のまま残します。")
    return False, ocr_text, "vision LLM応答の形式検証に失敗したため未検証"
