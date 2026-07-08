"""Pydantic contracts for the AI service.

MIRRORS the Zod contracts in `packages/ai-contracts/src/index.ts`. Keep both in
sync. PRIVACY: these never carry raw identity (no phone, name, address, employer).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


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
    preferred_cities: list[str] = Field(default_factory=list)
    willing_to_relocate: bool | None = None


class Availability(BaseModel):
    status: Literal["immediate", "notice_period", "not_looking", "unknown"] = "unknown"
    notice_period_days: int | None = None


class DraftProfile(BaseModel):
    canonical_trade_id: str | None = None
    canonical_role_id: str | None = None
    skills: list[str] = Field(default_factory=list)
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
