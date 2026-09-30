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
from ..profiling.canonical_roles import coerce_json_text
from ..pseudonymize import pseudonymize

#: The deterministic mock-posture answer: nothing proposed, nothing refused. An empty
#: card is the honest mock — no fabricated edit ever reaches a development worker.
MOCK_RESPONSE = '{"rows": [], "unsupported": []}'

_UNSUPPORTED_VALUES = frozenset(get_args(UnsupportedEditTarget))


def mask_snapshot(rows: list[CompanionEditSnapshotRow]) -> list[CompanionEditSnapshotRow]:
    """Pseudonymize every current value the model is shown.

    THE INVARIANT: every model input passes the gateway. The snapshot is the worker's
    STORED values — an employer name, a work description, an institute — so it is exactly
    the kind of data the gateway exists for even though it never left our database before.
    A value the gateway refuses is NULLED, not sent and not dropped: the row keeps its ref
    and its other fields, so the model can still address it.
    """
    masked: list[CompanionEditSnapshotRow] = []
    for row in rows:
        fields: dict[str, str | None] = {}
        for key, value in row.fields.items():
            if value is None:
                fields[key] = None
                continue
            result = pseudonymize(value)
            fields[key] = None if result.blocked else result.text
        masked.append(row.model_copy(update={"fields": fields}))
    return masked


def parse_edit_rows(content: str, max_rows: int) -> CompanionEditParseOutput:
    """The edit parser's content as validated rows, or an empty proposal.

    ``coerce_json_text`` first, like every other model-JSON parser here. A row that fails
    the contract is skipped; the cap truncates rather than refuses, so a model that
    over-delivers still yields the rows the worker asked for first.
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
