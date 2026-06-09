"""Resume building from a structured profile (Phase-1 placeholder).

NOTE: the messy-text → DraftProfile heuristics that used to live here now live in
``app/profiling/signals.py`` (single source of truth, shared with the interview
engine and the rich extractor). This module keeps only the name-less resume
builder used by ``/resume/generate``.
"""

from __future__ import annotations

from .contracts import DraftProfile


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
