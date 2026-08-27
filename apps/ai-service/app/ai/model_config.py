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
# THREE TIERS, AND THE THIRD EXISTS TO KEEP THE SECOND PINNED (#1237).
#
# `capable` used to be the top of the scale, so raising chat quality meant raising
# `default_capable_model` — which is ALSO what `profile_extraction` and `profile_parse`
# resolve through. That single knob is pinned to `gemini-2.5-flash` by an open GO/NO-GO item
# (docs/ai/real-llm-flip-go-no-go.md Finding 4: validation-model must equal flip-model) and by
# an executable guard (tests/test_extraction_model_pin.py). Moving it to improve the CHAT turn
# would have silently re-pointed two extraction paths at a model their funded 56-case
# re-validation never ran on, and the only task that is live today is the chat turn.
#
# `pro` decouples them: chat points here, extraction and parse stay on `capable`, and the pin
# holds. This is a tier ABOVE capable, not a rename of it.
ModelTier = Literal["cheap", "capable", "pro"]


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
# tier is configurable for the chat turn only, and it defaults to PRO now (#1237). It went
# cheap -> capable when the model stopped merely REPHRASING a question the deterministic engine
# had already chosen and began conducting the interview, tracking the Resume Field Set, and
# emitting strict JSON in Hinglish; it goes capable -> pro because that is the one task with
# real calls armed (`AI_REAL_CALL_TASKS` defaults to `profiling_chat_turn` alone) and therefore
# the only one where the model a worker actually meets is decided here.
_ROUTE_SHAPES: dict[str, tuple[ModelTier, bool]] = {
    # (default tier, json_mode)
    "profiling_chat_turn": ("pro", True),
    "profile_extraction": ("capable", True),
    # OIE Phase 7 — the ONE parse call. CAPABLE because the task is harder than it looks: it must
    # copy a span character-for-character out of Hinglish/Devanagari text while typing the value,
    # and a cheap model that paraphrases the quote fails the provenance gate on every field, which
    # reads as "the parse found nothing" rather than as a routing mistake. `json_mode` because the
    # response is parsed as a `ProfileParseOutput` — a prose preamble would exhaust the budget and
    # lose the whole overlay.
    "profile_parse": ("capable", True),
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

    Fails SOFT rather than raising: an unrecognised AI_CHAT_MODEL_TIER should not take the
    service down at request time.

    ``"pro"`` MUST BE IN THE ALLOWLIST, and forgetting it is the whole failure mode this
    function can have (#1237): an unlisted value is not an error, it silently becomes the shape
    default — so a `pro` tier the settings ask for but this tuple does not know would quietly
    keep serving the previous model with nothing anywhere saying so.

    THE FALLBACK TARGET IS THE SHAPE DEFAULT, WHICH IS NOW ALSO ``"pro"``, and that pairing is
    deliberate. The two must agree: if the shape default stayed ``"capable"`` while the settings
    default said ``"pro"``, a single typo in AI_CHAT_MODEL_TIER would silently DOWNGRADE the one
    worker-facing task in production — invisible, because a working answer from a cheaper model
    looks exactly like a working answer. Falling back to the more expensive tier is bounded by
    ``ai_max_daily_cost_inr`` (a visible, global ceiling); falling back to a cheaper one is
    bounded by nothing and reads as success.
    """
    tier = settings.ai_chat_model_tier.strip().lower()
    if tier in ("cheap", "capable", "pro"):
        return tier  # type: ignore[return-value]
    return _ROUTE_SHAPES["profiling_chat_turn"][0]


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
    if task_type == "profile_parse":
        return TaskRoute(
            task_type,
            default_tier,
            # The parse returns one object per requested field, each carrying a quoted span, so its
            # output scales with the Resume Field Set rather than being a fixed-size answer. It
            # shares the extraction budget deliberately: both read one finished interview and emit
            # one structured profile object, and giving them separate knobs would mean tuning the
            # same thing in two places.
            max_output_tokens=settings.ai_extraction_max_output_tokens,
            # TEMPERATURE ZERO, and NOT from settings. Typing a recorded answer has exactly one
            # right result; sampling would let a re-parse of an unchanged interview return a
            # different salary. This is also why the route needs its own branch at all — without
            # one it fell through to the resume defaults below and would have run a citation task
            # at temperature 0.4.
            temperature=0.0,
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
    """Resolve the concrete model id for a task from current settings.

    EXHAUSTIVE OVER ``ModelTier`` ON PURPOSE — `pro` is matched explicitly rather than being
    folded into the capable branch, so that adding a fourth tier without a branch here falls to
    the CHEAP default and is caught by the tier round-trip test, instead of quietly resolving to
    whatever the last branch happened to return.
    """
    route = get_route(task_type, settings)
    if route.tier == "pro":
        return settings.default_pro_model
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
    # Gemini 2.5 Pro (#1237). List price read 2026-08-26 from
    # https://ai.google.dev/gemini-api/docs/pricing: $1.25 in / $10.00 out per 1M for
    # prompts <= 200k tokens ~= Rs 0.104 in / Rs 0.83 out per 1k at ~Rs 83/USD — the same
    # conversion every other row here uses (each one reconciles to the live page exactly).
    #
    # THE <=200k TIER IS THE RIGHT ONE TO ENCODE, not a simplification. Pro bills $2.50/$15.00
    # above 200k, but no routed task can reach that: the chat turn carries a ~200-token system
    # prompt plus one interview, and `ai_chat_max_output_tokens` caps the reply at 512. A route
    # that could exceed 200k would need its own entry, and none exists.
    #
    # ⚠ THIS ROW IS NOT COSMETIC — an unpriced model is WORSE than a wrong one here. Without it
    # the estimator falls to `_DEFAULT_RATE_INR` (0.05, 0.15), which UNDER-reads Pro by ~2x on
    # input and ~5.5x on output. The guardrails are computed from the estimate, so the failure is
    # silent OVERSPEND — the caps never trip — and not the fall-to-mock that an over-estimate
    # would cause. Any future model id added to a tier default needs a row here in the same
    # change, or the ceilings below stop meaning anything.
    "gemini-2.5-pro": (0.104, 0.83),
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
    no live transport HERE and are metadata-only — including "sarvam", whose
    calls are real but are made by their own adapters (``stt.py``, ``tts.py``,
    ``translate.py``) and never enter the LLM router's candidate list.

    ORDER IS LOAD-BEARING, and the two transport-bearing labels come first on
    purpose: ``providers.complete`` dispatches on this return value, so a branch
    that could ever divert a routed model away from "google"/"anthropic" would
    turn a working call into "no live transport". Metadata-only labels are
    matched after them, and ``"unknown"`` stays the honest fallback for a model
    id no rule recognises."""
    m = model.lower()
    if "gemini" in m or "vertex" in m:
        return "google"
    if "claude" in m or "anthropic" in m:
        return "anthropic"
    if "gpt" in m or "openai" in m:
        return "openai"
    # Sarvam (the Indic STT/TTS/translate surfaces). Matched on the MODEL FAMILY,
    # which is the stable half of the id — "saarika:v2.5" becomes "saarika:v3"
    # without becoming a different provider: saarika (ASR) and saaras (the ASR
    # swap config.py already names), bulbul (TTS), mayura (translate), plus a bare
    # "sarvam" for the text models (``sarvam-m``) and any vendor-prefixed alias.
    #
    # WITHOUT THIS BRANCH EVERY RUPEE OF SARVAM SPEND ACCRUED AS "unknown". That is
    # not merely an unhelpful label: `platform_ai_cost_totals` is keyed on
    # (provider, task_type), so Sarvam's spend was pooled with the spend of models
    # that genuinely have no rule — the one bucket a reader cannot attribute.
    # The correction is NOT retroactive: rows already accrued under "unknown" stay
    # there, and only calls made after this ships land under "sarvam".
    if "saarika" in m or "saaras" in m or "bulbul" in m or "mayura" in m or "sarvam" in m:
        return "sarvam"
    return "unknown"


def rate_inr_per_1k(model: str) -> tuple[float, float]:
    return _MODEL_RATES_INR.get(model, _DEFAULT_RATE_INR)
