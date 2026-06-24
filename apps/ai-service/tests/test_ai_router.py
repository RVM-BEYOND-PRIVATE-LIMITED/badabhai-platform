"""AI router + cost tracker tests.

Verify mock mode never calls the model, real mode requires config (and fails
safe to mock when the call raises), and cost metadata is always returned. The
real transport is the direct Gemini client (``app.ai.gemini_client.acomplete``);
these tests NEVER hit the network — the real path is forced to raise via
monkeypatch so the router's fail-safe fallback to mock is what gets exercised.
"""

import asyncio

import pytest

from app.ai import cost_tracker
from app.ai import router as router_module
from app.ai.gemini_client import LlmResult
from app.ai.model_config import get_route, provider_for_model, resolve_model
from app.ai.router import AIRouter
from app.config import Settings

_MESSAGES = [{"role": "user", "content": "vmc 4 saal"}]


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """Force the provider dispatcher to raise so no test can hit the network.

    The router dispatches every real call through ``providers.complete`` (Gemini
    or Claude). Stubbing it here means any test that reaches the real path
    exercises the router's fail-safe fallback to the mock response, never an
    actual HTTP/SDK request. Tests that want a specific provider to succeed
    re-stub ``router_module.providers.complete`` themselves.
    """
    async def _boom(**_kwargs):
        raise RuntimeError("forced failure (no network in tests)")

    monkeypatch.setattr(router_module.providers, "complete", _boom)


def test_mock_mode_returns_mock_and_never_calls_the_model():
    # Real calls disabled (default) -> deterministic mock, no network.
    router = AIRouter(Settings(ai_enable_real_calls=False))
    content, meta = _run(
        router.run("profiling_chat_turn", messages=_MESSAGES, mock_response="MOCK_REPLY")
    )
    assert content == "MOCK_REPLY"
    assert meta.real_call is False
    assert meta.success is True
    assert meta.task_type == "profiling_chat_turn"
    assert meta.ai_call_id


def test_real_mode_call_failure_falls_back_to_mock_safely():
    # Real mode is configured, but the call raises -> must NOT raise; falls back
    # to the mock response and records the failure.
    settings = Settings(
        ai_enable_real_calls=True,
        gemini_flash_api_key="test-key",
    )
    assert settings.real_calls_enabled is True
    router = AIRouter(settings)
    content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="FALLBACK")
    )
    assert content == "FALLBACK"
    assert meta.real_call is True
    assert meta.success is False
    assert meta.error_code == "llm_call_failed"


def test_cost_metadata_is_returned_with_model_and_provider():
    router = AIRouter(Settings())
    _content, meta = _run(
        router.run("resume_generation", messages=_MESSAGES, mock_response="resume text")
    )
    assert meta.model_name  # resolved from settings
    assert meta.provider in {"google", "anthropic", "openai", "litellm"}
    assert meta.estimated_cost_inr >= 0
    assert meta.input_tokens > 0
    assert meta.output_tokens > 0


def test_real_call_can_be_disabled_per_request():
    # Even with real mode enabled globally, a request can opt out.
    settings = Settings(ai_enable_real_calls=True, gemini_flash_api_key="k")
    router = AIRouter(settings)
    _content, meta = _run(
        router.run(
            "profiling_chat_turn", messages=_MESSAGES, mock_response="m", real_call_allowed=False
        )
    )
    assert meta.real_call is False


def test_routing_picks_capable_model_for_extraction():
    settings = Settings(default_cheap_model="cheap-x", default_capable_model="capable-y")
    assert resolve_model("profile_extraction", settings) == "capable-y"
    assert resolve_model("profiling_chat_turn", settings) == "cheap-x"
    assert get_route("profile_extraction").json_mode is True


def test_cost_alert_thresholds():
    settings = Settings(ai_cost_alert_profile_inr=6.0, ai_target_profile_cost_inr=4.0)
    # Force a large token count to exceed thresholds (uses estimate table).
    meta = cost_tracker.build_call_metadata(
        task_type="profile_extraction", model="claude-haiku", real_call=False,
        input_tokens=200_000, output_tokens=200_000, latency_ms=1, success=True,
        settings=settings,
    )
    assert meta.estimated_cost_inr > 6.0
    assert meta.cost_alert is True
    assert meta.above_target is True


def test_provider_inference():
    assert provider_for_model("gemini-flash-lite") == "google"
    assert provider_for_model("claude-haiku") == "anthropic"


def test_hard_cost_ceiling_refuses_expensive_real_call():
    # Real mode enabled, but a near-zero per-call ceiling makes the worst-case
    # cost exceed it -> the router must NOT make a real call and fall back to mock.
    settings = Settings(
        ai_enable_real_calls=True,
        gemini_flash_api_key="k",
        ai_max_call_cost_inr=0.00001,
    )
    router = AIRouter(settings)
    content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="CEILING_MOCK")
    )
    assert content == "CEILING_MOCK"
    assert meta.real_call is False  # no real call was made
    assert meta.error_code == "cost_ceiling_exceeded"


def test_high_ceiling_allows_real_attempt():
    # With a generous ceiling, the real path is attempted (and falls back to mock
    # only because the forced call raises) — proving the ceiling didn't block it.
    settings = Settings(
        ai_enable_real_calls=True, gemini_flash_api_key="k", ai_max_call_cost_inr=10.0
    )
    router = AIRouter(settings)
    _content, meta = _run(
        router.run("profiling_chat_turn", messages=_MESSAGES, mock_response="m")
    )
    assert meta.real_call is True
    assert meta.error_code == "llm_call_failed"  # attempted, not ceiling-blocked


def test_per_task_allowlist_enables_only_the_listed_task():
    # Real enabled for ONE role: profile_extraction goes real (attempts, then
    # falls back to mock since the call raises); profiling_chat_turn stays mock.
    settings = Settings(
        ai_enable_real_calls=True,
        gemini_flash_api_key="k",
        ai_real_call_tasks="profile_extraction",
    )
    assert settings.real_call_enabled_for("profile_extraction") is True
    assert settings.real_call_enabled_for("profiling_chat_turn") is False

    router = AIRouter(settings)
    _c, ext = _run(router.run("profile_extraction", messages=_MESSAGES, mock_response="m"))
    _c, chat = _run(router.run("profiling_chat_turn", messages=_MESSAGES, mock_response="m"))
    assert ext.real_call is True  # attempted (allowlisted)
    assert chat.real_call is False  # stayed mock (not allowlisted)


def test_empty_allowlist_enables_all_tasks_backcompat():
    # No allowlist => master flag governs all tasks (existing behavior preserved).
    settings = Settings(
        ai_enable_real_calls=True, gemini_flash_api_key="k", ai_real_call_tasks=""
    )
    assert settings.real_call_enabled_for("profiling_chat_turn") is True
    assert settings.real_call_enabled_for("profile_extraction") is True


def test_allowlist_ignored_when_master_flag_off():
    # Allowlisting a task does NOT enable real calls without the master flag/key.
    settings = Settings(ai_enable_real_calls=False, ai_real_call_tasks="profile_extraction")
    assert settings.real_call_enabled_for("profile_extraction") is False
    router = AIRouter(settings)
    _c, meta = _run(router.run("profile_extraction", messages=_MESSAGES, mock_response="m"))
    assert meta.real_call is False


def test_real_calls_blocked_without_gemini_key():
    # Master flag on but no key -> fail closed (blocked reason, mock path).
    settings = Settings(ai_enable_real_calls=True)
    assert settings.real_calls_blocked_reason() == "GEMINI_FLASH_API_KEY is not set"
    assert settings.real_calls_enabled is False


# --- Provider-fallback chain (Gemini primary -> Claude Haiku fallback) ------

def _stub_dispatcher(monkeypatch, behavior):
    """Replace router_module.providers.complete with a fn driven by ``behavior``:
    a dict {model_substring: callable-or-result}. Records the models it was
    called with (in order) on the returned list. NO network."""
    seen: list[str] = []

    async def _complete(*, model, **_kwargs):
        seen.append(model)
        for key, action in behavior.items():
            if key in model:
                if callable(action):
                    return action()
                return action
        raise RuntimeError(f"no stub for {model}")

    monkeypatch.setattr(router_module.providers, "complete", _complete)
    return seen


def _fallback_settings(**overrides):
    base = dict(
        ai_enable_real_calls=True,
        gemini_flash_api_key="gem-key",
        anthropic_api_key="anth-key",
        default_cheap_model="gemini-flash-lite",
        default_capable_model="gemini-2.5-flash",
        default_fallback_model="claude-haiku-4-5",
    )
    base.update(overrides)
    return Settings(**base)


def test_gemini_failure_falls_over_to_haiku(monkeypatch):
    # Primary (Gemini) raises; the Claude Haiku fallback serves the call.
    # The anthropic SDK is NOT installed in CI (requirements-dev.txt omits it), so
    # simulate it present — this test exercises the armed-Haiku path, not SDK gating.
    _patch_anthropic_sdk(monkeypatch, installed=True)

    def _gem_fail():
        raise RuntimeError("gemini boom")

    seen = _stub_dispatcher(
        monkeypatch,
        {
            "gemini": _gem_fail,
            "claude-haiku-4-5": LlmResult(content="HAIKU_OK", input_tokens=11, output_tokens=3),
        },
    )
    router = AIRouter(_fallback_settings())
    content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="m")
    )
    assert content == "HAIKU_OK"
    assert meta.real_call is True
    assert meta.success is True
    assert meta.model_name == "claude-haiku-4-5"
    assert meta.provider == "anthropic"
    # Order: Gemini tried first (with its retries), then Haiku.
    assert seen[0].startswith("gemini")
    assert seen[-1] == "claude-haiku-4-5"


def test_both_providers_fail_falls_back_to_mock(monkeypatch):
    # SDK present so the Haiku fallback actually arms — this proves BOTH providers
    # are attempted before mock (without it, Haiku would be SDK-gated out and the
    # test would pass for the wrong reason).
    _patch_anthropic_sdk(monkeypatch, installed=True)

    def _boom():
        raise RuntimeError("provider boom")

    _stub_dispatcher(monkeypatch, {"gemini": _boom, "claude-haiku-4-5": _boom})
    router = AIRouter(_fallback_settings())
    content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="MOCK_LAST")
    )
    assert content == "MOCK_LAST"
    assert meta.real_call is True  # attempted real
    assert meta.success is False
    assert meta.error_code == "llm_call_failed"
    # Metadata reports under the PRIMARY model.
    assert meta.model_name == "gemini-2.5-flash"


def test_no_fallback_when_anthropic_key_absent(monkeypatch):
    # Without an Anthropic key, the chain is Gemini-only: on Gemini failure we go
    # straight to mock and never touch the Claude transport.
    def _boom():
        raise RuntimeError("gemini boom")

    seen = _stub_dispatcher(monkeypatch, {"gemini": _boom})
    router = AIRouter(_fallback_settings(anthropic_api_key=None))
    content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="MOCK")
    )
    assert content == "MOCK"
    assert meta.real_call is True
    assert meta.success is False
    assert all(m.startswith("gemini") for m in seen)  # Haiku never attempted


def test_cost_ceiling_skips_expensive_candidate_then_serves_cheaper(monkeypatch):
    # A tight ceiling makes the Haiku candidate (pricier) too expensive while the
    # Gemini primary stays under it. Gemini fails -> Haiku would be next but is
    # ceiling-skipped -> mock. Proves the ceiling is enforced PER candidate.
    # SDK present so Haiku is a real candidate the CEILING skips (not SDK-gated out).
    _patch_anthropic_sdk(monkeypatch, installed=True)

    def _gem_fail():
        raise RuntimeError("gemini boom")

    seen = _stub_dispatcher(
        monkeypatch,
        {"gemini": _gem_fail, "claude-haiku-4-5": LlmResult("X", 1, 1)},
    )
    # profile_extraction max_output_tokens=1024. Haiku out rate 0.415/1k ->
    # ~0.42 INR worst case; Gemini 2.5-flash out rate 0.21/1k -> ~0.21 INR.
    # Ceiling 0.30 admits Gemini, blocks Haiku.
    router = AIRouter(_fallback_settings(ai_max_call_cost_inr=0.30))
    content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="MOCK_CEIL")
    )
    assert content == "MOCK_CEIL"
    # Gemini WAS attempted (and failed) -> real_call True, llm_call_failed.
    assert meta.real_call is True
    assert meta.error_code == "llm_call_failed"
    assert any(m.startswith("gemini") for m in seen)
    assert "claude-haiku-4-5" not in seen  # skipped by ceiling, never dispatched


def test_fallback_skipped_when_same_provider(monkeypatch):
    # If the fallback model resolves to the SAME provider as the primary, it is
    # not added (no point re-trying the same transport).
    def _boom():
        raise RuntimeError("boom")

    seen = _stub_dispatcher(monkeypatch, {"gemini": _boom})
    router = AIRouter(_fallback_settings(default_fallback_model="gemini-flash-lite"))
    _c, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="m")
    )
    assert meta.real_call is True
    assert all(m.startswith("gemini") for m in seen)  # only one provider in chain


def test_master_flag_off_means_no_candidates(monkeypatch):
    # Master flag off: no real attempt regardless of an Anthropic key being set.
    called = _stub_dispatcher(monkeypatch, {"gemini": lambda: LlmResult("x", 1, 1)})
    settings = _fallback_settings(ai_enable_real_calls=False)
    router = AIRouter(settings)
    content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="MOCK_OFF")
    )
    assert content == "MOCK_OFF"
    assert meta.real_call is False
    assert called == []  # dispatcher never invoked


def test_haiku_primary_falls_over_to_gemini(monkeypatch):
    # SWAPPED chain: Claude Haiku primary, Gemini fallback. The fallback is gated
    # on the GEMINI key (its own provider's credential), not the Anthropic key —
    # proving primary/fallback can be either provider.
    def _haiku_fail():
        raise RuntimeError("haiku boom")

    seen = _stub_dispatcher(
        monkeypatch,
        {
            "claude-haiku-4-5": _haiku_fail,
            "gemini": LlmResult(content="GEMINI_OK", input_tokens=9, output_tokens=2),
        },
    )
    router = AIRouter(
        _fallback_settings(
            default_cheap_model="claude-haiku-4-5",
            default_capable_model="claude-haiku-4-5",
            default_fallback_model="gemini-2.5-flash-lite",
        )
    )
    content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="m")
    )
    assert content == "GEMINI_OK"
    assert meta.real_call is True
    assert meta.success is True
    assert meta.model_name == "gemini-2.5-flash-lite"
    assert meta.provider == "google"
    assert seen[0] == "claude-haiku-4-5"  # primary first
    assert seen[-1] == "gemini-2.5-flash-lite"  # fallback second


def test_gemini_fallback_dropped_when_gemini_key_absent():
    # Haiku primary + Gemini fallback, but no Google credential -> the chain-builder
    # drops the Gemini fallback (gated on its own provider key). Tested directly
    # because an absent gemini key also trips the master gate upstream.
    router = AIRouter(
        _fallback_settings(
            default_cheap_model="claude-haiku-4-5",
            default_fallback_model="gemini-2.5-flash-lite",
            gemini_flash_api_key="",
        )
    )
    assert router._candidate_models("claude-haiku-4-5") == ["claude-haiku-4-5"]


# --- SDK-aware fallback gating (Finding 1: dead Haiku fallback) -------------
# A key-set-but-SDK-absent (or SDK-absent) Anthropic config must NOT arm the
# Claude Haiku fallback: the anthropic_client raises 100% of the time, which would
# waste the per-call retries AND draw down the TD27 retry budget for nothing. The
# fallback arms ONLY when the credential AND the importable SDK are both present.
# We mock the SDK-availability probe so the assertion never depends on whether the
# ``anthropic`` package happens to be installed in the test env.

def _patch_anthropic_sdk(monkeypatch, *, installed: bool):
    """Force ``importlib.util.find_spec('anthropic')`` to report installed/absent,
    leaving every other module's find_spec untouched. No import side effects."""
    import importlib.util

    real_find_spec = importlib.util.find_spec

    def fake_find_spec(name, *args, **kwargs):
        if name == "anthropic":
            return object() if installed else None
        return real_find_spec(name, *args, **kwargs)

    monkeypatch.setattr(importlib.util, "find_spec", fake_find_spec)


def test_fallback_chain_is_gemini_only_when_anthropic_key_unset(monkeypatch):
    # (a) No Anthropic key -> Gemini-only candidate chain, regardless of SDK state.
    _patch_anthropic_sdk(monkeypatch, installed=True)
    router = AIRouter(_fallback_settings(anthropic_api_key=None))
    assert router._candidate_models("gemini-2.5-flash") == ["gemini-2.5-flash"]


def test_fallback_chain_is_gemini_only_when_anthropic_sdk_absent(monkeypatch):
    # (b) Anthropic KEY set but the SDK is NOT importable -> the fallback is a dead
    # transport, so the chain must stay Gemini-only (no 100%-failing candidate that
    # burns retries + the TD27 retry budget). This is the core Finding-1 fix.
    _patch_anthropic_sdk(monkeypatch, installed=False)
    router = AIRouter(_fallback_settings(anthropic_api_key="anth-key"))
    assert router._candidate_models("gemini-2.5-flash") == ["gemini-2.5-flash"]


def test_fallback_chain_includes_haiku_only_when_key_and_sdk_present(monkeypatch):
    # Both the Anthropic key AND the importable SDK present -> the ADR-0008 Claude
    # Haiku fallback is armed (preserved for a properly-provisioned deployment).
    _patch_anthropic_sdk(monkeypatch, installed=True)
    router = AIRouter(_fallback_settings(anthropic_api_key="anth-key"))
    assert router._candidate_models("gemini-2.5-flash") == [
        "gemini-2.5-flash",
        "claude-haiku-4-5",
    ]


def test_sdk_absent_fallback_does_not_consume_retry_budget(monkeypatch):
    # End-to-end consequence of the fix: with the Anthropic SDK absent, a Gemini
    # failure goes STRAIGHT to mock — the dead Haiku candidate is never dispatched,
    # so it can't draw down the TD27 retry budget. We prove Haiku was never reached.
    _patch_anthropic_sdk(monkeypatch, installed=False)

    def _gem_fail():
        raise RuntimeError("gemini boom")

    seen = _stub_dispatcher(monkeypatch, {"gemini": _gem_fail})
    router = AIRouter(_fallback_settings(anthropic_api_key="anth-key"))
    content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="MOCK")
    )
    assert content == "MOCK"
    assert meta.real_call is True  # Gemini WAS attempted
    assert meta.success is False
    assert all(m.startswith("gemini") for m in seen)  # Haiku never dispatched
    assert "claude-haiku-4-5" not in seen


def test_fallback_transport_available_credential_only_for_google():
    # The Gemini (primary) transport is raw httpx (a core dep), so for "google"
    # transport-available == credential-present (no SDK probe needed).
    s = _fallback_settings()
    assert s.fallback_transport_available("google") is True
    assert s.has_credential_for("anthropic") is True  # credential-only stays True
    # Unknown providers have no live transport.
    assert s.fallback_transport_available("openai") is False
