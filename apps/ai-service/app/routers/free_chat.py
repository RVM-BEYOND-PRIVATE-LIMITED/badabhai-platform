"""The profiling-stage free chat routes (ADR-0051, #2027).

``POST /free-chat/classify``: one typed message, in free or résumé mode, to one closed category.
``POST /free-chat/reply``: one casual or career message to 1-4 short Hinglish lines, or a closed
refusal topic. Both mirror the companion routes (ADR-0046), on a different surface.

THE PRIVACY ORDER IS THE COMPANION'S, AND IT FAILS CLOSED: the masking policy in force
(`AI_RAW_PII_ENABLED`, ADR-0047) BEFORE the model, through `app/llm_input_policy.py`, for every
model input: the message, the question on screen, the recent turns and the trade label. A
blocked message or question reaches no provider and returns the deterministic fail-closed
output: ``unclear`` with ``blocked=True`` (which the API reads as "unavailable": the interview in
résumé mode, the clarify line in free mode) or a refusal on ``unsafe_other`` (the API's fallback
line). A turn or a trade label the gate refuses is dropped, not sent.

``ai_metadata`` IS RETURNED, NEVER DISCARDED. The API records the spend from it, and decides a
REAL classification from ``ai_metadata.real_call`` being true and ``blocked`` false, so the
metadata must carry ``real_call`` exactly as the router measured it: false for a mock, and None
when no provider was reached at all.

MODEL OUTPUT IS UNTRUSTED AND THE ROUTES RETURN IT AS PARSED: the parsers in ``app.free_chat``
validate and fall back, and the API re-validates every reply line before a worker reads it.
Nothing here decides or writes anything.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..ai import prompt_registry
from ..companion.classify import mask_recent_turns
from ..companion.prompts import build_career_messages
from ..config import get_settings
from ..contracts import (
    FreeChatAnswer,
    FreeChatClassifyInput,
    FreeChatClassifyOutput,
    FreeChatRefuse,
    FreeChatReplyInput,
    FreeChatReplyOutput,
)
from ..free_chat import classify as classify_logic
from ..free_chat import reply as reply_logic
from ..free_chat.prompts import CLASSIFY_SYSTEM_PROMPT, build_free_classify_messages
from ..llm_input_policy import llm_input_gate
from ..pseudonymize import PseudonymizationResult
from ._shared import logger, resolve_prompt, router

api_router = APIRouter()

# The AIRouter task types, registered in `app/ai/model_config.py` (route + an explicit branch)
# and in the `aiTaskType` cost enum (packages/event-schema). Named apart from the companion's
# constants so a source scan that maps a constant to its task never confuses the two.
FREE_CLASSIFY_TASK_TYPE = "profiling_free_classify"
FREE_REPLY_TASK_TYPE = "profiling_free_reply"


def _first_refusal(**gated: PseudonymizationResult | None) -> tuple[str, str | None] | None:
    """The first input the gate refused, as (field name, the gate's closed reason), or None.

    Field names and the gate's reason vocabulary only: the refused TEXT never reaches a log.
    """
    for field, result in gated.items():
        if result is not None and result.blocked:
            return field, result.blocked_reason
    return None


@api_router.post("/free-chat/classify", response_model=FreeChatClassifyOutput)
async def free_chat_classify(body: FreeChatClassifyInput) -> FreeChatClassifyOutput:
    """One message to one category. ``blocked`` is the input gate's refusal, never the model's."""
    raw_pii = get_settings().ai_raw_pii_enabled
    result = llm_input_gate(body.text, raw=raw_pii)
    # THE QUESTION IS RENDERED IN RÉSUMÉ MODE ONLY: free mode has no question on screen
    # (the contract says null there), and a stray one would bias a free message toward
    # `resume`. A question that is never rendered is never gated either.
    question = body.pending_question if body.mode == "resume" else None
    question_result = llm_input_gate(question, raw=raw_pii) if question is not None else None
    refused = _first_refusal(text=result, pending_question=question_result)
    if refused is not None:
        field, reason = refused
        logger.warning(
            "free chat classify blocked", extra={"extra": {"field": field, "reason": reason}}
        )
        # Fail closed. A blocked QUESTION blocks the whole call rather than being dropped:
        # "5 saal" without its question reads as chit-chat, and a confident wrong verdict would
        # deflect a real answer, while "unavailable" sends it to today's interview.
        # `ai_metadata=None`: no provider was called, so there is no cost to record.
        return FreeChatClassifyOutput(
            category="unclear", confidence=0.0, blocked=True, ai_metadata=None
        )

    resolved = resolve_prompt(prompt_registry.FREE_CHAT_CLASSIFY)
    system_prompt = resolved.text if resolved is not None else CLASSIFY_SYSTEM_PROMPT
    messages = build_free_classify_messages(
        result.text,
        mask_recent_turns(body.recent_turns, raw=raw_pii),
        body.mode,
        question_result.text if question_result is not None else None,
        system_prompt,
    )
    content, meta = await router.run(
        FREE_CLASSIFY_TASK_TYPE,
        messages=messages,
        mock_response=classify_logic.MOCK_RESPONSE,
        real_call_allowed=True,
        prompt=resolved,
    )
    parsed = classify_logic.parse_classify_output(content)
    return parsed.model_copy(update={"ai_metadata": meta})


@api_router.post("/free-chat/reply", response_model=FreeChatReplyOutput)
async def free_chat_reply(body: FreeChatReplyInput) -> FreeChatAnswer | FreeChatRefuse:
    """One casual or career message to a short Hinglish answer, or a refusal on a closed topic.

    THE MODEL WRITES WHAT THE WORKER READS HERE, so everything is arranged so that the worst
    outcome is reviewed copy: the input is gated fail-closed, the prompt pins the refusal topics,
    the parser maps every unreadable output to ``refuse/unsafe_other``, and the API re-validates
    the content before serving a line.
    """
    raw_pii = get_settings().ai_raw_pii_enabled
    result = llm_input_gate(body.text, raw=raw_pii)
    if result.blocked:
        logger.warning(
            "free chat reply blocked", extra={"extra": {"reason": result.blocked_reason}}
        )
        # Fail closed: reviewed refusal copy, never a model line and never the raw text.
        return FreeChatRefuse(status="refuse", topic="unsafe_other", ai_metadata=None)

    # THE CATEGORY PICKS THE PROMPT; the API decided the category, the model never does.
    prompt_name, fallback_prompt = reply_logic.REPLY_PROMPTS[body.category]
    resolved = resolve_prompt(prompt_name)
    system_prompt = resolved.text if resolved is not None else fallback_prompt
    messages = build_career_messages(
        result.text,
        mask_recent_turns(body.recent_turns, raw=raw_pii),
        reply_logic.mask_worker_context(body.worker_context, raw=raw_pii),
        system_prompt,
    )
    content, meta = await router.run(
        FREE_REPLY_TASK_TYPE,
        messages=messages,
        mock_response=reply_logic.MOCK_RESPONSE,
        real_call_allowed=True,
        prompt=resolved,
    )
    parsed = reply_logic.parse_reply_output(content)
    return parsed.model_copy(update={"ai_metadata": meta})
