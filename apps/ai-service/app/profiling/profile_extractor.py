"""Messy-text → clean-profile extraction (Phase-1 heuristic / mock).

Builds the rich :class:`WorkerProfileDraft` from ``signals`` and derives the
legacy :class:`DraftProfile` (taxonomy ids) for backward-compatible storage.
Both come from a single ``signals.detect`` pass — no duplicated detection logic.

This boundary will later host an LLM-based extractor (behind pseudonymization);
the contract returned here is stable so the backend/Flutter need not change.
"""

from __future__ import annotations

import json
import re

from ..ai.canonicalize import SkillCanonicalStore, canonicalize_labels
from ..config import Settings
from ..contracts import (
    Availability,
    DraftProfile,
    Experience,
    LocationPreference,
    SalaryExpectation,
    WorkerProfileDraft,
)
from ..pseudonymize import certified_clean_skill_labels
from . import signals
from .canonical_roles import ROLE_TRADE, coerce_json_text, normalize_role_id
from .signals import Signals

# Adjacency flag value: the profile canonicalized to NOTHING in the launch
# taxonomy. Set on WorkerProfileDraft.unmatchable_reason so the profile is explicitly
# marked adjacent rather than silently half-empty. Adopting the full broader occupation
# taxonomy (NCO-2015/ISCO-08, ADR-0028) is still an ADR-gated backend workstream.
#
# TAX-WELD-1: WELDING IS NO LONGER AN EXAMPLE OF THIS. A welder now canonicalizes to
# role_welder / dom_welding + the pre-existing welding skill ids, so they are no longer
# flagged adjacent. The flag still fires for genuinely out-of-scope trades (fitter,
# electrician, carpenter, helper).
UNMATCHABLE_OUTSIDE_SCOPE = "outside_cnc_vmc_scope"

# Allowed values for the enum-typed draft fields. Used by ``merge_model_draft`` to
# reject a single loosely-typed value (e.g. experience_level "basic") WITHOUT
# discarding the rest of the model's good extraction.
_EXPERIENCE_LEVELS = {"fresher", "junior", "experienced", "senior", "unknown"}
_KNOWLEDGE_LEVELS = {"none", "basic", "strong", "unknown"}
_AVAILABILITY = {"immediate", "notice_period", "not_looking", "unknown"}

# missing-field -> neutral mentor clarification question (AI-PERSONA-1: no
# vocative, no gush, "aap"/present tense, one question, <=20 words).
_CLARIFY: dict[str, str] = {
    "primary_role": "Aap operator, setter ya programmer — kaunsa kaam karte hain?",
    "experience_years": "Kitne saal ka experience hai?",
    "current_city": "Abhi kis sheher mein hain?",
    "current_salary": "Abhi salary kitni hai?",
    "expected_salary": "Kitni salary expect karte hain?",
    "availability": "Join karne mein kitne din?",
    "controllers": "Controller kaunsa — Fanuc ya Siemens?",
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


def _refresh_completeness(draft: WorkerProfileDraft) -> None:
    """(Re)compute the DERIVED completeness report on ``draft``, in place.

    ``missing_fields`` / ``clarification_questions`` / ``confidence_score`` are
    functions of the other fields, so any step that writes a field must refresh
    them or the draft starts asserting things about itself that are no longer
    true (e.g. still listing ``expected_salary`` as missing after it was filled).
    """
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
    _refresh_completeness(draft)
    return draft


def _build_legacy(sig: Signals) -> DraftProfile:
    # Issue #423 — the current city is NO LONGER prepended to preferred_cities. The
    # engine keeps `current_location` and `preferred_locations` as separate topics
    # (question_bank.py: "never conflated"), and the legacy shape now has its own
    # `current_city` field, so "I live in Pune" stops being recorded as "I want to
    # work in Pune". Consumers read `current_city ?? preferred_cities[0]`, which is
    # why rows written before this field existed keep working.
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
            current_city=sig.current_city,
            preferred_cities=sig.preferred_locations,
            willing_to_relocate=sig.relocation_willingness,
        ),
        availability=Availability(
            status=sig.availability, notice_period_days=sig.notice_period_days
        ),
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


# --- Engine-collected answers -> the draft (D1) -----------------------------
#
# ``ConversationState.collected`` maps an interview TOPIC id to the value the
# worker gave AS THE ANSWER TO THAT QUESTION. Both it and ``extract()`` run the
# SAME deterministic detector (``signals``) — the difference is CONTEXT:
#
#   * ``collected`` is written by ``interview_engine.next_turn``, which passes
#     ``last_asked`` into ``signals.detect_answered_topics`` and then applies the
#     P1-1 overwrite rule (the asked topic commits, an explicit correction
#     commits, otherwise first write wins);
#   * ``extract()`` re-derives everything CONTEXT-FREE over the concatenated
#     transcript, where it cannot know which question any line answered.
#
# MEASURED consequence (the defect this closes): a worker answering the
# expected-salary question with a bare amount has it recorded as
# ``collected["salary_expected"]``, while ``_detect_salary`` over the transcript
# assigns the first cue-less amount to ``current_salary`` and then DROPS the
# second one (``elif sig.current_salary is None``). The resume shipped
# ``expected_salary: null`` for a value the parser had already captured.
#
# Topic id -> the SCALAR draft field it owns. On disagreement the collected value
# wins (see :func:`merge_collected`).
_COLLECTED_SCALAR_FIELDS: dict[str, str] = {
    "role": "primary_role",
    "experience": "experience_years",
    "current_location": "current_city",
    "salary_current": "current_salary",
    "salary_expected": "expected_salary",
    "availability": "availability",
}
# Topic id -> the LIST draft field it contributes to. Unioned, never replaced.
_COLLECTED_LIST_FIELDS: dict[str, str] = {
    "machines": "machines",
    "controllers": "controllers",
    "skills": "skills",
    "education": "education",
    "preferred_locations": "preferred_locations",
}


def _as_int(value: object) -> int | None:
    """A positive whole amount, or None. ``bool`` is excluded explicitly (it is an
    ``int`` subclass, and ``True`` must never become a salary of 1)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    amount = int(value)
    return amount if amount > 0 else None


def _union_labels(base: list[str], extra: list[str]) -> list[str]:
    """``base`` order preserved, members of ``extra`` not already present appended.
    Case-insensitive dedupe (first casing wins) — mirrors ``clamp_skill_labels``."""
    out = list(base)
    seen = {label.lower() for label in out}
    for label in extra:
        if label.lower() not in seen:
            seen.add(label.lower())
            out.append(label)
    return out


def merge_collected(base: WorkerProfileDraft, collected: dict | None) -> WorkerProfileDraft:
    """Merge the interview engine's question-attributed answers onto ``base``.

    THE PRECEDENCE RULE (see the table above for why):

    * **Scalars** — ``collected`` WINS. It is the answer the worker gave to that
      exact question, already guarded against incidental overwrite by the P1-1
      rule; ``base`` is a context-free re-derivation that demonstrably
      mis-attributes and drops. When ``collected`` is silent, ``base`` stands;
      when ``base`` is silent, ``collected`` fills it. **Neither side ever writes
      a null over a value** — this merge is strictly additive/corrective.
    * **Lists** — UNIONED, never replaced. A list is not a *correction* of
      another list: ``collected`` holds what ONE message contained, ``base`` what
      the whole transcript did (e.g. collected ``["VMC"]`` vs extracted
      ``["VMC", "CNC Lathe"]``). Replacing would delete a machine the worker
      really did mention. Base order first, collected-only members appended.
    * **Malformed values are SKIPPED, never coerced** — the same posture as
      :func:`merge_model_draft`. ``collected`` is typed ``dict`` on the contract,
      so it is treated as untrusted in shape. This also handles the engine's
      ``preferred_locations = "flexible"`` SENTINEL, which marks "kahin bhi
      chalega" as an ANSWER: it is a marker, not a place, and must never be
      written into the resume's city list. (Nothing is lost — the same phrase is
      what sets ``relocation_willingness`` on the transcript pass.)

    Ordering: callers must run this LAST, after any model overlay
    (:func:`merge_model_draft`). The model sees only the masked transcript and
    likewise has no question context, so a deterministic, worker-attributed value
    must outrank it. This strictly REDUCES the LLM's influence on the profile
    (CLAUDE.md §2 #4 — the LLM assists, it never decides).

    PRIVACY: pure local dict/label arithmetic over values the engine already
    holds in process (closed-set gazetteer labels, canonical cities, ints,
    enums). It performs no I/O and MUST NOT be called with anything on its way to
    a model. ``base`` is copied, never mutated.
    """
    out = base.model_copy(deep=True)
    if not collected:
        return out

    for topic_id, field in _COLLECTED_SCALAR_FIELDS.items():
        if topic_id not in collected:
            continue
        raw = collected[topic_id]
        if field in ("current_salary", "expected_salary"):
            amount = _as_int(raw)
            if amount is not None:
                setattr(out, field, amount)
        elif field == "experience_years":
            years = _as_float(raw)
            if years is not None:
                out.experience_years = years
                out.experience_level = _experience_level(years)  # keep level consistent
        elif field == "availability":
            if isinstance(raw, str) and raw in _AVAILABILITY:
                out.availability = raw
        else:  # primary_role / current_city — non-empty text only
            text = _as_text(raw)
            if text is not None:
                setattr(out, field, text)

    for topic_id, field in _COLLECTED_LIST_FIELDS.items():
        values = _as_str_list(collected.get(topic_id))
        if values:
            setattr(out, field, _union_labels(getattr(out, field), values))

    # The merge is the LAST write before the profile is used, so the derived
    # completeness report must be recomputed or it will claim we still need to ask
    # for something we now have.
    _refresh_completeness(out)
    return out


# Q14 hygiene clamp for worker-confirmed raw skill labels (defense in depth — the
# HARD gate is pseudonymize() at the résumé boundary in main.py). Escaped classes
# only: control chars are matched via \x escapes, never raw bytes.
_LABEL_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
_LABEL_MAX_CHARS = 80
_LABEL_MAX_COUNT = 20


def sanitize_skill_labels(labels: list[str]) -> list[str]:
    """Population-time pipeline for ``DraftProfile.skill_labels`` (Q14) — the
    CERTIFY-AT-REST gate: hygiene clamp first (so the certified text is exactly
    the text that persists), then pseudonymize certification via
    ``certified_clean_skill_labels`` (blocked/masked/altered labels never enter
    the persisted profile). apps/api stores this profile as
    ``profiles.raw_profile`` and later ``generated_resumes.sourceProfileSnapshot``,
    and the PDF + payer-facing disclosure surfaces render ``skill_labels`` from
    that snapshot with NO TypeScript pseudonymize equivalent — so certification
    must happen here, at population. The résumé boundary re-certifies (defense
    in depth). Certification after the 20-cap can leave fewer than 20 labels —
    over-drop is the safe direction. Never logs label text."""
    return certified_clean_skill_labels(clamp_skill_labels(labels))


def clamp_skill_labels(labels: list[str]) -> list[str]:
    """Hygiene-clamp raw skill labels for ``DraftProfile.skill_labels`` (Q14):
    strip control chars, trim, drop empties, drop over-length (> 80 chars),
    case-insensitive dedupe (first casing wins), cap at 20 labels."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in labels:
        if not isinstance(raw, str):
            continue
        label = _LABEL_CONTROL_CHARS_RE.sub("", raw).strip()
        if not label or len(label) > _LABEL_MAX_CHARS:
            continue
        key = label.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(label)
        if len(out) >= _LABEL_MAX_COUNT:
            break
    return out


def map_rich_to_legacy(
    rich: WorkerProfileDraft,
    base: DraftProfile | None = None,
    *,
    skill_store: SkillCanonicalStore | None = None,
    settings: Settings | None = None,
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
    - ``skill_labels`` (Q14): the rich ``skills`` LABELS, sanitized via
      ``sanitize_skill_labels`` (hygiene clamp + pseudonymize certification —
      certify-at-rest) — raw display text for the résumé only, never matchable.

    TAX-4 (ADR-0030): when ``skill_store`` + ``settings`` are supplied AND
    ``settings.skill_canonicalize_enabled`` is on, the model-emitted skill LABELS are
    ADDITIONALLY vector-canonicalized against ``skill_alias`` — assigning skill_ids the
    local gazetteer missed and recording misses (pseudonymized) for later learning. Only
    vector-ASSIGNED ids are added (SG-3: the LLM proposes phrases, this layer assigns ids;
    an LLM phrase can never inject an id the vector layer did not assign). Default (no store
    / flag off) → unchanged gazetteer-only behavior, so the raw phrase is preserved (rollback).

    When nothing canonicalizes (a genuinely out-of-scope trade — fitter, electrician,
    carpenter), the canonical ids stay null and the caller marks the profile adjacent
    via ``unmatchable_reason``. TAX-WELD-1: welding ("mig_tig_welder") is no longer
    such a case — it maps to role_welder + the pre-existing welding skill ids.
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

    # Q14 (ADR-0030 OQ#3): carry the worker's RAW skill labels onto the persisted
    # DraftProfile so the résumé can render them (labels-only field — the matchable
    # ``skills`` ids above are untouched; never rank/match on labels). CERTIFIED AT
    # REST via sanitize_skill_labels (clamp + pseudonymize certification): a
    # blocked/masked/altered label never persists, so every downstream renderer of
    # the snapshot (PDF, payer disclosure) only ever sees certified-clean labels.
    # The résumé boundary re-certifies (SG-2, defense in depth).
    legacy.skill_labels = sanitize_skill_labels(legacy.skill_labels + rich.skills)

    # TAX-4: flagged vector canonicalization over the DB seam (default off → no-op).
    if skill_store is not None and settings is not None and settings.skill_canonicalize_enabled:
        domain_id = settings.skill_canonicalize_default_domain
        assigned, _unresolved = canonicalize_labels(
            rich.skills + rich.controllers, domain_id, skill_store, settings
        )
        for sid in assigned:
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
