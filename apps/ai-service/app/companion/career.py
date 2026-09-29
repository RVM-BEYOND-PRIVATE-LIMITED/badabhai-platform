"""The career answer's output boundary (ADR-0046 Phase 3).

MODEL OUTPUT IS UNTRUSTED — AND HERE IT IS ALSO THE PRODUCT. This module turns the
model's raw content into either a :class:`CompanionCareerAnswer` or a
:class:`CompanionCareerRefuse`, and every failure mode — not JSON, not an object, an
unknown ``status``, a missing or empty ``lines`` list, a topic outside the closed set —
becomes the SAME fail-closed output: a refusal on ``unsafe_other``, whose copy is
reviewed text the API owns.

WHY A REFUSAL AND NOT NULL. ``None`` would be the API's "model unreachable" path, whose
outcome is the fallback line; a contract miss means we never got an answer to validate,
and a fixed refusal is the safer, more honest disposition: the worker is told this
question is outside what Bada Bhai answers, rather than handed a generic error. It is
also the disposition that cannot be wrong — a refusal carries no claim.

WHAT THIS MODULE DOES NOT DO. It does not judge content: the persona, refusal-backstop
and PII checks all live in the API's validator, AFTER this boundary, because they must
run on the answer the worker would actually read. A permissive parse here is deliberate:
a bad answer must reach the validator to be judged, not be rejected at the transport
with the same outcome and a worse diagnosis.
"""

from __future__ import annotations

import json

from pydantic import ValidationError

from ..contracts import CompanionCareerAnswer, CompanionCareerRefuse
from ..profiling.canonical_roles import coerce_json_text

#: The deterministic mock-posture answer: a refusal on the catch-all topic. A mock model
#: did not answer anything, and the refusal copy is reviewed text — the safest thing a
#: development environment can show a worker.
MOCK_RESPONSE = '{"status": "refuse", "topic": "unsafe_other"}'

#: What every unreadable output becomes. One constant, so "the contract missed" and "the
#: model declined" land on the same reviewed copy by construction.
REFUSED_FALLBACK = CompanionCareerRefuse(status="refuse", topic="unsafe_other")


def parse_career_output(content: str) -> CompanionCareerAnswer | CompanionCareerRefuse:
    """The model's content as a validated output, or :data:`REFUSED_FALLBACK`.

    ``coerce_json_text`` first, like every other model-JSON parser in this service: a
    markdown fence is not a refusal, and a conversational provider (or a human poking the
    endpoint) may wrap the object in one.

    The discriminant is read BEFORE validation so an ``answer`` payload cannot be coerced
    into a refusal shape or vice versa; anything that is neither validates the topic
    through the union member the model named, and every failure returns the constant.
    """
    try:
        raw = json.loads(coerce_json_text(content))
    except (TypeError, ValueError):
        return REFUSED_FALLBACK
    if not isinstance(raw, dict):
        return REFUSED_FALLBACK

    status = raw.get("status")
    try:
        if status == "answer":
            return CompanionCareerAnswer.model_validate(raw)
        if status == "refuse":
            return CompanionCareerRefuse.model_validate(raw)
    except ValidationError:
        return REFUSED_FALLBACK
    return REFUSED_FALLBACK
