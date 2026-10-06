"""The free-chat classifier's output boundary (ADR-0051 §3.2).

MODEL OUTPUT IS UNTRUSTED. This module is the one place that turns the classifier's raw content
into a :class:`FreeChatClassifyOutput`, and every failure mode (not JSON, not an object, a
category outside the closed set, a confidence outside 0..1, a missing key) produces the SAME
fail-closed answer: ``unclear`` with confidence 0. In free mode the API answers that with its
clarify line; in résumé mode the API only acts on a real verdict, so an outage never degrades
the live interview.

ONLY TWO FIELDS ARE THE MODEL'S. ``category`` and ``confidence`` are read from the output and
nothing else: ``blocked`` reports that the input gate refused the message, and ``ai_metadata``
is what the router measured. A model that returns either is ignored, because a model must not be
able to claim a safety event or a cost it did not have, and a junk value in a field that is not
its own must not cost an otherwise valid category.
"""

from __future__ import annotations

import json

from pydantic import ValidationError

from ..contracts import FreeChatClassifyOutput
from ..profiling.canonical_roles import coerce_json_text

#: The deterministic mock-posture answer. Honest: a mock model classified nothing, and the API
#: reads an unarmed task (``real_call`` false) as "unavailable" whatever this says.
MOCK_RESPONSE = '{"category": "unclear", "confidence": 0.0}'

#: What every unreadable output becomes. One constant, so "the contract missed" and "the model
#: said unclear" are the same value by construction.
UNCLEAR = FreeChatClassifyOutput(category="unclear", confidence=0.0, blocked=False)

#: The keys the model may supply. Everything else in its object is dropped before validation.
_MODEL_FIELDS = ("category", "confidence")


def parse_classify_output(content: str) -> FreeChatClassifyOutput:
    """The classifier's content as a validated output, or :data:`UNCLEAR`.

    ``coerce_json_text`` first, like every other model-JSON parser in this service: a markdown
    fence is not a classification failure.
    """
    try:
        raw = json.loads(coerce_json_text(content))
    except (TypeError, ValueError):
        return UNCLEAR
    if not isinstance(raw, dict):
        return UNCLEAR
    try:
        return FreeChatClassifyOutput.model_validate(
            {key: raw[key] for key in _MODEL_FIELDS if key in raw}
        )
    except ValidationError:
        return UNCLEAR
