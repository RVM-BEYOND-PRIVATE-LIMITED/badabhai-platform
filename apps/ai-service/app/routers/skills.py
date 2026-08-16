"""Skill taxonomy seams: POST /skills/canonicalize, POST /skills/retag-plan."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter

from ..ai import cost_tracker
from ..ai.canonicalize import canonicalize_skill
from ..ai.embeddings import EMBEDDING_TASK_TYPE
from ..ai.langfuse_tracing import get_tracer
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
    pseudonymize -> embed (SG-2/SG-4) -> scope-bounded nearest-alias (seam A store) ->
    floor gate. SG-3 holds: the id can only come from the closed skill_alias set.

    SCOPE (Phase 1.5): the body carries EXACTLY ONE of `domain_id` (legacy slug) or
    `job_domain_id` (canonical `jd_*`, resolved through `job_domain_skill` so a skill
    with a NULL legacy domain is reachable at all). Neither/both is a 422 from the
    contract — an unscoped search is refused, never widened.

    Honors SKILL_CANONICALIZE_ENABLED: flag off -> UNRESOLVED (inert — rollback for the
    job side is the same single flag as the worker side). ``async def`` + ``to_thread``:
    the store + a real embed are SYNC httpx calls and must not block the event loop
    (same posture as the #222 fix).

    TD68 (TD27 SpendLedger wiring, REAL embed path only): the single-phrase projected
    cost is reserved BEFORE the embed and reconciled after. A ledger block returns
    UNRESOLVED — canonicalization NEVER blocks the caller (the same posture as every
    other failure). Mock embed path (``real_call_enabled_for`` false): zero ledger
    traffic. Never logs the phrase.

    TRACED as one task with the embed nested inside it. Both non-embedding outcomes —
    the flag being off and a ledger block — are traced too, and deliberately: all three
    return the SAME ``unresolved`` body, so without the trace saying which one happened
    a disabled flag is indistinguishable from a phrase nothing matched. The phrase
    itself is never traced (the ``embed-text`` child records the MASKED text, which is
    what the provider actually saw)."""
    settings = get_settings()
    tracer = get_tracer()
    with tracer.task(
        task_type="skill_canonicalization",
        # BOTH SCOPE KEYS ARE TRACED, and both are safe: a legacy slug and a `jd_*` id are
        # closed-set identifiers, never worker text. Tracing only the one that was set would
        # make the two Phase 1.5 paths indistinguishable in Langfuse — the exact question the
        # cutover has to be able to answer ("did this go through job_domain_skill or the
        # legacy column?"). The phrase itself is still never traced.
        input={
            "domain_id": body.domain_id,
            "job_domain_id": body.job_domain_id,
            "lang": body.lang,
        },
        real_call=settings.real_call_enabled_for(EMBEDDING_TASK_TYPE),
    ) as task:
        if not settings.skill_canonicalize_enabled:
            task.update(level="WARNING", status_message="skill_canonicalize_disabled")
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
                task.update(level="WARNING", status_message=reason)
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
                # Phase 1.5: EXACTLY ONE of these is set (the contract 422s anything else),
                # so the legacy call is unchanged — this is None on every existing caller.
                job_domain_id=body.job_domain_id,
            )
            # Leave the full reservation recorded as the actual spend (conservative:
            # one real embed ran; a pseudonymize-blocked phrase slightly over-records).
            actual_inr = reserved_inr
            # SG-3 holds on the wire, so this is safe to record verbatim: `skill_id` can
            # only be an id from the closed skill_alias set, never model-invented text.
            task.update(output=out.model_dump())
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
