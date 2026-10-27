"""Token-audit fix B-1 — per-task model choice (`AI_TASK_MODEL_OVERRIDES`).

A provider flip or a tier default moves many tasks at once; an override moves ONE. These tests
pin the four promises that make it safe to use on the box:

  1. EMPTY IS TODAY. No value, or only separators, leaves every route exactly as it was.
  2. IT MOVES ONLY WHAT IT NAMES, and only the model chain: the route's budgets, temperature,
     json mode and retries stay.
  3. A BAD ENTRY NEVER MOVES ANYTHING. It is dropped, logged once, and that task keeps its route.
  4. THE FALLBACK ANSWERS IN THE SAME REQUEST, through the router's existing chain.

No test reaches the network: the provider dispatcher is stubbed.
"""

from __future__ import annotations

import asyncio
import logging
import runpy
from dataclasses import astuple
from pathlib import Path

import pytest

from app.ai import cost_tracker, model_config
from app.ai import router as router_module
from app.ai.gemini_client import LlmResult
from app.ai.model_config import (
    _MODEL_RATES_INR,
    _ROUTE_SHAPES,
    NON_OVERRIDABLE_TASKS,
    OVERRIDE_MODELS,
    get_route,
    model_chain,
    parse_task_model_overrides,
    provider_for_model,
    resolve_model,
    task_model_overrides,
)
from app.ai.router import AIRouter
from app.config import Settings

FLAGS_SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "effective-ai-flags.py"
CLASSIFY = "profiling_free_classify"
LITE_THEN_HAIKU = f"{CLASSIFY}=gemini-2.5-flash-lite>claude-haiku-4-5"


@pytest.fixture(autouse=True)
def _fresh_override_cache():
    model_config._parsed_overrides.cache_clear()
    yield
    model_config._parsed_overrides.cache_clear()


@pytest.fixture(autouse=True)
def _anthropic_sdk_present(monkeypatch):
    """Claude's transport usable (key below + SDK), so the Claude-first order is in force."""
    import importlib.util

    real_find_spec = importlib.util.find_spec

    def fake_find_spec(name, *args, **kwargs):
        if name == "anthropic":
            return object()
        return real_find_spec(name, *args, **kwargs)

    monkeypatch.setattr(importlib.util, "find_spec", fake_find_spec)


@pytest.fixture
def fresh_ledger():
    cost_tracker._ledger = cost_tracker.SpendLedger(
        Settings(_env_file=None, ai_spend_redis_url=None)
    )
    yield
    cost_tracker._ledger = None


def _settings(**overrides) -> Settings:
    """The shipped routing (Claude first), with both providers' transports usable."""
    base = dict(
        ai_enable_real_calls=True,
        gemini_flash_api_key="gem-key",
        anthropic_api_key="anth-key",
        default_cheap_model="gemini-2.5-flash-lite",
        default_capable_model="gemini-2.5-flash",
        default_pro_model="gemini-2.5-pro",
        default_fallback_model="claude-haiku-4-5",
        default_career_model="claude-haiku-4-5",
        ai_primary_provider="anthropic",
        ai_real_call_tasks=CLASSIFY,
    )
    base.update(overrides)
    return Settings(**base)


def _routes(settings: Settings) -> dict[str, tuple]:
    return {task: astuple(get_route(task, settings)) for task in _ROUTE_SHAPES}


# --- 1. Empty is today ---------------------------------------------------------------------------


def test_the_setting_ships_empty():
    assert Settings.model_fields["ai_task_model_overrides"].default == ""


@pytest.mark.parametrize("provider", ["anthropic", "google"])
@pytest.mark.parametrize("value", ["", " ", ",", " , ,"])
def test_no_entry_is_every_route_exactly(provider, value):
    today = _routes(_settings(ai_primary_provider=provider))
    assert _routes(_settings(ai_primary_provider=provider, ai_task_model_overrides=value)) == today


# --- 2. It moves only what it names --------------------------------------------------------------


def test_an_override_names_the_chain_and_wins_over_claude_first():
    settings = _settings(ai_task_model_overrides=LITE_THEN_HAIKU)
    # Today, Claude first: Haiku, then the cheap tier's Gemini model.
    assert model_chain(CLASSIFY, _settings()) == ["claude-haiku-4-5", "gemini-2.5-flash-lite"]
    # Overridden: Flash-Lite first, Haiku the fallback — in the router's own chain.
    assert resolve_model(CLASSIFY, settings) == "gemini-2.5-flash-lite"
    assert get_route(CLASSIFY, settings).fallback_model == "claude-haiku-4-5"
    assert model_chain(CLASSIFY, settings) == ["gemini-2.5-flash-lite", "claude-haiku-4-5"]
    assert AIRouter(settings)._candidate_models("gemini-2.5-flash-lite", "claude-haiku-4-5") == [
        "gemini-2.5-flash-lite",
        "claude-haiku-4-5",
    ]


def test_haiku_5_5_is_accepted_and_resolves():
    settings = _settings(ai_task_model_overrides=f"{CLASSIFY}=claude-haiku-5-5")
    assert task_model_overrides(settings).rejected == ()
    assert resolve_model(CLASSIFY, settings) == "claude-haiku-5-5"
    assert "claude-haiku-5-5" in OVERRIDE_MODELS


def test_it_keeps_every_number_on_the_route():
    before = get_route(CLASSIFY, _settings())
    after = get_route(CLASSIFY, _settings(ai_task_model_overrides=LITE_THEN_HAIKU))
    for field in (
        "task_type",
        "tier",
        "max_output_tokens",
        "temperature",
        "json_mode",
        "max_retries",
        "timeout_seconds",
    ):
        assert getattr(after, field) == getattr(before, field), field


def test_every_other_task_is_untouched():
    today = _routes(_settings())
    moved = _routes(_settings(ai_task_model_overrides=LITE_THEN_HAIKU))
    changed = {task for task in _ROUTE_SHAPES if moved[task] != today[task]}
    assert changed == {CLASSIFY}


def test_one_model_keeps_the_routers_global_fallback():
    settings = _settings(ai_task_model_overrides="profile_parse=gemini-2.5-flash")
    assert get_route("profile_parse", settings).fallback_model is None
    assert model_chain("profile_parse", settings) == ["gemini-2.5-flash", "claude-haiku-4-5"]


def test_the_same_model_twice_names_no_fallback():
    parsed = parse_task_model_overrides(f"{CLASSIFY}=claude-haiku-4-5>claude-haiku-4-5")
    assert parsed.by_task[CLASSIFY].fallback_model is None
    # The global fallback is Claude too, so the router adds nothing: one model, honestly.
    settings = _settings(ai_task_model_overrides=f"{CLASSIFY}=claude-haiku-4-5>claude-haiku-4-5")
    assert model_chain(CLASSIFY, settings) == ["claude-haiku-4-5"]


def test_a_route_that_names_its_own_model_can_move():
    # The free-chat reply and the career answer ride DEFAULT_CAREER_MODEL, which the box cannot
    # set from compose today; an override is how they move.
    value = "profiling_free_reply=gemini-2.5-flash-lite>claude-haiku-4-5"
    settings = _settings(ai_task_model_overrides=value)
    assert model_chain("profiling_free_reply", settings) == [
        "gemini-2.5-flash-lite",
        "claude-haiku-4-5",
    ]
    assert get_route("profiling_free_reply", settings).temperature == 0.5


def test_whitespace_and_several_entries():
    value = (
        f" {CLASSIFY} = gemini-2.5-flash-lite > claude-haiku-4-5 , profile_parse=gemini-2.5-flash "
    )
    parsed = parse_task_model_overrides(value)
    assert {task: astuple(row) for task, row in parsed.by_task.items()} == {
        CLASSIFY: ("gemini-2.5-flash-lite", "claude-haiku-4-5"),
        "profile_parse": ("gemini-2.5-flash", None),
    }
    assert parsed.rejected == ()


# --- 3. A bad entry never moves anything ---------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "reason"),
    [
        ("profiling_free_classify", "not task=model"),
        ("=gemini-2.5-flash-lite", "not task=model"),
        ("no_such_task=gemini-2.5-flash-lite", "unknown task"),
        ("profiling_free_news=gemini-2.5-flash-lite", "this task's model cannot change"),
        (f"{CLASSIFY}=", "empty model"),
        (f"{CLASSIFY}=gemini-2.5-flash-lite>", "empty model"),
        (
            f"{CLASSIFY}=gemini-2.5-flash-lite>claude-haiku-4-5>gemini-2.5-flash",
            "more than one fallback",
        ),
        # Rejects the thinking budget our client sends.
        (f"{CLASSIFY}=gemini-2.5-pro", "model not in OVERRIDE_MODELS"),
        # An embedding model, and a model id spelled the way no provider accepts.
        (f"{CLASSIFY}=gemini-embedding-001", "model not in OVERRIDE_MODELS"),
        (f"{CLASSIFY}=Gemini-2.5-Flash-Lite", "model not in OVERRIDE_MODELS"),
    ],
)
def test_a_bad_entry_is_refused_and_moves_nothing(value, reason):
    parsed = parse_task_model_overrides(value)
    assert dict(parsed.by_task) == {}
    assert [row[1] for row in parsed.rejected] == [reason]
    assert _routes(_settings(ai_task_model_overrides=value)) == _routes(_settings())


def test_a_task_named_twice_gets_no_override_even_if_one_line_is_good():
    value = f"{CLASSIFY}=gemini-2.5-flash-lite,{CLASSIFY}=gemini-2.5-flash"
    parsed = parse_task_model_overrides(value)
    assert dict(parsed.by_task) == {}
    assert parsed.rejected == ((CLASSIFY, "named more than once"),)
    # And with a refused first line, the good second one still does not apply.
    parsed = parse_task_model_overrides(f"{CLASSIFY}=gemini-2.5-pro,{CLASSIFY}=gemini-2.5-flash")
    assert dict(parsed.by_task) == {}


def test_one_bad_entry_does_not_cost_the_good_ones():
    value = f"no_such_task=gemini-2.5-flash,{LITE_THEN_HAIKU}"
    parsed = parse_task_model_overrides(value)
    assert set(parsed.by_task) == {CLASSIFY}
    assert parsed.rejected == (("no_such_task", "unknown task"),)


def test_the_news_answer_never_moves():
    assert "profiling_free_news" in NON_OVERRIDABLE_TASKS
    settings = _settings(ai_task_model_overrides="profiling_free_news=gemini-2.5-flash-lite")
    news = get_route("profiling_free_news", settings)
    assert (news.model, news.fallback_model) == ("claude-haiku-4-5", None)


def test_a_refusal_is_logged_once_with_the_entry_and_the_reason(caplog):
    settings = _settings(ai_task_model_overrides=f"no_such_task=gemini-2.5-flash,{LITE_THEN_HAIKU}")
    with caplog.at_level(logging.WARNING, logger="app.ai.model_config"):
        for _ in range(3):
            task_model_overrides(settings)
            get_route(CLASSIFY, settings)
    records = [r for r in caplog.records if r.getMessage() == "ai_task_model_override.rejected"]
    assert len(records) == 1
    assert records[0].extra == {"entry": "no_such_task", "reason": "unknown task"}


def test_every_model_an_override_may_name_is_priced_and_routable():
    # An unpriced model under-reads spend (the caps stop tripping); a model with no transport
    # fails every call. Both are refused by construction, and this holds the list to it.
    for model in OVERRIDE_MODELS:
        assert model in _MODEL_RATES_INR, model
        assert _MODEL_RATES_INR[model][1] > 0, f"{model} has no output price"
        assert provider_for_model(model) in ("google", "anthropic"), model


# --- 4. The fallback answers in the same request ------------------------------------------------


def _stub_dispatcher(monkeypatch, behavior):
    seen: list[str] = []

    async def _complete(*, model, **_kwargs):
        seen.append(model)
        action = behavior[model]
        return action() if callable(action) else action

    monkeypatch.setattr(router_module.providers, "complete", _complete)
    return seen


def test_flash_lite_first_and_haiku_answers_when_it_fails(monkeypatch, fresh_ledger):
    def _lite_fails():
        raise RuntimeError("flash-lite boom")

    seen = _stub_dispatcher(
        monkeypatch,
        {
            "gemini-2.5-flash-lite": _lite_fails,
            "claude-haiku-4-5": LlmResult(
                content='{"category": "chat"}', input_tokens=9, output_tokens=4
            ),
        },
    )
    router = AIRouter(_settings(ai_task_model_overrides=LITE_THEN_HAIKU))
    content, meta = asyncio.run(
        router.run(CLASSIFY, messages=[{"role": "user", "content": "kaise ho"}], mock_response="m")
    )
    assert content == '{"category": "chat"}'
    # The route's own retries run on Flash-Lite first (unchanged by the override), then Haiku.
    assert list(dict.fromkeys(seen)) == ["gemini-2.5-flash-lite", "claude-haiku-4-5"]
    assert seen[-1] == "claude-haiku-4-5"
    assert meta.model_name == "claude-haiku-4-5"
    assert meta.candidates_tried == ["gemini-2.5-flash-lite", "claude-haiku-4-5"]


def test_flash_lite_serves_when_healthy(monkeypatch, fresh_ledger):
    seen = _stub_dispatcher(
        monkeypatch,
        {"gemini-2.5-flash-lite": LlmResult(content="LITE_OK", input_tokens=9, output_tokens=2)},
    )
    router = AIRouter(_settings(ai_task_model_overrides=LITE_THEN_HAIKU))
    content, meta = asyncio.run(
        router.run(CLASSIFY, messages=[{"role": "user", "content": "kaise ho"}], mock_response="m")
    )
    assert (content, meta.model_name, seen) == (
        "LITE_OK",
        "gemini-2.5-flash-lite",
        ["gemini-2.5-flash-lite"],
    )


# --- The report ----------------------------------------------------------------------------------


def test_the_flags_report_shows_the_chain_in_force_and_the_refusals():
    module = runpy.run_path(str(FLAGS_SCRIPT), run_name="__not_main__")
    report = module["model_chains"](
        _settings(ai_task_model_overrides=f"no_such_task=gemini-2.5-flash,{LITE_THEN_HAIKU}")
    )
    assert report["chains"][CLASSIFY] == {
        "models": ["gemini-2.5-flash-lite", "claude-haiku-4-5"],
        "override": True,
    }
    assert report["chains"]["profile_parse"]["override"] is False
    assert set(report["chains"]) == set(_ROUTE_SHAPES)
    assert report["override_rejected"] == [["no_such_task", "unknown task"]]
    assert "AI_TASK_MODEL_OVERRIDES" in module["TRACKED"]
