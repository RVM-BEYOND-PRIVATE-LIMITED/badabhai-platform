"""The edit parser's output boundary (ADR-0046 Phase 1).

MODEL OUTPUT IS UNTRUSTED, and rows are dropped INDIVIDUALLY: one unreadable row must
not cost the card's other changes, which is the same rule the API applies again on its
side (`CompanionEditRow` per-row validation). Every drop here is a row the API would
also have dropped, so the contract is unchanged — this is belt, not policy.

WHAT THIS MODULE DOES NOT DO: it does not check a field against the catalogue, an op
against the field's legal ops, or a value against its writer's DTO. Those checks belong
to the API, which owns the catalogue and the writers; duplicating them here would be a
second rule that can drift. The closed section enum IS enforced (Pydantic), because
that set is shared by `packages/types`.

THE ROW CAP IS ENFORCED HERE TOO. `max_rows` is the API's product knob; a model that
returns more rows has ignored the request, and truncating to the cap is deterministic.

A ROW WHOSE VALUE CARRIES A HARD IDENTIFIER IS DROPPED (ADR-0047 G1, `app/output_floor.py`).
A confirmed row is stored and printed — an employer name or a `work_done` line lands on both
résumé PDFs — and with `AI_RAW_PII_ENABLED` on the model read the worker's raw message, so it
can echo the phone he typed into a value. Off it read "[PHONE_1]", and the API's placeholder
drop (ADR-0046 O17) caught that row; armed, no placeholder is minted and this floor is the
catch. The API drops the same row again (`containsHardIdentifier` in `companion-edit.service`),
so this is still belt. Reads no flag.
"""

from __future__ import annotations

import json
from typing import get_args

from pydantic import ValidationError

from ..contracts import (
    CompanionEditParseOutput,
    CompanionEditRow,
    CompanionEditSnapshotRow,
    UnsupportedEditTarget,
)
from ..llm_input_policy import llm_input_gate
from ..output_floor import carries_hard_identifier
from ..profiling.canonical_roles import coerce_json_text
from ..pseudonymize import TokenScope

#: The deterministic mock-posture answer: nothing proposed, nothing refused. An empty
#: card is the honest mock — no fabricated edit ever reaches a development worker.
MOCK_RESPONSE = '{"rows": [], "unsupported": []}'

_UNSUPPORTED_VALUES = frozenset(get_args(UnsupportedEditTarget))


def mask_snapshot(
    rows: list[CompanionEditSnapshotRow],
    *,
    raw: bool,
    scope: TokenScope | None = None,
) -> list[CompanionEditSnapshotRow]:
    """Pseudonymize every current value the model is shown.

    THE INVARIANT: every model input passes the gateway. The snapshot is the worker's
    STORED values — an employer name, a work description, an institute — so it is exactly
    the kind of data the gateway exists for even though it never left our database before.
    A value the gateway refuses is NULLED, not sent and not dropped: the row keeps its ref
    and its other fields, so the model can still address it.

    ONE TOKEN SCOPE FOR THE WHOLE REQUEST. Each value is masked on its own, and with a fresh
    numbering per value every employer became ``[EMPLOYER_1]`` — three different jobs, one
    token, and a message saying "[EMPLOYER_1] ko hatao" matched all of them. The values share
    ``scope`` (the endpoint passes the one it masked the MESSAGE with), so the same employer
    carries the same token in the message and in the snapshot, and two employers never share
    one. Without a caller's scope the values still share one among themselves.

    ``raw`` is the route's `AI_RAW_PII_ENABLED` (ADR-0047), passed in and never read here.
    With it on the values go through unmasked — which is what lets an edit to an employer
    name propose a real value instead of a placeholder row the API drops (ADR-0046 O17) —
    and a value is nulled only for the size cap.
    """
    tokens = scope if scope is not None else TokenScope()
    masked: list[CompanionEditSnapshotRow] = []
    for row in rows:
        fields: dict[str, str | None] = {}
        for key, value in row.fields.items():
            if value is None:
                fields[key] = None
                continue
            result = llm_input_gate(value, raw=raw, scope=tokens)
            fields[key] = None if result.blocked else result.text
        masked.append(row.model_copy(update={"fields": fields}))
    return masked


def parse_edit_rows(content: str, max_rows: int) -> CompanionEditParseOutput:
    """The edit parser's content as validated rows, or an empty proposal.

    ``coerce_json_text`` first, like every other model-JSON parser here. A row that fails
    the contract, or whose value carries a hard identifier, is skipped and does not count
    toward the cap; the cap truncates rather than refuses, so a model that over-delivers
    still yields the rows the worker asked for first.
    """
    try:
        raw = json.loads(coerce_json_text(content))
    except (TypeError, ValueError):
        return CompanionEditParseOutput()
    if not isinstance(raw, dict):
        return CompanionEditParseOutput()

    rows: list[CompanionEditRow] = []
    raw_rows = raw.get("rows")
    if isinstance(raw_rows, list):
        for candidate in raw_rows:
            try:
                row = CompanionEditRow.model_validate(candidate)
            except ValidationError:
                continue
            # EVERY ROW NAMES ITS FIELD — add, edit and delete alike. The API resolves each row
            # through its `(section, field)` catalogue entry BEFORE any op-specific check, so a
            # field-less row is one it drops unseen; dropping it here keeps "every drop is a row
            # the API would also have dropped" true, and stops it spending a slot of the cap.
            if row.field is None:
                continue
            # G1 (ADR-0047) — a proposed value carrying a hard identifier never reaches the card.
            if carries_hard_identifier(row.value):
                continue
            rows.append(row)
            if len(rows) >= max_rows:
                break

    unsupported: list[UnsupportedEditTarget] = []
    raw_unsupported = raw.get("unsupported")
    if isinstance(raw_unsupported, list):
        for value in raw_unsupported:
            if value in _UNSUPPORTED_VALUES and value not in unsupported:
                unsupported.append(value)

    return CompanionEditParseOutput(rows=rows, unsupported=unsupported)
