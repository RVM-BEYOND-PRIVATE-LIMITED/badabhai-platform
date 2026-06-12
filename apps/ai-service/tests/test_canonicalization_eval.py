"""Canonicalization eval harness (CNC/VMC).

Measures how well messy worker text is canonicalized to taxonomy ids
(`canonical_role_id`, machine ids). Targets >= 90% — the bar for enabling the
real LLM extraction path (see docs/ai/enable-real-llm-extraction.md).

In CI this runs against the deterministic heuristics (`profile_extractor.extract`)
as a regression guard. The SAME `CASES` + `evaluate()` are reused in staging to
score the REAL LLM path: point `extract_fn` at a client that calls
`POST /profile/extract` with `AI_REAL_CALL_TASKS=profile_extraction`.

Test data ONLY — fabricated, no real worker PII.
"""

from __future__ import annotations

from collections.abc import Callable

from app.profiling import profile_extractor

# (messy text, expected canonical_role_id, expected machine ids subset)
CASES: list[tuple[str, str, list[str]]] = [
    ("vmc chalata hu 4 saal se fanuc pe", "role_vmc_operator", ["mach_vmc"]),
    ("cnc lathe operator hu, turning ka kaam", "role_cnc_turner_operator", ["mach_cnc_lathe"]),
    ("cnc programmer hu, mastercam pe program banata hu", "role_cnc_programmer", []),
    ("setter operator hu, vmc setting karta hu", "role_cnc_setter_operator", ["mach_vmc"]),
    ("hmc operator, horizontal machining 5 saal", "role_hmc_operator", ["mach_hmc"]),
    ("grinding operator, cylindrical grinding", "role_cnc_grinding_operator",
     ["mach_cylindrical_grinder"]),
    ("cam programmer hu, fusion 360 use karta hu", "role_cam_programmer", []),
    ("vmc operator, siemens control, 6 saal experience", "role_vmc_operator", ["mach_vmc"]),
    ("turner hu, cnc lathe pe 3 saal", "role_cnc_turner_operator", ["mach_cnc_lathe"]),
    ("vmc pe kaam karta hu, fanuc, gd&t aata hai", "role_vmc_operator", ["mach_vmc"]),
    ("programmer hu, g code editing karta hu fanuc pe", "role_cnc_programmer", []),
    ("vmc machine operator, tool offset setting karta hu", "role_vmc_operator", ["mach_vmc"]),
]

# Threshold for canonicalization accuracy (the >=90% bar from the task brief).
THRESHOLD = 0.90

# An extractor: text -> the legacy DraftProfile (carries the canonical ids).
ExtractFn = Callable[[str], object]


def _heuristic_extract(text: str):
    _rich, legacy = profile_extractor.extract(text)
    return legacy


def evaluate(extract_fn: ExtractFn = _heuristic_extract) -> tuple[float, list[str]]:
    """Return (role_canonicalization_accuracy, list of human-readable misses)."""
    hits = 0
    misses: list[str] = []
    for text, expected_role, _machines in CASES:
        profile = extract_fn(text)
        got = getattr(profile, "canonical_role_id", None)
        if got == expected_role:
            hits += 1
        else:
            misses.append(f"{text!r}: expected {expected_role}, got {got}")
    return hits / len(CASES), misses


def test_role_canonicalization_meets_threshold():
    accuracy, misses = evaluate()
    assert accuracy >= THRESHOLD, (
        f"role canonicalization {accuracy:.0%} < {THRESHOLD:.0%}; misses:\n" + "\n".join(misses)
    )


def test_machine_canonicalization_is_consistent():
    # Every expected machine id must be detected (no missing canonical machines).
    for text, _role, expected_machines in CASES:
        _rich, legacy = profile_extractor.extract(text)
        for mid in expected_machines:
            assert mid in legacy.machines, (
                f"{text!r}: missing machine id {mid} (got {legacy.machines})"
            )
