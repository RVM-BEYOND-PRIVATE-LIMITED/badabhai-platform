"""TAX-5 offline floor analysis (pytest -k wedge) — CI-safe: no network, no DB.

Consumes the COMMITTED scores snapshot (produced by the live pair embed_wedge.py →
score-wedge.ts on REAL vectors) and locks the calibration conclusions:

- the labeled set is structurally sound and fully covered by the snapshot;
- at the RECORDED floor (Settings.skill_canonicalize_floor): every exact-tier phrase
  assigns correctly, every negative + cross-domain phrase stays UNRESOLVED, and
  precision over the evaluable set is 1.0;
- the vernacular tier scores BELOW the floor (the RVM wedge aliases are genuinely
  required — after ratification+seed+embed, re-sweep and update the snapshot);
- the recorded floor sits inside the measured safe band (above the worst
  negative/confusion, below the first out-of-band true positive).

If a corpus/model change moves the space, re-run the live sweep and commit a new
snapshot — do NOT hand-edit scores or nudge the floor to green a case (overfit risk
named in the TAX-5 spec).
"""

from __future__ import annotations

import json
from pathlib import Path

from app.config import Settings

from .wedge_set import UNRESOLVED, WEDGE_SET

SNAPSHOT = Path(__file__).parent / "scores_2026_07_14.json"


def _load():
    data = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    by_key = {(c["phrase"], c["domain_id"]): c for c in data["cases"]}
    return data, by_key


def _predict(case_scores: dict, floor: float) -> str:
    cands = case_scores["candidates"]
    if not cands:
        return UNRESOLVED
    top = max(cands, key=lambda c: c["score"])
    return top["skill_id"] if top["score"] >= floor else UNRESOLVED


def test_wedge_set_is_fully_scored_on_real_vectors():
    data, by_key = _load()
    # The snapshot must come from the CONFIGURED model — a config model bump (exactly
    # what the text-embedding-004 retirement forced) makes this fail until a re-sweep
    # commits a fresh snapshot (#225 review M2: no silent cross-space calibration).
    assert data["model"] == Settings().embedding_model
    assert data["model"] != "mock-embedding"  # REAL space, not hash noise
    for case in WEDGE_SET:
        assert (case.phrase, case.domain_id) in by_key, f"unscored: {case.phrase}"
    assert len(data["cases"]) == len(WEDGE_SET)


def test_wedge_floor_is_the_recorded_config_default():
    # Test-case 3 of the TAX-5 spec: the calibrated value IS the shipped default.
    assert Settings().skill_canonicalize_floor == 0.75


def test_at_recorded_floor_exact_assigns_negatives_stay_unresolved():
    _, by_key = _load()
    floor = Settings().skill_canonicalize_floor
    for case in WEDGE_SET:
        pred = _predict(by_key[(case.phrase, case.domain_id)], floor)
        if case.tier == "exact":
            assert pred == case.expected, f"exact-tier miss at floor {floor}: {case.phrase}"
        elif case.tier in ("negative", "cross_domain"):
            assert pred == UNRESOLVED, f"{case.tier} FALSE ASSIGN at floor {floor}: {case.phrase}"


def test_precision_is_perfect_at_recorded_floor():
    _, by_key = _load()
    floor = Settings().skill_canonicalize_floor
    assigns = correct = 0
    for case in WEDGE_SET:
        if case.requires_wedge:
            continue  # vernacular is unassignable until the RVM aliases land
        pred = _predict(by_key[(case.phrase, case.domain_id)], floor)
        if pred != UNRESOLVED:
            assigns += 1
            if pred == case.expected:
                correct += 1
    assert assigns > 0
    assert correct == assigns, "an incorrect id was assigned at the recorded floor"


def test_vernacular_tier_is_below_floor_until_wedge_aliases_land():
    # The evidence FOR the RVM wedge: kharad/chhilai/ghisai/chudi score far below the
    # floor against the standards-only corpus. After ratification + seed + embed they
    # become exact-space matches — re-sweep then and UPDATE this test's expectation.
    _, by_key = _load()
    floor = Settings().skill_canonicalize_floor
    for case in WEDGE_SET:
        if not case.requires_wedge:
            continue
        pred = _predict(by_key[(case.phrase, case.domain_id)], floor)
        assert pred == UNRESOLVED, (
            f"vernacular '{case.phrase}' assigned WITHOUT wedge aliases — "
            "if the wedge just landed, re-sweep and update the snapshot + this test"
        )


def test_recorded_floor_sits_inside_the_measured_safe_band():
    _, by_key = _load()
    floor = Settings().skill_canonicalize_floor
    # Worst score any negative/cross-domain phrase achieves — the floor must clear it.
    worst_negative = max(
        max((c["score"] for c in by_key[(w.phrase, w.domain_id)]["candidates"]), default=0.0)
        for w in WEDGE_SET
        if w.tier in ("negative", "cross_domain")
    )
    # Worst WRONG-id top score among evaluable positives (sibling confusion ceiling).
    worst_confusion = 0.0
    for w in WEDGE_SET:
        if w.expected == UNRESOLVED or w.requires_wedge:
            continue
        cands = by_key[(w.phrase, w.domain_id)]["candidates"]
        if cands:
            top = max(cands, key=lambda c: c["score"])
            if top["skill_id"] != w.expected:
                worst_confusion = max(worst_confusion, top["score"])
    assert floor > worst_negative, "floor does not clear the negative ceiling"
    assert floor > worst_confusion, "floor does not clear the sibling-confusion ceiling"


def test_shipped_anchor_path_truth_is_disclosed_not_overclaimed():
    """#225 review M1: the 0.800 recall is DOMAIN-ORACLE recall (each phrase scored in
    its labeled domain). The SHIPPED wiring queries ONE anchor domain for every label
    until per-label domain resolution (TAX-6) — this test pins the shipped-path truth so
    the launch gate can't cite the oracle number for the path that actually runs:
    on this set, anchor-path recall is 0.35 (7/20) with ZERO false assigns, and the
    floor still clears the anchor-path negative ceiling."""
    data, by_key = _load()
    floor = Settings().skill_canonicalize_floor
    assert data["anchor_domain"] == "cnc-machining"

    correct = false_assigns = total = 0
    anchor_negative_ceiling = 0.0
    for case in WEDGE_SET:
        row = by_key[(case.phrase, case.domain_id)]
        cands = row["candidates_anchor"]
        top = max(cands, key=lambda c: c["score"]) if cands else None
        pred = top["skill_id"] if (top and top["score"] >= floor) else UNRESOLVED
        if case.expected == UNRESOLVED:
            if top:
                anchor_negative_ceiling = max(anchor_negative_ceiling, top["score"])
            assert pred == UNRESOLVED, f"anchor-path FALSE ASSIGN on negative: {case.phrase}"
            continue
        if case.requires_wedge:
            continue
        total += 1
        if pred == case.expected:
            correct += 1
        elif pred != UNRESOLVED:
            false_assigns += 1

    assert false_assigns == 0  # precision TRANSFERS to the shipped path
    assert correct / total == 0.35  # recall does NOT (7/20) — the honest shipped number
    assert floor > anchor_negative_ceiling  # 0.75 still clears the anchor ceiling (0.7263)
