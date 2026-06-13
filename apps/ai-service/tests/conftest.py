"""Test isolation for the AI service.

The unit/contract suite is MOCK-ONLY and must make ZERO real LLM calls — in CI
(which has no `.env`) and on a developer laptop that has a real-call `.env`
(AI_ENABLE_REAL_CALLS=true + a Gemini key) for the staging validation runbook.

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
    # Drop the gateway key/eval target so real_calls_enabled is False and the
    # skip-gated per-field real test (which requires the key + AI_EVAL_BASE_URL)
    # stays SKIPPED even when a developer .env sets them.
    for var in ("LITELLM_API_KEY", "AI_EVAL_BASE_URL"):
        os.environ.pop(var, None)


# Applied at import time (before any test constructs Settings()).
_force_mock_only_env()
