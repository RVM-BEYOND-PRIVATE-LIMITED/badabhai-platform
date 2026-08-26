"""Spend-free reproduction of the welder profiling incident.

Two decoupled failures were observed in a welder's session:
  A) a RETRY STORM whose per-attempt log volume (~28) never reconciled with the
     per-call metadata (~11 calls / 1 failure), because the router logged only
     ``type(exc).__name__`` and attributed a Haiku-served failure to Gemini; and
  B) DROPPED CANONICAL DATA — every whitelist-backed field (role/skills/city) came
     back empty for a welder. The city drop ("dilli"/"bihar") was fixed in WS3. The
     role/skills drop was originally recorded as BY DESIGN (welding was outside the
     CNC/VMC gazetteer); TAX-WELD-1 CLOSES it — welding is now detected and mapped to
     the pre-existing, active welding skill ids, so a welder is matchable.

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

from app.ai import cost_tracker, provider_cooldown
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
    ignoring any ambient AI_SPEND_REDIS_URL/.env — mirrors tests/test_spend_cap.py.

    THE COOLDOWN RESET IS NOT OPTIONAL, and leaving it out is a real trap rather than
    tidiness: `ProviderCooldown` is a process-wide singleton keyed on the provider, and
    every storm test here raises a 429 that arms `google` for 60 s. Without this, the
    FIRST test in the file disables Gemini for every test after it, and those tests go
    green for the wrong reason — they stop measuring the attempt arithmetic they exist
    to measure, because the primary candidate is never dispatched at all."""
    cost_tracker._ledger = cost_tracker.SpendLedger(
        Settings(_env_file=None, ai_spend_redis_url=None)
    )
    provider_cooldown.reset_cooldown()
    yield
    cost_tracker._ledger = None
    provider_cooldown.reset_cooldown()


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
        # Stated rather than inherited (#1237). Every test below except the chat-turn one
        # drives `profile_extraction`, which resolves through the CAPABLE tier and is
        # unaffected by the pro tier; the chat turn resolves here. Pinning both explicitly is
        # what keeps this file's model literals readable as premises instead of as defaults
        # that can move underneath it.
        default_pro_model="gemini-2.5-pro",
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

    # Reconcile the "per-attempt vs per-call" gap: BOTH providers were tried, and the
    # attempt count equals the number of dispatches — no more phantom failures.
    #
    # 4, NOT 6, and the missing two are the point of this whole file. Gemini's 429 is now
    # in `_NO_RETRY_REASONS`, so a rate limit costs ONE dispatch instead of three: the
    # remaining `max_retries` are not spent re-asking a provider that has just said its
    # bucket is empty, and the chain escalates to Haiku immediately. Haiku's
    # `no_text_content` is genuinely retryable and still takes its full 3.
    #
    # This number is the regression guard. If it climbs back to 6, a 429 is being retried
    # again — and each of those dispatches wraps the Gemini client's own in-call 429 loop,
    # which is how one parse put 15 POSTs on the wire.
    assert meta.candidates_tried == ["gemini-2.5-flash", "claude-haiku-4-5"]
    assert meta.attempt_count == 4  # 1 Gemini (429, no retry) + 3 Haiku (max_retries=2)
    assert meta.attempt_count == len(seen)
    assert seen.count("gemini-2.5-flash") == 1

    # Attribution fix: the terminal failure is labelled under the model that
    # ACTUALLY failed last (the Haiku fallback), not always the primary.
    assert meta.model_name == "claude-haiku-4-5"

    # The closed-set reason codes are surfaced in the logs — never a bare
    # "RuntimeError" (which is what hid WHICH failure fired 28x).
    attempt_records = [r for r in caplog.records if r.getMessage().startswith("llm attempt failed")]
    reasons = [getattr(r, "extra", {}).get("reason") for r in attempt_records]
    assert "http_429" in reasons  # Gemini rate-limit attempts
    assert "no_text_content" in reasons  # Haiku empty-response attempts
    assert "RuntimeError" not in reasons
    # ...and the MESSAGE itself names them, since the structured `extra` is only
    # rendered by the JSON formatter, which plain-logging consumers never install.
    messages = "\n".join(r.getMessage() for r in attempt_records)
    assert "reason=http_429" in messages
    assert "reason=no_text_content" in messages
    assert "provider=google" in messages and "provider=anthropic" in messages


def test_repro_storm_chat_turn_also_reconciles(monkeypatch):
    # The same reconciliation holds for the high-volume chat task. The primary is
    # the CAPABLE model now (the chat turn moved cheap -> capable with generalized
    # profiling); max_retries=1 -> 2 attempts/candidate, and that attempt arithmetic
    # is what this test is actually about.
    #
    # 3 rather than 4, for the same reason as above: the 429 does not buy Gemini a
    # second dispatch. Haiku keeps both of its.
    _patch_anthropic_sdk(monkeypatch, installed=True)
    seen = _storm_dispatcher(monkeypatch)
    router = AIRouter(_storm_settings())

    _content, meta = _run(
        router.run("profiling_chat_turn", messages=_MESSAGES, mock_response="MOCK")
    )
    # The PRO model, because this is the chat turn (#1237) — every other test in this file
    # drives `profile_extraction`, which stays on the capable tier's flash. Worth having one
    # chat case here rather than pinning the tier down: it shows the cross-provider fallback is
    # chosen on PROVIDER, not on tier, so a pro-tier primary still reaches Haiku.
    assert meta.candidates_tried == ["gemini-2.5-pro", "claude-haiku-4-5"]
    assert meta.attempt_count == len(seen) == 3  # 1 Gemini (429) + 2 Haiku
    assert meta.failure_reason == "no_text_content"


# --- The cooldown: the first 429 informs the requests behind it -------------


def test_429_arms_a_cooldown_that_skips_the_provider_on_the_next_call(monkeypatch):
    """THE OUTER LOOP, closed. Bounding one request's retries was never enough: the
    reported incident was many SEPARATE requests each rediscovering the same rate limit,
    because nothing survived the request that found it. After a 429, the next call must
    not dispatch to that provider at all."""
    _patch_anthropic_sdk(monkeypatch, installed=True)
    seen = _storm_dispatcher(monkeypatch)
    router = AIRouter(_storm_settings())

    _run(router.run("profile_extraction", messages=_MESSAGES, mock_response="MOCK"))
    assert seen.count("gemini-2.5-flash") == 1

    # A SECOND, INDEPENDENT call. Gemini is still cooling, so it is skipped without
    # touching the network and the chain goes straight to Haiku.
    seen.clear()
    _content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="MOCK")
    )
    assert "gemini-2.5-flash" not in seen
    assert meta.candidates_tried == ["claude-haiku-4-5"]


def test_cooldown_on_every_candidate_reports_provider_cooldown(monkeypatch):
    """When the cooldown skips EVERY candidate the call is never attempted, so the
    terminal metadata must say why. `provider_cooldown` is a distinct diagnosis from a
    spend cap or a cost ceiling — it clears on its own, and apps/api needs to tell a
    transient outage from a deliberate posture to decide whether to retry."""
    _patch_anthropic_sdk(monkeypatch, installed=True)
    _storm_dispatcher(monkeypatch)
    settings = _storm_settings()
    router = AIRouter(settings)
    cooldown = provider_cooldown.get_cooldown(settings)

    _run(cooldown.start("google", settings))
    _run(cooldown.start("anthropic", settings))

    content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="MOCK")
    )
    assert content == "MOCK"
    assert meta.real_call is False
    assert meta.attempt_count == 0
    assert meta.error_code == "provider_cooldown"


def test_cooldown_disabled_by_zero_seconds(monkeypatch):
    """The kill switch. Set to 0, no provider is ever skipped — so an operator can turn
    the whole mechanism off without a deploy if it ever misfires."""
    _patch_anthropic_sdk(monkeypatch, installed=True)
    seen = _storm_dispatcher(monkeypatch)
    settings = _storm_settings(ai_provider_cooldown_seconds=0.0)
    router = AIRouter(settings)

    _run(router.run("profile_extraction", messages=_MESSAGES, mock_response="MOCK"))
    seen.clear()
    _run(router.run("profile_extraction", messages=_MESSAGES, mock_response="MOCK"))
    assert seen.count("gemini-2.5-flash") == 1  # dispatched again, never skipped


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


def test_welder_canonicalizes_after_tax_weld_1():
    # TAX-WELD-1 CLOSES repro B's canonical gap. It used to be "by design": welding was
    # excluded from the gazetteer, so this welder came back role/trade null with no
    # skills — unmatchable. The five skill ids and the wedge alias "welding ka kaam"
    # already existed (active/ratified) in packages/taxonomy; this was WIRING, not
    # minting. The closed-set trust boundary is UNCHANGED and still load-bearing:
    # the model's free-text "mig_tig_welder" is STILL rejected as a canonical id...
    assert normalize_role_id(extract_canonical_role_id(_WELDER_MODEL_JSON)) is None
    assert normalize_role_id("mig_tig_welder") is None

    # ...but the deterministic local gazetteer now detects welding itself.
    sig = signals.detect(_WELDER_TEXT)
    assert sig.role_id == "role_welder"
    assert sig.trade_id == "dom_welding"
    assert sig.skill_ids == [
        "skill_mig_welding",
        "skill_tig_welding",
        "skill_welder_occupation",
    ]
    assert sig.machine_ids == []  # no welding `mach_*` id exists — none invented

    # The rich draft still keeps the model's raw LABELS (human-readable), and the
    # legacy DraftProfile now carries real, closed-set matchable ids.
    rich, legacy = profile_extractor.extract(_WELDER_TEXT)
    rich = profile_extractor.merge_model_draft(rich, _WELDER_MODEL_JSON)
    assert rich.primary_role == "mig_tig_welder"
    assert legacy.canonical_role_id == "role_welder"
    assert legacy.canonical_trade_id == "dom_welding"
    assert legacy.skills == [
        "skill_mig_welding",
        "skill_tig_welding",
        "skill_welder_occupation",
    ]


def test_repro_welder_city_and_state_captured_after_ws3():
    # WS3 fixes the real bug: the Hinglish alias "dilli" normalizes to the canonical
    # "Delhi", and "bihar" is captured as a state instead of being silently dropped.
    sig = signals.detect(_WELDER_TEXT)
    assert sig.current_city == "Delhi"
    assert sig.current_state == "Bihar"
