"""AI router + cost tracker tests.

Verify mock mode never touches LiteLLM, real mode requires config (and fails
safe to mock when the dependency/endpoint is unavailable), and cost metadata is
always returned.
"""

import asyncio

from app.ai import cost_tracker
from app.ai.model_config import get_route, provider_for_model, resolve_model
from app.ai.router import AIRouter
from app.config import Settings

_MESSAGES = [{"role": "user", "content": "vmc 4 saal"}]


def _run(coro):
    return asyncio.run(coro)


def test_mock_mode_returns_mock_and_never_calls_litellm():
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


def test_real_mode_without_litellm_falls_back_to_mock_safely():
    # Real mode is configured, but litellm isn't installed -> must NOT raise;
    # falls back to the mock response and records the failure.
    settings = Settings(
        ai_enable_real_calls=True,
        litellm_api_key="test-key",
        litellm_base_url="http://localhost:4000",
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
    settings = Settings(ai_enable_real_calls=True, litellm_api_key="k")
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
        litellm_api_key="k",
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
    # only because litellm isn't installed) — proving the ceiling didn't block it.
    settings = Settings(ai_enable_real_calls=True, litellm_api_key="k", ai_max_call_cost_inr=10.0)
    router = AIRouter(settings)
    _content, meta = _run(
        router.run("profiling_chat_turn", messages=_MESSAGES, mock_response="m")
    )
    assert meta.real_call is True
    assert meta.error_code == "llm_call_failed"  # attempted, not ceiling-blocked


def test_per_task_allowlist_enables_only_the_listed_task():
    # Real enabled for ONE role: profile_extraction goes real (attempts, then
    # falls back to mock since litellm is absent); profiling_chat_turn stays mock.
    settings = Settings(
        ai_enable_real_calls=True,
        litellm_api_key="k",
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
    settings = Settings(ai_enable_real_calls=True, litellm_api_key="k", ai_real_call_tasks="")
    assert settings.real_call_enabled_for("profiling_chat_turn") is True
    assert settings.real_call_enabled_for("profile_extraction") is True


def test_allowlist_ignored_when_master_flag_off():
    # Allowlisting a task does NOT enable real calls without the master flag/key.
    settings = Settings(ai_enable_real_calls=False, ai_real_call_tasks="profile_extraction")
    assert settings.real_call_enabled_for("profile_extraction") is False
    router = AIRouter(settings)
    _c, meta = _run(router.run("profile_extraction", messages=_MESSAGES, mock_response="m"))
    assert meta.real_call is False
