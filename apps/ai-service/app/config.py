"""AI service configuration (env-driven).

Real LLM calls are gated and FAIL CLOSED: they require AI_ENABLE_REAL_CALLS=true
AND a direct Gemini key (GEMINI_FLASH_API_KEY). The real provider is Google AI
Studio (Gemini) reached over REST — there is NO LiteLLM proxy. Default mock-only.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    ai_enable_real_calls: bool = False
    # Per-task allowlist for real calls (comma-separated TaskTypes, e.g.
    # "profile_extraction"). Lets real calls be enabled for ONE role/task while
    # every other task stays on the mock path. EMPTY = all tasks (backward
    # compatible). The master flag + key are still required regardless.
    ai_real_call_tasks: str = ""

    # Direct Google AI Studio (Gemini) API key. The PRIMARY real-call credential
    # and the master gate for real calls (see real_calls_blocked_reason). The
    # field name maps to the env var GEMINI_FLASH_API_KEY (pydantic-settings is
    # case-insensitive). Optional so mock mode boots without it.
    gemini_flash_api_key: str | None = None

    # Anthropic (Claude) API key — credential for the FALLBACK provider only.
    # Maps to env ANTHROPIC_API_KEY. Its presence ADDS Claude Haiku to the
    # router's provider-fallback chain; it is NOT a master gate (Gemini's key
    # still governs whether real calls happen at all). Optional.
    anthropic_api_key: str | None = None

    # Model routing. Cheap model handles high-volume chat turns; the capable
    # model handles strict-JSON extraction. Bare Gemini model ids (no provider
    # prefix). Defaults are REAL Gemini ids so the service resolves a valid model
    # even when .env is absent; .env overrides them per environment.
    #
    # PINNED PROD EXTRACTION MODEL = gemini-2.5-flash (ADR-0008 "capable" tier +
    # docs/ai/enable-real-llm-extraction.md). This default now MATCHES the runbook so
    # the model that ships in prod == the model the gold set is validated on (resolves
    # GO/NO-GO Finding 4 / Q3: validation-model must equal flip-model). Real calls stay
    # OFF by default (AI_ENABLE_REAL_CALLS=false); this only fixes WHICH model is used
    # when extraction is turned real. The clean 56-case re-validation + p95 on this
    # exact model is the remaining (human-gated) gate before any flip.
    default_cheap_model: str = "gemini-2.5-flash-lite"
    default_capable_model: str = "gemini-2.5-flash"
    # Cross-provider FALLBACK model: tried by the router only AFTER the primary
    # (Gemini) candidate fails, and only when anthropic_api_key is set and this
    # model's provider differs from the primary's. Claude Haiku 4.5 (no date
    # suffix per the Anthropic API).
    default_fallback_model: str = "claude-haiku-4-5"

    # Per-profile cost guardrails (INR). Used for alerting only in Phase 1.
    ai_cost_alert_profile_inr: float = 6.0
    ai_target_profile_cost_inr: float = 4.0
    # Hard per-call spend ceiling (INR). A real call whose worst-case cost would
    # exceed this is refused (falls back to mock) — a stateless runaway guard.
    ai_max_call_cost_inr: float = 10.0

    # --- TD27: cumulative spend cap + retry budget + kill-switch ---------------
    # Independent HARD kill for real calls (env AI_REAL_CALLS_KILL_SWITCH). When
    # true it blocks real calls FIRST in real_calls_blocked_reason — before the
    # flag/key checks — so it disables real calls regardless of
    # AI_ENABLE_REAL_CALLS. Off by default.
    ai_real_calls_kill_switch: bool = False
    # Rolling per-UTC-day spend cap (INR). Real candidates are blocked once the
    # day's recorded spend + a call's worst-case projected cost would exceed it.
    ai_max_daily_cost_inr: float = 200.0
    # Process-lifetime cumulative spend cap (INR). Same check against total spend.
    ai_max_total_cost_inr: float = 1000.0
    # PER-USER rolling per-UTC-day spend cap (INR) — the user-facing budget that
    # bounds ALL real AI spend for one worker per day (profiling chat + extraction
    # + resume combined), keyed by the opaque ``worker_ref`` (PII-free). Checked
    # only when a worker_ref is supplied; the process-level caps above remain the
    # backstop for any call without one. Default Rs 6/user/day.
    ai_max_user_daily_cost_inr: float = 6.0
    # Max RETRY attempts (attempt > 0) across ALL requests within a rolling
    # window — cuts retry multiplication against a failing provider.
    ai_retry_budget_per_window: int = 20
    ai_retry_budget_window_seconds: int = 60

    # Shared spend-ledger store (env REDIS_URL). When UNSET the spend ledger uses
    # the in-process backend: daily / cumulative / per-user INR caps are enforced
    # PER PROCESS (with N Uvicorn workers each holds its own counters). This is the
    # deliberate dev / test / single-process default — NOT a failure.
    # When SET it uses the Redis backend (CLAUDE.md §3 locked stack — activating the
    # deferred wiring, not a new datastore): the SAME caps enforce GLOBALLY across
    # all workers, keyed by UTC day. The Redis store FAILS CLOSED — if Redis is
    # unreachable a real call is blocked (mock fallback); an unverifiable cap never
    # permits a real spend. Only PII-free data is stored (INR, counts, the UTC date,
    # and the opaque worker_ref). The retry budget stays per-process regardless.
    redis_url: str | None = None

    sarvam_api_key: str | None = None
    # Sarvam STT model id. Config so the future ``saaras:v3`` swap is one line.
    sarvam_stt_model: str = "saarika:v2.5"
    # Sarvam text-translation model. mayura:v1 is required for auto-detect + code-mixed
    # (the only model that supports Hinglish source + source_language_code="auto").
    sarvam_translate_model: str = "mayura:v1"

    # Supabase Storage access for the AI service. Read ONLY to fetch voice audio
    # for real STT (Storage Mode A — REST + service-role key). Backend-only.
    # Supabase project URL; never used for anything but the storage object GET.
    supabase_url: str | None = None
    # Service-role key; backend-only; never logged. Bypasses RLS by design.
    supabase_service_role_key: str | None = None
    # PRIVATE bucket holding uploaded voice notes; object key = the request's
    # ``storage_path``. MUST be created PRIVATE out-of-band (Storage object ACLs
    # are not covered by RLS/migrations).
    voice_notes_bucket: str = "worker-voice-notes"

    # Observability (Langfuse). Optional — tracing is silently disabled if either
    # key is missing, so local dev never depends on Langfuse being configured.
    langfuse_public_key: str | None = None
    langfuse_secret_key: str | None = None
    langfuse_base_url: str = "https://cloud.langfuse.com"

    ai_service_port: int = 8000

    def real_calls_blocked_reason(self) -> str | None:
        """Return why real LLM calls are disabled, or None if allowed.

        Real calls require the master flag AND a direct Gemini key. With either
        missing we fail closed (a non-None reason) so the mock path is used.

        The kill-switch is checked FIRST so it hard-disables real calls
        independently of AI_ENABLE_REAL_CALLS (TD27).
        """
        if self.ai_real_calls_kill_switch:
            return "kill switch engaged"
        if not self.ai_enable_real_calls:
            return "AI_ENABLE_REAL_CALLS is false"
        if not self.gemini_flash_api_key:
            return "GEMINI_FLASH_API_KEY is not set"
        return None

    @property
    def real_calls_enabled(self) -> bool:
        return self.real_calls_blocked_reason() is None

    @property
    def real_call_task_allowlist(self) -> frozenset[str]:
        """Parsed AI_REAL_CALL_TASKS. Empty = no per-task restriction (all tasks)."""
        return frozenset(t.strip() for t in self.ai_real_call_tasks.split(",") if t.strip())

    def real_call_enabled_for(self, task_type: str) -> bool:
        """Whether a REAL call is permitted for this specific task. Requires the
        master flag + key (``real_calls_enabled``); then, if an allowlist is set,
        the task must be in it. An empty allowlist means all tasks (back-compat)."""
        if not self.real_calls_enabled:
            return False
        allow = self.real_call_task_allowlist
        return (not allow) or (task_type in allow)

    def has_credential_for(self, provider: str) -> bool:
        """Whether the API credential for a provider label (as returned by
        ``provider_for_model``) is configured. Single source of truth shared by the
        router's fallback-chain gating and the CLI's readiness banner, so the
        primary/fallback providers can be swapped freely without either drifting."""
        if provider == "google":
            return bool(self.gemini_flash_api_key)
        if provider == "anthropic":
            return bool(self.anthropic_api_key)
        return False

    @property
    def storage_configured(self) -> bool:
        """Whether Supabase Storage is reachable (URL + service-role key). Real STT
        enforces this inside ``_transcribe_real`` so a missing-storage real call
        fails CLOSED to empty — never to mock."""
        return bool(self.supabase_url and self.supabase_service_role_key)

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
