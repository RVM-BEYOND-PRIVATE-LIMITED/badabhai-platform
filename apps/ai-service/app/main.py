"""FastAPI AI service.

Endpoints: /health, /pseudonymize, /profile/parse, /profile/extract,
/resume/generate.

INVARIANT: pseudonymization runs BEFORE any external LLM path on every endpoint
that could reach an LLM. If pseudonymization is blocked, the LLM is never called
and a safe fallback is returned (fail closed). Model routing and cost tracking live
behind ``app.ai.router.AIRouter``; Langfuse tracing lives behind
``app.ai.langfuse_tracing.get_tracer()``, which the router uses and which the two
non-router AI boundaries (skill embeds, voice STT/translate) use directly.

The 14 handlers now live in ``app/routers/*.py`` (one module per endpoint group,
each exposing ``api_router``); the process-wide singletons they share live in
``app/routers/_shared.py``. This module owns app construction, the boot lifespan
hook and the TD67 service-auth middleware, and re-exports the names that used to
be defined here so every ``from app.main import ...`` specifier keeps working.
"""

from __future__ import annotations

import hmac
import logging
import re
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from .ai import cost_tracker, prompt_registry
from .ai.langfuse_tracing import get_tracer
from .config import get_settings
from .job_posting_chat import interview_engine as job_posting_engine
from .logging_config import configure_logging, correlation_id_var, get_logger, request_id_var
from .routers import (
    embeddings,
    growth,
    health,
    job_posting,
    privacy,
    profile,
    profiling,
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
    # Same argument, one boot earlier: build the tracer HERE so "langfuse enabled"
    # (or the reason it is not) is logged at STARTUP rather than on the first AI
    # call. Constructing it does no network I/O, and it never raises.
    tracer = get_tracer()
    # Bind each production prompt name to the builder that produces its LOCAL text, so
    # every generation can record WHICH prompt version ran. Done from the lifespan and not
    # at import time for the reason `install_default_prompts` states: it imports the
    # profiling package, and doing that from `app.ai` at module scope would give the AI
    # package a permanent import-time dependency on the profiling package.
    #
    # GUARDED, UNLIKE THE LEDGER ABOVE, and the asymmetry is the point. An unconstructable
    # ledger cannot verify a spend cap, so booting without one would let unverifiable real
    # spend through — fail closed, abort. A prompt registry is pure observability: without
    # it a route falls back to the literal it used before this module existed and every
    # answer is byte-identical, only the `prompt_version` attribute on the trace goes
    # missing. Taking the service down over a missing trace attribute would be the
    # observability layer causing the outage it exists to explain.
    try:
        prompt_registry.install_default_prompts()
    except Exception as exc:  # pragma: no cover - builders are pure string functions
        logger.warning(
            "prompt registry install failed; routes will use their local literals",
            extra={"extra": {"error": str(exc)}},
        )
    yield
    # Langfuse buffers spans in a background exporter, so the traces most worth
    # keeping — the ones from the minutes before a deploy or a crash-loop restart —
    # are exactly the ones an unflushed buffer drops. The SDK registers an `atexit`
    # hook, but a container SIGTERM'd by `docker stop` does not reliably reach it.
    # `shutdown()` flushes and joins the exporter, and swallows its own failures.
    tracer.shutdown()


app = FastAPI(title="BadaBhai AI Service", version="0.1.0", lifespan=_lifespan)

# TD67: paths reachable WITHOUT the service token. Everything else (including /docs
# and /openapi.json) is gated once AI_INTERNAL_TOKEN is set. NOTE: /health itself
# TRIMS its payload to {status, service, service_auth_enabled} under the locked
# posture — the full spend/posture telemetry is recon data on a shared network and
# stays token-only (via the gated /ai/spend or the full /health when auth is off).
_AUTH_EXEMPT_PATHS = frozenset({"/health"})

# BL-19: a caller-supplied x-request-id/x-correlation-id is logged VERBATIM into every
# line for that request (see request_id_tracing below) -- it must never be free text.
# UUID-shape-or-regenerate, not merely length-capped: this codebase's own invariant
# ("no PII in logs, ever") means a permissive cap (e.g. request-id.middleware.ts's
# apps/api-side 128-char bound on requestId alone) is not safe to mirror here, since a
# short string can still carry a name/phone/address. Reject anything that isn't exactly
# UUID-shaped and mint a fresh one instead of trusting the caller's text.
_TRACE_ID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE
)


def _safe_trace_id(supplied: str | None) -> str:
    # fullmatch, NOT match with a ^...$ pattern: Python's `$` matches at end-of-string
    # OR immediately before a single trailing "\n", so "<valid-uuid>\n" would otherwise
    # pass this check and get written straight into a response header. fullmatch has no
    # such exception -- the ENTIRE string must be the 36-char shape, nothing trailing.
    if supplied and _TRACE_ID_RE.fullmatch(supplied):
        return supplied
    return str(uuid.uuid4())


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


@app.middleware("http")
async def request_id_tracing(request, call_next):  # type: ignore[no-untyped-def]
    """BL-19: bind the caller's request/correlation id for every log line this
    request emits, and echo both back as response headers.

    apps/api's AiService generates a fresh id per outbound call and sends it here
    (mirrors the x-ai-internal-token pattern) -- this is the ai-service half of the
    fix that closes "a failing ai-service call produces no queryable trace tying
    the failure to the originating call" (16_OBSERVABILITY_AUDIT.md Section 4).
    Falls back to generating an id if the caller sent none (or something not
    UUID-shaped), so every request is traceable even from a caller that predates
    this change (curl, a future client) -- and so a caller can never get its own
    free text logged verbatim under the guise of a trace id.

    Registered SECOND so it becomes the OUTERMOST middleware (Starlette runs the
    last-registered middleware first) -- it must wrap service_auth, not sit inside
    it, so a request rejected by the 401 path still gets tagged and echoes the
    headers, rather than silently skipping tracing on exactly the failure class
    apps/api's AiService already logs a request id for.
    """
    request_id = _safe_trace_id(request.headers.get("x-request-id"))
    correlation_id = _safe_trace_id(request.headers.get("x-correlation-id"))
    request_id_token = request_id_var.set(request_id)
    correlation_id_token = correlation_id_var.set(correlation_id)
    try:
        response = await call_next(request)
    finally:
        request_id_var.reset(request_id_token)
        correlation_id_var.reset(correlation_id_token)
    response.headers["x-request-id"] = request_id
    response.headers["x-correlation-id"] = correlation_id
    return response


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
# The LLM-led interview (Phase A) + its whole-chat extraction (Phase C). Registered AFTER
# profile so the two /profile* routes keep their precedence in the route table.
app.include_router(profiling.api_router)
app.include_router(resume.api_router)
app.include_router(voice.api_router)

# R7 §1 — the SYNTHETIC-PERSONA harness, and the second of its three barriers.
#
# CONDITIONAL REGISTRATION IS THE POINT. A route that exists and checks a flag can still be
# reached, logged against, and mis-configured into serving; a route that was never registered
# 404s at the router and there is nothing behind it to reach. So on every process that has not
# deliberately set AI_SYNTHETIC_PERSONA_MODE — which is every deployed one, since a guard test
# keeps the variable out of both compose files — /synthetic/* does not exist.
#
# The import is inside the branch so an unarmed process does not even load the module.
if get_settings().synthetic_persona_mode:
    from .routers import synthetic  # noqa: PLC0415  (deliberate: unarmed processes never load it)

    app.include_router(synthetic.api_router)
    logging.getLogger("ai.synthetic").warning(
        "SYNTHETIC-PERSONA MODE ARMED: /synthetic/* is registered and BYPASSES the "
        "pseudonymisation gateway. Developer machines only; the real-worker routes are unchanged."
    )
