"""FastAPI AI service.

Endpoints: /health, /pseudonymize, /profiling/respond, /profile/extract,
/resume/generate.

INVARIANT: pseudonymization runs BEFORE any LLM path on every endpoint that
could reach an LLM. If pseudonymization is blocked, the LLM is never called and a
safe fallback is returned (fail closed).
"""

from __future__ import annotations

from fastapi import FastAPI

from .config import get_settings
from .contracts import (
    DraftProfile,
    ProfileExtractionInput,
    ProfileExtractionOutput,
    ProfilingTurnInput,
    ProfilingTurnOutput,
    PseudonymizationInput,
    PseudonymizationOutput,
    ResumeGenerationInput,
    ResumeGenerationOutput,
)
from .extraction import build_resume, extract_profile_from_text
from .llm import LlmAdapter
from .logging_config import configure_logging, get_logger
from .pseudonymize import pseudonymize

configure_logging()
logger = get_logger("ai-service")
settings = get_settings()

app = FastAPI(title="BadaBhai AI Service", version="0.1.0")

_BLOCKED_REPLY = (
    "Sorry, I couldn't process that safely. Please rephrase without sharing "
    "personal details like your phone number, full name, or company name."
)


def _mock_reply(_pseudonymized_text: str) -> str:
    return (
        "Bada Bhai here \U0001f44b — tell me about your work: which machines do you "
        "run (CNC / VMC / HMC), how many years of experience, and which controller "
        "(Fanuc / Siemens)?"
    )


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "ai-service",
        "real_calls_enabled": settings.real_calls_enabled,
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
    # 1. Pseudonymize FIRST.
    result = pseudonymize(body.message_text)
    if result.blocked:
        logger.warning(
            "profiling blocked", extra={"extra": {"reason": result.blocked_reason}}
        )
        return ProfilingTurnOutput(
            reply_text=_BLOCKED_REPLY,
            blocked=True,
            blocked_reason=result.blocked_reason,
            is_mock=True,
        )

    # 2. Real LLM path is gated + fails closed -> mock otherwise.
    adapter = LlmAdapter(settings)
    enabled, _reason = adapter.can_call()
    if not enabled:
        return ProfilingTurnOutput(
            reply_text=_mock_reply(result.text),
            blocked=False,
            suggested_followups=[
                "Which controller — Fanuc or Siemens?",
                "How many years on VMC/CNC?",
                "Which city are you open to working in?",
            ],
            is_mock=True,
        )

    try:
        reply = await adapter.complete(prompt=result.text, purpose="profiling_respond")
        return ProfilingTurnOutput(reply_text=reply, blocked=False, is_mock=False)
    except Exception as exc:  # pragma: no cover - real path not wired in Phase 1
        logger.error("llm call failed", extra={"extra": {"error": str(exc)}})
        return ProfilingTurnOutput(reply_text=_mock_reply(result.text), blocked=False, is_mock=True)


@app.post("/profile/extract", response_model=ProfileExtractionOutput)
def profile_extract(body: ProfileExtractionInput) -> ProfileExtractionOutput:
    raw = body.transcript or "\n".join(m.text for m in (body.messages or []))
    result = pseudonymize(raw)
    if result.blocked:
        return ProfileExtractionOutput(
            profile=DraftProfile(), blocked=True, blocked_reason=result.blocked_reason, is_mock=True
        )
    profile = extract_profile_from_text(result.text)
    logger.info("profile extracted", extra={"extra": {"is_mock": True}})
    return ProfileExtractionOutput(profile=profile, blocked=False, is_mock=True)


@app.post("/resume/generate", response_model=ResumeGenerationOutput)
def resume_generate(body: ResumeGenerationInput) -> ResumeGenerationOutput:
    text, data = build_resume(body.profile)
    return ResumeGenerationOutput(resume_text=text, resume_json=data, format="text", is_mock=True)
