"""The profiling turn's understanding — its input masking and output boundary (ADR-0057, #2309).

ONE CALL PER TYPED PROFILING-CHAT MESSAGE. The model reads the message against the session's whole
profiling schema and answers with what the message is doing (one closed intent), every value the
worker volunteered (`fills`), every change asked of an already-filled field (`edits`) and the
Profile-page facts it merely mentioned. This module is everything around that call that is not
the prompt: what the model may see, and what of its answer may leave.

MODEL OUTPUT IS UNTRUSTED, AND IT IS CONTAINED HERE TO THE REQUEST ITSELF:
  - a fill or an edit must name a key the request's `schema_rows` carried;
  - an edit of a `list` field must name a ref from THAT row's entries, and any other edit none;
  - an edit or delete must address a field that HAS a value — filling an empty field is a fill,
    never an edit (R4), so an "edit" of an empty scalar becomes a fill and one of an empty list is
    dropped;
  - a mention must be one of the request's `page_owned` names;
  - every value passes the G1 output floor (`carries_hard_identifier`) and the placeholder check:
    a value carrying a masking token is the gateway's output, not the worker's words.
Rows are dropped ONE BY ONE — one unreadable row never costs the others — and the caps truncate,
so a model that over-delivers still yields what the worker said first. This is containment
against the request, not policy: the API re-validates every key, op, ref and value against its
own catalogue and parsers (#2311), and nothing here is applied by anyone.

WHAT THIS MODULE DOES NOT DO: normalise a value (the API runs it through the same parsers a typed
answer goes through), decide whether a value differs from the stored one (the API's rule), or
read any flag (`raw` is the route's `AI_RAW_PII_ENABLED`, passed in).
"""

from __future__ import annotations

import json
from typing import get_args

from pydantic import ValidationError

from ..contracts import (
    CompanionRecentTurn,
    ProfilingEdit,
    ProfilingFill,
    ProfilingOnScreen,
    ProfilingSchemaRow,
    ProfilingTurnIntent,
    ProfilingTurnUnderstandInput,
    ProfilingTurnUnderstandOutput,
)
from ..llm_input_policy import llm_input_gate
from ..output_floor import carries_hard_identifier
from ..pseudonymize import TokenScope
from ..resume_import.parse_policy import contains_mask_placeholder
from .canonical_roles import coerce_json_text

#: The deterministic mock-posture answer: nothing understood, nothing proposed. The API reads a
#: mock (`ai_metadata.real_call` false) as unavailable and runs today's pipeline for the turn.
MOCK_RESPONSE = (
    '{"intent": "unclear", "confidence": 0, "fills": [], "edits": [], "page_owned_mentions": []}'
)

#: The output caps — the contract's own bounds, read from it so the two cannot drift.
MAX_FILLS = ProfilingTurnUnderstandOutput.model_fields["fills"].metadata[0].max_length
MAX_EDITS = ProfilingTurnUnderstandOutput.model_fields["edits"].metadata[0].max_length

_INTENTS = frozenset(get_args(ProfilingTurnIntent))


def mask_request(
    body: ProfilingTurnUnderstandInput,
    *,
    raw: bool,
    scope: TokenScope,
) -> ProfilingTurnUnderstandInput:
    """Every worker-derived string the model is shown, through the gateway.

    THE INVARIANT: every model input passes the gateway — the turns, the question on screen and
    every schema value, not only the message (which the route gates itself, first). ONE token
    scope for the whole request, so "the Bajaj job" in the message and in an entry carry the same
    placeholder and two employers never share one (`mask_snapshot`'s rule in the companion).

    A refused value is NULLED, a refused entry or turn is DROPPED, and a refused on-screen question
    is dropped whole: the model still sees every key, so it can still address a field — it just
    never reads the words the gateway refused. ``raw`` (ADR-0047) sends them unmasked but
    size-capped, and then only the cap refuses.
    """

    def gated(text: str) -> str | None:
        result = llm_input_gate(text, raw=raw, scope=scope)
        return None if result.blocked else result.text

    turns: list[CompanionRecentTurn] = []
    for turn in body.recent_turns:
        text = gated(turn.text)
        if text:
            turns.append(turn.model_copy(update={"text": text}))

    on_screen: ProfilingOnScreen | None = None
    if body.on_screen is not None:
        text = gated(body.on_screen.text)
        if text:
            on_screen = body.on_screen.model_copy(update={"text": text})

    rows: list[ProfilingSchemaRow] = []
    for row in body.schema_rows:
        value = gated(row.value) if row.value is not None else None
        entries = []
        for entry in row.entries:
            entry_value = gated(entry.value)
            if entry_value:
                entries.append(entry.model_copy(update={"value": entry_value}))
        rows.append(row.model_copy(update={"value": value or None, "entries": entries}))

    return body.model_copy(
        update={"recent_turns": turns, "on_screen": on_screen, "schema_rows": rows}
    )


def _clean_value(value: str | None) -> str | None:
    """A value safe to return, or None: stripped, no hard identifier (G1), no masking token."""
    if value is None:
        return None
    stripped = value.strip()
    if not stripped or carries_hard_identifier(stripped) or contains_mask_placeholder(stripped):
        return None
    return stripped


def _has_value(row: ProfilingSchemaRow) -> bool:
    return bool(row.entries) if row.kind == "list" else row.value is not None


def parse_understanding(
    content: str, request: ProfilingTurnUnderstandInput
) -> ProfilingTurnUnderstandOutput:
    """The model's content as a contained answer, or the fail-safe `unclear` with nothing proposed.

    ``coerce_json_text`` first, like every other model-JSON parser here. See the module docstring
    for the containment rules; each is applied per row, so one bad row never costs the others.
    """
    try:
        raw = json.loads(coerce_json_text(content))
    except (TypeError, ValueError):
        return ProfilingTurnUnderstandOutput()
    if not isinstance(raw, dict):
        return ProfilingTurnUnderstandOutput()

    rows = {row.key: row for row in request.schema_rows}

    intent = raw.get("intent")
    confidence = raw.get("confidence")
    confidence_value = (
        float(confidence)
        if isinstance(confidence, int | float) and not isinstance(confidence, bool)
        else 0.0
    )

    fills: list[ProfilingFill] = []
    seen_fills: set[tuple[str, str]] = set()

    def add_fill(key: str, value: str) -> None:
        if len(fills) >= MAX_FILLS or (key, value.casefold()) in seen_fills:
            return
        seen_fills.add((key, value.casefold()))
        fills.append(ProfilingFill(key=key, value=value))

    raw_fills = raw.get("fills")
    if isinstance(raw_fills, list):
        for candidate in raw_fills:
            try:
                fill = ProfilingFill.model_validate(candidate)
            except ValidationError:
                continue
            value = _clean_value(fill.value)
            if fill.key in rows and value is not None:
                add_fill(fill.key, value)

    edits: list[ProfilingEdit] = []
    raw_edits = raw.get("edits")
    if isinstance(raw_edits, list):
        for candidate in raw_edits:
            try:
                edit = ProfilingEdit.model_validate(candidate)
            except ValidationError:
                continue
            row = rows.get(edit.key)
            if row is None:
                continue
            value = None if edit.op == "delete" else _clean_value(edit.value)
            # A value the floor refused is not "no value": the worker gave one, and it may not
            # leave. Dropping the row is the only answer that does not invent a re-ask.
            if edit.op == "edit" and edit.value is not None and value is None:
                continue
            if not _has_value(row):
                # R4: changing an EMPTY field is filling it. A scalar edit with a value becomes a
                # fill; anything else (a delete, a value-less edit, a list) has nothing to act on.
                if row.kind != "list" and edit.op == "edit" and value is not None:
                    add_fill(row.key, value)
                continue
            if row.kind == "list":
                if edit.ref not in {entry.ref for entry in row.entries}:
                    continue
                ref: str | None = edit.ref
            else:
                ref = None
            edits.append(ProfilingEdit(op=edit.op, key=edit.key, ref=ref, value=value))
            if len(edits) >= MAX_EDITS:
                break

    page_owned = set(request.page_owned)
    mentions: list[str] = []
    raw_mentions = raw.get("page_owned_mentions")
    if isinstance(raw_mentions, list):
        for mention in raw_mentions:
            if isinstance(mention, str) and mention in page_owned and mention not in mentions:
                mentions.append(mention)

    return ProfilingTurnUnderstandOutput(
        intent=intent if isinstance(intent, str) and intent in _INTENTS else "unclear",
        confidence=min(max(confidence_value, 0.0), 1.0),
        fills=fills,
        edits=edits,
        page_owned_mentions=mentions,
    )
