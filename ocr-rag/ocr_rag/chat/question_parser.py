"""
チャットの質問文の解析

DB・LLMに依存しない純粋関数（単体テストしやすいよう、チャットサービスから分けている）。
意図の判定に追加のLLM呼び出しは使わない。bge-m3とqwen3.5:9bはVRAM上で入れ替わり合うため、
呼び出しを増やすと待ち時間が悪化する。判定できなければNoneを返し、呼び出し側は
通常の検索として続ける（誤った絞り込みで該当する資料を落とすより安全）。
"""
import re
import unicodedata
from typing import Dict, List, Optional, Tuple

# マニュアル自体の有無・内容を直接尋ねる質問のキーワード
_MANUAL_REQUEST_KEYWORDS = ('マニュアル', '取説', '取扱説明書', '説明書')

# resolve_equipment_nameの前方一致用: 質問文から、タグ名に使われやすい型番・コード的な英数字トークンを抜き出す
# （例:「AHUの調子は？」から「AHU」）
_EQUIPMENT_NAME_TOKEN_PATTERN = re.compile(r'[A-Za-z0-9][A-Za-z0-9\-]*')

# 前方一致で許す最短のトークン長。1〜2文字（例:「1」「R」）まで許すと、無関係なタグ名まで拾う
_EQUIPMENT_NAME_PREFIX_MIN_LEN = 3


def is_manual_request(question: str) -> bool:
    """
    質問文が、マニュアルそのものの有無・表示を直接尋ねているか

    「マニュアルを見せて」「取説はある？」のような質問は、文面と資料本文（技術的な説明や表）の
    意味の近さが低くなりやすい。類似度で足切りすると、資料が登録済みでも0件になり
    「記載がありません」と誤答するため、呼び出し側はこの場合だけ足切りを外す。
    """
    return any(keyword in question for keyword in _MANUAL_REQUEST_KEYWORDS)


def _normalize(text: str) -> str:
    """全角半角・大文字小文字の違いを無くす（「ＥＳＰ－１」「esp-1」を「ESP-1」と同じに扱うため）"""
    return unicodedata.normalize('NFKC', text).casefold()


def _is_ascii_alnum(char: str) -> bool:
    return char.isascii() and char.isalnum()


def _mention_spans(name: str, question: str) -> List[Tuple[int, int]]:
    """
    正規化済みの質問文のうち、正規化済みの名前が言及されている範囲（開始, 終了）を全て返す

    名前の端が英数字のとき、その外側も英数字なら、別の語の一部とみなして言及に数えない
    （タグ「A」が「AI」に、「ESP-1」が「ESP-10」に当たらないようにする）。
    日本語など、英数字でない端は、単語の区切りが無いため、そのまま部分一致で扱う。
    """
    spans = []
    start = question.find(name)
    while start != -1:
        end = start + len(name)
        starts_inside_word = _is_ascii_alnum(name[0]) and start > 0 and _is_ascii_alnum(question[start - 1])
        ends_inside_word = _is_ascii_alnum(name[-1]) and end < len(question) and _is_ascii_alnum(question[end])
        if not (starts_inside_word or ends_inside_word):
            spans.append((start, end))
        start = question.find(name, start + 1)
    return spans


def _exact_mentions(question: str, candidate_names: List[str]) -> List[str]:
    """質問文に、名前そのものが書かれている候補（より長い名前の一部としてだけ出てくるものは除く）"""
    normalized_question = _normalize(question)
    spans_by_name: Dict[str, List[Tuple[int, int]]] = {}
    for name in dict.fromkeys(candidate_names):
        normalized_name = _normalize(name)
        if not normalized_name.strip():
            continue
        spans = _mention_spans(normalized_name, normalized_question)
        if spans:
            spans_by_name[name] = spans

    def inside_longer_mention(name: str, span: Tuple[int, int]) -> bool:
        # 例:「ESP-1.1」の中の「ESP-1」。同じ範囲どうし（正規化で同じになる別名）は、互いに除かない
        return any(
            other != name and other_span != span and other_span[0] <= span[0] and span[1] <= other_span[1]
            for other, other_spans in spans_by_name.items() for other_span in other_spans
        )

    return [
        name for name, spans in spans_by_name.items()
        if any(not inside_longer_mention(name, span) for span in spans)
    ]


def _prefix_mentions(question: str, candidate_names: List[str]) -> List[str]:
    """質問文中の英数字のトークン（3文字以上）が、前方一致になる候補（例:「AHUの調子は？」→「AHU-1」）"""
    tokens = {
        token for token in _EQUIPMENT_NAME_TOKEN_PATTERN.findall(_normalize(question))
        if len(token) >= _EQUIPMENT_NAME_PREFIX_MIN_LEN
    }
    return [
        name for name in dict.fromkeys(candidate_names)
        if name and any(_normalize(name).startswith(token) for token in tokens)
    ]


def resolve_equipment_name(question: str, candidate_names: List[str]) -> Optional[str]:
    """
    質問文から、タグ名（例: "ESP-1"）を1つに特定する

    candidate_namesは、登録済みのタグ名（r_manual_document_equipment.equipment_name）。
    質問文に書かれている名前が1つだけならそれを返す。複数書かれているときは特定できないとして
    Noneを返す（絞り込めなければ、タグ名なしの検索で続けられるため、聞き返さない）。
    全角半角・大文字小文字は区別しない。「A」が「AI」の一部に当たるような、
    別の語の一部としての出現は、書かれているとは数えない（_mention_spans参照）。

    名前が書かれていないときは、質問文中の英数字のトークンが、候補名の前方一致になっているかで補う
    （例:「AHUの調子は？」→「AHU-1」）。前方一致でも、複数の候補に当たるとき
    （例:「OHU」→「OHU-1」と「OHU-1.1」）はNoneを返す。

    Args:
        question: 質問文
        candidate_names: タグ名の候補（空文字列は無視する）

    Returns:
        一意に特定できたタグ名。0件または複数件に当たるときはNone
    """
    mentioned = _exact_mentions(question, candidate_names)
    if len(mentioned) == 1:
        return mentioned[0]
    if mentioned:
        return None

    prefix_matched = _prefix_mentions(question, candidate_names)
    return prefix_matched[0] if len(prefix_matched) == 1 else None


def find_mentioned_equipment_names(question: str, candidate_names: List[str]) -> List[str]:
    """
    質問文で言及されているタグ名を、全て返す（resolve_equipment_nameと違い、複数あっても全部返す）

    絞り込みには1つに決める必要があるが、「そのタグが付いた資料を探したい」質問では、
    複数のタグ名が挙がっていても、それぞれの資料が対象になるため。
    書かれている名前が無いときは、前方一致した候補（resolve_equipment_nameと同じ補い方）を返す。
    """
    return _exact_mentions(question, candidate_names) or _prefix_mentions(question, candidate_names)
