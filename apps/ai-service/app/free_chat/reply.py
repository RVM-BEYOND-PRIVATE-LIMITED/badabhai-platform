"""The free-chat reply's output boundary and its per-category prompt (ADR-0051 §3.3-§3.4).

MODEL OUTPUT IS UNTRUSTED, AND HERE IT IS ALSO WHAT THE WORKER READS. This module turns the
model's raw content into a :class:`FreeChatAnswer` or a :class:`FreeChatRefuse` through the
contract's ``status``-discriminated union, and every failure mode (not JSON, not an object, a
missing or unknown ``status``, missing or empty ``lines``, a topic outside the closed set)
becomes the SAME fail-closed output: a refusal on ``unsafe_other``, whose line is reviewed copy
the API owns (``REPLY_FALLBACK``).

WHAT THIS MODULE DOES NOT DO. It does not judge content: the persona, promise, sensitive-advice,
rating and PII checks live in the API's validator, AFTER this boundary, because they must run on
the answer the worker would actually read. A permissive parse is deliberate: a bad answer must
reach that validator to be judged, not be rejected here with the same outcome and a worse
diagnosis.

TWO PROMPTS, ONE TASK. The API sends the category it already decided (``casual`` or
``career``); :data:`REPLY_PROMPTS` maps it to its registry name and its local text. The model
never picks its own prompt.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from types import MappingProxyType

from pydantic import TypeAdapter, ValidationError

from ..ai import prompt_registry
from ..contracts import (
    CompanionCareerWorkerContext,
    FreeChatAnswer,
    FreeChatRefuse,
    FreeChatReplyCategory,
    FreeChatReplyOutput,
)
from ..llm_input_policy import llm_input_gate
from ..profiling.canonical_roles import coerce_json_text
from .prompts import CAREER_SYSTEM_PROMPT, CASUAL_SYSTEM_PROMPT

#: The deterministic mock-posture answer: a refusal on the catch-all topic. A mock model answered
#: nothing, and the refusal line is reviewed copy, the safest thing a dev environment can show.
MOCK_RESPONSE = '{"status": "refuse", "topic": "unsafe_other"}'

#: What every unreadable output becomes. One constant, so "the contract missed" and "the model
#: declined" land on the same reviewed copy by construction.
REFUSED_FALLBACK = FreeChatRefuse(status="refuse", topic="unsafe_other")

#: category -> (prompt registry name, local prompt text). Read-only, and exhaustive over
#: `FreeChatReplyCategory` (pinned by a test), so a new reply category cannot silently fall onto
#: the wrong prompt.
REPLY_PROMPTS: Mapping[FreeChatReplyCategory, tuple[str, str]] = MappingProxyType(
    {
        "casual": (prompt_registry.FREE_CHAT_CASUAL, CASUAL_SYSTEM_PROMPT),
        "career": (prompt_registry.FREE_CHAT_CAREER, CAREER_SYSTEM_PROMPT),
    }
)

_REPLY_OUTPUT: TypeAdapter[FreeChatAnswer | FreeChatRefuse] = TypeAdapter(FreeChatReplyOutput)


def mask_worker_context(
    context: CompanionCareerWorkerContext, *, raw: bool
) -> CompanionCareerWorkerContext:
    """The worker context as the model may see it: the trade label through the input gate.

    THE BELT ON A FIELD THE COMPANION TRUSTS. On the companion the label comes from a confirmed
    profile; in the profiling stage it is whatever the interview has captured so far, so it is
    gated like every other model input. A canonical label passes unchanged (measured: Welder,
    CNC Operator, CAD Draughtsman and 13 more), a label the gate refuses is DROPPED rather than
    sent, and the experience bucket is a closed enum with nothing in it to mask. ``raw`` is the
    route's `AI_RAW_PII_ENABLED`, passed in and never read here.
    """
    if context.trade_label is None:
        return context
    result = llm_input_gate(context.trade_label, raw=raw)
    return context.model_copy(update={"trade_label": None if result.blocked else result.text})


def parse_reply_output(content: str) -> FreeChatAnswer | FreeChatRefuse:
    """The model's content as a validated union member, or :data:`REFUSED_FALLBACK`.

    The union is discriminated on ``status``, so an ``answer`` payload can never be coerced into
    a refusal shape or the reverse. ``ai_metadata`` is the router's, never the model's, and is
    dropped before validation so a junk value there cannot cost an otherwise valid answer.
    """
    try:
        raw = json.loads(coerce_json_text(content))
    except (TypeError, ValueError):
        return REFUSED_FALLBACK
    if not isinstance(raw, dict):
        return REFUSED_FALLBACK
    raw.pop("ai_metadata", None)
    try:
        return _REPLY_OUTPUT.validate_python(raw)
    except ValidationError:
        return REFUSED_FALLBACK
