"""The canonicalization observability endpoint, and the local-canonicalization boot guard.

`GET /internal/observability/canonicalization` exists because the effective value of
`SKILL_CANONICALIZE_ENABLED` was previously unknowable without a shell on the box, and every
alternative route is unsound: `/health` omits it by design, `POST /skills/canonicalize`
returns an identical body whether the flag is off or nothing matched, and a compose default /
GitHub secret / env file are all INPUTS to the running value rather than the value.

The properties pinned here are the ones that make it trustworthy:
  * it reports the SAME boolean canonicalization acts on, not a second parsed copy,
  * it discloses no secret material,
  * it is gated by the EXISTING TD67 bearer, with no new auth and no exemption,
  * it reports both halves of the TD65 chain, because either half alone is inert.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.config as app_config
from app.ai.skill_store import (
    HttpSkillStore,
    NullSkillStore,
    get_skill_store,
    skill_store_configured,
)
from app.config import ConfigError, Settings
from app.main import app

ENDPOINT = "/internal/observability/canonicalization"
HEADER = "x-ai-internal-token"
TOKEN = "test-service-token-0123456789abcdef"
SEAM_TOKEN = "seam-token-0123456789abcdef"
SRC = Path(__file__).resolve().parents[1] / "app"


@pytest.fixture
def settings_as() -> Iterator[object]:
    """Swap the process-wide Settings, restore afterwards."""
    prior = app_config._settings

    def _apply(**kwargs: object) -> Settings:
        app_config._settings = Settings(**kwargs)  # type: ignore[arg-type]
        return app_config._settings

    try:
        yield _apply
    finally:
        app_config._settings = prior


def client() -> TestClient:
    """A client carrying the bearer WHENEVER the current settings demand one.

    Not a convenience: the ai-service anchors its env file to its own package, so a bare
    ``Settings()`` in a test still picks up a real ``AI_INTERNAL_TOKEN`` from the developer
    environment and the route correctly 401s. Tests about the PAYLOAD must not accidentally
    become tests about auth — the auth behaviour is pinned explicitly in
    :class:`TestAuthentication`, where the header is set (or withheld) deliberately.
    """
    token = app_config._settings.ai_internal_token if app_config._settings else None
    return TestClient(app, headers={HEADER: token} if token else None)


# ===========================================================================
class TestShape:
    def test_returns_200_with_exactly_the_three_declared_keys(self, settings_as):
        settings_as()
        body = client().get(ENDPOINT).json()
        assert set(body.keys()) == {"canonicalizationEnabled", "storeConfigured", "buildSha"}
        assert isinstance(body["canonicalizationEnabled"], bool)
        assert isinstance(body["storeConfigured"], bool)
        assert isinstance(body["buildSha"], str) and body["buildSha"]

    def test_build_sha_comes_from_THE_existing_build_id_source(self, settings_as):
        # Not a second source of truth: the same `Settings.build_id` /health reports, fed by
        # the GIT_COMMIT_SHA build arg. Unset must read "unknown", never empty or null —
        # that contract is shared with apps/api and apps/payer-web.
        s = settings_as(git_commit_sha="a1b2c3d")
        assert client().get(ENDPOINT).json()["buildSha"] == "a1b2c3d" == s.build_id
        settings_as(git_commit_sha="")
        assert client().get(ENDPOINT).json()["buildSha"] == "unknown"

    def test_agrees_with_health_on_the_build(self, settings_as):
        settings_as(git_commit_sha="deadbee")
        c = client()
        assert c.get(ENDPOINT).json()["buildSha"] == c.get("/health").json()["build"]


# ===========================================================================
class TestEffectiveConfiguration:
    """The endpoint must report what canonicalization ACTS on, not a copy that can drift."""

    @pytest.mark.parametrize("enabled", [True, False])
    def test_tracks_the_flag_in_both_directions(self, settings_as, enabled):
        s = settings_as(skill_canonicalize_enabled=enabled)
        body = client().get(ENDPOINT).json()
        assert body["canonicalizationEnabled"] is enabled is s.skill_canonicalize_enabled

    def test_reports_the_ATTRIBUTE_the_canonicalize_route_gates_on(self):
        # A behavioural test cannot catch this class of drift: the route returns the same
        # body either way, so a report reading a different attribute would look correct.
        # Pin the coupling at the source instead.
        route_src = (SRC / "routers" / "skills.py").read_text(encoding="utf8")
        assert "if not settings.skill_canonicalize_enabled:" in route_src
        health_src = (SRC / "routers" / "health.py").read_text(encoding="utf8")
        assert '"canonicalizationEnabled": current.skill_canonicalize_enabled,' in health_src
        # ...and both reach it through get_settings(), not a module-level snapshot.
        assert "current = get_settings()" in health_src

    @pytest.mark.parametrize(
        "kwargs,expected",
        [
            ({}, False),
            ({"backend_api_url": "http://api:3000"}, False),
            ({"skills_internal_token": SEAM_TOKEN}, False),
            ({"backend_api_url": "http://api:3000", "skills_internal_token": SEAM_TOKEN}, True),
        ],
    )
    def test_store_configured_matches_the_factory_exactly(self, settings_as, kwargs, expected):
        # THE POINT OF `skill_store_configured` BEING ONE FUNCTION. If this predicate and the
        # factory ever disagreed, the endpoint would report a live store while the
        # canonicalizer held the inert one.
        s = settings_as(**kwargs)
        body = client().get(ENDPOINT).json()
        assert body["storeConfigured"] is expected is skill_store_configured(s)
        assert isinstance(get_skill_store(s), NullSkillStore) is (not expected)

    @pytest.mark.parametrize("flag", [True, False])
    @pytest.mark.parametrize("seam", [True, False])
    def test_the_flag_and_the_STORE_are_INDEPENDENT_in_all_four_combinations(
        self, settings_as, flag, seam
    ):
        # THE FULL MATRIX, because the two are separate halves of the TD65 chain and the
        # endpoint must never let one imply the other. Audited 2026-08-27: production sits in
        # the (False, False) corner, and enabling the flag alone moves it to (True, False) —
        # armed and unable to resolve anything.
        wired = (
            {"backend_api_url": "http://api:3000", "skills_internal_token": SEAM_TOKEN}
            if seam
            else {}
        )
        settings_as(skill_canonicalize_enabled=flag, **wired)
        body = client().get(ENDPOINT).json()
        assert body["canonicalizationEnabled"] is flag
        assert body["storeConfigured"] is seam

    def test_the_flag_alone_does_NOT_mean_canonicalization_works(self, settings_as):
        # Why `storeConfigured` is not padding. TD65 is a CHAIN. With the seam unwired the
        # canonicalizer gets NullSkillStore, whose nearest_aliases returns [] — every phrase
        # is UNRESOLVED and nothing is recorded, while the embed is still paid for. An
        # operator seeing only `canonicalizationEnabled: true` would read a green light over
        # a dead path.
        s = settings_as(skill_canonicalize_enabled=True)
        body = client().get(ENDPOINT).json()
        assert body["canonicalizationEnabled"] is True
        assert body["storeConfigured"] is False
        assert isinstance(get_skill_store(s), NullSkillStore)
        assert NullSkillStore().nearest_aliases(None, [0.0], 5, job_domain_id="jd_x") == []


# ===========================================================================
class TestStoreSelectionMatrix:
    """The full 2x2x2: the flag and the seam are INDEPENDENT, and only the seam selects.

    `get_skill_store` must never consult `skill_canonicalize_enabled`. If it did, the two
    halves of the TD65 chain would collapse into one and "wire the seam" would become
    indistinguishable from "turn canonicalization on" — the exact conflation this activation
    programme exists to avoid.
    """

    @pytest.mark.parametrize("flag", [False, True])
    @pytest.mark.parametrize("url", [None, "http://api:3001"])
    @pytest.mark.parametrize("token", [None, SEAM_TOKEN])
    def test_only_the_seam_selects_the_store(self, settings_as, flag, url, token):
        kwargs = {"skill_canonicalize_enabled": flag}
        if url is not None:
            kwargs["backend_api_url"] = url
        if token is not None:
            kwargs["skills_internal_token"] = token
        s = settings_as(**kwargs)

        both = url is not None and token is not None
        assert skill_store_configured(s) is both
        assert isinstance(get_skill_store(s), HttpSkillStore if both else NullSkillStore)
        # ...and the flag is untouched by any of it, in both directions.
        assert s.skill_canonicalize_enabled is flag
        assert client().get(ENDPOINT).json() == {
            "canonicalizationEnabled": flag,
            "storeConfigured": both,
            "buildSha": s.build_id,
        }


# ===========================================================================
class TestEmptyMeansUnset:
    """#858, the Python half. A `${VAR:-}` pass-through hands the process "", not nothing."""

    @pytest.mark.parametrize("blank", ["", "   "])
    def test_an_empty_seam_variable_reads_as_UNSET(self, settings_as, blank):
        # A bridged-but-unarmed secret must mean "not configured", so the store stays inert
        # rather than half-constructing an HttpSkillStore against an empty base URL.
        s = settings_as(backend_api_url=blank, skills_internal_token=blank)
        assert s.backend_api_url is None
        assert s.skills_internal_token is None
        assert skill_store_configured(s) is False
        assert isinstance(get_skill_store(s), NullSkillStore)

    @pytest.mark.parametrize("blank", ["", "   "])
    def test_an_empty_AI_INTERNAL_TOKEN_disarms_rather_than_crashing_the_boot(self, blank):
        # THE CHANGE THAT LET TD67 REACH THE BOX AT ALL. `min_length=16` made "" a startup
        # failure, so the variable could not be declared as a compose pass-through and was
        # therefore absent entirely — leaving every route on the historical OPEN posture.
        assert Settings(ai_internal_token=blank).ai_internal_token is None

    @pytest.mark.parametrize("bad", ["short", "x" * 15])
    def test_a_SHORT_non_empty_token_STILL_fails_at_startup(self, bad):
        # The half that must not move. Only the empty string was reclassified; a short secret
        # is a real value that would arm a weak gate, and it still refuses to boot.
        with pytest.raises(ValidationError):
            Settings(ai_internal_token=bad)

    def test_a_VALID_token_still_arms_the_gate(self):
        assert Settings(ai_internal_token=TOKEN).ai_internal_token == TOKEN

    def test_the_gate_is_never_armed_VACUOUSLY(self, settings_as):
        # The TD67 review's HIGH, re-pinned against the new semantics. With "" the middleware
        # would have entered the enforcement branch, where `compare_digest(b"", b"")` passes
        # every TOKENLESS request while /health claimed auth was on and correctly-tokened
        # callers got 401. Mapping "" -> None REMOVES that state rather than permitting it:
        # the middleware short-circuits and /health reports the truth.
        settings_as(ai_internal_token="")
        c = TestClient(app)
        assert c.get("/health").json()["service_auth_enabled"] is False
        assert c.get(ENDPOINT).status_code == 200

# ===========================================================================
class TestAuthentication:
    """The EXISTING TD67 bearer. No new mechanism, and no exemption."""

    def test_missing_token_is_rejected(self, settings_as):
        settings_as(ai_internal_token=TOKEN)
        resp = TestClient(app).get(ENDPOINT)
        assert resp.status_code == 401
        assert resp.json() == {"detail": "unauthorized"}

    def test_invalid_token_is_rejected(self, settings_as):
        settings_as(ai_internal_token=TOKEN)
        resp = TestClient(app).get(ENDPOINT, headers={HEADER: "wrong-token-value-123456"})
        assert resp.status_code == 401

    def test_valid_token_succeeds(self, settings_as):
        settings_as(ai_internal_token=TOKEN)
        resp = TestClient(app).get(ENDPOINT, headers={HEADER: TOKEN})
        assert resp.status_code == 200
        assert "canonicalizationEnabled" in resp.json()

    def test_is_NOT_added_to_the_auth_exempt_set(self):
        # /health is exempt because a liveness probe cannot carry a bearer. This route has no
        # such excuse, and adding it to that set would silently publish config posture.
        from app.main import _AUTH_EXEMPT_PATHS

        assert ENDPOINT not in _AUTH_EXEMPT_PATHS
        assert _AUTH_EXEMPT_PATHS == frozenset({"/health"})


# ===========================================================================
class TestSecretNonDisclosure:
    def test_response_contains_no_secret_material_of_any_kind(self, settings_as):
        settings_as(
            ai_internal_token=TOKEN,
            skills_internal_token=SEAM_TOKEN,
            backend_api_url="http://api:3000",
            skill_canonicalize_enabled=True,
            gemini_flash_api_key="gemini-key-should-never-appear",
            langfuse_secret_key="sk-should-never-appear",
            git_commit_sha="a1b2c3d",
        )
        raw = TestClient(app).get(ENDPOINT, headers={HEADER: TOKEN}).text
        for forbidden in (
            TOKEN,
            SEAM_TOKEN,
            "gemini-key-should-never-appear",
            "sk-should-never-appear",
            "http://api:3000",
            "SKILL_CANONICALIZE_ENABLED",
            "DATABASE_URL",
            "postgres",
        ):
            assert forbidden not in raw, forbidden
        # The effective booleans ARE disclosed — that is the entire purpose.
        assert json.loads(raw) == {
            "canonicalizationEnabled": True,
            "storeConfigured": True,
            "buildSha": "a1b2c3d",
        }

    def test_reports_the_effective_boolean_not_the_raw_variable(self, settings_as):
        settings_as(skill_canonicalize_enabled=True)
        body = client().get(ENDPOINT).json()
        assert body["canonicalizationEnabled"] is True  # a bool, never the string "true"
        assert not isinstance(body["canonicalizationEnabled"], str)


# ===========================================================================
class TestReadOnly:
    def test_the_handler_touches_no_store_and_no_provider(self):
        src = (SRC / "routers" / "health.py").read_text(encoding="utf8")
        body = src.split("async def canonicalization_posture()")[1].split("@api_router")[0]
        # Strip the docstring: it DISCUSSES the seam by name (that is the explanation this
        # endpoint needs), and scanning prose for identifiers tests the wrong thing.
        handler = body.split('"""')[2] if body.count('"""') >= 2 else body
        for forbidden in (
            "get_skill_store",
            "record_unresolved",
            "nearest_aliases",
            "canonicalize_skill",
            "embed_text",
            "INSERT",
            "UPDATE",
            "DELETE",
            "httpx",
        ):
            assert forbidden not in handler, forbidden

    def test_repeated_calls_are_identical_and_change_nothing(self, settings_as):
        settings_as(skill_canonicalize_enabled=True, git_commit_sha="a1b2c3d")
        c = client()
        first = c.get(ENDPOINT).json()
        second = c.get(ENDPOINT).json()
        assert first == second
        assert app_config._settings.skill_canonicalize_enabled is True  # unchanged by reading


# ===========================================================================
class TestLocalCanonicalizationBootGuard:
    """Two signals plus a topology check — and it must never fire on the deployed service."""

    def test_flag_alone_boots(self):
        assert Settings(skill_canonicalize_enabled=True).skill_canonicalize_enabled is True

    def test_seam_alone_boots(self):
        s = Settings(backend_api_url="http://localhost:3000", skills_internal_token=SEAM_TOKEN)
        assert skill_store_configured(s) is True

    def test_BOTH_signals_at_a_loopback_api_REFUSE_to_boot(self):
        # The hazard: the flag was already true from an earlier experiment, someone wires the
        # seam at a local api, and that api reads DATABASE_URL from the root env file —
        # production. Canonicalization would arm itself silently and write outside every gate.
        for host in ("localhost", "127.0.0.1", "host.docker.internal", "0.0.0.0"):
            with pytest.raises(ConfigError) as err:
                Settings(
                    skill_canonicalize_enabled=True,
                    backend_api_url=f"http://{host}:3000",
                    skills_internal_token=SEAM_TOKEN,
                )
            assert "REFUSING TO BOOT" in str(err.value)
            assert "CANONICALIZE_ALLOW_LOCAL" in str(err.value)

    def test_the_refusal_never_echoes_the_token_or_the_url(self):
        with pytest.raises(ConfigError) as err:
            Settings(
                skill_canonicalize_enabled=True,
                backend_api_url="http://localhost:3000",
                skills_internal_token=SEAM_TOKEN,
            )
        message = str(err.value)
        assert SEAM_TOKEN not in message
        assert "http://localhost:3000" not in message
        # ConfigError, NOT ValueError — pydantic would wrap the latter into a ValidationError
        # that records the offending input verbatim.
        assert not isinstance(err.value, ValueError)

    def test_it_CANNOT_fire_on_the_deployed_topology(self):
        # THE ASSERTION THAT KEEPS THIS FROM BECOMING AN OUTAGE. Production reaches the api by
        # compose service name; a loopback backend_api_url is not a production topology. If
        # this ever fails, the guard has started blocking the activation it exists to protect.
        for url in ("http://api:3000", "http://badabhai-api:3000", "https://api.internal"):
            s = Settings(
                skill_canonicalize_enabled=True,
                backend_api_url=url,
                skills_internal_token=SEAM_TOKEN,
            )
            assert s.skill_canonicalize_enabled is True

    def test_an_explicit_acknowledgement_permits_it(self):
        s = Settings(
            skill_canonicalize_enabled=True,
            backend_api_url="http://localhost:3000",
            skills_internal_token=SEAM_TOKEN,
            canonicalize_allow_local="wiring the FORK-B-1 seam against a local db",
        )
        assert s.skill_canonicalize_enabled is True

    def test_whitespace_is_not_an_acknowledgement(self):
        with pytest.raises(ConfigError):
            Settings(
                skill_canonicalize_enabled=True,
                backend_api_url="http://localhost:3000",
                skills_internal_token=SEAM_TOKEN,
                canonicalize_allow_local="   ",
            )
