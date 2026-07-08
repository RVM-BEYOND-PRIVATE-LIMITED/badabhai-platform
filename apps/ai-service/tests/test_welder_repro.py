"""Spend-free reproduction of the welder profiling incident.

Two decoupled failures were observed in a welder's session:
  A) a RETRY STORM whose per-attempt log volume (~28) never reconciled with the
     per-call metadata (~11 calls / 1 failure), because the router logged only
     ``type(exc).__name__`` and attributed a Haiku-served failure to Gemini; and
  B) DROPPED CANONICAL DATA — every whitelist-backed field (role/skills/city) came
     back empty for a welder, which is largely BY DESIGN (welding is outside the
     CNC/VMC gazetteer) except the city, which was a real bug ("dilli"/"bihar").

Both are reproduced here with NO network and NO real key leaving the process:
the provider dispatcher (``app.ai.providers.complete``) is monkeypatched to raise
the typed transport errors, and Settings is constructed with explicit kwargs
(``ai_enable_real_calls=True`` + a dummy key) that outrank conftest's mock-only
env. The pattern mirrors tests/test_ai_router.py.
"""

from __future__ import annotations

import asyncio
import json
import logging

import pytest

from app.ai import cost_tracker
from app.ai import router as router_module
from app.ai.errors import REASON_HTTP_429, REASON_NO_TEXT_CONTENT, LlmTransportError
from app.ai.router import AIRouter
from app.config import Settings
from app.profiling import profile_extractor, signals
from app.profiling.canonical_roles import extract_canonical_role_id, normalize_role_id

_MESSAGES = [{"role": "user", "content": "vmc 4 saal"}]


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _reset_ledger():
    """Fresh, deterministic in-process ledger per test (retry budget + spend),
    ignoring any ambient REDIS_URL/.env — mirrors tests/test_spend_cap.py."""
    cost_tracker._ledger = cost_tracker.SpendLedger(Settings(_env_file=None, redis_url=None))
    yield
    cost_tracker._ledger = None


def _patch_anthropic_sdk(monkeypatch, *, installed: bool = True) -> None:
    """Report the ``anthropic`` SDK present so the Haiku fallback actually arms
    (no real import, no network)."""
    import importlib.util

    real_find_spec = importlib.util.find_spec

    def fake_find_spec(name, *args, **kwargs):
        if name == "anthropic":
            return object() if installed else None
        return real_find_spec(name, *args, **kwargs)

    monkeypatch.setattr(importlib.util, "find_spec", fake_find_spec)


def _storm_dispatcher(monkeypatch) -> list[str]:
    """Stub ``providers.complete`` to raise the observed transport errors:
    Gemini attempts 429 (rate limit), the Haiku fallback returns no text. Records
    the model of every dispatch (in order). NO network."""
    seen: list[str] = []

    async def _complete(*, model, **_kwargs):
        seen.append(model)
        if "gemini" in model:
            raise LlmTransportError(REASON_HTTP_429, status_code=429)
        if "claude-haiku" in model:
            raise LlmTransportError(REASON_NO_TEXT_CONTENT)
        raise RuntimeError(f"no stub for {model}")

    monkeypatch.setattr(router_module.providers, "complete", _complete)
    return seen


def _storm_settings(**overrides) -> Settings:
    base = dict(
        ai_enable_real_calls=True,
        gemini_flash_api_key="test-key",
        anthropic_api_key="anth-key",
        default_cheap_model="gemini-2.5-flash-lite",
        default_capable_model="gemini-2.5-flash",
        default_fallback_model="claude-haiku-4-5",
        ai_real_call_tasks="profiling_chat_turn,profile_extraction",
    )
    base.update(overrides)
    return Settings(**base)


# --- Repro A: the retry storm now reconciles + surfaces the reason ----------

def test_repro_storm_reconciles_attempts_and_surfaces_reason(monkeypatch, caplog):
    _patch_anthropic_sdk(monkeypatch, installed=True)
    seen = _storm_dispatcher(monkeypatch)
    router = AIRouter(_storm_settings())

    with caplog.at_level(logging.WARNING, logger="ai.router"):
        content, meta = _run(
            router.run("profile_extraction", messages=_MESSAGES, mock_response="MOCK")
        )

    # Fail-safe: never raises; falls back to the deterministic mock.
    assert content == "MOCK"
    assert meta.real_call is True
    assert meta.success is False
    # The coarse error_code is KEPT; the SPECIFIC transport reason is added.
    assert meta.error_code == "llm_call_failed"
    assert meta.failure_reason == "no_text_content"

    # Reconcile the "per-attempt vs per-call" gap: BOTH providers were tried, and
    # the attempt count (3 Gemini + 3 Haiku, max_retries=2 each) equals the number
    # of dispatches — no more phantom, unexplained failures.
    assert meta.candidates_tried == ["gemini-2.5-flash", "claude-haiku-4-5"]
    assert meta.attempt_count == 6
    assert meta.attempt_count == len(seen)

    # Attribution fix: the terminal failure is labelled under the model that
    # ACTUALLY failed last (the Haiku fallback), not always the primary.
    assert meta.model_name == "claude-haiku-4-5"

    # The closed-set reason codes are surfaced in the logs — never a bare
    # "RuntimeError" (which is what hid WHICH failure fired 28x).
    reasons = [
        getattr(r, "extra", {}).get("reason")
        for r in caplog.records
        if r.getMessage() == "llm attempt failed"
    ]
    assert "http_429" in reasons  # Gemini rate-limit attempts
    assert "no_text_content" in reasons  # Haiku empty-response attempts
    assert "RuntimeError" not in reasons


def test_repro_storm_chat_turn_also_reconciles(monkeypatch):
    # The same reconciliation holds for the high-volume chat task (cheap primary,
    # max_retries=1 -> 2 attempts/candidate).
    _patch_anthropic_sdk(monkeypatch, installed=True)
    seen = _storm_dispatcher(monkeypatch)
    router = AIRouter(_storm_settings())

    _content, meta = _run(
        router.run("profiling_chat_turn", messages=_MESSAGES, mock_response="MOCK")
    )
    assert meta.candidates_tried == ["gemini-2.5-flash-lite", "claude-haiku-4-5"]
    assert meta.attempt_count == len(seen) == 4  # 2 Gemini + 2 Haiku
    assert meta.failure_reason == "no_text_content"


# --- Repro B: the dropped canonical data (by-design gap + the city bug) ------
# The observed welder payload: a rich draft full of welding LABELS, but every
# CNC/VMC-whitelist-backed canonical field empty. Welding is outside scope by
# design; the city drop ("dilli"/"bihar") is the real bug fixed in WS3.

_WELDER_TEXT = "mig aur tig welding karta hu, dilli mai kaam karta tha, ab bihar mai hu"
_WELDER_MODEL_JSON = json.dumps(
    {
        "primary_role": "mig_tig_welder",
        "canonical_role_id": None,
        "skills": ["mig welding", "tig welding"],
        "machines": [],
    }
)


def test_repro_welder_canonical_gap_is_by_design():
    # The model's welding role is NOT in the closed CNC/VMC set -> rejected, so it
    # can never enter a matchable field (the whitelist trust boundary holds).
    assert normalize_role_id(extract_canonical_role_id(_WELDER_MODEL_JSON)) is None

    # The local gazetteer detector finds no CNC/VMC role/skill/machine for welding.
    sig = signals.detect(_WELDER_TEXT)
    assert sig.role_id is None
    assert sig.skill_ids == []
    assert sig.machine_ids == []

    # The rich draft keeps the model's welding LABELS (human-readable), but the
    # legacy DraftProfile's canonical ids stay empty -> matchable fields are null.
    rich, legacy = profile_extractor.extract(_WELDER_TEXT)
    rich = profile_extractor.merge_model_draft(rich, _WELDER_MODEL_JSON)
    assert rich.primary_role == "mig_tig_welder"
    assert legacy.canonical_role_id is None
    assert legacy.canonical_trade_id is None
    assert legacy.skills == []


def test_repro_welder_city_and_state_captured_after_ws3():
    # WS3 fixes the real bug: the Hinglish alias "dilli" normalizes to the canonical
    # "Delhi", and "bihar" is captured as a state instead of being silently dropped.
    sig = signals.detect(_WELDER_TEXT)
    assert sig.current_city == "Delhi"
    assert sig.current_state == "Bihar"
