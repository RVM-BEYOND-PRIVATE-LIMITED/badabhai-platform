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

# Per-field accuracy bar (same 90% gate, applied per scored field + aggregate).
PER_FIELD_THRESHOLD = 0.90

# Deterministic role -> trade id mapping (mirrors ``signals._ROLES``). Used to
# DEFAULT ``expected_trade`` from ``expected_role`` so we never re-type the trade
# for every case (single source of truth: the role decides the trade).
ROLE_TO_TRADE: dict[str, str] = {
    "role_cam_programmer": "dom_programming",
    "role_cnc_programmer": "dom_programming",
    "role_cnc_setter_operator": "dom_cnc_machining",
    "role_vmc_operator": "dom_vmc_machining",
    "role_hmc_operator": "dom_hmc_machining",
    "role_cnc_grinding_operator": "dom_grinding",
    "role_cnc_turner_operator": "dom_cnc_machining",
}

# Sentinel: a per-field expectation is "not asserted for this case". Distinct
# from an empty tuple (= "expect NO skills/machines") and from ``None`` (= a
# real expected value of None, e.g. no role / no experience).
UNSET = object()


@dataclass(frozen=True)
class GoldCase:
    """One fabricated canonicalization example.

    ``text``                fabricated Hinglish transcript (no PII).
    ``expected_role``       expected ``canonical_role_id`` (``None`` = no role).
    ``expected_machines``   machine ids that MUST be detected (subset check).
    ``tier``                core | negative | hard.

    Optional per-field expectations (added for the per-field rig; defaulting to
    ``UNSET`` keeps every existing case construction valid and unchanged):

    ``expected_trade``      expected ``canonical_trade_id``. ``UNSET`` (default)
                            means "derive from ``expected_role`` via
                            :data:`ROLE_TO_TRADE`" — so role-only cases get a
                            trade expectation for free. Pass ``None`` to assert
                            "no trade" (negative cases).
    ``expected_skills``     skill ids that MUST be present (subset/overlap check).
                            ``UNSET`` = skill field not scored for this case.
    ``expected_experience`` expected years (float). ``UNSET`` = not scored;
                            ``None`` = assert no experience detected.
    """

    text: str
    expected_role: str | None
    expected_machines: tuple[str, ...]
    tier: Tier
    expected_trade: object = UNSET
    expected_skills: object = UNSET
    expected_experience: object = UNSET

    def resolved_trade(self) -> object:
        """``expected_trade``, defaulting to the role's trade when ``UNSET``."""
        if self.expected_trade is not UNSET:
            return self.expected_trade
        if self.expected_role is None:
            return None
        return ROLE_TO_TRADE.get(self.expected_role, UNSET)


# --- CORE: heuristic is expected to pass (>= 90%); the CI regression guard -----
# Every one of the 7 launch roles has >= 3 cases. Each was verified against
# ``profile_extractor.extract`` so CI stays green (see eval CLI / pytest).
_CORE: list[GoldCase] = [
    # role_cam_programmer (CAM Programmer) — keyword "cam programmer".
    GoldCase("cam programmer hu, fusion 360 use karta hu", "role_cam_programmer", (), "core"),
    GoldCase("cam programmer hu, surface modelling karta hu", "role_cam_programmer", (), "core"),
    GoldCase("experienced cam programmer, 7 saal fusion 360 pe", "role_cam_programmer", (),
             "core", expected_skills=("skill_cam_software",), expected_experience=7.0),
    GoldCase("cam programmer hu mastercam aur fusion dono", "role_cam_programmer", (), "core",
             expected_skills=("skill_cam_software",)),
    # role_cnc_programmer (CNC Programmer) — keyword "programmer".
    GoldCase("cnc programmer hu, mastercam pe program banata hu", "role_cnc_programmer", (),
             "core", expected_skills=("skill_program_editing",)),
    GoldCase("programmer hu, g code editing karta hu fanuc pe", "role_cnc_programmer", (), "core",
             expected_skills=("skill_program_editing", "skill_fanuc")),
    GoldCase("cnc programmer hu, fanuc pe program editing", "role_cnc_programmer", (), "core",
             expected_skills=("skill_program_editing", "skill_fanuc")),
    GoldCase("senior cnc programmer, 8 saal ka experience", "role_cnc_programmer", (), "core",
             expected_experience=8.0),
    # role_cnc_setter_operator (CNC Setter-Operator) — keyword "setter".
    GoldCase("setter operator hu, vmc setting karta hu", "role_cnc_setter_operator",
             ("mach_vmc",), "core"),
    GoldCase("cnc setter hu, machine setting karta hu", "role_cnc_setter_operator", (), "core"),
    GoldCase("setter hu, tool offset aur fixture setup karta hu", "role_cnc_setter_operator", (),
             "core", expected_skills=("skill_tool_offset_setting", "skill_fixture_setup")),
    GoldCase("cnc setter operator, 5 saal setting ka kaam", "role_cnc_setter_operator", (),
             "core", expected_experience=5.0),
    # role_vmc_operator (VMC Operator) — keyword "vmc" (after programmer/setter).
    GoldCase("vmc chalata hu 4 saal se fanuc pe", "role_vmc_operator", ("mach_vmc",), "core",
             expected_skills=("skill_fanuc",), expected_experience=4.0),
    GoldCase("vmc operator, siemens control, 6 saal experience", "role_vmc_operator",
             ("mach_vmc",), "core", expected_skills=("skill_siemens",), expected_experience=6.0),
    GoldCase("vmc pe kaam karta hu, fanuc, gd&t aata hai", "role_vmc_operator", ("mach_vmc",),
             "core", expected_skills=("skill_fanuc", "skill_gdt_reading")),
    GoldCase("vmc machine operator, tool offset setting karta hu", "role_vmc_operator",
             ("mach_vmc",), "core"),
    GoldCase("vmc operator hu, drawing padh leta hu", "role_vmc_operator", ("mach_vmc",), "core"),
    # role_hmc_operator (HMC Operator) — keyword "hmc".
    GoldCase("hmc operator, horizontal machining 5 saal", "role_hmc_operator", ("mach_hmc",),
             "core", expected_experience=5.0),
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
             "core", expected_experience=3.0),
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


# --- Per-field evaluation --------------------------------------------------
# A richer extractor: text -> an object exposing the full DraftProfile surface
# (``canonical_trade_id``, ``canonical_role_id``, ``skills``, ``machines``,
# ``experience.total_years``). The heuristic ``DraftProfile`` already satisfies
# this; the real CLI passes a lightweight stand-in built from the endpoint JSON.
FieldExtractFn = Callable[[str], object]

# Experience tolerance (years). The LLM may read "5 saal" as 5.0; we allow a
# small absolute slack so e.g. 4.5 vs 5 is still a hit. Trade/role are EXACT.
EXPERIENCE_TOLERANCE_YEARS = 0.5

# The fields scored per case, in report order.
FIELD_NAMES: tuple[str, ...] = ("trade", "role", "skills", "machines", "experience")


def _full_heuristic_extract(text: str) -> object:
    """Per-field default extractor: the deterministic legacy DraftProfile."""
    _rich, legacy = profile_extractor.extract(text)
    return legacy


def _get_experience_years(profile: object) -> float | None:
    exp = getattr(profile, "experience", None)
    if exp is None:
        return None
    # DraftProfile.experience is an object with .total_years; the CLI stand-in
    # uses the same attribute. Tolerate a plain float too.
    if isinstance(exp, (int, float)):
        return float(exp)
    return getattr(exp, "total_years", None)


@dataclass(frozen=True)
class FieldMatch:
    """One (case, field) scoring outcome."""

    text: str
    tier: str
    field: str
    expected: object
    got: object
    hit: bool

    def as_miss_line(self) -> str:
        return (f"[{self.tier}/{self.field}] {self.text!r}: "
                f"expected {self.expected!r}, got {self.got!r}")


@dataclass(frozen=True)
class FieldResult:
    field: str
    hits: int
    total: int
    misses: tuple[FieldMatch, ...]

    @property
    def accuracy(self) -> float:
        return self.hits / self.total if self.total else 1.0


@dataclass(frozen=True)
class PerFieldEvalResult:
    by_field: dict[str, FieldResult]
    matches: tuple[FieldMatch, ...]  # every (case, field) outcome, all fields
    aggregate_hits: int
    aggregate_total: int

    @property
    def aggregate_accuracy(self) -> float:
        return self.aggregate_hits / self.aggregate_total if self.aggregate_total else 1.0

    @property
    def misses(self) -> tuple[FieldMatch, ...]:
        return tuple(m for m in self.matches if not m.hit)


def _score_trade(case: GoldCase, profile: object) -> FieldMatch | None:
    expected = case.resolved_trade()
    if expected is UNSET:
        return None
    got = getattr(profile, "canonical_trade_id", None)
    return FieldMatch(case.text, case.tier, "trade", expected, got, got == expected)


def _score_role(case: GoldCase, profile: object) -> FieldMatch:
    got = getattr(profile, "canonical_role_id", None)
    return FieldMatch(case.text, case.tier, "role", case.expected_role, got,
                      got == case.expected_role)


def _score_skills(case: GoldCase, profile: object) -> FieldMatch | None:
    if case.expected_skills is UNSET:
        return None
    expected = set(case.expected_skills)  # type: ignore[arg-type]
    got = set(getattr(profile, "skills", []) or [])
    # Subset semantics: every expected skill must be present (extra skills OK).
    hit = expected.issubset(got)
    return FieldMatch(case.text, case.tier, "skills", tuple(sorted(expected)),
                      tuple(sorted(got)), hit)


def _score_machines(case: GoldCase, profile: object) -> FieldMatch | None:
    # Only score machines when the case asserts some (matches existing subset
    # semantics of the role/machine test); empty expectation = not scored here.
    if not case.expected_machines:
        return None
    expected = set(case.expected_machines)
    got = set(getattr(profile, "machines", []) or [])
    hit = expected.issubset(got)
    return FieldMatch(case.text, case.tier, "machines", tuple(sorted(expected)),
                      tuple(sorted(got)), hit)


def _score_experience(case: GoldCase, profile: object) -> FieldMatch | None:
    if case.expected_experience is UNSET:
        return None
    expected = case.expected_experience
    got = _get_experience_years(profile)
    if expected is None:
        hit = got is None
    else:
        hit = got is not None and abs(got - float(expected)) <= EXPERIENCE_TOLERANCE_YEARS
    return FieldMatch(case.text, case.tier, "experience", expected, got, hit)


def evaluate_per_field(
    extract_fn: FieldExtractFn = _full_heuristic_extract,
    *,
    tiers: tuple[Tier, ...] = ("core", "negative", "hard"),
) -> PerFieldEvalResult:
    """Score ``extract_fn`` PER FIELD across the gold set.

    For each case we extract once and score each applicable field:

    - ``trade``      exact match on ``canonical_trade_id`` (derived from role
                     unless overridden).
    - ``role``       exact match on ``canonical_role_id`` (every case).
    - ``skills``     subset: all ``expected_skills`` present (extras allowed).
    - ``machines``   subset: all ``expected_machines`` present (extras allowed).
    - ``experience`` years within ``EXPERIENCE_TOLERANCE_YEARS`` (None = assert
                     no experience).

    A field with no expectation on a case is simply not scored for it (kept out
    of both numerator and denominator) so accuracy reflects only asserted fields.
    The aggregate is the micro-average over every scored (case, field) pair.
    """
    cases = [c for c in GOLD_CASES if c.tier in tiers]
    per_field: dict[str, list[FieldMatch]] = {f: [] for f in FIELD_NAMES}
    all_matches: list[FieldMatch] = []
    scorers = {
        "trade": _score_trade,
        "role": _score_role,
        "skills": _score_skills,
        "machines": _score_machines,
        "experience": _score_experience,
    }
    for case in cases:
        profile = extract_fn(case.text)
        for field in FIELD_NAMES:
            match = scorers[field](case, profile)
            if match is None:
                continue
            per_field[field].append(match)
            all_matches.append(match)

    by_field: dict[str, FieldResult] = {}
    agg_hits = 0
    agg_total = 0
    for field in FIELD_NAMES:
        matches = per_field[field]
        if not matches:
            continue
        hits = sum(1 for m in matches if m.hit)
        misses = tuple(m for m in matches if not m.hit)
        by_field[field] = FieldResult(field, hits, len(matches), misses)
        agg_hits += hits
        agg_total += len(matches)
    return PerFieldEvalResult(by_field, tuple(all_matches), agg_hits, agg_total)
