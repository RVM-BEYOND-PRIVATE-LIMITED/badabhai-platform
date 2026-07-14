"""Prompt-cache guard tests (COST-2).

The static persona / extraction system block is marked cacheable ONLY when it
clears the provider's minimum cacheable size; below that a cache directive is a
silent no-op, so we skip it and emit a diagnostic. Only static prompt text is ever
cached — never a worker message or name (SG-1).
"""

from __future__ import annotations

import logging

from app.ai import model_config
from app.ai.anthropic_client import _anthropic_system_param, _to_anthropic_request
from app.ai.gemini_client import _to_gemini_request

# A block that clears every provider minimum (~6.5k tokens); and one far below it.
_BIG_SYSTEM = "You are a helpful shop-floor mentor. " * 700
_SMALL_SYSTEM = "You are Bada Bhai."  # a few tokens — below every provider minimum

# A realistic chat message list: stable persona + worker turn + per-turn question.
_CHAT_MESSAGES = [
    {"role": "system", "content": _BIG_SYSTEM},
    {"role": "user", "content": "abhi VMC chalata hu"},
    {"role": "system", "content": "Ask exactly this question: Kitne saal?"},
]


# --- The shared decision: cacheable iff the block clears the min (min is a param) -
def test_should_cache_system_is_true_iff_block_clears_the_min():
    # "mock the min" by passing arbitrary thresholds — the flag flips at the boundary.
    assert model_config.should_cache_system(_SMALL_SYSTEM, 1) is True
    assert model_config.should_cache_system(_SMALL_SYSTEM, 10_000) is False
    assert model_config.should_cache_system(_BIG_SYSTEM, model_config.GEMINI_CACHE_MIN_TOKENS)
    assert model_config.should_cache_system(_BIG_SYSTEM, model_config.ANTHROPIC_CACHE_MIN_TOKENS)


# --- Anthropic: cache_control breakpoint present iff ≥ min, on the STABLE block ---
def test_anthropic_marks_only_the_stable_block_cacheable_when_over_min():
    param = _anthropic_system_param([_BIG_SYSTEM, "per-turn instruction: Kitne saal?"])
    assert isinstance(param, list)  # structured blocks, not a plain string
    # Only the FIRST (stable) block carries the ephemeral cache breakpoint…
    assert param[0]["cache_control"] == {"type": "ephemeral"}
    assert param[0]["text"] == _BIG_SYSTEM
    # …the per-turn instruction block is present but NOT cached (its text changes).
    assert "cache_control" not in param[1]


def test_anthropic_skips_cache_and_logs_diagnostic_when_under_min(caplog):
    with caplog.at_level(logging.INFO):
        param = _anthropic_system_param([_SMALL_SYSTEM, "per-turn instruction"])
    assert isinstance(param, str)  # plain string, no directive
    assert "cache_control" not in param
    assert any("below cache minimum" in r.getMessage() for r in caplog.records)


def test_anthropic_cached_block_contains_no_worker_message_or_name():
    # SG-1: the cache_control block holds ONLY the static system text — never the
    # worker's turn or a name. Build from the full chat message list end-to-end.
    system_texts, msgs = _to_anthropic_request(_CHAT_MESSAGES, json_mode=True)
    param = _anthropic_system_param(system_texts)
    cached_text = param[0]["text"]  # the sole cache_control block
    assert cached_text == _BIG_SYSTEM  # exactly the stable persona, nothing more
    assert "VMC chalata hu" not in cached_text  # the worker message is not cached
    # The worker message stays in `messages`, never inside the cached system block.
    assert any(m["role"] == "user" and "VMC chalata hu" in m["content"] for m in msgs)


# --- Gemini: diagnostic reflects eligibility; no explicit-cache field fabricated --
def test_gemini_logs_skip_diagnostic_and_adds_no_cache_field_when_under_min(caplog):
    with caplog.at_level(logging.INFO):
        body = _to_gemini_request(
            [{"role": "system", "content": _SMALL_SYSTEM}, {"role": "user", "content": "hi"}],
            max_output_tokens=48,
            temperature=0.3,
            json_mode=False,
        )
    assert "cachedContent" not in body  # no explicit-cache resource fabricated
    assert any("below cache minimum" in r.getMessage() for r in caplog.records)


def test_gemini_logs_eligible_diagnostic_when_over_min(caplog):
    with caplog.at_level(logging.INFO):
        _to_gemini_request(
            [{"role": "system", "content": _BIG_SYSTEM}, {"role": "user", "content": "hi"}],
            max_output_tokens=48,
            temperature=0.3,
            json_mode=False,
        )
    assert any("eligible" in r.getMessage().lower() for r in caplog.records)
