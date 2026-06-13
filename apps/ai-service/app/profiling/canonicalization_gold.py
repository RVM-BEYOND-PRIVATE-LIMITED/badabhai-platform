"""Tiered canonicalization gold set (CNC/VMC) — the single source of truth.

Measures how well messy Hinglish worker text is canonicalized to taxonomy ids
(``canonical_role_id`` + machine ids). The ``>= 90%`` bar here is THE bar for
turning on the real LLM extraction path (docs/ai/enable-real-llm-extraction.md).

This module is imported by BOTH the pytest regression test
(``tests/test_canonicalization_eval.py``) and the eval CLI
(``app/profiling/eval_canonicalization.py``) so there is exactly one gold set and
one ``evaluate()`` — never a duplicated copy that can drift.

Tiers
-----
- ``core``      : realistic, in-vocabulary Hinglish across all 7 launch roles.
                  The deterministic heuristic IS expected to canonicalize these
                  (>= 90%). This is the CI regression guard.
- ``negative``  : helper / unrelated trade / empty / garbage -> role is ``None``.
                  The heuristic IS expected to return ``None`` here.
- ``hard``      : out-of-vocab spellings, heavy code-switching, implicit roles
                  (described by tasks, role word absent), multi-role
                  disambiguation. These STRESS the heuristic and it is NOT
                  expected to pass them. They are the bar the REAL LLM must clear
                  in staging. Reported separately; they MUST NOT fail the CI gate.

PRIVACY: every transcript here is FABRICATED — invented Hinglish, no real worker
PII, no transcripts copied from production. Lives entirely inside the trusted
service. The ``--real`` eval path still goes through ``/profile/extract``, which
pseudonymizes before any model call; this gold set never bypasses that.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from app.profiling import profile_extractor

Tier = Literal["core", "negative", "hard"]

# The >= 90% bar from the task brief (and the runbook).
THRESHOLD = 0.90


@dataclass(frozen=True)
class GoldCase:
    """One fabricated canonicalization example.

    ``text``              fabricated Hinglish transcript (no PII).
    ``expected_role``     expected ``canonical_role_id`` (``None`` = no role).
    ``expected_machines`` machine ids that MUST be detected (subset check).
    ``tier``              core | negative | hard.
    """

    text: str
    expected_role: str | None
    expected_machines: tuple[str, ...]
    tier: Tier


# --- CORE: heuristic is expected to pass (>= 90%); the CI regression guard -----
# Every one of the 7 launch roles has >= 3 cases. Each was verified against
# ``profile_extractor.extract`` so CI stays green (see eval CLI / pytest).
_CORE: list[GoldCase] = [
    # role_cam_programmer (CAM Programmer) — keyword "cam programmer".
    GoldCase("cam programmer hu, fusion 360 use karta hu", "role_cam_programmer", (), "core"),
    GoldCase("cam programmer hu, surface modelling karta hu", "role_cam_programmer", (), "core"),
    GoldCase("experienced cam programmer, 7 saal fusion 360 pe", "role_cam_programmer", (),
             "core"),
    GoldCase("cam programmer hu mastercam aur fusion dono", "role_cam_programmer", (), "core"),
    # role_cnc_programmer (CNC Programmer) — keyword "programmer".
    GoldCase("cnc programmer hu, mastercam pe program banata hu", "role_cnc_programmer", (),
             "core"),
    GoldCase("programmer hu, g code editing karta hu fanuc pe", "role_cnc_programmer", (), "core"),
    GoldCase("cnc programmer hu, fanuc pe program editing", "role_cnc_programmer", (), "core"),
    GoldCase("senior cnc programmer, 8 saal ka experience", "role_cnc_programmer", (), "core"),
    # role_cnc_setter_operator (CNC Setter-Operator) — keyword "setter".
    GoldCase("setter operator hu, vmc setting karta hu", "role_cnc_setter_operator",
             ("mach_vmc",), "core"),
    GoldCase("cnc setter hu, machine setting karta hu", "role_cnc_setter_operator", (), "core"),
    GoldCase("setter hu, tool offset aur fixture setup karta hu", "role_cnc_setter_operator", (),
             "core"),
    GoldCase("cnc setter operator, 5 saal setting ka kaam", "role_cnc_setter_operator", (),
             "core"),
    # role_vmc_operator (VMC Operator) — keyword "vmc" (after programmer/setter).
    GoldCase("vmc chalata hu 4 saal se fanuc pe", "role_vmc_operator", ("mach_vmc",), "core"),
    GoldCase("vmc operator, siemens control, 6 saal experience", "role_vmc_operator",
             ("mach_vmc",), "core"),
    GoldCase("vmc pe kaam karta hu, fanuc, gd&t aata hai", "role_vmc_operator", ("mach_vmc",),
             "core"),
    GoldCase("vmc machine operator, tool offset setting karta hu", "role_vmc_operator",
             ("mach_vmc",), "core"),
    GoldCase("vmc operator hu, drawing padh leta hu", "role_vmc_operator", ("mach_vmc",), "core"),
    # role_hmc_operator (HMC Operator) — keyword "hmc".
    GoldCase("hmc operator, horizontal machining 5 saal", "role_hmc_operator", ("mach_hmc",),
             "core"),
    GoldCase("hmc chalata hu, horizontal machine pe kaam", "role_hmc_operator", ("mach_hmc",),
             "core"),
    GoldCase("main hmc operator hu fanuc pe", "role_hmc_operator", ("mach_hmc",), "core"),
    GoldCase("hmc operator, fanuc control, drawing reading aata hai", "role_hmc_operator",
             ("mach_hmc",), "core"),
    # role_cnc_grinding_operator (CNC Grinding Operator) — keyword "grinding".
    GoldCase("grinding operator, cylindrical grinding", "role_cnc_grinding_operator",
             ("mach_cylindrical_grinder",), "core"),
    GoldCase("cnc grinding operator hu, surface grinding karta hu", "role_cnc_grinding_operator",
             ("mach_cnc_grinder",), "core"),
    GoldCase("grinding machine chalata hu, cylindrical grind", "role_cnc_grinding_operator",
             ("mach_cylindrical_grinder",), "core"),
    GoldCase("cnc grinding operator, surface grinding 6 saal", "role_cnc_grinding_operator",
             ("mach_cnc_grinder",), "core"),
    # role_cnc_turner_operator (CNC Turner/Operator) — keyword "turner"/"turning"/"lathe".
    GoldCase("cnc lathe operator hu, turning ka kaam", "role_cnc_turner_operator",
             ("mach_cnc_lathe",), "core"),
    GoldCase("turner hu, cnc lathe pe 3 saal", "role_cnc_turner_operator", ("mach_cnc_lathe",),
             "core"),
    GoldCase("lathe operator, turning karta hu", "role_cnc_turner_operator", ("mach_cnc_lathe",),
             "core"),
    GoldCase("turning ka kaam karta hu cnc lathe pe", "role_cnc_turner_operator",
             ("mach_cnc_lathe",), "core"),
    GoldCase("cnc turner hu, lathe pe turning karta hu", "role_cnc_turner_operator",
             ("mach_cnc_lathe",), "core"),
]

# --- NEGATIVE: heuristic is expected to return None (scored WITH the gate) ------
_NEGATIVE: list[GoldCase] = [
    GoldCase("sirf helper hu", None, (), "negative"),
    GoldCase("main helper hu factory me", None, (), "negative"),
    GoldCase("welding ka kaam karta hu", None, (), "negative"),
    GoldCase("fitter hu, assembly line pe", None, (), "negative"),
    GoldCase("electrician hu, wiring karta hu", None, (), "negative"),
    GoldCase("kuch nahi aata abhi, naya hu", None, (), "negative"),
    GoldCase("hello bhai", None, (), "negative"),
    GoldCase("asdf qwer zxcv 1 2 3", None, (), "negative"),
]

# --- HARD: stresses the heuristic; the bar the REAL LLM must clear in staging ---
# These are NOT expected to pass on the heuristic — informational, never gated.
_HARD: list[GoldCase] = [
    # Out-of-vocab / misspelled role & machine words.
    GoldCase("vimmc chalata hu fanuc pe", "role_vmc_operator", ("mach_vmc",), "hard"),
    GoldCase("vmc machine wmc operator hu", "role_vmc_operator", ("mach_vmc",), "hard"),
    GoldCase("horizonta machine operator hu", "role_hmc_operator", ("mach_hmc",), "hard"),
    GoldCase("main programer hu cnc ka", "role_cnc_programmer", (), "hard"),
    GoldCase("cam programing karta hu mastercam pe", "role_cam_programmer", (), "hard"),
    GoldCase("grindr operator, round part ghisai", "role_cnc_grinding_operator", (), "hard"),
    # Implicit role — described by tasks, role keyword absent.
    GoldCase("vertical machining center chalata hu fanuc pe", "role_vmc_operator", ("mach_vmc",),
             "hard"),
    GoldCase("horizontal machining center operator hu", "role_hmc_operator", ("mach_hmc",),
             "hard"),
    GoldCase("round part ko ghisai karke size pe laata hu cylindrical pe",
             "role_cnc_grinding_operator", ("mach_cylindrical_grinder",), "hard"),
    GoldCase("cnc program banata hu, g-code likhta hu", "role_cnc_programmer", (), "hard"),
    GoldCase("cam software pe tool path banata hu cnc ke liye", "role_cam_programmer", (), "hard"),
    GoldCase("job ko round shape me ghumake katai karta hu", "role_cnc_turner_operator",
             ("mach_cnc_lathe",), "hard"),
    # Heavy code-switching / mixed English-Hindi-Hinglish.
    GoldCase("bhai i do milling on vertical centre, fanuc control samajhta hu",
             "role_vmc_operator", ("mach_vmc",), "hard"),
    GoldCase("mera kaam hai turning operation on lathe machine daily",
             "role_cnc_turner_operator", ("mach_cnc_lathe",), "hard"),
    # Multi-role disambiguation — what is the PRIMARY role?
    GoldCase("vmc chalata bhi hu aur set bhi karta hu, mainly setting ka kaam",
             "role_cnc_setter_operator", ("mach_vmc",), "hard"),
    GoldCase("program banata hu aur khud machine bhi set karta hu",
             "role_cnc_programmer", (), "hard"),
    GoldCase("pehle operator tha vmc pe, ab grinding zyada karta hu",
             "role_cnc_grinding_operator", ("mach_vmc",), "hard"),
    GoldCase("lathe aur grinding dono, par grinding me expert hu",
             "role_cnc_grinding_operator", ("mach_cnc_lathe", "mach_cnc_grinder"), "hard"),
]

# The full ordered gold set (core -> negative -> hard).
GOLD_CASES: list[GoldCase] = [*_CORE, *_NEGATIVE, *_HARD]


# --- Evaluation ------------------------------------------------------------
# An extractor: text -> an object carrying ``.canonical_role_id`` (the legacy
# DraftProfile, or any client return that exposes that attribute).
ExtractFn = Callable[[str], object]


def _heuristic_extract(text: str) -> object:
    """Default extractor: the deterministic local heuristic (no network)."""
    _rich, legacy = profile_extractor.extract(text)
    return legacy


@dataclass(frozen=True)
class TierResult:
    tier: str
    hits: int
    total: int
    misses: tuple[str, ...]

    @property
    def accuracy(self) -> float:
        return self.hits / self.total if self.total else 1.0


@dataclass(frozen=True)
class EvalResult:
    overall_accuracy: float
    overall_hits: int
    overall_total: int
    by_tier: dict[str, TierResult]
    misses: tuple[str, ...]  # all human-readable misses, every tier

    @property
    def gated_accuracy(self) -> float:
        """Accuracy over the tiers that gate the heuristic (core + negative)."""
        hits = sum(self.by_tier[t].hits for t in ("core", "negative") if t in self.by_tier)
        total = sum(self.by_tier[t].total for t in ("core", "negative") if t in self.by_tier)
        return hits / total if total else 1.0


def _score(cases: list[GoldCase], extract_fn: ExtractFn) -> tuple[int, list[str]]:
    hits = 0
    misses: list[str] = []
    for case in cases:
        profile = extract_fn(case.text)
        got = getattr(profile, "canonical_role_id", None)
        if got == case.expected_role:
            hits += 1
        else:
            misses.append(f"{case.text!r}: expected {case.expected_role}, got {got}")
    return hits, misses


def evaluate(
    extract_fn: ExtractFn = _heuristic_extract,
    *,
    tiers: tuple[Tier, ...] = ("core", "negative", "hard"),
    per_tier_limit: int | None = None,
) -> EvalResult:
    """Score ``extract_fn`` over the gold set, broken down by tier.

    ``extract_fn`` defaults to the deterministic heuristic. In staging the
    eval CLI passes a client that POSTs to the real ``/profile/extract`` and
    reads back ``canonical_role_id`` — same gold set, same scoring.

    ``per_tier_limit`` caps how many cases are scored PER TIER — a stratified
    subset so a real run fits inside a tight provider quota (e.g. a free-tier
    20-requests/day cap) while still covering every tier. ``None`` = full set
    (the CI/heuristic gate always uses the full set).
    """
    by_tier: dict[str, TierResult] = {}
    all_misses: list[str] = []
    total_hits = 0
    total_count = 0
    for tier in tiers:
        cases = [c for c in GOLD_CASES if c.tier == tier]
        if per_tier_limit is not None:
            cases = cases[:per_tier_limit]
        if not cases:
            continue
        hits, misses = _score(cases, extract_fn)
        by_tier[tier] = TierResult(tier, hits, len(cases), tuple(misses))
        all_misses.extend(misses)
        total_hits += hits
        total_count += len(cases)
    overall = total_hits / total_count if total_count else 1.0
    return EvalResult(overall, total_hits, total_count, by_tier, tuple(all_misses))


def tier_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    for case in GOLD_CASES:
        counts[case.tier] = counts.get(case.tier, 0) + 1
    return counts
