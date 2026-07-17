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
import traceback
from pathlib import Path

import pytest

# Imported at MODULE level on purpose: importing app.main runs configure_logging(),
# which does `root.handlers.clear()` — and that would WIPE pytest's caplog handler if
# it happened mid-test, silently capturing nothing. At collection time it lands before
# caplog installs its per-test handler, so the log assertions below are deterministic
# instead of depending on whether an earlier test module already imported app.main.
from app import main as app_main
from app.ai import cost_tracker
from app.ai.cost_tracker import (
    _REDIS_TIMEOUT_SECONDS,
    InProcessSpendBackend,
    RedisSpendBackend,
    SpendLedger,
)
from app.config import _AI_SERVICE_ROOT, ConfigError, Settings

REPO_ROOT = Path(__file__).resolve().parents[3]
AI_SERVICE_DIR = Path(__file__).resolve().parents[1]

# Fields that can hold a credential. Compared as set/unset booleans, never by value:
# these tests diff whole Settings objects, and on a developer box (whose dotenv holds
# real keys — see conftest) a failing assertion would otherwise print them straight
# into the test output. §2: a secret never reaches a log.
_SECRET_FIELDS = frozenset({
    "gemini_flash_api_key",
    "anthropic_api_key",
    "sarvam_api_key",
    "supabase_service_role_key",
    "langfuse_public_key",
    "langfuse_secret_key",
    "skills_internal_token",
    "ai_internal_token",
    "ai_spend_redis_url",
})


def _redacted(settings: Settings) -> dict:
    """``model_dump()`` with every credential-bearing field reduced to a set/unset
    boolean. Preserves the discriminating power these tests need (a poisoned value
    still flips unset->set) with none of the leak risk."""
    return {
        key: (bool(value) if key in _SECRET_FIELDS else value)
        for key, value in settings.model_dump().items()
    }


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
    assert _redacted(from_root) == _redacted(from_pkg)

    # And the resolved env_file itself is CWD-independent.
    monkeypatch.chdir(REPO_ROOT)
    assert Path(Settings.model_config["env_file"]) == AI_SERVICE_DIR / ".env"


def test_a_decoy_env_file_in_the_cwd_is_never_read(monkeypatch, tmp_path):
    """The NON-VACUOUS anchor proof.

    The test above compares two real directories, so on a checkout where NEITHER
    holds a dotenv it would pass even with the bug. This one cannot: it plants a
    DECOY dotenv in the working directory carrying values this service would
    otherwise honour — exactly the root-dotenv-shadows-the-service-dotenv scenario.
    With the CWD-relative default, pydantic reads this file; with the anchor it is
    invisible.

    Asserted RELATIVE to a baseline resolved from the package directory, never against
    hardcoded expected values (review F5). This test must drop conftest's
    AI_ENABLE_REAL_CALLS guard to give the decoy a path in — which re-exposes the
    developer dotenv that conftest documents as holding AI_ENABLE_REAL_CALLS=true.
    Asserting ``is False`` would then fail on exactly that box: a false alarm about
    the developer's config, not about the anchor. Comparing the two resolutions asks
    the only question that matters — did the CWD change the answer? — and is correct
    on every machine regardless of what any real dotenv holds.
    """
    decoy = tmp_path / ".env"
    decoy.write_text(
        # A plausible ROOT dotenv: the API's mandatory Redis + a real-call flip.
        # The values are SENTINELS no real config would hold, so their absence is
        # meaningful on any box.
        "REDIS_URL=redis://api-sessions-store:6379/0\n"
        "AI_SPEND_REDIS_URL=redis://decoy-should-never-load:6379/0\n"
        "AI_ENABLE_REAL_CALLS=true\n"
        "AI_MAX_DAILY_COST_INR=99999\n",
        encoding="utf-8",
    )
    # conftest neutralizes some of these in os.environ, and a real env var OUTRANKS a
    # dotenv entry — leaving them would make the decoy unable to land even WITH the bug,
    # i.e. the test would pass for the wrong reason. Dropping them is what gives the
    # decoy a path in, and mirrors the real shape of this bug: `uvicorn app.main:app`
    # from the repo root, no shell vars set, just the wrong file on disk.
    monkeypatch.delenv("AI_SPEND_REDIS_URL", raising=False)
    monkeypatch.delenv("AI_ENABLE_REAL_CALLS", raising=False)

    # Baseline: resolved standing IN the package dir. Whatever it holds is the correct
    # answer by definition — the anchor's job is to return it from anywhere else too.
    monkeypatch.chdir(AI_SERVICE_DIR)
    baseline = Settings()

    monkeypatch.chdir(tmp_path)
    from_decoy = Settings()

    # THE PROPERTY: the CWD (and the decoy sitting in it) changed nothing.
    assert _redacted(from_decoy) == _redacted(baseline)

    # And the sentinels specifically never landed — safe as absolute assertions
    # because no real dotenv on any box holds these values.
    assert from_decoy.ai_spend_redis_url != "redis://decoy-should-never-load:6379/0"
    assert from_decoy.ai_max_daily_cost_inr != 99999
    # A stray dotenv must never flip the real-call gate (CLAUDE.md invariant 5). Stated
    # relatively so it is the DECOY being judged, not the developer's own config.
    assert from_decoy.ai_enable_real_calls == baseline.ai_enable_real_calls


# --- 5. the hard cut: the API's REDIS_URL can no longer reach these Settings ---

def test_legacy_redis_url_env_var_is_ignored(monkeypatch):
    """THE POINT OF THE HARD CUT. The NestJS API's REDIS_URL is MANDATORY
    infrastructure with an incompatible meaning; if it still bound to this field, a
    shared env / root dotenv / compose block would silently arm the Redis spend
    backend against a store this service does not own. It must not bind at all
    (``extra="ignore"`` drops it).

    ``delenv`` is LOAD-BEARING, not hygiene. conftest neutralizes AI_SPEND_REDIS_URL
    suite-wide with an empty string, and a real env var outranks every lower source —
    so leaving it in place SATISFIES the binding before REDIS_URL is ever consulted,
    and every assertion below would hold with the hard cut fully undone. Dropping it
    leaves REDIS_URL as the ONLY candidate source, which is what gives this test the
    power to fail. (``_env_file=None`` closes the dotenv source for the same reason.)
    """
    monkeypatch.delenv("AI_SPEND_REDIS_URL", raising=False)
    monkeypatch.setenv("REDIS_URL", "redis://api-sessions-store:6379/0")

    settings = Settings(_env_file=None)

    # `is None`, not merely falsy: with the only two other sources closed off, the
    # field can be non-None ONLY if REDIS_URL reached it — i.e. the hard cut leaked.
    assert settings.ai_spend_redis_url is None
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


# --- a malformed URL is rejected at STARTUP, naming the var, leaking nothing ----

@pytest.mark.parametrize(
    "malformed",
    [
        "localhost:6379",           # THE common typo: no scheme at all
        "http://localhost:6379",    # wrong scheme
        "redis:/localhost:6379",    # single-slash slip
        "  ",                       # whitespace-only
    ],
)
def test_malformed_spend_redis_url_fails_at_settings_naming_the_var(malformed):
    """TD67's precedent applied: a setting that can be misconfigured must be REJECTED
    at startup, not armed and left to explode somewhere less legible.

    ``redis.asyncio.from_url`` validates the scheme EAGERLY (it raises before any I/O),
    so without this validator a missing ``redis://`` prefix aborted BOOT from inside the
    redis library with a bare ValueError that never named the variable at fault — the
    exact failure class this PR exists to kill.
    """
    with pytest.raises(ConfigError) as excinfo:
        Settings(_env_file=None, ai_spend_redis_url=malformed)

    message = str(excinfo.value)
    assert "AI_SPEND_REDIS_URL" in message  # names the VAR, not just the field
    assert "redis://" in message  # and states what a valid value looks like


def test_malformed_spend_redis_url_error_never_leaks_the_credential():
    """§2 — THE TRAP. Pydantic echoes the offending input into validation errors by
    default (``input_value='redis://user:pass@host'``), and this value can carry
    credentials. ``hide_input_in_errors=True`` (config.py) suppresses that echo. A boot
    error is printed to logs and CI output, so an echo here is a real credential leak.
    """
    secret = "sup3rs3cret"
    # Malformed (bad scheme) AND credential-bearing — the value that must not surface.
    bad = f"proto://admin:{secret}@ledger.internal:6379/0"

    with pytest.raises(ConfigError) as excinfo:
        Settings(_env_file=None, ai_spend_redis_url=bad)

    # Check every rendering an operator or a log could plausibly see.
    renderings = [
        str(excinfo.value),
        repr(excinfo.value),
        "".join(traceback.format_exception(excinfo.value)),
    ]
    for rendered in renderings:
        assert secret not in rendered
        assert bad not in rendered
        assert "admin" not in rendered
    # ...while still being actionable.
    assert "AI_SPEND_REDIS_URL" in str(excinfo.value)


@pytest.mark.parametrize("valid", ["redis://h:6379/0", "rediss://h:6379/0", "unix:///t.sock"])
def test_valid_spend_redis_url_schemes_are_accepted(valid):
    """The validator must not over-reject: every scheme redis-py accepts still builds."""
    settings = Settings(_env_file=None, ai_spend_redis_url=valid)
    assert settings.ai_spend_redis_url == valid
    assert SpendLedger(settings).backend_name == "redis"


@pytest.mark.parametrize("unset", [None, ""])
def test_unset_spend_redis_url_stays_valid_and_is_not_mandatory(unset):
    """Redis is NOT mandatory. Unset (or an empty template line) must NOT raise — it
    means per-process caps, the deliberate dev/test/single-process default."""
    settings = Settings(_env_file=None, ai_spend_redis_url=unset)
    assert not settings.ai_spend_redis_url
    assert SpendLedger(settings).backend_name == "in_process"


def test_unusable_url_that_passes_the_scheme_check_still_names_the_var():
    """Defence in depth for the residual I measured: ``redis://host:notaport`` passes
    the scheme check but from_url still rejects it at parse time ("Port could not be
    cast to integer"). RedisSpendBackend re-raises naming the variable rather than
    letting a raw redis-lib error abort boot anonymously."""
    with pytest.raises(ConfigError) as excinfo:
        RedisSpendBackend("redis://host:notaport")

    message = str(excinfo.value)
    assert "AI_SPEND_REDIS_URL" in message
    assert "notaport" not in message  # value omitted (§2)


def test_wellformed_but_unreachable_url_boots_and_still_fails_closed():
    """THE INVARIANT the validation must not disturb. Shape-checking is NOT a
    connectivity check: a well-formed URL pointing at nothing must still CONSTRUCT
    (boot succeeds, no network at boot) and still BLOCK the real call per-call."""
    # Constructs without raising -> the service boots.
    ledger = SpendLedger(
        Settings(_env_file=None, ai_spend_redis_url="redis://192.0.2.1:6379/0")
    )
    assert ledger.backend_name == "redis"

    # ...and the per-call verdict is unchanged: blocked, never open.
    class _Unreachable:
        async def eval(self, *a, **k):
            raise ConnectionError("no route to host")

    ledger._store._client = _Unreachable()
    verdict = asyncio.run(
        ledger.would_exceed_spend(1.0, Settings(_env_file=None), user_ref="w1")
    )
    assert verdict == "spend_store_unavailable"


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


# --- the backend choice is announced AT BOOT, not on first traffic -------------

def test_startup_lifespan_logs_the_backend_at_boot(caplog, monkeypatch):
    """AI-ENV-1 1c as WRITTEN: the choice must be visible at STARTUP.

    The ledger is a lazy singleton, so before the lifespan hook nothing was logged
    until real AI traffic first constructed it — a log that only appears once traffic
    flows does not tell a deploy whether caps are global. Pins that merely booting the
    app emits the line.
    """
    from fastapi.testclient import TestClient

    monkeypatch.setattr(cost_tracker, "_ledger", None)  # force a fresh construction
    with caplog.at_level(logging.INFO, logger="ai.cost"):
        with TestClient(app_main.app):  # __enter__ runs the lifespan startup
            pass

    records = [r for r in caplog.records if "spend ledger:" in r.getMessage()]
    assert len(records) == 1  # exactly once at boot
    assert "InProcessSpendBackend" in records[0].getMessage()
    monkeypatch.setattr(cost_tracker, "_ledger", None)


def test_startup_log_fires_even_under_the_td67_locked_posture(caplog, monkeypatch):
    """The posture where the log MATTERS MOST. With AI_INTERNAL_TOKEN set, /health
    returns a trimmed payload that OMITS ``spend_store`` and never constructs the
    ledger — so the boot log is the ONLY signal of which backend is live."""
    from fastapi.testclient import TestClient

    locked = Settings(_env_file=None, ai_internal_token="x" * 16)
    monkeypatch.setattr(app_main, "settings", locked)
    monkeypatch.setattr(app_main, "get_settings", lambda: locked)
    monkeypatch.setattr(cost_tracker, "_ledger", None)

    with caplog.at_level(logging.INFO, logger="ai.cost"):
        with TestClient(app_main.app) as client:
            body = client.get("/health").json()

    # The trimmed payload really does hide the backend (this is why boot logging matters).
    assert "spend_store" not in body
    assert body["service_auth_enabled"] is True
    # ...but the boot log still announced it.
    records = [r for r in caplog.records if "spend ledger:" in r.getMessage()]
    assert len(records) == 1
    monkeypatch.setattr(cost_tracker, "_ledger", None)


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


# NOTE (review F4): a "reserve returns within the timeout budget" test used to live
# here and was DELETED, not weakened. Its stub scheduled the very ``asyncio.sleep`` the
# assertion then measured — it asserted on a value it had set itself, so it would have
# passed at ANY timeout, including none at all, while its name claimed the reserve
# "must not stall". A test that measures its own stub advertises protection it does not
# provide. The bound is pinned where it is actually decided — the client kwargs, in
# ``test_redis_client_is_built_with_a_bounded_timeout`` above, which mutation testing
# shows FAILS when the timeouts are removed. Measuring the REAL client's timeout needs a
# routable-but-silent host (measured by hand off-CI: 21.05s -> 2.01s), which is network-
# and OS-dependent and does not belong in the suite.


# --- MSG-1 (router half): the ROUTER must log the REAL reason ------------------

def _block_router(monkeypatch, reason: str):
    """Drive the REAL AIRouter in real mode with the ledger stubbed to block with
    ``reason``. No network is possible: the spend check sits BEFORE
    ``providers.complete`` and blocking every candidate skips the dispatch entirely.
    Returns the router's WARNING records for the run."""
    from app.ai.router import AIRouter

    class _BlockingLedger:
        async def would_exceed_spend(self, projected_inr, settings, *, user_ref=None):
            return reason

        async def record_spend(self, *a, **k):
            return None

        def try_consume_retry(self, settings):
            return True

    monkeypatch.setattr(cost_tracker, "get_ledger", lambda: _BlockingLedger())
    # Real mode + no anthropic key => exactly ONE candidate, so one log line.
    settings = Settings(
        _env_file=None,
        ai_enable_real_calls=True,
        gemini_flash_api_key="k",
        anthropic_api_key=None,
    )
    router = AIRouter(settings)
    content, meta = asyncio.run(
        router.run(
            "profile_extraction",
            messages=[{"role": "user", "content": "vmc 4 saal"}],
            mock_response="MOCK",
        )
    )
    return content, meta


def test_router_logs_the_real_block_reason_not_a_blanket_spend_cap(monkeypatch, caplog):
    """MSG-1's PRIMARY site. The router used to log "spend cap reached" for EVERY
    block reason, so an unreachable ledger (a CONFIG error) presented as a cap/model
    problem — the exact misdiagnosis that cost real debugging time.

    Pins BOTH halves: the unreachable-store line names AI_SPEND_REDIS_URL and denies
    being a cap, and a genuine cap line does NOT. Collapsing them back makes the two
    lines identical, which the final assertion rejects.
    """
    with caplog.at_level(logging.WARNING, logger="ai.router"):
        content, meta = _block_router(monkeypatch, "spend_store_unavailable")
    store_lines = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert len(store_lines) == 1
    assert "spend ledger unreachable" in store_lines[0]
    assert "AI_SPEND_REDIS_URL" in store_lines[0]
    assert "NOT a cap" in store_lines[0]
    # §2: names the variable, never the value.
    assert "redis://" not in store_lines[0]
    # Fail-closed is unaffected by the wording: still mock, still blocked.
    assert content == "MOCK"
    assert meta.real_call is False
    assert meta.error_code == "spend_store_unavailable"

    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="ai.router"):
        _block_router(monkeypatch, "daily_cap_exceeded")
    cap_lines = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert len(cap_lines) == 1
    assert "daily spend cap reached" in cap_lines[0]
    # A real budget stop must NOT send anyone to debug Redis config.
    assert "AI_SPEND_REDIS_URL" not in cap_lines[0]

    # THE DISCRIMINATOR: collapsing both into one headline makes these equal.
    assert store_lines[0] != cap_lines[0]


def test_router_distinguishes_every_spend_block_reason(monkeypatch, caplog):
    """All four closed-set ledger reasons produce mutually distinct router lines."""
    seen = {}
    for reason in (
        "spend_store_unavailable",
        "daily_cap_exceeded",
        "cumulative_cap_exceeded",
        "user_daily_cap_exceeded",
    ):
        caplog.clear()
        with caplog.at_level(logging.WARNING, logger="ai.router"):
            _block_router(monkeypatch, reason)
        lines = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
        assert len(lines) == 1, reason
        seen[reason] = lines[0]

    assert len(set(seen.values())) == 4, seen
    assert "cumulative spend cap" in seen["cumulative_cap_exceeded"]
    assert "per-user daily spend cap" in seen["user_daily_cap_exceeded"]


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

def test_a_decoy_env_file_cannot_arm_the_redis_backend_via_the_real_singleton(
    monkeypatch, tmp_path
):
    """END-TO-END through the PRODUCTION wiring: get_settings() -> get_ledger().

    The unit tests above build Settings directly; this one exercises the path the
    service actually uses at boot, with a decoy dotenv in the CWD trying to arm the
    Redis backend against a store this service does not own. That is the real-world
    consequence of the CWD-relative env_file, and it must be impossible.

    (Replaces an assertion that read ``backend_name in {"in_process", "redis"}`` —
    the complete range of a two-valued property, so it could never fail. Review F1's
    vacuity audit.)
    """
    from app import config as config_module

    (tmp_path / ".env").write_text(
        "AI_SPEND_REDIS_URL=redis://decoy-should-never-load:6379/0\n", encoding="utf-8"
    )
    monkeypatch.delenv("AI_SPEND_REDIS_URL", raising=False)  # let the decoy have a path in
    monkeypatch.setattr(config_module, "_settings", None)  # drop the cached settings
    monkeypatch.setattr(cost_tracker, "_ledger", None)  # force a fresh ledger
    monkeypatch.chdir(tmp_path)
    try:
        # The decoy must not reach the singleton -> caps stay in-process, and no
        # RedisSpendBackend is ever pointed at the API's store.
        assert cost_tracker.get_ledger().backend_name == "in_process"
    finally:
        monkeypatch.setattr(cost_tracker, "_ledger", None)
        monkeypatch.setattr(config_module, "_settings", None)
