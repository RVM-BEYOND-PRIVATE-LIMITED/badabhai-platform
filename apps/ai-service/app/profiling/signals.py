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

from ..pseudonymize import CITY_ALIASES, KNOWN_CITIES

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
    if value <= 0 or value > 10_000_000:
        return None
    return int(value)


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

    # Role (first match wins)
    for kw, label, rid, tid in _ROLES:
        if kw in lower:
            sig.primary_role = label
            sig.role_id = rid
            sig.trade_id = tid
            break

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


def detect_answered_topics(text: str) -> dict[str, object]:
    """Map detected signals to interview topic ids -> a short collected value.

    Used by the interview engine to mark progress. Returns profile data only
    (never identity PII)."""
    sig = detect(text)
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
    if sig.current_city or sig.preferred_locations:
        answered["location"] = sig.current_city or sig.preferred_locations
    if sig.current_salary is not None or sig.expected_salary is not None:
        answered["salary"] = sig.current_salary or sig.expected_salary
    if sig.availability != "unknown":
        answered["availability"] = sig.availability
    if sig.education or sig.certifications:
        answered["education"] = sig.education + sig.certifications
    return answered
