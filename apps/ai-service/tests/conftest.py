"""Test isolation for the AI service.

The unit/contract suite is MOCK-ONLY and must make ZERO real LLM calls — in CI
(which has no `.env`) and on a developer laptop that has a real-call `.env`
(AI_ENABLE_REAL_CALLS=true + a real provider key) for the staging validation
runbook.

pydantic-settings ranks real environment variables ABOVE the `.env` file, so
forcing the gate OFF in `os.environ` here neutralizes any local real-call `.env`
without deleting it. Tests that need real mode construct ``Settings(...)`` with
explicit kwargs, which outrank both. This guarantees the suite never reaches the
network and the skip-gated real per-field test stays skipped.
"""

import os


def _force_mock_only_env() -> None:
    os.environ["AI_ENABLE_REAL_CALLS"] = "false"
    os.environ["AI_REAL_CALL_TASKS"] = ""
    # Blank every real-provider secret so a developer real-call `.env` can't leak
    # into Settings(). pydantic-settings reads the `.env` FILE, so popping os.environ
    # is not enough (the dotenv value would still flow in) — an EMPTY env var
    # outranks the dotenv entry, so set these to "" (falsy → every real gate stays
    # closed). GEMINI_FLASH_API_KEY is the master gate; ANTHROPIC_API_KEY adds the
    # fallback candidate; SARVAM_API_KEY gates real STT. (LITELLM_/GEMINI_API_KEY
    # are legacy names kept here only to neutralize an older developer .env.)
    for var in (
        "GEMINI_FLASH_API_KEY",
        "ANTHROPIC_API_KEY",
        "SARVAM_API_KEY",
        "LITELLM_API_KEY",
        "GEMINI_API_KEY",
    ):
        os.environ[var] = ""
    # Pin model routing too, so tests that read the DEFAULTS (e.g. the onboarding
    # readiness banner) are deterministic regardless of which primary/fallback a
    # developer's `.env` selects (e.g. a local Claude-Haiku-primary swap). Tests
    # needing a specific routing pass explicit Settings(...) kwargs, which outrank
    # these. Values mirror the committed defaults: Gemini primary, Haiku fallback.
    os.environ["DEFAULT_CHEAP_MODEL"] = "gemini-2.5-flash-lite"
    os.environ["DEFAULT_CAPABLE_MODEL"] = "gemini-2.5-flash-lite"
    os.environ["DEFAULT_FALLBACK_MODEL"] = "claude-haiku-4-5"
    # Drop the eval target so the skip-gated per-field real test stays SKIPPED
    # even when a developer .env sets it.
    os.environ.pop("AI_EVAL_BASE_URL", None)


# Applied at import time (before any test constructs Settings()).
_force_mock_only_env()
