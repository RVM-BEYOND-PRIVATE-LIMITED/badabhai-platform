"""FastAPI AI service.

Endpoints: /health, /pseudonymize, /profile/parse, /profile/extract,
/resume/generate.

INVARIANT: pseudonymization runs BEFORE any external LLM path on every endpoint
that could reach an LLM. If pseudonymization is blocked, the LLM is never called
and a safe fallback is returned (fail closed). Model routing, cost tracking, and
Langfuse tracing all live behind ``app.ai.router.AIRouter``.

The 14 handlers now live in ``app/routers/*.py`` (one module per endpoint group,
each exposing ``api_router``); the process-wide singletons they share live in
``app/routers/_shared.py``. This module owns app construction, the boot lifespan
hook and the TD67 service-auth middleware, and re-exports the names that used to
be defined here so every ``from app.main import ...`` specifier keeps working.
"""

from __future__ import annotations

import hmac
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from .ai import cost_tracker
from .config import get_settings
from .job_posting_chat import interview_engine as job_posting_engine
from .logging_config import configure_logging, get_logger
from .routers import (
    embeddings,
    growth,
    health,
    job_posting,
    privacy,
    profile,
    resume,
    skills,
    voice,
)
from .routers._shared import (
    _pseudonymization_meta,
    router,
    settings,
    stt_adapter,
    translate_adapter,
)
from .routers.job_posting import _JOB_POSTING_BLOCKED_REPLY

__all__ = [
    "_JOB_POSTING_BLOCKED_REPLY",
    "_pseudonymization_meta",
    "app",
    "job_posting_engine",
    "logger",
    "router",
    "settings",
    "stt_adapter",
    "translate_adapter",
]

configure_logging()
logger = get_logger("ai-service")


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


# Registration order reproduces the pre-split route table. The one unavoidable
# deviation: /skills/retag-plan now sits beside /skills/canonicalize instead of
# after /growth/cluster. Every path is static and distinct, so no match order
# changes and the generated OpenAPI schema is byte-identical.
app.include_router(health.api_router)
app.include_router(privacy.api_router)
app.include_router(embeddings.api_router)
app.include_router(skills.api_router)
app.include_router(growth.api_router)
app.include_router(job_posting.api_router)
app.include_router(profile.api_router)
app.include_router(resume.api_router)
app.include_router(voice.api_router)
