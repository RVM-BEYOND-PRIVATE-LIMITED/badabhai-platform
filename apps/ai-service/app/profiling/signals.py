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
_EXPERIENCE_RE = re.compile(
    r"(?<![\d.])(\d{1,2}(?:\.\d+)?)\s*\+?\s*(?:years|year|yrs|yr|saal|sal)\b",
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
# Money like "22k", "22000", "22 thousand", "1.5 lakh".
_SALARY_RE = re.compile(
    r"(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:[,\d]*)(?:\.\d+)?)\s*(k|thousand|hazar|hzr|lakh|lac|l)?",
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
_RELOCATE_CUES = ("relocat", "shift", "chalega", "ready", "ja sakta", "kahin bhi", "anywhere",
                  "bahar", "outside")
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
_AVAIL_JOIN = (
    r"(?:join\s+kar\s+(?:sakta|sakti|sakte)|join\s+(?:kar\s+)?"
    r"(?:lunga|loonga|luga|karunga|karoonga|sakunga)|joining\s+(?:kar\s+)?"
    r"(?:sakta|sakti|sakte|lunga)|aa\s+(?:sakta|sakti|sakte|jaunga|jaungi)|"
    r"(?:start|shuru)\s+kar\s+(?:sakta|sakti|sakte|dunga)|ready)"
)
_IMMEDIATE_CUE_RE: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        # Unambiguous immediacy words — these ARE the answer on their own.
        r"\bimmediate(?:ly)?\b",
        r"\bturant\b",
        r"\bfaura?n\b",
        r"\bforan\b",
        r"\bready\s+to\s+join\b",
        # Being free / idle right now. Requires the copula, so "freelance" (no word
        # boundary anyway) and "free size job" can never fire it.
        r"\b(?:free|khaali|khali|faarig|farig|fursat)\s+(?:hu|hun|hoon|hai|hain|ho)\b",
        rf"\b(?:{_AVAIL_NOW}|main|mai|bilkul)\s+(?:free|khaali|khali)\b",
        # "available" attributed to the WORKER, never to a job/machine — "koi job
        # available hai kya?" is a question about vacancies, not a start date.
        rf"\b(?:main|mai|hum|i\s*am|i'?m|{_AVAIL_NOW})\s+available\b"
        r"(?!\s+(?:machine|machines|job|jobs|kaam|work|vacanc|position))",
        r"\bavailable\s+(?:hu|hun|hoon)\b",
        # Not currently working — a complete availability answer.
        r"\b(?:kaam|job|naukri|kuch)\s+(?:nahi+n?|nhi)\s+"
        r"(?:kar\s+raha|kar\s+rahi|hai|mil\s+raha|milta)\b",
        r"\b(?:job|naukri|company|kaam)\s+chhod\s+(?:di|diya|dia|dii)\b",
        r"\bberozgar\b",
        # A time adverb NEXT TO a join/start intent, in either word order. This is the
        # ONLY way "abhi"/"aaj"/"kal" can contribute, and the whole point of the fix.
        rf"\b{_AVAIL_NOW}\b[^.;!?]{{0,20}}?\b{_AVAIL_JOIN}\b",
        rf"\b{_AVAIL_JOIN}\b[^.;!?]{{0,20}}?\b{_AVAIL_NOW}\b",
    )
)

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
_ASKED_IMMEDIATE_RE: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        # "whenever you say" — genuinely immediate. Matched EXPLICITLY so it stops
        # being read as immediate for the wrong reason (the old cue found the "abhi"
        # inside "kabhi"; "kabhi kabhi" = "sometimes" scored the same way).
        r"\bkabhi\s+bhi\b",
        r"\bjab\s+(?:bolo|bhi|kaho|chaho|bulao|bulaye)\b",
        r"\banytime\b",
        # A bare time adverb IS the answer to "how many days to join?".
        rf"^\W*{_AVAIL_NOW}\b",
        rf"\b{_AVAIL_NOW}\s*(?:hi|se|se\s+hi)?\s*$",
        # Ability to join, with no immediacy adverb attached.
        rf"\b{_AVAIL_JOIN}\b",
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
_NEGATION_ANSWERS_TOPICS: frozenset[str] = frozenset({"education", "skills"})

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
    # bahar nahi jaunga" loses Pune) and their negation was not part of this fix.
    # Negation there is a KNOWN, deliberately UNCHANGED gap.
    masked, _negated_topics = _apply_negation(text)
    lower = masked.lower()
    raw_lower = text.lower()

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
        sig.experience_years = float(match.group(1))

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
    if any(c in raw_lower for c in _RELOCATE_CUES) or sig.preferred_locations:
        sig.relocation_willingness = True

    # Salary (current vs expected by nearby cue) — raw text, as above.
    _detect_salary(text, raw_lower, sig)

    # Availability — raw text: "abhi kuch nahi kar raha" is an IMMEDIATE answer.
    #
    # Issue #424 follow-up: word-boundary GENUINE cues only (see _IMMEDIATE_CUE_RE).
    # A bare time adverb is NOT a cue, so answering our own "Abhi kis sheher mein
    # hain?" no longer fabricates "immediate". Immediate is still checked first, as
    # before, so an explicit "turant" beats an incidental duration in the same text.
    if any(p.search(raw_lower) for p in _IMMEDIATE_CUE_RE):
        sig.availability = "immediate"
    elif any(p.search(raw_lower) for p in _NOTICE_CUE_RE):
        sig.availability = "notice_period"

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


def _detect_salary(text: str, lower: str, sig: Signals) -> None:
    for m in _SALARY_RE.finditer(text):
        num, unit = m.group(1), m.group(2)
        if not unit and len(num.replace(",", "")) <= 2:
            continue  # bare 1-2 digit number with no unit -> likely years, skip
        near_before = lower[max(0, m.start() - _PERIOD_WINDOW_BEFORE): m.start()]
        near_after = lower[m.end(): m.end() + _PERIOD_WINDOW_AFTER]
        if _looks_like_a_year(num, unit, near_before + " " + near_after):
            continue
        months = _period_months(near_before, near_after)
        if months is None:
            continue  # ambiguous period -> record nothing
        amount = _parse_amount(num, unit, months)
        if amount is None or amount < 1_000:
            continue
        window = lower[max(0, m.start() - 25): m.end() + 10]
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
_CURRENT_LOC_CUES = (
    "mein hoon", "mein hu", "me hoon", "me hu", "mai hoon", "mai hu",
    "rehta", "rahta", "rehti", "rahti", "abhi",
)


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
    # RAW text here: the only consumer below is the current-location cue check, and
    # location deliberately keeps its pre-fix reading (see detect()).
    lower = text.lower()
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
    states_current = any(cue in lower for cue in _CURRENT_LOC_CUES)
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
        if _ASKED_NOTICE_RE.search(lower):
            availability = "notice_period"
        elif any(p.search(lower) for p in _ASKED_IMMEDIATE_RE):
            availability = "immediate"
    if availability != "unknown":
        answered["availability"] = availability
    if sig.education or sig.certifications:
        answered["education"] = sig.education + sig.certifications

    # P1-2: a denial ANSWERS the question it was asked (value None -> nothing is
    # collected, but the topic is not re-asked and is not mistaken for silence).
    if (
        last_asked_topic_id in _NEGATION_ANSWERS_TOPICS
        and last_asked_topic_id in negated_topics
        and last_asked_topic_id not in answered
    ):
        answered[last_asked_topic_id] = None
    return answered
