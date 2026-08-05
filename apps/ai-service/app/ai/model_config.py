"""Task → model routing configuration.

Routing is config-driven: each AI task maps to a model *tier* (cheap/capable),
token limits, and call behavior. Concrete model names come from ``Settings`` so
they can change via env without code changes.

The INR cost table is an ESTIMATE used only for guardrails/alerts (not billing).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..config import Settings

TaskType = Literal["profiling_chat_turn", "profile_extraction", "resume_generation"]
ModelTier = Literal["cheap", "capable"]


@dataclass(frozen=True)
class TaskRoute:
    task_type: str
    tier: ModelTier
    max_output_tokens: int
    temperature: float
    json_mode: bool
    max_retries: int


# Routing rules. The SHAPE of a route is code (which tasks exist, whether each
# needs strict JSON); the NUMBERS are config, because they are the levers that
# decide answer quality and per-turn cost and they should not need a deploy.
#
# json_mode is deliberately NOT configurable. It is a correctness requirement, not
# a tuning knob: the chat turn and the extraction both parse the response as a JSON
# object, and without json_mode the model writes a prose preamble BEFORE the JSON,
# intermittently exhausting the token budget (MAX_TOKENS -> truncated candidate ->
# the whole turn fails over). An operator who could switch it off would be able to
# break parsing from the environment.
#
# tier is configurable for the chat turn only, and it defaults to CAPABLE now. The
# cheap tier was right when the model merely REPHRASED a question the deterministic
# engine had already chosen; it now conducts the interview, tracks the Resume Field
# Set, and emits strict JSON in Hinglish.
_ROUTE_SHAPES: dict[str, tuple[ModelTier, bool]] = {
    # (default tier, json_mode)
    "profiling_chat_turn": ("capable", True),
    "profile_extraction": ("capable", True),
    "resume_generation": ("cheap", False),
    # The RAG job-domain pick. CHEAP on purpose, and it is not a cost compromise: the
    # retrieval has already narrowed thousands of occupations to ten labelled lines, so
    # the model's whole job is to choose one of ten — a task a cheap model does as well
    # as a capable one. `json_mode` because the answer is `{job_domain_id, confidence}`
    # and a prose answer would have to be regex-scraped for an id, which is precisely
    # how a hallucinated id gets past a parser.
    "domain_match": ("cheap", True),
}


def _chat_tier(settings: Settings) -> ModelTier:
    """Chat tier from config, falling back to the shape default on a bad value.

    Fails SOFT rather than raising: an unrecognised AI_CHAT_MODEL_TIER should not
    take the service down at request time, and "capable" is the safe direction to
    fall back in (a better model, not a worse one).
    """
    tier = settings.ai_chat_model_tier.strip().lower()
    return tier if tier in ("cheap", "capable") else _ROUTE_SHAPES["profiling_chat_turn"][0]  # type: ignore[return-value]


def get_route(task_type: str, settings: Settings | None = None) -> TaskRoute:
    """Resolve a task's route, reading the tunable numbers from settings.

    ``settings`` is optional so existing callers and tests that only need the
    static shape (``get_route("profile_extraction").json_mode``) keep working; when
    omitted the committed defaults are used.
    """
    shape = _ROUTE_SHAPES.get(task_type)
    if shape is None:
        raise ValueError(f"Unknown AI task type: {task_type!r}")

    if settings is None:
        from ..config import get_settings

        settings = get_settings()

    default_tier, json_mode = shape
    if task_type == "profiling_chat_turn":
        return TaskRoute(
            task_type,
            _chat_tier(settings),
            max_output_tokens=settings.ai_chat_max_output_tokens,
            temperature=settings.ai_chat_temperature,
            json_mode=json_mode,
            max_retries=settings.ai_chat_max_retries,
        )
    if task_type == "profile_extraction":
        return TaskRoute(
            task_type,
            default_tier,
            max_output_tokens=settings.ai_extraction_max_output_tokens,
            temperature=settings.ai_extraction_temperature,
            json_mode=json_mode,
            max_retries=settings.ai_extraction_max_retries,
        )
    if task_type == "domain_match":
        return TaskRoute(
            task_type,
            default_tier,
            # 64 tokens is the whole answer: `{"job_domain_id": "...", "confidence": 0.9}`.
            # Tight on purpose — this route has nothing to say beyond the choice, and a
            # budget that permits an explanation invites one.
            max_output_tokens=64,
            # TEMPERATURE ZERO. A classification against a fixed list must give the same
            # answer for the same worker every time; sampling here would mean a re-run
            # could re-file a worker into a different occupation with no input change.
            temperature=0.0,
            json_mode=json_mode,
            max_retries=settings.ai_extraction_max_retries,
        )
    return TaskRoute(
        task_type,
        default_tier,
        max_output_tokens=settings.ai_resume_max_output_tokens,
        temperature=settings.ai_resume_temperature,
        json_mode=json_mode,
        max_retries=settings.ai_resume_max_retries,
    )


def resolve_model(task_type: str, settings: Settings) -> str:
    """Resolve the concrete model id for a task from current settings."""
    route = get_route(task_type, settings)
    if route.tier == "capable":
        return settings.default_capable_model
    return settings.default_cheap_model


# (input_per_1k, output_per_1k) INR estimates. Unknown models fall back to a
# conservative default. These are deliberately centralized + overridable.
# Gemini 2.5 Flash list price (~$0.30 in / $2.50 out per 1M tokens) ~=
# Rs 0.025 in / Rs 0.21 out per 1k at ~Rs 83/USD. We use the bare model id; a
# legacy ``gemini/``-prefixed alias maps to the same rate (harmless entry).
_DEFAULT_RATE_INR: tuple[float, float] = (0.05, 0.15)
_GEMINI_25_FLASH_RATE_INR: tuple[float, float] = (0.025, 0.21)
_MODEL_RATES_INR: dict[str, tuple[float, float]] = {
    "gemini-flash-lite": (0.006, 0.024),
    "gemini-flash": (0.012, 0.048),
    "gemini-2.5-flash": _GEMINI_25_FLASH_RATE_INR,
    "gemini/gemini-2.5-flash": _GEMINI_25_FLASH_RATE_INR,
    # 2.5 Flash-Lite list price (~$0.10 in / $0.40 out per 1M) ~= Rs 0.008 in /
    # Rs 0.033 out per 1k at ~Rs 83/USD.
    "gemini-2.5-flash-lite": (0.008, 0.033),
    "claude-haiku-or-gemini-flash": (0.02, 0.08),
    "claude-haiku": (0.07, 0.35),
    # Claude Haiku 4.5 (fallback provider): $1/1M in, $5/1M out ~= Rs 0.083 in /
    # Rs 0.415 out per 1k at ~Rs 83/USD.
    "claude-haiku-4-5": (0.083, 0.415),
    # Gemini text-embedding-004 (ADR-0030 skill_embedding, TAX-3): embeddings bill input
    # only (~$0.15/1M ~= Rs 0.0125/1k at ~Rs 83/USD; output tokens do not exist). Without
    # this entry the batch estimate fell back to _DEFAULT_RATE_INR (~4x too high).
    "text-embedding-004": (0.0125, 0.0),
    # gemini-embedding-001 — the LIVE embedding model (text-embedding-004 retired; verified
    # 2026-07-14). Same $0.15/1M-input list price ~= Rs 0.0125/1k; embeddings have no output.
    "gemini-embedding-001": (0.0125, 0.0),
}


# --- Prompt-cache thresholds (COST-2) --------------------------------------
# Providers bill cached input at ~10% of the normal rate, but they ONLY cache a
# system block that clears a minimum size — a smaller block is silently ignored,
# so a cache directive on it is a pure no-op. Before adding a directive we check
# the STATIC block against these minimums and otherwise emit a skip diagnostic.
#
# Sources read 2026-07-14 (update HERE if a provider changes them — do not scatter
# the number):
#   - Anthropic prompt caching min = 4096 tokens for Claude Haiku 4.5 (our fallback
#     provider); 1024 for most models, 2048 for Haiku 3/3.5.
#     https://platform.claude.com/docs/en/build-with-claude/prompt-caching
#   - Gemini 2.5 Flash IMPLICIT caching (automatic, no request change — the ONLY
#     Gemini mechanism this file reasons about) applies from ~1024 tokens. Gemini
#     EXPLICIT cachedContent (a separate resource, DEFERRED) has a higher 2048-token
#     floor (2.5 Flash) / is the 2.5 Pro figure. We gate the Gemini diagnostic on the
#     IMPLICIT floor, since that is what actually caches today.
#     https://ai.google.dev/gemini-api/docs/caching
#
# NOTE (honest state): after AI-PERSONA-1 trimmed the persona, BADA_BHAI_SYSTEM_PROMPT
# is ~200 tokens — far below every minimum here — so caching is a no-op today and the
# guard takes the skip-diagnostic path. It arms automatically if the prompt ever grows.
ANTHROPIC_CACHE_MIN_TOKENS = 4096
# Gemini 2.5 Flash implicit-cache floor (what _gemini_cache_diagnostic checks).
GEMINI_CACHE_MIN_TOKENS = 1024
# Deferred: the explicit cachedContent lifecycle would gate on this higher floor.
GEMINI_EXPLICIT_CACHE_MIN_TOKENS = 2048


def should_cache_system(system_text: str, min_tokens: int) -> bool:
    """True iff the static system block is large enough to clear a provider's
    prompt-cache minimum (else a cache directive is a silent no-op).

    Uses the shared token ESTIMATE (~chars/4); a wrong guess only means we skip an
    ineffective cache, never a correctness or privacy issue. SG-1: only the STATIC
    persona/extraction prompt is ever passed here — never a worker message or name,
    so nothing PII-bearing is ever marked cacheable. Imported lazily to avoid a
    module cycle (cost_tracker imports this module)."""
    from .cost_tracker import estimate_tokens

    return estimate_tokens(system_text) >= min_tokens


def provider_for_model(model: str) -> str:
    """Coarse provider label used for BOTH cost/observability metadata AND the
    router's provider dispatch: "google" -> direct Gemini (``gemini_client``),
    "anthropic" -> Claude via the SDK (``anthropic_client``). Other labels have
    no live transport and are metadata-only."""
    m = model.lower()
    if "gemini" in m or "vertex" in m:
        return "google"
    if "claude" in m or "anthropic" in m:
        return "anthropic"
    if "gpt" in m or "openai" in m:
        return "openai"
    return "unknown"


def rate_inr_per_1k(model: str) -> tuple[float, float]:
    return _MODEL_RATES_INR.get(model, _DEFAULT_RATE_INR)
