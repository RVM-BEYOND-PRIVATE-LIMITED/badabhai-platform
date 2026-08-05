"""The strict JSON contract for one LLM-driven chat turn.

WHY A SCHEMA AND NOT PROSE. The turn has to carry four things at once: the line the
worker reads, the tap-to-answer chips, what the model learned this turn, and whether it
thinks the interview is done. A prose reply could only carry the first, and the old
design got away with that because a deterministic engine already knew everything else.
It no longer does, so the turn is structured.

`json_mode` is already ON for this route, and the route's `responseMimeType` forces a
bare JSON object - without it the model writes a chatty preamble BEFORE the JSON and
intermittently exhausts the token budget, which surfaces as a silent fallback rather
than an error.

NOTHING HERE IS TRUSTED. `is_complete` is ADVISORY - the endpoint decides, because a
model told "say when you have enough" will say so on turn two for a terse worker, and
completion is irreversible downstream. `captured` is filtered against the closed field
vocabulary. `chips` are bounded and stripped. The model proposes; the service decides.
"""

from __future__ import annotations

import json

from pydantic import BaseModel, Field

from .persona import MAX_CHIPS


class LlmChatTurn(BaseModel):
    """What the model must return, every turn."""

    reply: str = Field(description="The line the worker reads. One question, under 20 words.")
    chips: list[str] = Field(
        default_factory=list,
        description="Tap-to-answer options for THIS question. Short. Empty if open-ended.",
    )
    asked_field: str | None = Field(
        default=None,
        description="The Resume Field Set id this turn is asking about.",
    )
    captured: dict[str, str] = Field(
        default_factory=dict,
        description="Field ids the worker has now answered, mapped to a SHORT value.",
    )
    is_complete: bool = Field(
        default=False,
        description="ADVISORY. True when every required field has been collected.",
    )


# The JSON shape, embedded in the static system block. Kept as a literal rather than
# generated from the model, because it lives inside the byte-stable cached prefix and
# `model_json_schema()` output can shift between pydantic versions - which would break
# prompt caching silently, with no error and no test failure.
SCHEMA_HINT = f"""Reply with a single JSON object, nothing else:
{{
  "reply":        "<at most a 3-word acknowledgement, then ONE question under 20 words>",
  "chips":        ["<short option>", "..."],   // 0 to {MAX_CHIPS}. [] if open-ended.
  "asked_field":  "<the field id this question is about, or null>",
  "captured":     {{"<field id>": "<short value the worker just gave>"}},
  "is_complete":  false
}}

CHIPS are how a worker who cannot type easily answers you, so offer them whenever the
answer is from a small set (a machine name, a city, yes/no, a notice period). Never
offer chips for a genuinely open question. Never put a full sentence in a chip.

CAPTURED is cumulative-by-turn: include every field the worker answered in THIS message,
even if they answered three things at once. Use the field ids exactly as given. Keep
values short - "VMC operator", "5 saal", "Pune", not a sentence.

IS_COMPLETE is true only when every required field has a value."""


def _clean_line(text: object) -> str:
    return " ".join(str(text or "").split())


def coerce_turn(raw: str) -> LlmChatTurn | None:
    """Parse the model's response into a turn, or None if it is unusable.

    Tolerates a markdown fence, because a model in json_mode still occasionally wraps
    its object in ```json - and throwing away an otherwise-good turn over three
    backticks would spend a real call for nothing.

    Returns None rather than raising: the caller falls back to a safe turn, and the
    router's never-raise contract holds all the way to the worker.
    """
    text = (raw or "").strip()
    if not text:
        return None
    if text.startswith("```"):
        # ```json\n{...}\n```  ->  {...}
        text = text.split("\n", 1)[-1] if "\n" in text else text
        text = text.rsplit("```", 1)[0].strip()
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        turn = LlmChatTurn.model_validate(data)
    except Exception:  # noqa: BLE001 - any validation failure means "use the fallback"
        return None

    turn.reply = _clean_line(turn.reply)
    if not turn.reply:
        return None
    # Bound and tidy the chips here rather than trusting the prompt: an over-long chip
    # breaks the Flutter layout, and a duplicate chip reads as a bug to the worker.
    seen: set[str] = set()
    chips: list[str] = []
    for chip in turn.chips:
        c = _clean_line(chip)
        if not c or len(c) > 40:
            continue
        key = c.lower()
        if key in seen:
            continue
        seen.add(key)
        chips.append(c)
        if len(chips) >= MAX_CHIPS:
            break
    turn.chips = chips
    return turn


# ---------------------------------------------------------------------------
# The degraded turn
# ---------------------------------------------------------------------------
# The router NEVER raises - it always returns `mock_response`. With the question bank
# deleted there is no templated question behind that any more, so `mock_response` has to
# be a valid turn in its own right. Three properties it must have:
#
#   1. JSON-SHAPED, because the endpoint parses the router's return as the model's JSON.
#      One parse path, no "prose or JSON?" branch.
#   2. ADVANCES NOTHING. It captures no field and claims no completion, so a provider
#      outage costs a turn, never a topic.
#   3. PERSONA-CONFORMANT and free of any {{worker_name}} token - no vocative on a
#      degraded turn.

_FALLBACK_REPLY = "Theek hai. Thoda aur bataiye — aap kya kaam karte hain?"


def fallback_turn(asked_field: str | None = "trade") -> LlmChatTurn:
    """A safe, content-free continuation for when the model is unreachable or its
    output could not be repaired into something on-persona."""
    return LlmChatTurn(
        reply=_FALLBACK_REPLY,
        chips=[],
        asked_field=asked_field,
        captured={},
        is_complete=False,
    )


def fallback_turn_json(asked_field: str | None = "trade") -> str:
    """The fallback as the `mock_response` string the router expects."""
    return fallback_turn(asked_field).model_dump_json()
