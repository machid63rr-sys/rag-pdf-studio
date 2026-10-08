"""
設定（環境変数）の解決

不正な値は黙って既定値に戻さず、起動時に例外にする（サイレントフォールバック禁止）。
DB_PASSWORDだけは既定値を持たず、未設定なら起動できない。
"""
import os
from dataclasses import dataclass
from typing import List, Mapping, Optional

DEFAULT_OCR_VISION_TIMEOUT_SECONDS = 120
DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024


class ConfigError(RuntimeError):
    """環境変数の設定ミス"""


def _positive_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} は整数で指定してください: {raw!r}") from None
    if value <= 0:
        raise ConfigError(f"{name} は1以上で指定してください: {raw!r}")
    return value


def positive_int_from_environ(name: str, default: int) -> int:
    """
    環境変数から正の整数を読む。Settingsを経由しない、モジュール定数(Ollamaの生成の上限など)用。
    不正な値は、既定値に戻さず、読み込み時に例外にする
    """
    return _positive_int(os.environ, name, default)


@dataclass(frozen=True)
class Settings:
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: str
    ollama_host: str
    embedding_model: str
    # 比較用OCR（GLM-OCR）と、OCRの主文を読むvision LLM。環境変数だけで差し替えられる
    ocr_model: str
    vision_model: str
    # vision LLM・補正1回あたりのタイムアウト(秒)。大きいモデルに差し替えると
    # 1ページの生成が既定を超えうるため、コード変更なしで延ばせるようにする
    vision_timeout_seconds: int
    # アップロード(PDF・Markdown)の上限バイト数
    max_upload_bytes: int
    # チャット（機能④）の回答を作るモデル。既定はvision_modelと同じ（OCRの主文と同じモデルを使えば、
    # モデルを1つ多く取得・常駐させずに済む）
    chat_model: str

    @property
    def required_models(self) -> List[str]:
        """動作に必要なOllamaのモデル（埋め込み・比較OCR・OCR主文・チャットの回答）"""
        return list(dict.fromkeys([self.embedding_model, self.ocr_model, self.vision_model, self.chat_model]))

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None) -> "Settings":
        env = os.environ if env is None else env

        db_password = env.get("DB_PASSWORD")
        if not db_password:
            raise ConfigError("環境変数 DB_PASSWORD が設定されていません（既定値は使いません）")

        vision_model = env.get("OCR_VISION_MODEL") or "qwen3.5:9b"
        return cls(
            db_host=env.get("DB_HOST") or "localhost",
            db_port=_positive_int(env, "DB_PORT", 5432),
            db_name=env.get("DB_NAME") or "ragstudio",
            db_user=env.get("DB_USER") or "postgres",
            db_password=db_password,
            ollama_host=env.get("OLLAMA_HOST") or "http://ollama:11434",
            embedding_model=env.get("EMBEDDING_MODEL") or "bge-m3",
            ocr_model=env.get("OCR_MODEL") or "glm-ocr",
            vision_model=vision_model,
            vision_timeout_seconds=_positive_int(
                env, "OCR_VISION_TIMEOUT_SECONDS", DEFAULT_OCR_VISION_TIMEOUT_SECONDS
            ),
            max_upload_bytes=_positive_int(env, "MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES),
            chat_model=env.get("CHAT_MODEL") or vision_model,
        )
