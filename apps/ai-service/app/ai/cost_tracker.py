"""Cost + token accounting for AI calls.

Records per-call metadata and computes an INR cost estimate plus simple
guardrail flags (cost_alert / above_target). Phase-1 persistence is a structured
log + returned metadata; the shape is designed to later map onto ai_jobs/events.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from ..config import Settings
from ..contracts import AICallMetadata
from ..logging_config import get_logger
from .model_config import provider_for_model, rate_inr_per_1k

logger = get_logger("ai.cost")


def estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars/token). Used for mock mode and as a
    fallback when the provider doesn't return usage."""
    if not text:
        return 0
    return max(1, len(text) // 4)


def estimate_cost_inr(model: str, input_tokens: int, output_tokens: int) -> float:
    in_rate, out_rate = rate_inr_per_1k(model)
    cost = (input_tokens / 1000.0) * in_rate + (output_tokens / 1000.0) * out_rate
    return round(cost, 4)


def build_call_metadata(
    *,
    task_type: str,
    model: str,
    real_call: bool,
    input_tokens: int,
    output_tokens: int,
    latency_ms: int,
    success: bool,
    settings: Settings,
    error_code: str | None = None,
) -> AICallMetadata:
    """Assemble + log the metadata for one AI call."""
    estimated = estimate_cost_inr(model, input_tokens, output_tokens)
    meta = AICallMetadata(
        ai_call_id=str(uuid.uuid4()),
        task_type=task_type,
        model_name=model,
        provider=provider_for_model(model),
        real_call=real_call,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        estimated_cost_inr=estimated,
        latency_ms=latency_ms,
        success=success,
        error_code=error_code,
        # Guardrails: flagged but NOT sent anywhere externally in Phase 1.
        cost_alert=estimated > settings.ai_cost_alert_profile_inr,
        above_target=estimated > settings.ai_target_profile_cost_inr,
        created_at=datetime.now(UTC).isoformat(),
    )
    # No PII here — only ids, model name, tokens, cost.
    logger.info("ai_call", extra={"extra": meta.model_dump()})
    return meta
