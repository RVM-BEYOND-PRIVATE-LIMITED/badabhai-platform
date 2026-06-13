"""Per-field extraction eval harness — measurement-correctness + real gate.

Extends the SINGLE canonicalization gold set (``app.profiling.canonicalization_gold``)
to score EVERY extracted field, not just the role:

  trade / role        exact match on the taxonomy id
  skills / machines   subset (all expected ids present; extras allowed)
  experience          years within EXPERIENCE_TOLERANCE_YEARS (None = no exp)

Two layers, mirroring the existing role eval:

- **Default (CI / local, no key):** structural + measurement-correctness tests on
  the deterministic heuristic. These make NO network call and NO LLM call. They
  prove the rig MEASURES correctly (semantics, aggregate math, attribution),
  which is the real deliverable.
- **Real (staging only):** ``test_per_field_real_meets_threshold`` asserts the
  live ``/profile/extract`` clears the 90% per-field aggregate. It is SKIPPED
  unless real calls are actually enabled for ``profile_extraction`` AND a base
  URL is provided — so CI/local never makes a real call and stays green.

Miss attribution (TD3 over-masking vs extraction error) is tested against the
in-process gateway with fabricated inputs — no PII, no mapping inspection.
"""

from __future__ import annotations

import os

import pytest

from app.config import get_settings
from app.profiling import canonicalization_gold as gold
from app.profiling import miss_attribution as attrib


# --- Measurement correctness (no network, no LLM) --------------------------
def test_per_field_eval_runs_and_scores_every_field():
    """The rig produces a scored result for each field that has expectations."""
    result = gold.evaluate_per_field()
    # role is scored on every case; the others on cases that assert them.
    assert "role" in result.by_field
    assert "trade" in result.by_field
    assert "skills" in result.by_field
    assert "machines" in result.by_field
    assert "experience" in result.by_field
    for fr in result.by_field.values():
        assert fr.total > 0
        assert 0.0 <= fr.accuracy <= 1.0


def test_aggregate_is_micro_average_of_scored_pairs():
    """Aggregate hits/total equals the sum over every scored (case, field) pair."""
    result = gold.evaluate_per_field()
    expected_hits = sum(fr.hits for fr in result.by_field.values())
    expected_total = sum(fr.total for fr in result.by_field.values())
    assert result.aggregate_hits == expected_hits
    assert result.aggregate_total == expected_total
    assert result.aggregate_total == len(result.matches)


def test_trade_defaults_from_role_but_is_scored_exactly():
    """trade is derived from role unless overridden, and matched exactly."""
    # A core case with no explicit trade still gets a trade expectation.
    case = next(c for c in gold.GOLD_CASES if c.expected_role == "role_vmc_operator")
    assert case.resolved_trade() == "dom_vmc_machining"
    # Negative cases assert no trade.
    neg = next(c for c in gold.GOLD_CASES if c.tier == "negative")
    assert neg.resolved_trade() is None


def test_skills_use_subset_semantics_not_exact():
    """A profile with MORE skills than expected still counts as a skills hit."""

    class _P:
        canonical_trade_id = "dom_vmc_machining"
        canonical_role_id = "role_vmc_operator"
        skills = ["skill_fanuc", "skill_gdt_reading", "extra_skill"]
        machines = ["mach_vmc"]
        experience = None

    case = gold.GoldCase(
        "x", "role_vmc_operator", ("mach_vmc",), "core",
        expected_skills=("skill_fanuc",),
    )
    match = gold._score_skills(case, _P())
    assert match is not None and match.hit  # subset present despite extras


def test_experience_tolerance_is_applied():
    """Experience within the tolerance is a hit; outside it is a miss."""

    class _Exp:
        def __init__(self, y):
            self.total_years = y

    class _P:
        def __init__(self, y):
            self.experience = _Exp(y)

    case = gold.GoldCase("x", "role_vmc_operator", (), "core", expected_experience=5.0)
    assert gold._score_experience(case, _P(5.0)).hit
    assert gold._score_experience(case, _P(5.0 + gold.EXPERIENCE_TOLERANCE_YEARS)).hit
    assert not gold._score_experience(case, _P(5.0 + gold.EXPERIENCE_TOLERANCE_YEARS + 0.1)).hit
    assert not gold._score_experience(case, _P(None)).hit


def test_heuristic_passes_core_negative_per_field():
    """On the gating tiers the heuristic clears the per-field aggregate — the rig
    agrees with the existing role gate and the new fields don't regress it."""
    result = gold.evaluate_per_field(tiers=("core", "negative"))
    assert result.aggregate_accuracy >= gold.PER_FIELD_THRESHOLD, (
        f"core+negative per-field {result.aggregate_accuracy:.0%} "
        f"< {gold.PER_FIELD_THRESHOLD:.0%}; misses:\n"
        + "\n".join(m.as_miss_line() for m in result.misses)
    )


def test_hard_tier_is_the_unmet_bar_for_the_llm():
    """The heuristic does NOT clear the per-field bar overall (the hard tier is
    why the real LLM is needed). This documents the gap the staging run must close."""
    result = gold.evaluate_per_field()
    assert result.aggregate_accuracy < gold.PER_FIELD_THRESHOLD


# --- Miss attribution (TD3 over-masking vs extraction error) ----------------
def test_attribution_splits_every_miss():
    """Every miss is attributed to exactly one cause; counts sum to total misses."""
    result = gold.evaluate_per_field()
    summary = attrib.attribute_misses(result)
    assert len(summary.attributions) == len(result.misses)
    assert len(summary.over_masking) + len(summary.extraction_errors) == len(result.misses)


def test_surviving_anchor_is_extraction_error():
    """If the answer's anchor survives pseudonymization, the gateway is not the
    cause -> extraction error (model saw the evidence, mis-canonicalized it)."""
    match = gold.FieldMatch(
        text="vmc chalata hu", tier="hard", field="role",
        expected="role_vmc_operator", got=None, hit=False,
    )
    # Identity pseudonymizer: nothing masked -> anchor 'vmc' survives.
    a = attrib.attribute_match(match, pseudonymize_fn=lambda t: t)
    assert a.cause == attrib.EXTRACTION_ERROR
    assert "vmc" in a.surviving


def test_masked_anchor_is_over_masking_td3():
    """If the gateway removes the anchor that was in the source, it's TD3
    over-masking — the model never saw the evidence."""
    match = gold.FieldMatch(
        text="vmc chalata hu", tier="hard", field="role",
        expected="role_vmc_operator", got=None, hit=False,
    )
    # Stub gateway that masks 'vmc' (simulating over-masking of a technical term).
    a = attrib.attribute_match(match, pseudonymize_fn=lambda t: t.replace("vmc", "[X_1]"))
    assert a.cause == attrib.OVER_MASKING
    assert "vmc" in a.present_in_original
    assert a.surviving == ()


def test_attribution_uses_real_gateway_and_does_not_remove_tech_terms():
    """Sanity: the in-process gateway does NOT mask technical vocabulary, so a
    heuristic miss on present evidence is attributed to extraction, not masking."""
    result = gold.evaluate_per_field()
    summary = attrib.attribute_misses(result)
    # Every over-masking attribution must point at a term that was genuinely in
    # the source and genuinely removed (no false TD3 blame on spelling).
    for a in summary.over_masking:
        assert a.present_in_original and not a.surviving


# --- Real-mode gate (staging only; SKIPPED in CI/local) ---------------------
def _real_base_url() -> str | None:
    """The eval target URL, only when a real per-task LLM call is actually
    enabled for extraction. Returns None otherwise so the real test SKIPS and
    NEVER makes a real call in CI/local."""
    settings = get_settings()
    if not settings.real_call_enabled_for("profile_extraction"):
        return None
    return os.environ.get("AI_EVAL_BASE_URL")


@pytest.mark.skipif(
    _real_base_url() is None,
    reason="real profile_extraction calls not enabled (AI_ENABLE_REAL_CALLS + key + "
    "AI_REAL_CALL_TASKS=profile_extraction) or AI_EVAL_BASE_URL unset — "
    "staging-only; CI/local never makes a real call",
)
def test_per_field_real_meets_threshold():
    """STAGING ONLY. Asserts the LIVE /profile/extract clears the 90% per-field
    aggregate over the fabricated gold set, and reports the TD3 vs extraction
    miss split. Goes through the endpoint, which pseudonymizes first."""
    from app.profiling import eval_canonicalization as cli

    base_url = _real_base_url()
    assert base_url is not None  # guarded by skipif
    extract_fn = cli._make_real_field_extract_fn(base_url)
    pseudo_fn = cli._make_real_pseudonymize_fn(base_url)
    result = gold.evaluate_per_field(extract_fn)
    summary = attrib.attribute_misses(result, pseudonymize_fn=pseudo_fn)
    assert result.aggregate_accuracy >= gold.PER_FIELD_THRESHOLD, (
        f"real per-field aggregate {result.aggregate_accuracy:.0%} "
        f"< {gold.PER_FIELD_THRESHOLD:.0%}; "
        f"over-masking(TD3)={len(summary.over_masking)} "
        f"extraction_errors={len(summary.extraction_errors)}; misses:\n"
        + "\n".join(m.as_miss_line() for m in result.misses)
    )
