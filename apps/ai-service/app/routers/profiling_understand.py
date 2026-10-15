"""The profiling turn's understanding route (ADR-0057, #2309).

``POST /profiling/understand`` — one typed profiling-chat message, read against the session's
whole profiling schema, to one closed intent plus contained fills, edits and page-owned mentions.

THE PRIVACY ORDER IS EVERY WORKER-TEXT ROUTE'S, AND IT FAILS CLOSED: the message is gated BEFORE
the model, and a blocked message reaches no provider and returns ``blocked`` with nothing
proposed — which the API treats exactly like a timeout or a mock: today's pipeline runs the turn
(ADR-0057 §3.6). The turns, the question on screen and every schema value pass the same gateway,
under ONE token scope (`understand.mask_request`), so "every model input passes the gateway"
holds for the whole request. The API has already redacted the worker's own name (G2).

MODEL OUTPUT IS UNTRUSTED: `understand.parse_understanding` contains it to the request and floors
every value (G1); the API validates all of it again and applies nothing a rule or the worker's
Haan has not allowed. Nothing here writes anything.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..ai import prompt_registry
from ..config import get_settings
from ..contracts import ProfilingTurnUnderstandInput, ProfilingTurnUnderstandOutput
from ..llm_input_policy import llm_input_gate
from ..profiling import understand as understand_logic
from ..profiling.understand_prompts import UNDERSTAND_SYSTEM_PROMPT, build_understand_messages
from ..pseudonymize import TokenScope
from ._shared import logger, resolve_prompt, router

api_router = APIRouter()

# The AIRouter task type, registered in `app/ai/model_config.py`. An unregistered task RAISES
# inside `router.run` — deliberately: an unknown task is a programming error, never a
# worker-visible failure.
UNDERSTAND_TASK_TYPE = "profiling_turn_understand"


@api_router.post("/profiling/understand", response_model=ProfilingTurnUnderstandOutput)
async def profiling_understand(
    body: ProfilingTurnUnderstandInput,
) -> ProfilingTurnUnderstandOutput:
    """One message to its intent and its contained fills, edits and mentions."""
    scope = TokenScope()
    raw_pii = get_settings().ai_raw_pii_enabled
    result = llm_input_gate(body.text, raw=raw_pii, scope=scope)
    if result.blocked:
        logger.warning(
            "profiling understand blocked", extra={"extra": {"reason": result.blocked_reason}}
        )
        return ProfilingTurnUnderstandOutput(blocked=True)

    # The original request is what the output is CONTAINED against (its keys, refs and names are
    # API-authored and never masked); the masked copy is only what the model reads.
    masked = understand_logic.mask_request(body, raw=raw_pii, scope=scope).model_copy(
        update={"text": result.text}
    )
    resolved = resolve_prompt(prompt_registry.PROFILING_TURN_UNDERSTAND)
    system_prompt = resolved.text if resolved is not None else UNDERSTAND_SYSTEM_PROMPT
    content, meta = await router.run(
        UNDERSTAND_TASK_TYPE,
        messages=build_understand_messages(masked, system_prompt),
        mock_response=understand_logic.MOCK_RESPONSE,
        real_call_allowed=True,
        prompt=resolved,
    )
    # The metadata rides back on the response so the API records the spend against
    # `profiling_turn_understand` — and so it can tell a mock (`real_call` false) from a model.
    parsed = understand_logic.parse_understanding(content, body)
    return parsed.model_copy(update={"ai_metadata": meta})
