"""FastAPI AI service.

Endpoints: /health, /pseudonymize, /profiling/respond, /profile/extract,
/resume/generate.

INVARIANT: pseudonymization runs BEFORE any external LLM path on every endpoint
that could reach an LLM. If pseudonymization is blocked, the LLM is never called
and a safe fallback is returned (fail closed). Model routing, cost tracking, and
Langfuse tracing all live behind ``app.ai.router.AIRouter``.
"""

from __future__ import annotations

import json

from fastapi import FastAPI

from .ai import cost_tracker
from .ai.router import AIRouter
from .config import get_settings
from .contracts import (
    DraftProfile,
    ProfileExtractionInput,
    ProfileExtractionOutput,
    ProfilingTurnInput,
    ProfilingTurnOutput,
    PseudonymizationInput,
    PseudonymizationMeta,
    PseudonymizationOutput,
    ResumeGenerationInput,
    ResumeGenerationOutput,
    TranscriptionInput,
    TranscriptionOutput,
    WorkerProfileDraft,
)
from .extraction import build_resume
from .logging_config import configure_logging, get_logger
from .profiling import interview_engine, profile_extractor
from .profiling.canonical_roles import (
    ROLE_TRADE,
    canonicalization_instruction,
    extract_canonical_role_id,
    normalize_role_id,
)
from .profiling.prompts import (
    EXTRACTION_SYSTEM_PROMPT,
    RESUME_SYSTEM_PROMPT,
    build_chat_messages,
)
from .pseudonymize import PseudonymizationResult, pseudonymize
from .stt import SttAdapter
from .translate import TranslateAdapter

configure_logging()
logger = get_logger("ai-service")
settings = get_settings()
router = AIRouter(settings)
stt_adapter = SttAdapter(settings)
translate_adapter = TranslateAdapter(settings)

app = FastAPI(title="BadaBhai AI Service", version="0.1.0")

_BLOCKED_REPLY = (
    "Sorry, I couldn't process that safely. Please rephrase without sharing "
    "personal details like your phone number, full name, or company name."
)


def _pseudonymization_meta(result: PseudonymizationResult) -> PseudonymizationMeta:
    return PseudonymizationMeta(
        blocked=result.blocked,
        blocked_reason=result.blocked_reason,
        replaced_entities=result.replaced_entities,
        placeholder_tokens=result.placeholder_tokens,
    )


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "service": "ai-service",
        "real_calls_enabled": settings.real_calls_enabled,
        # Actual tracer state (keys present AND package installed), not just config.
        "langfuse_enabled": router.langfuse_enabled,
        "max_call_cost_inr": settings.ai_max_call_cost_inr,
        # Which spend-ledger backend is active (redis = global caps; in_process =
        # per-worker). PII-free; no store round-trip.
        "spend_store": cost_tracker.get_ledger().backend_name,
        # PII-free cumulative spend / retry-budget usage-vs-cap (TD27). snapshot is
        # async (it may touch the Redis backend); await it.
        "spend": await cost_tracker.get_ledger().snapshot(settings),
    }


@app.get("/ai/spend")
async def ai_spend(user_ref: str | None = None) -> dict:
    """PII-free cumulative spend + retry-budget usage vs. caps (TD27).

    Numbers / model ids / UTC date only — never message content. Pass an opaque
    ``user_ref`` to also see that worker's spend vs the per-user daily cap. Scope is
    per-process with the in-process backend; GLOBAL across workers with Redis
    (REDIS_URL set). snapshot is async (may touch Redis); await it.
    """
    return await cost_tracker.get_ledger().snapshot(settings, user_ref=user_ref)


@app.post("/pseudonymize", response_model=PseudonymizationOutput)
def pseudonymize_endpoint(body: PseudonymizationInput) -> PseudonymizationOutput:
    result = pseudonymize(body.text)
    logger.info(
        "pseudonymize",
        extra={
            "extra": {
                "blocked": result.blocked,
                "replaced_entities": result.replaced_entities,
                "request_id": body.request_id,
            }
        },
    )
    return PseudonymizationOutput(
        pseudonymized_text=result.text,
        blocked=result.blocked,
        blocked_reason=result.blocked_reason,
        replaced_entities=result.replaced_entities,
        placeholder_tokens=result.placeholder_tokens,
    )


@app.post("/profiling/respond", response_model=ProfilingTurnOutput)
async def profiling_respond(body: ProfilingTurnInput) -> ProfilingTurnOutput:
    # 1. Pseudonymize FIRST — gate for any external LLM call.
    result = pseudonymize(body.message_text)
    if result.blocked:
        logger.warning("profiling blocked", extra={"extra": {"reason": result.blocked_reason}})
        return ProfilingTurnOutput(
            reply_text=_BLOCKED_REPLY,
            blocked=True,
            blocked_reason=result.blocked_reason,
            is_mock=True,
            pseudonymization_metadata=_pseudonymization_meta(result),
        )

    # 2. Engine decides next question + progress (reads raw locally, no network).
    mock_reply, asked_id, updated_state, extraction_ready = interview_engine.next_turn(
        body.conversation_state, body.message_text, body.role_family
    )

    # 3. Route through the model (mock vs real); LLM only sees pseudonymized text.
    #    The engine already chose the question; the model only rephrases it warmly.
    #    COST-3: the chat turn is STATELESS — prior history is NOT sent to the model
    #    (build_chat_messages ignores it), so there is nothing to pseudonymize/thread
    #    here. Only the current (already-pseudonymized) message + the engine's
    #    question reach the LLM. History still persists in the API for extraction.
    messages = build_chat_messages([], mock_reply, result.text)
    reply_text, meta = await router.run(
        "profiling_chat_turn",
        messages=messages,
        mock_response=mock_reply,
        real_call_allowed=body.real_call_allowed,
        user_ref=body.worker_ref,
    )

    return ProfilingTurnOutput(
        reply_text=reply_text,
        blocked=False,
        suggested_followups=interview_engine.suggested_followups(body.role_family),
        is_mock=not meta.real_call,
        asked_question_id=asked_id,
        extraction_ready=extraction_ready,
        updated_state=updated_state,
        ai_metadata=meta,
        pseudonymization_metadata=_pseudonymization_meta(result),
    )


@app.post("/profile/extract", response_model=ProfileExtractionOutput)
async def profile_extract(body: ProfileExtractionInput) -> ProfileExtractionOutput:
    raw = body.transcript or "\n".join(m.text for m in (body.messages or []))

    # 1. Pseudonymize FIRST — gate. If blocked, fail closed.
    result = pseudonymize(raw)
    if result.blocked:
        return ProfileExtractionOutput(
            profile=DraftProfile(),
            blocked=True,
            blocked_reason=result.blocked_reason,
            is_mock=True,
            extraction_status="blocked",
        )

    # 2. Heuristic extraction over RAW text (trusted local; no network).
    rich, legacy = profile_extractor.extract(raw, body.role_family)

    # 3. Route for cost/tracing + optional real-model extraction. The LLM only
    #    ever sees the pseudonymized transcript. The canonicalization rubric makes
    #    the model emit a `canonical_role_id` from the closed taxonomy set.
    messages = [
        {
            "role": "system",
            "content": EXTRACTION_SYSTEM_PROMPT + canonicalization_instruction() + _schema_hint(),
        },
        {"role": "user", "content": result.text},
    ]
    content, meta = await router.run(
        "profile_extraction",
        messages=messages,
        mock_response=rich.model_dump_json(),
        real_call_allowed=True,
        user_ref=body.worker_ref,
    )

    # In real mode, prefer a valid LLM profile but keep locally-read fields
    # (city/salary) since the model only saw masked text.
    if meta.real_call and meta.success:
        # Canonicalization first, LENIENTLY: pull the role id straight from the raw
        # JSON and trust it only if it is a known canonical id (reject
        # hallucinations). This is independent of the strict rich-draft validation
        # below — the model routinely nulls/loosely-types enrichment fields, and a
        # correct canonical role id must not be discarded just because (say)
        # `experience_level` came back null. A valid id overrides the heuristic on
        # `legacy` — the field the canonicalization eval measures — and derives the
        # trade id. A null/invalid id keeps the heuristic.
        role_id = normalize_role_id(extract_canonical_role_id(content))
        if role_id is not None:
            legacy.canonical_role_id = role_id
            legacy.canonical_trade_id = ROLE_TRADE.get(role_id, legacy.canonical_trade_id)
        # Field-by-field enrichment overlay: keep each well-formed model field even
        # when siblings are malformed (location/salary stay local — masked input).
        rich = profile_extractor.merge_model_draft(rich, content)
        # TODO(WS4 recall backfill, owner review): once the real-eval NEGATIVE tier
        # is confirmed unaffected, enable the rich->legacy canonical backfill here:
        #   legacy = profile_extractor.map_rich_to_legacy(rich, legacy)
        # It fills in-scope machine/skill/role ids the raw-text detector missed
        # (writing only closed-set gazetteer ids). Deferred because backfilling the
        # role from the model's free `primary_role` label could override the model's
        # AUTHORITATIVE `canonical_role_id=null` on a helper/adjacent case and
        # regress the negative tier — verify against the staging --real eval first.

    # Honest-adjacency flag (advisory ONLY — never ranks/rejects): mark the draft
    # adjacent when it canonicalized to nothing matchable in the CNC/VMC taxonomy
    # (e.g. welding), so it is not silently half-empty. Additive; no matchable
    # field is written here.
    if profile_extractor.is_outside_cnc_vmc_scope(legacy):
        rich.unmatchable_reason = profile_extractor.UNMATCHABLE_OUTSIDE_SCOPE

    logger.info("profile extracted", extra={"extra": {"is_mock": not meta.real_call}})
    return ProfileExtractionOutput(
        profile=legacy,
        blocked=False,
        is_mock=not meta.real_call,
        extraction_status="completed",
        worker_profile_draft=rich,
        ai_metadata=meta,
    )


@app.post("/resume/generate", response_model=ResumeGenerationOutput)
async def resume_generate(body: ResumeGenerationInput) -> ResumeGenerationOutput:
    text, data = build_resume(body.profile)
    messages = [
        {"role": "system", "content": RESUME_SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(data)},
    ]
    resume_text, meta = await router.run(
        "resume_generation",
        messages=messages,
        mock_response=text,
        real_call_allowed=True,
        user_ref=body.worker_ref,
    )
    return ResumeGenerationOutput(
        resume_text=resume_text,
        resume_json=data,
        format="text",
        is_mock=not meta.real_call,
    )


@app.post("/voice/transcribe", response_model=TranscriptionOutput)
async def voice_transcribe(body: TranscriptionInput) -> TranscriptionOutput:
    # Mock by default; the real Sarvam call is gated behind AI_ENABLE_REAL_CALLS
    # (+ key) and fails closed. The adapter never sends audio on the mock path.
    result = await stt_adapter.transcribe(
        storage_path=body.storage_path,
        duration_seconds=body.duration_seconds,
        language_code=body.language_code,
        real_call_allowed=body.real_call_allowed,
    )
    # Translate the transcript to English (gated, mock-by-default, fail-closed).
    # The adapter skips English sources and returns empty english on any failure.
    english_text = ""
    if body.translate_to_english and result.transcript_text.strip():
        translation = await translate_adapter.translate(
            text=result.transcript_text,
            source_language_code=result.language_code,
            real_call_allowed=body.real_call_allowed,
        )
        english_text = translation.english_text
    # PRIVACY: never log transcript or english TEXT (raw worker free-text). Counts only.
    logger.info(
        "voice transcribe",
        extra={
            "extra": {
                "voice_note_id": body.voice_note_id,
                "is_mock": result.is_mock,
                "confidence": result.confidence,
                "char_count": len(result.transcript_text),
                "english_len": len(english_text),
                "language": result.language_code,
                "error_code": result.error_code,
            }
        },
    )
    return TranscriptionOutput(
        transcript_text=result.transcript_text,
        confidence=result.confidence,
        language_code=result.language_code,
        is_mock=result.is_mock,
        english_text=english_text,
    )


def _schema_hint() -> str:
    keys = ", ".join(WorkerProfileDraft.model_fields.keys())
    return f"Schema keys: {keys}."


