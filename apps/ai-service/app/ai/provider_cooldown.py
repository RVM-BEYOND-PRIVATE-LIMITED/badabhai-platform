"""Per-provider rate-limit cooldown — the guard that was missing when a 429 arrived.

WHAT IT FIXES. Nothing in this service ever recorded "the provider just told us to
stop". Every layer bounded its OWN retries — the Gemini client's in-call 429 loop, the
router's attempt loop, the TD27 rolling retry budget — and every one of them reset the
moment a new request arrived. So a rate limit that lasted a minute was met by every
request in that minute walking the full chain again, each contributing more rejected
calls to the same exhausted window. The bucket cannot refill while we keep drinking
from it.

A cooldown is the piece of state that outlives the request: the FIRST 429 marks the
provider, and every request for the next ``ai_provider_cooldown_seconds`` skips it
without touching the network and falls straight through to the next candidate.

FAILS OPEN, and this is the one place in this module's neighbourhood that does.
``cost_tracker``'s spend ledger fails CLOSED because an unverifiable cap must never
permit an unaccounted spend — being wrong there costs money. Here, being wrong costs a
call that was going to be made anyway: if the store is unreachable we cannot know
whether a provider is cooling, and answering "it is" would let one Redis blip disable
every AI call in the platform. A missed cooldown degrades to exactly the behaviour that
existed before this module. A false cooldown is an outage.

BACKEND SELECTION MIRRORS THE LEDGER, deliberately, and rides the SAME variable
(``AI_SPEND_REDIS_URL``) rather than minting a second one: it is the same store, the
same principal and the same lifecycle, and AI-ENV-1 is on record about what a
second, subtly-different Redis variable costs. Unset => in-process (dev/test/CI run
Redis-free, and a per-process cooldown is still strictly better than none); set =>
Redis, so the cooldown is shared by every Uvicorn worker — which matters, because the
rate limit itself is shared by every Uvicorn worker.

PII-FREE BY CONSTRUCTION. The only key component is a provider name from the closed set
in ``model_config`` — never a worker ref, never a model's input.
"""

from __future__ import annotations

import threading
import time

from ..config import Settings
from ..logging_config import get_logger

logger = get_logger("ai.cooldown")

# Connect + socket timeout for the cooldown store. Matches the spend ledger's
# `_REDIS_TIMEOUT_SECONDS` and for the same measured reason: without an explicit bound
# the client inherits OS TCP behaviour, which stalled ~21s per call against a
# routable-but-silent host. This check sits in front of EVERY candidate on EVERY real
# call, so it must be the cheapest thing in the chain or it is not worth having.
_REDIS_TIMEOUT_SECONDS = 2.0

_PREFIX = "aicooldown"


def _key(provider: str) -> str:
    return f"{_PREFIX}:{provider}"


class _InProcessCooldown:
    """Per-process cooldown. The dev/test/CI default, and the fallback when
    ``AI_SPEND_REDIS_URL`` is unset.

    Honest about its limit: with N Uvicorn workers a provider can still be probed up to
    N times per cooldown window instead of once. That is a large improvement on the
    unbounded case and a real gap against Redis, which is why the selection is logged."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # provider -> monotonic deadline. `time.monotonic` and not wall time: a clock
        # step (NTP, a suspended container) must not resurrect or extend a cooldown.
        self._until: dict[str, float] = {}

    async def is_cooling(self, provider: str) -> bool:
        with self._lock:
            until = self._until.get(provider)
            if until is None:
                return False
            if time.monotonic() >= until:
                # Expired — drop it so the dict cannot grow without bound across a long
                # process lifetime. The provider set is tiny, but "tiny" is not "bounded".
                del self._until[provider]
                return False
            return True

    async def start(self, provider: str, seconds: float) -> None:
        with self._lock:
            deadline = time.monotonic() + seconds
            # EXTEND, never shorten. Two concurrent 429s must not have the second one
            # cut the first one's window short.
            self._until[provider] = max(self._until.get(provider, 0.0), deadline)

    async def clear(self) -> None:
        with self._lock:
            self._until.clear()


class _RedisCooldown:
    """Redis-backed cooldown, shared across Uvicorn workers.

    One key per provider, holding nothing but its own expiry — the TTL IS the state, so
    there is no value to read, no clock to compare and nothing to invalidate. Expiry is
    Redis's job, which is also what makes a crashed worker unable to leave a provider
    permanently disabled."""

    def __init__(self, redis_url: str) -> None:
        # Lazy import so a missing redis lib never breaks mock-only boot — same posture
        # as RedisSpendBackend.
        import redis.asyncio as aioredis

        self._client = aioredis.from_url(
            redis_url,
            decode_responses=True,
            socket_connect_timeout=_REDIS_TIMEOUT_SECONDS,
            socket_timeout=_REDIS_TIMEOUT_SECONDS,
        )

    async def is_cooling(self, provider: str) -> bool:
        try:
            return await self._client.exists(_key(provider)) > 0
        except Exception as exc:
            # FAIL OPEN. See the module docstring: a store we cannot read must not be
            # able to disable a provider. Logged at WARNING with the error TYPE only —
            # never the URL, which may carry credentials.
            logger.warning(
                "cooldown store unreadable; treating provider as available",
                extra={"extra": {"provider": provider, "error_type": type(exc).__name__}},
            )
            return False

    async def start(self, provider: str, seconds: float) -> None:
        try:
            # Plain SET with an expiry, NOT `nx=True`. A second 429 arriving mid-window
            # means the limit is still being hit, so the window should be re-armed from
            # now rather than allowed to lapse on the first one's schedule.
            await self._client.set(_key(provider), "1", ex=max(1, int(seconds)))
        except Exception as exc:
            # Also fail open: an unrecorded cooldown is the pre-existing behaviour.
            logger.warning(
                "cooldown store unwritable; provider not marked",
                extra={"extra": {"provider": provider, "error_type": type(exc).__name__}},
            )

    async def clear(self) -> None:
        try:
            keys = [k async for k in self._client.scan_iter(f"{_PREFIX}:*")]
            if keys:
                await self._client.delete(*keys)
        except Exception as exc:
            logger.warning(
                "cooldown store unavailable on clear",
                extra={"extra": {"error_type": type(exc).__name__}},
            )


class ProviderCooldown:
    """Name-stable facade over the two backends. Constructed once per process."""

    def __init__(self, settings: Settings) -> None:
        if settings.ai_spend_redis_url:
            self._store: _RedisCooldown | _InProcessCooldown = _RedisCooldown(
                settings.ai_spend_redis_url
            )
            self.backend_name = "redis"
        else:
            self._store = _InProcessCooldown()
            self.backend_name = "in_process"

    async def is_cooling(self, provider: str, settings: Settings) -> bool:
        """True if ``provider`` returned a rate limit recently enough to skip it.

        Always False when the feature is switched off (``ai_provider_cooldown_seconds``
        of 0), so the kill switch costs no round trip."""
        if settings.ai_provider_cooldown_seconds <= 0:
            return False
        return await self._store.is_cooling(provider)

    async def start(self, provider: str, settings: Settings) -> None:
        """Mark ``provider`` as rate-limited for the configured window."""
        seconds = settings.ai_provider_cooldown_seconds
        if seconds <= 0:
            return
        await self._store.start(provider, seconds)
        logger.warning(
            "provider rate-limited; cooling down",
            extra={"extra": {"provider": provider, "cooldown_s": seconds}},
        )

    async def clear(self) -> None:
        """Drop every cooldown. For tests and for an operator ending one early."""
        await self._store.clear()


_cooldown: ProviderCooldown | None = None
_cooldown_lock = threading.Lock()


def get_cooldown(settings: Settings) -> ProviderCooldown:
    """The process-wide cooldown, built on first use.

    Double-checked under a lock for the same reason the ledger is: Uvicorn serves
    concurrently from the first request, and two threads racing the constructor would
    open two Redis clients and leave one of them orphaned."""
    global _cooldown
    if _cooldown is None:
        with _cooldown_lock:
            if _cooldown is None:
                _cooldown = ProviderCooldown(settings)
                logger.info(
                    f"provider cooldown: {_cooldown.backend_name}",
                    extra={
                        "extra": {
                            "cooldown_store": _cooldown.backend_name,
                            "config_var": "AI_SPEND_REDIS_URL",
                        }
                    },
                )
    return _cooldown


def reset_cooldown() -> None:
    """Drop the cached instance so the next ``get_cooldown`` rebuilds it. Tests only."""
    global _cooldown
    with _cooldown_lock:
        _cooldown = None
