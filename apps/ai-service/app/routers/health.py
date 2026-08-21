"""Liveness + spend telemetry: GET /health, GET /ai/spend."""

from __future__ import annotations

from fastapi import APIRouter

from ..ai import cost_tracker
from ..ai.langfuse_tracing import get_tracer
from ..config import get_settings
from ._shared import router, settings

api_router = APIRouter()


@api_router.get("/health")
async def health() -> dict:
    # TD67: under the LOCKED posture the tokenless health surface is liveness + the
    # posture boolean ONLY — spend telemetry / caps / provider posture are recon data
    # on a shared network (the full snapshot stays available on the token-gated
    # /ai/spend). With auth off (dev default), the full payload is unchanged.
    #
    # WHICH BUILD IS ANSWERING. Present in BOTH branches on purpose: the contract
    # shared with apps/api and apps/payer-web is that `build` is ALWAYS readable —
    # never omitted, never null — so a consumer can ask "is the box running the commit
    # I think it is?" without first knowing which posture the service is in. Safe under
    # the TD67 trim, unlike the spend/provider fields below: a commit sha is public (it
    # is in the ghcr image tag), so it is not the recon data that branch withholds.
    # `build_id` cannot raise and cannot be empty — an unwired build arg reads
    # "unknown", it never fails this probe (the deploy's health gate consumes it).
    build = get_settings().build_id
    if get_settings().ai_internal_token is not None:
        return {
            "status": "ok",
            "service": "ai-service",
            "service_auth_enabled": True,
            "build": build,
        }
    return {
        "status": "ok",
        "service": "ai-service",
        "build": build,
        "real_calls_enabled": settings.real_calls_enabled,
        # TD67: whether the service-level bearer is enforced (true once
        # AI_INTERNAL_TOKEN is set in the service env). Boolean only — never the value.
        "service_auth_enabled": False,
        # Actual tracer state (keys present AND package installed), not just config.
        "langfuse_enabled": router.langfuse_enabled,
        # WHICH OPTIONAL LANGFUSE SURFACES ACTUALLY BOUND — {scores, prompt_management,
        # trace_continuation}. The SDK is an optional dependency whose method names for
        # these three are not verifiable outside an image that installed
        # requirements-ai.txt, so `langfuse_tracing` probes for them at init and every
        # unbound one degrades SILENTLY to a no-op. That is the right runtime behaviour and
        # a terrible diagnostic one: without this readout "no scores are reaching Langfuse"
        # and "the installed SDK exposes no scoring method" look identical from outside the
        # process, and only the first of those is a bug. Config ids and booleans only — no
        # keys, no URLs. Deliberately NOT in the TD67-trimmed payload above: it is provider
        # posture, which is exactly the recon data the locked branch exists to withhold.
        "langfuse_capabilities": get_tracer().capabilities,
        "max_call_cost_inr": settings.ai_max_call_cost_inr,
        # Which spend-ledger backend is active (redis = global caps; in_process =
        # per-worker). PII-free; no store round-trip.
        "spend_store": cost_tracker.get_ledger().backend_name,
        # PII-free cumulative spend / retry-budget usage-vs-cap (TD27). snapshot is
        # async (it may touch the Redis backend); await it.
        "spend": await cost_tracker.get_ledger().snapshot(settings),
    }


@api_router.get("/ai/spend")
async def ai_spend(user_ref: str | None = None) -> dict:
    """PII-free cumulative spend + retry-budget usage vs. caps (TD27).

    Numbers / model ids / UTC date only — never message content. Pass an opaque
    ``user_ref`` to also see that worker's spend vs the per-user daily cap. Scope is
    per-process with the in-process backend; GLOBAL across workers with Redis
    (AI_SPEND_REDIS_URL set). snapshot is async (may touch Redis); await it.
    """
    return await cost_tracker.get_ledger().snapshot(settings, user_ref=user_ref)
