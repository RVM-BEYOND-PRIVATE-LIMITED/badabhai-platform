"""AI service configuration (env-driven).

Real LLM calls are gated and FAIL CLOSED: they require AI_ENABLE_REAL_CALLS=true
AND a LiteLLM key. Default is mock-only.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    ai_enable_real_calls: bool = False

    litellm_base_url: str = "http://localhost:4000"
    litellm_api_key: str | None = None

    sarvam_api_key: str | None = None

    langfuse_public_key: str | None = None
    langfuse_secret_key: str | None = None

    ai_service_port: int = 8000

    def real_calls_blocked_reason(self) -> str | None:
        """Return why real LLM calls are disabled, or None if allowed."""
        if not self.ai_enable_real_calls:
            return "AI_ENABLE_REAL_CALLS is false"
        if not self.litellm_api_key:
            return "LITELLM_API_KEY is not set"
        return None

    @property
    def real_calls_enabled(self) -> bool:
        return self.real_calls_blocked_reason() is None


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
