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
    """The three `model_config.TaskType` values plus the two routed-but-unlisted ones."""
    from app.ai import model_config

    routed = set(json.loads(json.dumps(list(model_config.TaskType.__args__))))
    missing = routed - _ledgerable_task_types()
    assert not missing, f"routed task types missing from the cost enum: {sorted(missing)}"
