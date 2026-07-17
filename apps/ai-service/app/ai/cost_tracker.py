"""Cost + token accounting for AI calls.

Records per-call metadata and computes an INR cost estimate plus simple
guardrail flags (cost_alert / above_target). Phase-1 persistence is a structured
log + returned metadata; the shape is designed to later map onto ai_jobs/events.

The spend ledger (TD27) is a name-stable ``SpendLedger`` facade over a pluggable
``SpendStore`` backend:

- ``InProcessSpendBackend`` — ``threading.Lock`` counters; the default when
  ``AI_SPEND_REDIS_URL`` is unset (local dev + CI run with NO Redis). Caps are
  per-process.
- ``RedisSpendBackend`` — ``redis.asyncio`` + Lua; caps enforce GLOBALLY across
  Uvicorn workers. Fails CLOSED (an unverifiable cap never permits a real spend).

Keys AND values are PII-free everywhere: INR amounts, counts, the UTC date, and
the OPAQUE ``worker_ref`` only — never message content, tokens-of-a-specific-user,
or any worker-identifying id.
"""

from __future__ import annotations

import threading
import time
import uuid
from abc import ABC, abstractmethod
from datetime import UTC, date, datetime, timedelta

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
    attempt_count: int = 0,
    candidates_tried: list[str] | None = None,
    failure_reason: str | None = None,
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
        # Diagnostics: reconcile per-attempt vs per-call counts + the specific
        # transport failure. All PII-free (int / model ids / closed-set reason).
        attempt_count=attempt_count,
        candidates_tried=candidates_tried or [],
        failure_reason=failure_reason,
        # Guardrails: flagged but NOT sent anywhere externally in Phase 1.
        cost_alert=estimated > settings.ai_cost_alert_profile_inr,
        above_target=estimated > settings.ai_target_profile_cost_inr,
        created_at=datetime.now(UTC).isoformat(),
    )
    # No PII here — only ids, model name, tokens, cost, closed-set reason codes.
    logger.info("ai_call", extra={"extra": meta.model_dump()})
    return meta


def _utc_date_str() -> str:
    """UTC calendar date as ``YYYY-MM-DD``. Used in Redis key names so UTC-day
    rollover is structural (a new day => a new key)."""
    return datetime.now(UTC).date().isoformat()


def _seconds_to_next_utc_midnight() -> int:
    """Seconds until the next UTC midnight, + a 1h buffer. Used as the TTL for the
    daily / per-user keys so they expire shortly after the day they belong to."""
    now = datetime.now(UTC)
    tomorrow = (now + timedelta(days=1)).date()
    midnight = datetime(tomorrow.year, tomorrow.month, tomorrow.day, tzinfo=UTC)
    return int((midnight - now).total_seconds()) + 3600


# --- pluggable backend protocol ---------------------------------------------


class SpendStore(ABC):
    """Backend contract for the spend ledger. All store-touching methods are
    coroutines (router.run is async; a sync Redis client would block the loop).
    The per-process retry budget is NOT part of this contract — it stays on the
    facade (a per-worker circuit-breaker, ratified)."""

    @abstractmethod
    async def reserve(
        self, projected_inr: float, settings: Settings, *, user_ref: str | None
    ) -> str | None:
        """Atomic check-AND-reserve. Returns a block reason (and reserves NOTHING)
        or None (and has reserved ``projected_inr`` on every counter)."""

    @abstractmethod
    async def refund(
        self, reserved_inr: float, actual_inr: float, *, user_ref: str | None
    ) -> None:
        """Reconcile: refund ``reserved_inr - actual_inr`` on every counter,
        floored at 0. ``actual_inr=0.0`` => full refund (failure/abort path)."""

    @abstractmethod
    async def snapshot(self, settings: Settings, *, user_ref: str | None) -> dict:
        """PII-free counters-vs-caps snapshot (numbers / ids / dates only)."""

    @abstractmethod
    async def reset(self) -> None:
        """Clear all spend state. For tests."""


class InProcessSpendBackend(SpendStore):
    """Today's logic: daily / total / per-user dicts under a ``threading.Lock``.
    The default when ``AI_SPEND_REDIS_URL`` is unset (single-process caps; CI
    Redis-free).

    reserve = check-all-then-increment-all (atomic within the process);
    refund   = decrement, floored at 0. Net effect: success leaves +actual; a
    blocked call leaves nothing; a failed call leaves +reserved then -reserved = 0.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._day: date = datetime.now(UTC).date()
        self._daily_spend_inr: float = 0.0
        self._total_spend_inr: float = 0.0
        # Per-user rolling daily spend, keyed by the opaque worker_ref (PII-free).
        self._user_daily_inr: dict[str, float] = {}

    def _roll_over_locked(self) -> None:
        """Reset the daily counters if the UTC date changed. Caller holds the lock.
        The cumulative (lifetime) total is never reset on roll-over."""
        today = datetime.now(UTC).date()
        if today != self._day:
            self._day = today
            self._daily_spend_inr = 0.0
            self._user_daily_inr = {}

    async def reserve(
        self, projected_inr: float, settings: Settings, *, user_ref: str | None
    ) -> str | None:
        with self._lock:
            self._roll_over_locked()
            # Check order: per-user (tightest) -> daily -> cumulative.
            if user_ref is not None:
                user_spent = self._user_daily_inr.get(user_ref, 0.0)
                if user_spent + projected_inr > settings.ai_max_user_daily_cost_inr:
                    return "user_daily_cap_exceeded"
            if self._daily_spend_inr + projected_inr > settings.ai_max_daily_cost_inr:
                return "daily_cap_exceeded"
            if self._total_spend_inr + projected_inr > settings.ai_max_total_cost_inr:
                return "cumulative_cap_exceeded"
            # All checks passed -> RESERVE on every counter.
            self._daily_spend_inr += projected_inr
            self._total_spend_inr += projected_inr
            if user_ref is not None:
                self._user_daily_inr[user_ref] = (
                    self._user_daily_inr.get(user_ref, 0.0) + projected_inr
                )
            return None

    async def refund(
        self, reserved_inr: float, actual_inr: float, *, user_ref: str | None
    ) -> None:
        delta = reserved_inr - actual_inr
        if delta == 0.0:
            return
        with self._lock:
            self._roll_over_locked()
            self._daily_spend_inr = max(0.0, self._daily_spend_inr - delta)
            self._total_spend_inr = max(0.0, self._total_spend_inr - delta)
            if user_ref is not None and user_ref in self._user_daily_inr:
                self._user_daily_inr[user_ref] = max(
                    0.0, self._user_daily_inr[user_ref] - delta
                )

    async def snapshot(self, settings: Settings, *, user_ref: str | None) -> dict:
        with self._lock:
            self._roll_over_locked()
            snap = {
                "daily_spend_inr": round(self._daily_spend_inr, 4),
                "daily_cap_inr": settings.ai_max_daily_cost_inr,
                "total_spend_inr": round(self._total_spend_inr, 4),
                "total_cap_inr": settings.ai_max_total_cost_inr,
                "user_daily_cap_inr": settings.ai_max_user_daily_cost_inr,
                "tracked_users": len(self._user_daily_inr),
                "day": self._day.isoformat(),
            }
            if user_ref is not None:
                snap["user_ref"] = user_ref
                snap["user_daily_spend_inr"] = round(
                    self._user_daily_inr.get(user_ref, 0.0), 4
                )
            return snap

    async def reset(self) -> None:
        with self._lock:
            self._day = datetime.now(UTC).date()
            self._daily_spend_inr = 0.0
            self._total_spend_inr = 0.0
            self._user_daily_inr = {}


# --- Lua scripts (atomic in Redis: single-threaded => the whole script runs) -

# RESERVE: check per-user -> daily -> cumulative, then INCRBYFLOAT all + SADD the
# user to the per-day set, only if all checks pass. Returns a block-reason string
# or "OK". TTLs are set on the daily/user keys + user set only when they have none
# (TTL == -1), so a reservation never resets a live day's expiry.
#   KEYS[1] = daily key      KEYS[2] = total key
#   KEYS[3] = user key       KEYS[4] = users-set key
#   ARGV[1] = projected_inr  ARGV[2] = user_cap   ARGV[3] = daily_cap
#   ARGV[4] = total_cap      ARGV[5] = ttl_seconds
#   ARGV[6] = has_user ("1"/"0")   ARGV[7] = user_ref (opaque; "" when absent)
_RESERVE_LUA = """
local projected = tonumber(ARGV[1])
local has_user = ARGV[6] == "1"

if has_user then
  local user_cap = tonumber(ARGV[2])
  local user_spent = tonumber(redis.call("GET", KEYS[3]) or "0")
  if user_spent + projected > user_cap then
    return "user_daily_cap_exceeded"
  end
end

local daily_cap = tonumber(ARGV[3])
local daily_spent = tonumber(redis.call("GET", KEYS[1]) or "0")
if daily_spent + projected > daily_cap then
  return "daily_cap_exceeded"
end

local total_cap = tonumber(ARGV[4])
local total_spent = tonumber(redis.call("GET", KEYS[2]) or "0")
if total_spent + projected > total_cap then
  return "cumulative_cap_exceeded"
end

redis.call("INCRBYFLOAT", KEYS[1], projected)
redis.call("INCRBYFLOAT", KEYS[2], projected)
if redis.call("TTL", KEYS[1]) == -1 then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[5]))
end

if has_user then
  redis.call("INCRBYFLOAT", KEYS[3], projected)
  if redis.call("TTL", KEYS[3]) == -1 then
    redis.call("EXPIRE", KEYS[3], tonumber(ARGV[5]))
  end
  redis.call("SADD", KEYS[4], ARGV[7])
  if redis.call("TTL", KEYS[4]) == -1 then
    redis.call("EXPIRE", KEYS[4], tonumber(ARGV[5]))
  end
end

return "OK"
"""

# REFUND/RECONCILE: subtract delta = reserved - actual from each counter, clamped
# at 0 (guards float drift / double-refund). Decrements are commutative; no
# re-check needed. The total key has no TTL; daily/user keys keep theirs.
#   KEYS[1] = daily key   KEYS[2] = total key   KEYS[3] = user key
#   ARGV[1] = delta       ARGV[2] = has_user ("1"/"0")
_REFUND_LUA = """
local delta = tonumber(ARGV[1])
local has_user = ARGV[2] == "1"

local function refund(key)
  local cur = tonumber(redis.call("GET", key) or "0")
  local new = cur - delta
  if new < 0 then new = 0 end
  redis.call("SET", key, tostring(new))
end

refund(KEYS[1])
refund(KEYS[2])
if has_user then
  refund(KEYS[3])
end
return "OK"
"""


# AI-ENV-1 / 1d: connect + socket timeout (seconds) for the spend-ledger Redis.
# WHY 2.0: the ledger Redis is same-network infrastructure (docker network / VPC) —
# a healthy reserve is a single round-trip answering in low single-digit ms, so 2s is
# ~100x the expected p99 and cannot trip on a merely loaded box. Without an explicit
# timeout the client inherits the OS TCP connect behaviour: a MEASURED 21.0s stall
# per reserve against a routable-but-silent host (Windows dev box) — and reserve runs
# once PER CANDIDATE MODEL, so a 2-candidate chain stalled ~42s before falling back to
# mock. That is a config error wearing a latency costume. 2s bounds it while staying
# far above any legitimate same-network variance.
#
# This changes the LATENCY and the MESSAGE of a misconfiguration — NEVER the VERDICT.
# A timeout raises inside reserve()'s except -> "spend_store_unavailable" -> the router
# blocks the real call -> mock fallback. Fail-closed is preserved exactly: an
# unverifiable cap still never permits an unaccounted real spend.
_REDIS_TIMEOUT_SECONDS = 2.0


class RedisSpendBackend(SpendStore):
    """``redis.asyncio`` + Lua backend — caps enforce GLOBALLY across Uvicorn
    workers. FAILS CLOSED: any Redis error on reserve returns the block reason
    ``spend_store_unavailable`` (an unverifiable cap never permits a real spend).
    refund/snapshot never raise (the router must never crash on a ledger error).

    Connect/socket timeouts are bounded (``_REDIS_TIMEOUT_SECONDS``) so an
    unreachable host fails FAST and closed instead of stalling every real call.

    Key layout (PII-free):
      aispend:daily:{UTC_DATE}            INR, TTL to next UTC midnight + 1h
      aispend:total                       INR, NO TTL
      aispend:user:{UTC_DATE}:{worker_ref}  INR, TTL like daily
      aispend:users:{UTC_DATE}            SET of opaque worker_refs, TTL like daily
    """

    _PREFIX = "aispend"

    def __init__(self, redis_url: str) -> None:
        # Lazy import so a missing redis lib never breaks mock-only boot.
        import redis.asyncio as aioredis

        self._redis_url = redis_url
        # decode_responses=True so GET/SCARD return str/int, not bytes.
        # socket_connect_timeout bounds the TCP handshake (the 21s-stall case);
        # socket_timeout bounds a connection that opens then goes silent (a
        # half-open/blackholed peer), which the connect timeout alone would miss.
        self._client = aioredis.from_url(
            redis_url,
            decode_responses=True,
            socket_connect_timeout=_REDIS_TIMEOUT_SECONDS,
            socket_timeout=_REDIS_TIMEOUT_SECONDS,
        )

    def _daily_key(self, day: str) -> str:
        return f"{self._PREFIX}:daily:{day}"

    def _total_key(self) -> str:
        return f"{self._PREFIX}:total"

    def _user_key(self, day: str, user_ref: str) -> str:
        return f"{self._PREFIX}:user:{day}:{user_ref}"

    def _users_set_key(self, day: str) -> str:
        return f"{self._PREFIX}:users:{day}"

    async def reserve(
        self, projected_inr: float, settings: Settings, *, user_ref: str | None
    ) -> str | None:
        day = _utc_date_str()
        has_user = user_ref is not None
        keys = [
            self._daily_key(day),
            self._total_key(),
            self._user_key(day, user_ref) if has_user else f"{self._PREFIX}:user:_none",
            self._users_set_key(day),
        ]
        args = [
            projected_inr,
            settings.ai_max_user_daily_cost_inr,
            settings.ai_max_daily_cost_inr,
            settings.ai_max_total_cost_inr,
            _seconds_to_next_utc_midnight(),
            "1" if has_user else "0",
            user_ref if has_user else "",
        ]
        try:
            result = await self._client.eval(_RESERVE_LUA, len(keys), *keys, *args)
        except Exception as exc:
            # Fail CLOSED: an unverifiable cap NEVER permits a real spend.
            # PII-free log (reason + amount only); the router blocks -> mock.
            # NAMES the variable so a config error is diagnosable — never its VALUE,
            # which may carry credentials (redis://user:pass@host). §2.
            logger.warning(
                "spend ledger Redis unreachable; blocking real call (fail-closed). "
                "Check AI_SPEND_REDIS_URL",
                extra={"extra": {
                    "reason": "spend_store_unavailable",
                    "config_var": "AI_SPEND_REDIS_URL",
                    "timeout_seconds": _REDIS_TIMEOUT_SECONDS,
                    "projected_inr": projected_inr,
                    "error_type": type(exc).__name__,
                }},
            )
            return "spend_store_unavailable"
        if result == "OK":
            return None
        # A block reason string from the Lua script.
        return result if isinstance(result, str) else "spend_store_unavailable"

    async def refund(
        self, reserved_inr: float, actual_inr: float, *, user_ref: str | None
    ) -> None:
        delta = reserved_inr - actual_inr
        if delta == 0.0:
            return
        day = _utc_date_str()
        has_user = user_ref is not None
        keys = [
            self._daily_key(day),
            self._total_key(),
            self._user_key(day, user_ref) if has_user else f"{self._PREFIX}:user:_none",
        ]
        try:
            await self._client.eval(
                _REFUND_LUA, len(keys), *keys, delta, "1" if has_user else "0"
            )
        except Exception as exc:
            # CANNOT safely refund -> leave the worst-case RESERVED (stricter).
            # Never raise: the router must never crash on a ledger error.
            logger.warning(
                "spend store unavailable on refund; leaving reservation in place",
                extra={"extra": {
                    "reason": "spend_store_unavailable",
                    "reserved_inr": reserved_inr,
                    "actual_inr": actual_inr,
                    "error_type": type(exc).__name__,
                }},
            )

    async def snapshot(self, settings: Settings, *, user_ref: str | None) -> dict:
        day = _utc_date_str()
        snap = {
            "daily_spend_inr": None,
            "daily_cap_inr": settings.ai_max_daily_cost_inr,
            "total_spend_inr": None,
            "total_cap_inr": settings.ai_max_total_cost_inr,
            "user_daily_cap_inr": settings.ai_max_user_daily_cost_inr,
            "tracked_users": None,
            "day": day,
        }
        try:
            daily = await self._client.get(self._daily_key(day))
            total = await self._client.get(self._total_key())
            tracked = await self._client.scard(self._users_set_key(day))
            snap["daily_spend_inr"] = round(float(daily or 0.0), 4)
            snap["total_spend_inr"] = round(float(total or 0.0), 4)
            snap["tracked_users"] = int(tracked or 0)
            if user_ref is not None:
                user_spent = await self._client.get(self._user_key(day, user_ref))
                snap["user_ref"] = user_ref
                snap["user_daily_spend_inr"] = round(float(user_spent or 0.0), 4)
        except Exception as exc:
            # Degraded PII-free snapshot (sentinels for the values we can't read).
            logger.warning(
                "spend store unavailable on snapshot; returning degraded view",
                extra={"extra": {
                    "reason": "spend_store_unavailable",
                    "error_type": type(exc).__name__,
                }},
            )
            if user_ref is not None:
                snap["user_ref"] = user_ref
                snap["user_daily_spend_inr"] = None
        return snap

    async def reset(self) -> None:
        """Delete all aispend:* keys. For tests against the Redis backend."""
        try:
            keys = [k async for k in self._client.scan_iter(f"{self._PREFIX}:*")]
            if keys:
                await self._client.delete(*keys)
        except Exception as exc:
            logger.warning(
                "spend store unavailable on reset",
                extra={"extra": {
                    "reason": "spend_store_unavailable",
                    "error_type": type(exc).__name__,
                }},
            )


class SpendLedger:
    """Process-level rolling spend + retry-budget ledger (TD27).

    Name-stable facade over a pluggable ``SpendStore`` backend, selected by
    ``settings.ai_spend_redis_url``: unset => ``InProcessSpendBackend`` (single-process
    caps; the dev/test/CI default); set => ``RedisSpendBackend`` (caps enforce
    GLOBALLY across Uvicorn workers, fails closed if Redis is unreachable).

    The selection is LOGGED ONCE here, at construction (AI-ENV-1 / 1c): "unset" and
    "misconfigured" used to look identical from outside the process, so a per-process
    cap silently standing in for a global one was invisible. The log names the
    variable, never its value (§2).

    Holds ONLY PII-free numbers (INR, counts, the UTC date) and the OPAQUE
    ``worker_ref`` — never message content, tokens-of-a-specific-user, or any id
    that identifies a worker.

    The spend caps are atomic reserve -> reconcile -> refund:
    ``would_exceed_spend`` RESERVES the worst-case cost; the router later
    ``record_spend(reserved, actual)`` to refund the difference (full refund when
    ``actual=0.0`` on the failure/abort path) so no path leaks a reservation.

    The retry budget is per-process (a per-worker circuit-breaker, ratified) and
    stays on the facade — it does NOT move to Redis.
    """

    def __init__(self, settings: Settings) -> None:
        self._lock = threading.Lock()
        self._retry_times: list[float] = []
        if settings.ai_spend_redis_url:
            self._store: SpendStore = RedisSpendBackend(settings.ai_spend_redis_url)
        else:
            self._store = InProcessSpendBackend()
        self._log_backend_selection()

    def _log_backend_selection(self) -> None:
        """Emit the selected-backend line ONCE, at construction (never per call).
        Reuses ``backend_name`` — the same value /health reports — so the log and the
        health hook can never disagree. Names AI_SPEND_REDIS_URL; NEVER prints its
        value (it may carry credentials). §2."""
        if self.backend_name == "redis":
            message = "spend ledger: RedisSpendBackend (global caps)"
        else:
            message = (
                "spend ledger: InProcessSpendBackend (per-process caps — "
                "set AI_SPEND_REDIS_URL for global)"
            )
        logger.info(
            message,
            extra={"extra": {
                "spend_store": self.backend_name,
                "config_var": "AI_SPEND_REDIS_URL",
            }},
        )

    @property
    def backend_name(self) -> str:
        """Which backend is active ("redis" or "in_process") — for the health
        hook. PII-free; does not touch the store (no network)."""
        return "redis" if isinstance(self._store, RedisSpendBackend) else "in_process"

    async def would_exceed_spend(
        self, projected_inr: float, settings: Settings, *, user_ref: str | None = None
    ) -> str | None:
        """Atomic check-AND-reserve of ``projected_inr`` (the worst-case projected
        cost), checked BEFORE a real call. Returns the blocking reason (and
        reserves nothing) or None (and has reserved on every counter). The PER-USER
        daily cap is checked FIRST when a ``user_ref`` is supplied; then the
        process-level daily + cumulative caps (the backstop for a call without a
        user_ref). With Redis unreachable returns ``spend_store_unavailable``
        (fail closed)."""
        return await self._store.reserve(projected_inr, settings, user_ref=user_ref)

    async def record_spend(
        self, reserved_inr: float, actual_inr: float, *, user_ref: str | None = None
    ) -> None:
        """Reconcile a reservation: refund ``reserved_inr - actual_inr`` on every
        counter (floored at 0). Call AFTER a real attempt resolves:
        - success => ``record_spend(reserved, actual)`` leaves +actual recorded.
        - failure/abort => ``record_spend(reserved, 0.0)`` fully refunds the
          reservation so the mock-fallback path leaks nothing.
        Attributes to ``user_ref``'s per-user daily budget when given. Never
        raises (the router must never crash on a ledger error)."""
        await self._store.refund(reserved_inr, actual_inr, user_ref=user_ref)

    def try_consume_retry(self, settings: Settings) -> bool:
        """Consume one slot of the rolling retry budget. Prunes timestamps older
        than the window; returns False if the budget is exhausted (do NOT retry),
        else records 'now' and returns True. SYNC + per-process by design — a
        per-worker circuit-breaker, not a money guardrail (ratified)."""
        with self._lock:
            now = time.monotonic()
            window = settings.ai_retry_budget_window_seconds
            self._retry_times = [t for t in self._retry_times if now - t < window]
            if len(self._retry_times) >= settings.ai_retry_budget_per_window:
                return False
            self._retry_times.append(now)
            return True

    async def snapshot(self, settings: Settings, *, user_ref: str | None = None) -> dict:
        """PII-free usage-vs-cap snapshot (numbers / ids / dates only). Merges the
        per-process retry-budget view onto the backend's spend view. When a
        ``user_ref`` is given, also reports THAT user's spend vs the per-user cap.
        Never dumps the full per-user map (only a count of tracked users)."""
        snap = await self._store.snapshot(settings, user_ref=user_ref)
        with self._lock:
            now = time.monotonic()
            window = settings.ai_retry_budget_window_seconds
            retry_count = len([t for t in self._retry_times if now - t < window])
        snap["retry_window_count"] = retry_count
        snap["retry_budget_per_window"] = settings.ai_retry_budget_per_window
        snap["kill_switch_engaged"] = settings.ai_real_calls_kill_switch
        snap["window_seconds"] = window
        return snap

    async def reset(self) -> None:
        """Clear all state (spend backend + retry budget). For tests — the
        singleton must not leak across tests."""
        await self._store.reset()
        with self._lock:
            self._retry_times = []


# Module-level singleton, built LAZILY from get_settings() so import stays cheap
# and no Redis client is constructed at import time (mock-only boot never needs
# redis installed when AI_SPEND_REDIS_URL is unset).
_ledger: SpendLedger | None = None


def get_ledger() -> SpendLedger:
    """Return the process singleton (built once from get_settings())."""
    global _ledger
    if _ledger is None:
        from ..config import get_settings

        _ledger = SpendLedger(get_settings())
    return _ledger
