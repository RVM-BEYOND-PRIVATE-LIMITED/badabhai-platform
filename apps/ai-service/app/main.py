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
    ConversationMessage,
    ConversationState,
    DraftProfile,
    GrowthClusterInput,
    GrowthClusterOutput,
    JobDomainMatch,
    JobPostingChatOpeningInput,
    JobPostingChatOpeningOutput,
    JobPostingChatTurnInput,
    JobPostingChatTurnOutput,
    ProfileExtractionInput,
    ProfileExtractionOutput,
    ProfilingOpeningInput,
    ProfilingOpeningOutput,
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
from .extraction import build_resume, resolve_taxonomy_ids
from .job_posting_chat import answers as job_posting_answers
from .job_posting_chat import interview_engine as job_posting_engine
from .logging_config import configure_logging, get_logger
from .profiling import persona_guard, profile_extractor, rfs
from .profiling.canonical_roles import (
    ROLE_TRADE,
    canonicalization_instruction,
    extract_canonical_role_id,
    normalize_role_id,
)
from .profiling.domain_match import (
    build_query_text as build_domain_query,
)
from .profiling.domain_match import (
    get_domain_store,
)
from .profiling.domain_match import (
    match_domain as match_job_domain,
)
from .profiling.opener import one_shot_opener_for
from .profiling.prompts import (
    RESUME_SYSTEM_PROMPT,
    build_chat_messages,
    extraction_system_prompt,
)
from .profiling.signals import has_first_person_claim, label_for_id
from .profiling.turn_schema import coerce_turn, fallback_turn, fallback_turn_json
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
    (``redis.asyncio.from_url`` is lazy — it connects on first command), so a
    well-formed but UNREACHABLE Redis still boots fine and still fails CLOSED per call.
    It does not import anything ``main`` has not already imported, so there is no cycle.

    DELIBERATELY UNGUARDED. ``from_url`` does no I/O but it does PARSE eagerly, so a
    malformed URL raises here rather than returning. Letting that abort the boot is the
    CORRECT outcome, and the reason there is no try/except:

    - Both malformed-URL paths now fail with a message that NAMES AI_SPEND_REDIS_URL —
      the scheme typo at ``Settings()`` (config.py's validator, so it aborts at import,
      before this hook), anything else at ``RedisSpendBackend.__init__``. A loud, named,
      boot-time failure is precisely what this PR exists to produce.
    - Swallowing it would be strictly worse: the service would boot with no usable
      ledger, and the next real call would re-enter ``get_ledger()`` and raise INSIDE
      ``router.run`` — breaching the router's never-raise contract and turning a config
      typo into a worker-facing 500 instead of a mock fallback.
    - Fail-closed: a ledger that cannot be constructed cannot verify a cap, and an
      unverifiable cap must never permit real spend.
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


# The WORKER-facing pseudonymization-blocked reply.
#
# WHY THE COPY MATTERS MORE THAN A NORMAL ERROR STRING: apps/api STORES this as an
# outbound chat message, so it lands in the worker's transcript and therefore in the
# EXTRACTION CORPUS — it is not a toast that disappears. It was English ("Sorry, I
# couldn't process that safely. Please rephrase without sharing personal details like
# your phone number, full name, or company name.") in a Hinglish, chat-first product,
# from a bot that speaks Hinglish on every other turn.
#
# The persona rules it now satisfies, each pinned by test_persona_neutrality
# (_worker_facing_strings carries this string, so the whole banned-token net applies):
#   * "aap" form, never "tu"/"tum";
#   * NO vocative — never bhai / bhaiya / beta / behen / yaar;
#   * no exclamation mark, no emoji, two short sentences;
#   * it tells the worker WHAT TO DO DIFFERENTLY and says nothing about our internals
#     (no "safely", no "processing", no mention of a gateway or a rule).
#
# Aligned in tone with the Flutter sibling `kChatBlockedNotice`
# ("Aapki baat theek se nahi pahunch payi — thoda saaf karke dobara likhein.") — the
# two are DELIBERATELY not byte-identical: the client string is a generic
# transport/parse notice, this one is served when the privacy gateway blocked the turn,
# so it names the two things that most often cause it. It never says WHY in our terms.
_BLOCKED_REPLY = (
    "Aapki baat theek se nahi pahunch payi. "
    "Phone number ya poora naam likhe bina dobara bhejiye."
)

# The PAYER-facing equivalent (ADR-0035 job-posting chat). Deliberately a separate
# constant and deliberately still English: the job-posting engine speaks English to
# payers on every turn, so handing them the worker persona's Hinglish here would be a
# tone break on a different product surface — and nothing above applies (the payer
# transcript is not a worker profiling corpus). Same fail-closed semantics.
_JOB_POSTING_BLOCKED_REPLY = (
    "Sorry, I couldn't process that safely. Please rephrase without sharing "
    "contact details like a phone number, a person's name, or a company name."
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


@app.post("/profiling/opening", response_model=ProfilingOpeningOutput)
async def profiling_opening(body: ProfilingOpeningInput) -> ProfilingOpeningOutput:
    """The ONE-SHOT opener text — an invitation to answer everything in one message.

    Unconditional and pure on purpose: this route always serves the opener, and the
    decision of whether a worker SEES it lives in apps/api behind
    CHAT_ONE_SHOT_OPENER_ENABLED. Putting the flag here instead would leave a dead
    branch that no test exercises, and could not make "off" mean what it has to mean
    — that /chat/session takes no network hop at all.

    No model call, no pseudonymization: the response is a module constant. The
    opener carries no vocative, so nothing worker-identifying passes through here.
    """
    return ProfilingOpeningOutput(opening_text=one_shot_opener_for(body.role_family))


@app.post("/profiling/respond", response_model=ProfilingTurnOutput)
async def profiling_respond(body: ProfilingTurnInput) -> ProfilingTurnOutput:
    """One LLM-driven interview turn.

    The deterministic question bank is gone. The model conducts the interview for
    whatever trade the worker actually does; this handler owns everything the model is
    not allowed to decide: the privacy gate, the turn budget, whether the interview is
    over, and whether the reply is on-persona.

    ORDER IS THE CONTRACT:
      1. pseudonymize EVERY worker-derived surface, fail closed
      2. call the model
      3. guard the reply, repair once, else fall back
      4. merge what was captured; the SERVICE decides completion, not the model
    """
    settings_now = get_settings()
    prior = body.conversation_state
    role_family = (prior.role_family if prior else None) or body.role_family
    turn_index = (prior.turn_count if prior else 0) + 1

    # 1. Pseudonymize FIRST — the gate for any external LLM call, and it now covers
    #    FIVE worker-derived surfaces, not one. The old handler only had `message_text`
    #    to gate because history was never sent; re-arming history widened the egress
    #    surface, so every leg is masked and ANY blocked leg fails the whole turn
    #    closed. A partially-masked transcript must never reach a provider.
    #
    #    THE THREE LEGS ARE NOT THE SAME KIND OF THING, so they do not fail the same way.
    #    The WORKER'S MESSAGE is live input: it is the thing the gate exists for, and an
    #    unmaskable message fails the whole turn closed, unchanged. HISTORY and CAPTURED
    #    are SERVER-HELD STATE, re-evaluated identically on every subsequent turn — so
    #    blocking the turn on them is not fail-closed, it is a LIVELOCK. A single value
    #    that trips the gate (a normalised start date like "20260801" reads as a residual
    #    numeric sequence) would freeze `turn_count` forever: the cap can never fire,
    #    completion never comes, no flush, no profile, and the worker is told to rephrase
    #    a message that is not the problem. The buffer then expires and the whole
    #    interview is lost. So an unmaskable piece of STATE is DROPPED, not served: it
    #    never reaches the provider (the privacy guarantee is intact — strictly less
    #    leaves than before), the interview continues, and a dropped field is simply
    #    asked again.
    result = pseudonymize(body.message_text)
    masked_history: list[ConversationMessage] = []
    dropped_history = 0
    for msg in body.history:
        leg = pseudonymize(msg.text)
        if leg.blocked:
            dropped_history += 1
            continue
        masked_history.append(ConversationMessage(role=msg.role, text=leg.text))

    masked_captured: dict[str, str] = {}
    dropped_captured = 0
    for key, value in (prior.captured if prior else {}).items():
        leg = pseudonymize(value)
        if leg.blocked:
            dropped_captured += 1
            continue
        masked_captured[key] = leg.text

    if dropped_history or dropped_captured:
        # Counts only — the offending text is by definition un-maskable, so it is the
        # last thing that may be logged.
        logger.warning(
            "dropped un-maskable state from the turn",
            extra={
                "extra": {
                    "history_legs": dropped_history,
                    "captured_fields": dropped_captured,
                    "turn": turn_index,
                }
            },
        )

    if result.blocked:
        logger.warning(
            "profiling blocked",
            extra={"extra": {"reason": result.blocked_reason or "blocked", "leg": "message"}},
        )
        return ProfilingTurnOutput(
            reply_text=_BLOCKED_REPLY,
            blocked=True,
            blocked_reason=result.blocked_reason or "blocked",
            is_mock=True,
            # State is returned UNCHANGED on a blocked turn: nothing was learned, and
            # advancing the turn counter would spend one of the worker's turns on a
            # message the model never saw.
            updated_state=prior,
            pseudonymization_metadata=_pseudonymization_meta(result),
        )

    # 2. Ask the model. `mock_response` is a VALID TURN in its own right now — with the
    #    question bank deleted there is no templated question behind the router's
    #    never-raise contract, so the fallback has to be JSON of the same shape. One
    #    parse path, no "prose or JSON?" branch.
    missing_before = rfs.missing_required(masked_captured, settings_now)
    window = settings_now.profiling_history_max_turns
    # A turn is a worker+assistant pair, so the window is doubled into messages. The
    # bound exists because re-sending the transcript every turn is O(n^2) input cost —
    # exactly why history used to be dropped entirely. Windowing keeps the follow-ups
    # the interview needs while capping a pathological 40-turn session.
    windowed = masked_history[-(window * 2) :] if window > 0 else masked_history

    def _messages(repair: str | None = None) -> list[dict[str, str]]:
        return build_chat_messages(
            settings=settings_now,
            history=windowed,
            worker_message=result.text,
            role_family=role_family,
            captured=masked_captured,
            missing=missing_before,
            turn_index=turn_index,
            force_complete=body.force_complete,
            repair=repair,
        )

    # IS THIS THE CLOSING TURN? Exactly the condition under which `turn_context_message`
    # tells the model to stop asking: the cap fired, or nothing required is left. It must
    # be computed from `missing_before` — the same pre-merge view the PROMPT was built
    # from — so the instruction the model received and the rule the guard enforces can
    # never disagree. Deriving it post-merge instead would re-introduce the contradiction
    # from the other side.
    is_final_turn = (
        body.force_complete
        or turn_index >= settings_now.profiling_max_turns
        or not missing_before
    )

    fallback_json = fallback_turn_json(
        missing_before[0] if missing_before else None, is_final=is_final_turn
    )
    reply_raw, meta = await router.run(
        "profiling_chat_turn",
        messages=_messages(),
        mock_response=fallback_json,
        real_call_allowed=body.real_call_allowed,
        user_ref=body.worker_ref,
    )

    turn = coerce_turn(reply_raw) or fallback_turn(
        missing_before[0] if missing_before else None, is_final=is_final_turn
    )
    # Hold `asked_field` to the SAME closed vocabulary as `captured`, and do it BEFORE
    # the guard runs — the never-re-ask law is a membership test against this value, so
    # an unvalidated id disables it silently rather than loudly.
    turn.asked_field = rfs.normalize_asked_field(turn.asked_field, settings_now)

    # 3. The persona guard. Most of the persona spec is mechanically checkable, and a
    #    prompt is a request rather than a guarantee — the deterministic engine never
    #    needed this because its questions were hand-written strings. On a violation we
    #    spend ONE repair call quoting the specific broken rule; if that also fails the
    #    worker gets a safe templated turn rather than an off-persona one.
    # NOTE: violations are deliberately NOT accumulated here. `GuardResult` keeps
    # `violations` (which may quote the model's reply) separate from `codes` (a closed,
    # content-free vocabulary) precisely so the two cannot be confused at a sink. A
    # module-level list of violation strings with no consumer is one line away from being
    # logged or returned, which is the exact hazard that split exists to prevent — so it
    # does not exist. `violations` reaches the MODEL via `repair_instruction` and nowhere
    # else; logs get `codes`.
    if settings_now.profiling_persona_guard_enabled:
        prior_replies = [m.text for m in masked_history if m.role == "assistant"]
        # Hoisted so the FIRST check and the repair RE-CHECK ask exactly the same
        # question. They did not: the re-check omitted these two and fell back to
        # `appreciations_used=0, previous_had_appreciation=False`, under which the
        # "appreciation budget spent" and "two in a row" rules CANNOT fire. A model told
        # to fix three violations at once would fix the mechanical ones, keep the
        # appreciation, and pass a re-check that was blind to the only rule it still
        # broke — serving an off-persona line at double the cost.
        appreciations_used = persona_guard.count_appreciations(prior_replies)
        previous_had_appreciation = (
            bool(prior_replies) and persona_guard.count_appreciations(prior_replies[-1:]) > 0
        )

        def _check(reply: str, asked_field: str | None):
            return persona_guard.check_turn(
                reply,
                max_words=settings_now.profiling_max_reply_words,
                turn_index=turn_index,
                appreciations_used=appreciations_used,
                previous_had_appreciation=previous_had_appreciation,
                already_captured=frozenset(masked_captured),
                asked_field=asked_field,
                is_final=is_final_turn,
            )

        check = _check(turn.reply, turn.asked_field)
        attempts = settings_now.profiling_persona_repair_retries
        while not check.ok and attempts > 0:
            logger.info(
                "persona guard repair",
                # CODES, never `check.violations`. One violation message interpolates a
                # slice of the model's own reply (the acknowledgement it invented), and
                # that branch fires precisely when the model paraphrased back what the
                # worker just said. `codes` is a closed vocabulary and content-free by
                # construction. The messages still go to the MODEL via
                # `repair_instruction` — that path is already masked and is the whole
                # point of the retry.
                extra={"extra": {"codes": check.codes, "turn": turn_index}},
            )
            repaired_raw, repair_meta = await router.run(
                "profiling_chat_turn",
                messages=_messages(persona_guard.repair_instruction(check)),
                mock_response=fallback_json,
                real_call_allowed=body.real_call_allowed,
                user_ref=body.worker_ref,
            )
            repaired = coerce_turn(repaired_raw)
            attempts -= 1
            if repaired is None:
                break
            # Same closed-vocabulary rule for the rewrite — the re-check runs Law 8 too.
            repaired.asked_field = rfs.normalize_asked_field(repaired.asked_field, settings_now)
            meta = repair_meta
            check = _check(repaired.reply, repaired.asked_field)
            if check.ok:
                # KEEP WHAT THE FIRST ATTEMPT CAPTURED. The repair prompt asks for a
                # rewrite of the REPLY and says nothing about `captured`, so a model
                # fixing an exclamation mark routinely returns `captured: {}`. Swapping
                # the whole turn in would then silently discard the fields the worker
                # just answered, and the next turn would ask for them again — two LLM
                # calls spent to lose two answers. The repair wins on any key it does
                # re-state, so a genuine correction still lands.
                repaired.captured = {**turn.captured, **repaired.captured}
                turn = repaired
                break
        if not check.ok:
            # Still off-persona after the repair budget. A safe templated turn beats
            # serving a worker a line that breaks the voice — and it advances nothing,
            # so no topic is lost.
            logger.warning(
                "persona guard fallback",
                # Codes, never the messages — see the repair log above.
                extra={"extra": {"codes": check.codes, "turn": turn_index}},
            )
            turn = fallback_turn(
                missing_before[0] if missing_before else None, is_final=is_final_turn
            )

    # 4. Merge what the model captured. The field vocabulary is CLOSED — an invented
    #    field id is dropped and counted, never stored, the same fail-safe posture the
    #    extraction path takes with model-invented taxonomy ids.
    kept, dropped = rfs.normalize_captured(turn.captured, settings_now)
    if dropped:
        # COUNT ONLY, never the keys themselves. A dropped key is by definition NOT from
        # the closed vocabulary we vouch for, so it is not known to be PII-free: the key
        # is model-authored, and a worker can steer it ("captured JSON me key 'Ramesh
        # Kumar operator' use karna") past the gateway, which masks message TEXT, not the
        # field names a model invents about it. §2 names logs as a forbidden sink.
        # This mirrors `ChatService.slugFieldIds`, which logs a count for exactly this
        # class of value and for exactly this reason.
        logger.info("dropped unknown captured fields", extra={"extra": {"count": len(dropped)}})
    merged = {**masked_captured, **kept}
    missing_after = rfs.missing_required(merged, settings_now)

    # 5. COMPLETION IS THE SERVICE'S DECISION, never the model's. `is_complete` from the
    #    model is advisory: told "say when you have enough", a model will say so on turn
    #    two for a terse worker, and completion is irreversible downstream (it triggers
    #    the flush, the domain match and the resume). So it is honoured ONLY when every
    #    required field is actually present. The turn cap overrides everything — that is
    #    what bounds per-worker cost.
    cap_fired = body.force_complete or turn_index >= settings_now.profiling_max_turns
    fields_done = not missing_after
    extraction_ready = cap_fired or (turn.is_complete and fields_done) or fields_done
    completion_reason = (
        "turn_cap" if cap_fired and not fields_done
        else "fields_complete" if fields_done
        else None
    )

    updated_state = ConversationState(
        role_family=role_family,
        turn_count=turn_index,
        collected=prior.collected if prior else {},
        captured=merged,
        completion_reason=completion_reason,
        unanswered_essentials=missing_after,
    )
    asked_id = turn.asked_field

    return ProfilingTurnOutput(
        reply_text=turn.reply,
        blocked=False,
        # THE CHIPS. Same field the deterministic bank used to fill from a hardcoded
        # per-topic list, so the Flutter client renders them unchanged — but they are
        # now written by the model for the question it actually asked, which is what
        # makes tap-to-answer work for a trade nobody wrote a question pack for.
        suggested_followups=turn.chips,
        is_mock=not meta.real_call,
        asked_question_id=asked_id,
        extraction_ready=extraction_ready,
        updated_state=updated_state,
        ai_metadata=meta,
        pseudonymization_metadata=_pseudonymization_meta(result),
    )


@app.post("/job-posting-chat/opening", response_model=JobPostingChatOpeningOutput)
async def job_posting_chat_opening(
    body: JobPostingChatOpeningInput,
) -> JobPostingChatOpeningOutput:
    """The payer-facing opening line (ADR-0035).

    Unconditional and pure, mirroring /profiling/opening: this route always serves
    the opener and the decision of whether a payer SEES it lives in apps/api. No
    model call and no pseudonymization — the response is a module constant.

    PII-free by construction: the opener carries no vocative, no payer name and no
    organisation name (§Decision 3 — the org name is stamped server-side at publish
    and never enters this service).
    """
    return JobPostingChatOpeningOutput(
        opening_text=job_posting_engine.opening_message(body.trade_hint)
    )


@app.post("/job-posting-chat/respond", response_model=JobPostingChatTurnOutput)
async def job_posting_chat_respond(body: JobPostingChatTurnInput) -> JobPostingChatTurnOutput:
    """One payer turn of the job-posting interview (ADR-0035).

    Structurally identical to /profiling/respond, with the privacy order IDENTICAL
    and one deliberate difference (step 3).
    """
    # 1. Pseudonymize FIRST — the gate for any external LLM call, and it fails CLOSED.
    #    It runs even though the payer is describing a job rather than themselves: a
    #    payer can absolutely type their own phone number, a plant manager's name, or
    #    an applicant's name into free text, and the privacy gateway does not get an
    #    exemption based on who the principal is (§2 #3, ADR-0035 §Decision 2). It
    #    also runs BEFORE the engine, so a blocked turn never advances the interview
    #    and never touches the draft.
    result = pseudonymize(body.message_text)
    if result.blocked:
        logger.warning(
            "job posting chat blocked", extra={"extra": {"reason": result.blocked_reason}}
        )
        return JobPostingChatTurnOutput(
            reply_text=_JOB_POSTING_BLOCKED_REPLY,
            blocked=True,
            blocked_reason=result.blocked_reason,
            is_mock=True,
            # Both null: nothing was parsed, so the caller keeps the state and draft
            # it already had. The turn is a no-op by construction.
            draft=None,
            updated_state=None,
            pseudonymization_metadata=_pseudonymization_meta(result),
        )

    # 2. The text the DRAFT may keep. Raw by default — a job's city and pay figures
    #    are the point of the posting and are masked before an LLM call but must
    #    survive onto the draft. Masked when this turn carried IDENTITY-class content
    #    (phone/person/employer/id), so a phone number typed into a description can
    #    never reach the stored draft or a published posting.
    draft_text = job_posting_answers.safe_draft_text(
        body.message_text, result.text, result.placeholder_tokens
    )

    # 3. Clarify BEFORE advancing: a clarifying message ("what do you mean?") is not
    #    an answer, and next_turn would mis-advance the state (the confusing topic
    #    lands in asked_question_ids and _next_topic skips it forever, essentials
    #    included). clarify_turn refuses — None, engine runs normally — when there is
    #    nothing to re-serve, when the message carries an extractable ANSWER
    #    (answer-trumps-clarify), or when the consecutive clarify budget is spent.
    is_clarify = job_posting_engine.needs_rephrase(body.message_text)
    turn = (
        job_posting_engine.clarify_turn(
            body.conversation_state, body.message_text, body.trade_hint
        )
        if is_clarify
        else None
    )
    if turn is None:
        turn = job_posting_engine.next_turn(
            body.conversation_state,
            body.message_text,
            body.trade_hint,
            draft_text=draft_text,
        )
    reply_text, asked_id, updated_state, draft_ready = turn

    # 4. ZERO LLM CALLS, on every path — the one place this route deviates from
    #    /profiling/respond, and it deviates in the cheaper direction. The engine has
    #    already produced a short, on-tone, employer-facing question, so the reply is
    #    returned verbatim: no router round-trip, no tokens, no cost. The rephrase
    #    seam (prompts.build_job_posting_chat_messages) is written and documented but
    #    NOT wired, because AIRouter.run resolves the task route first and RAISES on
    #    an unknown task type — registering `job_posting_chat_turn` in
    #    app/ai/model_config.py plus a rephrase settings flag is the follow-up that
    #    turns it on. `is_mock=True` and `ai_metadata=None` are therefore the honest
    #    values, not placeholders.
    return JobPostingChatTurnOutput(
        reply_text=reply_text,
        blocked=False,
        # Chips are ANSWERS to the question in `reply_text`, keyed on the topic
        # actually being asked this turn — `None` on the wrap-up turn yields none.
        suggested_answers=job_posting_engine.suggested_answers(asked_id, body.trade_hint),
        is_mock=True,
        asked_question_id=asked_id,
        draft_ready=draft_ready,
        draft=job_posting_engine.build_draft(updated_state, body.trade_hint),
        updated_state=updated_state,
        pseudonymization_metadata=_pseudonymization_meta(result),
    )


@app.post("/profile/extract", response_model=ProfileExtractionOutput)
async def profile_extract(body: ProfileExtractionInput) -> ProfileExtractionOutput:
    # Two texts, deliberately different, because two consumers need different things.
    #
    # `llm_text` is the WHOLE conversation, both directions. The model needs our
    # questions to read an answer in context ("5 saal" means nothing alone), and
    # apps/api already labels each line `Worker:` / `Bada Bhai:` so it can tell
    # them apart. Unchanged from before this split — the model was never the
    # problem.
    #
    # `worker_text` is the worker's OWN lines only, and it feeds the deterministic
    # detector. That detector is a keyword/regex reader with no notion of who is
    # speaking, so on the combined blob it read OUR question text as the worker's
    # answers: a controller question listing "Fanuc, Siemens, Mitsubishi, Haas,
    # Heidenhain" produced all five controllers from a worker who said only
    # "fanuc"; a retry worded "jaise 2 saal ya 5 saal" produced 2.0 years from a
    # worker who said "5 saal"; the education question's own examples produced
    # `["ITI", "Diploma"]` from a worker who had not yet been asked. Measured: this
    # split alone corrects experience, preferred cities, skills, controllers and
    # that fabricated education.
    #
    # `messages` absent → both fall back to `transcript` and behaviour is
    # byte-identical to before. That is the rollback lever: apps/api sends both
    # fields, so dropping `messages` restores the previous behaviour exactly.
    msgs = body.messages or []
    if msgs:
        worker_text = "\n".join(m.text for m in msgs if m.role == "worker")
        llm_text = body.transcript or "\n".join(
            f"{'Worker' if m.role == 'worker' else 'Bada Bhai'}: {m.text}" for m in msgs
        )
    else:
        worker_text = llm_text = body.transcript or ""

    # 1. Pseudonymize FIRST — gate. If blocked, fail closed.
    #
    #    `llm_text` is gated because it is what reaches the model. `worker_text` is
    #    gated TOO, and separately, because the two are independent inputs whenever
    #    a caller sends both fields: nothing forces them to describe the same
    #    conversation, so gating only `llm_text` would let a caller hand the
    #    detector text the gate would have refused. apps/api always derives both
    #    from the same messages, so in practice this second call is redundant —
    #    but "in practice" is not a gate, and the property should be structural.
    #
    #    NOT claimed here (an earlier version of this comment did claim it):
    #    `worker_text` is not confined to this process. `rich` is derived from it
    #    and is passed to the router as `mock_response`, which the Langfuse tracer
    #    records as the trace output on the mock path and on every real-call
    #    failure. That payload is closed-set labels and numbers, not free text, and
    #    it predates this split — but it is egress, so the comment must not say
    #    otherwise.
    result = pseudonymize(llm_text)
    if not result.blocked and worker_text is not llm_text:
        worker_gate = pseudonymize(worker_text)
        if worker_gate.blocked:
            result = worker_gate
    if result.blocked:
        return ProfileExtractionOutput(
            profile=DraftProfile(),
            blocked=True,
            blocked_reason=result.blocked_reason,
            is_mock=True,
            extraction_status="blocked",
        )

    # 2. Heuristic extraction over the worker's OWN raw text (trusted local; no network).
    rich, legacy = profile_extractor.extract(worker_text, body.role_family)

    # 3. Route for cost/tracing + optional real-model extraction. The LLM only
    #    ever sees the pseudonymized transcript. The canonicalization rubric makes
    #    the model emit a `canonical_role_id` from the closed taxonomy set.
    messages = [
        {
            "role": "system",
            "content": (
                extraction_system_prompt(body.role_family)
                + canonicalization_instruction()
                + _schema_hint()
            ),
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
            # TD101: A valid id overrides the heuristic ONLY IF the heuristic found it too,
            # or the worker actually made a first-person claim in the text. This prevents
            # the LLM from inventing a role (like "CNC Setter-Operator") when the worker
            # just said "mera bhai operator hai".
            if legacy.canonical_role_id is None and not has_first_person_claim(worker_text):
                role_id = None

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
    legacy.skill_labels = profile_extractor.sanitize_skill_labels(legacy.skill_labels + rich.skills)

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

    # TD-EDU — carry the academic education level/field from the rich draft (the
    # LLM-filled source) onto the PERSISTED legacy profile, so the résumé + resume
    # tab (which read the DraftProfile snapshot) can show them. Mirrors the
    # skill_labels carry above; None stays None (mock mode leaves them unset).
    legacy.education_level = rich.education_level
    legacy.education_field = rich.education_field

    # #499 / TD102: carry the list-topics for education and certifications, sanitized.
    legacy.education = profile_extractor.sanitize_skill_labels(rich.education)
    legacy.certifications = profile_extractor.sanitize_skill_labels(rich.certifications)

    # GENERALIZED PROFILING — the RAG job-domain match. It runs HERE, and where it runs
    # is a deliberate choice: extraction is already off the request path (a BullMQ job),
    # already holds the whole pseudonymized transcript, and already produces exactly the
    # trade vocabulary the retrieval needs. Putting it on the chat's final turn instead
    # would have made the worker wait through an embed, an ANN lookup and a second model
    # call to see "Aapki profile ban rahi hai".
    #
    # NEVER RAISES, and never blocks. Every failure mode inside `match_domain` returns an
    # UNMATCHED status, and this wrapper catches anything unforeseen on top: a
    # classification that failed must cost the worker a label, never their profile.
    domain_match = None
    if settings.domain_match_enabled:
        try:
            query = build_domain_query(
                trade=label_for_id(legacy.canonical_role_id) if legacy.canonical_role_id else None,
                skills=list(rich.skills or []),
                machines=list(rich.machines or []),
            )
            domain_match = await match_job_domain(
                query,
                store=get_domain_store(settings),
                settings=settings,
                router=router,
                embed=embed_text,
                user_ref=body.worker_ref,
                # NO `real_call_allowed` override: unlike ProfilingTurnInput, the
                # extraction contract has no such field, and reading one off `body` here
                # raised an AttributeError that this block's own broad `except` then
                # swallowed into a silent `unmatched_degraded` — the feature looked
                # wired and matched nothing, with one log line naming only
                # "AttributeError". The default (True) is correct anyway: whether a real
                # call happens is decided by AI_ENABLE_REAL_CALLS plus the per-task
                # AI_REAL_CALL_TASKS allowlist inside the router, which is the single
                # enforcement point for every task.
            )
            logger.info(
                "domain match",
                extra={
                    "extra": {
                        "status": domain_match.status,
                        "job_domain_id": domain_match.job_domain_id,
                        "shortlist": len(domain_match.considered),
                    }
                },
            )
        except Exception as exc:  # noqa: BLE001 — a label is never worth a failed profile
            # `exc_info` so an unforeseen error is DIAGNOSABLE. The class name alone
            # ("AttributeError") is what a broad except usually leaves you with, and it
            # is not enough to find a wiring bug in a pass that otherwise degrades
            # silently by design. The traceback carries no worker text: everything in
            # this block is catalog ids, config numbers and already-masked phrases.
            logger.warning(
                "domain match errored",
                extra={"extra": {"error": type(exc).__name__}},
                exc_info=True,
            )
            domain_match = JobDomainMatch(status="unmatched_degraded")

    logger.info("profile extracted", extra={"extra": {"is_mock": not meta.real_call}})
    return ProfileExtractionOutput(
        profile=legacy,
        blocked=False,
        is_mock=not meta.real_call,
        extraction_status="completed",
        worker_profile_draft=rich,
        ai_metadata=meta,
        job_domain_match=(
            JobDomainMatch(
                status=domain_match.status,
                job_domain_id=domain_match.job_domain_id,
                score=domain_match.score,
                considered=domain_match.considered,
            )
            if domain_match is not None
            else None
        ),
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
    if profile.education:
        kept = certified_clean_skill_labels(profile.education)
        profile = profile.model_copy(update={"education": kept})
    if profile.certifications:
        kept = certified_clean_skill_labels(profile.certifications)
        profile = profile.model_copy(update={"certifications": kept})
    text, data = build_resume(profile)
    # Resolve all taxonomy IDs to human-readable labels BEFORE the LLM sees
    # them, so the LLM never echoes raw IDs like skill_milling or mach_vmc
    # into the generated resume text. The machine-readable resume_json that
    # travels alongside the text still carries the raw IDs.
    sanitized = {
        **data,
        "canonical_role_id": label_for_id(data["canonical_role_id"])
        if data.get("canonical_role_id")
        else None,
        "canonical_trade_id": label_for_id(data["canonical_trade_id"])
        if data.get("canonical_trade_id")
        else None,
        "skills": [label_for_id(s) for s in data.get("skills", [])],
        "machines": [label_for_id(m) for m in data.get("machines", [])],
        "skill_labels": [label_for_id(s) for s in data.get("skill_labels", [])],
    }
    payload = json.dumps(sanitized)

    # PSEUDONYMIZE GATE — invariant #3 on the ONE route that had none.
    #
    # THE GAP THIS CLOSES. `certified_clean_skill_labels` above filters exactly three
    # LIST fields; `build_resume` then returns `profile.model_dump()` — the ENTIRE
    # DraftProfile — and `sanitized` overrides only the taxonomy-id fields. So every
    # remaining value went into the user message VERBATIM: `education_level` and
    # `education_field` (model-authored free-text scalars, certified by nothing),
    # `location_preference.current_city` / `preferred_cities`, `experience`,
    # `salary_expectation`, `availability`. A name, phone or employer that a model
    # wrote into any of those egressed raw — while `/profiling/respond` and
    # `/profile/extract` mask that exact class of value on every turn.
    #
    # FAIL-CLOSED THE SAME WAY `/profiling/respond` DOES: on `blocked` the provider is
    # NEVER called. The route still COMPLETES — `text` is the deterministic résumé
    # `build_resume` already produced LOCALLY from the filtered profile, so a worker
    # never loses their résumé over a gateway block; only the LLM polish is skipped.
    # The OUTPUT SHAPE is unchanged (this schema carries no `blocked` field), and
    # `resume_json` stays `data`, the machine-readable ids, exactly as before.
    #
    # ACCEPTED COST, stated plainly: the masked payload is what a REAL model now sees,
    # so a worker's city can reach it as "[CITY_1]" and a 7-digit salary as
    # "[AMOUNT_1]". That is the same treatment every other route already applies to
    # those values, and over-masking is the locked safe direction. Under the committed
    # default (`AI_ENABLE_REAL_CALLS=false`) nothing changes at all: the router takes
    # its mock path and returns `text`, which is built from the unmasked profile.
    gate = pseudonymize(payload)
    if gate.blocked:
        logger.warning(
            "resume generation blocked before the LLM",
            extra={"extra": {"reason": gate.blocked_reason}},
        )
        return ResumeGenerationOutput(
            resume_text=resolve_taxonomy_ids(text),
            resume_json=data,
            format="text",
            is_mock=True,
        )

    messages = [
        {"role": "system", "content": RESUME_SYSTEM_PROMPT},
        {"role": "user", "content": gate.text},
    ]
    resume_text, meta = await router.run(
        "resume_generation",
        messages=messages,
        mock_response=text,
        real_call_allowed=True,
        user_ref=body.worker_ref,
    )
    resume_text = resolve_taxonomy_ids(resume_text)
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
    #
    # PSEUDONYMIZE GATE — this leg used to hand `result.transcript_text` to
    # `translate_adapter.translate` RAW AND VERBATIM, and `translate.py` says so in its
    # own module docstring ("the real /translate call sends the RAW transcript (which
    # may contain PII) to Sarvam"). Documented is not gated: it was an ungated
    # worker-free-text egress to an external provider, on the one route where the
    # worker is SPEAKING — the surface most likely to carry a name, a phone number and
    # an employer in one breath.
    #
    # THE STT HOP ABOVE IS DIFFERENT AND IS NOT TOUCHED: its input is AUDIO, which
    # cannot be pseudonymized, and that exposure is inherent and already recorded
    # (stt.py). This gate covers the TEXT hop, which is the one that can be masked.
    #
    # FAIL CLOSED, consistently: on `blocked` the provider is not called and
    # `english_text` stays "" — the exact degraded value the adapter already returns
    # on any translation failure, so the OUTPUT SHAPE and every downstream consumer
    # are unchanged. `transcript_text` returned below is the RAW transcript exactly as
    # before: this route's job is to give the worker their own words back, and those
    # words go to `voice_notes` inside our own boundary, not to a provider.
    english_text = ""
    if body.translate_to_english and result.transcript_text.strip():
        translate_gate = pseudonymize(result.transcript_text)
        if translate_gate.blocked:
            logger.warning(
                "voice translation blocked before the provider",
                extra={"extra": {"reason": translate_gate.blocked_reason}},
            )
        else:
            translation = await translate_adapter.translate(
                text=translate_gate.text,
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
