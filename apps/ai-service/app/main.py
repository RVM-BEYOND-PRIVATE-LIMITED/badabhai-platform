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

from .ai.router import AIRouter
from .config import get_settings
from .contracts import (
    ConversationMessage,
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
    normalize_role_id,
)
from .profiling.prompts import (
    EXTRACTION_SYSTEM_PROMPT,
    RESUME_SYSTEM_PROMPT,
    build_chat_messages,
)
from .pseudonymize import PseudonymizationResult, pseudonymize
from .stt import SttAdapter

configure_logging()
logger = get_logger("ai-service")
settings = get_settings()
router = AIRouter(settings)
stt_adapter = SttAdapter(settings)

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
def health() -> dict:
    return {
        "status": "ok",
        "service": "ai-service",
        "real_calls_enabled": settings.real_calls_enabled,
        # Actual tracer state (keys present AND package installed), not just config.
        "langfuse_enabled": router.langfuse_enabled,
        "max_call_cost_inr": settings.ai_max_call_cost_inr,
    }


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
    #    History is pseudonymized too — prior turns must never reach the LLM/trace raw.
    messages = build_chat_messages(_pseudonymized_history(body.history), mock_reply, result.text)
    reply_text, meta = await router.run(
        "profiling_chat_turn",
        messages=messages,
        mock_response=mock_reply,
        real_call_allowed=body.real_call_allowed,
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
        role_id = normalize_role_id(_extract_canonical_role_id(content))
        if role_id is not None:
            legacy.canonical_role_id = role_id
            legacy.canonical_trade_id = ROLE_TRADE.get(role_id, legacy.canonical_trade_id)
        # Best-effort enrichment overlay when the full draft validates.
        parsed = _safe_parse_worker_profile(content)
        if parsed is not None:
            rich = _overlay_local_fields(parsed, rich)

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
    # PRIVACY: never log the transcript text (raw worker free-text). Counts only.
    logger.info(
        "voice transcribe",
        extra={
            "extra": {
                "voice_note_id": body.voice_note_id,
                "is_mock": result.is_mock,
                "confidence": result.confidence,
                "char_count": len(result.transcript_text),
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
    )


def _pseudonymized_history(history: list[ConversationMessage]) -> list[ConversationMessage]:
    """Pseudonymize prior turns BEFORE they enter LLM input / Langfuse traces.

    The current message is gated separately; history must be gated too or a prior
    turn's PII would reach the model in real mode. Any turn that can't be safely
    pseudonymized is dropped (fail closed) — history is only phrasing context.
    """
    safe: list[ConversationMessage] = []
    for msg in history:
        result = pseudonymize(msg.text)
        if result.blocked:
            continue
        safe.append(ConversationMessage(role=msg.role, text=result.text))
    return safe


def _schema_hint() -> str:
    keys = ", ".join(WorkerProfileDraft.model_fields.keys())
    return f"Schema keys: {keys}."


def _safe_parse_worker_profile(content: str) -> WorkerProfileDraft | None:
    try:
        return WorkerProfileDraft.model_validate_json(content)
    except Exception:  # noqa: BLE001 - tolerate any malformed LLM output
        return None


def _extract_canonical_role_id(content: str) -> str | None:
    """Pull `canonical_role_id` from raw LLM JSON, tolerating any other malformed
    fields. Returns None if the content is not a JSON object or lacks the key —
    canonicalization must not hinge on the whole enrichment draft validating."""
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return None
    value = data.get("canonical_role_id") if isinstance(data, dict) else None
    return value if isinstance(value, str) else None


def _overlay_local_fields(
    parsed: WorkerProfileDraft, local: WorkerProfileDraft
) -> WorkerProfileDraft:
    """Keep locally-detected location/salary on the LLM-parsed draft (the model
    only saw pseudonymized text, so it cannot know these)."""
    parsed.current_city = local.current_city
    parsed.preferred_locations = local.preferred_locations
    parsed.relocation_willingness = local.relocation_willingness
    parsed.current_salary = local.current_salary
    parsed.expected_salary = local.expected_salary
    return parsed
