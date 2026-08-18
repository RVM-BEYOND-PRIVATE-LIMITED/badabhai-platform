"""#965 — /health must say WHICH BUILD is answering, and must never fail saying it.

Before this, every service's /health answered "am I up?" and nothing else, so a deploy
that had silently not rolled forward looked identical to one that had — and hours went
into debugging code that was not running. The build id is knowable at IMAGE BUILD time
(the deploy pins immutable ghcr images tagged ``sha-<short7>``); it just was not
surfaced anywhere at runtime.

THE CONTRACT, shared verbatim with apps/api and apps/payer-web:
  - the Dockerfile takes ``ARG GIT_COMMIT_SHA`` and promotes it to ``ENV`` so it
    survives into the running container,
  - the service adds ``"build"`` to its EXISTING /health JSON,
  - the value is the short sha, or the literal string ``"unknown"`` when unset.
    NEVER omitted, NEVER null — a consumer must always be able to read it.

THE FAILURE THIS FILE EXISTS TO PREVENT is the second half of that contract, not the
first. A GitHub Actions ``build-args:`` line referencing a variable that does not exist
resolves to the EMPTY STRING, and Docker injects a declared ARG into the build
environment PRESENT-AND-EMPTY rather than absent — which is exactly how the payer-web
build broke on main on 2026-08-18 (a zod schema rejected ""). This service's settings
layer has a long history of failing CLOSED on config problems (``ai_internal_token``'s
min_length, ``ai_spend_redis_url``'s scheme check), and applying that reflex here would
turn a missing observability label into an OUTAGE: no boot, or a 500 on the one endpoint
the deploy's health gate and the container HEALTHCHECK both poll. This field fails OPEN,
and these tests pin that it does.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.main as app_main
from app.config import Settings
from app.routers import health as health_router

AI_SERVICE_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture
def health_settings(monkeypatch):
    """Serve /health from an explicit Settings, whatever the ambient env holds.

    Returns a callable taking a ready-made ``Settings``. Both ``get_settings`` and the
    module-global ``settings`` snapshot are patched in ``app.routers.health`` (the
    handler reads both) and in ``app.main`` (its service-auth middleware resolves
    ``get_settings`` from there), mirroring the existing locked-posture test in
    test_config_env_anchor.py. Deliberately NOT reliant on os.environ: a developer box
    or a CI runner that happens to export GIT_COMMIT_SHA must not change the outcome.
    """

    def _serve(settings: Settings) -> TestClient:
        monkeypatch.setattr(health_router, "settings", settings)
        monkeypatch.setattr(health_router, "get_settings", lambda: settings)
        monkeypatch.setattr(app_main, "settings", settings)
        monkeypatch.setattr(app_main, "get_settings", lambda: settings)
        return TestClient(app_main.app)

    return _serve


# --- 1. the key is always there, in every posture -----------------------------


def test_health_reports_the_injected_build(health_settings):
    """The whole point: /health names the commit the container was built from."""
    body = health_settings(Settings(_env_file=None, git_commit_sha="a1b2c3d")).get("/health").json()
    assert body["build"] == "a1b2c3d"
    # PURELY ADDITIVE — the pre-existing fields and status code are untouched.
    assert body["status"] == "ok"
    assert body["service"] == "ai-service"
    assert body["real_calls_enabled"] is False


def test_health_reports_the_build_under_the_locked_posture_too(health_settings):
    """TD67 trims /health to liveness + the auth boolean when AI_INTERNAL_TOKEN is set.
    ``build`` survives that trim: the posture a deploy is debugged in is usually this
    one, and a commit sha is already public in the image tag — it is not the provider/
    spend recon data the trimmed branch exists to withhold."""
    locked = Settings(_env_file=None, ai_internal_token="x" * 16, git_commit_sha="deadbee")
    body = health_settings(locked).get("/health").json()
    assert body["build"] == "deadbee"
    assert body["service_auth_enabled"] is True
    assert "spend" not in body  # the trim still holds


# --- 2. unset / empty -> "unknown", never an error ----------------------------


@pytest.mark.parametrize(
    ("raw", "why"),
    [
        ("", "the Docker trap: a build-args line for a nonexistent var yields ''"),
        ("   ", "a whitespace-only value is the same accident with a stray space"),
        ("\n", "a value captured from a command substitution that returned nothing"),
    ],
)
def test_empty_build_arg_yields_unknown_not_an_error(health_settings, raw, why):
    """EMPTY IS EQUIVALENT TO UNSET, and neither is an error — the #965 hard rule.

    An ARG is not inert: Docker puts every declared ARG into the build environment, so
    an unresolved ``build-args:`` reference arrives as PRESENT-AND-EMPTY. Every one of
    these must read "unknown" with a 200, not raise, not 500, not omit the key.
    """
    res = health_settings(Settings(_env_file=None, git_commit_sha=raw)).get("/health")
    assert res.status_code == 200, why
    assert res.json()["build"] == "unknown", why


def test_unset_build_arg_yields_unknown(health_settings):
    """No build arg at all — the local `docker build` and `uvicorn` paths."""
    res = health_settings(Settings(_env_file=None)).get("/health")
    assert res.status_code == 200
    assert res.json()["build"] == "unknown"


def test_the_build_key_is_never_omitted_and_never_null(health_settings):
    """The consumer-facing half of the contract, stated as a property.

    apps/api, apps/payer-web and this service all answer the same question the same way,
    so the reader is written once and must not need a ``if "build" in body`` branch or a
    null check. Asserted over the full matrix of postures x values.
    """
    for token in (None, "x" * 16):
        for sha in ("", "   ", "a1b2c3d", None):
            kwargs = {} if sha is None else {"git_commit_sha": sha}
            settings = Settings(_env_file=None, ai_internal_token=token, **kwargs)
            body = health_settings(settings).get("/health").json()
            assert "build" in body, (token, sha)
            assert isinstance(body["build"], str), (token, sha)
            assert body["build"] != "", (token, sha)


# --- 3. the settings layer must not fail closed on this one field -------------


def test_settings_never_fails_to_construct_for_any_build_value():
    """STARTUP MUST NOT DEPEND ON THIS FIELD.

    Every other misconfigurable setting in config.py rejects bad input at ``Settings()``
    — deliberately, because arming a half-configured GATE is worse than not booting.
    This field gates nothing, so the same reflex would only convert a missing label into
    a service that will not start. No validator, no min_length, no shape check.
    """
    for value in ("", "   ", "a1b2c3d", "sha-a1b2c3d", "\x00", "x" * 5000, "not a sha at all"):
        assert Settings(_env_file=None, git_commit_sha=value) is not None


def test_build_id_never_raises_for_any_input():
    """``build_id`` is total: every input maps to a non-empty string, none raise.

    Includes values no sane build would produce — control characters, newlines, a
    5 KB string, JSON-ish text. /health is polled by the container HEALTHCHECK and by
    the deploy's health gate; an exception here would read as an unhealthy container
    and roll back a perfectly good deploy over a label.
    """
    hostile = [
        "",
        " ",
        "\t\n",
        "\x00\x01",
        "x" * 5000,
        '{"not": "a sha"}',
        "sha-a1b2c3d",
        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",  # a full 40-char sha
        "v1.2.3+build.4",
        "../../etc/passwd",
        "<script>alert(1)</script>",
        "Ramesh Kumar 9876543210",  # nothing but a sha may ever land in /health
    ]
    for value in hostile:
        result = Settings(_env_file=None, git_commit_sha=value).build_id
        assert isinstance(result, str)
        assert result != ""


def test_implausible_values_degrade_to_unknown_rather_than_being_echoed():
    """/health is a PUBLIC, unauthenticated surface (it is the one path exempt from the
    TD67 bearer), so it publishes what we injected or nothing at all. A value that is
    not shaped like a build id was not produced by our build, and echoing it verbatim
    would make an unauthenticated endpoint into a reflector."""
    for value in ("Ramesh Kumar 9876543210", '{"not": "a sha"}', "<script>", "a b c", "x" * 200):
        assert Settings(_env_file=None, git_commit_sha=value).build_id == "unknown"

    # ...while every shape a real build produces is preserved EXACTLY.
    for value in ("a1b2c3d", "sha-a1b2c3d", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", "v1.2.3"):
        assert Settings(_env_file=None, git_commit_sha=value).build_id == value


# --- 4. the env var name, and the Dockerfile that has to set it ---------------


def test_the_setting_reads_the_git_commit_sha_env_var(monkeypatch):
    """The name is load-bearing: the Dockerfile's ENV and this field must agree, and
    nothing else connects them. ``_env_file=None`` so a developer dotenv cannot mask it.
    """
    monkeypatch.setenv("GIT_COMMIT_SHA", "beefc0d")
    assert Settings(_env_file=None).build_id == "beefc0d"

    # And the empty case travels the same path: env var SET but empty -> "unknown".
    monkeypatch.setenv("GIT_COMMIT_SHA", "")
    assert Settings(_env_file=None).build_id == "unknown"

    monkeypatch.delenv("GIT_COMMIT_SHA")
    assert Settings(_env_file=None).build_id == "unknown"


def test_dockerfile_declares_the_arg_and_promotes_it_to_env():
    """A build arg that is never promoted to ENV evaporates when the build ends.

    Static, because the alternative is building the image in CI. The two lines are the
    entire supply chain for this value — the container has no .git and the service is
    forbidden from shelling out to git — so losing either one silently reverts /health
    to reporting "unknown" forever, which looks exactly like a correctly-behaving
    service that simply was not given a sha.
    """
    dockerfile = (AI_SERVICE_DIR / "Dockerfile").read_text(encoding="utf-8")
    lines = [line.strip() for line in dockerfile.splitlines()]
    assert 'ARG GIT_COMMIT_SHA=""' in lines, "the ARG must default to EMPTY, never be absent"
    assert "ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA" in lines, "an unpromoted ARG never reaches runtime"
    # The ARG must be declared before it is consumed, and both after the FROM (an ARG
    # above FROM belongs to no build stage and would expand to nothing here).
    assert lines.index("FROM python:3.12-slim-bookworm") < lines.index('ARG GIT_COMMIT_SHA=""')
    assert lines.index('ARG GIT_COMMIT_SHA=""') < lines.index("ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA")
