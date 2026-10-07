"""
ocr_rag/config.py のテスト
"""
import pytest

from ocr_rag.config import ConfigError, Settings


def _env(**overrides):
    env = {"DB_PASSWORD": "secret"}
    env.update(overrides)
    return env


class TestSettingsFromEnv:
    def test_defaults(self):
        settings = Settings.from_env(_env())

        assert settings.db_host == "localhost"
        assert settings.db_port == 5432
        assert settings.db_name == "ragstudio"
        assert settings.db_user == "postgres"
        assert settings.db_password == "secret"
        assert settings.ollama_host == "http://ollama:11434"
        assert settings.embedding_model == "bge-m3"
        assert settings.ocr_model == "glm-ocr"
        assert settings.vision_model == "qwen3.5:9b"
        assert settings.vision_timeout_seconds == 120
        assert settings.max_upload_bytes == 100 * 1024 * 1024

    def test_overrides(self):
        settings = Settings.from_env(_env(
            DB_HOST="db", DB_PORT="6543", DB_NAME="n", DB_USER="u",
            OLLAMA_HOST="http://o:1", EMBEDDING_MODEL="e", OCR_MODEL="g", OCR_VISION_MODEL="v",
            OCR_VISION_TIMEOUT_SECONDS="300", MAX_UPLOAD_BYTES="1024",
        ))

        assert (settings.db_host, settings.db_port, settings.db_name, settings.db_user) == ("db", 6543, "n", "u")
        assert settings.ollama_host == "http://o:1"
        assert (settings.embedding_model, settings.ocr_model, settings.vision_model) == ("e", "g", "v")
        assert settings.vision_timeout_seconds == 300
        assert settings.max_upload_bytes == 1024

    @pytest.mark.parametrize("env", [{}, {"DB_PASSWORD": ""}])
    def test_missing_db_password_raises(self, env):
        with pytest.raises(ConfigError, match="DB_PASSWORD"):
            Settings.from_env(env)

    @pytest.mark.parametrize("name", ["DB_PORT", "OCR_VISION_TIMEOUT_SECONDS", "MAX_UPLOAD_BYTES"])
    @pytest.mark.parametrize("value", ["abc", "1.5"])
    def test_non_integer_value_raises(self, name, value):
        with pytest.raises(ConfigError, match=name):
            Settings.from_env(_env(**{name: value}))

    @pytest.mark.parametrize("name", ["DB_PORT", "OCR_VISION_TIMEOUT_SECONDS", "MAX_UPLOAD_BYTES"])
    @pytest.mark.parametrize("value", ["0", "-5"])
    def test_non_positive_value_raises(self, name, value):
        with pytest.raises(ConfigError, match=name):
            Settings.from_env(_env(**{name: value}))
