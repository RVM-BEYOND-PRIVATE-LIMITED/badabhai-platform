"""The rolling summary's output boundary (ADR-0051 §8, Release 2).

MODEL OUTPUT IS UNTRUSTED, AND HERE IT IS KEPT INDEFINITELY (R23). This module is the one place
that turns the summarizer's raw content into a :class:`FreeChatSummarizeOutput`, and every failure
mode (not JSON, not an object, a missing or non-string ``summary``, an empty or placeholder-word
summary, one past the transport cap) produces the SAME value: ``summary=None``. Null means "keep
the previous summary": the API records it as ``unavailable`` and stores nothing, so a broken
model can cost a fold but never overwrite good notes with junk.

WHAT THIS MODULE DOES NOT DO. It does not judge content: the hard-identifier floor (G1), the
worker's own name, the ``{{``/``}}`` template check and the 1200-character storage cap are the
API's validation, AFTER this boundary, and each of those refusals is an event outcome of its own
(``rejected``). Refusing them here as well would report them as ``unavailable`` and hide the
reason, so a long or suspect summary is passed on to be judged where the outcome is recorded.

ONLY ONE FIELD IS THE MODEL'S. ``summary`` is read and nothing else: ``ai_metadata`` is what the
router measured, and a model that writes it is ignored.
"""

from __future__ import annotations

import json

from pydantic import ValidationError

from ..contracts import FreeChatSummarizeOutput
from ..profiling.canonical_roles import coerce_json_text

#: The deterministic mock-posture answer. Honest: a mock model kept no notes, and a null summary
#: is exactly what makes an unarmed task store nothing (ADR-0051 §8 "Arming"), so the route can
#: merge before the box arms it.
MOCK_RESPONSE = '{"summary": null}'

#: What every unreadable output becomes. One constant, so "the contract missed" and "the model
#: had nothing to keep" are the same value by construction.
NO_SUMMARY = FreeChatSummarizeOutput(summary=None)

#: Words a model writes INSTEAD of JSON null. Stored, one of these would be served back to every
#: reply as the worker's notes for as long as the account lives; read as null, it keeps the
#: previous summary. Compared after stripping and case-folding, whole value only.
_NULL_WORDS = frozenset({"null", "none", "n/a"})


def parse_summary_output(content: str) -> FreeChatSummarizeOutput:
    """The summarizer's content as a validated output, or :data:`NO_SUMMARY`.

    ``coerce_json_text`` first, like every other model-JSON parser in this service: a markdown
    fence is not a failure. The summary is stripped of surrounding whitespace (one that is only
    whitespace is no summary); its inner lines are left exactly as the model wrote them.
    """
    try:
        raw = json.loads(coerce_json_text(content))
    except (TypeError, ValueError):
        return NO_SUMMARY
    if not isinstance(raw, dict):
        return NO_SUMMARY
    summary = raw.get("summary")
    if not isinstance(summary, str):
        return NO_SUMMARY
    summary = summary.strip()
    if not summary or summary.casefold() in _NULL_WORDS:
        return NO_SUMMARY
    try:
        return FreeChatSummarizeOutput(summary=summary)
    except ValidationError:
        return NO_SUMMARY
