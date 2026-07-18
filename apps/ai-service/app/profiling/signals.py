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
# TAX-WELD-1: the welding entries are DELIBERATELY LAST. First-keyword-wins, so every
# CNC/VMC keyword still shadows them — a worker who says "vmc pe kaam karta hu aur
# welding bhi" stays a VMC operator. Welding can therefore only ever ADD a role where
# there was `None` before; it can never take one away. That ordering is the structural
# guarantee behind "CNC/VMC extraction unchanged".
_ROLES: list[tuple[str, str, str, str]] = [
    ("cam programmer", "CAM Programmer", "role_cam_programmer", "dom_programming"),
    ("programmer", "CNC Programmer", "role_cnc_programmer", "dom_programming"),
    ("setter", "CNC Setter-Operator", "role_cnc_setter_operator", "dom_cnc_machining"),
    ("vmc", "VMC Operator", "role_vmc_operator", "dom_vmc_machining"),
    ("hmc", "HMC Operator", "role_hmc_operator", "dom_hmc_machining"),
    ("grinding", "CNC Grinding Operator", "role_cnc_grinding_operator", "dom_grinding"),
    ("turner", "CNC Turner/Operator", "role_cnc_turner_operator", "dom_cnc_machining"),
    ("turning", "CNC Turner/Operator", "role_cnc_turner_operator", "dom_cnc_machining"),
    ("welder", "Welder", "role_welder", "dom_welding"),
    ("welding", "Welder", "role_welder", "dom_welding"),
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

_EXPERIENCE_RE = re.compile(
    r"(\d{1,2})\s*\+?\s*(?:years|year|yrs|yr|saal|sal|saal\b)", re.IGNORECASE
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
_RELOCATE_CUES = ("relocat", "shift", "chalega", "ready", "ja sakta", "kahin bhi", "anywhere",
                  "bahar", "outside")
_IMMEDIATE_CUES = ("immediate", "abhi", "turant", "free", "available", "ready to join")
_NOTICE_CUES = ("notice", "din lag", "days", "month", "mahina", "15 din", "30 din")


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


def _parse_amount(num: str, unit: str | None) -> int | None:
    try:
        value = float(num.replace(",", ""))
    except ValueError:
        return None
    unit = (unit or "").lower()
    if unit in ("k", "thousand", "hazar", "hzr"):
        value *= 1_000
    elif unit in ("lakh", "lac", "l"):
        value *= 100_000
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


def detect(text: str) -> Signals:
    """Detect all profile signals in ``text`` (raw worker text, trusted local)."""
    sig = Signals()
    lower = text.lower()

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

    # TAX-WELD-1 role fallback: a welder who never says the word "welder"/"welding"
    # ("TIG aur MIG machine chala leta hun") is still a welder. Only fires when NO
    # CNC/VMC role matched, so it can never displace an in-scope machining role.
    if sig.role_id is None and any(s in _WELDING_DOMAIN_SKILL_IDS for s in sig.skill_ids):
        sig.primary_role = "Welder"
        sig.role_id = "role_welder"
        sig.trade_id = "dom_welding"

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
    cities = [_canonical_city(m.group(0)) for m in _CITY_RE.finditer(text)]
    # de-dup preserving order
    seen: set[str] = set()
    ordered = [c for c in cities if not (c in seen or seen.add(c))]
    if ordered:
        sig.current_city = ordered[0]
        sig.preferred_locations = ordered[1:]
    # State-level location (captured instead of dropped; does not replace a city).
    sig.current_state = _detect_state(text)
    if any(c in lower for c in _RELOCATE_CUES) or sig.preferred_locations:
        sig.relocation_willingness = True

    # Salary (current vs expected by nearby cue)
    _detect_salary(text, lower, sig)

    # Availability
    if any(c in lower for c in _IMMEDIATE_CUES):
        sig.availability = "immediate"
    elif any(c in lower for c in _NOTICE_CUES):
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


def _detect_salary(text: str, lower: str, sig: Signals) -> None:
    for m in _SALARY_RE.finditer(text):
        num, unit = m.group(1), m.group(2)
        if not unit and len(num.replace(",", "")) <= 2:
            continue  # bare 1-2 digit number with no unit -> likely years, skip
        amount = _parse_amount(num, unit)
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
    instead of dropping to None. The welding keywords sit LAST in ``_ROLES``, so a
    label naming a CNC/VMC role still wins. A welding-PROCESS-only label ("MIG
    welding") falls back to the same role via the welding table."""
    low = (label or "").lower()
    for kw, _label, rid, tid in _ROLES:
        if kw in low:
            return rid, tid
    for pattern, _label, sid in _WELDING_RE:
        if sid in _WELDING_DOMAIN_SKILL_IDS and pattern.search(low):
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
    """
    sig = detect(text)
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

    if sig.availability != "unknown":
        answered["availability"] = sig.availability
    if sig.education or sig.certifications:
        answered["education"] = sig.education + sig.certifications
    return answered
