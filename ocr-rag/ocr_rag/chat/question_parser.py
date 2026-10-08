"""
チャットの質問文の解析

DB・LLMに依存しない純粋関数（単体テストしやすいよう、チャットサービスから分けている）。
意図の判定に追加のLLM呼び出しは使わない。bge-m3とqwen3.5:9bはVRAM上で入れ替わり合うため、
呼び出しを増やすと待ち時間が悪化する。判定できなければNoneを返し、呼び出し側は
通常の検索として続ける（誤った絞り込みで該当する資料を落とすより安全）。
"""
import re
from typing import List, Optional

# マニュアル自体の有無・内容を直接尋ねる質問のキーワード
_MANUAL_REQUEST_KEYWORDS = ('マニュアル', '取説', '取扱説明書', '説明書')

# resolve_equipment_nameの前方一致用: 質問文から機器コード的な英数字トークンを抜き出す
# （例:「AHUの調子は？」から「AHU」）
_EQUIPMENT_NAME_TOKEN_PATTERN = re.compile(r'[A-Za-z0-9][A-Za-z0-9\-]*')

# 前方一致で許す最短のトークン長。1〜2文字（例:「1」「R」）まで許すと、無関係な機器名まで拾う
_EQUIPMENT_NAME_PREFIX_MIN_LEN = 3


def is_manual_request(question: str) -> bool:
    """
    質問文が、マニュアルそのものの有無・表示を直接尋ねているか

    「マニュアルを見せて」「取説はある？」のような質問は、文面と資料本文（技術的な説明や表）の
    意味の近さが低くなりやすい。類似度で足切りすると、資料が登録済みでも0件になり
    「記載がありません」と誤答するため、呼び出し側はこの場合だけ足切りを外す。
    """
    return any(keyword in question for keyword in _MANUAL_REQUEST_KEYWORDS)


def resolve_equipment_name(question: str, candidate_names: List[str]) -> Optional[str]:
    """
    質問文から、機器名（例: "ESP-1"）を1つに特定する

    candidate_namesは、登録済みの機器名（r_manual_document_equipment.equipment_name）。
    質問文に完全に含まれる名前が1つだけならそれを返す。複数含まれるときは特定できないとして
    Noneを返す（絞り込めなければ、機器名なしの検索で続けられるため、聞き返さない）。

    完全一致が無いときは、質問文中の英数字のトークンが、候補名の前方一致になっているかで補う
    （例:「AHUの調子は？」→「AHU-1」）。前方一致でも、複数の候補に当たるとき
    （例:「OHU」→「OHU-1」と「OHU-1.1」）はNoneを返す。

    Args:
        question: 質問文
        candidate_names: 機器名の候補（空文字列は無視する）

    Returns:
        一意に特定できた機器名。0件または複数件に当たるときはNone
    """
    matched = {name for name in candidate_names if name and name in question}
    if len(matched) == 1:
        return next(iter(matched))
    if matched:
        return None

    tokens = {
        token for token in _EQUIPMENT_NAME_TOKEN_PATTERN.findall(question)
        if len(token) >= _EQUIPMENT_NAME_PREFIX_MIN_LEN
    }
    prefix_matched = {
        name for name in candidate_names
        if name and any(name.upper().startswith(token.upper()) for token in tokens)
    }
    return next(iter(prefix_matched)) if len(prefix_matched) == 1 else None
