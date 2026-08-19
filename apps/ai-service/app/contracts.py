"""Pydantic contracts for the AI service.

MIRRORS the Zod contracts in `packages/ai-contracts/src/`. Keep both in
sync. PRIVACY: these never carry raw identity (no phone, name, address, employer).
"""

from __future__ import annotations

import math
import re
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationInfo,
    field_validator,
    model_validator,
)

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


# ===========================================================================
# Occupation Intelligence Engine (OIE) — the deterministic-profiling contracts.
# ---------------------------------------------------------------------------
# MIRRORS packages/ai-contracts/src/oie.ts, asserted key-for-key by
# tests/test_contract_parity.py against src/__fixtures__/oie.keys.json. Part of the
# Phase 0 contract FREEZE: any change here is a joint PR that moves the Zod side, this
# file and the fixture in the same commit.
#
# PRIVACY: nothing here carries identity PII by construction. Answers are RFS profile
# signals; question packs are reviewed static copy; evidence quotes are spans of the
# PSEUDONYMIZED transcript — the only transcript the parse call ever sees.
# ===========================================================================

# `int().positive()` parity, same reasoning as AskCount above: Zod rejects 0 and "2".
PositiveInt = Annotated[int, Field(ge=1, strict=True)]

ProfilingPhase = Literal[
    "identify",
    "disambiguate",
    # The LLM-led stretch. APPENDED, never inserted — authored packs carry `phase_is`
    # predicates comparing against these literals, so re-ordering silently re-targets them.
    "llm_interview",
    "occupation_specific",
    "universal_tail",
    "close",
]
LlmInterviewStage = Literal["domain", "role", "skills", "experience", "done"]
InputMode = Literal["text", "options_only"]
OccupationMatchLayer = Literal["l0_exact", "l1_skeleton", "l2_trigram", "l3_vector"]
# The five job-domain statuses PLUS the two deterministic-engine outcomes migration 0076
# adds to the worker_profiles CHECK — declared ahead of 0076 because this file freezes at
# Phase 0 and the CHECK expansion must not need a contract change.
OccupationMatchStatus = Literal[
    "matched_auto",
    "matched_llm",
    "unmatched_below_floor",
    "unmatched_llm_declined",
    "unmatched_degraded",
    "matched_lexical",
    "matched_worker_confirmed",
]
AnswerStatus = Literal["answered", "declined", "unanswered", "superseded"]

_SLUG_RE = re.compile(r"^[a-z_]+$")


def _validate_slug(value: str, field_name: str) -> str:
    """The `^[a-z_]+$` ≤40 filter every question_key / field id must pass — the same
    filter the event-payload path applies (`slugFieldIds`), enforced at the contract
    instead of discovered inside the flush transaction. Mirrors Zod's `slugKey`."""
    if not value or len(value) > 40 or not _SLUG_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be a lowercase slug ([a-z_]+, <=40 chars)")
    return value


class EvidenceSpan(BaseModel):
    """A literal span of the pseudonymized transcript. The provenance gate — the
    strongest of the six parse gates — verifies `quote` is a substring of
    `transcript[message_index].text` after whitespace normalization."""

    message_index: AskCount
    quote: str = Field(min_length=1)


class AnswerRecordHistoryEntry(BaseModel):
    """A superseded value, kept when a correction overwrites an answer. Load-bearing for
    the parse call: the transcript holds both values, the history says which won."""

    value_raw: str | None = None
    value_normalized: Any | None = None
    status: AnswerStatus = "superseded"
    evidence: EvidenceSpan | None = None
    turn: AskCount = 0


class AnswerRecord(BaseModel):
    """One captured answer — the unit of the deterministic answer map, which is the parse
    call's PRIMARY input (the transcript is only its evidence store). `value_normalized`
    is written at CAPTURE time by the orchestrator, never at parse time — that is what
    makes the fail-closed projection (LLM down => profile from the map alone) real."""

    question_key: str
    target_field: str | None = None
    value_raw: str | None = None
    value_normalized: Any | None = None
    status: AnswerStatus = "unanswered"
    evidence: EvidenceSpan | None = None
    turn: AskCount = 0
    history: list[AnswerRecordHistoryEntry] = Field(default_factory=list)

    @field_validator("question_key")
    @classmethod
    def _question_key_slug(cls, v: str) -> str:
        return _validate_slug(v, "question_key")

    @field_validator("target_field")
    @classmethod
    def _target_field_slug(cls, v: str | None) -> str | None:
        return v if v is None else _validate_slug(v, "target_field")


class OccupationPin(BaseModel):
    """The identified occupation, pinned to the conversation the moment retrieval
    resolves it. pack_id + pack_version + catalog_version are IMMUTABLE for the rest of
    the conversation (risk #13)."""

    job_domain_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    isco_unit_code: str | None = None
    match_status: OccupationMatchStatus = "unmatched_degraded"
    match_score: float | None = None
    match_layer: OccupationMatchLayer | None = None
    pack_id: str | None = None
    pack_version: PositiveInt | None = None
    catalog_version: str | None = None


class PredicateOperand(BaseModel):
    """Exactly one of `field` (reads answers[id].value_normalized — the ONLY thing the
    evaluator can read) or `const` (a literal). Key PRESENCE decides, mirroring the Zod
    refine — `{"const": null}` is a valid literal null, not an absent operand."""

    field: str | None = None
    const: Any | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> PredicateOperand:
        provided = self.model_fields_set & {"field", "const"}
        if len(provided) != 1:
            raise ValueError("an operand is exactly one of {field} or {const}")
        return self


PredicateOp = Literal[
    "all",
    "any",
    "not",
    "answered",
    "declined",
    "eq",
    "neq",
    "in",
    "gte",
    "lte",
    "occupation_is",
    "occupation_under",
    "phase_is",
    "turn_gte",
]

# Which optional keys each operator REQUIRES. One closed table, no other combination —
# byte-for-byte the same table as PREDICATE_ARITY in oie.ts.
_PREDICATE_ARITY: dict[str, tuple[str, ...]] = {
    "all": ("predicates",),
    "any": ("predicates",),
    "not": ("predicate",),
    "answered": ("field",),
    "declined": ("field",),
    "eq": ("left", "right"),
    "neq": ("left", "right"),
    "in": ("left", "right"),
    "gte": ("left", "right"),
    "lte": ("left", "right"),
    "occupation_is": ("job_domain_id",),
    "occupation_under": ("isco_code",),
    "phase_is": ("phase",),
    "turn_gte": ("turn",),
}
_PREDICATE_OPERAND_KEYS = (
    "predicates",
    "predicate",
    "field",
    "left",
    "right",
    "job_domain_id",
    "isco_code",
    "phase",
    "turn",
)


class Predicate(BaseModel):
    """The ask_if/skip_if condition — a closed JSON AST, NEVER a string, therefore no
    expression-parser injection surface. ONE object shape with an `op` discriminant so
    this model and the Zod side share a stable key list; the validator enforces per-op
    arity, and the Phase 4 pack validator re-checks at boot."""

    op: PredicateOp
    predicates: list[Predicate] | None = None
    predicate: Predicate | None = None
    field: str | None = None
    left: PredicateOperand | None = None
    right: PredicateOperand | None = None
    job_domain_id: str | None = None
    isco_code: str | None = None
    phase: ProfilingPhase | None = None
    turn: AskCount | None = None

    @model_validator(mode="after")
    def _arity(self) -> Predicate:
        required = _PREDICATE_ARITY[self.op]
        for key in required:
            if getattr(self, key) is None:
                raise ValueError(f'op "{self.op}" requires "{key}"')
        for key in _PREDICATE_OPERAND_KEYS:
            if getattr(self, key) is not None and key not in required:
                raise ValueError(f'op "{self.op}" does not take "{key}"')
        return self


Predicate.model_rebuild()


QuestionTargetKind = Literal["rfs", "match_skill", "attribute", "none"]
AnswerType = Literal["text", "number", "boolean", "single_select", "multi_select"]
QuestionPackStatus = Literal["draft", "active", "deprecated"]


class QuestionPackOption(BaseModel):
    """A chip. The label IS the worker's answer of record verbatim when tapped — which is
    why chips are reviewed static data and never model output."""

    option_key: str
    label_text: str = Field(min_length=1)
    value: Any | None = None
    implies_skill_id: str | None = None
    is_none_of_above: bool = False

    @field_validator("option_key")
    @classmethod
    def _option_key_slug(cls, v: str) -> str:
        return _validate_slug(v, "option_key")


class QuestionPackItem(BaseModel):
    question_key: str
    prompt_text: str = Field(min_length=1)
    display_order: AskCount
    target_kind: QuestionTargetKind
    target_field: str | None = None
    target_skill_id: str | None = None
    answer_type: AnswerType
    is_mandatory: bool = False
    is_core: bool = False
    max_asks: PositiveInt = 2
    min_turn: AskCount | None = None
    max_turn: AskCount | None = None
    ask_if: Predicate | None = None
    skip_if: Predicate | None = None
    parent_item_key: str | None = None
    retry_text: str | None = None
    why_text: str | None = None
    options: list[QuestionPackOption] = Field(default_factory=list)

    @field_validator("question_key")
    @classmethod
    def _question_key_slug(cls, v: str) -> str:
        return _validate_slug(v, "question_key")


class QuestionPack(BaseModel):
    """A resolved pack at a PINNED version — version-scoped and therefore immutable by
    construction. Immutability IS the cache invalidation."""

    pack_id: str = Field(min_length=1)
    version: PositiveInt
    family_id: str = Field(pattern=r"^fam_[a-z0-9_]+$")
    locale: str = Field(min_length=2, max_length=8)
    status: QuestionPackStatus
    content_hash: str = Field(min_length=1)
    items: list[QuestionPackItem] = Field(default_factory=list)


class TranscriptLine(BaseModel):
    """One line of the indexed evidence store. `i` is what evidence spans point at."""

    i: AskCount
    role: Literal["worker", "assistant"]
    text: str


class TargetField(BaseModel):
    """A field the parse call may fill. Anything outside this closed list is dropped."""

    field_id: str
    type: str = Field(min_length=1)
    enum: list[str] | None = None
    unit: str | None = None
    required: bool = False

    @field_validator("field_id")
    @classmethod
    def _field_id_slug(cls, v: str) -> str:
        return _validate_slug(v, "field_id")


class ProfileParseInput(BaseModel):
    """THE one LLM call's request. The framing is the enforcement: `answer_map` is the
    record, `transcript` is the evidence store. The model is never asked what the
    worker's salary is — it is asked to type and cite the answer the map already holds."""

    schema_version: Literal["oie.v1"] = "oie.v1"
    worker_ref: str = Field(min_length=1)
    language: str | None = None
    occupation: OccupationPin | None = None
    answer_map: list[AnswerRecord] = Field(default_factory=list)
    transcript: list[TranscriptLine] = Field(default_factory=list)
    target_fields: list[TargetField] = Field(default_factory=list)


ParseNormalization = Literal["verbatim", "spelling", "translit", "unit", "enum", "numeric"]


class ParsedField(BaseModel):
    """One parsed field. `evidence` is MANDATORY — a value with no span cannot even be
    REPRESENTED, which is a stronger guarantee than rejecting it downstream."""

    value: Any
    evidence: EvidenceSpan
    source: Literal["answer_map", "transcript"]
    normalization: ParseNormalization
    confidence: float = Field(ge=0, le=1)


class ProfileParseOutput(BaseModel):
    fields: dict[str, ParsedField | None] = Field(default_factory=dict)
    unparsed_field_ids: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    # Cost + latency for the call this response came from.
    #
    # THE PHASE 8 CUTOVER MADE THIS THE ONLY LLM CALL IN THE WHOLE INTERVIEW — every
    # per-turn model call was deleted and replaced by one parse at the end. It shipped
    # returning no metadata, so the single remaining piece of model spend in the core
    # flow was invisible to the ledger. ``/profile/extract`` and the profiling chat have
    # carried ``ai_metadata`` since Phase 1; this closes the gap the cutover opened.
    #
    # ``None`` on every degraded path (deadline, mock posture, spend cap): a fabricated
    # zero-cost record is worse than an absent one, being indistinguishable from a real
    # call that happened to be free. PII-free — ids, model names, counts, an INR estimate.
    ai_metadata: AICallMetadata | None = None


# --- The LLM-led interview (Phase A) and its whole-chat extraction (Phase C) --
#
# Mirrors `packages/ai-contracts/src/oie.ts`. The packs ask what was authored, and authoring
# cannot cover every trade: a worker who said "cook hu" was offered
# [Pizza maker | यात्रा सेवा | khana | खाद्य प्रसंस्करण] and fell through to the generic pack.
# The model conducts the stretch that cannot be authored; the API keeps the rest and takes the
# turn back the moment the model is unavailable.


class ExperienceEntry(BaseModel):
    """ONE job a worker has held.

    ``extra="forbid"`` IS THE ENFORCEMENT, mirroring the TS ``.strict()``. §2 forbids storing
    employer names and ``FIELD_CROSSWALK`` parks ``work_history`` at ``draftPath: None`` for
    that reason. A prompt rule is a request; a forbidding schema makes ``employer_name`` fail
    at the boundary, before it can reach a column. Model output is untrusted input (§11).

    ``duration_months`` is optional because "kuch saal" is a real answer, and inventing 24 from
    it would be exactly the fabrication the parse gates exist to stop.
    """

    model_config = ConfigDict(extra="forbid")

    role_label: str = Field(min_length=1, max_length=120)
    duration_text: str = Field(default="", max_length=120)
    duration_months: int | None = Field(default=None, ge=0, le=720)
    work_done: str = Field(default="", max_length=600)


class LlmInterviewDraft(BaseModel):
    """What the model has gathered so far, echoed back each turn so the call stays stateless."""

    domain_label: str | None = None
    role_label: str | None = None
    skills: list[str] = Field(default_factory=list)
    experiences: list[ExperienceEntry] = Field(default_factory=list)


class LlmTurnInput(BaseModel):
    schema_version: Literal["oie.v1"] = "oie.v1"
    worker_ref: str = Field(min_length=1)
    language: str | None = None
    stage: LlmInterviewStage = "domain"
    message_text: str = ""
    history: list[TranscriptLine] = Field(default_factory=list)
    draft: LlmInterviewDraft = Field(default_factory=LlmInterviewDraft)
    experience_count: int = Field(default=0, ge=0)
    # The model's LAST allowed question: ask the most valuable one left, then stop. The cap is
    # API-authoritative because the API owns the session state — this service holds none and
    # could not count turns even if it were trusted to. A cap that has already fired never
    # reaches here: the API ends Phase A without calling, so a runaway costs nothing.
    force_close: bool = False


class LlmTurnOutput(BaseModel):
    reply_text: str = ""
    stage: LlmInterviewStage = "domain"
    input_mode: InputMode = "text"
    suggested_answers: list[str] = Field(default_factory=list, max_length=4)
    # A LABEL, never a job_domain_id. A model that could hand us an id could hand us one that
    # does not exist, or one that exists and is wrong — both would persist as though retrieval
    # had agreed. The catalogue decides what this resolves to.
    domain_label: str | None = None
    role_label: str | None = None
    skills: list[str] = Field(default_factory=list)
    experience_entry: ExperienceEntry | None = None
    # ADVISORY ONLY. The API's caps decide when Phase A ends.
    phase_a_done: bool = False
    blocked: bool = False
    blocked_reason: str | None = None
    is_mock: bool = True
    ai_metadata: AICallMetadata | None = None


class InterviewExtractInput(BaseModel):
    schema_version: Literal["oie.v1"] = "oie.v1"
    worker_ref: str = Field(min_length=1)
    language: str | None = None
    transcript: list[TranscriptLine] = Field(default_factory=list)
    occupation: OccupationPin | None = None


class InterviewExtractOutput(BaseModel):
    domain_label: str | None = None
    role_label: str | None = None
    skills: list[str] = Field(default_factory=list)
    experiences: list[ExperienceEntry] = Field(default_factory=list)
    shift: str | None = None
    current_city: str | None = None
    preferred_locations: list[str] = Field(default_factory=list)
    availability: str | None = None
    expected_salary: float | None = None
    blocked: bool = False
    is_mock: bool = True
    ai_metadata: AICallMetadata | None = None


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
            if len(topic) > 40:
                raise ValueError(f"topic_id '{topic}' exceeds 40 character limit")
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

    # --- Generalized profiling (the LLM-driven interview) -------------------
    # ADDITIVE + defaulted => backward compatible, and mirrored in
    # @badabhai/ai-contracts ConversationStateSchema.
    #
    # `captured` is the Resume Field Set as filled so far: {field_id: short value}.
    # It REPLACES `collected` as the thing that matters, and it is what makes "never
    # ask what has already been answered" work without a deterministic engine — the
    # endpoint feeds it back to the model every turn. Keys are the closed RFS
    # vocabulary (PROFILING_REQUIRED_FIELDS + PROFILING_OPTIONAL_FIELDS); anything
    # else the model invents is dropped before it ever lands here.
    #
    # PRIVACY: profile signals only, exactly like `collected` beside it. There is no
    # RFS field for name, phone, address, employer or any ID, the persona forbids
    # asking for them, and pseudonymize blocks them upstream — so this dict has
    # nowhere to put identity PII even if a worker volunteered some.
    captured: dict[str, str] = Field(default_factory=dict)
    # WHY the interview ended, for observability. Never model-supplied — the endpoint
    # assigns it, because the model does not get to decide that it is finished.
    completion_reason: str | None = None

    # --- Occupation Intelligence Engine (the deterministic interview) --------
    # ADDITIVE + defaulted => backward compatible; part of the Phase 0 contract freeze
    # and mirrored in @badabhai/ai-contracts ConversationStateSchema. `captured` above
    # STAYS POPULATED as a flattened projection of `answer_map`, so anything still
    # reading it keeps working. Every field here must ALSO be added to
    # ChatTranscriptBuffer.narrow() on the api side, which silently drops unknown keys.
    phase: ProfilingPhase = "identify"
    occupation: OccupationPin | None = None
    # THE record. `captured` is a projection of this; the parse call reads this.
    answer_map: list[AnswerRecord] = Field(default_factory=list)
    # Engine-driven ASKS (not turns) — the MAX_ENGINE_ASKS budget's counter; clarifies
    # and re-serves consume turns, not asks, mirroring interview_engine.py.
    engine_asks: AskCount = 0
    # The pack pinned with the occupation — IMMUTABLE for the conversation (risk #13).
    # Duplicated from `occupation` deliberately: a repin replaces `occupation`, but the
    # already-answered questions keep pointing at the pack that asked them.
    pack_id: str | None = None
    pack_version: PositiveInt | None = None
    # Catalogue release retrieval ran against; pins alias resolution mid-flight.
    catalog_version: str | None = None


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
    # The API's turn cap fired. The model is still called (ONE code path), but it is
    # told to close rather than ask, and completion is forced on the way out whatever
    # comes back. The cap is API-authoritative on purpose: a model must never be able
    # to extend its own interview, and the ai-service holds no per-session state to
    # count turns with.
    force_complete: bool = False


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


class ResumeProfile(BaseModel):
    """The LLM-led interview's Phase C object, stored as the model produced it.

    The résumé's ONLY input. ``DraftProfile`` below is a storage shape inherited from the
    deterministic pack era — flat model values arrive and get scattered into
    ``salary_expectation{}`` / ``location_preference{}`` / ``availability{}`` beside eight
    taxonomy fields the LLM path never fills — and every reassembly step was a place a value
    could be dropped or outvoted. Four of nine keys were being discarded that way before #812.

    THE RULE IS: NO MERGE, NO PRECEDENCE, NO DERIVATION. These keys are the Phase C response
    one-for-one, so a reader can diff this against the Langfuse assistant message and expect
    equality. Anything that "improves" a value on the way in destroys that property.

    DELIBERATELY NARROWER THAN THE ANSWER MAP (fifteen crosswalk fields vs these nine).
    Education, certifications, languages, tools and relocation stay on ``DraftProfile`` and are
    not rendered from here — an accepted, temporary loss (owner decision 2026-08-12) while the
    pipeline is proven end-to-end on a narrow field set.

    NEVER used for matching or ranking: this is free text a model wrote (§3).

    Mirrors ResumeProfileSchema in packages/ai-contracts/src/profile.ts (§7 parity).
    """

    domain_label: str | None = None
    role_label: str | None = None
    skills: list[str] = Field(default_factory=list)
    experiences: list[ExperienceEntry] = Field(default_factory=list)
    shift: str | None = None
    current_city: str | None = None
    preferred_locations: list[str] = Field(default_factory=list)
    # The MODEL's vocabulary, kept verbatim — ``Availability.status`` uses a different closed
    # set and translating here would break the diff-against-the-trace property. The renderer
    # humanises it at the edge, which is where a presentation concern belongs.
    availability: str | None = None
    # `ge=0` matches the TypeScript mirror's `z.number().nonnegative()`
    # (packages/ai-contracts/src/profile.ts ResumeProfileSchema.expected_salary) — a
    # negative value fails closed at validation, before it can ever reach the résumé's
    # ":.0f" print statement. No upper bound: the TS side has none either.
    expected_salary: float | None = Field(default=None, ge=0)


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
    # #499 — education + certifications, carried from the rich WorkerProfileDraft so
    # the résumé (resume_text + rendered PDF) can show them. Both are ALWAYS asked
    # (MUST_ASK_TOPICS) and captured on the rich draft, but were dropped at the
    # rich→legacy boundary (_build_legacy), leaving the templates' section empty.
    # Additive (default [] → old rows unchanged, invariant #8). Mirrors the Zod
    # DraftProfileSchema in packages/ai-contracts/src/profile.ts (§7 parity).
    education: list[str] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)
    # TD-EDU — highest education LEVEL ("12th") + FIELD of study ("Electronics"),
    # asked as two dedicated interview topics and carried from the rich draft so the
    # résumé (rendered PDF) + the worker's resume tab can show them. NOT PII (same
    # class as `education`). Additive (default None → old rows unchanged, invariant
    # #8). Mirrors DraftProfileSchema in packages/ai-contracts (§7 parity).
    education_level: str | None = None
    education_field: str | None = None
    experience: Experience = Field(default_factory=Experience)
    # ── THE THREE PHASE C KEYS THAT HAD NOWHERE TO LAND ──────────────────────────
    # `InterviewExtractOutput` returns nine data keys and extract_system_prompt asks
    # for all nine by name; only five had a destination on this model. The processor's
    # merge read these three ZERO times, so they were prompted for, billed for,
    # validated, sent — and dropped. Additive (default None → old rows unchanged,
    # invariant #8); `raw_profile` is jsonb, so no migration. Mirrors
    # DraftProfileSchema in packages/ai-contracts/src/profile.ts (§7 parity), where
    # the length bounds that keep model output from writing unbounded text live.
    domain_label: str | None = None
    role_label: str | None = None
    shift: str | None = None
    salary_expectation: SalaryExpectation = Field(default_factory=SalaryExpectation)
    location_preference: LocationPreference = Field(default_factory=LocationPreference)
    availability: Availability = Field(default_factory=Availability)
    confidence: float | None = None
    # THE RÉSUMÉ CONTAINER, CARRIED INSIDE THIS ONE. Nested rather than given its own column:
    # `raw_profile` is jsonb, so this costs no migration and no production column (§10), and it
    # rides to the résumé for free because `resumes.source_profile_snapshot` already snapshots
    # the whole DraftProfile. None is the honest value for every profile written before this and
    # for every deterministic-only extraction — the renderer reads None as "use the old path",
    # which keeps existing résumés rendering unchanged (invariant #8).
    resume_profile: ResumeProfile | None = None


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
    # TD-EDU — highest education LEVEL + FIELD of study (see DraftProfile). The model
    # fills these from the transcript; carried onto the legacy DraftProfile in main.py.
    education_level: str | None = None
    education_field: str | None = None
    confidence_score: float = 0.0
    missing_fields: list[str] = Field(default_factory=list)
    clarification_questions: list[str] = Field(default_factory=list)
    # Advisory adjacency flag: set (e.g. "outside_cnc_vmc_scope") when the profile
    # canonicalizes to nothing matchable in the CNC/VMC taxonomy, so it is marked
    # adjacent rather than silently half-empty. Additive (default None). Advisory
    # ONLY — never used to rank/reject a worker. Mirrors the Zod contract.
    unmatchable_reason: str | None = None


# --- Skill canonicalization (ADR-0030 / TAX-4) -----------------------------
def exactly_one_skill_scope(domain_id: str | None, job_domain_id: str | None) -> bool:
    """The Phase 1.5 scope rule, in ONE place so the two validators below (and
    ``app.ai.canonicalize``'s defence-in-depth guard) can never drift apart.

    PRESENCE, not truthiness: ``domain_id=""`` counts as SUPPLIED. That is deliberate —
    an empty slug scopes the search to a domain that owns no aliases (zero rows →
    UNRESOLVED), which is safe, whereas treating it as absent would 422 a caller whose
    behaviour is unchanged today. The rule that matters is that *neither* id is refused."""
    return (domain_id is None) != (job_domain_id is None)


_SKILL_SCOPE_ERROR = (
    "exactly one of domain_id (legacy skill-domain slug) or "
    "job_domain_id (canonical jd_*) is required"
)


class SkillCanonicalizationInput(BaseModel):
    """One skill phrase to canonicalize within EXACTLY ONE domain scope. ``phrase`` is a
    skill LABEL the extraction proposed; it is pseudonymized before the embed regardless
    (SG-2). Mirrors ``SkillCanonicalizationInputSchema`` in ai-contracts.

    TWO ID SPACES, EXACTLY ONE PER REQUEST (Phase 1.5 canonicalizer cutover).
    ``domain_id`` is the LEGACY 11-slug skill domain ("cnc-machining") denormalized onto
    ``skill_alias.domain_id`` — migration 0076 made that column NULLABLE, so a canonical
    skill minted by the taxonomy bootstrap carries no slug and is INVISIBLE to a
    ``WHERE domain_id = $1`` scan. ``job_domain_id`` is the canonical ``jd_*`` id and
    resolves candidates through ``job_domain_skill`` instead.

    NEITHER IS A REJECT, NOT A WILDCARD. Making both optional without this rule would let
    "no domain" degrade into "search the entire skill vocabulary" and a cook would be
    offered lathe skills. Both is also a reject — two scopes have no defined precedence.
    """

    phrase: str
    # LEGACY 11-slug skill domain. Optional as of Phase 1.5; still fully supported and
    # still the only path that reads `skill_alias.domain_id`.
    domain_id: str | None = None
    # CANONICAL `jd_*` job domain — candidates come from `job_domain_skill`.
    #
    # `validate_default=True` so the field validator below RUNS when the caller omits the
    # field, which is exactly the "neither supplied" case it exists to catch.
    job_domain_id: str | None = Field(default=None, validate_default=True)
    lang: str = "en"

    @field_validator("job_domain_id")
    @classmethod
    def _scope_rule_without_echoing_the_phrase(
        cls, value: str | None, info: ValidationInfo
    ) -> str | None:
        """THE SAME RULE AS THE MODEL VALIDATOR BELOW, LOCATED ON A FIELD ON PURPOSE — this
        is a PII control, not a duplicate.

        MEASURED (pydantic 2.13.4 / fastapi 0.139.2): a ``ValueError`` raised from a
        ``model_validator(mode="after")`` is reported with ``input`` = the whole model
        input, and FastAPI's 422 body is ``{"detail": exc.errors()}`` — so a scope-less
        request came back as
        ``{"type":"value_error","loc":["body"],...,"input":{"phrase":"call me on 9876543210"}}``,
        echoing the RAW phrase. Raised from THIS field, the same rejection reports
        ``loc:["body","job_domain_id"]`` and ``input: null`` — the phrase never appears.
        A field validator runs BEFORE the model validator, so this is the error a caller
        actually receives.

        Order-dependent (it reads ``domain_id`` out of ``info.data``, which requires
        ``domain_id`` to be DECLARED FIRST). That dependency fails LOUDLY, not silently:
        reorder the fields and the legacy ``domain_id``-only tests reject and go red.
        """
        if not exactly_one_skill_scope(info.data.get("domain_id"), value):
            raise ValueError(_SKILL_SCOPE_ERROR)
        return value

    @model_validator(mode="after")
    def _exactly_one_domain_scope(self) -> SkillCanonicalizationInput:
        """The authoritative, order-independent form of the rule (the field validator
        above is the same check, sited where its error cannot echo the phrase). Kept so
        the invariant survives a field reorder or a direct ``model_construct``-adjacent
        edit — never remove one without the other."""
        if not exactly_one_skill_scope(self.domain_id, self.job_domain_id):
            raise ValueError(_SKILL_SCOPE_ERROR)
        return self


class SkillCanonicalization(BaseModel):
    """Canonicalization outcome: either an ASSIGNED ``skill_id`` (top match >= floor) or
    UNRESOLVED. Carries NO PII. SG-3 / LLM-never-invents: ``skill_id`` is None unless the
    vector layer assigned it. Mirrors ``SkillCanonicalizationSchema`` in ai-contracts."""

    status: Literal["matched", "unresolved"]
    skill_id: str | None = None
    score: float | None = None
    # #745: THE EMBED IS A PAID PROVIDER CALL AND HAD NO WAY HOME.
    #
    # This is the exact root cause #738 fixed for STT, on a second surface: the response
    # contract carried no cost field, so no emitter could exist in apps/api even if someone
    # wrote one, and `SELECT ... WHERE task_type = 'skill_embedding'` returned empty — which
    # reads as "no spend" rather than "not instrumented". Additive + defaulted, so every
    # existing caller and stored payload stays valid (the §3 discipline #738 used).
    #
    # None on every path that did NOT reach a provider: the flag being off, a spend-ledger
    # block, and a pseudonymize block. `AiCostRecorder.record` no-ops on None, so the caller
    # never has to branch, and a mocked environment never writes fictional money.
    ai_metadata: AICallMetadata | None = None


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
    """One extraction request. Mirrors ``ProfileExtractionInputSchema`` in ai-contracts.

    ``job_domain_id`` IS THE S3-C READ SWITCH FOR THIS CALLER, and it is a request field
    rather than a flag because that is what the switch is: ``phase-9-s3-deployment-plan.md``
    defines it as *which field the caller populates* — ``job_domain_id`` selects Path A
    (candidates through ``job_domain_skill``), its absence leaves Path B (the legacy
    ``skill_alias.domain_id`` slug). There is no feature flag to add here; a caller that
    sends nothing gets byte-identical behaviour, which is what every caller does today.

    Scoped to the canonicalization pass ONLY. It does not pin, seed or override the
    ``DOMAIN_MATCH_ENABLED`` RAG classification further down ``/profile/extract`` — that
    pass decides the worker's trade and must not be handed its own answer.
    """

    worker_ref: str | None = None
    language: str | None = None
    transcript: str | None = None
    messages: list[ConversationMessage] | None = None
    role_family: str = "cnc_vmc"  # Phase-1 addition (optional → backward compatible)
    # BOUNDED to match the Zod mirror and every other scope id on the wire
    # (`NearestAliasesDtoSchema`, `RecordUnresolvedDtoSchema`). `min_length=1` matters more
    # than it looks: `exactly_one_skill_scope` tests PRESENCE, so an empty string would count
    # as a supplied canonical scope, quietly scope Path A to a domain that owns nothing, and
    # file every resulting miss under `job_domain_id = ''`.
    job_domain_id: str | None = Field(default=None, min_length=1, max_length=64)


#: The closed match-status vocabulary. A `Literal`, not a bare `str`, and that matters:
#: every OTHER closed set in this file is a Literal, the Zod mirror is a `z.enum`, and
#: the same five strings are a CHECK constraint on `worker_profiles`. Left open, an
#: out-of-set code would sail through Pydantic and Zod and only fail at the INSERT — at
#: the end of a long async pipeline, one worker at a time, discarding that extraction.
JobDomainMatchStatus = Literal[
    "matched_auto",
    "matched_llm",
    "unmatched_below_floor",
    "unmatched_llm_declined",
    "unmatched_degraded",
]


class JobDomainMatch(BaseModel):
    """The RAG job-domain classification (generalized profiling).

    ADDITIVE + fully defaulted, so a caller that predates it is unaffected and the whole
    feature stays inert behind ``DOMAIN_MATCH_ENABLED``. Mirrored in
    ``@badabhai/ai-contracts`` ``JobDomainMatchSchema``.

    ``status`` is the SAME closed vocabulary as the ``job_domain_match_status`` CHECK on
    ``worker_profiles``, so an unmatched profile records WHY — below the floor, the model
    declined, or the pass degraded — instead of looking identical to one never attempted.

    ``score`` is the RETRIEVAL cosine similarity, never the model's self-reported
    confidence: one is measured, the other asserted, and only the measured one belongs in
    a column that later analysis will threshold on.

    PII-FREE: a catalog id, a closed-set status, a float, and the shortlist of ids that
    were considered. No worker text, ever.
    """

    status: JobDomainMatchStatus = "unmatched_degraded"
    job_domain_id: str | None = None
    score: float | None = None
    considered: list[str] = Field(default_factory=list)


class ProfileExtractionOutput(BaseModel):
    profile: DraftProfile
    blocked: bool = False
    blocked_reason: str | None = None
    is_mock: bool = True
    # Phase-1 additions (optional → backward compatible):
    extraction_status: Literal["completed", "blocked"] = "completed"
    worker_profile_draft: WorkerProfileDraft | None = None
    ai_metadata: AICallMetadata | None = None
    # #745: THE EMBEDS THE CANONICALIZATION PASS PAID FOR — one entry per embed, not one
    # per extraction.
    #
    # `ai_metadata` above is the EXTRACTION call and nothing else. The TAX-4 pass that runs
    # after it is a SECOND set of billable provider calls (one embed per skill label), and
    # they had no way home: `canonicalize_labels` returned ids and unresolved labels only.
    # The first cut of #745 wired `/skills/canonicalize` — the job-posting side — and left
    # this one, which meant `WHERE task_type = 'skill_embedding'` returned SOME rows. Empty
    # reads as "not instrumented"; partial reads as complete, and is worse. The coverage
    # guard in apps/api is keyed by TASK TYPE, so wiring either path deletes the entry that
    # names both — which is exactly how one path stayed dark.
    #
    # A LIST, not a single record, because the count is the whole point: a 10-label pass is
    # 10 billable embeds and a per-pass record would under-report it tenfold. EMPTY on every
    # path that reached no provider — the flag off, a spend-ledger block, a blocked
    # extraction — which is distinct from `[]` meaning "free": nothing was attempted at all.
    # Additive + defaulted, so a caller that predates it is unaffected (§3).
    skill_embedding_metadata: list[AICallMetadata] = Field(default_factory=list)
    # Generalized profiling: the RAG domain match. `None` = the pass did not run at all
    # (flag off, or a blocked extraction), which is DISTINCT from a match that ran and
    # came back unmatched — the caller writes nothing in the first case and records the
    # reason in the second.
    job_domain_match: JobDomainMatch | None = None
    # Why this extraction is degraded, when it is — the field that lets apps/api tell an
    # ai-service OUTAGE from a worker who genuinely said nothing. Both arrive as
    # `blocked: false` with an empty profile, and `is_mock` cannot separate them (it is
    # `not real_call`, so a healthy mock extraction sets it too). Additive and defaulted,
    # so an older caller is unaffected. Mirrors `TranscriptionOutput.error_code`.
    error_code: str | None = None


# --- Resume generation -----------------------------------------------------
class ResumeGenerationInput(BaseModel):
    profile: DraftProfile
    language: str | None = None
    # Opaque worker ref (PII-free) → attributes resume spend to the per-user daily
    # cap, so resume + chat + extraction share one Rs 6/user/day budget. Optional →
    # backward compatible.
    worker_ref: str | None = None


class ResumeGenerationOutput(BaseModel):
    # THE DETERMINISTIC `Label: value` TEMPLATE, on every path (#909). `build_resume` is the
    # only thing that produces it, and the worker app parses it to render the sectioned résumé
    # — so this field is a CONTRACT ABOUT SHAPE, not merely "some résumé text". The LLM's prose
    # goes to `summary` below; it must never replace this.
    resume_text: str
    resume_json: dict = Field(default_factory=dict)
    format: Literal["text", "json"] = "text"
    is_mock: bool = True
    # The model's 2-4 sentence blurb, or None when no provider was called (mock posture, a
    # pseudonymize block, a cap). ADDITIVE and optional: nothing renders it yet, and the
    # sectioned résumé does not depend on it.
    summary: str | None = None
    # #745: `router.run` has always produced this metadata here — the route simply dropped
    # it on the floor, so resume spend reached no ledger. Same additive/defaulted shape as
    # the STT fix (#738). None on the pseudonymize-blocked path, where the route completes
    # from the LOCAL deterministic resume and no provider is called.
    ai_metadata: AICallMetadata | None = None


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
    # WHY a degraded result has to SAY SO on the wire.
    #
    # `SttAdapter.transcribe` already distinguishes "the worker said nothing" from
    # "we refused to call the provider" (``stt_budget_blocked``) and "the provider
    # call failed" (``stt_call_failed``). Until this field existed, that distinction
    # was LOGGED here and then thrown away at the response boundary — so the backend
    # received an empty transcript with no way to tell the three apart, wrote it, and
    # marked the job completed. In chat that degrades a reply. In a voice-only form
    # the worker speaks their answer and it vanishes behind a success.
    #
    # PII-FREE and CLOSED-SET by construction: these are adapter-authored codes, never
    # provider text and never worker text. Additive + defaulted, so an older backend
    # ignoring it is unaffected (§3).
    error_code: str | None = None
    # WHAT THIS CALL COST, so that something durable can record it (#738).
    #
    # Until this field existed the backend could not price a transcription even in
    # principle: `recordAiCost` lives on the profile-extraction path, nothing on the
    # transcription path could reach it, and this contract carried no number for it to
    # emit. The only thing bounding STT spend was `SpendLedger` — a Redis counter whose
    # keys expire ~25h after the day they describe — so the spend was capped and then
    # forgotten. `aiTaskType` already listed `stt_transcription`, which made a query for
    # STT cost return empty and read as "no spend" rather than "not instrumented".
    #
    # PII-FREE: ids, a model name, an int count, rupees, a closed-set reason code — the
    # same object `/profile/parse` already returns, and it is never given worker text.
    # `None` on the mock path costs nothing to ignore; additive + defaulted (§3).
    ai_metadata: AICallMetadata | None = None
    # HOW MANY SPOKEN PHONE NUMBERS WERE REMOVED FROM `transcript_text` (#747 leg (a)).
    #
    # A COUNT, DELIBERATELY, AND NEVER THE DIGITS. The whole purpose of the redaction is to
    # keep that number out of storage, logs, events and the LLM boundary; a field carrying
    # "what was removed" would hand it straight back to every one of them. `> 0` answers the
    # only questions worth asking — is the gate firing, and how often — and it is exactly the
    # number V8's ASR PII measurement is looking for.
    #
    # `pseudonymize.py` cannot see this class: it masks a phone by SHAPE (9-13 digits) and a
    # spoken number carries no digit characters at all. Devanagari NUMERALS are already
    # covered there, measured rather than assumed.
    spoken_digit_redactions: int = 0


# --- Job-posting chat (ADR-0035) -------------------------------------------
# The payer-facing sibling of the profiling contracts above. Mirrored field-for-field
# in packages/ai-contracts/src/job-posting.ts and pinned by the shared golden fixture
# packages/ai-contracts/src/__fixtures__/job-posting-chat.keys.json, which BOTH
# suites assert against (§7 parity — Pydantic silently drops unknown request keys,
# so a one-sided change is otherwise green on both sides).

# The five shipped vacancy bands (ADR-0012), verbatim from packages/types
# VACANCY_BANDS. A posting is BANDED, never a head count.
VacancyBand = Literal["1", "2-5", "6-10", "11-25", "25+"]
# The closed jobs.shift enum (packages/db schema.ts jobs_shift_chk).
JobShift = Literal["day", "night", "rotational"]

# Caps mirror apps/api/src/job-postings/job-postings.dto.ts so a draft this service
# emits can never be one the publish DTO would reject.
_JP_LABEL_MAX = 200
_JP_DESCRIPTION_MAX = 2000
JobPostingSkillPhrase = Annotated[str, Field(min_length=1, max_length=80)]


class JobPostingChatState(BaseModel):
    """Server-computed job-posting interview progress.

    Mirrors :class:`ConversationState`'s shape. Holds POSTING signals only (role
    title, city, band, pay figures) — never payer identity, and never the payer's
    organisation name, which this chat does not ask for and never receives
    (ADR-0035 §Decision 3).
    """

    # Reserved trade seam. The job-posting bank is deliberately NOT split by trade
    # (the questions are identical across trades — see question_bank.py), so this is
    # carried and passed to `topics_for()` but does not branch today. Present so a
    # future trade-specific bank needs no contract change.
    trade_hint: str | None = None
    turn_count: int = 0
    answered_topics: list[str] = Field(default_factory=list)
    asked_question_ids: list[str] = Field(default_factory=list)
    collected: dict = Field(default_factory=dict)
    # Max CONSECUTIVE clarify re-serves of the same question (bounded at 2 by the
    # engine; every next_turn resets it).
    clarify_count: int = 0
    # Per-topic ASK count. `asked_question_ids` is a dedup set and cannot count, so
    # the bounded re-ask needs its own counter. Topic ids only — no PII.
    ask_counts: dict[str, AskCount] = Field(default_factory=dict)
    # ESSENTIAL topics the payer never actually answered, in ESSENTIAL_TOPICS order.
    # Empty = complete. THIS, not `draft_ready`, is how an incomplete draft is
    # declared. Topic ids only — no PII.
    unanswered_essentials: list[str] = Field(default_factory=list)

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
            if len(topic) > 40:
                raise ValueError(f"topic_id '{topic}' exceeds 40 character limit")
        return v


class JobPostingDraft(BaseModel):
    """The chat's in-progress job posting — the rich-draft precedent set by
    :class:`WorkerProfileDraft`, pointed at the demand side.

    THERE IS DELIBERATELY NO ``org_label`` FIELD, and adding one is a defect
    (ADR-0035 §Decision 3). ``PayerCreateJobPostingSchema`` requires ``org_label``,
    but the value is already known server-side on ``payers.orgNameEnc`` and is
    decrypted + stamped onto the create call by the NestJS publish step — the same
    post-hoc interpolation AI-PERSONA-2 uses for a worker's name. The chat never
    asks for it, so it never enters a payer message, this draft, conversation state,
    an event payload, or LLM input. Asking would both duplicate data we hold and
    invite a payer to type personal contact details next to it.

    Free-text fields carry the payer's own business copy. When a turn's
    pseudonymization masked an IDENTITY-class entity (phone/person/employer/id) the
    MASKED text is stored instead (answers.safe_draft_text), so a personal phone
    number typed into a description cannot reach the stored draft or a published
    posting; ``clarification_questions`` then asks the payer to retype that field.
    """

    role_title: str | None = Field(default=None, max_length=_JP_LABEL_MAX)
    # <= 10 phrases of <= 80 chars — the exact `skillsInput` cap in the publish DTO.
    skills: list[JobPostingSkillPhrase] = Field(default_factory=list, max_length=10)
    location_label: str | None = Field(default=None, max_length=_JP_LABEL_MAX)
    # BANDED, never an integer (ADR-0012). Derived from any count the payer gives via
    # answers.band_for_count (the Python mirror of validators' bandForCount).
    vacancy_band: VacancyBand | None = None
    # Monthly pay in whole rupees. Shapes match jobs.pay_min / jobs.pay_max.
    pay_min: int | None = Field(default=None, ge=0)
    pay_max: int | None = Field(default=None, ge=0)
    shift: JobShift | None = None
    benefits: list[str] = Field(default_factory=list)
    requirements: list[str] = Field(default_factory=list)
    description: str | None = Field(default=None, max_length=_JP_DESCRIPTION_MAX)
    # DETERMINISTIC coverage ratio (topics with a value / topics in the bank), NOT a
    # model score and never an input to ranking or a publish decision (invariant #4).
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    # Topic ids still without a value, in bank order. `vacancy` maps to
    # `vacancy_band`, `pay_range` to `pay_min`/`pay_max`; every other id is the
    # draft field name. Ids only — never the values.
    missing_fields: list[str] = Field(default_factory=list)
    clarification_questions: list[str] = Field(default_factory=list)


class JobPostingChatOpeningInput(BaseModel):
    trade_hint: str | None = None


class JobPostingChatOpeningOutput(BaseModel):
    """The opening line. Deliberately just the string — a deterministic template, no
    model call, nothing pseudonymized, and no payer/org identity of any kind, which
    is what keeps this endpoint PII-free by construction."""

    opening_text: str


class JobPostingChatTurnInput(BaseModel):
    """One payer turn. Mirrors :class:`ProfilingTurnInput` with one deliberate
    omission: there is NO ``history`` field. The profiling input keeps one for caller
    compatibility and then ignores it (COST-3 — the chat turn is stateless because
    the engine already chose the question locally). A new contract does not need to
    inherit that dead weight, and omitting it makes re-sending a transcript
    impossible rather than merely discouraged."""

    session_id: str = Field(min_length=1)
    # OPAQUE payer reference for per-caller spend attribution — never a raw payer
    # identity, never the organisation name.
    payer_ref: str | None = None
    language: str | None = None
    message_text: str = Field(min_length=1)
    trade_hint: str | None = None
    conversation_state: JobPostingChatState | None = None
    # Reserved for the rephrase seam (see prompts.py). No LLM call is made on this
    # route today, so this is inert; it is part of the frozen contract so turning the
    # seam on later is not a contract change.
    real_call_allowed: bool = True


class JobPostingChatTurnOutput(BaseModel):
    """One engine turn. Mirrors :class:`ProfilingTurnOutput`.

    ``suggested_answers`` is the profiling ``suggested_followups`` field under an
    honest name: that field's own docstring states it carries ANSWERS to the question
    just asked, never follow-up questions, because a tapped chip is sent verbatim as
    the payer's message. A new contract with two client teams building against it
    gets the accurate name.

    ``draft``/``updated_state`` are nullable and are BOTH null on a blocked turn —
    nothing was parsed, so the caller keeps whatever it had stored.
    """

    reply_text: str
    blocked: bool = False
    blocked_reason: str | None = None
    suggested_answers: list[str] = Field(default_factory=list)
    is_mock: bool = True
    asked_question_id: str | None = None
    # The interview is complete: every essential answered and every must-ask topic
    # raised. The publish step still re-validates against PayerCreateJobPostingSchema.
    draft_ready: bool = False
    draft: JobPostingDraft | None = None
    updated_state: JobPostingChatState | None = None
    # Always null today (no model is called on this route — see prompts.py); part of
    # the frozen contract for the rephrase seam.
    ai_metadata: AICallMetadata | None = None
    pseudonymization_metadata: PseudonymizationMeta | None = None
