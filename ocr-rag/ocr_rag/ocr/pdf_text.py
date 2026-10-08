"""
PDFのテキスト層(文字として埋め込まれた文字列)の取り出しと、照合

依存: poppler-utils(pdftotext)。pdf_images.py(pdftoppm)と同じパッケージで、ocr-ragコンテナのイメージ
(ocr-rag/Dockerfile)に同梱している。

用途は、OCRの補正が「PDFにそう書かれているか」の確認だけ。OCRの結果の代わりには使わない。
画像を含むデジタルPDFでは、図の外の文字は、テキスト層にある(OCRのように読み間違えない)。
スキャンしたPDF(ページ全体が画像)には、テキスト層が無いため、この確認は行わない。
過去にOCRをかけて文字を埋め込んだPDFなど、テキスト層自体が誤っていることもある(その場合は、誤りを確認してしまう)。
"""
import logging
import re
import shutil
import subprocess
import unicodedata
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)

# ページの文字数(空白を除く)がこれ未満なら、そのページにはテキスト層が無いとみなす(スキャン・図だけのページ)
TEXT_LAYER_MIN_CHARS = 20

# 照合する文字列(空白・記号を除いた長さ)の下限。短い文字列は、ページのどこにでも見つかるため、根拠にしない
MIN_SEARCH_CHARS = 3

_PAGE_SEPARATOR = "\f"
# 照合で無視する、Markdownの記号(表の罫線・強調・見出し・引用・コード)。テキスト層には無いため
_MARKDOWN_MARKS = re.compile(r"[|*_`#>~]")
# 目次・表の点線(NFKCで「...」の連なりになる)。長さが読み取りのたびに変わり、内容を持たない
_LEADER_DOTS = re.compile(r"\.{2,}")
_WHITESPACE = re.compile(r"\s+")


def squash_for_search(text: str) -> str:
    """照合用に、全角半角(NFKC)・空白・改行・Markdownの記号・点線の違いを無くす"""
    normalized = unicodedata.normalize("NFKC", text)
    normalized = _MARKDOWN_MARKS.sub("", normalized)
    normalized = _LEADER_DOTS.sub("", normalized)
    return _WHITESPACE.sub("", normalized)


def has_text_layer(squashed_page_text: str) -> bool:
    """squash_for_searchを通したページの文字列に、テキスト層があるとみなせる量の文字があるか"""
    return len(squashed_page_text) >= TEXT_LAYER_MIN_CHARS


def appears_in_page(squashed_page_text: str, needle: str) -> Optional[bool]:
    """
    needleが、ページのテキスト層にあるか。短すぎて判断できない(根拠にならない)ときは None。
    squashed_page_textは、squash_for_searchを通したもの(ページごとに1回だけ通せばよい)。
    """
    target = squash_for_search(needle)
    if len(target) < MIN_SEARCH_CHARS:
        return None
    return target in squashed_page_text


def extract_page_texts(pdf_path: Path, password: Optional[str] = None) -> Optional[List[str]]:
    """
    pdftotextで、PDFの各ページのテキスト層を、ページ順のリストで返す(テキスト層が無いページは、空に近い文字列)。
    取り出せなかったとき(pdftotextが無い・PDFが読めない)は、None。OCR自体は止めず、警告をログに残して、
    テキスト層との照合だけを省く(この確認は、OCRに必須ではないため)。
    """
    if shutil.which("pdftotext") is None:
        logger.warning("pdftotextが見つからないため、PDFのテキスト層との照合を省きます(poppler-utilsが未導入)")
        return None

    command = ["pdftotext", "-enc", "UTF-8"]
    if password:
        # pdf_images.pyと同じく、ユーザーパスワード・オーナーパスワードの両方に同じ値を渡す
        command += ["-upw", password, "-opw", password]
    command += [str(pdf_path), "-"]

    try:
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    except OSError as e:
        logger.warning(f"pdftotextを実行できないため、PDFのテキスト層との照合を省きます: {e}")
        return None
    if result.returncode != 0:
        logger.warning(
            f"pdftotextに失敗したため、PDFのテキスト層との照合を省きます(PDF: {pdf_path.name}): {result.stderr.strip()}"
        )
        return None

    pages = result.stdout.split(_PAGE_SEPARATOR)
    if pages and pages[-1] == "":
        pages.pop()  # pdftotextは、最後のページの後ろにも、ページ区切りを付ける(その後ろの空の要素を除く)
    return pages
