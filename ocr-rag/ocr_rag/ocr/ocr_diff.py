"""
OCR結果2通り(主文候補と比較候補)のdiff比較（低信頼度検出）

2026-09-30(12)決定: 主文はGLM-OCRからvision LLMに切り替わり、比較候補はGLM-OCR
(または主文と別条件で再実行したvision LLM)になった。DiffSegmentのglm_text/
glm_alt_textは旧方式(GLM-OCR 2回実行)時代の名前で、現在の意味は
glm_text=主文候補・glm_alt_text=比較候補（保存済みdraft(JSONB)・フロント型との
互換のためキー名は変えていない）。以下の経緯の記述はGLM-OCR 2回実行時代のもの。

2026-09-29(3)決定: 低信頼度検出は当初tesseract(比較専用の補助信号)との
diffで行っていたが、実マニュアルで検証したところtesseractの日本語認識精度が
低く、GLM-OCRが正しく読めている箇所まで「tesseractと食い違う」という理由で
軒並み要確認扱いになってしまう問題が判明した（ユーザーが実際に試して確認）。
そのため、tesseractとの比較をやめ、GLM-OCR自体を異なるtemperature/seedで
2回走らせてその2回分をdiffする方式に変更した。1回目(主文候補)は
ocr_pipeline.pyでtemperature=0のまま、2回目はtemperature>0で
呼び出すことで、モデルが確信を持って読めている箇所は2回とも同じ結果になり、
自信の無い箇所ほど揺らいで差分として検出されることを期待する設計。

2026-09-29(2)決定: 当初は行単位でdiffしていたが、GLM-OCRの整形済みMarkdown
（段落・見出し単位で改行）は実行のたびに改行位置が微妙に変わりうるため、
行単位で比較すると改行位置のズレだけで大きな不一致ブロックになってしまい、
「間違った箇所だけ抜粋する」という目的を果たせなかった。そのため単語単位の
diffに変更し、実際に食い違っている数単語だけを小さく抜粋できるようにした。

単語のオフセット（元テキスト内の開始・終了位置）を保持し、各セグメントの
glm_text/glm_alt_textは元テキストの部分文字列（装飾込み、単語間の空白・改行も
含む）をそのまま切り出す。これにより、is_match/needs_reviewのセグメントの
final_textをそのまま順番に連結するだけで、元のGLM-OCR出力の見た目（改行・
インデント等）を損なわずに再構成できる（ocr_pipeline.py参照）。
"""
import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import List, Sequence, Tuple

_LEADING_MARKDOWN_MARKS = re.compile(r'^[#>*_\-\s]+')
_WHITESPACE = re.compile(r'\s+')
_WORD_PATTERN = re.compile(r'\S+')
# 目次・表の点線(「…………」。NFKCで「...」の連なりになる)。内容を持たず、長さも読み取りのたびに変わるため、類似度の比較から外す
_LEADER_DOTS = re.compile(r'\.{2,}')


@dataclass(frozen=True)
class DiffSegment:
    """
    ページ内の1差分区間（一致 or 不一致）。glm_text/glm_alt_textは元の表記のまま保持する。
    glm_text: 主文候補(vision LLM、temperature=0)の該当箇所
    glm_alt_text: 比較候補(GLM-OCR、または主文と別条件のvision LLM再実行)の該当箇所
    """
    segment_id: str
    glm_text: str
    glm_alt_text: str
    is_match: bool


def normalize_for_diff(text: str) -> str:
    """
    比較用にテキストを正規化する。
    - Unicode正規化(NFKC): 全角半角混在等を吸収
    - 行頭のMarkdown構造記号(#, >, *, _, -)を除去
    - セル区切り`|`はスペースに置換してから連続空白を1つに畳む
    """
    normalized = unicodedata.normalize("NFKC", text)
    normalized = _LEADING_MARKDOWN_MARKS.sub('', normalized)
    normalized = normalized.replace('|', ' ')
    return _WHITESPACE.sub(' ', normalized).strip()


def candidate_similarity(text: str, candidates: Sequence[str]) -> float:
    """
    textが、candidatesのうち最も近いものにどれだけ似ているか(0.0〜1.0。1.0は、正規化すると同じ)。
    補正LLMの出力が、主文・比較候補を土台にした修正なのか、候補と無関係な文字列(文字化け・幻覚)なのかを
    見分けるために使う(ocr_pipeline.MIN_CORRECTION_SIMILARITY)。

    比較は、normalize_for_diffに加えて、空白・改行と、点線(「…………」)を全て除いた文字列で行う。LLMは、候補を写すときに
    改行・空白の位置を変えることがあり、それを違いとして数えないため。点線は、内容を持たないのに、候補と文字化けの
    両方に長く入っていると、類似度を押し上げてしまう(実機の資料の表は、点線で項目と内容をつないでいる)。
    """
    def squash(value: str) -> str:
        return _WHITESPACE.sub('', _LEADER_DOTS.sub('', normalize_for_diff(value)))

    target = squash(text)
    return max(
        (SequenceMatcher(None, target, squash(candidate), autojunk=False).ratio() for candidate in candidates),
        default=0.0,
    )


def _tokenize_with_spans(text: str) -> List[Tuple[str, int, int]]:
    """
    (正規化済みトークン, 開始位置, 終了位置) のリストを返す。

    記号のみで正規化結果が空文字列になるトークン(表の罫線・パイプ`|`等)は
    単独の比較対象にせず、隣接する実トークンの範囲に吸収する（そうしないと、
    2回の生成で表組みの罫線位置が微妙に変わっただけで誤検出になってしまうため）。

    終了位置は次の実トークン開始位置（無ければ文字列末尾）まで拡張し、トークン間の
    空白・改行・記号も含める。こうすることで、各セグメントのtext[start:end]を
    順番に連結するだけで元テキストを過不足なく再構成できる。
    """
    matches = list(_WORD_PATTERN.finditer(text))
    if not matches:
        return []

    spans: List[Tuple[str, int, int]] = []
    carry_start = 0
    for i, m in enumerate(matches):
        normalized = normalize_for_diff(m.group())
        next_start = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        if not normalized:
            continue  # 記号のみのトークンは吸収するだけで、それ自体はセグメント化しない
        spans.append((normalized, carry_start, next_start))
        carry_start = next_start

    if spans:
        # 末尾が記号のみのトークンで終わる場合、吸収先が無いまま取りこぼされないよう
        # 最後の実トークンの範囲を文字列末尾まで延長する
        last_norm, last_start, _ = spans[-1]
        spans[-1] = (last_norm, last_start, len(text))

    return spans


def diff_page(glm_text: str, glm_alt_text: str) -> List[DiffSegment]:
    """
    ページ単位で主文候補と比較候補を単語単位でdiffし、DiffSegmentのリストを返す。
    比較は正規化済みトークンで行うが、各セグメントのglm_text/glm_alt_textは
    元テキストの部分文字列（装飾・空白込み）をそのまま切り出す。
    """
    glm_tokens = _tokenize_with_spans(glm_text)
    alt_tokens = _tokenize_with_spans(glm_alt_text)
    glm_norm_seq = [t[0] for t in glm_tokens]
    alt_norm_seq = [t[0] for t in alt_tokens]

    matcher = SequenceMatcher(a=glm_norm_seq, b=alt_norm_seq, autojunk=False)

    segments = []
    for idx, (tag, i1, i2, j1, j2) in enumerate(matcher.get_opcodes()):
        glm_excerpt = glm_text[glm_tokens[i1][1]:glm_tokens[i2 - 1][2]] if i2 > i1 else ""
        alt_excerpt = glm_alt_text[alt_tokens[j1][1]:alt_tokens[j2 - 1][2]] if j2 > j1 else ""

        segments.append(
            DiffSegment(
                segment_id=f"seg-{idx}",
                glm_text=glm_excerpt,
                glm_alt_text=alt_excerpt,
                is_match=(tag == "equal"),
            )
        )
    return segments
