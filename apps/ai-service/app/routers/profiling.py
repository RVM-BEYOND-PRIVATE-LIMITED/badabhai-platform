"""The LLM-led worker interview: POST /profiling/turn and POST /profiling/extract.

This file was DELETED by the OIE Phase 8 cutover and is deliberately not a restoration of what
was here. The old version let a model run the whole interview and hold the state. This one lets
a model choose the next question inside a stretch the API bounds, and holds no state at all:
every call carries its own `stage`, `draft` and `history`, so the API remains the only thing
that knows how long an interview has run and the only thing that can end it.

WHAT COMES BACK ON EVERY FAILURE IS AN EMPTY `reply_text`. The caller has a deterministic
question ready — 101 authored packs' worth — and treats an empty reply as "you take this turn".
Blocked by the privacy gate, mock posture, a spend cap, a provider 429, malformed JSON: all one
outcome, because the caller's response to all of them is identical and a worker mid-interview
must never see any of them.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter

from ..config import get_settings
from ..contracts import (
    ExperienceEntry,
    InterviewExtractInput,
    InterviewExtractOutput,
    LlmTurnInput,
    LlmTurnOutput,
)
from ..profiling.canonical_roles import coerce_json_text
from ..profiling.interview_prompts import extract_system_prompt, interview_system_prompt
from ..profiling.parse_masking import mask_transcript_lines
from ..pseudonymize import pseudonymize
from ._shared import logger, router

api_router = APIRouter()

TURN_TASK_TYPE = "profiling_chat_turn"
EXTRACT_TASK_TYPE = "profile_extraction"

#: Returned when anything at all goes wrong. An empty reply IS the fallback signal.
_SILENT = LlmTurnOutput(reply_text="", is_mock=True)


def _turn_messages(body: LlmTurnInput, masked_message: str) -> list[dict[str, str]]:
    """System prompt + a compact rendering of where we are and what was said.

    The draft is sent back each turn rather than kept here: this service holds no session
    state, which is what makes an API-owned turn cap enforceable rather than advisory.
    """
    history = "\n".join(
        f"{'Worker' if line.role == 'worker' else 'Bada Bhai'}: {line.text}"
        for line in body.history
    )
    draft = body.draft
    state = json.dumps(
        {
            "stage": body.stage,
            "domain_label": draft.domain_label,
            "role_label": draft.role_label,
            "skills": draft.skills,
            "experiences_recorded": len(draft.experiences),
        },
        ensure_ascii=False,
    )
    closing = (
        "\n\nTHIS IS YOUR LAST TURN. Do not ask anything. Set phase_a_done true and reply with a "
        "short closing acknowledgement."
        if body.force_close
        else ""
    )
    return [
        {"role": "system", "content": interview_system_prompt()},
        {
            "role": "user",
            "content": (
                f"Conversation so far:\n{history or '(nothing yet)'}\n\n"
                f"What you have gathered: {state}\n\n"
                f"The worker just said: {masked_message or '(nothing yet - open the conversation)'}"
                f"{closing}"
            ),
        },
    ]


def _parse_turn(content: str, body: LlmTurnInput) -> LlmTurnOutput | None:
    """Model output is untrusted input (§11). `None` on anything unreadable."""
    # THROUGH `coerce_json_text` FIRST, which is not optional — its own docstring says every
    # place that parses model JSON for a profile must go through it. Claude has no strict JSON
    # mode and routinely wraps the object in a ```json fence, so a bare `json.loads` rejects a
    # perfectly good turn. Measured live: a real call came back with 102 tokens of valid content
    # and this function threw it away, which the caller then reported as "the model is
    # unavailable", falling the whole interview back to the packs.
    try:
        raw = json.loads(coerce_json_text(content))
    except (TypeError, ValueError):
        logger.warning("llm turn output was not JSON")
        return None
    if not isinstance(raw, dict):
        return None
    try:
        out = LlmTurnOutput.model_validate(raw)
    except Exception:
        # Includes an `experience_entry` carrying `employer_name`: ExperienceEntry forbids
        # extras, so the whole turn is refused rather than quietly stripped. A model that tried
        # to hand us an employer once will try again, and a silent strip hides that.
        logger.warning("llm turn output failed the contract")
        return None
    # NO STAGE NORMALIZATION HERE, and the absence is deliberate. This used to re-check
    # `out.stage` against the closed set and fall back to `body.stage` — unreachable code:
    # `LlmInterviewStage` is a `Literal`, so `model_validate` above has already refused anything
    # outside it and returned None. A stage the model invented therefore fails the whole turn,
    # which is the same fail-closed direction every other branch here takes, and the API owns
    # progression regardless: `LlmTurnService` decides `done` from its own caps, never from this.
    return out


@api_router.post("/profiling/turn", response_model=LlmTurnOutput)
async def profiling_turn(body: LlmTurnInput) -> LlmTurnOutput:
    """One Phase A turn: the model asks the next question about domain/role/skills/experience.

    Privacy order is the same as every other worker-text route and it fails CLOSED:
    pseudonymize BEFORE the model, and a blocked message never reaches a provider and never
    advances anything.
    """
    settings = get_settings()

    masked_message = ""
    if body.message_text:
        result = pseudonymize(body.message_text)
        if result.blocked:
            logger.warning(
                "llm turn blocked by the privacy gate",
                extra={"extra": {"reason": result.blocked_reason}},
            )
            return LlmTurnOutput(
                reply_text="", blocked=True, blocked_reason=result.blocked_reason, is_mock=True
            )
        masked_message = result.text

    # History is masked PER MESSAGE, not as one blob. A 20k whole-transcript gate is what once
    # blocked long interviews outright and handed the worker an empty profile — punished,
    # precisely, for answering at length.
    body = body.model_copy(update={"history": mask_transcript_lines(body.history)})

    try:
        content, meta = await asyncio.wait_for(
            router.run(
                TURN_TASK_TYPE,
                messages=_turn_messages(body, masked_message),
                mock_response="{}",
                real_call_allowed=True,
                user_ref=body.worker_ref,
            ),
            timeout=settings.profiling_turn_deadline_seconds,
        )
    except TimeoutError:
        # TimeoutError ONLY — a CancelledError means the CLIENT went away, and swallowing it
        # would turn a disconnect into a fabricated 200.
        logger.warning(
            "llm turn deadline exceeded",
            extra={"extra": {"deadline_s": settings.profiling_turn_deadline_seconds}},
        )
        return _SILENT

    if not meta.real_call:
        # A posture (mock mode, a cap, the kill switch), not an incident. No mock question is
        # invented: a fabricated interview question is worse than a deterministic real one.
        return _SILENT

    out = _parse_turn(content, body)
    if out is None or not out.reply_text.strip():
        return _SILENT

    out.is_mock = False
    out.ai_metadata = meta
    return out


@api_router.post("/profiling/extract", response_model=InterviewExtractOutput)
async def profiling_extract(body: InterviewExtractInput) -> InterviewExtractOutput:
    """Phase C: the whole conversation in, the resume-shaped values out.

    Separate from `/profile/parse`, which types and cites a deterministic answer map against a
    closed field list. This one reads a conversation the model itself conducted and must
    SYNTHESISE across turns — `experiences[]` in particular has no answer-map equivalent,
    because the packs can only ask a fixed question once.
    """
    settings = get_settings()
    masked = mask_transcript_lines(body.transcript)
    if not masked:
        return InterviewExtractOutput(is_mock=True)

    rendered = "\n".join(
        f"{'Worker' if line.role == 'worker' else 'Bada Bhai'}: {line.text}" for line in masked
    )
    messages = [
        {"role": "system", "content": extract_system_prompt()},
        {"role": "user", "content": f"The conversation:\n{rendered}"},
    ]

    try:
        content, meta = await asyncio.wait_for(
            router.run(
                EXTRACT_TASK_TYPE,
                messages=messages,
                mock_response="{}",
                real_call_allowed=True,
                user_ref=body.worker_ref,
            ),
            timeout=settings.profiling_extract_deadline_seconds,
        )
    except TimeoutError:
        logger.warning(
            "interview extract deadline exceeded",
            extra={"extra": {"deadline_s": settings.profiling_extract_deadline_seconds}},
        )
        return InterviewExtractOutput(is_mock=True)

    if not meta.real_call:
        return InterviewExtractOutput(is_mock=True)

    try:
        # Same fence tolerance as the turn parser above, and for the same reason.
        raw = json.loads(coerce_json_text(content))
        out = InterviewExtractOutput.model_validate(raw if isinstance(raw, dict) else {})
    except Exception:
        logger.warning("interview extract output failed the contract")
        return InterviewExtractOutput(is_mock=True, ai_metadata=meta)

    # Re-certify every surviving string. The model read a masked transcript, but it composes new
    # text (`work_done`, skill phrases) and composed text is not covered by the input gate.
    out.experiences = [e for e in out.experiences if _certified(e)]
    out.skills = [s for s in out.skills if not pseudonymize(s).blocked]

    out.is_mock = False
    out.ai_metadata = meta
    return out


def _certified(entry: ExperienceEntry) -> bool:
    """Drop an experience whose composed prose carries something the gateway will not mask.
    Dropping one entry costs coverage; keeping it costs the worker their credibility."""
    return not any(
        pseudonymize(text).blocked
        for text in (entry.role_label, entry.duration_text, entry.work_done)
        if text
    )
