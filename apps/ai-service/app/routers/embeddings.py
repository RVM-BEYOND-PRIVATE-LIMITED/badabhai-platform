"""Skill-alias embedding batches: POST /embeddings/skill-alias."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter

from ..ai import cost_tracker
from ..ai.embeddings import (
    EMBED_REQUEST_BATCH,
    EMBEDDING_TASK_TYPE,
    MOCK_MODEL,
    embed_texts,
)
from ..ai.langfuse_tracing import get_tracer
from ..ai.model_config import rate_inr_per_1k
from ..config import Settings, get_settings
from ..contracts import (
    SkillAliasEmbedInput,
    SkillAliasEmbedItem,
    SkillAliasEmbedOutput,
    SkillAliasEmbedResult,
)
from ._shared import logger

api_router = APIRouter()


def _embed_batch_sync(
    items: list[SkillAliasEmbedItem],
    settings: Settings,
    is_mock: bool,
    in_rate: float,
) -> tuple[list[SkillAliasEmbedResult], float, int, bool]:
    """Per-item embed loop for POST /embeddings/skill-alias. SYNC on purpose
    (``embed_texts`` is a sync httpx call) and dispatched via ``asyncio.to_thread``
    so the event loop keeps serving while a real batch runs (same posture as the
    #222 fix). Returns ``(results, cost_inr, errors, budget_stopped)``. The
    per-request INR ceiling stays enforced INSIDE the loop — belt + suspenders
    under the TD68 SpendLedger reserve done by the caller. Never logs alias text.

    TRACED as ONE task, not one per item. A trace is a unit of work, and the unit
    here is the batch: without this span a 200-alias run would post 200 rootless
    ``embed-text`` traces, which is both unreadable and the wrong shape for the
    question anyone actually asks ("what did this batch cost?"). Each item's embed
    nests underneath. No ``user_ref``: the corpus embed is offline taxonomy work with
    no worker behind it."""
    tracer = get_tracer()
    with tracer.task(
        task_type=EMBEDDING_TASK_TYPE,
        input={"items": len(items)},
        real_call=not is_mock,
    ) as task:
        results, cost_inr, errors, budget_stopped = _embed_loop(items, settings, is_mock, in_rate)
        task.update(
            output={
                "embedded": len(results),
                "blocked": sum(1 for r in results if r.blocked),
                "errors": errors,
                "budget_stopped": budget_stopped,
            },
            metadata={"estimated_cost_inr": round(cost_inr, 6)},
            # Items were DROPPED — the runner has to come back for them. Silent
            # truncation is the failure mode this level exists to surface.
            level="WARNING" if budget_stopped or errors else "DEFAULT",
        )
    return results, cost_inr, errors, budget_stopped


def _embed_loop(
    items: list[SkillAliasEmbedItem],
    settings: Settings,
    is_mock: bool,
    in_rate: float,
) -> tuple[list[SkillAliasEmbedResult], float, int, bool]:
    results: list[SkillAliasEmbedResult] = []
    cost_inr = 0.0
    errors = 0
    budget_stopped = False
    # Chunked so ONE provider request carries up to EMBED_REQUEST_BATCH aliases. The
    # binding constraint on the corpus embed is the provider's per-day REQUEST quota,
    # not spend: at one request per alias the 9121-row corpus needs 9121 requests
    # against a 1000/day free-tier cap, which is what stalled a real run at 998 rows.
    #
    # The per-request INR ceiling is consequently checked per CHUNK rather than per
    # item — the finest granularity a batched provider call allows. It stays a real
    # guard: alias texts are ~3-token strings, so a full runner batch is a small
    # fraction of a paisa and the cap can only be approached over many chunks.
    for start in range(0, len(items), EMBED_REQUEST_BATCH):
        if not is_mock and cost_inr >= settings.ai_max_call_cost_inr:
            budget_stopped = True
            break
        chunk = items[start : start + EMBED_REQUEST_BATCH]
        if not is_mock:
            # Take only the prefix of this chunk that fits under the ceiling. Batching
            # means cost can no longer be observed between items, so the affordability
            # decision moves BEFORE the call — otherwise a 100-item chunk would commit
            # the whole batch's spend before the guard could look at it, and the
            # ceiling would degrade from an item-level stop to a chunk-level one.
            #
            # Projected on the RAW text, unlike the ACTUAL accumulation below, which
            # stays on the pseudonymized text the provider saw. Pseudonymization
            # substitutes placeholders of similar length, so the two agree closely;
            # the estimate only decides where to cut, never what is recorded.
            affordable: list[SkillAliasEmbedItem] = []
            projected = cost_inr
            for item in chunk:
                if projected >= settings.ai_max_call_cost_inr:
                    budget_stopped = True
                    break
                affordable.append(item)
                projected += (cost_tracker.estimate_tokens(item.text) / 1000.0) * in_rate
            chunk = affordable
        if not chunk:
            break
        try:
            embedded = embed_texts([item.text for item in chunk], settings)
        except Exception:
            # embed_texts already isolates provider failures to their own chunk; this
            # is the belt-and-suspenders path for anything it does not catch. The rows
            # stay NULL for a later run. Never logs the text.
            errors += len(chunk)
            continue
        # strict=True: embed_texts returns exactly one slot per input, in order.
        # Anything else would attach a vector to the wrong alias_id.
        for item, res in zip(chunk, embedded, strict=True):
            if res is None:
                # Provider failure for THIS row: omit it entirely so the runner leaves
                # the row NULL and resumes later. Deliberately NOT reported as blocked —
                # blocked means fail-closed and sends a clean alias to a human.
                errors += 1
                continue
            results.append(
                SkillAliasEmbedResult(
                    alias_id=item.alias_id, vector=res.vector, blocked=res.blocked
                )
            )
            if not is_mock and not res.blocked:
                cost_inr += (cost_tracker.estimate_tokens(res.text or "") / 1000.0) * in_rate
        if budget_stopped:
            # The ceiling cut this chunk short; the remaining items are OMITTED so
            # the runner leaves those rows NULL and resumes on a later run.
            break
    return results, cost_inr, errors, budget_stopped


@api_router.post("/embeddings/skill-alias", response_model=SkillAliasEmbedOutput)
async def embed_skill_aliases(body: SkillAliasEmbedInput) -> SkillAliasEmbedOutput:
    """ADR-0030 fork-B seam: the db-side runner (packages/db/src/embed-skill-aliases.ts,
    owner connection) POSTs alias-text batches; this service embeds and returns vectors —
    the DB read/write stays on the runner so the ai-service remains DB-free.

    SG-2: every text is pseudonymized before the embed (inside ``embed_texts``, fail-closed
    → ``vector=None, blocked=True`` and the runner leaves that row NULL). SG-4: mock by
    default (zero spend); the real provider additionally needs the master flag + key +
    the ``skill_embedding`` task allowlist. Never logs alias text.

    REAL-path guards (enforced HERE, on the path the runner actually hits):
    - TD68 (TD27 SpendLedger wiring): the projected batch cost is atomically
      check-AND-RESERVED (``would_exceed_spend``) BEFORE any provider call, so embed
      spend shares the daily / cumulative / per-user-global (Redis) INR caps with every
      other real call. When the FULL batch's reserve blocks, the item prefix is HALVED
      and re-reserved (loop, floor 1 — #238 F3: an all-or-nothing reserve would starve
      fixed-size runner batches until UTC midnight once remaining headroom < one
      batch); the affordable prefix is embedded and returned with
      ``budget_stopped=True`` (results shorter than items — the runner resumes the
      rest). Only if not even ONE item fits does the request return NO results (rows
      stay NULL). After the batch the reservation is reconciled to the ACTUAL
      accumulated estimate (``record_spend``).
    - Per-request INR ceiling (belt + suspenders under the ledger): real-embed cost is
      accumulated UNROUNDED per item (alias texts are ~3-token strings whose
      individually-rounded estimate is 0.0) against ``ai_max_call_cost_inr``; on breach
      the batch STOPS, remaining items are OMITTED (rows stay NULL — a later run
      resumes), ``budget_stopped=True``.
    - Per-item failure isolation: one provider error skips THAT item (counted in
      ``errors``) instead of 500ing the request and discarding already-paid embeds.
    Mock path: zero spend, ZERO ledger traffic, behavior unchanged.
    """
    settings = get_settings()
    is_mock = not settings.real_call_enabled_for(EMBEDDING_TASK_TYPE)
    in_rate, _out = rate_inr_per_1k(settings.embedding_model)

    # TD68: all ledger awaits happen HERE on the handler's own loop (the ledger
    # singleton's Redis backend binds to the running loop — never asyncio.run /
    # a new loop from the worker thread).
    items: list[SkillAliasEmbedItem] = list(body.items)
    reserved_inr = 0.0
    ledger_truncated = False
    if not is_mock:

        def _projected(prefix: list[SkillAliasEmbedItem]) -> float:
            return (
                sum(cost_tracker.estimate_tokens(item.text) for item in prefix) / 1000.0
            ) * in_rate

        ledger = cost_tracker.get_ledger()
        projected = _projected(items)
        reason = await ledger.would_exceed_spend(projected, settings)
        # #238 F3: an all-or-nothing reserve STARVES the corpus embed once the
        # remaining daily headroom is smaller than one fixed-size runner batch
        # (identical block until UTC midnight). Halve the item prefix and re-reserve
        # (floor 1); the affordable prefix is embedded and returned as partial
        # results + budget_stopped=True — the runner resumes the rest.
        while reason is not None and len(items) > 1:
            items = items[: len(items) // 2]
            ledger_truncated = True
            projected = _projected(items)
            reason = await ledger.would_exceed_spend(projected, settings)
        if reason is not None:
            # Not even ONE item fits. Counts only — never alias text.
            logger.warning(
                "embed skill-alias batch blocked by spend ledger",
                extra={
                    "extra": {
                        "items": len(body.items),
                        "reason": reason,
                        "projected_inr": round(projected, 6),
                    }
                },
            )
            return SkillAliasEmbedOutput(
                results=[],
                is_mock=False,
                model=settings.embedding_model,
                budget_stopped=True,
                errors=0,
                estimated_cost_inr=0.0,
            )
        reserved_inr = projected
        if ledger_truncated:
            # Counts only — the runner resumes the omitted suffix on a later run.
            logger.warning(
                "embed skill-alias batch truncated by spend ledger",
                extra={"extra": {"items": len(body.items), "affordable": len(items)}},
            )

    results: list[SkillAliasEmbedResult] = []
    cost_inr = 0.0
    errors = 0
    budget_stopped = False
    try:
        results, cost_inr, errors, budget_stopped = await asyncio.to_thread(
            _embed_batch_sync, items, settings, is_mock, in_rate
        )
    finally:
        if not is_mock:
            # Reconcile reserved -> ACTUAL accumulated estimate: leaves +cost_inr
            # recorded on every counter; if the batch raised, cost_inr stayed 0.0 =>
            # full refund — no path leaks a reservation. record_spend never raises.
            await cost_tracker.get_ledger().record_spend(reserved_inr, cost_inr)
    # A ledger-truncated request is budget-stopped from the caller's view: results
    # are shorter than items and the omitted suffix stays NULL for a later run.
    budget_stopped = budget_stopped or ledger_truncated
    logger.info(
        "embed skill-alias batch",
        extra={
            "extra": {
                "items": len(body.items),
                "returned": len(results),
                "blocked": sum(1 for r in results if r.blocked),
                "errors": errors,
                "budget_stopped": budget_stopped,
                "estimated_cost_inr": round(cost_inr, 6),
                "is_mock": is_mock,
            }
        },
    )
    return SkillAliasEmbedOutput(
        results=results,
        is_mock=is_mock,
        model=settings.embedding_model if not is_mock else MOCK_MODEL,
        budget_stopped=budget_stopped,
        errors=errors,
        estimated_cost_inr=round(cost_inr, 6),
    )
