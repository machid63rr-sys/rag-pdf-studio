"""
GLM-OCR（Ollama、vision対応）の呼び出し

ページ画像1枚を、比較用のOCR結果（Markdown）に変換する。主文（下書きの基準）は
vision LLM（vision_correction.ocr_full_page_with_vision_llm）が読み、このGLM-OCRの
結果とocr_diff.pyでdiff比較して低信頼度箇所を検出する（ocr_pipeline.py参照）。
別モデルなので、主文と同じ誤りを共有しにくい。
"""
import base64
import logging
import re
from pathlib import Path
from typing import Tuple

import requests

logger = logging.getLogger(__name__)

DEFAULT_GLM_OCR_MODEL = "glm-ocr"
DEFAULT_GLM_OCR_TIMEOUT_SECONDS = 120  # vision推論はテキストのみの埋め込みより時間がかかる
# 2026-09-29: 実機のollama(0.32.5)+glm-ocrで実際に確認した不具合への対策。
# 短く単純な内容のページ(機器銘板・短い注意書き等)で、正しい内容を1回出力した直後に
# 同じ内容をMarkdownコードフェンス(```)で囲んで際限なく繰り返し続ける現象を確認した
# （repeat_penalty/temperature=0を試しても解消せず）。num_predictで上限を設け、
# 応答からは重複ブロックを検出して切り詰める。
DEFAULT_GLM_OCR_NUM_PREDICT = 2048
# 2026-09-29: 実機で、num_ctx未指定時にollamaがglm-ocrをコンテキスト長4096で
# ロードし、画像1枚分のトークン+プロンプトだけで4096を超えて
# "request exceeds the available context size" 400エラーになる不具合を確認した
# （高DPIレンダリング画像や複雑なページで発生しうる）。モデル自体は131072まで
# 対応しているため、GPU VRAM(8GB想定)とのバランスを見て余裕を持たせる
DEFAULT_GLM_OCR_NUM_CTX = 16384
# 2026-09-29: 実機のollama(0.32.5)+glm-ocrで、生成中にモデルが不正なUTF-8バイト列
# （壊れたマルチバイト文字）を出力すると、llama.cppのchat-templateパーサーが
# パースに失敗してタスクを強制キャンセルし、"done": false のまま応答が途中で
# 打ち切られる不具合を確認した（サーバーログでcommon_chat_peg_parse失敗→
# srv stop: cancel taskを確認済み）。温度・seedを変えても同じ箇所で再現するため、
# 単純な同一条件リトライでは回避できない。GLM_OCR_MAX_ATTEMPTS回まで温度/seedを
# 変えて試行し、それでもdone:falseなら、その時点までの部分応答(最も内容が長い
# ものを採用)を「未確認」として返す。実機検証で、打ち切られた時点までの内容自体は
# 正しく読み取れているケースが多いと判明したため、サイレントに握り潰しはしないが
# 内容自体は活かし、ページ単位で人手確認に回す設計とした（2026-09-29決定）。
GLM_OCR_MAX_ATTEMPTS = 3
GLM_OCR_PROMPT = (
    "この画像は空調設備の機器マニュアルの1ページです。"
    "文章はMarkdown形式で、表組みは表として、見出しは#で、忠実に書き起こしてください。"
    "画像に無い内容を補完したり要約したりせず、実際に書かれている文字だけを出力してください。"
    "内容は1回だけ出力し、同じ内容を繰り返さないでください。"
)
# 2026-09-29: 実機検証で、故障コード表等の複雑な表ページはMarkdown表記法での
# 構造化出力を求めると特に不安定になり(Pythonのリストのような壊れた形式になる、
# done:falseで打ち切られる、等)、通常プロンプトをGLM_OCR_MAX_ATTEMPTS回試しても
# 直らないケースが多いと判明した。全て失敗した場合の最後の手段として、体裁を
# 一切求めずプレーンテキストの書き起こしだけを頼む簡素なプロンプトでもう1回だけ
# 試す（構造化出力を諦める代わりに生成が安定することを期待する）。
GLM_OCR_PLAINTEXT_FALLBACK_PROMPT = (
    "この画像は空調設備の機器マニュアルの1ページです。"
    "表や見出しなどの体裁は一切気にせず、画像に書かれている文字だけを"
    "上から下へ、行ごとにそのままプレーンテキストで書き出してください。"
    "Markdown記法(#、|、*等)は使わないでください。"
    "画像に無い内容を補完したり要約したりせず、実際に書かれている文字だけを出力してください。"
)

_FENCE_PATTERN = re.compile(r'```\w*')


def _dedupe_repeated_output(text: str) -> str:
    """
    GLM-OCRが正しい内容を出力した直後に同じ内容を繰り返し続ける既知の不具合への対処。
    Markdownコードフェンスで区切ったブロック単位で正規化・比較し、既出のブロックが
    再び現れた時点でそれ以降を切り捨てる（正しい内容は最初に1回だけ出力されるため）。
    """
    blocks = [b.strip() for b in _FENCE_PATTERN.split(text) if b.strip()]
    seen = set()
    result = []
    for block in blocks:
        if block in seen:
            break
        seen.add(block)
        result.append(block)
    return "\n\n".join(result)


def _call_glm_once(
    image_b64: str, prompt: str, ollama_host: str, model: str, timeout_seconds: int,
    temperature: float, seed: int,
) -> Tuple[str, bool]:
    """GLM-OCRへ1回だけリクエストする。戻り値は(重複除去済みテキスト, done)"""
    response = requests.post(
        f"{ollama_host}/api/generate",
        json={
            "model": model,
            "prompt": prompt,
            "images": [image_b64],
            "stream": False,
            "options": {
                "num_predict": DEFAULT_GLM_OCR_NUM_PREDICT,
                "num_ctx": DEFAULT_GLM_OCR_NUM_CTX,
                "temperature": temperature,
                "seed": seed,
            },
        },
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    data = response.json()

    raw_text = data.get("response", "")
    deduped = _dedupe_repeated_output(raw_text)
    if deduped != raw_text.strip():
        logger.warning("GLM-OCR応答に繰り返しを検出したため切り詰めました")
    return deduped, data.get("done") is not False


def ocr_with_glm(
    image_path: Path,
    ollama_host: str,
    model: str = DEFAULT_GLM_OCR_MODEL,
    timeout_seconds: int = DEFAULT_GLM_OCR_TIMEOUT_SECONDS,
    temperature: float = 0.0,
    seed: int = 1,
) -> Tuple[str, bool]:
    """
    GLM-OCR（Ollama、vision）で1ページ分のOCRテキスト(Markdown)を取得する。

    公式ドキュメントでOpenAI互換API(/api/chat)のvisionリクエストに制限があると
    案内されているため、native の /api/generate を使う。

    temperature/seed: 2026-09-29(3)決定。低信頼度検出をtesseractとの比較から、
    GLM-OCR自体を異なるtemperature/seedで2回走らせてその2回分をdiffする方式に
    変更した（tesseractの日本語認識精度が低く、GLM-OCRが正しく読めている箇所まで
    「tesseractと食い違う」という理由で軒並み要確認扱いになっていた問題への対処）。
    そのため呼び出し側が1回目・2回目で異なる値を明示的に指定する
    （両方ともtemperature=0の既定値のままだと決定的推論により毎回同一出力になり、
    diffが機能しない）。プレーンテキストのフォールバック(最終手段)もこのseedから
    派生させており、1回目・2回目の呼び出しが両方ともここまでリトライし切った
    場合でも独立性を保つ（2026-09-29(4)修正、以前は固定値でここだけ同一出力に
    なってしまっていた）。

    Returns:
        (text, is_complete) のタプル。is_complete=Falseは、通常プロンプト
        (GLM_OCR_MAX_ATTEMPTS回)+プレーンテキストのフォールバック(1回)を
        試しても応答が完了しなかった(done:falseのまま)ことを示す。この場合textは
        打ち切られた時点までの部分応答（最も内容が長かった試行を採用、重複除去済み）。
        呼び出し側はis_complete=Falseのページを人手確認対象として扱うこと
        （サイレントに正としない）。
    """
    image_b64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
    best_partial_text = ""

    try:
        for attempt in range(1, GLM_OCR_MAX_ATTEMPTS + 1):
            # 1回目は呼び出し側が指定したtemperature/seedで試し、失敗時のみ
            # さらに揺らぎを与えて同じ壊れたトークン列の再現を避けようとする
            # （毎回効くとは限らない）
            deduped, done = _call_glm_once(
                image_b64, GLM_OCR_PROMPT, ollama_host, model, timeout_seconds,
                temperature=temperature if attempt == 1 else 0.3, seed=seed if attempt == 1 else seed + attempt,
            )
            if done:
                return deduped, True

            if len(deduped) > len(best_partial_text):
                best_partial_text = deduped
            logger.warning(
                f"GLM-OCR応答が完了しませんでした(done:false、attempt {attempt}/{GLM_OCR_MAX_ATTEMPTS}、"
                f"image={image_path})。不正なUTF-8出力によるサーバー側タスクキャンセルの可能性があります。"
            )

        logger.warning(
            f"GLM-OCRが{GLM_OCR_MAX_ATTEMPTS}回とも応答を完了できませんでした（image={image_path}）。"
            "表組み等の構造化出力の要求が不安定化の一因である可能性があるため、"
            "体裁を求めないプレーンテキスト専用プロンプトで最後にもう1回だけ試します。"
        )
        # seedを呼び出し元の値から派生させる(2026-09-29(4)修正)。ここを固定値のままに
        # すると、1回目/2回目呼び出しが両方ともここまでリトライし切った場合に完全に
        # 同一パラメータでOllamaを叩くことになり、2回の独立性が失われて同一の
        # (同じ箇所で打ち切られた)出力になってしまう不具合があった。
        deduped, done = _call_glm_once(
            image_b64, GLM_OCR_PLAINTEXT_FALLBACK_PROMPT, ollama_host, model, timeout_seconds,
            temperature=0.0, seed=seed + 1000,
        )
        if done:
            return deduped, True
        if len(deduped) > len(best_partial_text):
            best_partial_text = deduped
    except requests.RequestException as e:
        logger.error(f"GLM-OCR呼び出し失敗 ({ollama_host}, model={model}, image={image_path}): {e}")
        raise

    logger.error(
        f"GLM-OCRがプレーンテキストのフォールバックも含め応答を完了できませんでした"
        f"（image={image_path}）。打ち切られた時点までの部分応答を要確認扱いで採用します。"
    )
    return best_partial_text, False
