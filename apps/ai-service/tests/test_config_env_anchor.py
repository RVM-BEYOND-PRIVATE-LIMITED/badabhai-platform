"""AI-ENV-1 — the env_file anchor + the AI_SPEND_REDIS_URL hard cut.

The bug these pin: ``env_file=".env"`` is CWD-relative, so running the service from
the repo root loaded the ROOT .env (the NestJS API's) instead of the ai-service's.
The two projects both defined ``REDIS_URL`` with INCOMPATIBLE meanings — mandatory
session/OTP/BullMQ infrastructure for the API, an OPTIONAL spend ledger here — and
the symptom of loading the wrong one was a multi-second stall per real call, not an
error. The fix is two-sided: ANCHOR the env_file to the package, and RENAME the var
so the API's REDIS_URL cannot reach these Settings at all.

These tests never touch the network: the unreachable-Redis proof uses a client stub
that raises, and the timeout proof asserts the CLIENT CONFIG (kwargs passed to
from_url), so CI needs no blackholed host and stays fast + deterministic.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from app.ai import cost_tracker
from app.ai.cost_tracker import (
    _REDIS_TIMEOUT_SECONDS,
    InProcessSpendBackend,
    RedisSpendBackend,
    SpendLedger,
)
from app.config import _AI_SERVICE_ROOT, Settings

REPO_ROOT = Path(__file__).resolve().parents[3]
AI_SERVICE_DIR = Path(__file__).resolve().parents[1]


# --- 1. the anchor: identical config from ANY cwd -----------------------------

def test_env_file_is_anchored_to_the_package_not_the_cwd():
    """The anchor points at apps/ai-service/.env — parents[1] of app/config.py."""
    assert _AI_SERVICE_ROOT == AI_SERVICE_DIR
    assert _AI_SERVICE_ROOT.name == "ai-service"
    configured = Settings.model_config["env_file"]
    # An ABSOLUTE path (the whole point): a bare ".env" would resolve per-CWD.
    assert Path(configured).is_absolute()
    assert Path(configured) == AI_SERVICE_DIR / ".env"


def test_config_loads_identically_from_repo_root_and_from_package(monkeypatch):
    """AI-ENV-1: the SAME settings resolve from a foreign CWD. Before the anchor,
    Settings() from the repo root read the ROOT .env (the API's) — a different file
    with a colliding REDIS_URL — and from apps/ai-service read the service's own."""
    monkeypatch.chdir(REPO_ROOT)
    from_root = Settings()

    monkeypatch.chdir(AI_SERVICE_DIR)
    from_pkg = Settings()

    # Every field, not just the Redis one: the anchor governs the whole file.
    assert from_root.model_dump() == from_pkg.model_dump()

    # And the resolved env_file itself is CWD-independent.
    monkeypatch.chdir(REPO_ROOT)
    assert Path(Settings.model_config["env_file"]) == AI_SERVICE_DIR / ".env"


def test_a_decoy_env_file_in_the_cwd_is_never_read(monkeypatch, tmp_path):
    """The NON-VACUOUS anchor proof.

    The test above compares two real directories, so on a checkout where NEITHER
    holds a dotenv it would pass even with the bug. This one cannot: it plants a
    DECOY dotenv in the working directory carrying values this service would
    otherwise honour — exactly the root-.env-shadows-the-service-.env scenario.
    With the CWD-relative default, pydantic reads this file and the asserts below
    fail. With the anchor, it is invisible.
    """
    decoy = tmp_path / ".env"
    decoy.write_text(
        # A plausible ROOT .env: the API's mandatory Redis + a real-call flip.
        "REDIS_URL=redis://api-sessions-store:6379/0\n"
        "AI_SPEND_REDIS_URL=redis://decoy-should-never-load:6379/0\n"
        "AI_ENABLE_REAL_CALLS=true\n"
        "AI_MAX_DAILY_COST_INR=99999\n",
        encoding="utf-8",
    )
    # conftest neutralizes some of these in os.environ, and a real env var OUTRANKS a
    # dotenv entry — which would make the asserts below pass for the wrong reason. Drop
    # those blanks so the decoy FILE is the only possible source, which is also the
    # real-world shape of this bug: `uvicorn app.main:app` from the repo root, no shell
    # vars set, just the wrong file on disk.
    monkeypatch.delenv("AI_SPEND_REDIS_URL", raising=False)
    monkeypatch.delenv("AI_ENABLE_REAL_CALLS", raising=False)
    monkeypatch.chdir(tmp_path)

    settings = Settings()

    # None of the decoy's values may reach the service.
    assert settings.ai_spend_redis_url != "redis://decoy-should-never-load:6379/0"
    assert settings.ai_max_daily_cost_inr != 99999
    # The most dangerous one: a stray dotenv must NEVER flip the real-call gate
    # (CLAUDE.md invariant 5 — real calls are gated and off by default).
    assert settings.ai_enable_real_calls is False
    assert SpendLedger(settings).backend_name == "in_process"


# --- 5. the hard cut: the API's REDIS_URL can no longer reach these Settings ---

def test_legacy_redis_url_env_var_is_ignored(monkeypatch):
    """THE POINT OF THE HARD CUT. The NestJS API's REDIS_URL is MANDATORY
    infrastructure with an incompatible meaning; if it still bound to this field, a
    shared env / root .env / compose block would silently arm the Redis spend backend
    against a store this service does not own. It must not bind at all
    (``extra="ignore"`` drops it)."""
    monkeypatch.setenv("REDIS_URL", "redis://api-sessions-store:6379/0")

    settings = Settings(_env_file=None)

    # Falsy, not `is None`: conftest neutralizes the var suite-wide with an empty
    # string, and empty is what backend selection actually keys on. The point stands
    # either way — the API's REDIS_URL value did not land here.
    assert not settings.ai_spend_redis_url
    assert settings.ai_spend_redis_url != "redis://api-sessions-store:6379/0"
    assert not hasattr(settings, "redis_url")  # the old field name is GONE
    # The decisive assertion: the ledger stays in-process despite REDIS_URL being set.
    assert SpendLedger(settings).backend_name == "in_process"


def test_new_var_name_does_bind(monkeypatch):
    """Control for the test above: the NEW name binds — proving the previous test
    fails for the RIGHT reason (the name, not a broken env read)."""
    monkeypatch.setenv("AI_SPEND_REDIS_URL", "redis://ai-spend-ledger:6379/0")

    settings = Settings(_env_file=None)

    assert settings.ai_spend_redis_url == "redis://ai-spend-ledger:6379/0"
    assert SpendLedger(settings).backend_name == "redis"


# --- 2. unset -> in-process + the startup log ---------------------------------

def test_unset_selects_in_process_backend_and_logs_once(caplog):
    """Unset is a DELIBERATE default, not a failure — but it must be VISIBLE:
    per-process caps silently standing in for global ones was invisible from outside."""
    with caplog.at_level(logging.INFO, logger="ai.cost"):
        ledger = SpendLedger(Settings(_env_file=None, ai_spend_redis_url=None))

    assert ledger.backend_name == "in_process"
    assert isinstance(ledger._store, InProcessSpendBackend)

    records = [r for r in caplog.records if "spend ledger:" in r.getMessage()]
    assert len(records) == 1  # ONCE at construction, never per call
    message = records[0].getMessage()
    assert "InProcessSpendBackend" in message
    assert "per-process caps" in message
    assert "AI_SPEND_REDIS_URL" in message  # tells you how to get global caps


# --- 3. set + reachable -> redis backend --------------------------------------

def test_set_and_reachable_selects_redis_backend_and_logs_once(caplog):
    """Set => the Redis backend, and a reachable store actually reserves through it
    (fakeredis runs the real atomic Lua, so this is a live round-trip, not a mock)."""
    import pytest

    pytest.importorskip("fakeredis", reason="fakeredis[lua] required")
    import fakeredis
    import fakeredis.aioredis

    with caplog.at_level(logging.INFO, logger="ai.cost"):
        ledger = SpendLedger(
            Settings(_env_file=None, ai_spend_redis_url="redis://ai-spend-ledger:6379/0")
        )

    assert ledger.backend_name == "redis"
    assert isinstance(ledger._store, RedisSpendBackend)

    records = [r for r in caplog.records if "spend ledger:" in r.getMessage()]
    assert len(records) == 1
    assert "RedisSpendBackend" in records[0].getMessage()
    assert "global caps" in records[0].getMessage()

    # Swap in an in-memory server (from_url is lazy) and prove a real reserve works.
    server = fakeredis.FakeServer()
    ledger._store._client = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
    settings = Settings(
        _env_file=None,
        ai_max_daily_cost_inr=100.0,
        ai_max_total_cost_inr=100.0,
        ai_max_user_daily_cost_inr=100.0,
    )
    assert asyncio.run(ledger.would_exceed_spend(1.0, settings, user_ref="w1")) is None


def test_startup_log_never_contains_the_redis_url_value(caplog):
    """§2: the URL may carry credentials (redis://user:pass@host). The log NAMES the
    variable; it must NEVER print its value."""
    secret = "redis://admin:sup3rs3cret@ledger.internal:6379/0"
    with caplog.at_level(logging.INFO, logger="ai.cost"):
        SpendLedger(Settings(_env_file=None, ai_spend_redis_url=secret))

    for record in caplog.records:
        rendered = record.getMessage() + repr(getattr(record, "extra", ""))
        assert "sup3rs3cret" not in rendered
        assert secret not in rendered
        assert "redis://" not in rendered


# --- 4. set + UNREACHABLE -> blocked (fail-closed), fast, and NAMES the var ----

def test_redis_client_is_built_with_a_bounded_timeout():
    """1d: the client MUST carry connect/socket timeouts. Without them the OS TCP
    behaviour governs — a MEASURED 21s stall per reserve against a routable-but-silent
    host, and reserve runs once PER CANDIDATE MODEL. Asserted on the client config so
    CI needs no blackholed host."""
    captured: dict = {}

    import redis.asyncio as aioredis

    real_from_url = aioredis.from_url

    def _spy(url, **kwargs):
        captured.update(kwargs)
        return real_from_url(url, **kwargs)

    aioredis.from_url = _spy
    try:
        RedisSpendBackend("redis://ai-spend-ledger:6379/0")
    finally:
        aioredis.from_url = real_from_url

    assert captured["socket_connect_timeout"] == _REDIS_TIMEOUT_SECONDS
    assert captured["socket_timeout"] == _REDIS_TIMEOUT_SECONDS
    # Defensible bound: same-network Redis answers in low single-digit ms.
    assert 0 < _REDIS_TIMEOUT_SECONDS <= 5.0


def test_unreachable_redis_blocks_the_real_call_fast_and_names_the_var(caplog):
    """THE INVARIANT: fast-fail changes the LATENCY and the MESSAGE, NEVER the
    VERDICT. An unreachable ledger must STILL block the real call — an unverifiable
    cap never permits unaccounted spend (CLAUDE.md §2 / §3 fail-closed).
    """
    backend = RedisSpendBackend("redis://ai-spend-ledger:6379/0")

    class _TimeoutClient:
        """Stands in for the bounded client: raises the way a timed-out connect does."""

        async def eval(self, *a, **k):
            raise TimeoutError("Timeout connecting to server")

    backend._client = _TimeoutClient()

    with caplog.at_level(logging.WARNING, logger="ai.cost"):
        verdict = asyncio.run(
            backend.reserve(1.0, Settings(_env_file=None), user_ref="w1")
        )

    # VERDICT unchanged: still blocked, still fail-closed. Never None (never open).
    assert verdict == "spend_store_unavailable"

    # MESSAGE improved: it NAMES the variable so this is diagnosable as a CONFIG error.
    records = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(records) == 1
    message = records[0].getMessage()
    assert "AI_SPEND_REDIS_URL" in message
    assert "fail-closed" in message
    # §2: names the variable, never the value.
    assert "redis://" not in message


def test_unreachable_redis_reserve_returns_within_the_timeout_budget():
    """FAST: the reserve must not stall. Bounded by the client timeout, so a
    misconfiguration surfaces in ~seconds, not the ~21s OS TCP default."""
    import time

    backend = RedisSpendBackend("redis://ai-spend-ledger:6379/0")

    class _SlowThenTimeoutClient:
        async def eval(self, *a, **k):
            # Simulate the bounded wait the real client performs before raising.
            await asyncio.sleep(_REDIS_TIMEOUT_SECONDS)
            raise TimeoutError("Timeout connecting to server")

    backend._client = _SlowThenTimeoutClient()

    start = time.perf_counter()
    verdict = asyncio.run(backend.reserve(1.0, Settings(_env_file=None), user_ref="w1"))
    elapsed = time.perf_counter() - start

    assert verdict == "spend_store_unavailable"  # fail-closed preserved
    # Comfortably under the 21s OS default this replaces; generous headroom for CI.
    assert elapsed < _REDIS_TIMEOUT_SECONDS + 3.0


def test_ledger_facade_also_fails_closed_when_the_store_is_unreachable():
    """The router calls the FACADE, not the backend — prove fail-closed survives the
    facade hop (this is the call the real-call gate actually depends on)."""
    ledger = SpendLedger(
        Settings(_env_file=None, ai_spend_redis_url="redis://ai-spend-ledger:6379/0")
    )

    class _BoomClient:
        async def eval(self, *a, **k):
            raise ConnectionError("redis down")

    ledger._store._client = _BoomClient()

    verdict = asyncio.run(
        ledger.would_exceed_spend(1.0, Settings(_env_file=None), user_ref="w1")
    )
    assert verdict == "spend_store_unavailable"


# --- the ledger singleton honours the anchored settings ------------------------

def test_get_ledger_singleton_uses_the_anchored_settings(monkeypatch):
    """get_ledger() builds from get_settings(); with the anchor that resolution is
    CWD-independent, so the singleton cannot differ by launch directory."""
    monkeypatch.setattr(cost_tracker, "_ledger", None)
    monkeypatch.chdir(REPO_ROOT)
    try:
        assert cost_tracker.get_ledger().backend_name in {"in_process", "redis"}
    finally:
        monkeypatch.setattr(cost_tracker, "_ledger", None)
