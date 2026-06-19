"""TD27 — cumulative spend cap + retry budget + kill-switch tests.

Mock-only, NO network. The real transport (``providers.complete``) is stubbed
exactly like ``test_ai_router.py``; real mode is constructed via ``Settings(
ai_enable_real_calls=True, gemini_flash_api_key="k", ...)``. An autouse fixture
resets the process-level ``SpendLedger`` singleton so its state never leaks
between tests.

These tests verify the new guards sit BEFORE ``providers.complete`` (the sole
network dispatch) with no bypass, fail closed to the deterministic mock, and
hold only PII-free data (numbers / model ids / dates).
"""

import asyncio

import pytest

from app.ai import cost_tracker
from app.ai import router as router_module
from app.ai.gemini_client import LlmResult
from app.ai.router import AIRouter
from app.config import Settings

_MESSAGES = [{"role": "user", "content": "vmc 4 saal"}]


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _reset_ledger():
    """Force a fresh, deterministic IN-PROCESS ledger before each test. These
    tests prove the in-process backend (the Redis backend has its own suite), so
    rebuild the singleton ignoring any ambient REDIS_URL / .env — otherwise a dev
    box whose root .env sets REDIS_URL would build a RedisSpendBackend that fails
    closed against an unreachable Redis. Also guarantees no cross-test state leak."""
    cost_tracker._ledger = cost_tracker.SpendLedger(Settings(_env_file=None, redis_url=None))
    yield
    cost_tracker._ledger = None


def _stub(monkeypatch, action):
    """Stub providers.complete; ``action`` is called (or returned) per dispatch.
    Returns a counter list recording each model dispatched. NO network."""
    seen: list[str] = []

    async def _complete(*, model, **_kwargs):
        seen.append(model)
        if callable(action):
            return action()
        return action

    monkeypatch.setattr(router_module.providers, "complete", _complete)
    return seen


def _real_settings(**overrides):
    base = dict(ai_enable_real_calls=True, gemini_flash_api_key="k")
    base.update(overrides)
    return Settings(**base)


# --- daily cap --------------------------------------------------------------

def test_daily_cap_blocks_before_network(monkeypatch):
    seen = _stub(monkeypatch, lambda: LlmResult("SHOULD_NOT_RUN", 1, 1))
    settings = _real_settings(ai_max_daily_cost_inr=1.0, ai_max_total_cost_inr=1_000_000.0)
    # Pre-load daily spend right up to the cap so any projected cost exceeds it.
    # With the reserve->reconcile model, "pre-loading" spend = RESERVING it.
    assert _run(cost_tracker.get_ledger().would_exceed_spend(1.0, settings)) is None

    router = AIRouter(settings)
    content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="DAILY_MOCK")
    )
    assert content == "DAILY_MOCK"
    assert meta.real_call is False
    assert meta.success is True
    assert meta.error_code == "daily_cap_exceeded"
    assert seen == []  # providers.complete was NEVER called


# --- cumulative cap ---------------------------------------------------------

def test_cumulative_cap_blocks_before_network(monkeypatch):
    seen = _stub(monkeypatch, lambda: LlmResult("SHOULD_NOT_RUN", 1, 1))
    # Daily cap generous; cumulative cap is the binding one.
    settings = _real_settings(ai_max_daily_cost_inr=1_000_000.0, ai_max_total_cost_inr=1.0)
    assert _run(cost_tracker.get_ledger().would_exceed_spend(1.0, settings)) is None

    router = AIRouter(settings)
    content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="CUMULATIVE_MOCK")
    )
    assert content == "CUMULATIVE_MOCK"
    assert meta.real_call is False
    assert meta.success is True
    assert meta.error_code == "cumulative_cap_exceeded"
    assert seen == []


# --- retry budget -----------------------------------------------------------

def test_retry_budget_bounds_attempts_across_runs(monkeypatch):
    def _always_fail():
        raise RuntimeError("provider boom")

    seen = _stub(monkeypatch, _always_fail)
    # Gemini-only chain (no anthropic key). profile_extraction max_retries=2 ->
    # up to 3 attempts/run (1 initial + 2 retries). Tiny retry budget caps the
    # cross-request retries. Wide caps so spend never blocks first.
    settings = _real_settings(
        ai_retry_budget_per_window=2,
        ai_retry_budget_window_seconds=300,
        ai_max_daily_cost_inr=1_000_000.0,
        ai_max_total_cost_inr=1_000_000.0,
    )
    router = AIRouter(settings)

    last_meta = None
    for _ in range(5):
        _c, last_meta = _run(
            router.run("profile_extraction", messages=_MESSAGES, mock_response="RETRY_MOCK")
        )

    # Total dispatches are bounded: budget of 2 retries are consumable in total;
    # every run still gets its 1 (budget-free) initial attempt. With 5 runs that
    # is at most 5 initial attempts + 2 budgeted retries = 7. It must be far
    # below the unbounded 5*3 = 15.
    assert len(seen) <= 7
    assert len(seen) < 15
    # The terminal run hit the network (initial attempt) then the budget on retry.
    assert last_meta.real_call is True
    assert last_meta.success is False
    assert last_meta.error_code == "retry_budget_exhausted"


def test_retry_budget_terminal_error_code(monkeypatch):
    def _always_fail():
        raise RuntimeError("boom")

    _stub(monkeypatch, _always_fail)
    settings = _real_settings(
        ai_retry_budget_per_window=0,  # no retries allowed at all
        ai_retry_budget_window_seconds=300,
        ai_max_daily_cost_inr=1_000_000.0,
        ai_max_total_cost_inr=1_000_000.0,
    )
    router = AIRouter(settings)
    _c, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="m")
    )
    assert meta.real_call is True  # initial attempt happened
    assert meta.error_code == "retry_budget_exhausted"


# --- kill switch ------------------------------------------------------------

def test_kill_switch_blocks_real_calls_independently(monkeypatch):
    seen = _stub(monkeypatch, lambda: LlmResult("SHOULD_NOT_RUN", 1, 1))
    settings = _real_settings(ai_real_calls_kill_switch=True)
    # Kill-switch wins over the flag+key: blocked reason is reported first.
    assert settings.real_calls_blocked_reason() == "kill switch engaged"
    assert settings.real_calls_enabled is False

    router = AIRouter(settings)
    content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="KILL_MOCK")
    )
    assert content == "KILL_MOCK"
    assert meta.real_call is False
    assert meta.success is True
    assert meta.error_code == "kill_switch_engaged"
    assert seen == []  # NO network call


# --- spend recorded on success ----------------------------------------------

def test_spend_recorded_on_successful_real_call(monkeypatch):
    _stub(monkeypatch, lambda: LlmResult(content="OK", input_tokens=10, output_tokens=5))
    settings = _real_settings(
        ai_max_daily_cost_inr=1_000_000.0, ai_max_total_cost_inr=1_000_000.0
    )
    ledger = cost_tracker.get_ledger()
    assert _run(ledger.snapshot(settings))["daily_spend_inr"] == 0.0

    router = AIRouter(settings)
    _content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="m")
    )
    assert meta.real_call is True
    assert meta.success is True
    snap = _run(ledger.snapshot(settings))
    assert snap["daily_spend_inr"] == pytest.approx(meta.estimated_cost_inr)
    assert snap["total_spend_inr"] == pytest.approx(meta.estimated_cost_inr)


# --- happy path under caps --------------------------------------------------

def test_real_call_proceeds_well_under_caps(monkeypatch):
    seen = _stub(monkeypatch, lambda: LlmResult(content="REAL_OK", input_tokens=8, output_tokens=2))
    settings = _real_settings(
        ai_max_daily_cost_inr=1_000_000.0, ai_max_total_cost_inr=1_000_000.0
    )
    router = AIRouter(settings)
    content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="m")
    )
    assert content == "REAL_OK"
    assert meta.real_call is True
    assert meta.success is True
    assert meta.error_code is None
    assert len(seen) == 1  # one dispatch, succeeded immediately


# --- no-PII -----------------------------------------------------------------

def test_snapshot_is_pii_free():
    settings = Settings()
    snap = _run(cost_tracker.get_ledger().snapshot(settings))
    assert set(snap.keys()) == {
        "daily_spend_inr", "daily_cap_inr", "total_spend_inr", "total_cap_inr",
        "user_daily_cap_inr", "tracked_users",
        "retry_window_count", "retry_budget_per_window", "kill_switch_engaged",
        "window_seconds", "day",
    }
    # Only numbers / bool / an ISO date string — never message text.
    for key, value in snap.items():
        if key == "day":
            assert isinstance(value, str)  # UTC ISO date, no PII
        else:
            assert isinstance(value, (int, float, bool))


def test_per_user_snapshot_is_pii_free():
    # A worker_ref is an OPAQUE id (no phone/name); the snapshot echoes it + the
    # user's spend number only. No message content.
    settings = Settings()
    snap = _run(cost_tracker.get_ledger().snapshot(settings, user_ref="worker-uuid-1"))
    assert snap["user_ref"] == "worker-uuid-1"
    assert snap["user_daily_spend_inr"] == 0.0
    assert isinstance(snap["user_daily_cap_inr"], (int, float))


def test_error_codes_are_structural_tokens():
    # Every TD27 terminal error_code is a fixed structural token (no PII).
    for code in (
        "daily_cap_exceeded", "cumulative_cap_exceeded", "user_daily_cap_exceeded",
        "retry_budget_exhausted", "kill_switch_engaged",
    ):
        assert code.replace("_", "").isalpha()


# --- per-user daily cap (Rs 6/user/day, all tasks share the budget) ---------

def test_per_user_cap_blocks_before_network(monkeypatch):
    seen = _stub(monkeypatch, lambda: LlmResult("SHOULD_NOT_RUN", 1, 1))
    # Tight per-user cap; global caps wide open so the per-user cap is the binding
    # one. Pre-load this user's daily spend up to the cap.
    settings = _real_settings(
        ai_max_user_daily_cost_inr=6.0,
        ai_max_daily_cost_inr=1_000_000.0,
        ai_max_total_cost_inr=1_000_000.0,
    )
    assert _run(
        cost_tracker.get_ledger().would_exceed_spend(6.0, settings, user_ref="worker-1")
    ) is None

    router = AIRouter(settings)
    content, meta = _run(
        router.run(
            "profile_extraction", messages=_MESSAGES, mock_response="USER_MOCK",
            user_ref="worker-1",
        )
    )
    assert content == "USER_MOCK"
    assert meta.real_call is False
    assert meta.success is True
    assert meta.error_code == "user_daily_cap_exceeded"
    assert seen == []  # NO network call


def test_per_user_cap_is_isolated_between_users(monkeypatch):
    # worker-1 is over budget; worker-2 (fresh) must still be able to call.
    seen = _stub(monkeypatch, lambda: LlmResult(content="REAL_OK", input_tokens=8, output_tokens=2))
    settings = _real_settings(
        ai_max_user_daily_cost_inr=6.0,
        ai_max_daily_cost_inr=1_000_000.0,
        ai_max_total_cost_inr=1_000_000.0,
    )
    assert _run(
        cost_tracker.get_ledger().would_exceed_spend(6.0, settings, user_ref="worker-1")
    ) is None

    router = AIRouter(settings)
    # worker-1 blocked
    _c1, m1 = _run(router.run(
        "profile_extraction", messages=_MESSAGES, mock_response="BLOCKED", user_ref="worker-1",
    ))
    # worker-2 proceeds
    c2, m2 = _run(router.run(
        "profile_extraction", messages=_MESSAGES, mock_response="m", user_ref="worker-2",
    ))
    assert m1.real_call is False and m1.error_code == "user_daily_cap_exceeded"
    assert c2 == "REAL_OK" and m2.real_call is True and m2.success is True
    assert len(seen) == 1  # only worker-2 reached the network; worker-1 was blocked


def test_per_user_cap_covers_all_tasks(monkeypatch):
    # The per-user budget is shared across chat + extraction + resume: spend from
    # one task pushes the SAME user over the cap for the next task.
    _stub(monkeypatch, lambda: LlmResult(content="OK", input_tokens=10, output_tokens=5))
    settings = _real_settings(
        ai_max_user_daily_cost_inr=6.0,
        ai_max_daily_cost_inr=1_000_000.0,
        ai_max_total_cost_inr=1_000_000.0,
    )
    # Pre-load the user just under the cap so the next call's worst-case exceeds it.
    assert _run(
        cost_tracker.get_ledger().would_exceed_spend(5.99, settings, user_ref="worker-9")
    ) is None
    router = AIRouter(settings)
    _c, meta = _run(router.run(
        "resume_generation", messages=_MESSAGES, mock_response="m", user_ref="worker-9",
    ))
    assert meta.real_call is False
    assert meta.error_code == "user_daily_cap_exceeded"


def test_no_user_ref_skips_per_user_cap(monkeypatch):
    # A call without a worker_ref is NOT subject to the per-user cap (only the
    # process-level backstops apply) — so the eval/anonymous path is unconstrained.
    seen = _stub(monkeypatch, lambda: LlmResult(content="REAL_OK", input_tokens=8, output_tokens=2))
    settings = _real_settings(
        ai_max_user_daily_cost_inr=0.000001,  # absurdly tight per-user cap
        ai_max_daily_cost_inr=1_000_000.0,
        ai_max_total_cost_inr=1_000_000.0,
    )
    router = AIRouter(settings)
    content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="m")  # no user_ref
    )
    assert content == "REAL_OK"
    assert meta.real_call is True
    assert len(seen) == 1


def test_per_user_spend_recorded_against_user_budget(monkeypatch):
    _stub(monkeypatch, lambda: LlmResult(content="OK", input_tokens=10, output_tokens=5))
    settings = _real_settings(
        ai_max_daily_cost_inr=1_000_000.0, ai_max_total_cost_inr=1_000_000.0
    )
    ledger = cost_tracker.get_ledger()
    router = AIRouter(settings)
    _c, meta = _run(router.run(
        "profile_extraction", messages=_MESSAGES, mock_response="m", user_ref="worker-7",
    ))
    snap = _run(ledger.snapshot(settings, user_ref="worker-7"))
    assert snap["user_daily_spend_inr"] == pytest.approx(meta.estimated_cost_inr)
    # A different user has no spend.
    assert _run(
        ledger.snapshot(settings, user_ref="worker-other")
    )["user_daily_spend_inr"] == 0.0
