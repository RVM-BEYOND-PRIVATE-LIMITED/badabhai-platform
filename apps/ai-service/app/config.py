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

    # Model routing. Cheap model handles high-volume chat turns; the capable
    # model handles strict-JSON extraction. Names are LiteLLM model ids.
    default_cheap_model: str = "gemini-flash-lite"
    default_capable_model: str = "claude-haiku-or-gemini-flash"

    # Per-profile cost guardrails (INR). Used for alerting only in Phase 1.
    ai_cost_alert_profile_inr: float = 6.0
    ai_target_profile_cost_inr: float = 4.0
    # Hard per-call spend ceiling (INR). A real call whose worst-case cost would
    # exceed this is refused (falls back to mock) — a stateless runaway guard.
    ai_max_call_cost_inr: float = 10.0

    sarvam_api_key: str | None = None

    # Observability (Langfuse). Optional — tracing is silently disabled if either
    # key is missing, so local dev never depends on Langfuse being configured.
    langfuse_public_key: str | None = None
    langfuse_secret_key: str | None = None
    langfuse_base_url: str = "https://cloud.langfuse.com"

    # Google Cloud / Gemini (only consumed by LiteLLM in real mode; never by the
    # frontend). All optional so mock mode boots without them.
    google_cloud_project: str | None = None
    google_cloud_location: str | None = None
    gemini_api_key: str | None = None

    ai_service_port: int = 8000

    def real_calls_blocked_reason(self) -> str | None:
        """Return why real LLM calls are disabled, or None if allowed."""
        if not self.ai_enable_real_calls:
            return "AI_ENABLE_REAL_CALLS is false"
        if not self.litellm_api_key:
            return "LITELLM_API_KEY is not set"
        if not self.litellm_base_url:
            return "LITELLM_BASE_URL is not set"
        return None

    @property
    def real_calls_enabled(self) -> bool:
        return self.real_calls_blocked_reason() is None

    @property
    def langfuse_enabled(self) -> bool:
        """Langfuse tracing is enabled only when BOTH keys are present."""
        return bool(self.langfuse_public_key and self.langfuse_secret_key)


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
