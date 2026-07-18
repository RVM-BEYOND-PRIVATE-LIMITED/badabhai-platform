"""Resume building from a structured profile (Phase-1 placeholder).

NOTE: the messy-text → DraftProfile heuristics that used to live here now live in
``app/profiling/signals.py`` (single source of truth, shared with the interview
engine and the rich extractor). This module keeps only the name-less resume
builder used by ``/resume/generate``.
"""

from __future__ import annotations

import re

from .contracts import DraftProfile

_NORM_RE = re.compile(r"[^a-z0-9]+")


def _norm(value: str) -> str:
    """Normalize for id-vs-label dedupe: lowercase, non-alphanumeric → space,
    collapse runs, trim. E.g. "MIG-Welding " → "mig welding"."""
    return _NORM_RE.sub(" ", value.lower()).strip()


def _skills_entries(profile: DraftProfile) -> list[str]:
    """Canonical skill ids first, then the worker-confirmed raw labels (Q14),
    dropping a label whose normalization equals an id's normalization with the
    ``skill_`` prefix stripped (e.g. label "Milling" dupes id ``skill_milling``)."""
    entries = list(profile.skills)
    seen = {_norm(sid.removeprefix("skill_")) for sid in profile.skills}
    for label in profile.skill_labels:
        key = _norm(label)
        if not key or key in seen:
            continue
        seen.add(key)
        entries.append(label)
    return entries


def build_resume(profile: DraftProfile) -> tuple[str, dict]:
    """Build a simple, name-less text resume from a structured profile.

    Q14 (ADR-0030 OQ#3): the skills line renders the canonical ids PLUS the
    worker-confirmed raw ``skill_labels``. The caller (``/resume/generate``) is
    responsible for pseudonymize-gating the labels BEFORE calling this (SG-2) —
    this builder renders whatever filtered profile it is handed, and still
    degrades to "(to be confirmed)" when both ids and labels are empty.
    """
    lines = ["WORKER PROFILE (DRAFT)", ""]
    lines.append(f"Role: {profile.canonical_role_id or '(to be confirmed)'}")
    lines.append(f"Trade: {profile.canonical_trade_id or '(to be confirmed)'}")
    if profile.experience.total_years is not None:
        lines.append(f"Experience: {profile.experience.total_years:g} years")
    lines.append(
        "Machines: " + (", ".join(profile.machines) if profile.machines else "(to be confirmed)")
    )
    skills = _skills_entries(profile)
    lines.append("Skills: " + (", ".join(skills) if skills else "(to be confirmed)"))
    # Issue #423 — label each honestly. Before the split these shared one list, so a
    # worker's CURRENT city was rendered under "Preferred locations:" — a claim they
    # never made. Emitted only when present, so a worker who stated no preference
    # produces no "Preferred locations" line at all rather than an invented one.
    if profile.location_preference.current_city:
        lines.append(f"Current location: {profile.location_preference.current_city}")
    if profile.location_preference.preferred_cities:
        cities = ", ".join(profile.location_preference.preferred_cities)
        lines.append(f"Preferred locations: {cities}")
    return "\n".join(lines), profile.model_dump()
