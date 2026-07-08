"""Messy-text → clean-profile extraction (Phase-1 heuristic / mock).

Builds the rich :class:`WorkerProfileDraft` from ``signals`` and derives the
legacy :class:`DraftProfile` (taxonomy ids) for backward-compatible storage.
Both come from a single ``signals.detect`` pass — no duplicated detection logic.

This boundary will later host an LLM-based extractor (behind pseudonymization);
the contract returned here is stable so the backend/Flutter need not change.
"""

from __future__ import annotations

import json

from ..contracts import (
    Availability,
    DraftProfile,
    Experience,
    LocationPreference,
    SalaryExpectation,
    WorkerProfileDraft,
)
from . import signals
from .canonical_roles import ROLE_TRADE, coerce_json_text, normalize_role_id
from .signals import Signals

# Adjacency flag value: the profile canonicalized to NOTHING in the CNC/VMC
# taxonomy (e.g. a welder). Set on WorkerProfileDraft.unmatchable_reason so the
# profile is explicitly marked adjacent rather than silently half-empty. Adopting
# a broader occupation taxonomy (NCO-2015/ISCO-08) that brings such trades in-scope
# is an ADR-gated backend workstream — out of scope for apps/ai-service.
UNMATCHABLE_OUTSIDE_SCOPE = "outside_cnc_vmc_scope"

# Allowed values for the enum-typed draft fields. Used by ``merge_model_draft`` to
# reject a single loosely-typed value (e.g. experience_level "basic") WITHOUT
# discarding the rest of the model's good extraction.
_EXPERIENCE_LEVELS = {"fresher", "junior", "experienced", "senior", "unknown"}
_KNOWLEDGE_LEVELS = {"none", "basic", "strong", "unknown"}
_AVAILABILITY = {"immediate", "notice_period", "not_looking", "unknown"}

# missing-field -> Hinglish clarification question.
_CLARIFY: dict[str, str] = {
    "primary_role": "Aap mainly operator ho, setter ho ya programmer?",
    "experience_years": "Kitne saal ka experience hai bhai?",
    "current_city": "Abhi aap kis city me ho?",
    "current_salary": "Abhi current salary kitni hai?",
    "expected_salary": "Expected salary kitni chahiye bhai?",
    "availability": "Joining ke liye kitne din lagenge?",
    "controllers": "Controller kaunsa chalaya hai — Fanuc ya Siemens?",
}

# Fields tracked for completeness (order = priority for clarification questions).
_TRACKED: list[str] = [
    "primary_role",
    "experience_years",
    "current_city",
    "current_salary",
    "expected_salary",
    "availability",
    "controllers",
]


def _experience_level(years: float | None) -> str:
    if years is None:
        return "unknown"
    if years < 1:
        return "fresher"
    if years < 3:
        return "junior"
    if years < 8:
        return "experienced"
    return "senior"


def _build_rich(sig: Signals, role_family: str) -> WorkerProfileDraft:
    draft = WorkerProfileDraft(
        role_family=role_family,
        primary_role=sig.primary_role,
        secondary_roles=sig.secondary_roles,
        machines=sig.machines,
        controllers=sig.controllers,
        skills=sig.skills,
        experience_years=sig.experience_years,
        experience_level=_experience_level(sig.experience_years),
        programming_knowledge=sig.programming_knowledge,
        setting_knowledge=sig.setting_knowledge,
        operation_knowledge=sig.operation_knowledge,
        inspection_tools=sig.inspection_tools,
        materials_handled=sig.materials_handled,
        drawing_reading=sig.drawing_reading,
        current_city=sig.current_city,
        current_state=sig.current_state,
        preferred_locations=sig.preferred_locations,
        relocation_willingness=sig.relocation_willingness,
        current_salary=sig.current_salary,
        expected_salary=sig.expected_salary,
        availability=sig.availability,
        education=sig.education,
        certifications=sig.certifications,
    )

    def _is_missing(field_name: str) -> bool:
        value = getattr(draft, field_name)
        if field_name == "availability":
            return value == "unknown"
        if field_name == "controllers":
            return not value
        return value is None

    draft.missing_fields = [f for f in _TRACKED if _is_missing(f)]
    draft.clarification_questions = [
        _CLARIFY[f] for f in draft.missing_fields if f in _CLARIFY
    ][:3]

    core_values = (draft.primary_role, draft.machines, draft.experience_years, draft.current_city)
    core_filled = sum(1 for v in core_values if v)
    draft.confidence_score = round(min(0.3 + 0.15 * core_filled, 0.95), 2)
    return draft


def _build_legacy(sig: Signals) -> DraftProfile:
    cities = ([sig.current_city] if sig.current_city else []) + sig.preferred_locations
    return DraftProfile(
        canonical_trade_id=sig.trade_id,
        canonical_role_id=sig.role_id,
        skills=sig.skill_ids,
        machines=sig.machine_ids,
        experience=Experience(total_years=sig.experience_years),
        salary_expectation=SalaryExpectation(
            amount_min=float(sig.current_salary) if sig.current_salary else None,
            amount_max=float(sig.expected_salary) if sig.expected_salary else None,
        ),
        location_preference=LocationPreference(
            preferred_cities=cities,
            willing_to_relocate=sig.relocation_willingness,
        ),
        availability=Availability(status=sig.availability),
        confidence=0.4 if (sig.role_id or sig.machine_ids or sig.skill_ids) else 0.1,
    )


def extract(text: str, role_family: str = "cnc_vmc") -> tuple[WorkerProfileDraft, DraftProfile]:
    """Extract both the rich draft and the legacy DraftProfile in one pass."""
    sig = signals.detect(text)
    return _build_rich(sig, role_family), _build_legacy(sig)


def _as_float(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _as_str_list(value: object) -> list[str] | None:
    if not isinstance(value, list):
        return None
    return [str(x).strip() for x in value if str(x).strip()]


def _as_text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def merge_model_draft(base: WorkerProfileDraft, content: str) -> WorkerProfileDraft:
    """Overlay a model's extracted fields onto the heuristic ``base``, keeping each
    field ONLY when it is individually well-formed.

    Why not ``WorkerProfileDraft.model_validate_json``: a conversational model
    routinely nulls enum fields or loose-types ONE value (e.g. experience_level
    "basic", availability null). Strict validation then rejects the WHOLE draft, so
    genuinely-good fields (experience_years, machines) are lost with the bad ones.
    Here each field is validated on its own and silently skipped if malformed.

    Location/salary fields are deliberately NOT overlaid: the model only ever sees
    the PSEUDONYMIZED transcript, so those are trusted only from the local heuristic
    ``base``. A bad/empty ``content`` returns ``base`` unchanged.
    """
    try:
        data = json.loads(coerce_json_text(content))
    except (ValueError, TypeError):
        return base
    if not isinstance(data, dict):
        return base

    out = base.model_copy(deep=True)

    if (role := _as_text(data.get("primary_role"))) is not None:
        out.primary_role = role

    years = _as_float(data.get("experience_years"))
    if years is not None:
        out.experience_years = years
        out.experience_level = _experience_level(years)  # keep level consistent
    else:
        lvl = data.get("experience_level")
        if isinstance(lvl, str) and lvl in _EXPERIENCE_LEVELS:
            out.experience_level = lvl

    for field in (
        "machines", "controllers", "skills", "education", "inspection_tools",
        "materials_handled", "secondary_roles", "certifications",
    ):
        values = _as_str_list(data.get(field))
        if values is not None:
            setattr(out, field, values)

    for field in ("programming_knowledge", "setting_knowledge", "operation_knowledge"):
        level = data.get(field)
        if isinstance(level, str) and level in _KNOWLEDGE_LEVELS:
            setattr(out, field, level)

    availability = data.get("availability")
    if isinstance(availability, str) and availability in _AVAILABILITY:
        out.availability = availability

    if isinstance(data.get("drawing_reading"), bool):
        out.drawing_reading = data["drawing_reading"]

    return out


def map_rich_to_legacy(
    rich: WorkerProfileDraft, base: DraftProfile | None = None
) -> DraftProfile:
    """Canonicalize the MODEL-emitted rich LABELS into the legacy DraftProfile's
    closed-set ids, BACKFILLING only what the raw-text detector missed.

    Reuses the gazetteer reverse-lookup helpers (``signals.role_id_for_label`` /
    ``machine_ids_for_labels`` / ``skill_ids_for_labels``), so it only ever writes
    real, closed-set ids — NEVER free text into the matchable fields. The role id
    is additionally re-validated through ``normalize_role_id`` (defensive: only a
    known canonical id can enter ``canonical_role_id``), and its trade id is derived
    from ``ROLE_TRADE``.

    - ``canonical_role_id``/``canonical_trade_id``: filled only when ``base`` has no
      role yet AND the rich ``primary_role`` maps to an in-scope role.
    - ``machines``/``skills``: UNION of the ids already on ``base`` and the ids mapped
      from the rich labels (order-preserving, de-duplicated).

    When nothing canonicalizes (e.g. welding "mig_tig_welder"), the canonical ids
    stay null — the caller marks the profile adjacent via ``unmatchable_reason``.
    ``base`` is copied, not mutated.
    """
    legacy = base.model_copy(deep=True) if base is not None else DraftProfile()

    if legacy.canonical_role_id is None and rich.primary_role:
        match = signals.role_id_for_label(rich.primary_role)
        if match is not None:
            rid = normalize_role_id(match[0])  # defensive: closed-set id only
            if rid is not None:
                legacy.canonical_role_id = rid
                legacy.canonical_trade_id = ROLE_TRADE.get(rid, legacy.canonical_trade_id)

    for mid in signals.machine_ids_for_labels(rich.machines):
        if mid not in legacy.machines:
            legacy.machines.append(mid)

    for sid in signals.skill_ids_for_labels(rich.skills + rich.controllers):
        if sid not in legacy.skills:
            legacy.skills.append(sid)

    return legacy


def is_outside_cnc_vmc_scope(legacy: DraftProfile) -> bool:
    """True when a profile canonicalized to NOTHING matchable in the CNC/VMC
    taxonomy — no role, no skill ids, no machine ids. Used to set the advisory
    ``unmatchable_reason`` adjacency flag (honest-adjacency, not a hard reject)."""
    return not (legacy.canonical_role_id or legacy.skills or legacy.machines)


def extract_worker_profile_draft(text: str, role_family: str = "cnc_vmc") -> WorkerProfileDraft:
    return _build_rich(signals.detect(text), role_family)


def to_draft_profile(text: str) -> DraftProfile:
    return _build_legacy(signals.detect(text))
