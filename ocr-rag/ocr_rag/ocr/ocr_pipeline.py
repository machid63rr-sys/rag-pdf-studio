"""
vision LLM(主文) + GLM-OCR(比較) + diff + vision補正の全体オーケストレーション

ページ単位で以下を行い、下書きMarkdown（draft_markdown）とフロントの差分ハイライト
プレビュー用データ（diff_segments）を組み立てる:
1. vision LLM(既定qwen3.5:9b)でフルページOCRする（temperature=0、これが主文）
2. GLM-OCRを1回実行する（比較候補。別モデルなので同じ誤りを共有しにくい）
3. 正規化してdiff（低信頼度箇所検出）
4. 不一致セグメントのあるページのみ、画像+両候補をvision LLMにまとめて渡し判定
5. 自動修正(status=auto_corrected)/要確認(status=needs_review)/一致(status=match)を
   組み立て、最終的なdraft_markdownは主文(vision LLM)をベースに自動修正箇所だけ
   置換する。still_uncertain=Trueの箇所はLLMの提案を採用せず主文を暫定採用する
   （画像を見ても判定できない=信頼できる根拠が無い、ため保守的に倒す）。
   LLMの提案が、主文・比較候補のどちらとも大きく異なる(類似度が低い)場合も、文字化けの恐れが
   高いため採用せず、主文を残して要確認にする（MIN_CORRECTION_SIMILARITY参照）。
6. 補正が主文を書き換えた箇所を、別の根拠で再チェックする(correction_recheck.py)。PDFのテキスト層
   (文字として埋め込まれた文字列)に、補正後・主文のどちらの表記があるかを照合し、無い・決められない箇所は、
   前後の文脈つきで、日本語として正しいのはどちらかを(画像を使わず)LLMに判定させる。
   補正後より主文が正しいと確認できたら、補正を取り消して主文に戻す(補正LLMが、弱い方の候補で、
   正しい主文を上書きする誤りへの対処。2026-10-08)。

失敗時の扱い（サイレントに正としない）:
- vision LLMのフルページOCR自体が失敗した場合のみ、GLM-OCRを暫定の主文とし、
  ページ全体を要確認扱いにする。
- GLM-OCRが使えない・構造が壊れている場合（補正LLMが確定できない要確認セグメントが
  多い場合を含む）は、vision LLMを別条件(temperature/seed)で再実行した結果と比較する
  （自己比較。MAX_UNRESOLVED_SEGMENTS_FOR_PARTIAL_DIFF参照）。
- OCR結果の入口(normalize_ocr_markup)で、文言を捨てない範囲の表の修復を行う
  （table_repair.py参照）。直せない表は画面側で警告する。

セグメントのglm_text/glm_alt_textキーは旧方式(GLM-OCR 2回実行)時代の名前で、
現在の意味は glm_text=主文候補(vision LLM)、glm_alt_text=比較候補 である
（保存済みdraft(JSONB)・フロント型との互換のためキー名は変えていない）。

モデル名は呼び出し側(ocr_rag/api/ocr_drafts.py)が設定(ocr_rag/config.py)から渡す。
環境変数OCR_VISION_MODEL(主文) / OCR_MODEL(比較のGLM-OCR)で、コード変更なしで
差し替え可能。

各決定に至った経緯（実機検証の記録）は docs/ocr-design-history.md を参照。
"""
import logging
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional

from ocr_rag.ocr.correction_recheck import BASIS_TEXT_LAYER, RecheckItem, recheck_corrections
from ocr_rag.ocr.ocr_diff import DiffSegment, candidate_similarity, diff_page
from ocr_rag.ocr.ocr_engines import DEFAULT_GLM_OCR_MODEL, ocr_with_glm
from ocr_rag.ocr.pdf_images import convert_pdf_to_images
from ocr_rag.ocr.pdf_text import extract_page_texts, has_text_layer, squash_for_search
from ocr_rag.ocr.table_repair import repair_markdown_tables
from ocr_rag.ocr.vision_correction import (
    DEFAULT_VISION_MODEL,
    VisionCorrectionResult,
    correct_page_with_vision_llm,
    ocr_full_page_with_vision_llm,
    verify_full_page_ocr_with_vision_llm,
)

logger = logging.getLogger(__name__)

# 2026-09-29(11): GLM-OCR部分応答とのdiffで、補正LLMが判定を確定できず要確認になった
# セグメント(判定漏れ・判定不能・補正テキストが空)がこの件数を超えた場合、比較材料の
# 構造が壊れている(表の途中で打ち切られた等)兆候とみなし、vision LLMの自己比較に
# フォールバックする。実機検証で、正常に機能したケース(文章ページ)は1件、構造が壊れた
# ケース(表ページ)は8件だったため、その中間に設定。
# 2026-09-30(13): 当初は「判定漏れ」だけを数えていたが、補正LLMが判定漏れではなく
# 「判定不能+補正テキスト空」で返す壊れ方をすると検知をすり抜け、壊れた比較結果が
# そのまま採用され要確認が大量に出た(実機ドラフトで9件)ため、数え方を要確認全般に広げた
MAX_UNRESOLVED_SEGMENTS_FOR_PARTIAL_DIFF = 3

# 2026-10-08: 補正LLMの提案を採用してよい、候補(主文・比較候補)との類似度の下限(0〜1)。
# 画像入りのPDF(図・吹き出しのあるページ)で、補正LLMが、主文では正しく読めていた箇所を、候補と無関係な
# 文字化け(「①〜の損傷…〜を取り替える」のような正しい行→「©ネルeリ角 …」のような無関係な文字列)に置き換え、
# 本文から正しい内容が消える不具合を、実機の下書き3件(図・吹き出しのあるPDFと、文字だけの表のPDF)で確認した。
# その下書きの自動修正10件で、最も近い候補との類似度(ocr_diff.candidate_similarity)は、文字化けした3件が0.03〜0.17、
# それ以外(1字の直し・空白や改行の違い・吹き出しの文字の結合)が0.78以上と、はっきり分かれたため、中間の0.6にした。
# 10件だけの実測なので、実PDFを増やして、誤って止めている(正しい補正が要確認に回る)例が無いか、確認すること。
# 下回った場合は、提案を採用せず主文を残し、要確認にする(still_uncertainと同じ扱い)。
# 限界: 弱い方の候補をそのまま選ぶ誤り(類似度1.0)は、これでは防げない。
MIN_CORRECTION_SIMILARITY = 0.6

# 補正案を、要確認の理由に示すときの最大文字数(文字化けが長くても、画面の判定理由を埋めないため)
_MAX_PROPOSAL_CHARS_IN_REASON = 60

# 補正の再チェック(correction_recheck.py)で、日本語として正しいかの判断に使う、補正箇所の前後の文字数
_RECHECK_CONTEXT_CHARS = 40

# vision LLMを自己比較のため2回目に呼び出す際のパラメータ。1回目(temperature=0、決定的)と
# 異なる値にしないと毎回同一出力になりdiffが機能しない
VISION_ALT_TEMPERATURE = 0.5
VISION_ALT_SEED = 99

# 2026-09-30: OCR(特にMarkdown表)は、セル内の改行をHTMLの<br>タグで、空白を&nbsp;で、
# 丸数字(①等)をLaTeXの$\\textcircled{1}$で出力することがある。人手確認済みの既存マニュアル
# (data/manuals/*.md)はこれらを含まない素の日本語テキストで、画面のMarkdown表示は生のHTMLや
# LaTeXを描画しないため文字のまま見えてしまう。また片方の候補にだけあると差分の食い違いとして
# 誤検出される（実機ドラフトで確認）。そのためOCR結果の入口で素のテキストに揃える。
# <br>は空白1つに置換する（文の区切りは句読点・？等が担うため内容は失われない）
_HTML_LINE_BREAK = re.compile(r"\s*<br\s*/?>\s*", re.IGNORECASE)
_HTML_NBSP = re.compile(r"(?:&nbsp;)+", re.IGNORECASE)
_LATEX_CIRCLED_NUMBER = re.compile(r"\$?\\textcircled\{(\d{1,2})\}\$?")
_MAX_CIRCLED_NUMBER = 20  # Unicodeの丸数字①〜⑳

# ページ全体が要確認であることを示す目印セグメントのID(_build_page_result参照)
REVIEW_MARKER_SEGMENT_ID = "page-review-marker"


def _circled_number(match: "re.Match[str]") -> str:
    number = int(match.group(1))
    if 1 <= number <= _MAX_CIRCLED_NUMBER:
        return chr(0x2460 + number - 1)
    return match.group(0)  # ①〜⑳の範囲外は変換せず、そのまま残して人の目に委ねる


def normalize_ocr_markup(text: str) -> str:
    """
    OCR結果中のHTML/LaTeXの表記を素のテキストに揃える(<br>→空白、&nbsp;→空白、\\textcircled{n}→丸数字)。
    加えて、Markdown表の構造崩れ(ヘッダ行と区切り行の列数の食い違い等)を内容を失わずに修復する
    (table_repair.py参照)。表と認識されないと画面でパイプ付きの生テキストになるため。
    """
    text = _HTML_LINE_BREAK.sub(" ", text)
    text = _HTML_NBSP.sub(" ", text)
    text = _LATEX_CIRCLED_NUMBER.sub(_circled_number, text)
    return repair_markdown_tables(text)


def _join_preserving_structure(parts: List[str]) -> str:
    """
    セグメントのfinal_textを順番に連結して1ページ分のテキストを再構成する。
    match/needs_reviewのセグメントはocr_diff.pyのトークン分割により
    元テキストの空白・改行を保持した部分文字列になっているため単純連結でよいが、
    auto_correctedのセグメントはvision LLMが返した独立した文字列（元の空白を
    保持しているとは限らない）のため、前後のセグメントと単語がくっつかないよう
    必要な場合のみ半角スペースを挟む。
    """
    result = ""
    for part in parts:
        if (
            result and part
            and not result[-1].isspace()
            and not part[0].isspace()
        ):
            result += " "
        result += part
    return result


@dataclass(frozen=True)
class PageResult:
    """1ページ分のOCR結果。フロントの差分ハイライトプレビューはsegmentsをそのまま描画に使う"""
    page_number: int
    final_text: str
    segments: List[Dict]  # 各要素: segment_id, glm_text, glm_alt_text, status, final_text, reason


@dataclass(frozen=True)
class OcrDraftResult:
    """run_ocr_pipeline()の戻り値。t_manual_ocr_draftへそのまま保存できる形"""
    markdown: str
    pages: List[PageResult]
    page_count: int

    @property
    def diff_segments(self) -> List[Dict]:
        """t_manual_ocr_draft.diff_segments(JSONB)にそのまま保存する形（ページ番号込み）"""
        return [
            {"page": page.page_number, **segment}
            for page in self.pages
            for segment in page.segments
        ]


def _shown(text: str) -> str:
    """補正案を、要確認の理由に示すための、1行・短い文字列(文字化けが長くても、画面の判定理由を埋めない)"""
    shown = " ".join(text.split())
    return shown[:_MAX_PROPOSAL_CHARS_IN_REASON] + "…" if len(shown) > _MAX_PROPOSAL_CHARS_IN_REASON else shown


def _recheck_corrections(
    diff_segs: List[DiffSegment], segments: List[Dict], final_parts: List[str], page_number: int,
    page_text: Optional[str], ollama_host: str, vision_model: str, vision_timeout_seconds: int
) -> None:
    """
    補正が主文を書き換えた箇所(auto_corrected)を、「PDFにそう書かれているか」「日本語として正しいか」で
    再チェックし、取り消す箇所は、segments・final_partsを書き換えて、主文に戻す(correction_recheck.py参照)。
    主文と同じ内容(空白・改行の違いだけ)への補正は、書き換えではないため、対象にしない。
    """
    items: List[RecheckItem] = []
    for index, (seg, entry) in enumerate(zip(diff_segs, segments)):
        if entry["status"] != "auto_corrected" or not seg.glm_text.strip() or not entry["final_text"].strip():
            continue
        if candidate_similarity(entry["final_text"], [seg.glm_text]) >= 1.0:
            continue
        items.append(RecheckItem(
            segment_id=seg.segment_id, primary=seg.glm_text, chosen=entry["final_text"],
            before="".join(s.glm_text for s in diff_segs[:index])[-_RECHECK_CONTEXT_CHARS:],
            after="".join(s.glm_text for s in diff_segs[index + 1:])[:_RECHECK_CONTEXT_CHARS],
        ))
    if not items:
        return

    verdicts = recheck_corrections(items, page_text, ollama_host, model=vision_model, timeout_seconds=vision_timeout_seconds)
    for index, (seg, entry) in enumerate(zip(diff_segs, segments)):
        verdict = verdicts.get(seg.segment_id)
        if verdict is None or entry["status"] != "auto_corrected":
            continue
        if verdict.keep_chosen:
            if verdict.basis == BASIS_TEXT_LAYER:
                entry["reason"] = f"{entry['reason'] or ''}({verdict.reason})"
            continue
        proposal = _shown(entry["final_text"])
        # 補正を取り消して、主文を残す。PDFのテキスト層で主文が確認できたときは、確認済みのため要確認にしない
        entry["status"] = "match" if verdict.basis == BASIS_TEXT_LAYER else "needs_review"
        entry["final_text"] = seg.glm_text
        entry["reason"] = f"補正案を取り消し、主文を残しました。{verdict.reason}(補正案: {proposal})"
        final_parts[index] = seg.glm_text
        logger.warning(
            f"補正の再チェックで、補正案を取り消しました: p.{page_number} {seg.segment_id} basis={verdict.basis}"
        )


def _build_page_result(
    page_number: int, glm_text: str, glm_alt_text: str, review_marker_reason: Optional[str],
    image_path: Path, ollama_host: str, vision_model: str, vision_timeout_seconds: int,
    page_text: Optional[str] = None
) -> PageResult:
    diff_segs: List[DiffSegment] = diff_page(glm_text, glm_alt_text)

    corrections_by_id: Dict[str, VisionCorrectionResult] = {}
    if any(not seg.is_match for seg in diff_segs):
        corrections_by_id = {
            c.segment_id: c
            for c in correct_page_with_vision_llm(
                image_path, diff_segs, ollama_host, model=vision_model, timeout_seconds=vision_timeout_seconds
            )
        }

    segments = []
    final_parts = []
    for seg in diff_segs:
        if seg.is_match:
            status = "match"
            final_text = seg.glm_text
            reason = None
        else:
            correction = corrections_by_id.get(seg.segment_id)
            if correction is None:
                # diff_page()が不一致と判定したがvision補正結果が無い(呼び出し自体が
                # 行われなかった等)場合も、サイレントに一致扱いにせず要確認として残す
                status = "needs_review"
                final_text = seg.glm_text
                reason = "vision LLMによる判定結果がありません"
            elif correction.still_uncertain or not correction.corrected_text.strip():
                # 2026-09-29: 実機検証で、vision LLMがstill_uncertain=falseなのに
                # corrected_textが空文字という壊れた応答を返す不具合を確認した。
                # 「確信あり」を鵜呑みにして空文字で上書きすると、正しく読めていた
                # 内容(seg.glm_text)まで消えてしまうため、空文字の場合は
                # still_uncertainの値に関わらず要確認扱いにしLLMの提案を採用しない
                status = "needs_review"
                final_text = seg.glm_text  # LLMの提案は採用せず主文候補を暫定採用
                # 2026-09-30: 従来の固定文言「応答が空でした」は、実際にはLLMがreasonを空で
                # 返しただけのケース(still_uncertain=true、または補正テキストが空)も含んでおり
                # 実態と合わなかったため、条件別に文言を分け、生の値をログにも残す
                if correction.reason:
                    reason = correction.reason
                elif correction.still_uncertain:
                    reason = "vision LLMが判定不能(still_uncertain)と回答しましたが、理由の記載がありませんでした"
                else:
                    reason = "vision LLMの補正テキスト(corrected_text)が空で、理由の記載もありませんでした"
                logger.warning(
                    f"vision LLMの補正を採用せず要確認にしました: p.{page_number} {seg.segment_id} "
                    f"still_uncertain={correction.still_uncertain} "
                    f"corrected_text_len={len(correction.corrected_text.strip())} reason={correction.reason!r}"
                )
            else:
                proposal = normalize_ocr_markup(correction.corrected_text)
                similarity = candidate_similarity(proposal, [seg.glm_text, seg.glm_alt_text])
                if similarity < MIN_CORRECTION_SIMILARITY:
                    # 主文・比較候補のどちらとも大きく違う提案は、画像を根拠にした修正ではなく、文字化け・幻覚の
                    # 恐れが高い(MIN_CORRECTION_SIMILARITYのコメント参照)。LLMが付けた理由も、信用できないため使わない
                    status = "needs_review"
                    final_text = seg.glm_text  # 提案は採用せず、主文を残す
                    reason = (
                        f"vision LLMの補正案が、主文・比較候補のどちらとも大きく異なる"
                        f"(最も近い候補との類似度{similarity:.0%})ため、採用せず主文を残しました。補正案: {_shown(proposal)}"
                    )
                    logger.warning(
                        f"vision LLMの補正案を、候補との類似度が低いため採用せず要確認にしました: "
                        f"p.{page_number} {seg.segment_id} similarity={similarity:.2f}"
                    )
                else:
                    status = "auto_corrected"
                    final_text = proposal
                    reason = correction.reason

        final_parts.append(final_text)
        segments.append({
            "segment_id": seg.segment_id,
            "glm_text": seg.glm_text,
            "glm_alt_text": seg.glm_alt_text,
            "status": status,
            "final_text": final_text,
            "reason": reason,
        })

    _recheck_corrections(
        diff_segs, segments, final_parts, page_number, page_text, ollama_host, vision_model, vision_timeout_seconds
    )

    if review_marker_reason is not None:
        # ページ全体が要確認であることが一覧で分かるよう先頭に目印セグメントを追加する
        # （内容自体はfinal_partsとして活かす。ドキュメント全体は失敗させない）
        segments.insert(0, {
            "segment_id": REVIEW_MARKER_SEGMENT_ID,
            "glm_text": glm_text,
            "glm_alt_text": glm_alt_text,
            "status": "needs_review",
            "final_text": "",
            "reason": review_marker_reason,
        })

    return PageResult(page_number=page_number, final_text=_join_preserving_structure(final_parts), segments=segments)


def _build_page_from_primary(
    page_number: int, primary_text: str, glm_text: str,
    image_path: Path, ollama_host: str, vision_model: str, vision_timeout_seconds: int,
    page_text: Optional[str] = None
) -> PageResult:
    """
    主文(vision LLMのフルページOCR)に対する比較材料を選んで1ページ分を組み立てる。
    優先順位: ①GLM-OCR(別モデルで同じ誤りを共有しにくい) → ②vision LLM自身の
    2回目(異なるtemperature/seed) → ③画像との自己検証。
    """
    if glm_text:
        candidate_page = _build_page_result(
            page_number, primary_text, glm_text, None,
            image_path, ollama_host, vision_model, vision_timeout_seconds, page_text=page_text
        )
        # candidate_pageはreview_marker_reason=Noneで組み立てているため、status=needs_reviewの
        # セグメントは全て補正LLMが判定を確定できなかったもの
        unresolved_count = sum(1 for seg in candidate_page.segments if seg["status"] == "needs_review")
        if unresolved_count <= MAX_UNRESOLVED_SEGMENTS_FOR_PARTIAL_DIFF:
            return candidate_page
        # 2026-09-29(11): 比較材料の構造が壊れている(表の途中で打ち切られた等)兆候
        logger.warning(
            f"GLM-OCRとの比較で判定できなかった箇所が{unresolved_count}件発生したため"
            f"（構造の不整合の可能性）、vision LLMの自己比較に切り替えます: p.{page_number}"
        )

    alt_text = ocr_full_page_with_vision_llm(
        image_path, ollama_host, model=vision_model, timeout_seconds=vision_timeout_seconds,
        temperature=VISION_ALT_TEMPERATURE, seed=VISION_ALT_SEED,
    )
    if alt_text:
        return _build_page_result(
            page_number, primary_text, normalize_ocr_markup(alt_text), None,
            image_path, ollama_host, vision_model, vision_timeout_seconds, page_text=page_text
        )

    # 2026-09-29(7): 2回目も失敗した場合は自己検証結果を使う。matches_image=Falseでも
    # ページ全体をneeds_review扱いにはせず、既存のdiff_page()+セグメント単位補正に渡す
    matches_image, corrected_text, verify_reason = verify_full_page_ocr_with_vision_llm(
        image_path, primary_text, ollama_host, model=vision_model, timeout_seconds=vision_timeout_seconds
    )
    if matches_image or corrected_text != primary_text:
        return _build_page_result(
            page_number, primary_text, normalize_ocr_markup(corrected_text), None,
            image_path, ollama_host, vision_model, vision_timeout_seconds, page_text=page_text
        )
    # 検証呼び出し自体が失敗(接続エラー・スキーマ不正)し有効な修正案を得られなかった
    # 場合のみ、保守的にページ全体を要確認扱いにする
    return _build_page_result(
        page_number, primary_text, primary_text,
        (
            "比較材料(GLM-OCR・vision LLMの再読み取り)を得られず、"
            f"画像との再照合にも失敗しました({verify_reason})。"
            "このページ全体を目視で確認してください。"
        ),
        image_path, ollama_host, vision_model, vision_timeout_seconds
    )


def _ocr_page(
    page_number: int, image_path: Path, ollama_host: str, glm_model: str,
    vision_model: str, vision_timeout_seconds: int, page_text: Optional[str] = None
) -> PageResult:
    primary_text = ocr_full_page_with_vision_llm(
        image_path, ollama_host, model=vision_model, timeout_seconds=vision_timeout_seconds
    )
    glm_text, _glm_complete = ocr_with_glm(image_path, ollama_host, model=glm_model)
    glm_text = normalize_ocr_markup(glm_text.strip())

    if primary_text is None:
        # vision LLMのフルページOCRが失敗(接続エラー・空応答)した場合のみ、GLM-OCRを
        # 暫定の主文として使い、ページ全体を要確認扱いにする（サイレントに採用しない）。
        # 空白ページでも同じ扱いになる（LLMが空応答だったのか失敗なのか区別できないため保守的に倒す）
        logger.warning(f"vision LLMのフルページOCRに失敗したため、GLM-OCR結果を暫定採用します: p.{page_number}")
        return _build_page_result(
            page_number, glm_text, glm_text,
            (
                "vision LLMによるOCRが失敗または空応答だったため、GLM-OCRの結果を暫定採用しています"
                "（空白ページの場合もこの表示になります）。このページ全体を目視で確認してください。"
            ),
            image_path, ollama_host, vision_model, vision_timeout_seconds
        )

    return _build_page_from_primary(
        page_number, normalize_ocr_markup(primary_text.strip()), glm_text,
        image_path, ollama_host, vision_model, vision_timeout_seconds, page_text=page_text
    )


class OcrCancelled(Exception):
    """OCRの途中で、呼び出し側（on_progress）が中止を指示した"""


def run_ocr_pipeline(
    pdf_path: Path,
    password: Optional[str] = None,
    ollama_host: str = "http://ollama:11434",
    glm_model: str = DEFAULT_GLM_OCR_MODEL,
    vision_model: str = DEFAULT_VISION_MODEL,
    vision_timeout_seconds: int = 120,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> OcrDraftResult:
    """
    PDF全ページをvision LLM(主文)でOCRし、GLM-OCRの結果とdiff→不一致箇所のvision補正を
    行って、下書きMarkdown+差分ハイライト用データを組み立てる。

    glm_model: 比較用GLM-OCRのモデル名、vision_model: 主文のvision LLMのモデル名
    （どちらも呼び出し側が環境変数から渡す。ocr_rag/config.py参照）。

    ページ数・不一致箇所数によっては数分かかりうる。呼び出し側(ocr_rag/ocr_jobs.py)は
    バックグラウンドで実行する。

    on_progress(完了ページ数, 総ページ数): PDFを画像にした直後(0, 総数)と、各ページの
    OCRが終わるたびに呼ばれる。中止したい場合は、この中でOcrCancelledを投げる
    （ページの途中では止まらず、ページの区切りで中止される）。
    """
    with tempfile.TemporaryDirectory() as tmp_dir:
        images = convert_pdf_to_images(pdf_path, Path(tmp_dir), password=password)
        logger.info(f"{len(images)}ページを画像化しました: {pdf_path.name}")
        if on_progress is not None:
            on_progress(0, len(images))

        # 補正の再チェック用に、PDFのテキスト層を取り出す(スキャンしたPDF・取り出せない場合は、使わない)
        page_texts = extract_page_texts(pdf_path, password=password)

        pages: List[PageResult] = []
        for i, image_path in enumerate(images, 1):
            logger.info(f"OCR実行中: p.{i}/{len(images)}")
            page_text = page_texts[i - 1] if page_texts is not None and i - 1 < len(page_texts) else None
            if page_text is not None and not has_text_layer(squash_for_search(page_text)):
                page_text = None  # このページには、テキスト層が無い(スキャン・図だけのページ)
            pages.append(_ocr_page(i, image_path, ollama_host, glm_model, vision_model, vision_timeout_seconds, page_text=page_text))
            if on_progress is not None:
                on_progress(i, len(images))

    # 2026-10-05: 先頭に「# {pdf_path.stem}」を出していたが、APIはアップロードを一時ファイル
    # (tmpXXXX.pdf)に保存して渡すため、利用者に意味のない一時ファイル名が見出しになっていた。
    # 資料名はt_manual_ocr_draft.title/source_file_nameに別途保存されるので、本文には出さない
    markdown_parts: List[str] = []
    for page in pages:
        # 「p.N」だと、PDF内に印刷されたページ番号と混同される(2026-10-05)。PDFファイル内の通し番号で
        # あることを明示する。画面側の位置合わせ(draftLocator.ts)がこの文言を目印に
        # ページを特定するため、変更する場合は両方をそろえること
        markdown_parts.append(f"## PDF {page.page_number}ページ目")
        markdown_parts.append("")
        markdown_parts.append(page.final_text if page.final_text.strip() else "（このページはテキストを検出できませんでした）")
        markdown_parts.append("")

    return OcrDraftResult(markdown="\n".join(markdown_parts), pages=pages, page_count=len(pages))
