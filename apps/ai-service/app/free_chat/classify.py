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

THE COMPANION SURFACE (ADR-0055, #2275) adds a fourth field, ``resume_action``, read apart like
``language`` and only where it means something: on the companion surface AND on a ``resume``
verdict. Anywhere else (the profiling surface, any other category, a label outside the closed
set) it is ``None``, which leaves the companion's deterministic résumé menu to ask. The surface
also picks the prompt (:data:`CLASSIFY_PROMPTS`); the model never picks its own.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from types import MappingProxyType
from typing import get_args

from pydantic import ValidationError

from ..ai import prompt_registry
from ..contracts import (
    FreeChatCategory,
    FreeChatClassifyOutput,
    FreeChatReplyLanguage,
    FreeChatResumeAction,
    FreeChatSurface,
)
from ..profiling.canonical_roles import coerce_json_text
from .prompts import CLASSIFY_SYSTEM_PROMPT, COMPANION_CLASSIFY_SYSTEM_PROMPT, SurfacePrompt

#: surface -> the classifier's :class:`SurfacePrompt`. Read-only, and exhaustive over
#: `FreeChatSurface` (pinned by a test), so a new surface cannot silently fall onto the wrong
#: prompt. The task is ``profiling_free_classify`` on both: only the prompt and its name differ.
CLASSIFY_PROMPTS: Mapping[FreeChatSurface, SurfacePrompt] = MappingProxyType(
    {
        "profiling": SurfacePrompt(prompt_registry.FREE_CHAT_CLASSIFY, CLASSIFY_SYSTEM_PROMPT),
        "companion": SurfacePrompt(
            prompt_registry.FREE_CHAT_CLASSIFY_COMPANION, COMPANION_CLASSIFY_SYSTEM_PROMPT
        ),
    }
)

#: The deterministic mock-posture answer, on both surfaces. Honest: a mock model classified
#: nothing, and named no language and no résumé action. The router also serves it when every
#: provider fails, with ``real_call`` TRUE and ``success`` false, which is why the API's
#: real-verdict test needs ``success`` as well as ``real_call``: either way the API reads it as
#: "unavailable", whatever this says.
MOCK_RESPONSE = '{"category": "unclear", "confidence": 0.0}'

#: What every unreadable output becomes. One constant, so "the contract missed" and "the model
#: said unclear" are the same value by construction. Its ``language`` and ``resume_action`` are
#: ``None``.
UNCLEAR = FreeChatClassifyOutput(category="unclear", confidence=0.0, blocked=False)

#: The keys whose validation decides the whole output. Everything else in its object is dropped
#: before validation; ``language`` and ``resume_action`` are read on their own, by
#: :func:`parse_language` and :func:`parse_resume_action`.
_MODEL_FIELDS = ("category", "confidence")

#: The closed reply-language set (`FREE_CHAT_REPLY_LANGUAGES`), the only labels a language may be.
LANGUAGES: frozenset[str] = frozenset(get_args(FreeChatReplyLanguage))

#: The closed résumé-action set (`FREE_CHAT_RESUME_ACTIONS`, ADR-0055), the only labels an action
#: may be.
RESUME_ACTIONS: frozenset[str] = frozenset(get_args(FreeChatResumeAction))

#: The one category a résumé action belongs to. On any other verdict the action is dropped, so a
#: model that writes one beside `jobs` or `career` can never steer the companion's résumé menu.
_RESUME_CATEGORY: FreeChatCategory = "resume"


def _closed_label(value: object, labels: frozenset[str]) -> str | None:
    """``value`` as one of ``labels``, forgiving case and surrounding whitespace, or ``None``."""
    if not isinstance(value, str):
        return None
    label = value.strip().casefold()
    return label if label in labels else None


def parse_language(value: object) -> FreeChatReplyLanguage | None:
    """The model's language label as one of the closed set, or ``None``.

    Case and surrounding whitespace are forgiven ("Marathi " is marathi): the label only selects
    one of seven fixed lines from a closed table, so there is nothing to inject. Anything else
    (another language, "hindi", a list, a number, a sentence) is ``None``, never a near miss.
    """
    return _closed_label(value, LANGUAGES)  # type: ignore[return-value]


def parse_resume_action(value: object) -> FreeChatResumeAction | None:
    """The model's résumé action as one of the closed set, or ``None`` (ADR-0055).

    Forgiving exactly as :func:`parse_language` is ("Download " is download): the label only
    picks one of three fixed companion handlers. Anything else ("null" as a string, "update", a
    list, a number) is ``None``, the companion's "ask with the résumé menu", never a near miss.
    """
    return _closed_label(value, RESUME_ACTIONS)  # type: ignore[return-value]


def parse_classify_output(
    content: str, *, surface: FreeChatSurface = "profiling"
) -> FreeChatClassifyOutput:
    """The classifier's content as a validated output, or :data:`UNCLEAR`.

    ``coerce_json_text`` first, like every other model-JSON parser in this service: a markdown
    fence is not a classification failure. The language is attached only to an output whose
    category and confidence passed, so a contract miss carries no label from the same text.

    The résumé action (ADR-0055) is attached on the same terms, and only on the companion surface
    to a ``resume`` verdict: the profiling prompt never asks for one, so a stray key there is
    ignored, and on any other category the API has no résumé menu for it to steer.
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
    reads_action = surface == "companion" and parsed.category == _RESUME_CATEGORY
    action = parse_resume_action(raw.get("resume_action")) if reads_action else None
    return parsed.model_copy(
        update={"language": parse_language(raw.get("language")), "resume_action": action}
    )
