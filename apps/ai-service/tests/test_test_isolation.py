"""P1-4: the suite CANNOT make a real outbound call — regardless of local dotenv.

THE DEFECT: ``tests/conftest.py`` neutralized AI_ENABLE_REAL_CALLS, the provider
keys and AI_SPEND_REDIS_URL, but NOT ``SKILL_CANONICALIZE_ENABLED``. A developer
`.env` setting it true flowed into every bare ``Settings()``, so /profile/extract
entered the TAX-4 canonicalization branch during pytest and — in the tests that
legitimately construct REAL-mode settings — made an actual outbound HTTPS call to
the Gemini embeddings endpoint. Two tests failed on the owner's box for this
reason, on origin/main, with no branch involved.

A denylist of flags cannot be the whole answer (the next flag will be forgotten
too), so this file locks BOTH layers: the flag pin AND the socket-level guard
that makes egress impossible either way.
"""

from __future__ import annotations

import socket

import pytest
from conftest import OutboundNetworkBlocked

from app.config import Settings


# --- Layer 1: the flags that can arm an outbound call ----------------------
def test_bare_settings_never_arm_a_real_call():
    """A bare ``Settings()`` — what most tests and the app module itself build —
    must be fully inert whatever the developer's `.env` says."""
    settings = Settings()
    assert settings.ai_enable_real_calls is False
    assert not settings.gemini_flash_api_key
    assert not settings.anthropic_api_key
    assert not settings.sarvam_api_key
    # The P1-4 hole itself: the flag that reached the embeddings endpoint.
    assert settings.skill_canonicalize_enabled is False, (
        "SKILL_CANONICALIZE_ENABLED leaked in from a local .env — /profile/extract "
        "will make a real embeddings call during pytest"
    )
    assert not settings.backend_api_url
    assert not settings.skills_internal_token
    assert settings.langfuse_enabled is False
    assert not settings.ai_spend_redis_url


def test_real_mode_settings_still_do_not_enable_canonicalization():
    """The exact shape that broke: a test builds REAL-mode settings on purpose
    (spying on the LLM transport). Every field it does NOT name must still come
    back inert — otherwise an unrelated flag rides along and calls a provider."""
    settings = Settings(ai_enable_real_calls=True, gemini_flash_api_key="test-key")
    assert settings.skill_canonicalize_enabled is False
    # Note WHY this mattered: with real mode on, the embedding TASK is enabled —
    # so the canonicalize flag was the only thing standing between pytest and a
    # live provider call, and a dotenv could flip it. Hence layer 2.
    assert settings.real_call_enabled_for("skill_embedding") is True


# --- Layer 2: the socket-level backstop ------------------------------------
def test_outbound_connections_are_blocked():
    """The guard that makes "no real calls" a property rather than a promise.
    203.0.113.0/24 is RFC-5737 TEST-NET-3: never routed, so this asserts the
    REFUSAL, and no packet leaves the machine either way."""
    with pytest.raises(OutboundNetworkBlocked):
        socket.create_connection(("203.0.113.7", 443), timeout=0.5)

    with pytest.raises(OutboundNetworkBlocked):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.connect(("203.0.113.7", 443))
        finally:
            sock.close()


def test_a_provider_hostname_is_blocked():
    """The specific egress this defect produced: the Gemini embeddings endpoint."""
    with pytest.raises(OutboundNetworkBlocked):
        socket.create_connection(("generativelanguage.googleapis.com", 443), timeout=0.5)


def test_loopback_is_still_allowed():
    """The guard must not break the suites that drive a local URL (the eval CLI
    against http://localhost:9999) — those are refused by the OS, not by us."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.2)
    try:
        # Not asserting success (nothing is listening) — asserting that the GUARD
        # is not what stops it: a connection error is fine, OutboundNetworkBlocked
        # is not.
        sock.connect_ex(("127.0.0.1", 9))
    except OutboundNetworkBlocked:  # pragma: no cover - the failure we're excluding
        pytest.fail("the egress guard must not block loopback")
    except OSError:
        pass
    finally:
        sock.close()


def test_the_real_embedding_path_cannot_reach_the_provider():
    """End-to-end: even with real-mode settings and a key, the embeddings client
    cannot leave the box. Pre-guard this made a live HTTPS request."""
    from app.ai import embeddings

    settings = Settings(
        ai_enable_real_calls=True,
        gemini_flash_api_key="test-key",
        ai_real_call_tasks="skill_embedding",
    )
    assert settings.real_call_enabled_for("skill_embedding") is True
    with pytest.raises(Exception) as excinfo:
        embeddings.embed_text("vmc operator", settings)
    # httpx wraps the socket failure in ConnectError; the guard's message survives.
    assert "must not open network connections" in str(excinfo.value) or isinstance(
        excinfo.value, OutboundNetworkBlocked
    )
