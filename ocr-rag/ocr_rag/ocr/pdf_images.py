"""
PDF→画像変換

依存: poppler-utils（pdftoppm）。ocr-ragコンテナのイメージ（ocr-rag/Dockerfile）に同梱する。
"""
import logging
import shutil
import subprocess
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)

DEFAULT_DPI = 300


def _require_binary(name: str) -> None:
    """依存バイナリの有無を確認する（未導入時は分かりやすいエラーで停止し、サイレントスキップしない）"""
    if shutil.which(name) is None:
        raise RuntimeError(
            f"'{name}' が見つかりません。poppler-utilsが未導入です。"
            "ocr-ragコンテナのイメージ（ocr-rag/Dockerfile）でインストール済みのはずなので、"
            "コンテナ内で実行しているか確認してください。"
            "イメージが古い場合は`docker compose build ocr-rag`が必要です。"
        )


def convert_pdf_to_images(
    pdf_path: Path, output_dir: Path, dpi: int = DEFAULT_DPI, password: Optional[str] = None
) -> List[Path]:
    """pdftoppmでPDFの各ページをPNG画像化する"""
    _require_binary("pdftoppm")

    prefix = output_dir / "page"
    command = ["pdftoppm", "-png", "-r", str(dpi)]
    if password:
        # pdftoppmはユーザーパスワード/オーナーパスワードを区別するが、機器マニュアルの
        # 配布物では通常どちらか一方（多くはユーザーパスワード）のみなので両方に同じ値を渡す
        command += ["-upw", password, "-opw", password]
    command += [str(pdf_path), str(prefix)]

    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"pdftoppmに失敗しました（PDF: {pdf_path}）: {result.stderr.strip()}")

    images = sorted(output_dir.glob("page-*.png"))
    if not images:
        raise RuntimeError(f"PDFから画像を抽出できませんでした（ページ数0件): {pdf_path}")
    return images
