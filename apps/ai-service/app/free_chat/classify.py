"""The free-chat classifier's output boundary (ADR-0051 §3.2, §11 R42).

MODEL OUTPUT IS UNTRUSTED. This module is the one place that turns the classifier's raw content
into a :class:`FreeChatClassifyOutput`, and every failure mode (not JSON, not an object, a
category outside the closed set, a confidence outside 0..1, a missing key) produces the SAME
fail-closed answer: ``unclear`` with confidence 0 and no language. In free mode the API answers
that with its clarify line; in résumé mode the API only acts on a real verdict, so an outage never
degrades the live interview.

THREE FIELDS ARE THE MODEL'S. ``category`` and ``confidence`` are validated together, and the
whole output fails closed when either misses. ``language`` (R42) is read APART, after them: a
label outside the closed reply-language set, a missing one or a non-string becomes ``None``,
which leaves the API's word-list detection in force, and never costs an otherwise valid category.
``blocked`` reports that the input gate refused the message, and ``ai_metadata`` is what the
router measured. A model that returns either is ignored, because a model must not be able to
claim a safety event or a cost it did not have, and a junk value in a field that is not its own
must not cost an otherwise valid category.
"""

from __future__ import annotations

import json
from typing import get_args

from pydantic import ValidationError

from ..contracts import FreeChatClassifyOutput, FreeChatReplyLanguage
from ..profiling.canonical_roles import coerce_json_text

#: The deterministic mock-posture answer. Honest: a mock model classified nothing, and named no
#: language. The router also serves it when every provider fails, with ``real_call`` TRUE and
#: ``success`` false, which is why the API's real-verdict test needs ``success`` as well as
#: ``real_call``: either way the API reads it as "unavailable", whatever this says.
MOCK_RESPONSE = '{"category": "unclear", "confidence": 0.0}'

#: What every unreadable output becomes. One constant, so "the contract missed" and "the model
#: said unclear" are the same value by construction. Its ``language`` is ``None``.
UNCLEAR = FreeChatClassifyOutput(category="unclear", confidence=0.0, blocked=False)

#: The keys whose validation decides the whole output. Everything else in its object is dropped
#: before validation; ``language`` is read on its own by :func:`parse_language`.
_MODEL_FIELDS = ("category", "confidence")

#: The closed reply-language set (`FREE_CHAT_REPLY_LANGUAGES`), the only labels a language may be.
LANGUAGES: frozenset[str] = frozenset(get_args(FreeChatReplyLanguage))


def parse_language(value: object) -> FreeChatReplyLanguage | None:
    """The model's language label as one of the closed set, or ``None``.

    Case and surrounding whitespace are forgiven ("Marathi " is marathi): the label only selects
    one of seven fixed lines from a closed table, so there is nothing to inject. Anything else
    (another language, "hindi", a list, a number, a sentence) is ``None``, never a near miss.
    """
    if not isinstance(value, str):
        return None
    label = value.strip().casefold()
    return label if label in LANGUAGES else None  # type: ignore[return-value]


def parse_classify_output(content: str) -> FreeChatClassifyOutput:
    """The classifier's content as a validated output, or :data:`UNCLEAR`.

    ``coerce_json_text`` first, like every other model-JSON parser in this service: a markdown
    fence is not a classification failure. The language is attached only to an output whose
    category and confidence passed, so a contract miss carries no label from the same text.
    """
    try:
        raw = json.loads(coerce_json_text(content))
    except (TypeError, ValueError):
        return UNCLEAR
    if not isinstance(raw, dict):
        return UNCLEAR
    try:
        parsed = FreeChatClassifyOutput.model_validate(
            {key: raw[key] for key in _MODEL_FIELDS if key in raw}
        )
    except ValidationError:
        return UNCLEAR
    return parsed.model_copy(update={"language": parse_language(raw.get("language"))})
