# syntax=docker/dockerfile:1
#
# ocr-rag（OCR・RAG登録・検索のAPI）。x86_64・arm64のどちらでも、同じ手順でビルドできる
# （poppler-utilsはDebianのパッケージ、psycopg2-binaryなどはarm64用のwheelがある）。

FROM python:3.11-slim

# poppler-utils: PDFを画像にする pdftoppm（OCRに必須）
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先に依存だけを入れる（ソースを変えても、このレイヤーのキャッシュが効く）
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY ocr_rag ./ocr_rag

# 読み取り専用のルートファイルシステムでも動くよう、書き込み先は /tmp にする
# （OCR中の一時ファイルと、popplerのキャッシュ）
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/tmp
RUN useradd --system --uid 10001 --no-create-home ocrrag
USER ocrrag

EXPOSE 8000

# slimイメージにはcurlが無いため、標準ライブラリで /healthz（DBに接続できるか）を確認する
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"]

CMD ["uvicorn", "ocr_rag.api.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
