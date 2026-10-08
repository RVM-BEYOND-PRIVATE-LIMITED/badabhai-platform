"""The profiling-stage free chat routes (ADR-0051, #2027).

``POST /free-chat/classify``: one typed message, in free or résumé mode, to one closed category.
``POST /free-chat/reply``: one casual or career message to 1-4 short Hinglish lines, or a closed
refusal topic. Both mirror the companion routes (ADR-0046), on a different surface.
``POST /free-chat/summarize`` (Release 2, §8): the free-chat turns that aged out of the reply's
window, folded with the previous notes into the rolling summary the reply reads (R21-R24).
``POST /free-chat/news`` (ADR-0054): a news question the reply refused on ``news``, answered by
Claude with the web search tool on the approved sites, with sources built from the response.

THE PRIVACY ORDER IS THE COMPANION'S, AND IT FAILS CLOSED: the masking policy in force
(`AI_RAW_PII_ENABLED`, ADR-0047) BEFORE the model, through `app/llm_input_policy.py`, for every
model input: the message, the question on screen, the recent turns, the trade label, the reply's
summary and the summarizer's previous summary and turns. A blocked message or question reaches
no provider and returns the deterministic fail-closed output: ``unclear`` with ``blocked=True``
(which the API reads as "unavailable": the interview in résumé mode, the clarify line in free
mode) or a refusal on ``unsafe_other`` (the API's fallback line). A turn, a trade label or a
summary the gate refuses is dropped, not sent; a fold left with no turn makes no call and returns
a null summary, which keeps the previous one.

``ai_metadata`` IS RETURNED, NEVER DISCARDED. The API records the spend from it, and counts a
classification as REAL only when ``ai_metadata.real_call`` is true AND ``ai_metadata.success``
is true AND ``blocked`` is false. So the metadata rides back exactly as the router measured it:
``real_call`` false for an unarmed mock, ``real_call`` true with ``success`` false when every
provider failed and the router served the mock, and ``ai_metadata`` None when the gate blocked
the input and no provider was reached at all.

MODEL OUTPUT IS UNTRUSTED AND THE ROUTES RETURN IT AS PARSED: the parsers in ``app.free_chat``
validate and fall back, and the API re-validates every reply and news line before a worker reads
it. Nothing here decides or writes anything.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..ai import prompt_registry
from ..companion.classify import mask_recent_turns
from ..config import get_settings
from ..contracts import (
    FreeChatAnswer,
    FreeChatClassifyInput,
    FreeChatClassifyOutput,
    FreeChatNewsAnswer,
    FreeChatNewsInput,
    FreeChatNewsNoResults,
    FreeChatNewsOutput,
    FreeChatNewsRefuse,
    FreeChatRefuse,
    FreeChatReplyInput,
    FreeChatReplyOutput,
    FreeChatSummarizeInput,
    FreeChatSummarizeOutput,
)
from ..free_chat import classify as classify_logic
from ..free_chat import news as news_logic
from ..free_chat import reply as reply_logic
from ..free_chat import summary as summary_logic
from ..free_chat.prompts import (
    CLASSIFY_SYSTEM_PROMPT,
    NEWS_SYSTEM_PROMPT,
    SUMMARY_SYSTEM_PROMPT,
    build_free_classify_messages,
    build_free_news_messages,
    build_free_reply_messages,
    build_free_summary_messages,
)
from ..llm_input_policy import llm_input_gate
from ..pseudonymize import PseudonymizationResult
from ._shared import logger, resolve_prompt, router

api_router = APIRouter()

# The AIRouter task types, registered in `app/ai/model_config.py` (route + an explicit branch)
# and in the `aiTaskType` cost enum (packages/event-schema). Named apart from the companion's
# constants so a source scan that maps a constant to its task never confuses the two.
FREE_CLASSIFY_TASK_TYPE = "profiling_free_classify"
FREE_REPLY_TASK_TYPE = "profiling_free_reply"
FREE_SUMMARY_TASK_TYPE = "profiling_free_summary"
FREE_NEWS_TASK_TYPE = "profiling_free_news"


def _first_refusal(**gated: PseudonymizationResult | None) -> tuple[str, str | None] | None:
    """The first input the gate refused, as (field name, the gate's closed reason), or None.

    Field names and the gate's reason vocabulary only: the refused TEXT never reaches a log.
    """
    for field, result in gated.items():
        if result is not None and result.blocked:
            return field, result.blocked_reason
    return None


def _gated_summary(text: str | None, *, raw: bool, route: str, field: str) -> str | None:
    """A stored summary as the model may see it, or ``None`` when there is none or it is refused.

    DROPPED, NOT BLOCKING, on both routes. A reply without its notes is still a good reply. And
    a fold whose previous notes the gate refuses can only replace them: the reply route refuses the
    same notes under the same posture, so they are already unusable, and blocking the fold instead
    would freeze them forever. ``raw`` is the route's `AI_RAW_PII_ENABLED`; the log names the
    route, the field and the gate's closed reason, never the text.
    """
    if text is None:
        return None
    result = llm_input_gate(text, raw=raw)
    if not result.blocked:
        return result.text
    logger.warning(
        "free chat summary dropped",
        extra={"extra": {"route": route, "field": field, "reason": result.blocked_reason}},
    )
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
    reply_prompt = reply_logic.REPLY_PROMPTS[body.category]
    resolved = resolve_prompt(reply_prompt.name)
    system_prompt = resolved.text if resolved is not None else reply_prompt.text
    messages = build_free_reply_messages(
        result.text,
        mask_recent_turns(body.recent_turns, raw=raw_pii),
        reply_logic.mask_worker_context(body.worker_context, raw=raw_pii),
        # R24: the reply reads the rolling summary (the classifier never does).
        _gated_summary(body.summary, raw=raw_pii, route="reply", field="summary"),
        system_prompt,
        message_label=reply_prompt.message_label,
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


@api_router.post("/free-chat/summarize", response_model=FreeChatSummarizeOutput)
async def free_chat_summarize(body: FreeChatSummarizeInput) -> FreeChatSummarizeOutput:
    """Fold aged-out free-chat turns into the rolling summary, or return null to keep the old one.

    THE API CALLS THIS AFTER THE REPLY IS SERVED, never on the worker's critical path, and stores
    a non-null summary only after its own validation (§8). Null is every "nothing usable" case:
    the unarmed mock, every turn refused by the gate, a failed call, an unreadable output.
    """
    raw_pii = get_settings().ai_raw_pii_enabled
    # A refused turn is DROPPED (the companion's helper), and so is one that is only whitespace:
    # it would render as nothing, and a fold of nothing must not be paid for.
    turns = [t for t in mask_recent_turns(body.turns, raw=raw_pii) if t.text.strip()]
    if not turns:
        logger.warning(
            "free chat summarize blocked",
            extra={"extra": {"field": "turns", "dropped": len(body.turns)}},
        )
        # Fail closed: no provider call, so no cost to record, and a null summary keeps the
        # previous one. Never a fold over the previous notes alone, which could only restate them.
        return FreeChatSummarizeOutput(summary=None, ai_metadata=None)

    previous = _gated_summary(
        body.previous_summary, raw=raw_pii, route="summarize", field="previous_summary"
    )
    resolved = resolve_prompt(prompt_registry.FREE_CHAT_SUMMARY)
    system_prompt = resolved.text if resolved is not None else SUMMARY_SYSTEM_PROMPT
    content, meta = await router.run(
        FREE_SUMMARY_TASK_TYPE,
        messages=build_free_summary_messages(previous, turns, system_prompt),
        mock_response=summary_logic.MOCK_RESPONSE,
        real_call_allowed=True,
        prompt=resolved,
    )
    parsed = summary_logic.parse_summary_output(content)
    return parsed.model_copy(update={"ai_metadata": meta})


@api_router.post("/free-chat/news", response_model=FreeChatNewsOutput)
async def free_chat_news(
    body: FreeChatNewsInput,
) -> FreeChatNewsAnswer | FreeChatNewsNoResults | FreeChatNewsRefuse:
    """One news question to a searched answer with its sources, ``no_results``, or a refusal.

    THE REPLY'S PRIVACY ORDER, AND ITS FAIL-CLOSED SHAPE: the message, the recent turns and the
    trade label pass the masking policy in force before the model; a blocked message reaches no
    provider and returns ``refuse/unsafe_other`` with ``ai_metadata`` None. So does a question
    carrying a hard identifier (owner ruling R9), whatever the posture. The search tool is
    attached here and nowhere else, so this is the only route whose call can read the web, and
    the call is charged to the worker's daily spend cap through ``worker_ref``.

    WHAT THE API READS (ADR-0054 §3.1). ``ai_metadata`` rides back exactly as the router measured
    it. ``real_call`` false is the unarmed mock (``no_results``, ``search_count`` 0): the API keeps
    today's NEWS line. ``real_call`` true with ``success`` false is a failed call (timeout, error)
    wearing the same mock: unavailable. Only ``real_call`` AND ``success`` make the status a real
    verdict. Every failure here is a value, never an exception: the API waits on this call.
    """
    raw_pii = get_settings().ai_raw_pii_enabled
    result = llm_input_gate(body.text, raw=raw_pii)
    if result.blocked:
        logger.warning("free chat news blocked", extra={"extra": {"reason": result.blocked_reason}})
        # Fail closed: reviewed refusal copy, no provider call, so no cost to record.
        return FreeChatNewsRefuse(status="refuse", topic="unsafe_other", ai_metadata=None)
    # OWNER RULING R9 (2026-10-08): a question carrying a hard identifier is NEVER searched,
    # under either posture, because a search query leaves for the web. Read off the worker's own
    # text (the masked copy would hide the identifier behind a placeholder), after the gate and
    # before any model call; the same fail-closed shape as a blocked input.
    identifier = news_logic.question_identifier(body.text)
    if identifier is not None:
        logger.warning(
            "free chat news refused: hard identifier in the question",
            extra={"extra": {"reason": "hard_identifier", "class": identifier}},
        )
        return FreeChatNewsRefuse(status="refuse", topic="unsafe_other", ai_metadata=None)

    resolved = resolve_prompt(prompt_registry.FREE_CHAT_NEWS)
    system_prompt = resolved.text if resolved is not None else NEWS_SYSTEM_PROMPT
    messages = build_free_news_messages(
        result.text,
        mask_recent_turns(body.recent_turns, raw=raw_pii),
        reply_logic.mask_worker_context(body.worker_context, raw=raw_pii),
        # The day in India, computed here: never a value from the request.
        news_logic.ist_today(),
        system_prompt,
    )
    content, meta, llm_result = await router.run_with_result(
        FREE_NEWS_TASK_TYPE,
        messages=messages,
        mock_response=news_logic.MOCK_RESPONSE,
        real_call_allowed=True,
        # H2: the per-worker daily spend cap applies to this paid, searched call, as on
        # /profile/parse. The opaque ref keys the ledger only; it is never in the messages.
        user_ref=body.worker_ref,
        prompt=resolved,
        tools=news_logic.news_search_tools(),
    )
    try:
        parsed = news_logic.parse_news_output(content, llm_result)
    except Exception as exc:  # pragma: no cover - the parser is total; this is the seam's belt
        # The class name only: an exception here could carry a URL, a title or model text.
        logger.warning(
            "free chat news parse failed", extra={"extra": {"error_class": type(exc).__name__}}
        )
        parsed = news_logic.REFUSED_FALLBACK
    return parsed.model_copy(update={"ai_metadata": meta})
