"""Mock profile extraction + resume building (Phase 1 placeholder).

Deterministic keyword heuristics over ALREADY-PSEUDONYMIZED text, mapping to the
stable taxonomy ids from `packages/taxonomy`. This stands in for an LLM-based
extractor (which would run behind the same pseudonymization boundary later).
"""

from __future__ import annotations

import re

from .contracts import DraftProfile, Experience

# Keyword -> taxonomy id maps (ids must match @badabhai/taxonomy).
_MACHINE_KEYWORDS: list[tuple[str, str]] = [
    ("vmc", "mach_vmc"),
    ("hmc", "mach_hmc"),
    ("cnc lathe", "mach_cnc_lathe"),
    ("lathe", "mach_cnc_lathe"),
    ("turning", "mach_cnc_lathe"),
    ("cylindrical grind", "mach_cylindrical_grinder"),
    ("grinder", "mach_cnc_grinder"),
    ("grinding", "mach_cnc_grinder"),
]

_SKILL_KEYWORDS: list[tuple[str, str]] = [
    ("fanuc", "skill_fanuc"),
    ("siemens", "skill_siemens"),
    ("mitsubishi", "skill_mitsubishi"),
    ("gd&t", "skill_gdt_reading"),
    ("gdt", "skill_gdt_reading"),
    ("drawing", "skill_gdt_reading"),
    ("offset", "skill_tool_offset_setting"),
    ("program", "skill_program_editing"),
    ("g code", "skill_program_editing"),
    ("m code", "skill_program_editing"),
    ("micrometer", "skill_measuring_instruments"),
    ("vernier", "skill_measuring_instruments"),
    ("gauge", "skill_measuring_instruments"),
    ("fixture", "skill_fixture_setup"),
    ("mastercam", "skill_cam_software"),
    ("fusion", "skill_cam_software"),
]

# Order matters: more specific roles first.
_ROLE_KEYWORDS: list[tuple[str, str, str]] = [
    ("cam programmer", "role_cam_programmer", "dom_programming"),
    ("programmer", "role_cnc_programmer", "dom_programming"),
    ("setter", "role_cnc_setter_operator", "dom_cnc_machining"),
    ("vmc", "role_vmc_operator", "dom_vmc_machining"),
    ("hmc", "role_hmc_operator", "dom_hmc_machining"),
    ("grinding", "role_cnc_grinding_operator", "dom_grinding"),
    ("turner", "role_cnc_turner_operator", "dom_cnc_machining"),
    ("turning", "role_cnc_turner_operator", "dom_cnc_machining"),
]

_EXPERIENCE_RE = re.compile(r"(\d{1,2})\s*\+?\s*(?:years|year|yrs|yr|saal|sal)\b", re.IGNORECASE)


def extract_profile_from_text(text: str) -> DraftProfile:
    lower = text.lower()

    machines: list[str] = []
    for kw, mid in _MACHINE_KEYWORDS:
        if kw in lower and mid not in machines:
            machines.append(mid)

    skills: list[str] = []
    for kw, sid in _SKILL_KEYWORDS:
        if kw in lower and sid not in skills:
            skills.append(sid)

    role_id: str | None = None
    trade_id: str | None = None
    for kw, rid, did in _ROLE_KEYWORDS:
        if kw in lower:
            role_id = rid
            trade_id = did
            break

    total_years: float | None = None
    match = _EXPERIENCE_RE.search(text)
    if match:
        total_years = float(match.group(1))

    return DraftProfile(
        canonical_trade_id=trade_id,
        canonical_role_id=role_id,
        skills=skills,
        machines=machines,
        experience=Experience(total_years=total_years),
        confidence=0.4 if (role_id or machines or skills) else 0.1,
    )


def build_resume(profile: DraftProfile) -> tuple[str, dict]:
    """Build a simple, name-less text resume from a structured profile."""
    lines = ["WORKER PROFILE (DRAFT)", ""]
    lines.append(f"Role: {profile.canonical_role_id or '(to be confirmed)'}")
    lines.append(f"Trade: {profile.canonical_trade_id or '(to be confirmed)'}")
    if profile.experience.total_years is not None:
        lines.append(f"Experience: {profile.experience.total_years:g} years")
    lines.append(
        "Machines: " + (", ".join(profile.machines) if profile.machines else "(to be confirmed)")
    )
    lines.append(
        "Skills: " + (", ".join(profile.skills) if profile.skills else "(to be confirmed)")
    )
    if profile.location_preference.preferred_cities:
        cities = ", ".join(profile.location_preference.preferred_cities)
        lines.append(f"Preferred locations: {cities}")
    return "\n".join(lines), profile.model_dump()
