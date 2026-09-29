"""The chat companion v2 routes (ADR-0046 Phase 1).

``POST /companion/classify`` — one free-text message to one closed intent.
``POST /companion/edit-parse`` — one message plus the API's catalogue and current values
to typed edit rows.

THE PRIVACY ORDER IS THE SAME AS EVERY WORKER-TEXT ROUTE, AND IT FAILS CLOSED:
pseudonymize BEFORE the model. A blocked message reaches no provider and returns the
deterministic fail-closed output — an ``unclear`` classification (the API's clarify
line) or an empty proposal (the API's "kya badalna hai, samajh nahi aaya" line). The
memory turns and every current value are masked too, so the invariant "every model
input passes the gateway" holds for the whole request, not just its first field.

MODEL OUTPUT IS UNTRUSTED AND THE ROUTES RETURN IT AS-IS: the parsers in
``app.companion`` validate and drop, and the API validates every row again before a
card is stored. Nothing here writes anything; only the worker's Haan can (O4).
"""

from __future__ import annotations

from fastapi import APIRouter

from ..companion import classify as classify_logic
from ..companion import edit_parse as edit_parse_logic
from ..companion.prompts import (
    CLASSIFY_SYSTEM_PROMPT,
    COMPANION_CLASSIFY_PROMPT,
    COMPANION_EDIT_PARSE_PROMPT,
    EDIT_PARSE_SYSTEM_PROMPT,
    build_classify_messages,
    build_edit_parse_messages,
)
from ..contracts import (
    CompanionClassifyInput,
    CompanionClassifyOutput,
    CompanionEditParseInput,
    CompanionEditParseOutput,
)
from ..pseudonymize import pseudonymize
from ._shared import logger, resolve_prompt, router

api_router = APIRouter()

# The AIRouter task types. Registered in `app/ai/model_config.py` by A3; until then an
# unregistered task RAISES inside `router.run` — deliberately, because an unknown task
# is a programming error, never a worker-visible failure.
CLASSIFY_TASK_TYPE = "companion_classify"
EDIT_PARSE_TASK_TYPE = "companion_edit_parse"


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
        return CompanionClassifyOutput(intent="unclear", confidence=0.0, blocked=True)

    # RESOLVED, not called, so the generation records which prompt version produced this
    # answer. `None` only while the name is unregistered (A3 registers it), in which case
    # the local constant is the fallback — the bytes the provider sees are the same.
    resolved = resolve_prompt(COMPANION_CLASSIFY_PROMPT)
    system_prompt = resolved.text if resolved is not None else CLASSIFY_SYSTEM_PROMPT
    messages = build_classify_messages(
        result.text, classify_logic.mask_recent_turns(body.recent_turns), system_prompt
    )
    content, _meta = await router.run(
        CLASSIFY_TASK_TYPE,
        messages=messages,
        mock_response=classify_logic.MOCK_RESPONSE,
        real_call_allowed=True,
        prompt=resolved,
    )
    return classify_logic.parse_classify_output(content)


@api_router.post("/companion/edit-parse", response_model=CompanionEditParseOutput)
async def companion_edit_parse(body: CompanionEditParseInput) -> CompanionEditParseOutput:
    """One message to typed edit rows (0..max_rows), plus the closed unsupported reasons."""
    result = pseudonymize(body.text)
    if result.blocked:
        logger.warning(
            "companion edit-parse blocked", extra={"extra": {"reason": result.blocked_reason}}
        )
        return CompanionEditParseOutput()

    resolved = resolve_prompt(COMPANION_EDIT_PARSE_PROMPT)
    system_prompt = resolved.text if resolved is not None else EDIT_PARSE_SYSTEM_PROMPT
    messages = build_edit_parse_messages(
        result.text,
        body.catalogue,
        edit_parse_logic.mask_snapshot(body.snapshot),
        body.max_rows,
        system_prompt,
    )
    content, _meta = await router.run(
        EDIT_PARSE_TASK_TYPE,
        messages=messages,
        mock_response=edit_parse_logic.MOCK_RESPONSE,
        real_call_allowed=True,
        prompt=resolved,
    )
    return edit_parse_logic.parse_edit_rows(content, body.max_rows)
