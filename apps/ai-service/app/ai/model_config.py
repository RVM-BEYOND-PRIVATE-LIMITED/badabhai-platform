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
    # High-volume chat: cheap model, short + warm.
    "profiling_chat_turn": TaskRoute(
        "profiling_chat_turn", "cheap", max_output_tokens=256, temperature=0.6,
        json_mode=False, max_retries=0,
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
_DEFAULT_RATE_INR: tuple[float, float] = (0.05, 0.15)
_MODEL_RATES_INR: dict[str, tuple[float, float]] = {
    "gemini-flash-lite": (0.006, 0.024),
    "gemini-flash": (0.012, 0.048),
    "claude-haiku-or-gemini-flash": (0.02, 0.08),
    "claude-haiku": (0.07, 0.35),
}


def provider_for_model(model: str) -> str:
    m = model.lower()
    if "gemini" in m or "vertex" in m:
        return "google"
    if "claude" in m or "anthropic" in m:
        return "anthropic"
    if "gpt" in m or "openai" in m:
        return "openai"
    return "litellm"


def rate_inr_per_1k(model: str) -> tuple[float, float]:
    return _MODEL_RATES_INR.get(model, _DEFAULT_RATE_INR)
