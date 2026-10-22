"""Audit fix F4 — `resume_option_map` gets its own output budget, defaulting to today's 1024.

WHY IT MOVED OFF THE SHARED KNOB. #1674 left the option map on `ai_extraction_max_output_tokens`
because its output scales with the pack rather than the uploaded document, and judged it not at
risk. Measured on 2026-10-21 it was at risk: a complete mapping for a trade pack (one object per
question, each with a cited quote) runs about 1,400-1,600 tokens, and the shared 1024 cut it off
in 3 of 3 audit uploads and 6 of 45 production calls. A cut-off reply has no closing brace, so
the whole mapping is lost: the call is billed and autofill never applies.

WHAT THESE PIN:
  - the route reads its OWN knob, not the shared extraction one;
  - the committed default is 1024, so merging this changes nothing; raising it is a box setting;
  - the env var overrides it, so the box CAN raise it;
  - nothing else about the route moved (temperature 0, strict JSON, capable tier, retries);
  - the recommended armed value (2048) still clears the per-call spend ceiling, so raising it
    cannot silently turn the call into a mock fallback.
"""

from __future__ import annotations

import pytest

from app.ai.cost_tracker import estimate_cost_inr, estimate_tokens
from app.ai.model_config import get_route, resolve_model
from app.config import Settings
from app.resume_import.extract import DEFAULT_LIMITS
from app.resume_import.resume_option_map import RESUME_OPTION_MAP_TASK_TYPE

_ENV_VAR = "AI_RESUME_OPTION_MAP_MAX_OUTPUT_TOKENS"

# Today's value, which the default must keep: the shared extraction budget the route read before.
TODAYS_BUDGET = 1024
# The value the owner is advised to arm on the box: ~1.3x the measured complete reply (1,600),
# and the same number #1674 chose for the parse.
RECOMMENDED_ARMED_BUDGET = 2048
MEASURED_COMPLETE_REPLY_MAX_TOKENS = 1600


def _settings(**over) -> Settings:
    """Settings with the dotenv closed; tests asserting the DEFAULT also delete the conftest pin."""
    return Settings(_env_file=None, **over)


def _budgets(settings: Settings) -> tuple[int, int]:
    """``(shared extraction budget, option-map budget)`` as plain ints, so a failed assertion
    prints numbers and never the credential-bearing ``Settings`` model (§2)."""
    return (
        settings.ai_extraction_max_output_tokens,
        settings.ai_resume_option_map_max_output_tokens,
    )


@pytest.fixture
def unpinned_env(monkeypatch):
    monkeypatch.delenv(_ENV_VAR, raising=False)


def test_the_option_map_reads_its_own_budget_not_the_shared_extraction_one():
    # The two knobs get DIFFERENT values on purpose: equal (as on a default box), this would hold
    # whichever field the route read, and pass against the code it is meant to reject.
    settings = _settings(
        ai_extraction_max_output_tokens=1024,
        ai_resume_option_map_max_output_tokens=3000,
    )
    shared, own = _budgets(settings)
    route = get_route(RESUME_OPTION_MAP_TASK_TYPE, settings)
    assert route.max_output_tokens == own == 3000
    assert route.max_output_tokens != shared


def test_the_committed_default_is_todays_1024(unpinned_env):
    """Merging changes nothing: the route gets exactly the budget it had on the shared knob."""
    assert _settings().ai_resume_option_map_max_output_tokens == TODAYS_BUDGET


def test_the_box_can_raise_it(monkeypatch):
    monkeypatch.setenv(_ENV_VAR, str(RECOMMENDED_ARMED_BUDGET))
    budget = Settings(_env_file=None).ai_resume_option_map_max_output_tokens
    assert budget == RECOMMENDED_ARMED_BUDGET


def test_only_the_budget_moved_and_the_rest_of_the_route_is_untouched():
    """VACUITY GUARD: temperature 0, strict JSON, the capable tier and the shared retry count are
    load-bearing for a citation task, and none of them was in scope."""
    settings = _settings(ai_resume_temperature=0.4)
    route = get_route(RESUME_OPTION_MAP_TASK_TYPE, settings)
    assert route.temperature == 0.0
    assert route.json_mode is True
    assert route.tier == "capable"
    assert route.max_retries == settings.ai_extraction_max_retries


def test_todays_budget_is_below_a_complete_reply_and_the_recommended_one_is_above():
    """The defect and the fix, as numbers: 1024 cannot hold a complete trade-pack mapping, so the
    reply is cut off and discarded; 2048 holds the largest measured one with headroom."""
    assert TODAYS_BUDGET < MEASURED_COMPLETE_REPLY_MAX_TOKENS
    assert RECOMMENDED_ARMED_BUDGET > 1.25 * MEASURED_COMPLETE_REPLY_MAX_TOKENS


def test_the_budget_needs_no_contract_change():
    field = Settings.model_fields["ai_resume_option_map_max_output_tokens"]
    bounds = {type(m).__name__: getattr(m, "ge", getattr(m, "le", None)) for m in field.metadata}
    assert bounds.get("Ge") == 16
    assert bounds.get("Le") == 8192
    assert 16 <= RECOMMENDED_ARMED_BUDGET <= 8192


@pytest.mark.parametrize("model", ["routed", "claude-haiku-4-5"])
def test_the_armed_budget_still_clears_the_per_call_spend_ceiling(unpinned_env, model):
    """The router checks the WORST case against `ai_max_call_cost_inr` before every real call.
    A budget that pushed it over would not overspend; it would skip the call and fall to mock,
    i.e. autofill would silently stop. Checked for the routed tier model and for Claude Haiku
    4.5, which is the dearest model production runs this route on (Claude first, #2170).

    Worst-case input: every line `extract()` keeps, plus generous room for the pack's questions
    and options, which ride in the same prompt.
    """
    settings = _settings(ai_resume_option_map_max_output_tokens=RECOMMENDED_ARMED_BUDGET)
    model_id = resolve_model(RESUME_OPTION_MAP_TASK_TYPE, settings) if model == "routed" else model
    worst_input_tokens = estimate_tokens("x" * (DEFAULT_LIMITS.max_total_chars + 20_000))
    worst_case_inr = estimate_cost_inr(model_id, worst_input_tokens, RECOMMENDED_ARMED_BUDGET)
    assert worst_case_inr < settings.ai_max_call_cost_inr
