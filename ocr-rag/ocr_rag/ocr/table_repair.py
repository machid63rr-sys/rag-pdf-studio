"""
OCR結果中のMarkdown表の構造崩れを、内容を失わずに修復する

vision LLMは同じページでも実行ごとに表の書き方が揺れ、GFM(Markdownの表記法)が
「表」と認識できない形で出力することがある。表と認識されないと、画面の書式付き
エディタでは `| a | b |` というパイプ付きの生テキストとして表示されてしまう
（2026-10-05、実際のOCR下書き5件中3件で発生）。実データで確認した崩れ方は次の2種類:

1. ヘッダ行の末尾に区切り行の断片(`:---`, `:`, 空)が混入し、区切り行より列数が多い
   例: `| 表示 | 名称 | :--- | :--- | : |` + `| --- | --- |`
2. ヘッダ行と区切り行の間に、表の外にあるはずの注記行が割り込んでいる
   例: `※お知らせは…です。 |` (行頭に`|`が無く、行末だけ`|`)

修復方針（いずれも元の文言を1文字も捨てない。捨てると無言のデータ欠落になるため）:
- 区切り行より多い列が断片(空・`:---`等)だけなら、その断片を取り除く
- 区切り行より多い列に文言があるなら、文言を残して区切り行の列数を広げる
- 割り込んだ注記行は、行末の`|`だけ取って表の直後(空行を挟んで)へ移す

上記以外の崩れ（セル結合を無理に書いた複数行セル等）は修復せず、そのまま残す。
残った箇所は、画面(Step3)側が「表として解釈できない」旨を警告する。
すでに表として成立している表は1文字も変更しない。
"""
import re
from typing import List, Optional, Tuple

_FENCE_LINE = re.compile(r"^\s{0,3}(```|~~~)")
# GFMの区切り行のセル: `---` / `:---` / `---:` / `:---:`
_DELIMITER_CELL = re.compile(r"^:?-+:?$")
# 区切り行の断片とみなせるセル: 空 / `:` / `-` / `:---` など（文言を含まない）
_JUNK_CELL = re.compile(r"^:?-*:?$")
# `\|`(エスケープされたパイプ)ではセルを分割しない
_CELL_SEPARATOR = re.compile(r"(?<!\\)\|")


def _starts_table(line: str) -> bool:
    return line.strip().startswith("|")


def _split_cells(line: str) -> List[str]:
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|") and not body.endswith("\\|"):
        body = body[:-1]
    return [cell.strip() for cell in _CELL_SEPARATOR.split(body)]


def _is_delimiter_row(line: str) -> bool:
    if not _starts_table(line):
        return False
    return all(_DELIMITER_CELL.match(cell) for cell in _split_cells(line))


def _join_cells(cells: List[str]) -> str:
    return "| " + " | ".join(cells) + " |"


def _is_wedged_note(line: str) -> bool:
    """表の外にあるはずなのに、行末だけ`|`で終わっている注記行（ヘッダと区切り行の間への割り込み）"""
    stripped = line.strip()
    return (
        bool(stripped)
        and not _starts_table(line)
        and stripped.endswith("|")
        and not _FENCE_LINE.match(line)
    )


def _find_delimiter_index(lines: List[str], header_index: int) -> Optional[int]:
    """ヘッダ候補の次(割り込み注記行を挟んでもよい)にある区切り行の位置。無ければNone"""
    index = header_index + 1
    while index < len(lines) and _is_wedged_note(lines[index]):
        index += 1
    if index < len(lines) and _is_delimiter_row(lines[index]):
        return index
    return None


def _repair_header_and_delimiter(header: str, delimiter: str) -> Tuple[str, str]:
    """区切り行の列数と食い違うヘッダ行を、文言を捨てずに揃える（揃えられない場合は変更しない）"""
    header_cells = _split_cells(header)
    delimiter_cells = _split_cells(delimiter)
    column_count = len(delimiter_cells)

    if len(header_cells) <= column_count:
        # 一致していれば修復不要。ヘッダの方が短い崩れは、どちらが正しいか判断できないため扱わない
        return header, delimiter

    while len(header_cells) > column_count and _JUNK_CELL.match(header_cells[-1]):
        header_cells.pop()

    if len(header_cells) == column_count:
        return _join_cells(header_cells), delimiter

    # はみ出した列に文言がある: 文言を残すため区切り行を広げる
    widened = delimiter_cells + ["---"] * (len(header_cells) - column_count)
    return _join_cells(header_cells), _join_cells(widened)


def repair_markdown_tables(text: str) -> str:
    lines = text.split("\n")
    repaired: List[str] = []
    fence_marker: Optional[str] = None
    index = 0

    while index < len(lines):
        line = lines[index]

        fence_match = _FENCE_LINE.match(line)
        if fence_match:
            if fence_marker is None:
                fence_marker = fence_match.group(1)
            elif fence_match.group(1) == fence_marker:
                fence_marker = None
            repaired.append(line)
            index += 1
            continue

        # 表の先頭行(直前が表行でない)だけをヘッダ候補にする。表の途中の行を
        # ヘッダと取り違えて、既存の表を分割してしまわないため
        is_header_candidate = (
            fence_marker is None
            and _starts_table(line)
            and not _is_delimiter_row(line)
            and (index == 0 or not _starts_table(lines[index - 1]))
        )
        delimiter_index = _find_delimiter_index(lines, index) if is_header_candidate else None
        if delimiter_index is None:
            repaired.append(line)
            index += 1
            continue

        body_end = delimiter_index + 1
        while body_end < len(lines) and _starts_table(lines[body_end]):
            body_end += 1

        header, delimiter = _repair_header_and_delimiter(line, lines[delimiter_index])
        wedged_notes = [note.strip().rstrip("|").rstrip() for note in lines[index + 1:delimiter_index]]

        repaired.append(header)
        repaired.append(delimiter)
        repaired.extend(lines[delimiter_index + 1:body_end])
        if wedged_notes:
            # GFMでは表の直後の文章行は表の行として取り込まれるため、空行を挟んで表の外へ出す
            repaired.append("")
            repaired.extend(wedged_notes)
            if body_end < len(lines) and lines[body_end].strip():
                repaired.append("")
        index = body_end

    return "\n".join(repaired)
