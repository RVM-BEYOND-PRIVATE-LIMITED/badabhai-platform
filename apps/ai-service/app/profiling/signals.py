"""Canonical signal detection over worker text (CNC/VMC role family).

This is the SINGLE source of truth for "what did the worker say": roles,
machines, controllers, skills, experience, location, salary, etc. Both the
interview engine and the messy-text→clean-profile extractor build on it, so
there is no duplicated keyword logic.

It runs deterministic heuristics (regex + small gazetteers) over RAW worker text
INSIDE the trusted service (no network). This is allowed because nothing here is
sent to an external LLM — pseudonymization gates only external calls. The values
extracted (role, machine, city preference, salary) are profile data, not
identity PII (phone/name/employer), which the pseudonymizer masks.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..pseudonymize import CITY_ALIASES, KNOWN_CITIES, MAX_PLAUSIBLE_SALARY_INR

KnowledgeLevel = str  # "none" | "basic" | "strong" | "unknown"

# --- Devanagari word boundaries ---------------------------------------------
# `\b` is defined on `\w`, and Python's `\w` is `str.isalnum()`-backed, so Devanagari
# COMBINING MARKS (matras: ी U+0940 Mc, ँ U+0901 Mn, ् U+094D Mn) are NOT word
# characters. Any Devanagari token that ENDS in a matra therefore has no `\b` after
# it, and `\bवीएमसी\b` / `\bकहीं\s+भी\b` silently never match — MEASURED, not assumed
# (tests/test_parser_widening.py::
# test_devanagari_boundaries_are_used_because_ascii_word_boundary_is_broken).
#
# The correct boundary for a Devanagari token is "not adjacent to another Devanagari
# character", which is what this expresses. Using it instead of `\b` keeps the
# no-substring-matching rule intact: `वीएमसी` cannot fire inside `वीएमसीएक्स`.
_DEVANAGARI = r"ऀ-ॿ"


def _dev(pattern: str) -> str:
    """Wrap ``pattern`` in Devanagari-safe boundaries (see :data:`_DEVANAGARI`)."""
    return rf"(?<![{_DEVANAGARI}]){pattern}(?![{_DEVANAGARI}])"


# --- Keyword tables (keyword, human-label, taxonomy-id) --------------------
# Order matters where a generic term could shadow a specific one.

_MACHINES: list[tuple[str, str, str]] = [
    ("vmc", "VMC", "mach_vmc"),
    ("hmc", "HMC", "mach_hmc"),
    ("cnc lathe", "CNC Lathe", "mach_cnc_lathe"),
    ("lathe", "CNC Lathe", "mach_cnc_lathe"),
    ("turning", "CNC Lathe", "mach_cnc_lathe"),
    ("cylindrical grind", "Cylindrical Grinder", "mach_cylindrical_grinder"),
    ("grinding", "Grinding", "mach_cnc_grinder"),
    ("grinder", "Grinding", "mach_cnc_grinder"),
]

# Controllers map to a legacy skill id where one exists (else None).
_CONTROLLERS: list[tuple[str, str, str | None]] = [
    ("fanuc", "Fanuc", "skill_fanuc"),
    ("siemens", "Siemens", "skill_siemens"),
    ("mitsubishi", "Mitsubishi", "skill_mitsubishi"),
    ("heidenhain", "Heidenhain", None),
    ("haas", "Haas", None),
]

# Roles, most specific first: (keyword, label, role_id, trade_id).
#
# TAX-WELD-1 contains NO welding entry here, deliberately. An earlier cut put
# ("welder"/"welding") LAST in this table and argued that first-keyword-wins meant
# welding "can only ever ADD a role where there was None, never take one away".
# That claim was TRUE but NOT SUFFICIENT, and it is corrected here:
#
#   This table has no entry for `cnc`, `lathe`, `milling` or bare `operator`. So a
#   large population of real machining workers ALREADY resolves to role_id None, and
#   "only fills a None" silently meant "captures those workers as welders":
#     "cnc operator hun, welding bhi kar leta hun"       -> role_welder  (WRONG)
#     "pehle welding karta tha, ab CNC lathe chalata hu" -> role_welder  (WRONG; past tense)
#
#   Filling a None WRONGLY is strictly WORSE than leaving it None. packages/
#   reach-engine/src/scoring.ts `scoreRole` returns 0.4 for a null roleId ("trade not
#   stated yet") but 0.0 for a NON-MATCHING one ("different trade"), at WEIGHTS.role
#   = 0.35. MEASURED on a VMC/turner job by scoring the same worker with roleId null
#   vs role_welder: an absolute score drop of 0.1647, i.e. 0.4 x 0.35 / (1 - 0.15) —
#   the skills-factor renormalisation — so the drop is the SAME for any skill-less
#   job regardless of the other factors. Relative cost depends on the baseline
#   (24.5% on a strong-match fixture, ~33% on a weaker one).
#
# The precise, load-bearing claim is therefore:
#   welding NEVER displaces an ASSIGNED role, AND it is only allowed to fill a `None`
#   when there is NO machining signal anywhere in the text and no blocker (negation /
#   welding-adjacent non-welder context). Both halves are enforced in ONE place —
#   `_assign_welding_role` — not by table ordering.
#
# Keeping welding OUT of this table also removes a real inconsistency: this loop is
# plain substring (`kw in lower`), so a "welding" entry here fired on "spotwelding" /
# "weldingwala" and set a role while `_WELDING_RE` (word-boundary) produced NO skill
# id. All welding role logic now runs off `_WELDING_RE`, so role and skills agree.
_ROLES: list[tuple[str, str, str, str]] = [
    ("cam programmer", "CAM Programmer", "role_cam_programmer", "dom_programming"),
    ("programmer", "CNC Programmer", "role_cnc_programmer", "dom_programming"),
    ("setter", "CNC Setter-Operator", "role_cnc_setter_operator", "dom_cnc_machining"),
    ("vmc", "VMC Operator", "role_vmc_operator", "dom_vmc_machining"),
    ("hmc", "HMC Operator", "role_hmc_operator", "dom_hmc_machining"),
    ("grinding", "CNC Grinding Operator", "role_cnc_grinding_operator", "dom_grinding"),
    ("turner", "CNC Turner/Operator", "role_cnc_turner_operator", "dom_cnc_machining"),
    ("turning", "CNC Turner/Operator", "role_cnc_turner_operator", "dom_cnc_machining"),
]

# --- Role keyword VARIANTS (parser widening) --------------------------------
#
# WHAT THIS TABLE IS, AND THE ONE THING IT IS NOT.
#
# `_ROLES` above is matched with a bare `kw in lower` SUBSTRING test, so it cannot see
# the same keyword written with spaces ("V M C"), with a misspelling ("seter"), or in
# Devanagari ("वीएमसी"). This table is ONLY that: alternate SURFACE FORMS of keywords
# `_ROLES` already carries. Each row inherits, exactly, whatever `_ROLES` already does
# with its Latin twin — including that table's pre-existing limits. It adds NO new
# inference of any kind.
#
# IT IS NOT AN INFERENCE TABLE, and the earlier cut of this widening that tried to make
# it one has been DELETED. That cut added "<machine> + <function>" rows
# ("lathe operator" -> role_cnc_turner_operator) and then needed a growing blocklist to
# stop them firing on someone else's job, an aspiration, a vacancy, a training course,
# an interrogative, a denial. Three rounds of adversarial review measured a new hole in
# that blocklist every round, because Hinglish generates variants faster than a
# blocklist can enumerate them:
#
#     BLOCKED "lathe operator ke saath kaam karta tha"
#     HOLE    "lathe operator mere saath kaam karta tha"   -> CNC Turner/Operator
#     BLOCKED "papa lathe chalate hai"
#     HOLE    "pitaji lathe chalate hai" / "chacha lathe chalate hai"
#     HOLE    "lathe operator ki salary kitni hoti hai"    (a QUESTION)
#     HOLE    "ek lathe operator ko jaanta hu"
#
# Deciding "is the speaker CLAIMING this role?" is a judgement `_ROLES` never makes,
# and every attempt to make it with regex leaked. It bought ONE corpus fixture. It is
# gone; "lathe operator" is an honest, re-askable GAP again.
#
# Every id below ALREADY EXISTS in the closed set (`canonical_roles.ROLE_TRADE`,
# derived from `_ROLES` + `_EXTRA_ROLE_TRADES`). NOTHING here mints a role id, and
# nothing here widens `_ROLES` itself — so `canonical_roles.ROLE_IDS`, the allow-set
# offered to the model, is byte-for-byte unchanged.
#
# WHAT IS DELIBERATELY ABSENT: `cnc` and bare `operator`.
#
#   `question_bank.py` records the decision ("Bare 'operator' does NOT [resolve], so
#   it never stands alone") and it is RIGHT, for a reason that also rules out `cnc`:
#   EVERY operator role in the closed set names a specific machine family
#   (role_vmc_operator / role_hmc_operator / role_cnc_turner_operator /
#   role_cnc_grinding_operator). "operator" states the function without the family;
#   "CNC" states a family-of-families (VMC, HMC, lathe and grinder are all CNC)
#   without saying which. Resolving either one would have to PICK a machine the
#   worker never named — the fabrication class this parser exists to avoid.
#
#   Minting a generic `role_cnc_operator` instead is not a parser change and would
#   make matching WORSE, measurably: packages/reach-engine/src/scoring.ts `scoreRole`
#   is exact-id-match, returning 0.4 for a NULL roleId ("trade not stated yet") but
#   0.0 for a non-matching one ("different trade"). A generic id matches no seeded
#   job, so it would score every one of these workers BELOW the null they get today.
#   That is an owner/ADR decision (taxonomy + job role_ids + reach), not a widening.
#
# MATCHED WITH BOUNDARIES, never as substrings: `\b` for the Latin cues and
# :func:`_dev` for the Devanagari ones (`\b` does not work there — see _DEVANAGARI).
# Applied ONLY when `_ROLES` matched nothing, and it reads the same negation-masked
# text `_ROLES` reads, so a denial suppresses a variant exactly as it suppresses the
# keyword ("वीएमसी नहीं चलाता" -> no role, like "vmc nahi chalata").
#
# NO BLOCKLIST GUARDS THIS TABLE, and none is needed: a variant row can only produce
# the reading its Latin twin already produces. "V M C operator ki job hai kya" resolves
# `role` — and so does "VMC operator ki job hai kya" on `main`, through `_ROLES`. That
# limit is real and is `_ROLES`'s, not this table's; narrowing it means narrowing
# `_ROLES`, which is a separate change against a shipped behaviour.
_ROLE_CUES: tuple[tuple[str, str, str, str], ...] = (
    # Spaced acronyms — "V M C operator". The substring test in `_ROLES` sees no
    # "vmc" here. Spaces are REQUIRED between the letters, so this can only ever
    # match a spelled-out acronym.
    (r"\bv\s+m\s+c\b", "VMC Operator", "role_vmc_operator", "dom_vmc_machining"),
    (r"\bh\s+m\s+c\b", "HMC Operator", "role_hmc_operator", "dom_hmc_machining"),
    # `setter` misspelt with one `t`. Cannot match inside "setter" itself.
    (r"\bset[ae]r\b", "CNC Setter-Operator", "role_cnc_setter_operator",
     "dom_cnc_machining"),
    # Devanagari forms of role words the Latin table already carries. TRANSLITERATION
    # of an EXISTING gazetteer entry to the other script — no new concept, no new id,
    # no vernacular alias (`ऑपरेटर` alone resolves nothing, exactly like `operator`).
    (_dev("वीएमसी"), "VMC Operator", "role_vmc_operator", "dom_vmc_machining"),
    (_dev("एचएमसी"), "HMC Operator", "role_hmc_operator", "dom_hmc_machining"),
    (_dev("प्रोग्रामर"), "CNC Programmer", "role_cnc_programmer", "dom_programming"),
    (_dev("सेटर"), "CNC Setter-Operator", "role_cnc_setter_operator", "dom_cnc_machining"),
    (_dev("टर्नर"), "CNC Turner/Operator", "role_cnc_turner_operator", "dom_cnc_machining"),
)
_ROLE_CUES_RE: tuple[tuple[re.Pattern[str], str, str, str], ...] = tuple(
    (re.compile(pat, re.IGNORECASE), label, rid, tid) for pat, label, rid, tid in _ROLE_CUES
)


# --- Welding (TAX-WELD-1) ---------------------------------------------------
# WIRING, NOT MINTING. Every id below ALREADY EXISTS, `status: "active"`, in
# `packages/taxonomy/src/skill-corpus.ts` (ADR-0030 / TAX-2), and every keyword below
# is ALREADY a canonical ENGLISH/technical alias of that skill in the same corpus:
#
#   skill_mig_welding      MIG welding / GMAW / MIG/MAG            (domain: welding)
#   skill_tig_welding      TIG welding / GTAW                      (domain: welding)
#   skill_arc_welding      arc welding / SMAW / stick welding      (domain: welding)
#   skill_gas_cutting      gas cutting / oxy-fuel cutting          (domain: fabrication)
#   skill_welder_occupation  Welder / "welder"                     (domain: welding)
#
# NO new skill_id is minted here and NO unratified Hinglish/vernacular alias is added
# (that needs RVM ratification — ADR-0030 §7 gate (d)). The one Hindi phrase that IS
# ratified for this family, "welding ka kaam" -> skill_welder_occupation
# (`wedge-aliases.ts`, ratified: true), is covered by the plain "welding" keyword.
#
# MATCHED WITH WORD BOUNDARIES, unlike the substring tables above: "tig" is a substring
# of "fatigue" and "mig" of "emigration"/"mitigate", so a bare `in` test would corrupt
# profiles. Most specific first (mig/mag before mig).
_WELDING: list[tuple[str, str, str]] = [
    (r"mig\s*/\s*mag", "MIG welding", "skill_mig_welding"),
    (r"gmaw", "MIG welding", "skill_mig_welding"),
    (r"mig\s+welding", "MIG welding", "skill_mig_welding"),
    (r"mig", "MIG welding", "skill_mig_welding"),
    (r"gtaw", "TIG welding", "skill_tig_welding"),
    (r"tig\s+welding", "TIG welding", "skill_tig_welding"),
    (r"tig", "TIG welding", "skill_tig_welding"),
    (r"smaw", "arc welding", "skill_arc_welding"),
    (r"stick\s+welding", "arc welding", "skill_arc_welding"),
    (r"arc\s+welding", "arc welding", "skill_arc_welding"),
    (r"oxy[\s-]*fuel(?:\s+cutting)?", "gas cutting", "skill_gas_cutting"),
    (r"gas\s+cutting", "gas cutting", "skill_gas_cutting"),
    (r"welder", "welding", "skill_welder_occupation"),
    (r"welding", "welding", "skill_welder_occupation"),
]
_WELDING_RE: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(rf"\b{pat}\b", re.IGNORECASE), label, sid) for pat, label, sid in _WELDING
]

# Welding-DOMAIN skill ids (skill_gas_cutting is domain `fabrication` — a gas cutter is
# a cutter, not necessarily a welder, so it alone must NOT imply the welder role).
_WELDING_DOMAIN_SKILL_IDS = frozenset(
    {"skill_mig_welding", "skill_tig_welding", "skill_arc_welding", "skill_welder_occupation"}
)

# --- Machining signal: the guard that stops welding capturing a machining worker ---
# ANY hit here means the text carries machining evidence, so welding must NOT assign
# the role — even when `_ROLES` matched nothing. This is what makes "welding only ever
# fills a None" actually safe (see the `_ROLES` note above): the Nones that welding is
# now barred from filling are exactly the machining ones.
#
# WORD-BOUNDARY matched, and deliberately NOT containing bare "machine": a real welder
# says "TIG aur MIG machine chala leta hun", and "welding machine" is a welder's own
# tool. Fail direction is intentionally toward None (0.4, "trade not stated") rather
# than a confident wrong role (0.0, "different trade").
# Roles that are part of the CLOSED role SET but are NOT keyword-matched by `_ROLES`.
#
# `_ROLES` is a KEYWORD TABLE; the closed set is `_ROLES` plus these. The two were the
# same list until TAX-WELD-1, which is why an earlier cut had to put a "welding" keyword
# in `_ROLES` just to get `role_welder` into `canonical_roles.ROLE_TRADE` — and that
# keyword is exactly what captured machining workers. Decoupling them lets welding be
# a first-class role in the closed set (so the model may propose it, `normalize_role_id`
# accepts it, and the rich->legacy mapper validates it) while its ASSIGNMENT from raw
# text stays behind the single gate in `_assign_welding_role`.
_EXTRA_ROLE_TRADES: tuple[tuple[str, str], ...] = (
    ("role_welder", "dom_welding"),
)

_MACHINING_CONTEXT: tuple[str, ...] = (
    r"cnc", r"vmc", r"hmc", r"lathe", r"milling", r"machining", r"turning", r"turner",
    r"grinding", r"grinder", r"boring", r"drilling", r"setter", r"programmer",
    r"mastercam", r"fanuc", r"siemens", r"haas", r"heidenhain", r"mitsubishi",
    r"g\s*-?\s*code", r"m\s*-?\s*code", r"tool\s+offset",
)
_MACHINING_CONTEXT_RE: list[re.Pattern[str]] = [
    re.compile(rf"\b{p}\b", re.IGNORECASE) for p in _MACHINING_CONTEXT
]

# --- Blockers: welding words present, but the worker is NOT (claiming to be) a welder.
# These suppress the welder ROLE only; the skill ids are still recorded (a phrase-level
# fix, not a general negation parser — see the module note in tests/test_welding_gazetteer.py).
#
# NEGATION is Hindi-word-order aware: Hindi negates AFTER the verb ("welding nahi
# karta"), English before ("I don't do welding"), so a window on BOTH sides is checked.
_WELDING_NEGATION = r"(?:nahi+n?|nah[ií]|mat|kabhi\s+nahi+n?|not|no|never|n't)"
_WELDING_ROLE_BLOCKERS: tuple[str, ...] = (
    # Explicit denial: "welding nahi karta, sirf helper hu" / "I don't do welding".
    rf"\b(?:welder|welding)\b[^.;!?]{{0,24}}?\b{_WELDING_NEGATION}\b",
    rf"\b{_WELDING_NEGATION}\b[^.;!?]{{0,24}}?\b(?:welder|welding)\b",
    # Welding-ADJACENT non-welders: the welding word modifies a NOUN (a consumable or
    # a machine being serviced/sold), it is not the work the worker performs.
    r"\bwelding\s+(?:rod|rods|wire|electrode|electrodes|filler|gas|cylinder)s?\b",
    r"\bwelding\s+machine\b[^.;!?]{0,24}?\b(?:repair|repairing|maintenance|service)\b",
    r"\b(?:welder|welding)\b[^.;!?]{0,24}?"
    r"\b(?:supply|supplier|supplies|sale|sales|sell|selling|bechta|bechti|dealer|dukan)\b",
)
_WELDING_ROLE_BLOCKERS_RE: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE) for p in _WELDING_ROLE_BLOCKERS
]

# Operational skills: (keyword, label, skill_id).
_SKILLS: list[tuple[str, str, str]] = [
    ("tool offset", "tool offset setting", "skill_tool_offset_setting"),
    ("offset", "tool offset setting", "skill_tool_offset_setting"),
    ("g code", "G-code/M-code editing", "skill_program_editing"),
    ("g-code", "G-code/M-code editing", "skill_program_editing"),
    ("m code", "G-code/M-code editing", "skill_program_editing"),
    ("program", "program editing", "skill_program_editing"),
    ("gd&t", "drawing reading", "skill_gdt_reading"),
    ("gdt", "drawing reading", "skill_gdt_reading"),
    ("drawing", "drawing reading", "skill_gdt_reading"),
    ("fixture", "fixture setup", "skill_fixture_setup"),
    ("mastercam", "CAM software", "skill_cam_software"),
    ("fusion", "CAM software", "skill_cam_software"),
]

_INSPECTION: list[tuple[str, str]] = [
    ("micrometer", "micrometer"),
    ("vernier", "vernier caliper"),
    ("caliper", "vernier caliper"),
    ("bore gauge", "bore gauge"),
    ("height gauge", "height gauge"),
    ("gauge", "gauges"),
    ("gage", "gauges"),
    ("cmm", "CMM"),
]

_MATERIALS: list[tuple[str, str]] = [
    ("mild steel", "Mild Steel"),
    ("ms ", "Mild Steel"),
    ("stainless", "Stainless Steel"),
    ("ss ", "Stainless Steel"),
    ("aluminium", "Aluminium"),
    ("aluminum", "Aluminium"),
    ("cast iron", "Cast Iron"),
    ("brass", "Brass"),
    ("titanium", "Titanium"),
]

_ROLE_LABELS: dict[str, str] = {rid: label for _, label, rid, _ in _ROLES}

# P1-3(a): DECIMAL-SAFE experience.
#
# The previous `(\d{1,2})` had no left boundary, so on "2.5 saal" the engine
# skipped the unmatchable "2." and matched the FRACTION — "5 saal", a 2.5-year
# worker shipped as five years. Two fixes, both load-bearing:
#
# - ``(?<![\d.])`` refuses to start a match immediately after a digit or a dot,
#   so the second half of a decimal can never be read as the whole number;
# - the optional ``(?:\.\d+)?`` group captures the fraction, so "2.5 saal" is 2.5.
#
# The trailing ``\b`` closes a second wrong-data path in the same regex: the bare
# ``sal`` alternative used to match INSIDE a longer word, so "2 salary" scored as
# two years of experience. (The old pattern's final ``saal\b`` alternative was
# unreachable — ``saal`` already matched — and is dropped.)
# Hinglish number-words for a DURATION IN YEARS.
#
# EXTRACTION_SYSTEM_PROMPT has taught the model 'aadha'=0.5, 'dedh'=1.5, 'dhai'=2.5
# since it was written. The deterministic detector never learned them, so with real
# calls off — the default — "dedh saal" produced NOTHING while "1.5 saal" produced
# 1.5. A worker who answers the experience question the way most workers actually
# say it lost their answer entirely, and `experience` is an ESSENTIAL topic that
# drives the payer-visible band. Measured on an owner session: "dedh saal ka",
# then "dedh saal" again on the re-ask, both -> None.
#
# This is a PARITY fix, not a new inference: the table below is the prompt's own
# table, plus the plain numerals. Ordered LONGEST-FIRST so "paune do" wins over
# "paune" and "sava do" over "sava" — the compounds mean different numbers.
_EXP_WORD_NUMBERS: tuple[tuple[str, float], ...] = (
    ("paune do", 1.75),
    ("sava do", 2.25),
    ("dhaai", 2.5), ("dhai", 2.5), ("adhai", 2.5),
    ("dedh", 1.5), ("dhedh", 1.5), ("derh", 1.5),
    ("sava", 1.25),
    ("paune", 0.75), ("pauna", 0.75),
    ("aadha", 0.5), ("adha", 0.5), ("aadhe", 0.5),
    ("pandrah", 15.0), ("bees", 20.0),
    ("gyarah", 11.0), ("barah", 12.0),
    ("ek", 1.0), ("do", 2.0), ("teen", 3.0), ("tin", 3.0),
    ("chaar", 4.0), ("char", 4.0),
    ("paanch", 5.0), ("panch", 5.0),
    ("chhah", 6.0), ("chhe", 6.0),
    ("saat", 7.0), ("aath", 8.0), ("nau", 9.0), ("das", 10.0),
)
_EXP_WORD_LOOKUP: dict[str, float] = {word: value for word, value in _EXP_WORD_NUMBERS}
_EXP_WORD_ALT = "|".join(re.escape(word) for word, _ in _EXP_WORD_NUMBERS)
_EXPERIENCE_RE = re.compile(
    r"(?<![\d.])(\d{1,2}(?:\.\d+)?|" + _EXP_WORD_ALT + r")\s*\+?\s*"
    r"(?:years|year|yrs|yr|saal|sal)\b",
    re.IGNORECASE,
)
# Detect the canonical cities AND their Hinglish aliases (dilli, bombay, ...) so a
# colloquial name is captured, then normalized to its canonical form.
_CITY_TOKENS = sorted(set(KNOWN_CITIES) | set(CITY_ALIASES), key=len, reverse=True)
_CITY_RE = re.compile(
    r"\b(?:" + "|".join(re.escape(c) for c in _CITY_TOKENS) + r")\b",
    re.IGNORECASE,
)


def _canonical_city(token: str) -> str:
    """Normalize a matched city/alias token to its canonical KNOWN_CITIES member,
    Title-cased (e.g. "dilli" -> "Delhi"). Aliases resolve INTO the closed set."""
    low = token.strip().lower()
    return CITY_ALIASES.get(low, low).title()


# --- State-level location (captured instead of dropped) --------------------
# Full state names -> canonical Title-cased label, matched case-INSENSITIVELY.
_STATE_NAMES: dict[str, str] = {
    "bihar": "Bihar",
    "uttar pradesh": "Uttar Pradesh",
    "madhya pradesh": "Madhya Pradesh",
    "andhra pradesh": "Andhra Pradesh",
    "himachal pradesh": "Himachal Pradesh",
    "arunachal pradesh": "Arunachal Pradesh",
    "west bengal": "West Bengal",
    "tamil nadu": "Tamil Nadu",
    "rajasthan": "Rajasthan",
    "punjab": "Punjab",
    "haryana": "Haryana",
    "gujarat": "Gujarat",
    "maharashtra": "Maharashtra",
    "karnataka": "Karnataka",
    "telangana": "Telangana",
    "kerala": "Kerala",
    "odisha": "Odisha",
    "jharkhand": "Jharkhand",
    "chhattisgarh": "Chhattisgarh",
    "uttarakhand": "Uttarakhand",
    "assam": "Assam",
    "goa": "Goa",
}
# UPPERCASE-only 2-letter abbreviations, matched CASE-SENSITIVELY. Deliberately
# strict: a case-insensitive "up"/"mp" would collide with common CNC phrasing like
# "set up" / "setup", corrupting the profile. "UP" written in caps is a state.
_STATE_ABBREVS: dict[str, str] = {
    "UP": "Uttar Pradesh",
    "MP": "Madhya Pradesh",
    "AP": "Andhra Pradesh",
    "HP": "Himachal Pradesh",
    "WB": "West Bengal",
}
_STATE_NAME_RE = re.compile(
    r"\b(?:" + "|".join(re.escape(s) for s in sorted(_STATE_NAMES, key=len, reverse=True)) + r")\b",
    re.IGNORECASE,
)
_STATE_ABBREV_RE = re.compile(
    r"\b(?:" + "|".join(re.escape(a) for a in _STATE_ABBREVS) + r")\b"
)  # case-sensitive by design (see _STATE_ABBREVS)


def _detect_state(text: str) -> str | None:
    """Capture a NAMED state (or an UPPERCASE 2-letter abbrev) so a state-only
    answer ("bihar mai hu") is no longer silently dropped. Full names win over
    abbreviations. Returns the canonical Title-cased label, or None."""
    match = _STATE_NAME_RE.search(text)
    if match:
        return _STATE_NAMES[match.group(0).lower()]
    match = _STATE_ABBREV_RE.search(text)
    if match:
        return _STATE_ABBREVS[match.group(0)]
    return None


# --- Multi-state REGIONS ----------------------------------------------------
# Names that are neither a city nor a state but ARE how a worker states where they
# can work: "NCR", "South India". Whole phrases only — "south" and "india" on their
# own say nothing ("south side me rehta hu", "made in India"), so neither is a cue.
_REGION_NAMES: dict[str, str] = {
    "ncr": "NCR",
    "delhi ncr": "NCR",
    "north india": "North India",
    "south india": "South India",
    "east india": "East India",
    "west india": "West India",
    "central india": "Central India",
}
_REGION_RE = re.compile(
    r"\b(?:"
    + "|".join(re.escape(r) for r in sorted(_REGION_NAMES, key=len, reverse=True))
    + r")\b",
    re.IGNORECASE,
)


def _detect_region(text: str) -> str | None:
    """A named multi-state region, or None. Longest phrase wins."""
    match = _REGION_RE.search(text)
    return _REGION_NAMES[match.group(0).lower()] if match else None


# --- The preferred-AREA read: a POSITIVE requirement, not a blocklist -------
#
# THE STRUCTURAL LESSON, paid for over three review rounds. The first two cuts of this
# function vetoed a state/region read with blocklists — a negation window, then an
# EXCLUSION marker list, then an ORIGIN marker list. Every round measured new holes,
# because the blocked class is GENERATIVE and Hinglish spells everything several ways:
#
#     "Bihar ke alawa kahin bhi"   BLOCKED   |  "Bihar ke alaawa ..."   HOLE
#     "Bihar chhod ke kahin bhi"   BLOCKED   |  "Bihar chhodke ..."     HOLE
#                                            |  "Bihar ke sivay ..."    HOLE
#     "Bihar se hu"                BLOCKED   |  "main Bihar ka hu"      HOLE
#                                            |  "ghar Bihar me hai"     HOLE
#     ...each hole storing the ONE state the worker ruled out, on a topic that then
#     closes and is never re-asked.
#
# A blocklist can only ever enumerate; the thing it must exclude is unbounded. So the
# test is INVERTED into a positive requirement, which fails CLOSED on everything it has
# never seen:
#
#     the message must consist of NOTHING BUT area names plus a short ALLOW-LIST of
#     connective words.
#
# "Gujarat mein" and "Gujarat ya Maharashtra dono chalega" pass. Every sentence above
# fails — not because its particular idiom was anticipated, but because it contains a
# word (`alaawa`, `chhodke`, `sivay`, `ghar`, `paida`, `bhai`, `hai`, `tha`, `nahi`)
# that is not on the allow-list. A NEW idiom nobody has thought of also fails, which is
# the property a blocklist can never have.
#
# The cost is real and is accepted: a long, discursive but genuine answer
# ("Gujarat me kaam kiya tha, wahi chahiye") records nothing and is re-asked. A gap
# re-asks the worker; a wrong preference feeds the reach feed a place they ruled out.

# Words allowed to appear ALONGSIDE the area names. Deliberately tiny, and every entry
# is a connective or a bare acceptance — nothing that can carry a proposition of its
# own (no verbs of being/having, no negators, no place nouns).
_AREA_FILLER_WORDS: frozenset[str] = frozenset(
    {
        # postpositions: "Gujarat mein", "Gujarat me". Latin only — `_STATE_NAMES`
        # and `_REGION_NAMES` carry no Devanagari entries, so a Devanagari filler
        # word here could never be reached and would only imply support that does
        # not exist.
        "me", "mein", "mai", "mei",
        # conjunctions / enumeration: "Gujarat ya Maharashtra", "dono"
        "ya", "aur", "or", "and", "dono", "teeno", "tino", "both",
        # restriction / emphasis: "sirf Gujarat", "Gujarat hi"
        "sirf", "only", "bas", "keval", "hi", "bhi",
        # scope: "pura Gujarat"
        "pura", "poora", "puri", "whole", "all",
        # the ask itself: "Gujarat me kaam chahiye"
        "kaam", "job", "naukri", "work", "chahiye", "chaahiye", "chahie",
        # bare acceptance: "Gujarat chalega"
        "chalega", "chalegi", "theek", "thik", "ok", "okay", "sahi", "fine",
    }
)


def _preferred_areas(text: str) -> list[str]:
    """STATES / REGIONS offered as places the worker CAN WORK. Empty unless certain.

    Read ONLY when the preferred-locations question was the one asked (see
    :func:`detect_answered_topics`).

    THE RULE (see the note above for why it is shaped this way): every word in the
    message must be either part of an area name or in :data:`_AREA_FILLER_WORDS`.
    Anything else — a verb, a negator, a relative, a house, a past tense, an idiom
    nobody has enumerated — abandons the read. Positive requirement, fails closed.

    **CURRENT location is untouched.** A state-only answer still does not mark
    ``current_location`` — that decision (and its reason: the engine should go on to
    ask for the CITY, which is strictly better matching data) is unchanged. It does
    not carry over to PREFERENCE, where "Gujarat mein" / "South India" is a complete,
    usable answer to "kahan kaam kar sakte hain?" and otherwise records NOTHING.

    **"Anywhere" WINS over an incidental area.** If the message carries a
    generality-of-place idiom, the worker has said *anywhere* and any state in the same
    message is context ("kahin bhi ja sakta hu, abhi Gujarat me kaam kar raha hu" —
    Gujarat is where they ARE). The allow-list already rejects those messages, but the
    precedence is asserted explicitly rather than left to emerge from a word list, so
    it cannot be broken by someone adding a word.

    FULL STATE NAMES ONLY — the 2-letter abbreviations in :data:`_STATE_ABBREVS` are
    deliberately NOT read here. Their own note calls the "set up" collision out, and
    the CASE-SENSITIVE guard it relies on does not hold: an adversarial probe measured
    ``"set UP karta hu"`` -> ``preferred_locations: ['Uttar Pradesh']``. "UP mein"
    therefore records nothing and the question is asked again.

    ALL areas are returned, not the first: ``preferred_locations`` is a LIST, and
    first-match-wins measured as dropping the second choice in "Gujarat ya Maharashtra
    dono chalega" while closing the topic against re-asking.

    WHAT AN EMPTY RETURN MEANS, precisely: the AREA read is abandoned, NOT the topic.
    :func:`detect_answered_topics` falls through to the flexibility arm, so a message
    that also says "kahin bhi" is still recorded as ``flexible`` — which is what it
    means and what ``main`` recorded. A message with neither records nothing at all.
    One consequence is worth stating rather than hiding: "Maharashtra ke andar kahin
    bhi, bahar nahi jaunga" records ``flexible``, i.e. anywhere in India, although the
    worker excluded outside Maharashtra. That is unchanged from ``main`` — this
    function cannot make it worse and does not make it better.
    """
    if _has_anywhere_cue(text) or "?" in text:
        # A QUESTION is not an answer. "Gujarat me kaam?" passes the filler test
        # otherwise (`me`/`kaam` are both filler), and a worker asking whether there is
        # work somewhere has not said they will go there. One character, whole class.
        return []
    spans: list[tuple[int, int, str]] = []
    for match in _STATE_NAME_RE.finditer(text):
        spans.append((match.start(), match.end(), _STATE_NAMES[match.group(0).lower()]))
    for match in _REGION_RE.finditer(text):
        spans.append((match.start(), match.end(), _REGION_NAMES[match.group(0).lower()]))
    if not spans:
        return []
    # Blank the area names out, then require everything LEFT OVER to be filler.
    remainder = list(text)
    for start, end, _label in spans:
        for i in range(start, end):
            remainder[i] = " "
    for token in _WORD_RE.finditer("".join(remainder)):
        word = token.group(0).strip(_TOKEN_TRIM).lower()
        if word and word not in _AREA_FILLER_WORDS:
            return []
    areas: list[str] = []
    for _start, _end, label in sorted(spans):
        _append_unique(areas, label)
    return areas


# Money like "22k", "22000", "22 thousand", "1.5 lakh".
# The unit must END on a word boundary. Without it the bare `k` alternative matched
# the FIRST LETTER of the next Hindi word, so "NSQF level 4 kiya hai" read the "k"
# of "kiya" as thousands and recorded a 4,000 salary — and so did every "<digit>
# kaam/karta/kiya" phrase. Same trap for the bare `l` in front of any l-word.
_SALARY_RE = re.compile(
    r"(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:[,\d]*)(?:\.\d+)?)\s*"
    r"((?:k|thousand|hazar|hzr|lakh|lac|l)\b)?",
    re.IGNORECASE,
)
_EXPECTED_CUES = ("expect", "chahiye", "chahie", "want", "expected", "demand", " chah")

# --- P1-3(b)/(c): salary PERIOD + year-vs-money cues ------------------------
# Read in a TIGHT window around the amount — wide enough for "1.5 lakh saal ka",
# narrow enough that the "5 saal" of an experience clause elsewhere in the same
# sentence cannot mark an unrelated amount as annual.
_PERIOD_WINDOW_BEFORE = 14
_PERIOD_WINDOW_AFTER = 18

# Annual cues are read ASYMMETRICALLY on purpose. AFTER the amount, a bare "saal"
# is the annual marker ("1.5 lakh saal ka"). BEFORE it, a bare "saal" is far more
# likely to be the EXPERIENCE clause ("5 saal se 25000 milta hai") — reading that
# as annual would divide a correct monthly wage by twelve, trading one wrong number
# for another. So the before-set carries only unambiguously annual words.
_ANNUAL_CUES_AFTER: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\bsaal\b", r"\bsal\b", r"\bsaalana\b", r"\bsalana\b", r"\bsalaana\b",
        r"\bvarsh\b", r"\bannum\b", r"\bannual\w*", r"\byearly\b", r"\byear\b",
        r"\bper\s*year\b", r"\bp\.?\s?a\.?\b", r"\blpa\b",
    )
)
_ANNUAL_CUES_BEFORE: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\bsaalana\b", r"\bsalana\b", r"\bsalaana\b", r"\bvarsh\b",
        r"\bannual\w*", r"\byearly\b", r"\bper\s*year\b", r"\bhar\s*saal\b",
    )
)
_MONTHLY_CUES: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\bmahin[ae]\b", r"\bmaheen[ae]\b", r"\bmonth\w*", r"\bmasik\b",
        r"\bp\.?\s?m\.?\b",
    )
)
# What makes a bare 4-digit number MONEY rather than a calendar year. Anchored
# patterns, not substrings: a loose "rs" would fire on the "rs" inside "years".
_MONEY_CUES: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"₹", r"\brs\.?\b", r"\binr\b", r"\brupee\w*", r"\brupa?y[ae]?\b",
        r"\bsal+ary\b", r"\btanakha\b", r"\btankha\b", r"\bpaga?ar?\b",
        r"\bmil(?:ta|te|ti)\b", r"\bkama\w*", r"\bpay\w*", r"\bwage\w*",
        r"\bstipend\b", r"\bincome\b", r"\bctc\b", r"\bmahin[ae]\b",
        r"\bmonth\w*", r"\bmasik\b", r"\bexpect\w*", r"\bchahi\w*",
    )
)
# --- Relocation willingness (issue #437: STOP FABRICATING willing_to_relocate) ---
#
# THE DEFECT (measured, 16/16 shop-floor phrases). These cues were BARE SUBSTRINGS:
#
#     _RELOCATE_CUES = ("relocat", "shift", "chalega", "ready", "ja sakta",
#                       "kahin bhi", "anywhere", "bahar", "outside")
#
# Every one of the short ones is CORE CNC/VMC SHOP VOCABULARY. They are what our
# target worker says describing the job they already have — not edge phrasing:
#
#     "night shift karta hu"              -> relocate=True   (working HOURS)
#     "outside diameter turning karta hu" -> relocate=True   (turning terminology)
#     "bahar ka diameter check karta hu"  -> relocate=True   ("bahar" = OUTER)
#     "vmc chalega mujhe"                 -> relocate=True   ("chalega" = it runs)
#     "ready hu machine ke liye"          -> relocate=True   (ready at the machine)
#
# So this fires on ordinary answers to OUR OWN machine and experience questions, and
# `willing_to_relocate` is PAYER-FACING: it reaches location_preference on the
# persisted profile and prints on the resume. A worker who never said a word about
# moving was advertised as willing to move, and nothing ever corrected it, because
# nothing re-asks a field the detector already filled.
#
# THE RULE, the same shape #436/#443 gave availability: relocation needs an explicit
# PLACE-CHANGE intent. A word that is only relocation-flavoured in context ("chalega",
# "ready", "bahar", "ja sakta") is a MODIFIER, never a cue on its own — it counts only
# when a PLACE it could apply to sits next to it. The decision is made in one place,
# with adjacency, instead of hoping a keyword list is unambiguous.
#
# FAIL DIRECTION is toward "unknown" (None), per the issue: an unset
# willing_to_relocate can still be asked; a fabricated one never gets corrected.

# GENERALITY-OF-PLACE idioms. These are the ONE group that stands alone: "anywhere"
# has no meaning except flexibility about WHERE, so it needs no verb beside it.
# Measured, not assumed — gating these on a verb cost two real corpus positives,
# "Maharashtra mein kahin bhi" and "anywhere in India", which are complete and
# unambiguous answers to "kahan kaam karna chahte hain?".
#
# Note which tokens are NOT here: every one #437 reported fabricating ("shift",
# "ready", "chalega", "outside", "bahar") is below, adjacency-gated. This group is
# untouched by that issue because none of it collides with shop vocabulary.
#
# SPELLING FAMILY (parser widening). "kahin bhi" is typed at least four ways by the
# same worker population, and the nasal is dropped as often as it is written. The
# alternation is generated from ONE stem rather than enumerated per spelling, so a
# spelling cannot go missing the way "kahi bhi" once did:
#   kahin | kahi | kahee | kaheen  x  bhi | bi
_RELOCATE_ANYWHERE = (
    r"(?:kah(?:in|i|ee|een)\s+bh?i|anywhere|any\s+where|"
    r"any\s+(?:city|place|location)|koi\s+bh?i\s+(?:sheher|shehar|shahar|city|jagah|"
    r"state|rajya)|india\s+me[in]?\s+kahin|out\s+of\s+station)"
)
# The same GENERALITY-OF-PLACE idiom in Devanagari ("कहीं भी" = anywhere, "जहाँ भी
# काम मिले" = wherever there is work). Kept OUT of `_RELOCATE_ANYWHERE` because that
# string is embedded in `\b...\b` wrappers, and `\b` does not work after a Devanagari
# matra (see :data:`_DEVANAGARI`) — wrapping these would make them silently dead.
_RELOCATE_ANYWHERE_DEV = _dev(r"(?:कहीं|कही|जहाँ|जहां|जहा)\s*भी")
_ANYWHERE_RE: tuple[re.Pattern[str], ...] = (
    re.compile(rf"\b{_RELOCATE_ANYWHERE}\b", re.IGNORECASE),
    re.compile(_RELOCATE_ANYWHERE_DEV, re.IGNORECASE),
)


def _has_anywhere_cue(text: str) -> bool:
    """True when the message carries a generality-of-place idiom ("kahin bhi").

    Used by :func:`_preferred_areas` to give "anywhere" PRECEDENCE over any state named
    in the same message: the worker said anywhere, so a state beside it is context, not
    the preference. Measured cases this exists for — every one recorded ``flexible`` on
    `main` and an incidental state in an earlier cut of the widening::

        "kahin bhi ja sakta hu, abhi Gujarat me kaam kar raha hu"  -> ['Gujarat']
        "Maharashtra me salary kam hai, kahin bhi bhej do"         -> ['Maharashtra']
        "mera bhai Kerala me hai, main kahin bhi ja sakta hu"      -> ['Kerala']
    """
    return any(p.search(text) for p in _ANYWHERE_RE)
# Places a move could be TO, INCLUDING the ambiguous ones. "bahar"/"outside" are here
# and not above because "bahar JAANA" is leaving town while "bahar KA diameter" is the
# outer diameter — only the verb beside it decides. "dusre sheher" likewise: on its own
# it is as often work history ("dusre sheher me kaam kiya tha") as an intention.
_RELOCATE_PLACE = (
    rf"(?:{_RELOCATE_ANYWHERE}|bahar|baahar|outside|kahin\s+aur|kahi\s+aur|"
    r"out\s+of\s+city|dusr[ae]\s+(?:sheher|shehar|shahar|city|jagah|state|rajya)|"
    r"doosr[ae]\s+(?:sheher|shehar|city|jagah)|second\s+city)"
)
# Moving/going VERBS — the intent half of the pair.
_RELOCATE_GO = (
    r"(?:ja\s+sakta|ja\s+sakti|ja\s+sakte|jaa\s+sakta|jaane|jane|jana|jaana|"
    r"jaunga|jaungi|jaaunga|nikal\s+sakta|rehne|rahne|settle|move|shift)"
)
# ACCEPTANCE — "that works for me". Only ever read against a PLACE.
_RELOCATE_OK = (
    r"(?:chalega|chalegi|chal\s+jayega|thik\s+hai|theek\s+hai|ok\s+hai|"
    r"koi\s+dikkat\s+nahi|problem\s+nahi)"
)
# WILLINGNESS — "I am ready/prepared". Only ever read against a move.
_RELOCATE_READY = r"(?:ready|taiyaar|taiyar|tayyar|rajee|raji)"

_RELOCATE_CUE_RE: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        # Explicit and unambiguous in English — the word means only this.
        r"\brelocat\w*",
        r"\btransfer\s+(?:le\s+)?(?:sakta|sakti|sakte|lunga|loonga)\b",
        # Generality of place — a complete flexibility answer on its own.
        rf"\b{_RELOCATE_ANYWHERE}\b",
        _RELOCATE_ANYWHERE_DEV,
        # A PLACE next to a GO verb, in either order: "bahar ja sakta hu",
        # "kahin bhi jaane ko taiyaar", "dusre sheher shift ho sakta hu".
        rf"\b{_RELOCATE_PLACE}\b[^.;!?]{{0,24}}?\b{_RELOCATE_GO}\b",
        rf"\b{_RELOCATE_GO}\b[^.;!?]{{0,24}}?\b{_RELOCATE_PLACE}\b",
        # A PLACE the worker ACCEPTS: "kahin bhi chalega", "koi bhi city chalega".
        # `chalega` alone is the machine verb ("vmc chalega mujhe") and never fires.
        rf"\b{_RELOCATE_PLACE}\b[^.;!?]{{0,24}}?\b{_RELOCATE_OK}\b",
        # READY/TAIYAAR attached to a MOVE, never to a machine: "bahar jaane ko
        # taiyaar hu", "relocate karne ke liye ready hu", "shift hone ko taiyaar hu".
        # "ready hu machine ke liye" has no move to attach to, so it stays unset.
        rf"\b{_RELOCATE_READY}\b[^.;!?]{{0,30}}?\b(?:{_RELOCATE_GO}|relocat\w*)\b",
        rf"\b(?:{_RELOCATE_GO}|relocat\w*)\b[^.;!?]{{0,30}}?\b{_RELOCATE_READY}\b",
        # "shift"/"move" as a PLACE-CHANGE verb: it must take a becoming-form
        # ("shift ho jaunga", "shift hone ko taiyaar"). "night shift karta hu",
        # "general shift", "shift me 12 ghante" carry no such form and stay unset.
        r"\b(?:shift|shifting)\s+(?:ho|hona|hone|hoke|ho\s+kar|kar\s+sakta|"
        r"kar\s+sakti)\b",
    )
)

def _has_relocate_cue(text: str, masked: str | None = None) -> bool:
    """True when ``text`` states a genuine willingness to CHANGE PLACE (#437).

    ``masked`` is the negation-masked text of the same length; when supplied, a cue
    whose characters fall inside a negated span is discarded, so "bahar nahi jaunga"
    and "relocate nahi kar sakta" no longer assert the opposite of what was said.
    """
    for pattern in _RELOCATE_CUE_RE:
        for match in pattern.finditer(text):
            if masked is None or not _negation_vetoed(
                masked, text, match.start(), match.end()
            ):
                return True
    return False
# --- Availability (issue #424 follow-up: STOP FABRICATING "immediate") ------
#
# THE DEFECT (measured, post-merge review of #429). These cues were BARE SUBSTRINGS:
#
#     _IMMEDIATE_CUES = ("immediate", "abhi", "turant", "free", "available", ...)
#     _NOTICE_CUES    = ("notice", "din lag", "days", "month", "mahina", ...)
#
# "abhi" merely means "right now / currently", and the question bank's OWN questions
# open with it — "Abhi kis sheher mein hain?" (current_location) and "Abhi salary
# kitni hai?" (salary_current). So the NATURAL answer to our own question invented an
# availability the worker never stated:
#
#     "abhi pune me hu"      -> {current_location: Pune,  availability: immediate}
#     "abhi 25000 milte hain"-> {salary_current: 25000,   availability: immediate}
#     "6 month ka experience hai"                      -> availability: notice_period
#     "freelance kaam karta hu" / "VMC free size job"  -> availability: immediate
#
# That is FABRICATION, not a coverage gap, and it is LIVE: availability is a reach
# scoring signal (apps/api/src/reach/reach.job-source.ts) and is rendered on the
# worker's resume. We were telling payers a worker could start immediately on the
# strength of the adverb in OUR question. It also silently satisfied the must-ask
# gate #429 added for `availability`, so that gate never fired on the common path.
#
# THE RULE: availability requires a GENUINE availability cue — joining / starting /
# being free / a notice duration — matched with WORD BOUNDARIES. A bare time adverb
# is only ever a MODIFIER: "abhi"/"aaj"/"kal" count only when they sit next to a
# join-or-start intent ("abhi join kar sakta hu", "aaj se ready hu"). Same shape as
# the TAX-WELD-1 blockers: the decision is made in ONE place with adjacency, not by
# hoping a keyword list is unambiguous.
#
# FAIL DIRECTION is deliberately toward "unknown". `availability` is a MUST_ASK topic
# (interview_engine.MUST_ASK_TOPICS, #424), so an undetected availability is simply
# ASKED — which is exactly what that gate is for. A FABRICATED one is never corrected:
# nothing downstream ever re-asks a topic the detector already marked answered.

# Time adverbs. NOT cues on their own — they only qualify a join/start intent.
_AVAIL_NOW = (
    r"(?:abhi|filhal|filhaal|turant|fauran|foran|aaj|kal|immediately|right\s+now)"
)
# Joining/starting INTENT: ability or future forms only. Past-tense joins ("2019 me
# company join ki thi", "kal join ki thi") are history, not availability, so they are
# deliberately unmatched.
#
# BARE `ready` IS NOT HERE — adversarial review of #436, HIGH-1. The first cut ended
# this alternation with `|ready)`, which combined with the adverb-adjacency rule below
# to re-create the EXACT bug class this module exists to kill, in the register it most
# needed to protect. On a shop floor "job" means the WORKPIECE, and "ready" is what you
# say about a part, a tool, a fixture or a drawing:
#
#     "job abhi ready hai"            -> immediate   (the PART is ready)
#     "machine abhi ready hai"        -> immediate
#     "tool aaj ready ho jayega"      -> immediate
#     "fixture aaj ready karna hai"   -> immediate
#     "kal meri shaadi hai to ready rahunga" -> immediate
#
# `ready` now only counts when it is attributed to the WORKER (a first-person copula,
# or an explicit "main/mai/I am"), or carries the "to join" suffix — the same
# self-attribution test that `available` already correctly required.
_AVAIL_JOIN = (
    r"(?:join\s+kar\s+(?:sakta|sakti|sakte)|join\s+(?:kar\s+)?"
    r"(?:lunga|loonga|luga|karunga|karoonga|sakunga)|joining\s+(?:kar\s+)?"
    r"(?:sakta|sakti|sakte|lunga)|aa\s+(?:sakta|sakti|sakte|jaunga|jaungi)|"
    r"(?:start|shuru)\s+kar\s+(?:sakta|sakti|sakte|dunga))"
)

# STRONG cues: the word itself is the answer, whoever is speaking. No blocker needed.
_IMMEDIATE_STRONG_RE: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\bimmediate(?:ly)?\b",
        r"\bturant\b",
        r"\bfaura?n\b",
        r"\bforan\b",
        # `ready` WITH the joining suffix — "ready to join", "join karne ke liye ready".
        r"\bready\s+(?:to\s+)?join\b",
        r"\bjoin\w*\s+(?:ke\s+liye|kar\w*\s+ke\s+liye)\s+ready\b",
        # A time adverb NEXT TO a join/start intent, in either word order. This is the
        # ONLY way "abhi"/"aaj"/"kal" can contribute, and the whole point of the fix.
        rf"\b{_AVAIL_NOW}\b[^.;!?]{{0,20}}?\b{_AVAIL_JOIN}\b",
        rf"\b{_AVAIL_JOIN}\b[^.;!?]{{0,20}}?\b{_AVAIL_NOW}\b",
    )
)

# SELF-STATE cues: "I am, right now, not working / free / ready". These are real
# availability answers, but every one of them is SUBJECT- and TENSE-sensitive, so each
# is additionally gated on :func:`_self_state_blocked`.
#
# FIRST PERSON IS REQUIRED (adversarial review of #436, HIGH-2). The first cut accepted
# `hai`/`hain` here and justified it with "the copula makes this safe". That reasoning
# was wrong: `hai`/`hain` are THIRD person, so objects became available workers —
# "machine free hai", "wo free hai". `available` in the very same tuple already demanded
# `main|mai|hum|i am`; these cues are now consistent with it.
_IMMEDIATE_SELF_STATE_RE: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        # Being free / idle. First-person copula ONLY, so "machine free hai" and the
        # "freelance"/"free size job" substrings can never fire it.
        r"\b(?:free|khaali|khali|faarig|farig|fursat)\s+(?:hu|hun|hoon)\b",
        rf"\b(?:{_AVAIL_NOW}|main|mai|bilkul)\s+(?:free|khaali|khali)\b",
        # `ready` attributed to the worker.
        r"\bready\s+(?:hu|hun|hoon)\b",
        r"\b(?:main|mai|hum|i\s*am|i'?m)\s+ready\b",
        # "available" attributed to the WORKER, never to a job/machine — "koi job
        # available hai kya?" is a question about vacancies, not a start date.
        rf"\b(?:main|mai|hum|i\s*am|i'?m|{_AVAIL_NOW})\s+available\b"
        r"(?!\s+(?:machine|machines|job|jobs|kaam|work|vacanc|position))",
        r"\bavailable\s+(?:hu|hun|hoon)\b",
        # Left the job. Past-perfect ("chhod di THI") is handled by the tense blocker.
        r"\b(?:job|naukri|company|kaam)\s+chhod\s+(?:di|diya|dia|dii)\b",
        # First person only: "mera bhai berozgar hai" is someone else's unemployment.
        r"\bberozgar\s+(?:hu|hun|hoon)\b",
    )
)

# NEGATION-BEARING cues: these carry a negator INSIDE the phrase, and that negator is
# what makes them mean "available" ("kaam nahi kar raha" = "I am not working" = free).
# They are therefore EXEMPT from the negation veto below — vetoing them would delete
# the very positives the veto exists to protect. Split out of the tuple above so the
# exemption is a property of the CUE, declared once, instead of a special case buried
# in the matching loop.
_IMMEDIATE_NEGATION_BEARING_RE: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        # Not currently working. `hai`, `mil raha` and `milta` were DROPPED (review of
        # #436, MEDIUM-3): "yahan acha kaam nahi milta" is a complaint about the
        # current job, and "kaam nahi hai" is as often about the shop's workload.
        r"\b(?:kaam|job|naukri|kuch)\s+(?:nahi+n?|nhi)\s+(?:kar\s+raha|kar\s+rahi)\b",
    )
)

# Blockers for the SELF-STATE family (adversarial review of #436, HIGH-2 + MEDIUM-3).
# Read in a window AROUND the cue, not over the whole message, so an unrelated later
# clause cannot suppress a genuine answer.
_SELF_STATE_WINDOW_BEFORE = 34
_SELF_STATE_WINDOW_AFTER = 16

# The cue describes a THING, not the worker. "job" is deliberately here: on a shop
# floor it means the workpiece.
_SELF_STATE_OBJECT = (
    r"\b(?:machine|machines|tool|tools|fixture|jig|drawing|piece|part|parts|spindle|"
    r"job|component|material|order)\b"
)
# The cue describes SOMEONE ELSE.
_SELF_STATE_THIRD_PARTY = (
    r"\b(?:wo|woh|uska|uski|unka|unki|bhai|dost|saathi|beta|papa|friend|colleague|"
    r"bandha|aadmi|ladka)\b"
)
# The state is TIME-SCOPED — free on Sunday / at lunch is not free for a job.
_SELF_STATE_TIME_SCOPE = (
    r"\b(?:sunday|saturday|monday|tuesday|wednesday|thursday|friday|ravivar|itwar|"
    r"shanivar|weekend|chutti|holiday|lunch|shaam|subah|raat|dopahar|evening|"
    r"morning|night|shift)\b"
)
# The state is in the PAST.
_SELF_STATE_PAST_BEFORE = r"\b(?:pehle|pichl[ae]|pichli|puran[ae]|purani|last)\b"
_SELF_STATE_PAST_AFTER = r"\b(?:tha|thi|the)\b"
# ...or it has since been resolved: "berozgar tha pehle, ab kaam mil gaya".
_SELF_STATE_RESOLVED = r"\b(?:kaam|job|naukri)\s+mil\s+(?:gaya|gayi|gya|gyi)\b"

_SELF_STATE_BEFORE_RE = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        _SELF_STATE_OBJECT,
        _SELF_STATE_THIRD_PARTY,
        _SELF_STATE_TIME_SCOPE,
        _SELF_STATE_PAST_BEFORE,
    )
)
_SELF_STATE_AFTER_RE = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (_SELF_STATE_PAST_AFTER, _SELF_STATE_RESOLVED)
)


def _self_state_blocked(text: str, start: int, end: int) -> bool:
    """True when a SELF-STATE availability cue is not about the worker being free NOW.

    Three ways that happens, each a MEASURED failure from the review of #436, not a
    hypothetical:

    - the subject is an OBJECT ("machine free hai", "machine sahi kaam nahi kar rahi")
      or a THIRD PARTY ("mera bhai berozgar hai");
    - the state is TIME-SCOPED ("sunday free hu", "lunch me free hu") — free at a time
      is not free for a job;
    - the state is PAST or already RESOLVED ("pichli job chhod di THI 2019 me",
      "berozgar tha pehle ab kaam mil gaya").

    Windowed rather than whole-message so a later unrelated clause cannot suppress a
    real answer. Fail direction stays toward "unknown": a blocked cue leaves
    availability unset, and #429's must-ask gate then asks the question properly.
    """
    before = text[max(0, start - _SELF_STATE_WINDOW_BEFORE): start]
    after = text[end: end + _SELF_STATE_WINDOW_AFTER]
    return any(p.search(before) for p in _SELF_STATE_BEFORE_RE) or any(
        p.search(after) for p in _SELF_STATE_AFTER_RE
    )


def _negation_vetoed(masked: str, raw: str, start: int, end: int) -> bool:
    """True when the cue matched at ``[start:end)`` sits inside a NEGATED span.

    Issue #441 B. Availability is matched against the RAW text, not the
    negation-masked text, and that is deliberate — :func:`_apply_negation` blanks a
    backward window from the negator, which would delete the "kaam" out of "kaam nahi
    kar raha" (a phrase whose negator is what makes it mean *available*). So we cannot
    simply feed availability the masked string; #443 measured that and left the gap
    open rather than trade one fabrication for another.

    But leaving it open meant a worker explicitly DECLINING was recorded as ACCEPTING:

        "abhi available nahi hu"    -> availability: immediate
        "turant join nahi kar sakta"-> availability: immediate
        "abhi khaali nahi hu"       -> availability: immediate

    The resolution is to use the masked text as a VETO rather than as the input. The
    cue still matches the raw text (so nothing is deleted out from under it), and the
    match is then discarded if :func:`_apply_negation` blanked any of the characters it
    matched on — i.e. if the phrase we read was inside the scope of a negator. Cues
    that carry their own negator are exempt by construction: they live in
    :data:`_IMMEDIATE_NEGATION_BEARING_RE` and never reach this check.

    Masking preserves LENGTH (it substitutes spaces), so ``masked`` and ``raw`` offsets
    are the same string positions and a plain slice comparison is exact.
    """
    return masked[start:end] != raw[start:end]


# How many word-tokens before a cue are scanned for a PRE-POSED negator. Two: enough
# for "turant nahi aa sakta" / "abhi nahi join kar sakta", tight enough that a negator
# in an earlier, unrelated part of the same clause cannot reach the cue
# ("kaam nahi milta isliye turant join kar sakta hu" — "nahi" is three tokens back).
_PRE_NEGATOR_LOOKBACK = 2


def _preceded_by_negator(text: str, start: int) -> bool:
    """True when a negator sits immediately BEFORE the cue, inside the same clause.

    Issue #441 B, second half. :func:`_apply_negation` masks BACKWARD from the negator,
    because Hindi normally negates after what it negates ("ITI nahi kiya"). Negated
    ABILITY inverts that word order — the negator comes FIRST:

        "turant nahi aa sakta"      ("cannot come immediately")
        "abhi nahi join kar sakta"

    so the backward mask covers "turant"/"abhi" and leaves the ability verb — the cue
    we actually match on — untouched. That is the documented cost of backward-only
    masking, and for most cue families missing it is the safe direction. For
    availability it is NOT: the cue still fires and records the OPPOSITE of what the
    worker said. So availability additionally checks the tokens directly in front of
    the cue, which is the adjacency shape TAX-WELD-1 uses for the welding cues.

    Clause-clamped, so a negator in a previous clause cannot suppress a genuine answer:
    "kaam nahi kar raha, turant join kar sakta hu" keeps its cue.
    """
    clause_start = 0
    for c_start, c_end in _clause_bounds(text):
        if c_start <= start < c_end:
            clause_start = c_start
            break
    before = [
        m.group(0).strip(_TOKEN_TRIM).lower()
        for m in _WORD_RE.finditer(text[clause_start:start])
    ]
    return any(
        token in _NEGATORS for token in before[-_PRE_NEGATOR_LOOKBACK:]
    )


def _availability_negated(masked: str, raw: str, start: int, end: int) -> bool:
    """Both halves of the #441 B veto: the cue is inside a negated span, or a negator
    sits directly in front of it."""
    return _negation_vetoed(masked, raw, start, end) or _preceded_by_negator(raw, start)


def _has_immediate_cue(text: str, masked: str | None = None) -> bool:
    """True when ``text`` carries a genuine "can start now" cue.

    Strong cues fire on their own; self-state cues must also survive
    :func:`_self_state_blocked`. Both are additionally vetoed when the phrase is
    NEGATED (#441 B) — passing ``masked`` (the negation-masked text of the same
    length) turns that veto on. Negation-bearing cues are matched separately and are
    never vetoed, because their negator is the signal.
    """
    def vetoed(start: int, end: int) -> bool:
        return masked is not None and _availability_negated(masked, text, start, end)

    for pattern in _IMMEDIATE_STRONG_RE:
        for match in pattern.finditer(text):
            if not vetoed(match.start(), match.end()):
                return True
    for pattern in _IMMEDIATE_SELF_STATE_RE:
        for match in pattern.finditer(text):
            if not _self_state_blocked(text, match.start(), match.end()) and not vetoed(
                match.start(), match.end()
            ):
                return True
    for pattern in _IMMEDIATE_NEGATION_BEARING_RE:
        for match in pattern.finditer(text):
            if not _self_state_blocked(text, match.start(), match.end()):
                return True
    return False


def _has_notice_cue(text: str, masked: str | None = None) -> bool:
    """True when ``text`` states a notice period, and is not DENYING one (#441 B).

    Same veto as :func:`_has_immediate_cue`; no notice cue carries its own negator, so
    all of them are subject to it ("notice period nahi hai" is not a notice period).
    """
    for pattern in _NOTICE_CUE_RE:
        for match in pattern.finditer(text):
            if masked is None or not _availability_negated(
                masked, text, match.start(), match.end()
            ):
                return True
    return False

# Notice-period durations. Deliberately EXCLUDES "saal"/"year": years are experience,
# never a notice period — and the experience clause is precisely what the old bare
# "month"/"mahina"/"days" cues were misreading.
_AVAIL_NUM = (
    r"(?:\d{1,3}|ek|do|teen|tin|char|chaar|paanch|panch|chhah|chhe|saat|aath|das|"
    r"pandrah|bees|tees|one|two|three|four|five|six|seven|ten|fifteen|twenty|thirty)"
)
_AVAIL_UNIT = (
    r"(?:din|days?|hafte|haftey|hafta|weeks?|mahin[ae]|maheen[ae]|months?)"
)
# A duration only means NOTICE when it is the time something TAKES — "15 din lagenge",
# "30 din baad". A duration on its own ("6 month ka experience hai") means nothing
# about availability, so it is left to the context-gated read in
# detect_answered_topics, where we know the availability question was the one asked.
_NOTICE_CUE_RE: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\bnotice\b",
        r"\bresign\b",
        r"\bnext\s+month\b",
        rf"\b{_AVAIL_NUM}\s*{_AVAIL_UNIT}\b[^.;!?]{{0,14}}?\b(?:lag\w*|baad|bad)\b",
        rf"\blag\w*\b[^.;!?]{{0,14}}?\b{_AVAIL_NUM}\s*{_AVAIL_UNIT}\b",
    )
)

# Read ONLY when the availability question is the one that was just asked (see
# detect_answered_topics). These phrasings are real answers to "join karne mein kitne
# din lagenge?" but say nothing on their own in the middle of a transcript, so they
# must never run context-free — that is how "6 month" became a notice period.
_ASKED_NOTICE_RE = re.compile(rf"\b{_AVAIL_NUM}\s*{_AVAIL_UNIT}\b", re.IGNORECASE)
# The same pattern with the number and unit CAPTURED, so the duration can be read as
# a value and not just detected. Kept as a separate compile rather than adding groups
# to the one above, because that one is used with `finditer` in boolean contexts where
# a group change would be an invisible behaviour change.
_ASKED_NOTICE_SPAN_RE = re.compile(rf"\b({_AVAIL_NUM})\s*({_AVAIL_UNIT})\b", re.IGNORECASE)

# ...and even in that context, a duration is only a NOTICE if it is time-until, not
# time-since or a work pattern (adversarial review of #436, MEDIUM-5). `last_asked` is
# ``asked_question_ids[-1]`` — "the last question we asked", NOT "the question this
# message answers" — so while availability is pending the worker may still be talking
# about something else:
#
#     "10 din pehle join kiya tha"    -> notice_period   (time AGO)
#     "hafte me 6 din kaam karta hu"  -> notice_period   (a work WEEK)
#     "do mahine se salary nahi mili" -> notice_period   (time SINCE)
#
# "X se" is "for the last X" while "X baad"/"X mein" is "in X" — the distinction that
# separates all three of these from a real notice period.
_ASKED_NOTICE_BLOCKERS_RE: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\bpehle\b",            # "10 din pehle" — that many days AGO
        r"\bse\b",               # "do mahine se" — FOR the last two months
        r"\bkaam\s+kar",         # "hafte me 6 din kaam karta hu" — a work pattern
        r"\bexperience\b",
    )
)
_ASKED_NOTICE_BLOCK_WINDOW = 14


def _asked_notice_blocked(text: str, start: int, end: int) -> bool:
    """True when a bare duration in an availability-context message is not a notice."""
    window = text[max(0, start - _ASKED_NOTICE_BLOCK_WINDOW): start] + " " + text[
        end: end + _ASKED_NOTICE_BLOCK_WINDOW
    ]
    return any(p.search(window) for p in _ASKED_NOTICE_BLOCKERS_RE)


_AVAIL_WORD_NUMBERS: dict[str, int] = {
    "ek": 1, "one": 1,
    "do": 2, "two": 2,
    "teen": 3, "tin": 3, "three": 3,
    "char": 4, "chaar": 4, "four": 4,
    "paanch": 5, "panch": 5, "five": 5,
    "chhah": 6, "chhe": 6, "six": 6,
    "saat": 7, "seven": 7,
    "aath": 8,
    "das": 10, "ten": 10,
    "pandrah": 15, "fifteen": 15,
    "bees": 20, "twenty": 20,
    "tees": 30, "thirty": 30,
}
# Calendar-ish, deliberately coarse. A worker saying "do mahine" means "about two
# months", not 61 days, and the field feeds a payer-facing band.
_AVAIL_UNIT_DAYS: tuple[tuple[str, int], ...] = (
    ("din", 1), ("day", 1),
    ("hafte", 7), ("haftey", 7), ("hafta", 7), ("week", 7),
    ("mahin", 30), ("maheen", 30), ("month", 30),
)


def _notice_days(num: str, unit: str) -> int | None:
    """"15 din" -> 15, "do mahine" -> 60, "ek hafta" -> 7."""
    low_num, low_unit = num.lower(), unit.lower()
    value = _AVAIL_WORD_NUMBERS.get(low_num)
    if value is None:
        try:
            value = int(low_num)
        except ValueError:
            return None
    for stem, days in _AVAIL_UNIT_DAYS:
        if low_unit.startswith(stem):
            return value * days
    return None


def _notice_period_days(text: str, masked: str | None = None) -> int | None:
    """The notice duration IN DAYS, or None when the message does not state one.

    Reads the same spans `_asked_notice_duration` reads, through the same blocker
    and negation vetoes, so the number can never disagree with the `notice_period`
    status it accompanies: "10 din pehle join kiya tha" (time AGO), "hafte me 6 din
    kaam karta hu" (a work WEEK) and "15 din nahi lagenge" (a denial) yield None
    here for exactly the reasons they yield no notice there.

    Prefers NULL on any ambiguity. A fabricated "15 days" on a worker's resume is
    worse than a blank, and this field is payer-visible.
    """
    for m in _ASKED_NOTICE_SPAN_RE.finditer(text):
        if _asked_notice_blocked(text, m.start(), m.end()):
            continue
        if masked is not None and _availability_negated(masked, text, m.start(), m.end()):
            continue
        days = _notice_days(m.group(1), m.group(2))
        if days is not None:
            return days
    return None


def _asked_notice_duration(text: str, masked: str | None = None) -> bool:
    """A bare duration that really does read as "this long until I can join".

    ``masked`` adds the #441 B negation veto: "15 din nahi lagenge" is not a notice.
    """
    return any(
        not _asked_notice_blocked(text, m.start(), m.end())
        and (
            masked is None
            or not _availability_negated(masked, text, m.start(), m.end())
        )
        for m in _ASKED_NOTICE_RE.finditer(text)
    )
_ASKED_IMMEDIATE_RE: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        # "whenever you say" — genuinely immediate. Matched EXPLICITLY so it stops
        # being read as immediate for the wrong reason (the old cue found the "abhi"
        # inside "kabhi"; "kabhi kabhi" = "sometimes" scored the same way).
        r"\bkabhi\s+bhi\b",
        r"\bjab\s+(?:bolo|bhi|kaho|chaho|bulao|bulaye)\b",
        r"\banytime\b",
        # A bare time adverb IS the answer to "how many days to join?" — but only when
        # it is the WHOLE answer. Anchored at BOTH ends (review of #436, HIGH-1): the
        # first cut anchored only the start, so any long sentence that happened to open
        # with a time word was read as a start date —
        # "kal meri shaadi hai to ready rahunga" -> immediate.
        rf"^\W*{_AVAIL_NOW}(?:\s+(?:hi|se|tak|ko|hi\s+se|se\s+hi))?\W*$",
        # Ability to join, with no immediacy adverb attached.
        rf"\b{_AVAIL_JOIN}\b",
        # A time adverb next to a bare CAN-DO verb. Only reachable here, in the
        # context-gated table, because it is only unambiguous when the availability
        # question is the one on screen: "abhi kar sakta hun" answering "join karne
        # mein kitne din lagenge?" means "I can start now", while the same words
        # answering anything else could be about the WORK. Measured on an owner
        # session: "abhi kar sakta hun package de doge toh" -> availability unknown,
        # because `_AVAIL_JOIN` requires an explicit join/start verb and this has
        # none. Bare "abhi" remains barred from the context-free table for the
        # documented reason — our own questions open with it.
        rf"\b{_AVAIL_NOW}\b[^.;!?]{{0,20}}?\b(?:kar|karna)\s+(?:sakta|sakti|sakte)\b",
    )
)


# --- P1-2: negation ---------------------------------------------------------
#
# THE DEFECT: every cue below is a plain substring/regex test, so a DENIAL read as
# an assertion — "iti nahi kiya" -> education ["ITI"], "diploma nahi hai" ->
# ["Diploma"], "setting nahi aati, sirf chalata hu" -> skills ["basic setting"].
# That is the OPPOSITE of what the worker said, and it ships onto their resume.
#
# THE RULE (see the PR body): in Hindi/Hinglish the negator FOLLOWS what it negates
# ("ITI nahi kiya", "setting nahi aati", "diploma nahi hai"), so the scope is a
# BACKWARD window of _NEGATION_BACK_WORDS words from the negator, CLAMPED to the
# enclosing clause. Those characters are blanked out before ANY cue matching runs.
#
# Backward-ONLY is a deliberate choice, not an oversight. The contrastive
# "X nahi, Y karta hu" is extremely common and often written WITHOUT the comma
# ("CNC nahi VMC karta hu"); a forward window would swallow the correction Y — the
# very value the worker is asserting. The cost is that a PRE-posed negator
# ("na ITI na diploma", "no ITI") is not suppressed. That direction is the safe
# one to miss: we prefer MISSING data (the topic gets re-asked / stays empty) over
# WRONG data, which is the whole point of this fix.
_NEGATION_BACK_WORDS = 3

# Clause boundaries. Punctuation (incl. the Devanagari danda) plus the contrastive
# connectors that start a NEW assertion — "setting nahi aati, sirf chalata hu".
# A spurious split only ever SHRINKS a negation scope, which is the safe direction.
_CLAUSE_SPLIT_RE = re.compile(
    r"[,;:.!?|/\n\r।]+|\s(?:lekin|magar|balki|but|sirf|only|bas|kintu|parantu)\s",
    re.IGNORECASE,
)

# Unambiguous negators: these are never a tag/affirmation in worker speech.
_NEGATORS: frozenset[str] = frozenset(
    {
        "nahi", "nahin", "nahee", "nahii", "nai", "nhi", "nahiin",
        "mat", "not", "never",
        "नहीं", "नही", "नहि", "मत", "न",
    }
)
# NOT included: bare English "no". In this domain it is far more often the
# ABBREVIATION ("part no. 12", "drawing no. 45") than a denial, and as a negator it
# would blank the three words before it — deleting "drawing" from a worker who
# reads drawings. "nahi" and its spellings carry the real load in worker replies.

# "na" / "ना" are negators ONLY sometimes: Hinglish also uses a CLAUSE-FINAL "na"
# as an affirmative tag ("VMC chalata hu na" = "I do run VMC, right?"). Treating
# that as a denial would delete the very machine the worker just claimed, so "na"
# only negates when it is followed by more words in its clause AND is not sitting
# right after a verb/copula (the tag position).
_TAG_ONLY_NEGATORS: frozenset[str] = frozenset({"na", "ना"})
_TAG_PRECEDERS: frozenset[str] = frozenset(
    {
        "hu", "hun", "hoon", "hai", "hain", "ho", "hota", "hoti",
        "tha", "the", "thi", "karta", "karte", "karti", "aata", "aati", "aate",
        "chalata", "chalate", "chalati", "theek", "thik", "haan", "han", "sahi", "ok",
    }
)

_WORD_RE = re.compile(r"\S+")
# Trim leading/trailing punctuation so "nahi," tokenizes as "nahi".
_TOKEN_TRIM = " \t\r\n.,;:!?\"'()[]{}-–—।|/"

# Which TOPIC a negated cue belongs to. Only cue families whose denial is itself a
# complete answer are listed (see detect_answered_topics) — deliberately NOT
# machines/role/location/salary, where "VMC nahi" is a denial, not an answer.
_NEGATABLE_TOPIC_CUES: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "education",
        re.compile(r"\biti\b|diploma|\b(?:b\.?tech|be|degree|engineering)\b|nsdc|rvm", re.I),
    ),
    (
        "certifications",
        re.compile(r"\bncvt\b|\bscvt\b|\bnsqf\b|apprentice|certificate|certification", re.I),
    ),
    (
        "skills",
        re.compile(
            r"setting|set\s?up|"
            + "|".join(re.escape(kw) for kw, _label, _sid in _SKILLS),
            re.IGNORECASE,
        ),
    ),
)

# Topics for which a DENIAL is a COMPLETE answer, so the ask is satisfied ("kya
# training li hai?" -> "ITI nahi kiya"; "kya aata hai?" -> "setting nahi aati").
# Deliberately excludes the essentials (role/machines/current_location) and salary:
# "VMC nahi chalaya" is a denial, not an answer, and closing those asks on it would
# ship an incomplete profile silently — the engine must still ask them.
_NEGATION_ANSWERS_TOPICS: frozenset[str] = frozenset(
    {"education", "skills", "certifications"}
)

# P1-1: an EXPLICIT self-correction. Only these let a value for a topic that is NOT
# the one being asked overwrite an already-collected value (see interview_engine).
_CORRECTION_MARKERS: tuple[str, ...] = (
    "nahi nahi", "nahin nahin", "nhi nhi", "nahi nhi", "nai nai",
    "galat", "ghalat", "sorry", "correction", "correct kar",
    "actually", "asal mein", "asal me", "sudhar", "wapas se",
    "नहीं नहीं", "गलत",
)


def _clause_bounds(text: str) -> list[tuple[int, int]]:
    """(start, end) offsets of each clause in ``text`` (splitters excluded)."""
    bounds: list[tuple[int, int]] = []
    cursor = 0
    for sep in _CLAUSE_SPLIT_RE.finditer(text):
        if sep.start() > cursor:
            bounds.append((cursor, sep.start()))
        cursor = sep.end()
    if cursor < len(text):
        bounds.append((cursor, len(text)))
    return bounds


def _is_negator(token: str, prev_token: str | None, is_clause_final: bool) -> bool:
    if token in _NEGATORS:
        return True
    if token in _TAG_ONLY_NEGATORS:
        # Clause-final "na" is the affirmative tag, and "…hu na" is too.
        return not is_clause_final and (prev_token or "") not in _TAG_PRECEDERS
    return False


def _apply_negation(text: str) -> tuple[str, set[str]]:
    """Blank out negated spans and report which TOPICS were negated.

    Returns ``(masked_text, negated_topic_ids)``. Masking replaces the negated
    characters with spaces, so the string keeps its LENGTH and every offset-based
    reader downstream (city spans, salary windows, ``_level_near``) is unaffected.
    """
    if not text:
        return text, set()
    chars = list(text)
    negated_spans: list[tuple[int, int]] = []
    for c_start, c_end in _clause_bounds(text):
        words = [
            (m.start() + c_start, m.end() + c_start, m.group(0).strip(_TOKEN_TRIM).lower())
            for m in _WORD_RE.finditer(text[c_start:c_end])
        ]
        for i, (_ws, _we, word) in enumerate(words):
            prev_token = words[i - 1][2] if i > 0 else None
            if not _is_negator(word, prev_token, is_clause_final=i == len(words) - 1):
                continue
            back = words[max(0, i - _NEGATION_BACK_WORDS): i]
            if not back:
                continue
            negated_spans.append((back[0][0], back[-1][1]))
    topics: set[str] = set()
    for start, end in negated_spans:
        span_text = text[start:end]
        for topic_id, pattern in _NEGATABLE_TOPIC_CUES:
            if pattern.search(span_text):
                topics.add(topic_id)
        for k in range(start, end):
            chars[k] = " "
    return "".join(chars), topics


def is_correction(text: str) -> bool:
    """P1-1: True when the worker is EXPLICITLY correcting themselves ("nahi nahi,
    10 saal"). Only then may a value for a topic other than the one being asked
    overwrite what was already collected."""
    low = (text or "").lower()
    return any(marker in low for marker in _CORRECTION_MARKERS)


@dataclass
class Signals:
    primary_role: str | None = None
    role_id: str | None = None
    trade_id: str | None = None
    secondary_roles: list[str] = field(default_factory=list)
    machines: list[str] = field(default_factory=list)
    machine_ids: list[str] = field(default_factory=list)
    controllers: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
    skill_ids: list[str] = field(default_factory=list)
    experience_years: float | None = None
    setting_knowledge: KnowledgeLevel = "unknown"
    operation_knowledge: KnowledgeLevel = "unknown"
    programming_knowledge: KnowledgeLevel = "unknown"
    drawing_reading: bool | None = None
    inspection_tools: list[str] = field(default_factory=list)
    materials_handled: list[str] = field(default_factory=list)
    current_city: str | None = None
    current_state: str | None = None
    preferred_locations: list[str] = field(default_factory=list)
    relocation_willingness: bool | None = None
    current_salary: int | None = None
    expected_salary: int | None = None
    availability: str = "unknown"
    # Days until the worker can join, when they stated one. None whenever the message
    # says `notice_period` without a duration, or states one ambiguously — the field
    # is payer-visible and a guessed number is worse than a blank.
    notice_period_days: int | None = None
    education: list[str] = field(default_factory=list)
    certifications: list[str] = field(default_factory=list)


def _append_unique(items: list[str], value: str) -> None:
    if value not in items:
        items.append(value)


def _level_near(text: str, keyword: str) -> KnowledgeLevel:
    """Infer a knowledge level from words near a keyword occurrence."""
    idx = text.find(keyword)
    if idx == -1:
        return "unknown"
    window = text[max(0, idx - 25): idx + len(keyword) + 25]
    basic_cues = ("thoda", "basic", "little", "thodi", "kam")
    strong_cues = ("full", "poora", "pura", "expert", "strong", "achha", "acha", "master")
    if any(w in window for w in basic_cues):
        return "basic"
    if any(w in window for w in strong_cues):
        return "strong"
    return "basic"


def _parse_amount(num: str, unit: str | None, months: int = 1) -> int | None:
    """Parse an amount to a MONTHLY rupee figure.

    ``months`` is the period the stated amount covers (1 = monthly, 12 = annual),
    so an annual figure is divided down instead of being stored as a monthly one
    (P1-3(b)). The plausibility ceiling is applied to the MONTHLY result, which is
    what the field actually means.
    """
    try:
        value = float(num.replace(",", ""))
    except ValueError:
        return None
    unit = (unit or "").lower()
    if unit in ("k", "thousand", "hazar", "hzr"):
        value *= 1_000
    elif unit in ("lakh", "lac", "l"):
        value *= 100_000
    if months > 1:
        value /= months
    # Ceiling shared with the pseudonymizer's D-1 money carve-out (single source
    # of truth in pseudonymize.py): what this accepts as a salary, the gateway
    # masks as [AMOUNT_n] instead of blocking the turn.
    if value <= 0 or value > MAX_PLAUSIBLE_SALARY_INR:
        return None
    return int(value)


def _detect_welding(lower: str, sig: Signals) -> None:
    """Append welding skill LABELS + canonical skill ids found in ``lower``.

    Order-preserving and de-duplicated. Writes ONLY the five pre-existing, active
    ``skill_*`` ids listed on :data:`_WELDING` — it can never mint an id, and it never
    writes free text into a matchable field. Deliberately writes NO ``mach_*`` id: the
    taxonomy has no welding machine id and the corpus models TIG/MIG/arc as SKILLS, so
    inventing one would be minting.
    """
    for pattern, label, skill_id in _WELDING_RE:
        if pattern.search(lower):
            _append_unique(sig.skills, label)
            _append_unique(sig.skill_ids, skill_id)


def has_machining_signal(lower: str, sig: Signals) -> bool:
    """True when ``lower`` carries ANY machining evidence.

    Three independent sources, so a machining worker is caught even when `_ROLES`
    (which has no `cnc`/`lathe`/`milling`/`operator` entry) assigns nothing:
    a detected machine id, a detected controller, or a machining keyword.
    """
    return bool(
        sig.machine_ids
        or sig.controllers
        or any(p.search(lower) for p in _MACHINING_CONTEXT_RE)
    )


def welding_role_blocked(lower: str) -> bool:
    """True when welding words are present but the worker is not claiming the trade
    (explicit denial, or a welding-adjacent non-welder: rod supplier, machine repair)."""
    return any(p.search(lower) for p in _WELDING_ROLE_BLOCKERS_RE)


def _assign_welding_role(lower: str, sig: Signals) -> None:
    """Assign ``role_welder``/``dom_welding`` — the ONLY place welding sets a role.

    Every condition is a guard against a MEASURED failure, not a hypothetical:

    - ``sig.role_id is None``   — never displace an assigned machining role.
    - no machining signal       — and never fill a MACHINING None either. Welding
      keywords co-occur with machining work constantly ("cnc operator hun, welding
      bhi kar leta hun"; "pehle welding karta tha, ab CNC lathe chalata hu"), and a
      wrong role scores 0.0 in the Reach engine where None scores 0.4 — so filling
      those Nones was a ranking REGRESSION for real machining workers.
    - not blocked               — explicit denial ("welding nahi karta, sirf helper
      hu") and welding-adjacent non-welders (rod supply, machine repair) must not
      become welders.
    - a welding-DOMAIN skill    — `skill_gas_cutting` alone (domain `fabrication`)
      never implies the welder role.

    Skills are left untouched by all of this: the worker still gets their welding
    skill ids, they just do not get a welder ROLE they did not claim.
    """
    if sig.role_id is not None:
        return
    if has_machining_signal(lower, sig) or welding_role_blocked(lower):
        return
    if not any(s in _WELDING_DOMAIN_SKILL_IDS for s in sig.skill_ids):
        return
    sig.primary_role = "Welder"
    sig.role_id = "role_welder"
    sig.trade_id = "dom_welding"


def detect(text: str) -> Signals:
    """Detect all profile signals in ``text`` (raw worker text, trusted local).

    P1-2: NEGATED spans are blanked (:func:`_apply_negation`) before the CAPABILITY
    cue tables run, so a denial can no longer assert its own opposite. Masking
    preserves string length, so all offset-based logic here is unchanged.
    """
    sig = Signals()
    # Negation applies to the CAPABILITY cue families (role / machines /
    # controllers / skills / knowledge / education) — the ones where a denial was
    # measured shipping its own opposite. Location, availability, salary and
    # experience keep reading the ORIGINAL text: masking them cost real answers in
    # measurement ("abhi kuch nahi kar raha" loses the availability cue, "Pune se
    # bahar nahi jaunga" loses Pune).
    #
    # Availability and relocation are no longer part of that gap: they still MATCH on
    # the raw text, but a match is vetoed when it lands inside a negated span (#441 B,
    # #437). Salary and experience remain a known, deliberately unchanged gap.
    masked, _negated_topics = _apply_negation(text)
    lower = masked.lower()
    raw_lower = text.lower()
    # The veto compares slices of these two by OFFSET, so they must be the same length.
    # Masking preserves length, but `.lower()` does not for every Unicode char (ß -> ss),
    # so the veto mask is built from `raw_lower` ITSELF rather than from `masked.lower()`.
    # Alignment is then structural instead of an assumption that quietly holds today.
    raw_masked, _ = _apply_negation(raw_lower)

    # Machines
    for kw, label, mid in _MACHINES:
        if kw in lower:
            _append_unique(sig.machines, label)
            _append_unique(sig.machine_ids, mid)

    # Controllers (also feed legacy skill ids)
    for kw, label, skill_id in _CONTROLLERS:
        if kw in lower:
            _append_unique(sig.controllers, label)
            if skill_id:
                _append_unique(sig.skill_ids, skill_id)

    # Welding (TAX-WELD-1) — word-boundary matched; maps ONLY to existing corpus ids.
    _detect_welding(lower, sig)

    # Role (first match wins)
    for kw, label, rid, tid in _ROLES:
        if kw in lower:
            sig.primary_role = label
            sig.role_id = rid
            sig.trade_id = tid
            break

    # ...then the VARIANT table, for surface forms a substring test cannot see:
    # "V M C operator", "seter", the Devanagari spellings. Only ever fills a None, and
    # reads the same negation-masked text, so it can neither change an existing
    # resolution nor read a denial as an assertion. No guard is needed because no row
    # infers anything `_ROLES` would not infer from the Latin spelling (see
    # `_ROLE_CUES`).
    if sig.role_id is None:
        for pattern, label, rid, tid in _ROLE_CUES_RE:
            if pattern.search(lower):
                sig.primary_role = label
                sig.role_id = rid
                sig.trade_id = tid
                break

    # TAX-WELD-1: the ONE place welding may assign a role (word-boundary matched, and
    # gated on machining evidence + blockers). Runs after the _ROLES loop so it can
    # never displace an assigned role, and after machines/controllers so the machining
    # signal it consults is already populated.
    _assign_welding_role(lower, sig)

    # Operational skills + knowledge levels
    for kw, label, skill_id in _SKILLS:
        if kw in lower:
            _append_unique(sig.skills, label)
            _append_unique(sig.skill_ids, skill_id)
            if skill_id == "skill_gdt_reading":
                sig.drawing_reading = True
            if skill_id == "skill_program_editing" and sig.programming_knowledge == "unknown":
                sig.programming_knowledge = _level_near(lower, kw)
            if skill_id == "skill_cam_software":
                sig.programming_knowledge = "strong"

    # Operation vs setting knowledge
    if any(w in lower for w in ("chalata", "chala", "operate", "operator", "running", "run ")):
        sig.operation_knowledge = "strong"
        _append_unique(sig.skills, "machine operation")
    elif sig.machines:
        sig.operation_knowledge = "basic"
    if "setting" in lower or "set up" in lower or "setup" in lower:
        sig.setting_knowledge = _level_near(lower, "setting" if "setting" in lower else "setup")
        _append_unique(
            sig.skills,
            "basic setting" if sig.setting_knowledge == "basic" else "machine setting",
        )

    # Inspection + materials
    for kw, label in _INSPECTION:
        if kw in lower:
            _append_unique(sig.inspection_tools, label)
    for kw, label in _MATERIALS:
        if kw in lower:
            _append_unique(sig.materials_handled, label)

    # Experience
    match = _EXPERIENCE_RE.search(text)
    if match:
        raw_amount = match.group(1).lower()
        word_value = _EXP_WORD_LOOKUP.get(raw_amount)
        sig.experience_years = word_value if word_value is not None else float(raw_amount)

    # Secondary role inference: an operator who also sets up is a setter-operator.
    if sig.role_id in ("role_vmc_operator", "role_hmc_operator", "role_cnc_turner_operator") and (
        sig.setting_knowledge in ("basic", "strong")
    ):
        _append_unique(sig.secondary_roles, "CNC Setter-Operator")

    # Location — cities (with alias normalization: dilli -> Delhi).
    # Reads the RAW text (see the note at the top of detect): masking here deleted
    # the answer in "Pune se bahar nahi jaunga", which IS a Pune preference.
    cities = [_canonical_city(m.group(0)) for m in _CITY_RE.finditer(text)]
    # de-dup preserving order
    seen: set[str] = set()
    ordered = [c for c in cities if not (c in seen or seen.add(c))]
    if ordered:
        sig.current_city = ordered[0]
        sig.preferred_locations = ordered[1:]
    # State-level location (captured instead of dropped; does not replace a city).
    sig.current_state = _detect_state(text)
    # Issue #437: a genuine PLACE-CHANGE intent, adjacency-matched, negation-vetoed —
    # no longer any bare substring of shop vocabulary ("night shift", "outside
    # diameter", "vmc chalega", "ready hu machine ke liye").
    #
    # The second arm is UNCHANGED and deliberately so: a SECOND named city that
    # detect() put in preferred_locations ("faridabad me hu, pune bhi chalega") is its
    # own, older signal, out of this issue's scope. It is not free of the same defect
    # class — two cities in a work-history sentence still infer willingness — but that
    # is a distinct inference from the cue table #437 reports, and changing it here
    # would move a behaviour nobody measured.
    if _has_relocate_cue(raw_lower, raw_masked) or sig.preferred_locations:
        sig.relocation_willingness = True

    # Salary (current vs expected by nearby cue) — raw text, as above.
    _detect_salary(text, raw_lower, sig)

    # Availability — raw text: "abhi kuch nahi kar raha" is an IMMEDIATE answer.
    #
    # Issue #424 follow-up: word-boundary GENUINE cues only (see _has_immediate_cue).
    # A bare time adverb is NOT a cue, so answering our own "Abhi kis sheher mein
    # hain?" no longer fabricates "immediate". Immediate is still checked first, as
    # before, so an explicit "turant" beats an incidental duration in the same text.
    # Issue #441 B: still matched on the RAW text (masking would delete the "kaam" out
    # of "kaam nahi kar raha", which MEANS available), but a match whose characters
    # were inside a negated span is now discarded — so a worker saying they CANNOT
    # start now is no longer recorded as able to start now.
    if _has_immediate_cue(raw_lower, raw_masked):
        sig.availability = "immediate"
    elif _has_notice_cue(raw_lower, raw_masked):
        sig.availability = "notice_period"
        sig.notice_period_days = _notice_period_days(raw_lower, raw_masked)

    # Education / certifications
    if re.search(r"\biti\b", lower):
        _append_unique(sig.education, "ITI")
    if "diploma" in lower:
        _append_unique(sig.education, "Diploma")
    if re.search(r"\b(b\.?tech|be\b|degree|engineering)\b", lower):
        _append_unique(sig.education, "Degree")
    if "rvm" in lower or "rvmcad" in lower or "rvm cad" in lower:
        _append_unique(sig.certifications, "RVM CAD")
    if "nsdc" in lower:
        _append_unique(sig.certifications, "NSDC")
    # `certifications` became its own asked topic on 2026-07-22 (owner ruling), so
    # the named bodies a CNC/VMC worker actually holds are read here. Positive
    # allow-list only — an unrecognised certificate stays unrecorded rather than
    # guessed, because a fabricated credential on a worker's resume is worse than a
    # blank one. Everything beyond this list reaches the rich draft via the model.
    if re.search(r"\bncvt\b", lower):
        _append_unique(sig.certifications, "NCVT")
    if re.search(r"\bscvt\b", lower):
        _append_unique(sig.certifications, "SCVT")
    if re.search(r"\bnsqf\b", lower):
        _append_unique(sig.certifications, "NSQF")
    if re.search(r"apprentice", lower):
        _append_unique(sig.certifications, "Apprenticeship")

    return sig


def _looks_like_a_year(num: str, unit: str | None, near: str) -> bool:
    """P1-3(c): "2012 se kaam kar raha hu" is a START YEAR, not a salary.

    A bare 4-digit number in the calendar range is only accepted as money when the
    text right around it actually says money (a currency mark, a pay word, or a
    per-period word). Otherwise it is dropped — an unrecorded salary is re-askable,
    a fabricated ₹2,012 salary ships onto the resume.
    """
    if unit:
        return False  # "2012 k" / "2012 lakh" is not a year
    digits = num.replace(",", "")
    if not (len(digits) == 4 and digits.isdigit() and 1900 <= int(digits) <= 2099):
        return False
    return not any(cue.search(near) for cue in _MONEY_CUES)


def _period_months(near_before: str, near_after: str) -> int | None:
    """How many months the amount covers: 1 (monthly, the default), 12 (annual), or
    None when the cues CONFLICT.

    P1-3(b): "1.5 lakh saal ka" is ANNUAL and used to be stored as a ₹1,50,000
    MONTHLY salary. Period cues are read in a TIGHT window (a wide one would attach
    the "5 saal" of an experience clause to an unrelated amount later in the
    sentence). Ambiguous (both an annual and a monthly cue) -> None -> not recorded,
    per "prefer no number over a wrong number".
    """
    annual = any(cue.search(near_after) for cue in _ANNUAL_CUES_AFTER) or any(
        cue.search(near_before) for cue in _ANNUAL_CUES_BEFORE
    )
    monthly = any(
        cue.search(near_before) or cue.search(near_after) for cue in _MONTHLY_CUES
    )
    if annual and monthly:
        return None
    return 12 if annual else 1


# A number sitting on a line that is about a CREDENTIAL is not money. Added with
# the certifications question (2026-07-22): measured, "NCVT hai, roll number
# R/2019/123456" recorded a 123,456 salary, and "certificate number 4471 hai"
# recorded 4,471 — both of which flow to `salary_expectation.amount_min`, onto the
# resume, and into the deterministic ranking factor `reach.mappers.ts` reads. The
# detector is topic-blind and only rejects amounts under 1,000, so a roll number is
# indistinguishable from a wage to it.
_CREDENTIAL_LINE_CUES: tuple[str, ...] = (
    "roll", "registration", "reg no", "regd", "certificate", "cert no",
    "enrolment", "enrollment", "licence", "license", "ncvt", "scvt", "nsqf", "nsdc",
)


def _detect_salary(text: str, lower: str, sig: Signals) -> None:
    for m in _SALARY_RE.finditer(text):
        num, unit = m.group(1), m.group(2)
        if not unit and len(num.replace(",", "")) <= 2:
            continue  # bare 1-2 digit number with no unit -> likely years, skip
        # Every cue window is clamped to the LINE the number sits on. A cue on a
        # neighbouring line is a different utterance and says nothing about this
        # number. Without the clamp, two salary answers on adjacent lines poison
        # each other: "25000\n35000 chahiye" put ' chah' inside 25000's 10-char
        # lookahead, so the CURRENT salary was recorded as EXPECTED and the real
        # expected salary was then dropped as a duplicate. The same hazard applies
        # to the period cues, where a stray "mahine" on the next line scales an
        # amount by 12.
        # Anchor both bounds on the DIGITS (group 1), not on the match: the match
        # spans surrounding whitespace at both ends, so m.start()/m.end() can sit on
        # the neighbouring line and would pick the wrong line entirely.
        digits_at = m.start(1)
        line_start = lower.rfind("\n", 0, digits_at) + 1
        line_end = lower.find("\n", digits_at)
        line_end = len(lower) if line_end == -1 else line_end
        line = lower[line_start:line_end]
        if any(cue in line for cue in _CREDENTIAL_LINE_CUES):
            continue  # a roll/registration number, not a wage
        near_before = lower[max(line_start, m.start() - _PERIOD_WINDOW_BEFORE): m.start()]
        near_after = lower[m.end(): min(line_end, m.end() + _PERIOD_WINDOW_AFTER)]
        if _looks_like_a_year(num, unit, near_before + " " + near_after):
            continue
        months = _period_months(near_before, near_after)
        if months is None:
            continue  # ambiguous period -> record nothing
        amount = _parse_amount(num, unit, months)
        if amount is None or amount < 1_000:
            continue
        window = lower[max(line_start, m.start() - 25): min(line_end, m.end() + 10)]
        if any(cue in window for cue in _EXPECTED_CUES):
            if sig.expected_salary is None:
                sig.expected_salary = amount
        elif sig.current_salary is None:
            sig.current_salary = amount


# --- Reverse label -> canonical id lookup (for the rich->legacy mapper) ------
# The model emits human-readable LABELS ("VMC Operator", "Fanuc", "tool offset
# setting"). These helpers map such a label back to a canonical gazetteer id by
# reusing the SAME keyword tables as detect(), so no vocabulary is duplicated and
# only real, closed-set ids are ever produced (never free text).


def role_id_for_label(label: str) -> tuple[str, str] | None:
    """Map a model-emitted role LABEL/phrase to its ``(role_id, trade_id)`` via the
    gazetteer keywords, or None when no in-scope role matches. First keyword match
    wins, mirroring detect()'s most-specific-first ordering.

    TAX-WELD-1: welding is now IN scope (``role_welder``/``dom_welding``), so
    "mig_tig_welder" — the exact label the observed welder session produced — maps
    instead of dropping to None. A label naming a CNC/VMC role still wins, because
    ``_ROLES`` is consulted FIRST and carries no welding entry. A welding-PROCESS-only
    label ("MIG welding") reaches the same role via the welding table.

    Separators are normalised to spaces before the word-boundary welding match:
    ``_`` and ``-`` are word characters to ``re``, so ``\\bwelder\\b`` would not fire
    on the snake_case label "mig_tig_welder" that the real session produced.

    The machining gate from :func:`_assign_welding_role` applies here too, so the
    "welding never captures a machining worker" invariant holds on the model-label
    path as well as the raw-text path — one rule, both live routes."""
    low = (label or "").lower()
    for kw, _label, rid, tid in _ROLES:
        if kw in low:
            return rid, tid
    normalized = re.sub(r"[_\-/]+", " ", low)
    if any(p.search(normalized) for p in _MACHINING_CONTEXT_RE):
        return None
    for pattern, _label, sid in _WELDING_RE:
        if sid in _WELDING_DOMAIN_SKILL_IDS and pattern.search(normalized):
            return "role_welder", "dom_welding"
    return None


def machine_ids_for_labels(labels: list[str]) -> list[str]:
    """Map model-emitted machine LABELS to canonical machine ids (order-preserving,
    de-duplicated). Unknown labels yield nothing."""
    out: list[str] = []
    for label in labels:
        low = (label or "").lower()
        for kw, _label, mid in _MACHINES:
            if kw in low:
                _append_unique(out, mid)
    return out


def skill_ids_for_labels(labels: list[str]) -> list[str]:
    """Map model-emitted skill AND controller LABELS to canonical skill ids
    (controllers feed a legacy skill id, e.g. Fanuc -> skill_fanuc), mirroring
    detect(). Order-preserving, de-duplicated; unknown labels yield nothing.

    TAX-WELD-1: welding labels ("MIG welding", "TIG welding", "arc welding", "gas
    cutting") now map to their pre-existing corpus ids instead of yielding nothing."""
    out: list[str] = []
    for label in labels:
        low = (label or "").lower()
        for kw, _label, sid in _SKILLS:
            if kw in low:
                _append_unique(out, sid)
        for kw, _label, sid in _CONTROLLERS:
            if sid and kw in low:
                _append_unique(out, sid)
        for pattern, _label, sid in _WELDING_RE:
            if pattern.search(low):
                _append_unique(out, sid)
    return out


# Cues that the worker is stating where they ARE (not where they'd go). Used to
# attribute cities in an answer to the preferred-locations question (B-4).
#
# WORD BOUNDARIES, NOT SUBSTRINGS (issue #441 A). This tuple used to be plain
# substrings, and one of them was the bare adverb "abhi" — which is a SUBSTRING OF
# THE NAME "Abhishek". So a worker naming a colleague had that name read as "right
# now", which flipped the B-4 attribution and recorded where they LIVE instead of
# where they want to WORK:
#
#     asked=preferred_locations "Abhishek ne bola Chennai chahiye"
#         -> current_location: Chennai                    WRONG
#     asked=preferred_locations "Rakesh ne bola Chennai chahiye"
#         -> preferred_locations: [Chennai]               correct  (the control)
#
# That is the exact current-vs-preferred conflation #423 described and #431 closed,
# reintroduced by a substring. "Abhishek" is common in the target population.
#
# The boundary also stops "abhi" being found inside "kabhi" ("kabhi bhi" = "whenever"
# — a FLEXIBILITY answer, the opposite of a current-location statement), the same
# false match #436 had to fix in the availability cues.
#
# Fail direction is toward NOT claiming a current location: a city that lands in
# preferred is still asked about ("Abhi kis sheher mein hain?"), while a fabricated
# current_location is never corrected.
_CURRENT_LOC_CUE_RE: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        # "main/mein/me/mai <copula>" — "I am in ...". One pattern covers every
        # spelling pair the old substring list enumerated.
        r"\b(?:me|mein|mai|main)\s+(?:hu|hun|hoon|hoo)\b",
        # "rehta/rahti hu" — "I live in ...".
        r"\b(?:rehta|rahta|rehti|rahti)\b",
        # The bare time adverb, now boundary-anchored so no NAME can supply it.
        r"\babhi\b",
    )
)


def detect_inferred_topics(text: str, last_asked_topic_id: str | None = None) -> set[str]:
    """Topics whose value in :func:`detect_answered_topics` was INFERRED from another
    topic's answer rather than stated, and which therefore must not close their own
    question.

    Owner-reported defect, 2026-07-22. "vmc operator hu" answers `role`, but the
    word "operator" also infers the generic skill "machine operation" — which
    marked `skills` ANSWERED. The skills question was then never asked, and when the
    worker volunteered "setting aur tool offset aata hai, program edit nahi aata"
    two turns later it hit the P1-1 first-write-wins rule as a non-asked topic and
    was DISCARDED. Their real, specific, correctly-negated answer lost to a
    placeholder derived from the word "operator", and the profile shipped
    `skills: ["machine operation"]`.

    Deliberately ONE producer, and the narrowest reading of it: `skills` holding
    nothing but the inferred generic, with no gazetteer skill, no drawing-reading
    and no setting knowledge. If any of those is present the worker really did
    state a skill and the topic is genuinely answered.

    `last_asked == "skills"` is NOT inferred: "chalata hu" in reply to "kya kya aata
    hai?" is a deliberate answer to the question on screen, however generic.

    The value is still COLLECTED — free information fills an empty slot. Only the
    "stop asking" half is withheld.
    """
    if last_asked_topic_id == "skills":
        return set()
    sig = detect(text)
    if (
        sig.skills == ["machine operation"]
        and not sig.drawing_reading
        and sig.setting_knowledge == "unknown"
    ):
        return {"skills"}
    return set()


def detect_answered_topics(
    text: str, last_asked_topic_id: str | None = None
) -> dict[str, object]:
    """Map detected signals to interview topic ids -> a short collected value.

    Used by the interview engine to mark progress. Returns profile data only
    (never identity PII).

    B-4 (context-drift register 2026-07-16 row B-4; owner ruling 2026-07-17
    "current AND preferred — do not conflate"): location is TWO topics —
    ``current_location`` and ``preferred_locations`` — each keyed on its own
    field. ``detect`` is context-free (the FIRST city always lands in
    ``current_city``), so ``last_asked_topic_id`` (additive, optional) lets the
    engine attribute an answer to the question that was actually asked:

    - reply to the PREFERRED question with city/cities and no "I am in ..." cue
      -> ALL detected cities are preferences, current stays unmarked;
    - a flexibility answer ("kahin bhi chalega") to the preferred question marks
      it answered even without a named city;
    - a combined answer ("Pune mein hoon, Delhi bhi chalega") marks BOTH.

    The salary topics split the same way (B-5 unbundling): ``salary_current`` /
    ``salary_expected``, with a bare cue-less amount answering the EXPECTED
    question attributed to expected (``detect`` defaults it to current).

    P1-2 (negation): a DENIAL still ANSWERS the question it was asked — "ITI nahi
    kiya" answers the education ask, "setting nahi aati" answers the skills ask —
    so the topic is reported with a ``None`` value: marked answered (never
    re-asked, and the clarify path still sees an answer), with NOTHING collected.
    This applies only to the topic CURRENTLY being asked and only to the topics
    where a "no" is a COMPLETE answer (:data:`_NEGATION_ANSWERS_TOPICS`) — a
    passing "VMC nahi chalaya" must not silently close the essential machines ask.
    """
    sig = detect(text)
    _masked, negated_topics = _apply_negation(text)
    # RAW text here: the current-location cue check deliberately keeps its pre-fix
    # reading (see detect()).
    lower = text.lower()
    # ...and its negation mask, for the context-gated availability read below (#441 B).
    # Built from `lower` itself so the offsets line up by construction.
    masked_lower, _ = _apply_negation(lower)
    answered: dict[str, object] = {}
    if sig.role_id:
        answered["role"] = sig.primary_role
    if sig.machines:
        answered["machines"] = sig.machines
    if sig.controllers:
        answered["controllers"] = sig.controllers
    if sig.experience_years is not None:
        answered["experience"] = sig.experience_years
    if sig.skills or sig.drawing_reading or sig.setting_knowledge != "unknown":
        answered["skills"] = sig.skills

    # Location (B-4): current and preferred are separate topics.
    preferred_ctx = last_asked_topic_id == "preferred_locations"
    states_current = any(cue.search(lower) for cue in _CURRENT_LOC_CUE_RE)
    if preferred_ctx and sig.current_city and not states_current:
        # Cities named in reply to the preferred question, with no "I am in ..."
        # cue, are preferences — including the first one detect() put in
        # current_city.
        answered["preferred_locations"] = [sig.current_city, *sig.preferred_locations]
    else:
        # Keyed on current_city ONLY (as the pre-split code was). A state-only
        # answer ("bihar mai hu") deliberately does NOT mark the topic answered:
        # the engine then still asks "Abhi kis sheher mein hain?" and we capture
        # the CITY, which is strictly better matching data. The state is not lost
        # either way — detect() keeps it on Signals.current_state for the profile.
        if sig.current_city:
            answered["current_location"] = sig.current_city
        if sig.preferred_locations:
            answered["preferred_locations"] = sig.preferred_locations
        elif preferred_ctx and (areas := _preferred_areas(text)):
            # A STATE or REGION ("Gujarat mein", "South India", "NCR") IS an answer to
            # "kahan kaam kar sakte hain?" — it says where the worker can work, just
            # less precisely than a city. Recorded as the list the topic already
            # carries, so nothing downstream sees a new shape.
            #
            # Ranked ABOVE the flexibility sentinel on purpose: "Maharashtra mein
            # kahin bhi" means anywhere in MAHARASHTRA, and recording "flexible"
            # (anywhere in India) for it overstates what the worker offered. Cities
            # still win over both — they are the most specific thing on offer.
            #
            # An EMPTY list falls through to the flexibility branch, which is what
            # restores "Bihar ke alawa kahin bhi" to `flexible` instead of the state
            # it excludes (see `_preferred_areas`).
            answered["preferred_locations"] = areas
        elif preferred_ctx and sig.relocation_willingness:
            # "kahin bhi chalega" — flexibility IS an answer to the preferred
            # ask. Context-gated so an incidental cue ("night shift") elsewhere
            # can never mark the topic answered and skip the required ask.
            answered["preferred_locations"] = "flexible"

    # Salary (B-5 split): keyed per field, expected-context attribution.
    if (
        last_asked_topic_id == "salary_expected"
        and sig.current_salary is not None
        and sig.expected_salary is None
    ):
        answered["salary_expected"] = sig.current_salary
    else:
        if sig.current_salary is not None:
            answered["salary_current"] = sig.current_salary
        if sig.expected_salary is not None:
            answered["salary_expected"] = sig.expected_salary

    availability = sig.availability
    if availability == "unknown" and last_asked_topic_id == "availability":
        # Context-gated widening (issue #424 follow-up), the same shape as the B-4
        # location and B-5 salary attribution above: a bare duration ("15 din",
        # "ek mahina", "10 days"), a bare time adverb ("abhi"), an "anytime" phrase
        # ("kabhi bhi", "jab bolo tab") or a plain ability to join IS an answer to
        # "Join karne mein kitne din lagenge?" — but says nothing about availability
        # anywhere else, which is exactly how "6 month ka experience hai" used to be
        # recorded as a notice period. Duration is tested FIRST: "abhi 15 din" is a
        # notice, not an immediate start.
        #
        # Both arms are negation-vetoed (#441 B) exactly as the context-free cues in
        # detect() are. Without it this path was the remaining way to record the
        # opposite of what was said: "turant nahi aa sakta" answering the availability
        # question matched the bare join-ability cue and read as immediate.
        if _asked_notice_duration(lower, masked_lower):
            availability = "notice_period"
        elif any(
            not _availability_negated(masked_lower, lower, m.start(), m.end())
            for p in _ASKED_IMMEDIATE_RE
            for m in p.finditer(lower)
        ):
            availability = "immediate"
    if availability != "unknown":
        answered["availability"] = availability
    # Education and certifications are TWO asked topics with two questions, so each
    # closes only itself. Before 2026-07-22 certifications had no question of their
    # own and were folded into `education`; naming a certificate no longer answers
    # "kahan tak padhai ki hai?".
    if sig.education:
        answered["education"] = sig.education
    # ...and `certifications` closes ONLY when it is the topic actually being asked.
    # A worker answering "kahan tak padhai ki hai?" with "ITI + 3 saal
    # apprenticeship" has mentioned a certification incidentally, not disclosed one
    # — and inferring an answer from it would silently skip the certifications
    # question, which is the exact complaint that put this topic in the bank. The
    # value is not lost: the model reads it from the transcript into the rich draft.
    if sig.certifications and last_asked_topic_id == "certifications":
        answered["certifications"] = sig.certifications

    # P1-2: a denial ANSWERS the question it was asked (value None -> nothing is
    # collected, but the topic is not re-asked and is not mistaken for silence).
    if (
        last_asked_topic_id in _NEGATION_ANSWERS_TOPICS
        and last_asked_topic_id in negated_topics
        and last_asked_topic_id not in answered
    ):
        answered[last_asked_topic_id] = None
    return answered
