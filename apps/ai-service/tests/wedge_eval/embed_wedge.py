"""LIVE step 1 of the TAX-5 floor sweep — embed every wedge phrase (REAL, §7-gated).

Ops tool, NOT a test (pytest ignores it — no test_ prefix). Requires the SG-4 real-embed
env (master flag + key + `skill_embedding` allowlist); refuses to write a MOCK snapshot,
because a mock sweep only validates plumbing, never a floor value.

    cd apps/ai-service
    python -m tests.wedge_eval.embed_wedge <out.json>

Then score against the live corpus vectors:

    pnpm --filter @badabhai/db exec tsx src/score-wedge.ts <out.json> <scores.json>

and commit the scores snapshot as tests/wedge_eval/scores_YYYY_MM_DD.json for the
offline pytest analysis (test_wedge.py).
"""

from __future__ import annotations

import json
import sys

from app.ai.embeddings import embed_text
from app.config import get_settings

from .wedge_set import WEDGE_SET


def main(out_path: str) -> None:
    settings = get_settings()
    if not settings.real_call_enabled_for("skill_embedding"):
        raise SystemExit(
            "REFUSING a mock sweep: enable the SG-4 real-embed env first "
            "(a mock snapshot would calibrate the floor against hash noise)."
        )
    rows = []
    for case in WEDGE_SET:
        res = embed_text(case.phrase, settings)
        if res.blocked or res.vector is None or res.is_mock:
            raise SystemExit(f"embed failed for a wedge phrase (blocked={res.blocked})")
        rows.append(
            {
                "phrase": case.phrase,
                "domain_id": case.domain_id,
                "expected": case.expected,
                "tier": case.tier,
                "requires_wedge": case.requires_wedge,
                "vector": res.vector,
            }
        )
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"model": settings.embedding_model, "cases": rows}, f)
    print(f"embedded {len(rows)} wedge phrases -> {out_path} (model={settings.embedding_model})")


if __name__ == "__main__":
    main(sys.argv[1])
