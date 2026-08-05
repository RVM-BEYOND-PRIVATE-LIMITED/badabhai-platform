"""Liveness + spend telemetry: GET /health, GET /ai/spend."""

from __future__ import annotations

from fastapi import APIRouter

from ..ai import cost_tracker
from ..config import get_settings
from ._shared import router, settings

api_router = APIRouter()


@api_router.get("/health")
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


@api_router.get("/ai/spend")
async def ai_spend(user_ref: str | None = None) -> dict:
    """PII-free cumulative spend + retry-budget usage vs. caps (TD27).

    Numbers / model ids / UTC date only — never message content. Pass an opaque
    ``user_ref`` to also see that worker's spend vs the per-user daily cap. Scope is
    per-process with the in-process backend; GLOBAL across workers with Redis
    (AI_SPEND_REDIS_URL set). snapshot is async (may touch Redis); await it.
    """
    return await cost_tracker.get_ledger().snapshot(settings, user_ref=user_ref)
