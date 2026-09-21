"""Every task type the service can SPEND on must be nameable by `ai.cost_recorded`.

WHY THIS FILE EXISTS. `aiTaskType` in packages/event-schema shipped with three values
while the service was already charging against eight. That is not a cosmetic drift: the
sole emitter of `ai.cost_recorded` swallows validation errors so an observability event
can never fail a worker's extraction — so a task type missing from the enum did not raise,
it silently produced no cost record at all.

`profile_parse` is the case that made it matter. The OIE Phase 8 cutover deleted every
per-turn model call and replaced them with one parse at the end of the interview, moving
ALL of the interview's model spend onto a task the enum could not express.

This test reads the enum out of the TypeScript source rather than duplicating the list, so
the two cannot drift again without a failure here.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from app.ai.embeddings import EMBEDDING_TASK_TYPE
from app.routers.profile import PARSE_TASK_TYPE
from app.stt import STT_TASK_TYPE
from app.tts import TTS_TASK_TYPE

_PAYLOADS_TS = (
    Path(__file__).resolve().parents[3] / "packages" / "event-schema" / "src" / "payloads.ts"
)


def _ledgerable_task_types() -> set[str]:
    """The `aiTaskType` enum members, read from the TS source."""
    src = _PAYLOADS_TS.read_text(encoding="utf-8")
    match = re.search(r"const aiTaskType = z\.enum\(\[(.*?)\]\)", src, re.DOTALL)
    assert match, "aiTaskType enum not found — did payloads.ts move or change shape?"
    return set(re.findall(r'"([a-z_]+)"', match.group(1)))


def test_every_spending_task_type_can_be_ledgered():
    spending = {
        STT_TASK_TYPE,
        TTS_TASK_TYPE,
        EMBEDDING_TASK_TYPE,
        PARSE_TASK_TYPE,
    }
    missing = spending - _ledgerable_task_types()
    assert not missing, (
        f"these task types spend real money but `ai.cost_recorded` cannot name them: "
        f"{sorted(missing)}. Add them to `aiTaskType` in packages/event-schema/src/payloads.ts "
        f"— an unnameable task type is silently unledgered, not loudly rejected."
    )


def test_the_router_task_types_are_ledgerable_too():
    """EVERY route the model router can dispatch, not just the ones `TaskType` happens to name.

    THIS TEST HAD THE SAME HOLE IT EXISTS TO CLOSE. It read `model_config.TaskType.__args__`,
    a three-member Literal, while dispatch is driven by `_ROUTE_SHAPES` — which carries six.
    `profile_parse` and `domain_match` were saved only because they are hand-listed in the enum;
    `work_history_polish` was not, and it spent real money on every resume render with no
    `ai.cost_recorded` to show for it.

    Reading the DISPATCH TABLE is what makes this executable rather than aspirational: a route
    added to `_ROUTE_SHAPES` is a route that can spend, and it now has to be nameable on the day
    it is added rather than on the day somebody notices the ledger is short.
    """
    from app.ai import model_config

    routed = set(model_config._ROUTE_SHAPES) | set(
        json.loads(json.dumps(list(model_config.TaskType.__args__)))
    )
    missing = routed - _ledgerable_task_types()
    assert not missing, f"routed task types missing from the cost enum: {sorted(missing)}"
