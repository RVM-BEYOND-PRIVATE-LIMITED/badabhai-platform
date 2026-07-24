"""Pydantic contracts for the AI service.

MIRRORS the Zod contracts in `packages/ai-contracts/src/index.ts`. Keep both in
sync. PRIVACY: these never carry raw identity (no phone, name, address, employer).
"""

from __future__ import annotations

import math
import re
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator

# INTERVIEW-1 §7 parity: Zod's `z.number().int().nonnegative()` REJECTS -1 and the
# string "2". Plain `int` here would accept both (Pydantic coerces "2" -> 2), so the
# two schemas would disagree on the input domain — and the permissive side is the one
# enforcing the interview's ask bound. strict=True + ge=0 makes them agree.
AskCount = Annotated[int, Field(ge=0, strict=True)]


# --- Conversation ----------------------------------------------------------
class ConversationMessage(BaseModel):
    role: Literal["worker", "assistant", "system"]
    text: str


# --- AI call metadata (cost / observability) -------------------------------
class AICallMetadata(BaseModel):
    """Per-call cost + token accounting, returned to the backend so it can later
    be persisted on ai_jobs / events. Carries NO PII."""

    ai_call_id: str
    task_type: str
    model_name: str
    provider: str
    real_call: bool
    input_tokens: int = 0
    output_tokens: int = 0
    estimated_cost_inr: float = 0.0
    latency_ms: int = 0
    success: bool = True
    error_code: str | None = None
    cost_alert: bool = False
    above_target: bool = False
    # Diagnostics (additive, defaulted → back-compat): reconcile per-attempt log
    # volume vs per-call metadata and surface the specific transport failure.
    # PII-free: an int count, model ids, and a closed-set reason code.
    attempt_count: int = 0
    candidates_tried: list[str] = Field(default_factory=list)
    failure_reason: str | None = None
    created_at: str


# --- Pseudonymization summary (label-only; safe to return/trace) ------------
class PseudonymizationMeta(BaseModel):
    blocked: bool
    blocked_reason: str | None = None
    replaced_entities: int = 0
    placeholder_tokens: list[str] = Field(default_factory=list)


# --- Interview conversation state ------------------------------------------
class ConversationState(BaseModel):
    """Server-computed interview progress. Holds profile signals only (role,
    machines, city, etc.) — never identity PII (phone/name/employer)."""

    role_family: str = "cnc_vmc"
    turn_count: int = 0
    answered_topics: list[str] = Field(default_factory=list)
    asked_question_ids: list[str] = Field(default_factory=list)
    collected: dict = Field(default_factory=dict)

    @field_validator("answered_topics", mode="before")
    @classmethod
    def validate_answered_topics(cls, v: list[str]) -> list[str]:
        """Enforce lowercase slug topic ids (a-z, underscore) — mirrors Zod regex."""
        if not isinstance(v, list):
            raise TypeError("answered_topics must be a list of strings")
        for topic in v:
            if not isinstance(topic, str):
                raise TypeError("each topic_id must be a string")
            if not topic:
                raise ValueError("topic_id cannot be empty")
            if not re.fullmatch(r"^[a-z_]+$", topic):
                raise ValueError(f"topic_id '{topic}' must be lowercase slug ([a-z_]+)")
        return v

    # COST-4 clarify bound (additive, defaulted => backward compatible; mirrored in
    # @badabhai/ai-contracts ConversationStateSchema): CONSECUTIVE clarify re-serves
    # of the same question. clarify_turn increments it and refuses past 2 (falls
    # through to next_turn); every next_turn resets it to 0.
    clarify_count: int = 0
    # INTERVIEW-1 re-ask bound (additive, defaulted => backward compatible; mirrored in
    # @badabhai/ai-contracts ConversationStateSchema): how many times each topic has
    # been ASKED. asked_question_ids is a dedup SET and cannot count, so the bounded
    # re-ask needs its own counter. _next_topic refuses past MAX_ASKS_PER_TOPIC (2), so
    # a topic the (CNC/VMC-only) detector can never parse is asked twice, never forever.
    # Topic ids only — no PII.
    #
    # NOT a total: the COST-4 clarify path (clarify_turn) RE-SERVES the last question
    # without incrementing this — those re-serves are bounded separately by
    # clarify_count. ask_counts counts ENGINE-driven asks only.
    ask_counts: dict[str, AskCount] = Field(default_factory=dict)
    # INTERVIEW-1 completeness signal (additive, defaulted => backward compatible;
    # mirrored in @badabhai/ai-contracts ConversationStateSchema): the ESSENTIAL
    # topics the worker never actually answered, in ESSENTIAL_TOPICS order. Empty
    # list = complete.
    #
    # This — NOT extraction_ready — is how an incomplete profile is declared.
    # extraction_ready keeps its frozen v1 meaning ("the interview is over, run
    # extraction") because it is the sole gate on extraction downstream, so making it
    # False on a gap would mean no profile and no resume at all. This list is read to
    # MARK the extracted profile incomplete, making a role: null resume a known
    # outcome. Topic ids only — no PII. The API-side consumer is a follow-up task.
    unanswered_essentials: list[str] = Field(default_factory=list)


# --- Profiling turn --------------------------------------------------------
class ProfilingTurnInput(BaseModel):
    session_id: str = Field(min_length=1)
    worker_ref: str | None = None
    language: str | None = None
    message_text: str = Field(min_length=1)
    history: list[ConversationMessage] = Field(default_factory=list)
    # Phase-1 additions (optional → backward compatible):
    role_family: str = "cnc_vmc"
    conversation_state: ConversationState | None = None
    real_call_allowed: bool = True


class ProfilingOpeningInput(BaseModel):
    role_family: str = "cnc_vmc"


class ProfilingOpeningOutput(BaseModel):
    """The one-shot opener text. Deliberately just the string.

    No ``is_mock`` and no ``ai_metadata``: this is a deterministic template, no
    model is called and nothing is pseudonymized, so there is no call to describe.
    No ``worker_name`` either — the opener carries no vocative, which keeps this
    endpoint PII-free by construction. Said explicitly so a later reviewer does not
    "fix" the omission.
    """

    opening_text: str


class ProfilingTurnOutput(BaseModel):
    reply_text: str
    blocked: bool = False
    blocked_reason: str | None = None
    suggested_followups: list[str] = Field(default_factory=list)
    is_mock: bool = True
    # Phase-1 additions (optional → backward compatible):
    asked_question_id: str | None = None
    extraction_ready: bool = False
    updated_state: ConversationState | None = None
    ai_metadata: AICallMetadata | None = None
    pseudonymization_metadata: PseudonymizationMeta | None = None


# --- Pseudonymization ------------------------------------------------------
class PseudonymizationInput(BaseModel):
    text: str
    request_id: str | None = None


class PseudonymizationOutput(BaseModel):
    pseudonymized_text: str
    blocked: bool
    blocked_reason: str | None = None
    replaced_entities: int = 0
    placeholder_tokens: list[str] = Field(default_factory=list)


# --- Draft profile (shared) ------------------------------------------------
class Experience(BaseModel):
    total_years: float | None = None
    summary: str | None = None


class SalaryExpectation(BaseModel):
    amount_min: float | None = None
    amount_max: float | None = None
    currency: str = "INR"
    period: Literal["monthly", "daily", "yearly"] = "monthly"


class LocationPreference(BaseModel):
    # Issue #423 — where the worker IS, kept separate from where they WANT to work.
    # The engine has always treated these as distinct topics (question_bank.py:
    # "current AND preferred location, never conflated"), but the legacy shape had
    # nowhere to put the current city, so _build_legacy prepended it to
    # preferred_cities — turning "I live in Pune" into "I want to work in Pune".
    #
    # ADDITIVE + defaulted -> backward compatible. Mirrors LocationPreferenceSchema
    # in packages/ai-contracts (§7 parity).
    current_city: str | None = None
    preferred_cities: list[str] = Field(default_factory=list)
    willing_to_relocate: bool | None = None


class Availability(BaseModel):
    status: Literal["immediate", "notice_period", "not_looking", "unknown"] = "unknown"
    notice_period_days: int | None = None


class DraftProfile(BaseModel):
    canonical_trade_id: str | None = None
    canonical_role_id: str | None = None
    skills: list[str] = Field(default_factory=list)
    # Q14 (ADR-0030 OQ#3, decided 2026-07-16): worker-confirmed RAW skill labels
    # (e.g. "MIG welding"), rendered on the résumé alongside the canonical ids.
    # LIVE-PATH producer: the /profile/extract endpoint (main.py) populates this
    # from WorkerProfileDraft.skills via sanitize_skill_labels — hygiene clamp +
    # pseudonymize certification, so labels are CERTIFIED CLEAN AT REST before
    # they persist (map_rich_to_legacy, currently WS4-deferred, applies the same
    # pipeline). NEVER canonical ids, NEVER used for matching/ranking. Additive:
    # old persisted rows lack the field → default [] → prior behavior unchanged.
    # The résumé boundary RE-certifies every label before it can reach the
    # artifact or the LLM payload (SG-2, fail-closed → dropped).
    skill_labels: list[str] = Field(default_factory=list)
    machines: list[str] = Field(default_factory=list)
    experience: Experience = Field(default_factory=Experience)
    salary_expectation: SalaryExpectation = Field(default_factory=SalaryExpectation)
    location_preference: LocationPreference = Field(default_factory=LocationPreference)
    availability: Availability = Field(default_factory=Availability)
    confidence: float | None = None


# --- Rich worker profile draft (human-readable; richer than DraftProfile) ---
ExperienceLevel = Literal["fresher", "junior", "experienced", "senior", "unknown"]
KnowledgeLevel = Literal["none", "basic", "strong", "unknown"]


class WorkerProfileDraft(BaseModel):
    """The clean messy-text → profile output. Uses human-readable labels (e.g.
    "VMC Operator", "Fanuc") rather than taxonomy ids. `DraftProfile` is derived
    from this for backward-compatible storage."""

    role_family: str = "cnc_vmc"
    primary_role: str | None = None
    # The model's canonicalized role id (one of canonical_roles.ROLE_IDS or null).
    # Optional → backward compatible; VALIDATED against the closed set before use.
    canonical_role_id: str | None = None
    secondary_roles: list[str] = Field(default_factory=list)
    machines: list[str] = Field(default_factory=list)
    controllers: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    experience_years: float | None = None
    experience_level: ExperienceLevel = "unknown"
    programming_knowledge: KnowledgeLevel = "unknown"
    setting_knowledge: KnowledgeLevel = "unknown"
    operation_knowledge: KnowledgeLevel = "unknown"
    inspection_tools: list[str] = Field(default_factory=list)
    materials_handled: list[str] = Field(default_factory=list)
    drawing_reading: bool | None = None
    current_city: str | None = None
    # State-level location, captured when the worker names a state (e.g. "Bihar")
    # rather than a specific city. Additive (default None → backward compatible).
    current_state: str | None = None
    preferred_locations: list[str] = Field(default_factory=list)
    relocation_willingness: bool | None = None
    current_salary: int | None = None
    expected_salary: int | None = None
    availability: Literal["immediate", "notice_period", "not_looking", "unknown"] = "unknown"
    education: list[str] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)
    confidence_score: float = 0.0
    missing_fields: list[str] = Field(default_factory=list)
    clarification_questions: list[str] = Field(default_factory=list)
    # Advisory adjacency flag: set (e.g. "outside_cnc_vmc_scope") when the profile
    # canonicalizes to nothing matchable in the CNC/VMC taxonomy, so it is marked
    # adjacent rather than silently half-empty. Additive (default None). Advisory
    # ONLY — never used to rank/reject a worker. Mirrors the Zod contract.
    unmatchable_reason: str | None = None


# --- Skill canonicalization (ADR-0030 / TAX-4) -----------------------------
class SkillCanonicalizationInput(BaseModel):
    """One skill phrase to canonicalize within a domain. ``phrase`` is a skill LABEL the
    extraction proposed; it is pseudonymized before the embed regardless (SG-2)."""

    phrase: str
    domain_id: str
    lang: str = "en"


class SkillCanonicalization(BaseModel):
    """Canonicalization outcome: either an ASSIGNED ``skill_id`` (top match >= floor) or
    UNRESOLVED. Carries NO PII. SG-3 / LLM-never-invents: ``skill_id`` is None unless the
    vector layer assigned it. Mirrors ``SkillCanonicalizationSchema`` in ai-contracts."""

    status: Literal["matched", "unresolved"]
    skill_id: str | None = None
    score: float | None = None


# --- Skill-alias embedding batch (ADR-0030 / TAX-3 fork-B runner seam) ------
class SkillAliasEmbedItem(BaseModel):
    """One alias to embed. ``text`` is reference vocabulary (no worker PII by design)
    and is STILL pseudonymized before any embed (SG-2)."""

    alias_id: str
    text: str


class SkillAliasEmbedInput(BaseModel):
    """A batch from the db-side runner (packages/db embed-skill-aliases.ts — the
    owner-chosen fork-B: DB read/write stays on the runner, this service stays DB-free).
    Capped so one request never smuggles an unbounded corpus."""

    items: list[SkillAliasEmbedItem] = Field(max_length=200)


class SkillAliasEmbedResult(BaseModel):
    """``vector`` is None iff the text was blocked (fail-closed) — the runner leaves
    that row NULL and excludes it from later fetches this run."""

    alias_id: str
    vector: list[float] | None = None
    blocked: bool = False


class SkillAliasEmbedOutput(BaseModel):
    """``results`` may be SHORTER than ``items``: an item is OMITTED when the request's
    real-spend budget stopped (``budget_stopped``) or its provider call errored
    (counted in ``errors``) — those rows stay NULL on the runner side and a later run
    resumes them. Already-paid embeds in the same request are always returned."""

    results: list[SkillAliasEmbedResult]
    is_mock: bool = True
    model: str
    # True when the per-request INR ceiling (ai_max_call_cost_inr) stopped the real batch
    # early (TD64 interim guard — enforced HERE, on the path the runner actually hits).
    budget_stopped: bool = False
    # Per-item real-provider failures skipped (item omitted; batch continues).
    errors: int = 0
    # Accumulated estimate for THIS request's real embeds (0.0 on the mock path).
    estimated_cost_inr: float = 0.0


# --- Growth-loop clustering (ADR-0030 / TAX-7 — pure compute, human-gated) --
_GROWTH_VECTOR_DIM = 768  # the house embedding dimension (mirrors skill_alias/worker_profiles)


def _validate_growth_vector(vec: list[float]) -> list[float]:
    """Exactly the 768 house dim and finite — a foreign-dim or NaN/inf vector would
    silently poison every cosine in the batch. On the MODEL (not just the batch input)
    so a standalone GrowthPhrase/GrowthAnchor holds the same guarantee as the Zod mirror."""
    if len(vec) != _GROWTH_VECTOR_DIM:
        raise ValueError(f"vector must be {_GROWTH_VECTOR_DIM}-dim (got {len(vec)})")
    if not all(math.isfinite(v) for v in vec):
        raise ValueError("vector contains a non-finite value")
    return vec


class GrowthPhrase(BaseModel):
    """One OPEN ``unresolved_phrase`` row. ``phrase`` is ALREADY pseudonymized at rest
    (SG-1); the growth endpoint never logs it and never sends it to an LLM."""

    id: str
    phrase: str
    count: int = Field(ge=1)
    vector: list[float]

    @field_validator("vector")
    @classmethod
    def _check_vector(cls, vec: list[float]) -> list[float]:
        return _validate_growth_vector(vec)


class GrowthAnchor(BaseModel):
    """One embedded ``skill_alias`` row — the CLOSED id space cluster centroids are
    compared against. An anchor ``skill_id`` is the ONLY id a proposal may carry (SG-3)."""

    skill_id: str
    vector: list[float]

    @field_validator("vector")
    @classmethod
    def _check_vector(cls, vec: list[float]) -> list[float]:
        return _validate_growth_vector(vec)


class GrowthClusterInput(BaseModel):
    """A per-domain batch from the db-side growth runner (fork-B pattern). Capped so one
    request never smuggles an unbounded queue; ``None`` params fall back to Settings.
    Vector hygiene (768-dim, finite) is enforced on GrowthPhrase/GrowthAnchor."""

    domain_id: str
    phrases: list[GrowthPhrase] = Field(max_length=500)
    anchors: list[GrowthAnchor] = Field(max_length=5000)
    min_cluster_size: int | None = Field(default=None, ge=1)
    min_total_count: int | None = Field(default=None, ge=1)
    cluster_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    band_low: float | None = Field(default=None, ge=0.0, le=1.0)
    floor: float | None = Field(default=None, ge=0.0, le=1.0)


class GrowthProposal(BaseModel):
    """One human-gated proposal. ``kind=alias`` → ``skill_id`` is set and is ALWAYS one of
    the request's anchors (SG-3). ``kind=provisional_skill`` → ``skill_id`` is None: NO id
    is minted here (SG-5) — creating one is a human taxonomy decision. ``nearest_*`` are
    diagnostics for the reviewer on both kinds. Carries no PII (phrases are SG-1 text)."""

    kind: Literal["alias", "provisional_skill"]
    skill_id: str | None = None
    leader_phrase: str
    member_ids: list[str]
    member_phrases: list[str]
    total_count: int
    nearest_skill_id: str | None = None
    nearest_score: float | None = None
    note: str | None = None


class GrowthClusterOutput(BaseModel):
    """Report-only output — the runner renders it into the proposals packet; the existing
    ratification flow is the ONLY activation path."""

    proposals: list[GrowthProposal]
    phrases_in: int
    clusters_total: int
    clusters_eligible: int
    skipped_below_guards: int


# --- Offline skill re-tag plan (ADR-0030 / TAX-9 — pure compute, dry-run first) ---
class RetagCrosswalkEntry(BaseModel):
    """One ``skill.replaced_by`` edge: a DEPRECATED id and its immutable successor."""

    deprecated_id: str
    replaced_by: str


class RetagRow(BaseModel):
    """One stored row to plan against. ``row_ref`` is an OPAQUE row uuid — no PII."""

    row_ref: str
    skill_ids: list[str] = Field(max_length=100)


class RetagPlanInput(BaseModel):
    """A batch from the db-side retag runner (fork-B pattern; caps bound one request)."""

    crosswalk: list[RetagCrosswalkEntry] = Field(max_length=1000)
    rows: list[RetagRow] = Field(max_length=5000)


class RetagResolvedEntry(BaseModel):
    """A crosswalk edge resolved to its TERMINAL id (chains A→B→C collapse; ``hops`` =
    edges walked). SG-5: terminal ids come from the caller-supplied crosswalk only."""

    deprecated_id: str
    terminal_id: str
    hops: int


class RetagChange(BaseModel):
    """One row whose ids change: ``after`` = crosswalk-mapped + first-seen de-duplicated.
    Rows the crosswalk does not touch are never listed (no dedup-only rewrites)."""

    row_ref: str
    before: list[str]
    after: list[str]


class RetagPlanOutput(BaseModel):
    """The dry-run plan. ``dropped`` = crosswalk ids on a CYCLE — fail-safe, not
    re-tagged, fix the corpus. The runner applies ``changes`` only under ``--apply``."""

    resolved: list[RetagResolvedEntry]
    dropped: list[str]
    changes: list[RetagChange]
    rows_in: int
    rows_changed: int


# --- Profile extraction ----------------------------------------------------
class ProfileExtractionInput(BaseModel):
    worker_ref: str | None = None
    language: str | None = None
    transcript: str | None = None
    messages: list[ConversationMessage] | None = None
    role_family: str = "cnc_vmc"  # Phase-1 addition (optional → backward compatible)


class ProfileExtractionOutput(BaseModel):
    profile: DraftProfile
    blocked: bool = False
    blocked_reason: str | None = None
    is_mock: bool = True
    # Phase-1 additions (optional → backward compatible):
    extraction_status: Literal["completed", "blocked"] = "completed"
    worker_profile_draft: WorkerProfileDraft | None = None
    ai_metadata: AICallMetadata | None = None


# --- Resume generation -----------------------------------------------------
class ResumeGenerationInput(BaseModel):
    profile: DraftProfile
    language: str | None = None
    # Opaque worker ref (PII-free) → attributes resume spend to the per-user daily
    # cap, so resume + chat + extraction share one Rs 6/user/day budget. Optional →
    # backward compatible.
    worker_ref: str | None = None


class ResumeGenerationOutput(BaseModel):
    resume_text: str
    resume_json: dict = Field(default_factory=dict)
    format: Literal["text", "json"] = "text"
    is_mock: bool = True


# --- Voice transcription (STT) ---------------------------------------------
class TranscriptionInput(BaseModel):
    """Request to transcribe an uploaded voice note. Carries only an opaque
    storage reference + non-identity metadata — never raw audio bytes here."""

    voice_note_id: str | None = None
    storage_path: str = Field(min_length=1)
    duration_seconds: float | None = None
    language_code: str | None = None
    real_call_allowed: bool = True
    # When true (default), the AI service ALSO translates the transcript to English
    # (Sarvam /translate). English-source transcripts skip the call. Backward compatible.
    translate_to_english: bool = True
    # Opaque worker ref (PII-free) → attributes real STT chunk spend to the TD27
    # per-user daily cap (D-2 chunked path: one 120s note = up to 5 provider
    # calls), so voice + chat + extraction + resume share one budget. Optional →
    # backward compatible.
    worker_ref: str | None = None


class TranscriptionOutput(BaseModel):
    """Transcription result. `transcript_text` is raw worker free-text (may
    contain PII) — it is returned ONLY to the trusted backend and must never be
    logged or placed in events/ai_jobs (those carry length/confidence only)."""

    transcript_text: str
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    language_code: str | None = None
    is_mock: bool = True
    # Derived English translation of transcript_text (empty when not translated /
    # source already English-empty / translation failed-closed). Raw worker text —
    # the backend stores it in voice_notes.transcript_english and keeps it OUT of
    # events/ai_jobs/logs, same as transcript_text.
    english_text: str = ""
