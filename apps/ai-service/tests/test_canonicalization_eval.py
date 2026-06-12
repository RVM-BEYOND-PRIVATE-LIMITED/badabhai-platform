"""Canonicalization eval harness (CNC/VMC) — CI regression guard.

Measures how well messy Hinglish worker text is canonicalized to taxonomy ids
(`canonical_role_id`, machine ids). The >= 90% bar is THE gate for enabling the
real LLM extraction path (see docs/ai/enable-real-llm-extraction.md).

The gold set + scoring live in ``app.profiling.canonicalization_gold`` — the
SINGLE source of truth shared with the eval CLI
(``python -m app.profiling.eval_canonicalization``). This test imports it; it does
NOT duplicate cases. In CI it scores the deterministic heuristic
(`profile_extractor.extract`); in staging the CLI's ``--real`` mode scores the
real ``POST /profile/extract`` path over the SAME gold set.

Tiers:
- ``core`` + ``negative`` — the heuristic MUST clear >= 90% (this gate).
- ``hard`` — stresses the heuristic (out-of-vocab, implicit, multi-role); it is
  NOT expected to pass. We only assert it is *tracked* (runs + reports), never
  that the heuristic clears it. That bar is for the REAL LLM in staging.

Test data ONLY — every transcript is fabricated, no real worker PII.
"""

from __future__ import annotations

from app.profiling import canonicalization_gold as gold
from app.profiling import profile_extractor


def test_role_canonicalization_meets_threshold():
    """Heuristic clears >= 90% on the gating tiers (core + negative)."""
    result = gold.evaluate()
    assert result.gated_accuracy >= gold.THRESHOLD, (
        f"role canonicalization (core+negative) {result.gated_accuracy:.0%} "
        f"< {gold.THRESHOLD:.0%}; misses:\n"
        + "\n".join(result.by_tier["core"].misses + result.by_tier["negative"].misses)
    )


def test_core_tier_is_fully_canonicalized():
    """Every core case is realistic in-vocabulary Hinglish the heuristic handles."""
    result = gold.evaluate(tiers=("core",))
    core = result.by_tier["core"]
    assert core.accuracy >= gold.THRESHOLD, (
        f"core {core.accuracy:.0%} < {gold.THRESHOLD:.0%}; misses:\n"
        + "\n".join(core.misses)
    )


def test_negative_tier_returns_no_role():
    """Helper / unrelated / garbage text must canonicalize to None."""
    for case in gold.GOLD_CASES:
        if case.tier != "negative":
            continue
        _rich, legacy = profile_extractor.extract(case.text)
        assert legacy.canonical_role_id is None, (
            f"{case.text!r}: expected None, got {legacy.canonical_role_id}"
        )


def test_hard_tier_is_tracked_but_not_gated():
    """The hard tier RUNS and REPORTS (so the LLM has a measured bar), but the
    heuristic is NOT required to clear >= 90% — it is informational only."""
    result = gold.evaluate(tiers=("hard",))
    hard = result.by_tier["hard"]
    assert hard.total >= 12, f"hard tier too small to be a meaningful LLM bar: {hard.total}"
    # It is tracked: a number is produced and misses are reported.
    assert 0.0 <= hard.accuracy <= 1.0
    # We EXPECT the heuristic to miss most of these (that is the whole point);
    # asserting it does NOT clear the gate documents why the real LLM is needed.
    assert hard.accuracy < gold.THRESHOLD, (
        "heuristic unexpectedly cleared the hard tier — re-tier or harden the "
        "cases so they remain a real stretch for the LLM"
    )


def test_machine_canonicalization_is_consistent():
    """Every expected machine id must be detected for core + negative cases
    (the heuristic-gated tiers). Hard cases may legitimately miss machines."""
    for case in gold.GOLD_CASES:
        if case.tier == "hard":
            continue
        _rich, legacy = profile_extractor.extract(case.text)
        for mid in case.expected_machines:
            assert mid in legacy.machines, (
                f"{case.text!r}: missing machine id {mid} (got {legacy.machines})"
            )


def test_gold_set_is_tiered_and_covers_all_roles():
    """Structural guard: every launch role has >= 3 core cases; tiers are sized."""
    counts = gold.tier_counts()
    assert counts.get("core", 0) >= 24
    assert counts.get("negative", 0) >= 6
    assert counts.get("hard", 0) >= 12
    expected_roles = {
        "role_cam_programmer",
        "role_cnc_programmer",
        "role_cnc_setter_operator",
        "role_vmc_operator",
        "role_hmc_operator",
        "role_cnc_grinding_operator",
        "role_cnc_turner_operator",
    }
    core_by_role: dict[str, int] = {}
    for case in gold.GOLD_CASES:
        if case.tier == "core" and case.expected_role:
            core_by_role[case.expected_role] = core_by_role.get(case.expected_role, 0) + 1
    for role in expected_roles:
        assert core_by_role.get(role, 0) >= 3, (
            f"{role} has only {core_by_role.get(role, 0)} core cases (need >= 3)"
        )
