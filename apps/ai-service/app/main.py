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
from .routers import embeddings as embeddings_router
from .routers import growth as growth_router
from .routers import health as health_router
from .routers import job_posting as job_posting_router
from .routers import privacy as privacy_router
from .routers import profile as profile_router
from .routers import profiling as profiling_router
from .routers import resume as resume_router
from .routers import skills as skills_router
from .routers import voice as voice_router
from .routers._shared import _pseudonymization_meta
from .routers.embeddings import _embed_batch_sync, embed_skill_aliases
from .routers.growth import growth_cluster_endpoint
from .routers.health import ai_spend, health
from .routers.job_posting import (
    _JOB_POSTING_BLOCKED_REPLY,
    job_posting_chat_opening,
    job_posting_chat_respond,
)
from .routers.privacy import pseudonymize_endpoint
from .routers.profile import _schema_hint, profile_extract
from .routers.profiling import _BLOCKED_REPLY, profiling_opening, profiling_respond
from .routers.resume import resume_generate
from .routers.skills import skills_canonicalize, skills_retag_plan
from .routers.voice import voice_transcribe
from .runtime import logger, router, settings, stt_adapter, translate_adapter
from .stt import SttAdapter
from .translate import TranslateAdapter

configure_logging()


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


# The route table, in the order the endpoints were declared before the split
# (/growth/cluster is the one hop: it sat between the two /skills routes, which a
# single include_router per module cannot reproduce — every path is static and
# disjoint, so matching and the generated OpenAPI are unaffected).
app.include_router(health_router.router)
app.include_router(privacy_router.router)
app.include_router(embeddings_router.router)
app.include_router(skills_router.router)
app.include_router(growth_router.router)
app.include_router(profiling_router.router)
app.include_router(job_posting_router.router)
app.include_router(profile_router.router)
app.include_router(resume_router.router)
app.include_router(voice_router.router)


# THE PRE-SPLIT IMPORT SURFACE. Every endpoint, helper and constant that used to be
# DEFINED here is now imported from app/routers/*, and every name main.py imported
# before the split is still imported above — so `from app.main import <anything that
# worked before>` still resolves, from the same specifier. Listing them keeps the
# re-exports explicit (and marks the pass-through imports as deliberate).
__all__ = [
    "AIRouter",
    "ConversationMessage",
    "ConversationState",
    "DraftProfile",
    "EMBEDDING_TASK_TYPE",
    "FastAPI",
    "GrowthClusterInput",
    "GrowthClusterOutput",
    "JSONResponse",
    "JobDomainMatch",
    "JobPostingChatOpeningInput",
    "JobPostingChatOpeningOutput",
    "JobPostingChatTurnInput",
    "JobPostingChatTurnOutput",
    "MOCK_MODEL",
    "ProfileExtractionInput",
    "ProfileExtractionOutput",
    "ProfilingOpeningInput",
    "ProfilingOpeningOutput",
    "ProfilingTurnInput",
    "ProfilingTurnOutput",
    "PseudonymizationInput",
    "PseudonymizationMeta",
    "PseudonymizationOutput",
    "PseudonymizationResult",
    "RESUME_SYSTEM_PROMPT",
    "ROLE_TRADE",
    "ResumeGenerationInput",
    "ResumeGenerationOutput",
    "RetagPlanInput",
    "RetagPlanOutput",
    "Settings",
    "SkillAliasEmbedInput",
    "SkillAliasEmbedItem",
    "SkillAliasEmbedOutput",
    "SkillAliasEmbedResult",
    "SkillCanonicalization",
    "SkillCanonicalizationInput",
    "SttAdapter",
    "TranscriptionInput",
    "TranscriptionOutput",
    "TranslateAdapter",
    "WorkerProfileDraft",
    "_AUTH_EXEMPT_PATHS",
    "_BLOCKED_REPLY",
    "_JOB_POSTING_BLOCKED_REPLY",
    "_embed_batch_sync",
    "_lifespan",
    "_pseudonymization_meta",
    "_schema_hint",
    "ai_spend",
    "app",
    "asynccontextmanager",
    "asyncio",
    "build_chat_messages",
    "build_domain_query",
    "build_resume",
    "canonicalization_instruction",
    "canonicalize_labels",
    "canonicalize_skill",
    "certified_clean_skill_labels",
    "coerce_turn",
    "configure_logging",
    "cost_tracker",
    "embed_skill_aliases",
    "embed_text",
    "extract_canonical_role_id",
    "extraction_system_prompt",
    "fallback_turn",
    "fallback_turn_json",
    "get_domain_store",
    "get_logger",
    "get_settings",
    "get_skill_store",
    "growth_cluster",
    "growth_cluster_endpoint",
    "has_first_person_claim",
    "health",
    "hmac",
    "job_posting_answers",
    "job_posting_chat_opening",
    "job_posting_chat_respond",
    "job_posting_engine",
    "json",
    "label_for_id",
    "logger",
    "match_job_domain",
    "normalize_role_id",
    "one_shot_opener_for",
    "persona_guard",
    "plan_retag",
    "profile_extract",
    "profile_extractor",
    "profiling_opening",
    "profiling_respond",
    "pseudonymize",
    "pseudonymize_endpoint",
    "rate_inr_per_1k",
    "resolve_taxonomy_ids",
    "resume_generate",
    "rfs",
    "router",
    "service_auth",
    "settings",
    "skills_canonicalize",
    "skills_retag_plan",
    "stt_adapter",
    "translate_adapter",
    "voice_transcribe",
]
