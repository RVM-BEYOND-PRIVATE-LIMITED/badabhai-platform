"""Token-audit fix A3 — prompt-cache tokens, read on every call and priced at what they cost.

THE GAP. Anthropic reports its cache buckets apart from ``input_tokens``, and they were read only
for tool calls; Gemini's implicit-cache hits sit INSIDE ``promptTokenCount`` and were billed as
full-rate input. So a cached Claude call under-read its cost and a cached Gemini call over-read
it, and the cost record had no field that could say caching was happening at all.

THE RULE, pinned below:
  - ``input_tokens`` means the same on both providers: tokens billed at the full input rate;
  - the cache buckets ride beside it (``cache_creation_input_tokens``, ``cache_read_input_tokens``)
    and reach ``AICallMetadata`` as ``cache_write_tokens`` / ``cache_read_tokens``;
  - they are priced at each provider's multipliers (Anthropic: write 1.25x, read 0.1x; Gemini:
    read 0.1x, no write charge);
  - a call with no cache bucket is priced EXACTLY as before.

No test reaches the network.
"""

from __future__ import annotations

import asyncio

import pytest

from app.ai import cost_tracker
from app.ai import router as router_module
from app.ai.anthropic_client import _parse_anthropic_response
from app.ai.gemini_client import LlmResult, _parse_gemini_response
from app.ai.model_config import (
    ANTHROPIC_CACHE_READ_MULTIPLIER,
    ANTHROPIC_CACHE_WRITE_MULTIPLIER,
    GEMINI_CACHE_READ_MULTIPLIER,
    cache_multipliers,
    rate_inr_per_1k,
)
from app.ai.router import AIRouter
from app.config import Settings

# --- Parsing -------------------------------------------------------------------------------------


class _Block:
    def __init__(self, text):
        self.type = "text"
        self.text = text


class _Usage:
    def __init__(self, input_tokens, output_tokens, **cache):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        for name, value in cache.items():
            setattr(self, name, value)


class _Resp:
    def __init__(self, usage):
        self.content = [_Block("ok")]
        self.usage = usage


def test_anthropic_reads_its_cache_buckets_on_a_plain_text_call():
    result = _parse_anthropic_response(
        _Resp(_Usage(120, 30, cache_creation_input_tokens=900, cache_read_input_tokens=4000))
    )
    assert (result.input_tokens, result.output_tokens) == (120, 30)
    assert (result.cache_creation_input_tokens, result.cache_read_input_tokens) == (900, 4000)


@pytest.mark.parametrize(
    "cache", [{}, {"cache_creation_input_tokens": None}, {"cache_read_input_tokens": "x"}]
)
def test_anthropic_without_cache_buckets_reads_zero(cache):
    result = _parse_anthropic_response(_Resp(_Usage(120, 30, **cache)))
    assert (result.input_tokens, result.output_tokens) == (120, 30)
    assert (result.cache_creation_input_tokens, result.cache_read_input_tokens) == (0, 0)


def _gemini(usage):
    return {"candidates": [{"content": {"parts": [{"text": "ok"}]}}], "usageMetadata": usage}


def test_gemini_splits_implicit_cache_hits_out_of_the_prompt_count():
    result = _parse_gemini_response(
        _gemini(
            {"promptTokenCount": 1000, "candidatesTokenCount": 40, "cachedContentTokenCount": 600}
        )
    )
    # The full-rate part only, so `input_tokens` means what it means for Anthropic.
    assert result.input_tokens == 400
    assert result.cache_read_input_tokens == 600
    assert result.cache_creation_input_tokens == 0
    assert result.output_tokens == 40


@pytest.mark.parametrize(
    ("usage", "expected"),
    [
        ({"promptTokenCount": 1000, "candidatesTokenCount": 40}, (1000, 0)),
        (
            {"promptTokenCount": 1000, "candidatesTokenCount": 40, "cachedContentTokenCount": 0},
            (1000, 0),
        ),
        # A count that is not a sane integer is no hit, never a crash or a negative.
        ({"promptTokenCount": 1000, "cachedContentTokenCount": "600"}, (1000, 0)),
        ({"promptTokenCount": 1000, "cachedContentTokenCount": True}, (1000, 0)),
        ({"promptTokenCount": 1000, "cachedContentTokenCount": -5}, (1000, 0)),
        # More "cached" than prompt is clamped to the prompt: the input never goes negative.
        ({"promptTokenCount": 1000, "cachedContentTokenCount": 5000}, (0, 1000)),
    ],
)
def test_gemini_without_a_sane_hit_keeps_todays_counts(usage, expected):
    result = _parse_gemini_response(_gemini(usage))
    assert (result.input_tokens, result.cache_read_input_tokens) == expected


# --- Pricing -------------------------------------------------------------------------------------


def test_the_multipliers_per_provider():
    assert cache_multipliers("anthropic") == (
        ANTHROPIC_CACHE_WRITE_MULTIPLIER,
        ANTHROPIC_CACHE_READ_MULTIPLIER,
    )
    assert cache_multipliers("anthropic") == (1.25, 0.1)
    assert cache_multipliers("google") == (1.0, GEMINI_CACHE_READ_MULTIPLIER)
    assert GEMINI_CACHE_READ_MULTIPLIER == 0.1
    # An unknown provider prices cache at the full rate: it can over-read, never under-read.
    assert cache_multipliers("someone-else") == (1.0, 1.0)


def _cached(write=0, read=0, inp=100, out=20):
    return LlmResult(
        content="ok",
        input_tokens=inp,
        output_tokens=out,
        cache_creation_input_tokens=write,
        cache_read_input_tokens=read,
    )


@pytest.mark.parametrize(
    ("model", "write", "read", "write_x", "read_x"),
    [
        ("claude-haiku-4-5", 900, 4000, 1.25, 0.1),
        ("gemini-2.5-flash-lite", 0, 600, 1.0, 0.1),
        ("gemini-2.5-flash", 0, 2000, 1.0, 0.1),
    ],
)
def test_a_cached_call_is_priced_at_its_multipliers(model, write, read, write_x, read_x):
    in_rate, out_rate = rate_inr_per_1k(model)
    result = _cached(write=write, read=read)
    expected = round(
        round(100 / 1000 * in_rate + 20 / 1000 * out_rate, 4)
        + (write * write_x + read * read_x) * in_rate / 1000,
        4,
    )
    assert (
        cost_tracker.measured_call_cost_inr(model, result, input_tokens=100, output_tokens=20)
        == expected
    )
    assert cost_tracker.has_cache_tokens(result)


def test_a_call_with_no_cache_bucket_is_priced_exactly_as_before():
    result = _cached()
    assert not cost_tracker.has_cache_tokens(result)
    for model in ("claude-haiku-4-5", "gemini-2.5-flash-lite"):
        assert cost_tracker.measured_call_cost_inr(
            model, result, input_tokens=100, output_tokens=20
        ) == cost_tracker.estimate_cost_inr(model, 100, 20)


def test_a_cache_read_is_far_cheaper_than_the_same_tokens_at_the_full_rate():
    model = "gemini-2.5-flash-lite"
    full = cost_tracker.estimate_cost_inr(model, 1000, 0)
    cached = cost_tracker.measured_call_cost_inr(
        model, _cached(read=1000, inp=0, out=0), input_tokens=0, output_tokens=0
    )
    assert cached == pytest.approx(full * 0.1, abs=1e-4)


def test_the_tool_call_price_is_unchanged_for_anthropic():
    # The server-tool path now shares the helper; for Claude the numbers must not move.
    model = "claude-haiku-4-5"
    in_rate, _ = rate_inr_per_1k(model)
    result = LlmResult(
        content="ok",
        input_tokens=2500,
        output_tokens=300,
        search_requests=2,
        cache_creation_input_tokens=1000,
        cache_read_input_tokens=3000,
    )
    expected_tokens = cost_tracker.estimate_cost_inr(model, 2500, 300) + (
        1000 * 1.25 + 3000 * 0.1
    ) * (in_rate / 1000.0)
    # D13 moved the search fee behind `web_search_cost_inr()` so it can follow the configured
    # dollar basis; unset, it returns the same 0.83 the module constant held, so the assertion is
    # the one this test made before the two fixes met.
    expected = round(expected_tokens + 2 * cost_tracker.web_search_cost_inr(), 4)
    assert (
        cost_tracker.server_tool_call_cost_inr(model, result, input_tokens=2500, output_tokens=300)
        == expected
    )


# --- The metadata --------------------------------------------------------------------------------


def _meta(**extra):
    return cost_tracker.build_call_metadata(
        task_type="profiling_free_classify",
        model="gemini-2.5-flash-lite",
        real_call=True,
        input_tokens=10,
        output_tokens=2,
        latency_ms=5,
        success=True,
        settings=Settings(_env_file=None),
        **extra,
    )


def test_the_metadata_carries_the_buckets_and_defaults_to_not_reported():
    assert (_meta().cache_write_tokens, _meta().cache_read_tokens) == (None, None)
    meta = _meta(cache_write_tokens=0, cache_read_tokens=600)
    assert (meta.cache_write_tokens, meta.cache_read_tokens) == (0, 600)


# --- Through the router --------------------------------------------------------------------------


@pytest.fixture
def fresh_ledger():
    cost_tracker._ledger = cost_tracker.SpendLedger(
        Settings(_env_file=None, ai_spend_redis_url=None)
    )
    yield
    cost_tracker._ledger = None


def _router(monkeypatch, result: LlmResult) -> AIRouter:
    async def _complete(**_kwargs):
        return result

    monkeypatch.setattr(router_module.providers, "complete", _complete)
    return AIRouter(
        Settings(
            ai_enable_real_calls=True,
            gemini_flash_api_key="gem-key",
            anthropic_api_key=None,
            default_cheap_model="gemini-2.5-flash-lite",
            ai_primary_provider="google",
            ai_real_call_tasks="profiling_free_classify",
        )
    )


def _run(router: AIRouter):
    return asyncio.run(
        router.run(
            "profiling_free_classify",
            messages=[{"role": "user", "content": "kaise ho"}],
            mock_response="m",
        )
    )


def test_a_cached_call_through_the_router_carries_and_prices_its_buckets(monkeypatch, fresh_ledger):
    model = "gemini-2.5-flash-lite"
    result = _cached(read=600, inp=400, out=40)
    _content, meta = _run(_router(monkeypatch, result))
    assert meta.model_name == model
    assert (meta.input_tokens, meta.cache_write_tokens, meta.cache_read_tokens) == (400, 0, 600)
    assert meta.estimated_cost_inr == cost_tracker.measured_call_cost_inr(
        model, result, input_tokens=400, output_tokens=40
    )
    assert meta.estimated_cost_inr < cost_tracker.estimate_cost_inr(model, 1000, 40)


def test_an_uncached_call_through_the_router_is_priced_as_before(monkeypatch, fresh_ledger):
    model = "gemini-2.5-flash-lite"
    _content, meta = _run(_router(monkeypatch, _cached(inp=400, out=40)))
    assert (meta.cache_write_tokens, meta.cache_read_tokens) == (0, 0)
    assert meta.estimated_cost_inr == cost_tracker.estimate_cost_inr(model, 400, 40)


def test_a_fully_cached_prompt_is_not_also_estimated_at_the_full_rate(monkeypatch, fresh_ledger):
    # `input_tokens == 0` used to mean "the provider reported nothing — estimate it". With a cache
    # bucket reported, zero full-rate tokens is a real count, not a missing one.
    model = "gemini-2.5-flash-lite"
    result = _cached(read=1000, inp=0, out=40)
    _content, meta = _run(_router(monkeypatch, result))
    assert meta.input_tokens == 0
    assert meta.estimated_cost_inr == cost_tracker.measured_call_cost_inr(
        model, result, input_tokens=0, output_tokens=40
    )


def test_a_call_that_reported_nothing_is_still_estimated(monkeypatch, fresh_ledger):
    _content, meta = _run(_router(monkeypatch, _cached(inp=0, out=0)))
    assert meta.input_tokens > 0
    assert meta.cache_read_tokens == 0
