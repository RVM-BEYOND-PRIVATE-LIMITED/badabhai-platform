"""The chat companion v2 routes (ADR-0046).

``POST /companion/classify`` — one free-text message to one closed intent.
``POST /companion/edit-parse`` — one message plus the API's catalogue and current values
to typed edit rows.
``POST /companion/career`` (P3) — one career question to a short Hinglish answer or a
closed refusal topic. The ONE route where the model writes what the worker reads.

THE PRIVACY ORDER IS THE SAME AS EVERY WORKER-TEXT ROUTE, AND IT FAILS CLOSED:
pseudonymize BEFORE the model. A blocked message reaches no provider and returns the
deterministic fail-closed output — an ``unclear`` classification (the API's clarify
line), an empty proposal (the API's "kya badalna hai, samajh nahi aaya" line) or a
refusal on ``unsafe_other`` (the API's reviewed refusal copy). The memory turns and
every current value are masked too, so the invariant "every model input passes the
gateway" holds for the whole request, not just its first field.

MODEL OUTPUT IS UNTRUSTED AND THE ROUTES RETURN IT AS-IS: the parsers in
``app.companion`` validate and drop, the API validates every row again before a card is
stored, and the API re-checks every career answer's content (persona, refusal backstop,
PII) before a line is served. Nothing here writes anything; only the worker's Haan can (O4).
"""

from __future__ import annotations

from fastapi import APIRouter

from ..ai import prompt_registry
from ..companion import career as career_logic
from ..companion import classify as classify_logic
from ..companion import edit_parse as edit_parse_logic
from ..companion.prompts import (
    CAREER_SYSTEM_PROMPT,
    CLASSIFY_SYSTEM_PROMPT,
    EDIT_PARSE_SYSTEM_PROMPT,
    build_career_messages,
    build_classify_messages,
    build_edit_parse_messages,
)
from ..contracts import (
    CompanionCareerAnswer,
    CompanionCareerInput,
    CompanionCareerRefuse,
    CompanionClassifyInput,
    CompanionClassifyOutput,
    CompanionEditParseInput,
    CompanionEditParseOutput,
)
from ..pseudonymize import pseudonymize
from ._shared import logger, resolve_prompt, router

api_router = APIRouter()

# The AIRouter task types. Registered in `app/ai/model_config.py`; until then an
# unregistered task RAISES inside `router.run` — deliberately, because an unknown task
# is a programming error, never a worker-visible failure.
CLASSIFY_TASK_TYPE = "companion_classify"
EDIT_PARSE_TASK_TYPE = "companion_edit_parse"
CAREER_TASK_TYPE = "companion_career_answer"


@api_router.post("/companion/classify", response_model=CompanionClassifyOutput)
async def companion_classify(body: CompanionClassifyInput) -> CompanionClassifyOutput:
    """One message to one intent. ``blocked`` is the pseudonymizer's refusal, never the model's."""
    result = pseudonymize(body.text)
    if result.blocked:
        logger.warning(
            "companion classify blocked", extra={"extra": {"reason": result.blocked_reason}}
        )
        # Fail closed: `unclear` is what a schema miss, a timeout and a low confidence
        # all become at the API, so a blocked message takes the ordinary clarify path.
        # `ai_metadata=None`: no provider was called, so there is no cost to record.
        return CompanionClassifyOutput(
            intent="unclear", confidence=0.0, blocked=True, ai_metadata=None
        )

    # RESOLVED, not called, so the generation records which prompt version produced this
    # answer. `None` only while the name is unregistered (A3 registers it), in which case
    # the local constant is the fallback — the bytes the provider sees are the same.
    resolved = resolve_prompt(prompt_registry.COMPANION_CLASSIFY)
    system_prompt = resolved.text if resolved is not None else CLASSIFY_SYSTEM_PROMPT
    messages = build_classify_messages(
        result.text, classify_logic.mask_recent_turns(body.recent_turns), system_prompt
    )
    content, meta = await router.run(
        CLASSIFY_TASK_TYPE,
        messages=messages,
        mock_response=classify_logic.MOCK_RESPONSE,
        real_call_allowed=True,
        prompt=resolved,
    )
    # THE SPEND IS RETURNED, NOT DISCARDED (ADR-0046 O12). `router.run` built this metadata and
    # `_meta` used to be dropped here — the exact #745/#738 shape that left `resume_generation`
    # and `job_posting_chat_turn` unledgered. The API records it against `companion_classify`
    # before any branch; `real_call=False` zeroes the rupees on a mocked run rather than
    # inventing them.
    parsed = classify_logic.parse_classify_output(content)
    return parsed.model_copy(update={"ai_metadata": meta})


@api_router.post("/companion/edit-parse", response_model=CompanionEditParseOutput)
async def companion_edit_parse(body: CompanionEditParseInput) -> CompanionEditParseOutput:
    """One message to typed edit rows (0..max_rows), plus the closed unsupported reasons."""
    result = pseudonymize(body.text)
    if result.blocked:
        logger.warning(
            "companion edit-parse blocked", extra={"extra": {"reason": result.blocked_reason}}
        )
        return CompanionEditParseOutput()

    resolved = resolve_prompt(prompt_registry.COMPANION_EDIT_PARSE)
    system_prompt = resolved.text if resolved is not None else EDIT_PARSE_SYSTEM_PROMPT
    messages = build_edit_parse_messages(
        result.text,
        body.catalogue,
        edit_parse_logic.mask_snapshot(body.snapshot),
        body.max_rows,
        system_prompt,
    )
    content, meta = await router.run(
        EDIT_PARSE_TASK_TYPE,
        messages=messages,
        mock_response=edit_parse_logic.MOCK_RESPONSE,
        real_call_allowed=True,
        prompt=resolved,
    )
    # Same rule as the classifier above: the metadata rides back on the response so the API can
    # record the spend against `companion_edit_parse` (ADR-0046 O12).
    parsed = edit_parse_logic.parse_edit_rows(content, body.max_rows)
    return parsed.model_copy(update={"ai_metadata": meta})


@api_router.post(
    "/companion/career",
    response_model=CompanionCareerAnswer | CompanionCareerRefuse,
)
async def companion_career(
    body: CompanionCareerInput,
) -> CompanionCareerAnswer | CompanionCareerRefuse:
    """One career question to a short Hinglish answer, or a refusal on a closed topic.

    THE ONE ROUTE WHERE THE MODEL WRITES WHAT THE WORKER READS (O7/O9/O10). Everything
    here is arranged so that the worst outcome is a reviewed refusal: the input is
    pseudonymized fail-closed, the prompt pins the refusal topics, the parser maps every
    unreadable output to ``refuse/unsafe_other``, and the API re-validates the content
    before serving a line. A blocked message returns that refusal without a provider call.
    """
    result = pseudonymize(body.text)
    if result.blocked:
        logger.warning(
            "companion career blocked", extra={"extra": {"reason": result.blocked_reason}}
        )
        # Fail closed: reviewed refusal copy, never a model line and never the raw text.
        return CompanionCareerRefuse(status="refuse", topic="unsafe_other", ai_metadata=None)

    resolved = resolve_prompt(prompt_registry.COMPANION_CAREER)
    system_prompt = resolved.text if resolved is not None else CAREER_SYSTEM_PROMPT
    messages = build_career_messages(
        result.text,
        classify_logic.mask_recent_turns(body.recent_turns),
        body.worker_context,
        system_prompt,
    )
    content, meta = await router.run(
        CAREER_TASK_TYPE,
        messages=messages,
        mock_response=career_logic.MOCK_RESPONSE,
        real_call_allowed=True,
        prompt=resolved,
    )
    parsed = career_logic.parse_career_output(content)
    return parsed.model_copy(update={"ai_metadata": meta})
