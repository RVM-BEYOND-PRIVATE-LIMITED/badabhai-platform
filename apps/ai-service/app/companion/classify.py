"""The classifier's output boundary (ADR-0046 Phase 1).

MODEL OUTPUT IS UNTRUSTED. This module is the one place that turns the classifier's
raw content into a :class:`CompanionClassifyOutput`, and every failure mode — not
JSON, not an object, an intent outside the closed set, a confidence outside 0..1,
a missing key — produces the SAME fail-closed answer: ``unclear`` with confidence 0.
The API then answers with its clarify line, which is exactly what a low-confidence
classification gets, so a broken model degrades into the ordinary "samajh nahi aaya"
path rather than an error.

THE BLOCK FLAG IS OURS, NEVER THE MODEL'S. ``blocked`` reports that the pseudonymizer
refused the input; a model that returns ``blocked: true`` is ignored (forced False)
because a model must not be able to claim a safety event it did not have.
"""

from __future__ import annotations

import json

from pydantic import ValidationError

from ..contracts import CompanionClassifyOutput, CompanionRecentTurn
from ..profiling.canonical_roles import coerce_json_text
from ..pseudonymize import pseudonymize

#: The deterministic mock-posture answer: no intent, no confidence. Honest — a mock
#: model did not classify anything, and the API's treatment of an unclear turn is the
#: clarify line, which is also the safest thing a development environment can show.
MOCK_RESPONSE = '{"intent": "unclear", "confidence": 0.0}'

#: What every unreadable output becomes. One constant, so "the contract missed" and
#: "the model said unclear" are the same value by construction.
UNCLEAR = CompanionClassifyOutput(intent="unclear", confidence=0.0, blocked=False)


def mask_recent_turns(turns: list[CompanionRecentTurn]) -> list[CompanionRecentTurn]:
    """Pseudonymize the memory turns, or drop the ones that will not pass.

    THE MEMORY IS ALREADY PSEUDONYMIZED AT REST (O13: Redis holds what the AI service
    returned), and this is the belt: the invariant is that EVERY model input passes the
    gateway, so the one path that could grow a bug — a caller sending raw text into
    ``recent_turns`` — is closed here rather than trusted. A turn the gateway refuses is
    DROPPED, not sent: fail closed, and the classifier still gets the current message.
    """
    masked: list[CompanionRecentTurn] = []
    for turn in turns:
        result = pseudonymize(turn.text)
        if result.blocked:
            continue
        masked.append(turn.model_copy(update={"text": result.text}))
    return masked


def parse_classify_output(content: str) -> CompanionClassifyOutput:
    """The classifier's content as a validated output, or :data:`UNCLEAR`.

    ``coerce_json_text`` first, for the same reason every other model-JSON parser in this
    service uses it: a conversational provider (or a human poking the endpoint) may wrap
    the object in a markdown fence, and a fence is not a classification failure.
    """
    try:
        raw = json.loads(coerce_json_text(content))
    except (TypeError, ValueError):
        return UNCLEAR
    if not isinstance(raw, dict):
        return UNCLEAR
    try:
        parsed = CompanionClassifyOutput.model_validate(raw)
    except ValidationError:
        return UNCLEAR
    # `blocked` is the pseudonymizer's fact. A model cannot assert it.
    return parsed.model_copy(update={"blocked": False})
