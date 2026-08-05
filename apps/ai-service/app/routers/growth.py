"""Router: POST /growth/cluster — the TAX-7 report-only growth loop.

Moved verbatim out of ``app/main.py``.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..ai.growth import growth_cluster
from ..config import get_settings
from ..contracts import GrowthClusterInput, GrowthClusterOutput
from ..runtime import logger

router = APIRouter()


@router.post("/growth/cluster", response_model=GrowthClusterOutput)
def growth_cluster_endpoint(body: GrowthClusterInput) -> GrowthClusterOutput:
    """ADR-0030 / TAX-7 growth loop — PURE COMPUTE, REPORT-ONLY. The db-side runner
    (packages/db/src/growth-cluster.ts, fork-B pattern) POSTs a per-domain batch of OPEN
    ``unresolved_phrase`` rows (SG-1 pseudonymized text + vectors) and the embedded
    ``skill_alias`` anchors; this clusters them and proposes alias-on-near-skill or
    provisional-skill entries for the HUMAN ratification flow — the only activation path.

    No LLM, no DB, no flag needed (inert unless the ops runner calls it; nothing it
    returns changes live behavior). SG-3: a proposal's ``skill_id`` can only be one of the
    supplied anchors; SG-5: provisional proposals carry NO id. Plain ``def`` (threadpool):
    the greedy clustering is CPU-bound and must not block the event loop. Never logs
    phrase text — counts only.

    EXPOSURE: unauthenticated like every ai-service route — the service is internal-only
    (the same posture as /profile/extract, which spends real LLM money). This is the
    CPU-heaviest route (worst case at the contract caps is minutes, in the threadpool);
    vectors are unit-normalized ONCE so the O(n²) loop is pure dots. Service-level auth
    for the ai-service as a whole is tracked as TD67 — do not bolt a one-off scheme onto
    this route alone."""
    out = growth_cluster(body, get_settings())
    logger.info(
        "growth cluster batch",
        extra={
            "extra": {
                "domain_id": body.domain_id,
                "phrases_in": out.phrases_in,
                "anchors": len(body.anchors),
                "clusters_total": out.clusters_total,
                "clusters_eligible": out.clusters_eligible,
                "proposals": len(out.proposals),
            }
        },
    )
    return out
