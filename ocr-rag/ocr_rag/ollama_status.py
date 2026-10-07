"""
Ollamaに必要なモデルが揃っているかの確認（/readyz用）

モデルは初回起動時に取得する（ollama-init）。取得に失敗した・まだ終わっていない状態で
OCR・登録を始めて途中で壊れることを避けるため、画面から確認できるようにする。
"""
from typing import List

import requests


def _normalize(model: str) -> str:
    """Ollamaは、タグ省略のモデル名を ':latest' として扱う"""
    return model if ":" in model else f"{model}:latest"


def find_missing_models(ollama_host: str, required: List[str], timeout_seconds: int = 5) -> List[str]:
    """
    必要なモデルのうち、Ollamaに入っていないものを返す（全部あれば空リスト）。

    Raises:
        requests.RequestException: Ollamaに接続できない場合
    """
    response = requests.get(f"{ollama_host}/api/tags", timeout=timeout_seconds)
    response.raise_for_status()
    installed = {m["name"] for m in response.json().get("models", [])}
    return [model for model in required if _normalize(model) not in installed]
