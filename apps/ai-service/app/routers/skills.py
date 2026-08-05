"""Skill taxonomy seams: POST /skills/canonicalize, POST /skills/retag-plan."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter

from ..ai import cost_tracker
from ..ai.canonicalize import canonicalize_skill
from ..ai.embeddings import EMBEDDING_TASK_TYPE
from ..ai.model_config import rate_inr_per_1k
from ..ai.retag import plan_retag
from ..ai.skill_store import get_skill_store
from ..config import get_settings
from ..contracts import (
    RetagPlanInput,
    RetagPlanOutput,
    SkillCanonicalization,
    SkillCanonicalizationInput,
)
from ._shared import logger

api_router = APIRouter()


@api_router.post("/skills/canonicalize", response_model=SkillCanonicalization)
async def skills_canonicalize(body: SkillCanonicalizationInput) -> SkillCanonicalization:
    """ADR-0030 / TAX-6: the JOB side canonicalizes through the SAME pipeline as the
    worker side — one shared id space. The NestJS api calls this at job-posting
    create/update for each posting skill phrase; `canonicalize_skill` runs
    pseudonymize -> embed (SG-2/SG-4) -> domain-scoped nearest-alias (seam A store) ->
    floor gate. SG-3 holds: the id can only come from the closed skill_alias set.

    Honors SKILL_CANONICALIZE_ENABLED: flag off -> UNRESOLVED (inert — rollback for the
    job side is the same single flag as the worker side). ``async def`` + ``to_thread``:
    the store + a real embed are SYNC httpx calls and must not block the event loop
    (same posture as the #222 fix).

    TD68 (TD27 SpendLedger wiring, REAL embed path only): the single-phrase projected
    cost is reserved BEFORE the embed and reconciled after. A ledger block returns
    UNRESOLVED — canonicalization NEVER blocks the caller (the same posture as every
    other failure). Mock embed path (``real_call_enabled_for`` false): zero ledger
    traffic. Never logs the phrase."""
    settings = get_settings()
    if not settings.skill_canonicalize_enabled:
        return SkillCanonicalization(status="unresolved")

    embed_is_mock = not settings.real_call_enabled_for(EMBEDDING_TASK_TYPE)
    reserved_inr = 0.0
    if not embed_is_mock:
        in_rate, _out = rate_inr_per_1k(settings.embedding_model)
        reserved_inr = (cost_tracker.estimate_tokens(body.phrase) / 1000.0) * in_rate
        reason = await cost_tracker.get_ledger().would_exceed_spend(reserved_inr, settings)
        if reason is not None:
            # Counts/reason only — never the phrase.
            logger.warning(
                "skills canonicalize blocked by spend ledger",
                extra={"extra": {"reason": reason, "projected_inr": round(reserved_inr, 6)}},
            )
            return SkillCanonicalization(status="unresolved")

    actual_inr = 0.0
    try:
        out = await asyncio.to_thread(
            canonicalize_skill,
            body.phrase,
            body.domain_id,
            get_skill_store(settings),
            settings,
            lang=body.lang,
        )
        # Leave the full reservation recorded as the actual spend (conservative:
        # one real embed ran; a pseudonymize-blocked phrase slightly over-records).
        actual_inr = reserved_inr
        return out
    finally:
        if not embed_is_mock:
            # On a raise, actual_inr stayed 0.0 => full refund (no reservation leak).
            await cost_tracker.get_ledger().record_spend(reserved_inr, actual_inr)


@api_router.post("/skills/retag-plan", response_model=RetagPlanOutput)
def skills_retag_plan(body: RetagPlanInput) -> RetagPlanOutput:
    """ADR-0030 / TAX-9: compute the OFFLINE re-tag plan for deprecated skill ids.
    PURE COMPUTE — no LLM, no DB, no PII (row_refs are opaque uuids; ids are closed-set).
    The db-side runner (packages/db/src/retag-skills.ts, owner connection) supplies the
    ``skill.replaced_by`` crosswalk + the affected rows and APPLIES the plan only under
    ``--apply`` after a human reads the dry-run report. Chains resolve to the terminal
    id; cycles are dropped fail-safe (SG-5: ids immutable, plan never invents one).
    Same internal-only exposure posture as every ai-service route (TD67)."""
    out = plan_retag(body)
    logger.info(
        "skills retag plan",
        extra={
            "extra": {
                "crosswalk": len(body.crosswalk),
                "rows_in": out.rows_in,
                "rows_changed": out.rows_changed,
                "dropped_cyclic": len(out.dropped),
            }
        },
    )
    return out
