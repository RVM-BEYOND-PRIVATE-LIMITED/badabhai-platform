"""Messy-text → clean-profile extraction (Phase-1 heuristic / mock).

Builds the rich :class:`WorkerProfileDraft` from ``signals`` and derives the
legacy :class:`DraftProfile` (taxonomy ids) for backward-compatible storage.
Both come from a single ``signals.detect`` pass — no duplicated detection logic.

This boundary will later host an LLM-based extractor (behind pseudonymization);
the contract returned here is stable so the backend/Flutter need not change.
"""

from __future__ import annotations

from ..contracts import (
    Availability,
    DraftProfile,
    Experience,
    LocationPreference,
    SalaryExpectation,
    WorkerProfileDraft,
)
from . import signals
from .signals import Signals

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


def extract_worker_profile_draft(text: str, role_family: str = "cnc_vmc") -> WorkerProfileDraft:
    return _build_rich(signals.detect(text), role_family)


def to_draft_profile(text: str) -> DraftProfile:
    return _build_legacy(signals.detect(text))
