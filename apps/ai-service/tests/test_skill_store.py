"""HttpSkillStore + factory + /profile/extract wiring (ADR-0030 / FORK-B-1 seam A).

Zero network: httpx.Client is monkeypatched. Covers the deliberate failure postures —
search fails OPEN to UNRESOLVED (canonicalization never blocks extraction), record
swallows errors — and that only vector-assigned ids ever land in the profile (SG-3).
"""

from __future__ import annotations

import httpx

from app.ai import skill_store as ss
from app.ai.canonicalize import NullSkillStore
from app.ai.skill_store import HttpSkillStore, get_skill_store
from app.config import Settings


class _FakeResponse:
    def __init__(self, status_code: int, body: dict | None = None):
        self.status_code = status_code
        self._body = body or {}

    def json(self):
        return self._body


class _FakeClient:
    """Stands in for httpx.Client (shared per store instance) — records calls,
    returns a scripted response."""

    calls: list[tuple[str, dict]] = []
    response: _FakeResponse = _FakeResponse(200, {"candidates": []})
    raise_exc: Exception | None = None

    def __init__(self, *a, **k):
        pass

    def post(self, url, headers=None, json=None):
        _FakeClient.calls.append((url, {"headers": headers, "json": json}))
        if _FakeClient.raise_exc is not None:
            raise _FakeClient.raise_exc
        return _FakeClient.response


def _use_fake_client(monkeypatch, response=None, raise_exc=None):
    _FakeClient.calls = []
    _FakeClient.response = response or _FakeResponse(200, {"candidates": []})
    _FakeClient.raise_exc = raise_exc
    monkeypatch.setattr(ss.httpx, "Client", _FakeClient)


def _store() -> HttpSkillStore:
    return HttpSkillStore("http://api.internal:3001/", "test-token")


# --- factory ------------------------------------------------------------------
def test_factory_returns_null_store_unless_fully_configured():
    assert isinstance(get_skill_store(Settings()), NullSkillStore)
    assert isinstance(
        get_skill_store(Settings(backend_api_url="http://x")), NullSkillStore
    )  # token missing
    assert isinstance(
        get_skill_store(Settings(skills_internal_token="t")), NullSkillStore
    )  # url missing
    assert isinstance(
        get_skill_store(Settings(backend_api_url="http://x", skills_internal_token="t")),
        HttpSkillStore,
    )


# --- nearest_aliases ------------------------------------------------------------
def test_nearest_aliases_passes_token_and_parses_candidates(monkeypatch):
    _use_fake_client(
        monkeypatch,
        response=_FakeResponse(
            200,
            {
                "candidates": [
                    {"skill_id": "skill_vmc_operator", "score": 0.93},
                    {"skill_id": 42, "score": 0.9},  # malformed id -> dropped
                    {"skill_id": "skill_x", "score": "high"},  # malformed score -> dropped
                ]
            },
        ),
    )
    out = _store().nearest_aliases("cnc-machining", [0.1] * 768, 5)
    assert out == [("skill_vmc_operator", 0.93)]
    url, req = _FakeClient.calls[0]
    assert url == "http://api.internal:3001/internal/skills/nearest-aliases"
    # SCOPED token header (never the all-routes x-internal-service-token — #222 review).
    assert req["headers"]["x-skills-internal-token"] == "test-token"
    assert req["json"]["domain_id"] == "cnc-machining" and req["json"]["k"] == 5


def test_k_is_clamped_to_the_api_dto_bounds(monkeypatch):
    # A mis-set SKILL_CANONICALIZE_TOP_K (e.g. 50) must NOT become a silent 400 -> []
    # -> UNRESOLVED-everything: the store clamps k to the api contract (1..20).
    _use_fake_client(monkeypatch)
    _store().nearest_aliases("d", [0.1] * 768, 50)
    assert _FakeClient.calls[0][1]["json"]["k"] == 20
    _use_fake_client(monkeypatch)
    _store().nearest_aliases("d", [0.1] * 768, 0)
    assert _FakeClient.calls[0][1]["json"]["k"] == 1


def test_nearest_aliases_fails_open_to_unresolved_on_http_error(monkeypatch):
    _use_fake_client(monkeypatch, response=_FakeResponse(500))
    assert _store().nearest_aliases("d", [0.1] * 768, 5) == []


def test_nearest_aliases_fails_open_on_transport_exception(monkeypatch):
    _use_fake_client(monkeypatch, raise_exc=httpx.ConnectError("refused"))
    assert _store().nearest_aliases("d", [0.1] * 768, 5) == []  # never raises into extract


# --- record_unresolved -----------------------------------------------------------
def test_record_unresolved_posts_and_swallows_errors(monkeypatch):
    _use_fake_client(monkeypatch, response=_FakeResponse(204))
    _store().record_unresolved("[EMPLOYER_1] polish work", "cnc-machining", "en")
    url, req = _FakeClient.calls[0]
    assert url.endswith("/internal/skills/unresolved")
    assert req["json"]["phrase"] == "[EMPLOYER_1] polish work"  # already-pseudonymized text

    _use_fake_client(monkeypatch, raise_exc=httpx.ConnectError("down"))
    _store().record_unresolved("x", "d", "en")  # must not raise (lost row is acceptable)


# --- /profile/extract wiring (flag + store; SKILLS only, WS4 role backfill untouched) --
def test_extract_wiring_adds_vector_assigned_skill_ids(monkeypatch):
    from fastapi.testclient import TestClient

    from app import main as app_main

    class FakeStore:
        def nearest_aliases(self, domain_id, query_vector, k):
            return [("skill_program_editing", 0.95)]

        def record_unresolved(self, phrase, domain_id, lang):
            raise AssertionError("no miss expected in this test")

    enabled = Settings(skill_canonicalize_enabled=True)
    monkeypatch.setattr(app_main, "settings", enabled)
    monkeypatch.setattr(app_main, "get_skill_store", lambda s: FakeStore())

    client = TestClient(app_main.app)
    resp = client.post(
        "/profile/extract",
        json={"transcript": "I know cnc programming and setting"},
    )
    assert resp.status_code == 200
    body = resp.json()
    # SG-3: the assigned id came from the (fake) vector store's closed set…
    assert "skill_program_editing" in body["profile"]["skills"]
    # …and the raw LABELS were never written as ids.
    assert "program editing" not in body["profile"]["skills"]


def test_extract_wiring_inert_when_flag_off(monkeypatch):
    from fastapi.testclient import TestClient

    from app import main as app_main

    called: list[str] = []

    class SpyStore:
        def nearest_aliases(self, domain_id, query_vector, k):
            called.append(domain_id)
            return []

        def record_unresolved(self, phrase, domain_id, lang):
            called.append("record")

    monkeypatch.setattr(app_main, "settings", Settings())  # flag OFF (default)
    monkeypatch.setattr(app_main, "get_skill_store", lambda s: SpyStore())

    client = TestClient(app_main.app)
    resp = client.post(
        "/profile/extract", json={"transcript": "I know cnc programming and setting"}
    )
    assert resp.status_code == 200
    assert called == []  # default path: canonicalization never ran (status quo)


def test_extract_wiring_flag_on_but_store_unconfigured_is_inert(monkeypatch):
    # TD65 "the flag alone is inert": flag ON but seam NOT configured -> the factory
    # returns the NullSkillStore -> no network, no ids added, extraction unchanged.
    from fastapi.testclient import TestClient

    from app import main as app_main

    enabled = Settings(skill_canonicalize_enabled=True)  # url + token both unset
    monkeypatch.setattr(app_main, "settings", enabled)
    # NOTE: get_skill_store deliberately NOT patched — the real factory must pick Null.

    client = TestClient(app_main.app)
    resp = client.post(
        "/profile/extract", json={"transcript": "I know cnc programming and setting"}
    )
    assert resp.status_code == 200
    skills = resp.json()["profile"]["skills"]
    # Only gazetteer ids — nothing vector-assigned (the factory picked NullSkillStore).
    assert all(s.startswith("skill_") for s in skills)
