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
    WorkerProfileDraft,
)
from .extraction import build_resume
from .logging_config import configure_logging, get_logger
from .profiling import interview_engine, profile_extractor
from .profiling.prompts import (
    EXTRACTION_SYSTEM_PROMPT,
    RESUME_SYSTEM_PROMPT,
    build_chat_messages,
)
from .pseudonymize import PseudonymizationResult, pseudonymize

configure_logging()
logger = get_logger("ai-service")
settings = get_settings()
router = AIRouter(settings)

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
        "langfuse_enabled": settings.langfuse_enabled,
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
    messages = build_chat_messages(body.history, mock_reply, result.text)
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
    #    ever sees the pseudonymized transcript.
    messages = [
        {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT + _schema_hint()},
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


def _schema_hint() -> str:
    keys = ", ".join(WorkerProfileDraft.model_fields.keys())
    return f"Schema keys: {keys}."


def _safe_parse_worker_profile(content: str) -> WorkerProfileDraft | None:
    try:
        return WorkerProfileDraft.model_validate_json(content)
    except Exception:  # noqa: BLE001 - tolerate any malformed LLM output
        return None


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
