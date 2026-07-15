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

import app.config as app_config
from app.config import Settings
from app.main import app

TOKEN = "test-service-token-0123456789abcdef"
HEADER = "x-ai-internal-token"


@pytest.fixture
def auth_enabled() -> Iterator[None]:
    """Point the module-global settings at a token-bearing Settings, restore after."""
    prior = app_config._settings
    app_config._settings = Settings(ai_internal_token=TOKEN)
    try:
        yield
    finally:
        app_config._settings = prior


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

    def test_openapi_and_docs_are_gated_too(self, auth_enabled):
        client = TestClient(app)
        assert client.get("/openapi.json").status_code == 401
        assert client.get("/docs").status_code == 401

    def test_every_post_route_is_gated(self, auth_enabled):
        """No route can silently opt out: every POST path in the app 401s tokenless."""
        client = TestClient(app)
        post_paths = [
            route.path
            for route in app.routes
            if getattr(route, "methods", None) and "POST" in route.methods
        ]
        assert len(post_paths) >= 8  # the service's POST surface (sanity floor)
        for path in post_paths:
            resp = client.post(path, json={})
            assert resp.status_code == 401, f"{path} not gated"
