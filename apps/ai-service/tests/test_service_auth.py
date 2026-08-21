"""TD67 service-level auth tests (`pytest -k auth`).

ONE bearer for every ai-service route, /health exempt. Locked properties:
- token UNSET (default) → open posture, byte-for-byte today's behavior,
- token SET → 401 without/with-wrong header on ALL routes (incl. /openapi.json),
  200 with the exact header; /health stays open and reports the boolean only,
- the 401 body never echoes anything (no token material, no header names).
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.config as app_config
from app.config import Settings
from app.main import app

TOKEN = "test-service-token-0123456789abcdef"
HEADER = "x-ai-internal-token"


def _served_paths_with_method(router: object, method: str) -> set[str]:
    """Every path the app actually SERVES for ``method``, including undocumented ones.

    ``include_router`` does not flatten its routes into ``app.routes`` on this FastAPI
    (0.140.x): it leaves a wrapper object whose own ``.path`` / ``.methods`` are absent,
    so a flat filter finds nothing. Recurse through the wrapper to the router it holds.

    Written defensively against the wrapper's private shape — it is an internal, and the
    attribute name has changed across releases. If a future upgrade renames BOTH probes,
    this returns fewer paths and the exact-count assertion in the caller fails loudly,
    which is the correct outcome: a route enumeration that silently finds nothing is the
    failure this helper exists to prevent.
    """
    found: set[str] = set()
    for route in getattr(router, "routes", []):
        methods = getattr(route, "methods", None)
        path = getattr(route, "path", None)
        if methods and path and method in methods:
            found.add(path)
            continue
        # An include_router wrapper: descend into the router it carries.
        inner = getattr(route, "original_router", None) or getattr(route, "app", None)
        if inner is not None and hasattr(inner, "routes"):
            found |= _served_paths_with_method(inner, method)
    return found


@pytest.fixture
def auth_enabled() -> Iterator[None]:
    """Point the module-global settings at a token-bearing Settings, restore after."""
    prior = app_config._settings
    app_config._settings = Settings(ai_internal_token=TOKEN)
    try:
        yield
    finally:
        app_config._settings = prior


class TestServiceAuthConfig:
    def test_empty_token_fails_at_startup_never_arms_vacuously(self):
        """The review's HIGH: AI_INTERNAL_TOKEN="" would enter the enforcement branch
        where compare_digest(b"", b"") passes every TOKENLESS request (open!) while
        401ing correctly-tokened callers and /health claims auth is on. min_length=16
        makes an empty/short value fail Settings() at STARTUP instead."""
        with pytest.raises(ValidationError):
            Settings(ai_internal_token="")
        with pytest.raises(ValidationError):
            Settings(ai_internal_token="short-token")
        assert Settings(ai_internal_token=None).ai_internal_token is None
        assert Settings(ai_internal_token=TOKEN).ai_internal_token == TOKEN


class TestServiceAuthDisabled:
    def test_default_posture_is_open(self):
        client = TestClient(app)
        resp = client.post("/pseudonymize", json={"text": "I run a VMC"})
        assert resp.status_code == 200

    def test_health_reports_auth_disabled(self):
        client = TestClient(app)
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["service_auth_enabled"] is False


class TestServiceAuthEnabled:
    def test_missing_header_is_401(self, auth_enabled):
        client = TestClient(app)
        resp = client.post("/pseudonymize", json={"text": "I run a VMC"})
        assert resp.status_code == 401
        assert resp.json() == {"detail": "unauthorized"}  # nothing echoed

    def test_wrong_token_is_401(self, auth_enabled):
        client = TestClient(app)
        resp = client.post(
            "/pseudonymize", json={"text": "x"}, headers={HEADER: "wrong-token-value-123456"}
        )
        assert resp.status_code == 401

    def test_correct_token_passes(self, auth_enabled):
        client = TestClient(app)
        resp = client.post("/pseudonymize", json={"text": "I run a VMC"}, headers={HEADER: TOKEN})
        assert resp.status_code == 200

    def test_health_stays_open_and_reports_enabled(self, auth_enabled):
        client = TestClient(app)
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["service_auth_enabled"] is True

    def test_locked_health_is_liveness_plus_boolean_only(self, auth_enabled):
        """Under the locked posture the tokenless /health must NOT leak spend/caps/
        provider posture (recon data on a shared network — the review's /health finding).
        The full snapshot stays on the token-gated /ai/spend.

        ``build`` is the ONE addition to this set (#965) and it is deliberate: a commit
        sha is already public in the ghcr image tag, so it is not the recon data this
        branch exists to withhold, and "which build is this box running?" must be
        answerable in EVERY posture — the posture the deploy is being debugged in is
        usually the locked one. Nothing else may join this set without the same argument.
        """
        client = TestClient(app)
        body = client.get("/health").json()
        assert set(body.keys()) == {"status", "service", "service_auth_enabled", "build"}
        assert isinstance(body["build"], str) and body["build"]
        # And the gated route serves the full view WITH the token:
        assert client.get("/ai/spend", headers={HEADER: TOKEN}).status_code == 200
        assert client.get("/ai/spend").status_code == 401

    def test_openapi_and_docs_are_gated_too(self, auth_enabled):
        client = TestClient(app)
        assert client.get("/openapi.json").status_code == 401
        assert client.get("/docs").status_code == 401

    def test_every_post_route_is_gated(self, auth_enabled):
        """No route can silently opt out: every POST path the app SERVES 401s tokenless.

        Enumerated by walking the real route tree, which since the handlers moved into
        ``app/routers/*.py`` requires recursing THROUGH the ``include_router`` wrappers:
        ``app.routes`` holds opaque objects with no ``.path`` / ``.methods``, so a flat
        filter over it silently yields ZERO paths — the floor below was the only thing
        standing between that and a vacuous pass.

        Deliberately NOT enumerated from ``app.openapi()``. The OpenAPI document is the
        DOCUMENTED surface, not the SERVED one: ``include_in_schema=False`` routes are
        absent from it, and this app already serves four of them (``/docs``,
        ``/openapi.json``, ``/docs/oauth2-redirect``, ``/redoc``). A route added with
        ``include_in_schema=False`` and quietly added to ``_AUTH_EXEMPT_PATHS`` would
        therefore be INVISIBLE to an OpenAPI-based check while serving traffic tokenless
        — which is the exact failure mode this test exists to prevent.
        """
        client = TestClient(app)
        post_paths = sorted(_served_paths_with_method(app.router, "POST"))
        # Pinned to the ACTUAL SET, not just a count. A count alone cannot tell "two routes
        # were deliberately retired" from "two routes were accidentally unregistered and two
        # others appeared" — and this test's whole job is noticing an unintended change to
        # what the service serves.
        #
        # 13 -> 11 at the OIE Phase 8 cutover, which DELETED `app/routers/profiling.py` and
        # with it POST /profiling/opening and POST /profiling/respond. That is the cutover:
        # the interview is now a deterministic state machine in apps/api and the LLM is
        # called once, at the end, through /profile/parse. Two fewer LLM-driven entry points
        # is the point, not a regression.
        #
        # 11 -> 13 with the LLM-led interview: POST /profiling/turn (one Phase A question) and
        # POST /profiling/extract (the whole-chat extraction). The Phase 8 cutover deleted
        # /profiling/opening and /profiling/respond and this is NOT their restoration — the old
        # pair let a model run the interview and hold the state; these hold none, and the API
        # bounds every turn. Both carry worker text, so both must be gated exactly like the rest.
        assert post_paths == [
            "/embeddings/skill-alias",
            "/growth/cluster",
            "/job-posting-chat/opening",
            "/job-posting-chat/respond",
            "/profile/extract",
            "/profile/parse",
            "/profiling/extract",
            "/profiling/turn",
            "/pseudonymize",
            "/resume/generate",
            "/skills/canonicalize",
            "/skills/retag-plan",
            "/voice/transcribe",
        ], f"POST surface changed: {post_paths}"
        for path in post_paths:
            resp = client.post(path, json={})
            assert resp.status_code == 401, f"{path} not gated"
