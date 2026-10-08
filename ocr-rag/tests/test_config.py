"""
ocr_rag/config.py のテスト
"""
import pytest

from ocr_rag.config import ConfigError, Settings, positive_int_from_environ


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
        assert settings.chat_model == "qwen3.5:9b"
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

    def test_chat_model_follows_the_vision_model_unless_set(self):
        assert Settings.from_env(_env(OCR_VISION_MODEL="v")).chat_model == "v"
        assert Settings.from_env(_env(OCR_VISION_MODEL="v", CHAT_MODEL="c")).chat_model == "c"

    def test_required_models_include_a_separate_chat_model(self):
        settings = Settings.from_env(_env(CHAT_MODEL="c"))

        assert settings.required_models == ["bge-m3", "glm-ocr", "qwen3.5:9b", "c"]

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


class TestPositiveIntFromEnviron:
    def test_未設定なら既定値(self, monkeypatch):
        monkeypatch.delenv("OCR_TEST_LIMIT", raising=False)

        assert positive_int_from_environ("OCR_TEST_LIMIT", 16384) == 16384

    def test_空文字なら既定値(self, monkeypatch):
        monkeypatch.setenv("OCR_TEST_LIMIT", "")

        assert positive_int_from_environ("OCR_TEST_LIMIT", 16384) == 16384

    def test_設定した値を使う(self, monkeypatch):
        monkeypatch.setenv("OCR_TEST_LIMIT", "32768")

        assert positive_int_from_environ("OCR_TEST_LIMIT", 16384) == 32768

    @pytest.mark.parametrize("value", ["abc", "1.5", "0", "-5"])
    def test_不正な値は既定値に戻さず例外(self, monkeypatch, value):
        monkeypatch.setenv("OCR_TEST_LIMIT", value)

        with pytest.raises(ConfigError, match="OCR_TEST_LIMIT"):
            positive_int_from_environ("OCR_TEST_LIMIT", 16384)
