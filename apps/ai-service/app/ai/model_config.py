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


# Routing rules per the Phase-1 spec.
_ROUTES: dict[str, TaskRoute] = {
    # High-volume chat: cheap model, short + efficient. The persona MUST return
    # strict JSON ({"message", "ready_to_extract"}), so json_mode is ON — without
    # it the model writes a chatty prose preamble BEFORE the JSON and
    # intermittently exhausts the token budget (MAX_TOKENS -> empty/truncated
    # candidate -> the whole turn fails over to the fallback). json_mode forces a
    # pure JSON object (the reply lives INSIDE "message"). The mentor persona caps
    # a turn at a 2-word ack + one <=20-word question, so 48 output tokens is
    # ~80% cheaper per turn than the old 512 (COST-1); low temperature 0.3 keeps
    # the terse voice on-rails; one retry smooths a transient blip before the
    # router escalates to the next provider. NOTE: 48 is sized for the SHIPPED
    # mock path (no real call → cap unused). Before enabling real
    # profiling_chat_turn, validate the headroom against a live Gemini tokenizer:
    # the JSON envelope (~12-15 tok) + a worst-case 20-word Hinglish line (subword
    # splits ~2 tok/word) can approach the cap → MAX_TOKENS → graceful mock
    # fallback (never a leak). Raise the cap then if it bites.
    "profiling_chat_turn": TaskRoute(
        "profiling_chat_turn", "cheap", max_output_tokens=48, temperature=0.3,
        json_mode=True, max_retries=1,
    ),
    # Extraction: capable model, strict JSON, retries allowed.
    "profile_extraction": TaskRoute(
        "profile_extraction", "capable", max_output_tokens=1024, temperature=0.0,
        json_mode=True, max_retries=2,
    ),
    # Resume: cheap by default, can run in mock mode.
    "resume_generation": TaskRoute(
        "resume_generation", "cheap", max_output_tokens=512, temperature=0.4,
        json_mode=False, max_retries=1,
    ),
}


def get_route(task_type: str) -> TaskRoute:
    route = _ROUTES.get(task_type)
    if route is None:
        raise ValueError(f"Unknown AI task type: {task_type!r}")
    return route


def resolve_model(task_type: str, settings: Settings) -> str:
    """Resolve the concrete model id for a task from current settings."""
    route = get_route(task_type)
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
}


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
