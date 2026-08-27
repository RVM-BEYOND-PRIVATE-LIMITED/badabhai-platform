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

THREE layers, because layer 1 is a DENYLIST and a denylist is only ever as good
as its last update — P1-4 was exactly that failure: a flag nobody had added here
(SKILL_CANONICALIZE_ENABLED) armed a real outbound call during pytest.

1. :func:`_force_mock_only_env` — pin every setting that can arm an outbound call.
2. :func:`_install_egress_guard` — a socket-level backstop that makes a non-loopback
   connection IMPOSSIBLE, whatever a future flag, dotenv or code path decides.
   Tests must never spend money or hit the network; layer 2 is what makes that a
   PROPERTY of the suite instead of a promise to keep layer 1 updated.
3. :func:`_neutralize_service_auth` — clear ``ai_internal_token`` on the SHARED
   settings singleton. Layer 1 structurally cannot do this one: its whole technique
   is "set the var to '' so it outranks the dotenv entry", and ``ai_internal_token``
   carries ``min_length=16`` ON PURPOSE (TD67 — an empty token would enter the
   enforcement branch where ``compare_digest(b"", b"")`` passes every tokenless
   request while /health claims the guard is on). So "" fails ``Settings()`` at
   startup instead of neutralizing anything, and a developer dotenv holding the
   bearer armed the auth middleware for the WHOLE suite — 401ing every TestClient
   call across 15 modules. Same leak shape as P1-4, in a setting the denylist
   technique cannot cover.

   NOT fixed by pointing ``env_file`` at None: ``test_config_env_anchor.py`` proves
   the AI-ENV-1 anchor by planting a DECOY dotenv and by diffing two real loads.
   With no dotenv read at all those proofs pass VACUOUSLY — the guard would look
   green while testing nothing. The dotenv stays live; only the bearer is cleared.
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
    # Pro tier (#1237) — the chat turn's model, decoupled from the pinned capable tier above
    # precisely so raising it cannot move extraction. Mirrors config.py `default_pro_model`.
    os.environ["DEFAULT_PRO_MODEL"] = "gemini-2.5-pro"
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
    # The AI-call trace text. It arms no outbound call, but it is the kind of flag
    # DOMAIN_MATCH_TOP_K is pinned for: it decides WHICH branch runs, and the flag-OFF
    # tests in test_ai_call_trace_text.py assert against a bare ``Settings()``. A
    # developer .env turning it on would make those pass vacuously — asserting "no text"
    # on a path that was never meant to have any — and would silently widen every
    # endpoint's response body for the whole suite.
    os.environ["AI_CALL_TRACE_TEXT_ENABLED"] = "false"
    # Supabase storage (voice-note object downloads).
    os.environ["SUPABASE_URL"] = ""
    os.environ["SUPABASE_SERVICE_ROLE_KEY"] = ""
    # Two PRE-EXISTING holes in this denylist, closed here. Both flags send a chat
    # turn to a provider — AI_PROFILING_LLM_EVERY_TURN does it on EVERY turn — so a
    # developer .env setting either one flowed into every bare ``Settings()`` and
    # armed the rephrase branch under pytest. The master gate happens to save us
    # today, but this list's stated principle is "pin every setting that can arm an
    # outbound call", and P1-4 is the record of what relying on the next layer costs.
    os.environ["AI_PROFILING_REPHRASE_ENABLED"] = "false"
    os.environ["AI_PROFILING_LLM_EVERY_TURN"] = "false"
    # --- Generalized profiling (the LLM-driven chat path) -------------------
    # Same P1-4 discipline as SKILL_CANONICALIZE_ENABLED above: DOMAIN_MATCH_ENABLED
    # arms an outbound embed + a retrieval leg, so a developer .env that turns it on
    # would flow into every bare ``Settings()`` and make the finalization path try to
    # reach a real provider during pytest. Pin it off.
    os.environ["DOMAIN_MATCH_ENABLED"] = "false"
    # The match thresholds do not arm anything, but they decide WHICH branch the RAG
    # pass takes (the no-model auto-pick vs asking the model vs below-floor), and
    # test_domain_match asserts on all three. A developer .env that tuned them would
    # silently move those assertions onto a different code path.
    os.environ["DOMAIN_MATCH_TOP_K"] = "10"
    os.environ["DOMAIN_MATCH_FLOOR"] = "0.55"
    os.environ["DOMAIN_MATCH_AUTO_FLOOR"] = "0.88"
    os.environ["DOMAIN_MATCH_AUTO_MARGIN"] = "0.08"
    # Pin the routing/cost knobs to the committed defaults so tests that read them
    # are deterministic regardless of what a developer's .env tunes. These do not
    # arm a call by themselves, but they change WHICH model resolves and what the
    # worst-case cost check computes — both of which tests assert on.
    # MUST mirror the committed default (config.py `ai_chat_model_tier`), for the same reason
    # DEFAULT_CAPABLE_MODEL above must: a stale value here makes the whole suite resolve the chat
    # turn to a model prod does not use, which is the exact drift that once masked the extraction
    # pin. `pro` since #1237.
    os.environ["AI_CHAT_MODEL_TIER"] = "pro"
    os.environ["AI_CHAT_MAX_OUTPUT_TOKENS"] = "512"
    os.environ["AI_CHAT_TEMPERATURE"] = "0.3"
    os.environ["AI_CHAT_MAX_RETRIES"] = "1"
    os.environ["AI_EXTRACTION_MAX_OUTPUT_TOKENS"] = "1024"
    os.environ["AI_EXTRACTION_TEMPERATURE"] = "0.0"
    os.environ["AI_EXTRACTION_MAX_RETRIES"] = "2"
    os.environ["AI_RESUME_MAX_OUTPUT_TOKENS"] = "512"
    os.environ["AI_RESUME_TEMPERATURE"] = "0.4"
    os.environ["AI_RESUME_MAX_RETRIES"] = "1"
    # Interview bounds + the persona guard. A developer .env with a tiny turn cap
    # would end interviews early under test and read as a model failure.
    os.environ["PROFILING_MAX_TURNS"] = "30"
    os.environ["PROFILING_HISTORY_MAX_TURNS"] = "20"
    os.environ["PROFILING_PERSONA_GUARD_ENABLED"] = "true"
    os.environ["PROFILING_PERSONA_REPAIR_RETRIES"] = "1"
    # Gemini transport. GEMINI_API_BASE especially: a .env pointing at a proxy would
    # be a non-loopback host, and layer 2 would turn that into a confusing egress
    # failure rather than an obvious config one.
    os.environ["GEMINI_API_BASE"] = "https://generativelanguage.googleapis.com/v1beta/models"
    os.environ["GEMINI_TIMEOUT_SECONDS"] = "30.0"
    os.environ["GEMINI_MAX_RATE_LIMIT_RETRIES"] = "1"
    os.environ["GEMINI_MAX_BACKOFF_SECONDS"] = "20.0"
    # The CUMULATIVE ceiling, and the bound that actually matters: the per-sleep cap above
    # permitted retries * backoff = 80 s of sleep inside one request, against a parse
    # deadline of 6 s. Pinned here for the same reason as its neighbours — a developer .env
    # tuning it would silently change how many POSTs a retry test observes.
    os.environ["GEMINI_MAX_TOTAL_BACKOFF_SECONDS"] = "5.0"
    os.environ["GEMINI_BACKOFF_BASE"] = "2.0"
    os.environ["GEMINI_THINKING_BUDGET"] = "0"
    # The rate-limit cooldown window. Pinned so a .env cannot make a cross-request
    # cooldown test wait on a real clock, or disable the mechanism under test entirely.
    os.environ["AI_PROVIDER_COOLDOWN_SECONDS"] = "60.0"


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


# --- Layer 3: the service-auth bearer --------------------------------------


def _neutralize_service_auth() -> None:
    """Clear ``ai_internal_token`` on the shared settings singleton.

    The middleware reads ``get_settings().ai_internal_token`` PER REQUEST
    (``app/main.py``), so seeding the singleton here governs every TestClient call
    without touching ``env_file`` — which must stay live, or the AI-ENV-1 decoy and
    two-cwd proofs in ``test_config_env_anchor.py`` go vacuous (see module docstring).

    Deliberately narrow:
    - ``Settings()`` still reads the real dotenv, so a bare ``Settings()`` in the
      anchor tests resolves exactly as it does in production (they compare it via
      ``_redacted()``, which reduces the bearer to a set/unset boolean anyway).
    - Tests that WANT the gate armed build ``Settings(ai_internal_token=...)`` and
      swap the singleton themselves (``test_service_auth.py``'s ``auth_enabled``
      fixture), restoring it after — unaffected.
    - A no-op in CI, which has no dotenv and therefore no bearer to clear.
    """
    import app.config as app_config

    base = app_config.Settings()
    if base.ai_internal_token is not None:
        app_config._settings = base.model_copy(update={"ai_internal_token": None})


# Applied at import time — before any test constructs Settings() or a client.
_force_mock_only_env()
_install_egress_guard()
# Last: it constructs Settings(), so the env pinning above must already be in place.
_neutralize_service_auth()
