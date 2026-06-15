"""Cost + token accounting for AI calls.

Records per-call metadata and computes an INR cost estimate plus simple
guardrail flags (cost_alert / above_target). Phase-1 persistence is a structured
log + returned metadata; the shape is designed to later map onto ai_jobs/events.
"""

from __future__ import annotations

import threading
import time
import uuid
from datetime import UTC, date, datetime

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


class SpendLedger:
    """Process-level rolling spend + retry-budget ledger (TD27).

    Tracks recorded INR spend for the current UTC day and for the process
    lifetime, plus a rolling window of retry timestamps. Used by the router to
    block real candidates before the network call (worst-case projected cost vs.
    daily/cumulative caps) and to bound retry multiplication against a failing
    provider. Holds ONLY PII-free numbers (INR, counts, the UTC date) — never
    message content, tokens-of-a-specific-user, or ids that identify a worker.

    Thread/async-safe via a ``threading.Lock`` so concurrent FastAPI requests do
    not corrupt the counters.

    SCOPE: single process only. With multiple Uvicorn workers each holds its own
    ledger, so caps are per-worker, not global. The follow-up is a shared store
    (e.g. Redis) keyed by UTC day so the cap is enforced across all workers.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._day: date = datetime.now(UTC).date()
        self._daily_spend_inr: float = 0.0
        self._total_spend_inr: float = 0.0
        self._retry_times: list[float] = []
        # Per-user rolling daily spend, keyed by the opaque worker_ref (PII-free).
        # Reset with the daily counter on UTC-day roll-over.
        self._user_daily_inr: dict[str, float] = {}

    def _roll_over_locked(self) -> None:
        """Reset the daily counters if the UTC date changed. Caller holds the lock.
        The cumulative (lifetime) total is never reset on roll-over."""
        today = datetime.now(UTC).date()
        if today != self._day:
            self._day = today
            self._daily_spend_inr = 0.0
            self._user_daily_inr = {}

    def would_exceed_spend(
        self, projected_inr: float, settings: Settings, *, user_ref: str | None = None
    ) -> str | None:
        """Whether recording ``projected_inr`` would breach a cap. Checked BEFORE
        a call using the worst-case projected cost. Returns the blocking reason or
        None if allowed. The PER-USER daily cap (the tightest, user-facing budget)
        is checked FIRST when a ``user_ref`` is supplied; then the process-level
        daily + cumulative caps (the backstop for any call without a user_ref)."""
        with self._lock:
            self._roll_over_locked()
            if user_ref is not None:
                user_spent = self._user_daily_inr.get(user_ref, 0.0)
                if user_spent + projected_inr > settings.ai_max_user_daily_cost_inr:
                    return "user_daily_cap_exceeded"
            if self._daily_spend_inr + projected_inr > settings.ai_max_daily_cost_inr:
                return "daily_cap_exceeded"
            if self._total_spend_inr + projected_inr > settings.ai_max_total_cost_inr:
                return "cumulative_cap_exceeded"
            return None

    def record_spend(self, inr: float, *, user_ref: str | None = None) -> None:
        """Add an ACTUAL estimated INR cost. Call AFTER a successful real call.
        Attributes the spend to ``user_ref``'s per-user daily budget when given."""
        with self._lock:
            self._roll_over_locked()
            self._daily_spend_inr += inr
            self._total_spend_inr += inr
            if user_ref is not None:
                self._user_daily_inr[user_ref] = self._user_daily_inr.get(user_ref, 0.0) + inr

    def try_consume_retry(self, settings: Settings) -> bool:
        """Consume one slot of the rolling retry budget. Prunes timestamps older
        than the window; returns False if the budget is exhausted (do NOT retry),
        else records 'now' and returns True."""
        with self._lock:
            now = time.monotonic()
            window = settings.ai_retry_budget_window_seconds
            self._retry_times = [t for t in self._retry_times if now - t < window]
            if len(self._retry_times) >= settings.ai_retry_budget_per_window:
                return False
            self._retry_times.append(now)
            return True

    def snapshot(self, settings: Settings, *, user_ref: str | None = None) -> dict:
        """PII-free usage-vs-cap snapshot (numbers / ids / dates only). When a
        ``user_ref`` is given, also reports THAT user's spend vs the per-user cap.
        Never dumps the full per-user map (only a count of tracked users)."""
        with self._lock:
            self._roll_over_locked()
            now = time.monotonic()
            window = settings.ai_retry_budget_window_seconds
            retry_count = len([t for t in self._retry_times if now - t < window])
            snap = {
                "daily_spend_inr": round(self._daily_spend_inr, 4),
                "daily_cap_inr": settings.ai_max_daily_cost_inr,
                "total_spend_inr": round(self._total_spend_inr, 4),
                "total_cap_inr": settings.ai_max_total_cost_inr,
                "user_daily_cap_inr": settings.ai_max_user_daily_cost_inr,
                "tracked_users": len(self._user_daily_inr),
                "retry_window_count": retry_count,
                "retry_budget_per_window": settings.ai_retry_budget_per_window,
                "kill_switch_engaged": settings.ai_real_calls_kill_switch,
                "window_seconds": window,
                "day": self._day.isoformat(),
            }
            if user_ref is not None:
                snap["user_ref"] = user_ref
                snap["user_daily_spend_inr"] = round(self._user_daily_inr.get(user_ref, 0.0), 4)
            return snap

    def reset(self) -> None:
        """Clear all state. For tests — the singleton must not leak across tests."""
        with self._lock:
            self._day = datetime.now(UTC).date()
            self._daily_spend_inr = 0.0
            self._total_spend_inr = 0.0
            self._retry_times = []
            self._user_daily_inr = {}


# Module-level singleton: one ledger per process (see SpendLedger docstring).
ledger = SpendLedger()


def get_ledger() -> SpendLedger:
    return ledger
