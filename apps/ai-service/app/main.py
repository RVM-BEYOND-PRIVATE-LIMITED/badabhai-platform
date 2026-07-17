"""FastAPI AI service.

Endpoints: /health, /pseudonymize, /profiling/respond, /profile/extract,
/resume/generate.

INVARIANT: pseudonymization runs BEFORE any external LLM path on every endpoint
that could reach an LLM. If pseudonymization is blocked, the LLM is never called
and a safe fallback is returned (fail closed). Model routing, cost tracking, and
Langfuse tracing all live behind ``app.ai.router.AIRouter``.
"""

from __future__ import annotations

import asyncio
import hmac
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from .ai import cost_tracker
from .ai.canonicalize import canonicalize_labels, canonicalize_skill
from .ai.embeddings import EMBEDDING_TASK_TYPE, MOCK_MODEL, embed_text
from .ai.growth import growth_cluster
from .ai.model_config import rate_inr_per_1k
from .ai.retag import plan_retag
from .ai.router import AIRouter
from .ai.skill_store import get_skill_store
from .config import Settings, get_settings
from .contracts import (
    DraftProfile,
    GrowthClusterInput,
    GrowthClusterOutput,
    ProfileExtractionInput,
    ProfileExtractionOutput,
    ProfilingTurnInput,
    ProfilingTurnOutput,
    PseudonymizationInput,
    PseudonymizationMeta,
    PseudonymizationOutput,
    ResumeGenerationInput,
    ResumeGenerationOutput,
    RetagPlanInput,
    RetagPlanOutput,
    SkillAliasEmbedInput,
    SkillAliasEmbedItem,
    SkillAliasEmbedOutput,
    SkillAliasEmbedResult,
    SkillCanonicalization,
    SkillCanonicalizationInput,
    TranscriptionInput,
    TranscriptionOutput,
    WorkerProfileDraft,
)
from .extraction import build_resume
from .logging_config import configure_logging, get_logger
from .profiling import interview_engine, profile_extractor
from .profiling.canonical_roles import (
    ROLE_TRADE,
    canonicalization_instruction,
    extract_canonical_role_id,
    normalize_role_id,
)
from .profiling.prompts import (
    EXTRACTION_SYSTEM_PROMPT,
    RESUME_SYSTEM_PROMPT,
    build_chat_messages,
)
from .pseudonymize import (
    PseudonymizationResult,
    certified_clean_skill_labels,
    pseudonymize,
)
from .stt import SttAdapter
from .translate import TranslateAdapter

configure_logging()
logger = get_logger("ai-service")
settings = get_settings()
router = AIRouter(settings)
stt_adapter = SttAdapter(settings)
translate_adapter = TranslateAdapter(settings)


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """AI-ENV-1 / 1c: construct the spend ledger AT BOOT so its backend choice is
    logged at STARTUP, not on the first AI call.

    The ledger is a lazy singleton, so without this hook nothing announced the
    selected backend until real AI traffic arrived — which defeats the point of the
    log. "Unset" (per-process caps, a deliberate default) and "misconfigured" were
    indistinguishable from outside the process precisely when you most need to
    know: at deploy time, before any traffic. This matters MOST under the TD67-locked
    posture, where ``/health`` trims ``spend_store`` out of its payload and the log
    is the ONLY signal.

    Safe to do at boot: ``SpendLedger`` construction performs NO network I/O
    (``redis.asyncio.from_url`` is lazy — it connects on first command), so an
    unreachable Redis still boots fine and still fails CLOSED per call. It does not
    import anything ``main`` has not already imported, so there is no cycle.
    """
    cost_tracker.get_ledger()
    yield


app = FastAPI(title="BadaBhai AI Service", version="0.1.0", lifespan=_lifespan)

# TD67: paths reachable WITHOUT the service token. Everything else (including /docs
# and /openapi.json) is gated once AI_INTERNAL_TOKEN is set. NOTE: /health itself
# TRIMS its payload to {status, service, service_auth_enabled} under the locked
# posture — the full spend/posture telemetry is recon data on a shared network and
# stays token-only (via the gated /ai/spend or the full /health when auth is off).
_AUTH_EXEMPT_PATHS = frozenset({"/health"})


@app.middleware("http")
async def service_auth(request, call_next):  # type: ignore[no-untyped-def]
    """TD67: ONE service-level bearer for every route (health exempt).

    LAUNCH-GATED: with ``AI_INTERNAL_TOKEN`` unset (the default) this is a no-op —
    the historical internal-only open posture. Once the env var is set, every
    request must carry the exact value in ``x-ai-internal-token`` (timing-safe
    compare; fail-closed 401 with no detail). Callers: the NestJS api
    (``AI_INTERNAL_TOKEN`` in @badabhai/config) + the three db runners. Never logs
    the supplied value."""
    token = get_settings().ai_internal_token
    if token is not None and request.url.path not in _AUTH_EXEMPT_PATHS:
        supplied = request.headers.get("x-ai-internal-token") or ""
        if not hmac.compare_digest(supplied.encode("utf-8"), token.encode("utf-8")):
            return JSONResponse(status_code=401, content={"detail": "unauthorized"})
    return await call_next(request)


_BLOCKED_REPLY = (
    "Sorry, I couldn't process that safely. Please rephrase without sharing "
    "personal details like your phone number, full name, or company name."
)


def _pseudonymization_meta(result: PseudonymizationResult) -> PseudonymizationMeta:
    return PseudonymizationMeta(
        blocked=result.blocked,
        blocked_reason=result.blocked_reason,
        replaced_entities=result.replaced_entities,
        placeholder_tokens=result.placeholder_tokens,
    )


@app.get("/health")
async def health() -> dict:
    # TD67: under the LOCKED posture the tokenless health surface is liveness + the
    # posture boolean ONLY — spend telemetry / caps / provider posture are recon data
    # on a shared network (the full snapshot stays available on the token-gated
    # /ai/spend). With auth off (dev default), the full payload is unchanged.
    if get_settings().ai_internal_token is not None:
        return {"status": "ok", "service": "ai-service", "service_auth_enabled": True}
    return {
        "status": "ok",
        "service": "ai-service",
        "real_calls_enabled": settings.real_calls_enabled,
        # TD67: whether the service-level bearer is enforced (true once
        # AI_INTERNAL_TOKEN is set in the service env). Boolean only — never the value.
        "service_auth_enabled": False,
        # Actual tracer state (keys present AND package installed), not just config.
        "langfuse_enabled": router.langfuse_enabled,
        "max_call_cost_inr": settings.ai_max_call_cost_inr,
        # Which spend-ledger backend is active (redis = global caps; in_process =
        # per-worker). PII-free; no store round-trip.
        "spend_store": cost_tracker.get_ledger().backend_name,
        # PII-free cumulative spend / retry-budget usage-vs-cap (TD27). snapshot is
        # async (it may touch the Redis backend); await it.
        "spend": await cost_tracker.get_ledger().snapshot(settings),
    }


@app.get("/ai/spend")
async def ai_spend(user_ref: str | None = None) -> dict:
    """PII-free cumulative spend + retry-budget usage vs. caps (TD27).

    Numbers / model ids / UTC date only — never message content. Pass an opaque
    ``user_ref`` to also see that worker's spend vs the per-user daily cap. Scope is
    per-process with the in-process backend; GLOBAL across workers with Redis
    (AI_SPEND_REDIS_URL set). snapshot is async (may touch Redis); await it.
    """
    return await cost_tracker.get_ledger().snapshot(settings, user_ref=user_ref)


@app.post("/pseudonymize", response_model=PseudonymizationOutput)
def pseudonymize_endpoint(body: PseudonymizationInput) -> PseudonymizationOutput:
    result = pseudonymize(body.text)
    logger.info(
        "pseudonymize",
        extra={
            "extra": {
                "blocked": result.blocked,
                "replaced_entities": result.replaced_entities,
                "request_id": body.request_id,
            }
        },
    )
    return PseudonymizationOutput(
        pseudonymized_text=result.text,
        blocked=result.blocked,
        blocked_reason=result.blocked_reason,
        replaced_entities=result.replaced_entities,
        placeholder_tokens=result.placeholder_tokens,
    )


def _embed_batch_sync(
    items: list[SkillAliasEmbedItem],
    settings: Settings,
    is_mock: bool,
    in_rate: float,
) -> tuple[list[SkillAliasEmbedResult], float, int, bool]:
    """Per-item embed loop for POST /embeddings/skill-alias. SYNC on purpose
    (``embed_text`` is a sync httpx call) and dispatched via ``asyncio.to_thread``
    so the event loop keeps serving while a real batch runs (same posture as the
    #222 fix). Returns ``(results, cost_inr, errors, budget_stopped)``. The
    per-request INR ceiling stays enforced INSIDE the loop — belt + suspenders
    under the TD68 SpendLedger reserve done by the caller. Never logs alias text."""
    results: list[SkillAliasEmbedResult] = []
    cost_inr = 0.0
    errors = 0
    budget_stopped = False
    for item in items:
        if not is_mock and cost_inr >= settings.ai_max_call_cost_inr:
            budget_stopped = True
            break
        try:
            res = embed_text(item.text, settings)
        except Exception:
            # Real-provider failure (HTTP error / timeout / dim mismatch). Skip the item —
            # it stays NULL for a later run; keep the embeds this request already paid for.
            # Never logs the text.
            errors += 1
            continue
        results.append(
            SkillAliasEmbedResult(alias_id=item.alias_id, vector=res.vector, blocked=res.blocked)
        )
        if not is_mock and not res.blocked:
            cost_inr += (cost_tracker.estimate_tokens(res.text or "") / 1000.0) * in_rate
    return results, cost_inr, errors, budget_stopped


@app.post("/embeddings/skill-alias", response_model=SkillAliasEmbedOutput)
async def embed_skill_aliases(body: SkillAliasEmbedInput) -> SkillAliasEmbedOutput:
    """ADR-0030 fork-B seam: the db-side runner (packages/db/src/embed-skill-aliases.ts,
    owner connection) POSTs alias-text batches; this service embeds and returns vectors —
    the DB read/write stays on the runner so the ai-service remains DB-free.

    SG-2: every text is pseudonymized before the embed (inside ``embed_text``, fail-closed
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
                extra={
                    "extra": {"items": len(body.items), "affordable": len(items)}
                },
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


@app.post("/skills/canonicalize", response_model=SkillCanonicalization)
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
                extra={
                    "extra": {"reason": reason, "projected_inr": round(reserved_inr, 6)}
                },
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


@app.post("/growth/cluster", response_model=GrowthClusterOutput)
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


@app.post("/skills/retag-plan", response_model=RetagPlanOutput)
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


@app.post("/profiling/respond", response_model=ProfilingTurnOutput)
async def profiling_respond(body: ProfilingTurnInput) -> ProfilingTurnOutput:
    # 1. Pseudonymize FIRST — gate for any external LLM call.
    result = pseudonymize(body.message_text)
    if result.blocked:
        logger.warning("profiling blocked", extra={"extra": {"reason": result.blocked_reason}})
        return ProfilingTurnOutput(
            reply_text=_BLOCKED_REPLY,
            blocked=True,
            blocked_reason=result.blocked_reason,
            is_mock=True,
            pseudonymization_metadata=_pseudonymization_meta(result),
        )

    # 2. COST-4 clarify fix: evaluate the clarify predicate BEFORE advancing the
    #    engine. A clarifying message ("matlab kya?") is NOT an answer — next_turn
    #    would mis-advance the state (the confused topic lands in asked_question_ids
    #    and _next_topic skips it forever, ESSENTIAL_TOPICS included) and hand the
    #    NEXT question to the rephrase branch instead of the confusing one.
    #    clarify_turn re-serves the LAST asked question (turn_count + clarify_count
    #    are the only state advances, so the topic stays re-askable). It refuses —
    #    None, engine runs normally — when there is nothing to re-serve, when the
    #    message carries an extractable ANSWER (answer-trumps-clarify: the predicate
    #    has false-positive classes like "Fanuc?" / "2 saal?" that must never eat an
    #    answer, #238 HIGH), or when the consecutive clarify budget (2) is spent.
    is_clarify = interview_engine.needs_rephrase(body.message_text)
    turn = (
        interview_engine.clarify_turn(
            body.conversation_state, body.message_text, body.role_family
        )
        if is_clarify
        else None
    )
    if turn is None:
        # Engine decides next question + progress (reads raw locally, no network).
        turn = interview_engine.next_turn(
            body.conversation_state, body.message_text, body.role_family
        )
    mock_reply, asked_id, updated_state, extraction_ready = turn

    # 3. COST-4: the straight-line path returns the deterministic templated question
    #    DIRECTLY — the engine already chose it (≤20 words, on-persona), so there is
    #    nothing for the LLM to phrase. We only allow a real chat LLM call when the
    #    worker seems to be asking for clarification (needs_rephrase) AND the rephrase
    #    flag is on — and mock_reply is then the RE-SERVED confusing question, so the
    #    LLM rephrases the right one. On the straight path real_call_allowed=False →
    #    the router takes its mock path and returns the templated question with ZERO
    #    output tokens.
    #    COST-3: the chat turn is STATELESS — prior history is NOT sent to the model
    #    (build_chat_messages ignores it); only the current (already-pseudonymized)
    #    message + the engine's question reach the LLM if a rephrase call does fire.
    wants_rephrase = settings.ai_profiling_rephrase_enabled and is_clarify
    messages = build_chat_messages([], mock_reply, result.text)
    reply_text, meta = await router.run(
        "profiling_chat_turn",
        messages=messages,
        mock_response=mock_reply,
        real_call_allowed=body.real_call_allowed and wants_rephrase,
        user_ref=body.worker_ref,
    )

    return ProfilingTurnOutput(
        reply_text=reply_text,
        blocked=False,
        suggested_followups=interview_engine.suggested_followups(body.role_family),
        is_mock=not meta.real_call,
        asked_question_id=asked_id,
        extraction_ready=extraction_ready,
        updated_state=updated_state,
        ai_metadata=meta,
        pseudonymization_metadata=_pseudonymization_meta(result),
    )


@app.post("/profile/extract", response_model=ProfileExtractionOutput)
async def profile_extract(body: ProfileExtractionInput) -> ProfileExtractionOutput:
    raw = body.transcript or "\n".join(m.text for m in (body.messages or []))

    # 1. Pseudonymize FIRST — gate. If blocked, fail closed.
    result = pseudonymize(raw)
    if result.blocked:
        return ProfileExtractionOutput(
            profile=DraftProfile(),
            blocked=True,
            blocked_reason=result.blocked_reason,
            is_mock=True,
            extraction_status="blocked",
        )

    # 2. Heuristic extraction over RAW text (trusted local; no network).
    rich, legacy = profile_extractor.extract(raw, body.role_family)

    # 3. Route for cost/tracing + optional real-model extraction. The LLM only
    #    ever sees the pseudonymized transcript. The canonicalization rubric makes
    #    the model emit a `canonical_role_id` from the closed taxonomy set.
    messages = [
        {
            "role": "system",
            "content": EXTRACTION_SYSTEM_PROMPT + canonicalization_instruction() + _schema_hint(),
        },
        {"role": "user", "content": result.text},
    ]
    content, meta = await router.run(
        "profile_extraction",
        messages=messages,
        mock_response=rich.model_dump_json(),
        real_call_allowed=True,
        user_ref=body.worker_ref,
    )

    # In real mode, prefer a valid LLM profile but keep locally-read fields
    # (city/salary) since the model only saw masked text.
    if meta.real_call and meta.success:
        # Canonicalization first, LENIENTLY: pull the role id straight from the raw
        # JSON and trust it only if it is a known canonical id (reject
        # hallucinations). This is independent of the strict rich-draft validation
        # below — the model routinely nulls/loosely-types enrichment fields, and a
        # correct canonical role id must not be discarded just because (say)
        # `experience_level` came back null. A valid id overrides the heuristic on
        # `legacy` — the field the canonicalization eval measures — and derives the
        # trade id. A null/invalid id keeps the heuristic.
        role_id = normalize_role_id(extract_canonical_role_id(content))
        if role_id is not None:
            legacy.canonical_role_id = role_id
            legacy.canonical_trade_id = ROLE_TRADE.get(role_id, legacy.canonical_trade_id)
        # Field-by-field enrichment overlay: keep each well-formed model field even
        # when siblings are malformed (location/salary stay local — masked input).
        rich = profile_extractor.merge_model_draft(rich, content)
        # TODO(WS4 recall backfill, owner review): once the real-eval NEGATIVE tier
        # is confirmed unaffected, enable the rich->legacy canonical backfill here:
        #   legacy = profile_extractor.map_rich_to_legacy(rich, legacy)
        # It fills in-scope machine/skill/role ids the raw-text detector missed
        # (writing only closed-set gazetteer ids). Deferred because backfilling the
        # role from the model's free `primary_role` label could override the model's
        # AUTHORITATIVE `canonical_role_id=null` on a helper/adjacent case and
        # regress the negative tier — verify against the staging --real eval first.

    # Q14 (ADR-0030 OQ#3) — the LIVE-PATH producer of skill_labels: carry the
    # rich draft's raw skill LABELS onto the persisted legacy profile so the
    # résumé can render them. LABELS ONLY — deliberately NOT the deferred WS4
    # map_rich_to_legacy role/id backfill above (negative-tier risk); the
    # matchable `skills`/`machines`/role ids are untouched here. CERTIFIED AT
    # REST via sanitize_skill_labels (hygiene clamp + pseudonymize
    # certification): apps/api persists this profile as profiles.raw_profile and
    # later generated_resumes.sourceProfileSnapshot, and the PDF + payer-facing
    # disclosure surfaces render skill_labels from that snapshot with NO
    # TypeScript pseudonymize equivalent — a suspect label must never persist.
    # The résumé boundary re-certifies (defense in depth). Never logs label text.
    legacy.skill_labels = profile_extractor.sanitize_skill_labels(
        legacy.skill_labels + rich.skills
    )

    # TAX-4/FORK-B-1: vector-canonicalize the SKILL labels (SG-3 — the vector layer
    # assigns ids from the closed skill_alias set; below-floor phrases are recorded
    # pseudonymized + stay raw). SKILLS ONLY — deliberately NOT map_rich_to_legacy's
    # role backfill, which the WS4 TODO above still defers (negative-tier risk).
    # Inert unless BOTH the flag is on AND the seam is configured (get_skill_store
    # returns the NullSkillStore otherwise) — the TD65 activation chain.
    if settings.skill_canonicalize_enabled:
        labels = rich.skills + rich.controllers
        # TD68 (TD27 SpendLedger wiring, REAL embed path only): reserve the projected
        # cost of the WHOLE label pass before it runs; on a ledger block SKIP the pass
        # entirely — labels stay raw, the NullSkillStore status quo (extraction is
        # never blocked by canonicalization). Mock embed path: zero ledger traffic.
        embed_is_mock = not settings.real_call_enabled_for(EMBEDDING_TASK_TYPE)
        reserved_inr = 0.0
        ledger_blocked = False
        if not embed_is_mock and labels:
            in_rate, _out = rate_inr_per_1k(settings.embedding_model)
            reserved_inr = (
                sum(cost_tracker.estimate_tokens(label) for label in labels) / 1000.0
            ) * in_rate
            # user_ref attributes this spend to the worker's per-user daily cap —
            # same attribution as the sibling router.run call above (#238 F2).
            reason = await cost_tracker.get_ledger().would_exceed_spend(
                reserved_inr, settings, user_ref=body.worker_ref
            )
            if reason is not None:
                ledger_blocked = True
                reserved_inr = 0.0  # nothing was reserved on a block
                # Counts/reason only — never label text.
                logger.warning(
                    "extract canonicalize pass skipped by spend ledger",
                    extra={"extra": {"labels": len(labels), "reason": reason}},
                )
        if not ledger_blocked:
            actual_inr = 0.0
            try:
                # OFF the event loop (#222 HIGH): the store + a real embed are SYNC httpx
                # calls (per label). Inline they would freeze the whole service (health
                # checks, every concurrent turn) for up to timeout x labels when the
                # api/provider is slow — to_thread keeps the loop serving while the pass
                # runs.
                assigned, _unresolved = await asyncio.to_thread(
                    canonicalize_labels,
                    labels,
                    settings.skill_canonicalize_default_domain,
                    get_skill_store(settings),
                    settings,
                )
                # Leave the full reservation recorded as the actual spend (conservative).
                actual_inr = reserved_inr
            finally:
                if reserved_inr > 0.0:
                    # On a raise, actual_inr stayed 0.0 => full refund (no leak).
                    await cost_tracker.get_ledger().record_spend(
                        reserved_inr, actual_inr, user_ref=body.worker_ref
                    )
            for sid in assigned:
                if sid not in legacy.skills:
                    legacy.skills.append(sid)

    # Honest-adjacency flag (advisory ONLY — never ranks/rejects): mark the draft
    # adjacent when it canonicalized to nothing matchable in the CNC/VMC taxonomy
    # (e.g. welding), so it is not silently half-empty. Additive; no matchable
    # field is written here.
    if profile_extractor.is_outside_cnc_vmc_scope(legacy):
        rich.unmatchable_reason = profile_extractor.UNMATCHABLE_OUTSIDE_SCOPE

    logger.info("profile extracted", extra={"extra": {"is_mock": not meta.real_call}})
    return ProfileExtractionOutput(
        profile=legacy,
        blocked=False,
        is_mock=not meta.real_call,
        extraction_status="completed",
        worker_profile_draft=rich,
        ai_metadata=meta,
    )


@app.post("/resume/generate", response_model=ResumeGenerationOutput)
async def resume_generate(body: ResumeGenerationInput) -> ResumeGenerationOutput:
    # Q14: `skill_labels` is the ONLY free-text field on the résumé profile
    # (everything else is closed-set ids/enums/numbers). Labels are already
    # CERTIFIED AT REST at population (/profile/extract → sanitize_skill_labels),
    # but the boundary RE-certifies every label (defense in depth — this also
    # covers old/hand-crafted payloads) before it may appear in the artifact OR
    # the LLM payload — the SAME filtered profile feeds build_resume
    # (mock/deterministic text) and the json.dumps LLM payload below, so both
    # see identical labels. The labels are worker-CONFIRMED by construction:
    # résumé generation is triggered only after `profile.confirmed`
    # (profiles.service.ts) and reads the confirmed snapshot — no new
    # confirmation mechanics here. The résumé ALWAYS completes:
    # all-labels-dropped just degrades the skills line.
    profile = body.profile
    if profile.skill_labels:
        kept = certified_clean_skill_labels(profile.skill_labels)
        if len(kept) != len(profile.skill_labels):
            # COUNT only — never the label text (a dropped label is suspect PII).
            logger.debug(
                "resume skill labels dropped by pseudonymize gate",
                extra={"extra": {"dropped": len(profile.skill_labels) - len(kept)}},
            )
        profile = profile.model_copy(update={"skill_labels": kept})
    text, data = build_resume(profile)
    messages = [
        {"role": "system", "content": RESUME_SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(data)},
    ]
    resume_text, meta = await router.run(
        "resume_generation",
        messages=messages,
        mock_response=text,
        real_call_allowed=True,
        user_ref=body.worker_ref,
    )
    return ResumeGenerationOutput(
        resume_text=resume_text,
        resume_json=data,
        format="text",
        is_mock=not meta.real_call,
    )


@app.post("/voice/transcribe", response_model=TranscriptionOutput)
async def voice_transcribe(body: TranscriptionInput) -> TranscriptionOutput:
    # Mock by default; the real Sarvam call is gated behind AI_ENABLE_REAL_CALLS
    # (+ key) and fails closed. The adapter never sends audio on the mock path.
    # 30-120s notes ride the chunked-sync path inside the adapter (D-2);
    # worker_ref attributes the per-chunk spend to the TD27 per-user daily cap.
    result = await stt_adapter.transcribe(
        storage_path=body.storage_path,
        duration_seconds=body.duration_seconds,
        language_code=body.language_code,
        real_call_allowed=body.real_call_allowed,
        worker_ref=body.worker_ref,
    )
    # Translate the transcript to English (gated, mock-by-default, fail-closed).
    # The adapter skips English sources and returns empty english on any failure.
    english_text = ""
    if body.translate_to_english and result.transcript_text.strip():
        translation = await translate_adapter.translate(
            text=result.transcript_text,
            source_language_code=result.language_code,
            real_call_allowed=body.real_call_allowed,
        )
        english_text = translation.english_text
    # PRIVACY: never log transcript or english TEXT (raw worker free-text). Counts only.
    logger.info(
        "voice transcribe",
        extra={
            "extra": {
                "voice_note_id": body.voice_note_id,
                "is_mock": result.is_mock,
                "confidence": result.confidence,
                "char_count": len(result.transcript_text),
                "english_len": len(english_text),
                "language": result.language_code,
                "error_code": result.error_code,
            }
        },
    )
    return TranscriptionOutput(
        transcript_text=result.transcript_text,
        confidence=result.confidence,
        language_code=result.language_code,
        is_mock=result.is_mock,
        english_text=english_text,
    )


def _schema_hint() -> str:
    keys = ", ".join(WorkerProfileDraft.model_fields.keys())
    return f"Schema keys: {keys}."


