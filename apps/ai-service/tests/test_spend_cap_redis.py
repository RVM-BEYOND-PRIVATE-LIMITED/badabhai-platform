"""TD27 — Redis-backed spend-ledger proof tests (the GLOBAL cross-worker caps).

Backed by ``fakeredis[lua]`` (async). These prove the non-negotiables of the
shared store that the in-process suite (test_spend_cap.py) cannot:

- ATOMIC reserve — N concurrent "workers" cannot collectively exceed a daily /
  cumulative / per-user cap (the check-then-act overshoot is closed).
- reconcile on success (refund reserved − actual) and full refund on failure/abort.
- FAIL-CLOSED when Redis is unreachable (reserve blocks; refund/snapshot never raise).
- PII-free keys + UTC-day key naming with a bounded TTL (lifetime key has none).
- backend selection by REDIS_URL; the facade preserves the snapshot shape.

NOTE on the concurrency proof: asyncio is single-threaded and a fakeredis ``eval``
runs the whole Lua script to completion without yielding — which is exactly why a
SINGLE check-and-increment eval cannot interleave (a non-atomic GET-then-INCR with
an await between them could). So these prove the script's logic (exactly K succeed;
the counter never exceeds the cap) under the same atomicity guarantee real Redis
gives. A true multi-PROCESS race needs a real Redis (out of CI scope).
"""

import re

import pytest

from app.ai import cost_tracker
from app.ai.cost_tracker import RedisSpendBackend, SpendLedger
from app.config import Settings

# fakeredis[lua] (pulls lupa) is required — eval is unsupported without it.
pytest.importorskip("fakeredis", reason="fakeredis[lua] required for the Redis backend tests")
import asyncio  # noqa: E402

import fakeredis  # noqa: E402
import fakeredis.aioredis  # noqa: E402

_WIDE = dict(ai_max_daily_cost_inr=1e9, ai_max_total_cost_inr=1e9, ai_max_user_daily_cost_inr=1e9)


def _settings(**overrides):
    """Settings that IGNORE the dev-box apps/ai-service/.env (which may hold real
    keys / flags — Finding 3) so the tests are deterministic on a dev box and in CI."""
    return Settings(_env_file=None, **overrides)


def _fresh_redis_client():
    """An isolated in-memory fakeredis async client (its own FakeServer so tests
    never share state). decode_responses=True to match the production client."""
    server = fakeredis.FakeServer()
    return fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)


def _backend():
    """A RedisSpendBackend wired to an isolated fakeredis. ``from_url`` is lazy
    (no connect at construction), so we just swap the client after building."""
    backend = RedisSpendBackend("redis://test")
    backend._client = _fresh_redis_client()
    return backend


# --- ATOMIC reserve: N concurrent workers cannot exceed a cap ----------------

def test_atomic_daily_cap_across_concurrent_workers():
    async def body():
        backend = _backend()
        # cap 10, each reserve 1.0 -> at most 10 of 25 concurrent reserves succeed.
        settings = _settings(ai_max_daily_cost_inr=10.0, ai_max_total_cost_inr=1e9,
                             ai_max_user_daily_cost_inr=1e9)
        results = await asyncio.gather(
            *[backend.reserve(1.0, settings, user_ref=None) for _ in range(25)]
        )
        allowed = [r for r in results if r is None]
        blocked = [r for r in results if r is not None]
        assert len(allowed) == 10
        assert blocked and all(r == "daily_cap_exceeded" for r in blocked)
        snap = await backend.snapshot(settings, user_ref=None)
        assert snap["daily_spend_inr"] == pytest.approx(10.0)
        assert snap["daily_spend_inr"] <= settings.ai_max_daily_cost_inr  # never overshot

    asyncio.run(body())


def test_atomic_cumulative_cap_across_concurrent_workers():
    async def body():
        backend = _backend()
        settings = _settings(ai_max_daily_cost_inr=1e9, ai_max_total_cost_inr=7.0,
                             ai_max_user_daily_cost_inr=1e9)
        results = await asyncio.gather(
            *[backend.reserve(1.0, settings, user_ref=None) for _ in range(20)]
        )
        assert len([r for r in results if r is None]) == 7
        assert all(r == "cumulative_cap_exceeded" for r in results if r is not None)
        snap = await backend.snapshot(settings, user_ref=None)
        assert snap["total_spend_inr"] == pytest.approx(7.0)

    asyncio.run(body())


def test_atomic_per_user_cap_across_concurrent_workers():
    async def body():
        backend = _backend()
        # per-user cap 5; one worker firing 20 concurrent reserves -> exactly 5 win.
        settings = _settings(ai_max_user_daily_cost_inr=5.0, ai_max_daily_cost_inr=1e9,
                             ai_max_total_cost_inr=1e9)
        results = await asyncio.gather(
            *[backend.reserve(1.0, settings, user_ref="worker-X") for _ in range(20)]
        )
        assert len([r for r in results if r is None]) == 5
        assert all(r == "user_daily_cap_exceeded" for r in results if r is not None)
        snap = await backend.snapshot(settings, user_ref="worker-X")
        assert snap["user_daily_spend_inr"] == pytest.approx(5.0)

    asyncio.run(body())


# --- reconcile / refund ------------------------------------------------------

def test_reconcile_refunds_overreserve_on_success():
    async def body():
        backend = _backend()
        settings = _settings(**_WIDE)
        assert await backend.reserve(10.0, settings, user_ref="w1") is None  # worst-case 10
        await backend.refund(10.0, 2.5, user_ref="w1")  # actual 2.5 -> refund 7.5
        snap = await backend.snapshot(settings, user_ref="w1")
        assert snap["daily_spend_inr"] == pytest.approx(2.5)
        assert snap["total_spend_inr"] == pytest.approx(2.5)
        assert snap["user_daily_spend_inr"] == pytest.approx(2.5)

    asyncio.run(body())


def test_full_refund_on_failure_and_floor_at_zero():
    async def body():
        backend = _backend()
        settings = _settings(**_WIDE)
        assert await backend.reserve(4.0, settings, user_ref="w1") is None
        await backend.refund(4.0, 0.0, user_ref="w1")  # failure/abort -> full refund
        snap = await backend.snapshot(settings, user_ref="w1")
        assert snap["daily_spend_inr"] == pytest.approx(0.0)
        assert snap["total_spend_inr"] == pytest.approx(0.0)
        assert snap["user_daily_spend_inr"] == pytest.approx(0.0)
        # an over-refund (float drift / double-call) can NOT drive a counter below 0
        await backend.refund(100.0, 0.0, user_ref="w1")
        snap2 = await backend.snapshot(settings, user_ref="w1")
        assert snap2["daily_spend_inr"] == pytest.approx(0.0)
        assert snap2["total_spend_inr"] == pytest.approx(0.0)

    asyncio.run(body())


# --- FAIL-CLOSED when Redis is unreachable -----------------------------------

def test_reserve_fails_closed_when_redis_unreachable():
    async def body():
        backend = RedisSpendBackend("redis://test")

        class _BoomClient:
            async def eval(self, *a, **k):
                raise ConnectionError("redis down")

            async def get(self, *a, **k):
                raise ConnectionError("redis down")

            async def scard(self, *a, **k):
                raise ConnectionError("redis down")

        backend._client = _BoomClient()
        settings = _settings()
        # RESERVE must fail CLOSED: a block reason, NEVER None (never fail open).
        assert await backend.reserve(1.0, settings, user_ref="w1") == "spend_store_unavailable"
        # REFUND must NOT raise (can't refund -> leaves the reserve, logs).
        await backend.refund(1.0, 0.0, user_ref="w1")
        # SNAPSHOT degrades to PII-free sentinels, does not raise.
        snap = await backend.snapshot(settings, user_ref="w1")
        assert snap["daily_spend_inr"] is None
        assert snap["total_spend_inr"] is None

    asyncio.run(body())


# --- UTC-day key naming + TTL + PII-free keys --------------------------------

def test_keys_are_pii_free_and_have_correct_ttl():
    async def body():
        backend = _backend()
        settings = _settings(**_WIDE)
        await backend.reserve(1.0, settings, user_ref="worker-uuid-1")
        keys = sorted([k async for k in backend._client.scan_iter("*")])
        # Every key is under the aispend namespace; shape carries only the UTC date
        # and/or an OPAQUE worker_ref — never message content.
        for k in keys:
            assert re.match(r"^aispend:(daily|total|user|users)(:|$)", k), k
        day = cost_tracker._utc_date_str()
        assert f"aispend:daily:{day}" in keys
        assert f"aispend:user:{day}:worker-uuid-1" in keys
        assert "aispend:total" in keys
        # daily + per-user keys carry a positive, day-bounded TTL; the lifetime key none.
        upper = 24 * 3600 + 3600 + 5
        assert 0 < await backend._client.ttl(f"aispend:daily:{day}") <= upper
        assert 0 < await backend._client.ttl(f"aispend:user:{day}:worker-uuid-1") <= upper
        assert await backend._client.ttl("aispend:total") == -1  # no expiry on cumulative

    asyncio.run(body())


# --- backend selection + facade snapshot shape -------------------------------

def test_backend_selection_by_redis_url():
    # Construction only (from_url is lazy) — no event loop / no Redis needed.
    assert SpendLedger(_settings()).backend_name == "in_process"
    assert SpendLedger(_settings(redis_url="redis://test")).backend_name == "redis"


def test_facade_reserve_reconcile_and_snapshot_shape_on_redis():
    async def body():
        ledger = SpendLedger(_settings(redis_url="redis://test"))
        ledger._store._client = _fresh_redis_client()
        settings = _settings(**_WIDE)
        # would_exceed_spend RESERVES; record_spend RECONCILES (refunds reserved-actual).
        assert await ledger.would_exceed_spend(3.0, settings, user_ref="w1") is None
        await ledger.record_spend(3.0, 0.7, user_ref="w1")
        snap = await ledger.snapshot(settings, user_ref="w1")
        assert snap["daily_spend_inr"] == pytest.approx(0.7)
        assert snap["user_daily_spend_inr"] == pytest.approx(0.7)
        # The Redis path preserves the EXACT in-process snapshot shape (retry-budget
        # view merged on by the facade + the per-user fields). PII-free keys only.
        assert set(snap.keys()) == {
            "daily_spend_inr", "daily_cap_inr", "total_spend_inr", "total_cap_inr",
            "user_daily_cap_inr", "tracked_users", "retry_window_count",
            "retry_budget_per_window", "kill_switch_engaged", "window_seconds", "day",
            "user_ref", "user_daily_spend_inr",
        }

    asyncio.run(body())
