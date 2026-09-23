"""#1674 — `resume_parse` gets its own output budget, and the other three keep sharing one.

WHAT THESE PIN, and why the separation is the whole test rather than the number.

`ai_extraction_max_output_tokens` (1024) was shared by `profile_parse`, `resume_parse`,
`resume_profile_summary` and `resume_option_map`. Of those, `resume_parse` is the only one
whose reply size is decided by an UPLOADED DOCUMENT rather than by a shape this service
controls. Measured over 43 documents (method + distribution + caveats on
``ai_resume_parse_max_output_tokens`` in ``app/config.py``) the maximal contract-permitted
reply reached 1047 tokens worst case — over the shared cap, on the 2-page CV that opened
#1656.

A truncation here is FATAL PER DOCUMENT, not per field: the candidate has no closing brace,
so `coerce_json_text` finds nothing balanced and the whole parse is lost. #1663 made a
MALFORMED reply survivable per-entry; it did nothing for a truncated one.

So the failure mode these tests exist to catch is a future edit re-pointing `resume_parse`
back at the shared knob, or "tidying" the three that legitimately share it onto the new one —
either of which reads as harmless and silently re-couples two different distributions.
"""

from __future__ import annotations

import pytest

from app.ai.cost_tracker import estimate_cost_inr, estimate_tokens
from app.ai.model_config import get_route, resolve_model
from app.config import Settings
from app.resume_import.extract import DEFAULT_LIMITS
from app.resume_import.resume_parse import RESUME_PARSE_TASK_TYPE

_ENV_VAR = "AI_RESUME_PARSE_MAX_OUTPUT_TOKENS"

# The measurement recorded on #1674, restated here as the numbers this budget answers to.
# n = 43 documents, pretty-printed JSON, sized with `cost_tracker.estimate_tokens` (len // 4)
# so the units match the spend ledger's.
MEASURED_WORST_CASE_MAX_TOKENS = 1047
MEASURED_WORST_CASE_P95_TOKENS = 957
MEASURED_REALISTIC_MAX_TOKENS = 805
# The budget that could not fit the worst document, i.e. what this change moved away from.
OLD_SHARED_BUDGET = 1024


def _budgets(settings: Settings) -> tuple[int, int]:
    """``(shared extraction budget, resume-parse budget)`` as PLAIN INTS.

    Assertions compare these locals rather than ``settings.<field>`` on purpose: pytest prints
    every operand of a failed comparison, and a ``Settings`` operand renders the whole model —
    including the credential-bearing fields — into the test output. Same rule as
    ``test_config_env_anchor._redacted``: §2, a secret never reaches a log.
    """
    return settings.ai_extraction_max_output_tokens, settings.ai_resume_parse_max_output_tokens


def _settings(**over) -> Settings:
    """Settings built with the dotenv closed AND the pinned env var removed.

    `conftest._force_mock_only_env` pins ``AI_RESUME_PARSE_MAX_OUTPUT_TOKENS=2048`` for the
    whole suite (deliberately — a developer .env must not move the routing numbers). That pin
    would make an assertion about the COMMITTED DEFAULT pass vacuously, so the default tests
    below delete it rather than trusting it to agree.
    """
    return Settings(_env_file=None, **over)


@pytest.fixture
def unpinned_env(monkeypatch):
    monkeypatch.delenv(_ENV_VAR, raising=False)


# ---------------------------------------------------------------------------
# The separation — resume_parse off the shared knob, the other three still on it
# ---------------------------------------------------------------------------


def test_resume_parse_reads_its_own_budget_not_the_shared_extraction_one():
    # The two knobs are given DIFFERENT values on purpose: with them equal (as they are on a
    # default box) this assertion holds no matter which field the route reads, and the test
    # would pass against the code it is meant to reject.
    settings = _settings(
        ai_extraction_max_output_tokens=1024,
        ai_resume_parse_max_output_tokens=4096,
    )
    shared, own = _budgets(settings)
    route = get_route(RESUME_PARSE_TASK_TYPE, settings)
    assert route.max_output_tokens == own == 4096
    assert route.max_output_tokens != shared


@pytest.mark.parametrize(
    "task_type",
    ["profile_parse", "resume_profile_summary", "resume_option_map"],
)
def test_the_other_three_extraction_routes_still_share_the_extraction_budget(task_type):
    """Widening them would be an UNMEASURED change, which is the thing #1674 refused to do.

    `profile_parse` reads one finished interview; `resume_profile_summary` is a fixed-size
    object; `resume_option_map` scales with the pack, not the document. None of the three was
    measured and none is at risk, so they stay where they were.
    """
    settings = _settings(
        ai_extraction_max_output_tokens=1024,
        ai_resume_parse_max_output_tokens=4096,
    )
    shared, own = _budgets(settings)
    route = get_route(task_type, settings)
    assert route.max_output_tokens == shared
    assert route.max_output_tokens != own


def test_only_the_budget_moved_and_the_rest_of_the_route_is_untouched():
    """VACUITY GUARD on the change itself: temperature 0, strict JSON, capable tier and the
    shared retry count are all load-bearing for a citation task and none of them was in scope.
    A split that quietly dragged this route onto the resume-GENERATION defaults (temperature
    0.4) would still satisfy every budget assertion above."""
    settings = _settings(ai_resume_temperature=0.4)
    shared_retries = settings.ai_extraction_max_retries
    route = get_route(RESUME_PARSE_TASK_TYPE, settings)
    assert route.temperature == 0.0
    assert route.json_mode is True
    assert route.tier == "capable"
    assert route.max_retries == shared_retries


# ---------------------------------------------------------------------------
# The number: 2048, and where it comes from
# ---------------------------------------------------------------------------


def test_the_committed_default_is_2048(unpinned_env):
    budget = _settings().ai_resume_parse_max_output_tokens
    assert budget == 2048


def test_the_env_var_overrides_the_default(monkeypatch):
    monkeypatch.setenv(_ENV_VAR, "3072")
    budget = Settings(_env_file=None).ai_resume_parse_max_output_tokens
    assert budget == 3072


def test_the_default_clears_the_measured_worst_case_with_room(unpinned_env):
    """WHY 2048 AND NOT SOMETHING ELSE — the assertion that stops the next reader re-guessing.

    2048 is 1.96x the observed worst case (1047) and 2.14x worst-case p95 (957). The margin is
    the point, not the exact figure: `estimate_tokens` is `len // 4` and real tokenization of
    dense punctuated JSON is typically denser, so the measurement is likely an UNDERestimate,
    and a `machines` array with 4-6 values (the corpus reply carried one) adds more.
    """
    budget = _settings().ai_resume_parse_max_output_tokens
    assert budget >= 1.9 * MEASURED_WORST_CASE_MAX_TOKENS
    assert budget >= 2.0 * MEASURED_WORST_CASE_P95_TOKENS
    assert budget > MEASURED_WORST_CASE_MAX_TOKENS > MEASURED_WORST_CASE_P95_TOKENS
    assert MEASURED_WORST_CASE_P95_TOKENS > MEASURED_REALISTIC_MAX_TOKENS


def test_the_old_shared_budget_could_not_fit_the_worst_measured_document():
    """The regression this change closes, stated as an assertion rather than a claim: at 1024
    the worst document in the corpus had nowhere to put its last 23 tokens, and a truncated
    candidate loses the closing brace — so the cost is the WHOLE parse, not one field."""
    assert MEASURED_WORST_CASE_MAX_TOKENS > OLD_SHARED_BUDGET


def test_the_budget_needs_no_contract_change():
    """`le=8192` was already the bound, so 2048 moves nothing a caller can observe. If a future
    edit tightens this field's bounds under the chosen value the failure should name the
    contract, not show up as a boot error on a box."""
    field = Settings.model_fields["ai_resume_parse_max_output_tokens"]
    bounds = {type(m).__name__: getattr(m, "ge", getattr(m, "le", None)) for m in field.metadata}
    assert bounds.get("Ge") == 16
    assert bounds.get("Le") == 8192
    assert 16 <= 2048 <= 8192


# ---------------------------------------------------------------------------
# TD27 — a bigger ceiling is a bigger worst-case bill; check it, do not assume it
# ---------------------------------------------------------------------------


def test_the_worst_case_parse_still_fits_inside_the_per_call_spend_ceiling(unpinned_env):
    """`max_output_tokens` is a CEILING, not a reservation of real money — the extra tokens are
    billed only if the model emits them, and the router's pre-call worst-case reservation is
    refunded down to actual. But the router DOES check the worst case against
    `ai_max_call_cost_inr` before every real candidate, and a budget that pushed the projection
    past it would not overspend: it would skip every candidate and fall to mock, i.e. the
    feature would silently stop working. This asserts the largest prompt this route can build
    still clears that check.
    """
    settings = _settings()
    model = resolve_model(RESUME_PARSE_TASK_TYPE, settings)
    call_ceiling_inr = settings.ai_max_call_cost_inr
    user_daily_ceiling_inr = settings.ai_max_user_daily_cost_inr
    # The biggest prompt `extract()` can hand this route: every line it is willing to keep.
    worst_input_tokens = estimate_tokens("x" * DEFAULT_LIMITS.max_total_chars)
    worst_case_inr = estimate_cost_inr(
        model, worst_input_tokens, settings.ai_resume_parse_max_output_tokens
    )
    assert worst_case_inr < call_ceiling_inr
    # ...and it is not merely under by a rounding error: the headroom is the reason a longer
    # document does not quietly convert into a mock fallback.
    assert worst_case_inr < call_ceiling_inr / 2
    # One worst-case parse must also stay well inside ONE WORKER'S DAY (Rs 25), which bounds
    # every real AI call for that worker — an import spends this plus the summary and the
    # option map, and a re-import spends them again.
    assert worst_case_inr < user_daily_ceiling_inr / 10


def test_the_split_raises_the_worst_case_bill_by_a_known_amount(unpinned_env):
    """The cost of the change, measured rather than waved at: the delta is output-only, so it
    is exactly the extra ceiling priced at the model's output rate. Recorded so a future spend
    review can attribute it instead of rediscovering it."""
    settings = _settings()
    model = resolve_model(RESUME_PARSE_TASK_TYPE, settings)
    delta = estimate_cost_inr(
        model, 0, settings.ai_resume_parse_max_output_tokens
    ) - estimate_cost_inr(model, 0, settings.ai_extraction_max_output_tokens)
    # ~Rs 0.215 at gemini-2.5-flash output rates (Rs 0.21/1k), and only if the model actually
    # emits the extra tokens. Asserted as a bound, not an exact value, so a rate-table update
    # fails here loudly rather than silently changing what the comment claims.
    assert 0.0 < delta < 0.25
