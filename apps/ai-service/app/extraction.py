"""Resume building from a structured profile (Phase-1 placeholder).

NOTE: the messy-text → DraftProfile heuristics that used to live here now live in
``app/profiling/signals.py`` (single source of truth, shared with the interview
engine and the rich extractor). This module keeps only the name-less resume
builder used by ``/resume/generate``.
"""

from __future__ import annotations

import re

from .contracts import DraftProfile
from .profiling.signals import label_for_id

_NORM_RE = re.compile(r"[^a-z0-9]+")

_TAXONOMY_ID_RE = re.compile(r"\b(skill|mach|role|dom|ind|trade|ctrl)_[a-z0-9_]+\b")


def resolve_taxonomy_ids(text: str) -> str:
    """Replace any raw taxonomy IDs in *text* with human-readable labels.

    The LLM receives the raw DraftProfile JSON and may echo ids like
    ``skill_mig_welding`` or ``mach_vmc`` in its output.  This sweep
    catches every ``{prefix}_{slug}`` pattern and resolves it via
    ``label_for_id`` (table lookup → prettify fallback).
    """

    def _replace(m: re.Match) -> str:
        return label_for_id(m.group(0))

    return _TAXONOMY_ID_RE.sub(_replace, text)


def _norm(value: str) -> str:
    """Normalize for id-vs-label dedupe: lowercase, non-alphanumeric → space,
    collapse runs, trim. E.g. "MIG-Welding " → "mig welding"."""
    return _NORM_RE.sub(" ", value.lower()).strip()


def _skills_entries(profile: DraftProfile) -> list[str]:
    """Canonical skill NAMES first (ids resolved to display labels — the résumé must
    never show a raw ``skill_*`` id), then the worker-confirmed raw labels (Q14),
    dropping a label whose normalization already matches a resolved name (e.g. label
    "Milling" dupes the resolved "Milling")."""
    entries = [label_for_id(sid) for sid in profile.skills]
    seen = {_norm(e) for e in entries}
    for label in profile.skill_labels:
        resolved = label_for_id(label)
        key = _norm(resolved)
        if not key or key in seen:
            continue
        seen.add(key)
        entries.append(resolved)
    return entries


def _role_line(canonical_id: str | None, label: str | None) -> str | None:
    """The worker's role/trade for the résumé: the canonical id, else the interview's label.

    WHY THE LABEL ARM EXISTS. The LLM-led interview structurally CANNOT write a canonical id —
    ``toExtractionOutput`` hardcodes both to ``None`` on that path, deliberately, because
    inventing an unvalidated taxonomy id would poison the one field the match engine trusts
    absolutely (CLAUDE.md §3). So this line read a field the interview never fills and printed
    "(to be confirmed)" for the role AND the trade on EVERY interview-led profile, while the
    model had named both in plain language and stored them on this same object.

    THE ID STILL LEADS, AND THAT IS A DELIBERATE ORDER, NOT AN OVERSIGHT. The id is
    taxonomy-validated and human-reviewed; the label is unvalidated model free text. Where both
    exist the reviewed value wins, so this arm can only ever FILL A BLANK — the same rule the
    TypeScript renderer states and pins ("never lets role_label outrank a resolved taxonomy
    role", resume-render-input.test.ts). Preferring model text over a reviewed value would be
    the AI outvoting a deterministic one on a worker-facing claim (§3).

    It also makes invariant #8 STRUCTURAL rather than coincidental. The two sources are disjoint
    today — deterministic packs write ids and no labels, the interview writes labels and no ids
    — but nothing in either schema enforces that, and canonicalization exists precisely to
    assign an id to a profile that lacks one. With the id first, any row that has one renders
    exactly as it does today no matter what a future writer puts in ``role_label``.

    NEVER FABRICATED — neither source yields None, and the caller prints "(to be confirmed)"
    rather than a guess. A blank/whitespace label counts as absent: the schema accepts ``""``,
    and "Role: " with nothing after it is worse than the honest placeholder.
    """
    if canonical_id:
        # Resolved to its display name — the résumé must never show a raw id like
        # role_hmc_operator / mach_vmc / skill_mig_welding.
        return label_for_id(canonical_id)
    # ONE LINE, ALWAYS. The Flutter card parses this text as `Label: value` and folds a
    # whitespace-led line into the previous entry, so a newline inside model free text would
    # forge a second field row on the worker's résumé. Collapsing here is the only place that
    # can be prevented for both readers of this string. `split()` with no argument splits on
    # ANY whitespace run, so this also trims — a blank label collapses to "" and yields None.
    collapsed = " ".join(label.split()) if label else ""
    return collapsed or None


def build_resume(profile: DraftProfile) -> tuple[str, dict]:
    """Build a simple, name-less text resume from a structured profile.

    Q14 (ADR-0030 OQ#3): the skills line renders the canonical ids PLUS the
    worker-confirmed raw ``skill_labels``. The caller (``/resume/generate``) is
    responsible for pseudonymize-gating the labels BEFORE calling this (SG-2) —
    this builder renders whatever filtered profile it is handed, and still
    degrades to "(to be confirmed)" when both ids and labels are empty.
    """
    role = _role_line(profile.canonical_role_id, profile.role_label)
    trade = _role_line(profile.canonical_trade_id, profile.domain_label)
    lines = ["WORKER PROFILE (DRAFT)", ""]
    lines.append(f"Role: {role or '(to be confirmed)'}")
    lines.append(f"Trade: {trade or '(to be confirmed)'}")
    if profile.experience.total_years is not None:
        lines.append(f"Experience: {profile.experience.total_years:g} years")
    machines = [label_for_id(m) for m in profile.machines]
    lines.append("Machines: " + (", ".join(machines) if machines else "(to be confirmed)"))
    skills = _skills_entries(profile)
    lines.append("Skills: " + (", ".join(skills) if skills else "(to be confirmed)"))
    # #499 — education + certifications (closed-set canonical tokens from the
    # signal detector: ITI/Diploma/Degree, NCVT/NSQF/SCVT/Apprenticeship/…). Emitted
    # ONLY when present, so a worker who stated none produces no empty line rather
    # than an invented "(to be confirmed)". PII-free (fixed qualification tokens).
    # TD-EDU — academic education level + field (scalars), emitted only when present.
    if profile.education_level:
        lines.append("Education level: " + profile.education_level)
    if profile.education_field:
        lines.append("Field of study: " + profile.education_field)
    if profile.education:
        lines.append("Education: " + ", ".join(profile.education))
    if profile.certifications:
        lines.append("Certifications: " + ", ".join(profile.certifications))
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
