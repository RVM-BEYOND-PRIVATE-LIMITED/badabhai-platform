"""Test isolation for the AI service.

The unit/contract suite is MOCK-ONLY and must make ZERO real LLM calls — in CI
(which has no `.env`) and on a developer laptop that has a real-call `.env`
(AI_ENABLE_REAL_CALLS=true + a real provider key) for the staging validation
runbook.

pydantic-settings ranks real environment variables ABOVE the `.env` file, so
forcing the gate OFF in `os.environ` here neutralizes any local real-call `.env`
without deleting it. Tests that need real mode construct ``Settings(...)`` with
explicit kwargs, which outrank both. This guarantees the suite never reaches the
network and the skip-gated real per-field test stays skipped.

TWO layers, because the first one is a DENYLIST and a denylist is only ever as
good as its last update — P1-4 was exactly that failure: a flag nobody had added
here (SKILL_CANONICALIZE_ENABLED) armed a real outbound call during pytest.

1. :func:`_force_mock_only_env` — pin every setting that can arm an outbound call.
2. :func:`_install_egress_guard` — a socket-level backstop that makes a non-loopback
   connection IMPOSSIBLE, whatever a future flag, dotenv or code path decides.
   Tests must never spend money or hit the network; layer 2 is what makes that a
   PROPERTY of the suite instead of a promise to keep layer 1 updated.
"""

import ipaddress
import os
import socket

# --- Layer 1: settings that can arm a real call ----------------------------


def _force_mock_only_env() -> None:
    os.environ["AI_ENABLE_REAL_CALLS"] = "false"
    os.environ["AI_REAL_CALL_TASKS"] = ""
    # Blank every real-provider secret so a developer real-call `.env` can't leak
    # into Settings(). pydantic-settings reads the `.env` FILE, so popping os.environ
    # is not enough (the dotenv value would still flow in) — an EMPTY env var
    # outranks the dotenv entry, so set these to "" (falsy → every real gate stays
    # closed). GEMINI_FLASH_API_KEY is the master gate; ANTHROPIC_API_KEY adds the
    # fallback candidate; SARVAM_API_KEY gates real STT. (LITELLM_/GEMINI_API_KEY
    # are legacy names kept here only to neutralize an older developer .env.)
    for var in (
        "GEMINI_FLASH_API_KEY",
        "ANTHROPIC_API_KEY",
        "SARVAM_API_KEY",
        "LITELLM_API_KEY",
        "GEMINI_API_KEY",
    ):
        os.environ[var] = ""
    # Pin model routing too, so tests that read the DEFAULTS (e.g. the onboarding
    # readiness banner) are deterministic regardless of which primary/fallback a
    # developer's `.env` selects (e.g. a local Claude-Haiku-primary swap). Tests
    # needing a specific routing pass explicit Settings(...) kwargs, which outrank
    # these. Values mirror the committed defaults: Gemini primary, Haiku fallback.
    os.environ["DEFAULT_CHEAP_MODEL"] = "gemini-2.5-flash-lite"
    # Capable tier MUST mirror the committed default (config.py default_capable_model
    # = "gemini-2.5-flash", the PINNED prod extraction model). A stale flash-lite here
    # made profile_extraction resolve to the CHEAP model under tests, masking the
    # three-model pin the flip gate depends on (validation-model == flip-model).
    os.environ["DEFAULT_CAPABLE_MODEL"] = "gemini-2.5-flash"
    os.environ["DEFAULT_FALLBACK_MODEL"] = "claude-haiku-4-5"
    # Drop the eval target so the skip-gated per-field real test stays SKIPPED
    # even when a developer .env sets it.
    os.environ.pop("AI_EVAL_BASE_URL", None)
    # AI-ENV-1: neutralize the spend-ledger store for the whole suite. The env_file is
    # now ANCHORED to apps/ai-service/.env, so it resolves from ANY cwd (previously
    # only when pytest ran from that directory) — which means a developer .env is
    # reachable no matter where the suite is invoked from. A bare ``Settings()``
    # (test_ai_router.py, test_embeddings.py, ...) feeds get_ledger(), so a dev box
    # setting AI_SPEND_REDIS_URL would build a RedisSpendBackend pointed at a store
    # that is not running under test — every real-call gate would then fail CLOSED on
    # spend_store_unavailable and outcomes would be MACHINE-DEPENDENT. An empty value
    # is falsy, so the in-process backend is always selected. Tests that need the Redis
    # backend pass an explicit Settings(ai_spend_redis_url=...) kwarg, which outranks
    # this (init > env > .env).
    os.environ["AI_SPEND_REDIS_URL"] = ""
    # P1-4: TAX-4 skill canonicalization was the hole this list did not cover. A
    # developer .env with SKILL_CANONICALIZE_ENABLED=true flows into every bare
    # ``Settings()``, so /profile/extract entered the canonicalization branch during
    # pytest — and in the tests that legitimately build REAL-mode settings, that
    # branch made an actual outbound HTTPS call to the Gemini embeddings endpoint.
    # (It also failed two flag-OFF tests outright, because ``Settings()`` was no
    # longer the "flag off (default)" they assert against.) Pin the flag off, and
    # blank the seam it activates as defense in depth.
    os.environ["SKILL_CANONICALIZE_ENABLED"] = "false"
    os.environ["BACKEND_API_URL"] = ""
    os.environ["SKILLS_INTERNAL_TOKEN"] = ""
    # Langfuse ships spans over the network once BOTH keys are present.
    os.environ["LANGFUSE_PUBLIC_KEY"] = ""
    os.environ["LANGFUSE_SECRET_KEY"] = ""
    # Supabase storage (voice-note object downloads).
    os.environ["SUPABASE_URL"] = ""
    os.environ["SUPABASE_SERVICE_ROLE_KEY"] = ""


# --- Layer 2: socket-level egress guard ------------------------------------

# Loopback stays OPEN. Several suites drive the eval CLI against
# http://localhost:9999 (stubbed transport / expected-refusal paths) and
# TestClient + asyncio internals use local sockets. Blocking those would break
# tests without protecting anything: loopback cannot spend money or leak worker
# data. Everything else is refused.
_ALLOWED_HOSTNAMES = frozenset({"localhost", "localhost.localdomain", ""})


class OutboundNetworkBlocked(RuntimeError):
    """Raised when test code tries to open a NON-loopback connection.

    This is not flakiness: it means a code path under test tried to reach a real
    provider. Stub the transport, or fix the gate that let the call through — do
    NOT relax this guard.
    """


def _is_loopback(host: object) -> bool:
    if isinstance(host, bytes):
        host = host.decode("utf-8", "ignore")
    if not isinstance(host, str):
        return False
    candidate = host.strip("[]").lower()
    if candidate in _ALLOWED_HOSTNAMES:
        return True
    try:
        return ipaddress.ip_address(candidate).is_loopback
    except ValueError:
        return False  # a resolvable hostname is, by definition, not loopback here


def _check_address(address: object) -> None:
    # AF_UNIX and friends pass a str/bytes path — not an outbound network socket.
    if not isinstance(address, tuple) or not address:
        return
    if _is_loopback(address[0]):
        return
    raise OutboundNetworkBlocked(
        "the ai-service test suite must not open network connections "
        f"(attempted host: {address[0]!r}). Stub the transport (httpx.Client / "
        "providers.complete / embeddings) instead of relaxing this guard."
    )


def _install_egress_guard() -> None:
    """Wrap the socket primitives so no test can reach a real host.

    Deliberately at the SOCKET layer rather than per-client: it covers httpx,
    requests, redis, urllib and any future SDK, under every flag combination —
    including the ones nobody has thought to add to layer 1 yet.
    """
    if getattr(socket.socket, "_bb_egress_guarded", False):
        return

    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_create_connection = socket.create_connection

    def guarded_connect(self, address, *args, **kwargs):
        _check_address(address)
        return real_connect(self, address, *args, **kwargs)

    def guarded_connect_ex(self, address, *args, **kwargs):
        _check_address(address)
        return real_connect_ex(self, address, *args, **kwargs)

    def guarded_create_connection(address, *args, **kwargs):
        _check_address(address)
        return real_create_connection(address, *args, **kwargs)

    socket.socket.connect = guarded_connect
    socket.socket.connect_ex = guarded_connect_ex
    socket.create_connection = guarded_create_connection
    socket.socket._bb_egress_guarded = True


# Applied at import time — before any test constructs Settings() or a client.
_force_mock_only_env()
_install_egress_guard()
