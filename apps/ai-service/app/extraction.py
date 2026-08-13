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
from .pseudonymize import pseudonymize

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


def _work_history_lines(profile: DraftProfile) -> list[str]:
    """The interview's work history, one printable line per job.

    THE ONE THING NO PACK QUESTION CAN PRODUCE, and until now it reached this résumé by NO
    ROUTE AT ALL. A pack asks its fixed question once, so a worker with three jobs has three
    answers to "what did you do" and the answer map has room for one — the list exists only
    because the LLM-led interview reads the whole conversation.

    IT ARRIVES ONLY INSIDE ``resume_profile``. The TypeScript ``DraftProfileSchema`` also
    carries a top-level ``experiences``, but this Pydantic model does not, so that array is
    dropped on validation at the wire (a §7 parity gap, recorded here rather than papered over
    with a duplicate field the two shapes could then disagree on). The container is the
    interview's own record and is the right carrier; this reads THAT.

    The PDF has rendered this since the v3 templates shipped. The in-app card never has — so
    one worker, one interview, and the two surfaces disagreed about whether they had ever
    worked. This closes that.

    ONE LINE PER JOB, and each collapsed to a single line: the worker app parses this text as
    ``Label: value`` and folds a whitespace-led line into the PREVIOUS entry, so a newline in
    model free text would forge a field row. A repeated ``Work history`` label is fine — the
    app keeps every entry carrying a label rather than the last one.

    NEVER FABRICATED: a job with no role name is skipped rather than printed as a blank bullet,
    and the duration/description clauses appear only when the model actually recorded them.
    """
    container = profile.resume_profile
    if container is None:
        return []
    lines: list[str] = []
    for entry in container.experiences:
        role = " ".join(entry.role_label.split()) if entry.role_label else ""
        if not role:
            continue
        # The worker's OWN words for the duration ("3.5 saal"); the month count is a
        # normalization of it and printing "42 months" trades their voice for a number they
        # never used. `duration_months` is nullable precisely because "kuch saal" is a real
        # answer, so nothing is derived when the text is absent.
        parts = [role]
        duration = " ".join(entry.duration_text.split()) if entry.duration_text else ""
        if duration:
            parts.append(duration)
        work = " ".join(entry.work_done.split()) if entry.work_done else ""
        if work:
            parts.append(work)
        lines.append("Work history: " + " — ".join(parts))
    return lines


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
    # THE WORK HISTORY, directly under the headline facts and above the qualifications —
    # for an industrial or skilled-trade résumé it is the most important thing on the page
    # after the name and the role, which is the order the v3 PDF templates already use.
    # Emitted only when the interview recorded jobs, so a deterministic-only profile prints
    # no heading for a section it has nothing to put in.
    lines.extend(_work_history_lines(profile))
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
    # AVAILABILITY, which the v3 PDF prints and this text never did. The two vocabularies do
    # not overlap on two of five values — `extract_system_prompt` asks the model for
    # `15_days`/`1_month`, `AvailabilitySchema.status` accepts neither — so the humanising
    # happens here, at the presentation edge, and knows both sets. Same treatment, same
    # reasoning as `humanizeAvailability` on the render side.
    availability = _availability_line(profile)
    if availability:
        lines.append(f"Availability: {availability}")
    # THE WORKER'S OWN COPY ONLY. `/resume/generate` builds the résumé the WORKER carries;
    # the payer-facing masked disclosure is a different surface built by
    # `resume-disclosure.service.ts`, which never calls this route. Their asking price is
    # useful on their own document and is a negotiating position handed away if a payer reads
    # it before any conversation (ADR-0032's reasoning for the photo).
    if profile.resume_profile is not None and profile.resume_profile.expected_salary is not None:
        # `:g` switches to scientific notation once the value reaches ~1e6
        # ("1200000" -> "1.2e+06") — a printed artifact the worker personally carries, and
        # a plausible LLM extraction failure mode (e.g. an annual CTC figure mistaken for a
        # monthly one). `:.0f` is fixed-point ALWAYS, at any magnitude, matching the plain
        # no-thousands-separator convention this file already uses (`Experience: {…:g}
        # years`, `Machines: …`) and the v3 PDF templates' `String(expectedSalary)`
        # (apps/api resume-renderer.service.ts) — a bare rupee integer, never "e+NN".
        lines.append(f"Expected salary: {profile.resume_profile.expected_salary:.0f} per month")
    return "\n".join(lines), profile.model_dump()


_MODEL_AVAILABILITY = {
    "immediate": "Available immediately",
    "notice_period": "On notice period",
    "15_days": "Available in 15 days",
    "1_month": "Available in 1 month",
}

_SHIFTS = {"day": "Day shift", "night": "Night shift", "any": "Any shift"}


def _availability_line(profile: DraftProfile) -> str | None:
    """When they can start, and which shift — or None.

    THE CONTAINER'S VOCABULARY FIRST, because it is the model's own words as traced; the
    legacy `availability.status` enum is the mapped copy and is the fallback for every
    deterministic profile. `not_looking`/`unknown` deliberately yield nothing: a résumé exists
    to be shown to employers, and stamping it with a line that discourages them serves nobody.

    SHIFT ALONE IS ENOUGH TO PRINT THE LINE — a worker who told us they work nights has said
    something worth showing even when they gave no notice period.
    """
    container = profile.resume_profile
    raw = None
    if container is not None and container.availability:
        raw = container.availability
    elif profile.availability.status:
        raw = profile.availability.status
    phrase = _MODEL_AVAILABILITY.get(raw.strip().lower()) if raw else None

    shift_raw = container.shift if container is not None and container.shift else profile.shift
    shift = None
    if shift_raw and shift_raw.strip():
        cleaned = " ".join(shift_raw.split())
        # The wire type is a bare `str | None`. `/profiling/extract` (routers/profiling.py)
        # re-certifies `experiences[]` and `skills` against the pseudonymizer before they can
        # reach `resume_profile`, but NOTHING re-certifies `shift` or any other scalar field —
        # it passes from the model's raw JSON straight onto the container untouched. This is
        # the one place that raw fallback text (an unrecognised value, printed title-cased
        # rather than mapped to a known shift) would otherwise reach the worker's résumé
        # verbatim, so it is certified HERE, at the point of print, the same way a blank role
        # is dropped rather than printed as an empty bullet: a value the pseudonymizer would
        # block on a normal LLM turn is silently omitted, never printed raw.
        if not pseudonymize(cleaned).blocked:
            shift = _SHIFTS.get(cleaned.lower(), cleaned[:1].upper() + cleaned[1:])

    if phrase and shift:
        return f"{phrase} · {shift}"
    return phrase or shift
