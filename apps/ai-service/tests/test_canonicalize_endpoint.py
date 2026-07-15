"""POST /skills/canonicalize — the TAX-6 shared-id-space seam (job side).

Proves: (1) the flag gates the endpoint (off → UNRESOLVED, inert); (2) a matched phrase
returns ONLY a store-assigned id (SG-3); (3) the WORKER path and the JOB path produce
the SAME skill_id for the same phrase — the ADR-0028/0030 one-id-space promise — because
both run the SAME canonicalize_skill over the SAME store.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app import main as app_main
from app.ai.canonicalize import canonicalize_skill
from app.config import Settings

client = TestClient(app_main.app)


class OneHitStore:
    def nearest_aliases(self, domain_id, query_vector, k):
        if domain_id == "cnc-machining":
            return [("skill_turning", 0.95)]
        return []

    def record_unresolved(self, phrase, domain_id, lang):
        pass


def test_flag_off_is_inert_unresolved(monkeypatch):
    monkeypatch.setattr(app_main, "get_settings", lambda: Settings())  # flag OFF default
    resp = client.post(
        "/skills/canonicalize",
        json={"phrase": "lathe operation", "domain_id": "cnc-machining"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "unresolved" and body["skill_id"] is None


def test_matched_id_comes_only_from_the_store(monkeypatch):
    enabled = Settings(skill_canonicalize_enabled=True)
    monkeypatch.setattr(app_main, "get_settings", lambda: enabled)
    monkeypatch.setattr(app_main, "get_skill_store", lambda s: OneHitStore())

    resp = client.post(
        "/skills/canonicalize",
        json={"phrase": "lathe operation", "domain_id": "cnc-machining"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "matched"
    assert body["skill_id"] == "skill_turning"  # the store's closed set — never invented
    assert body["score"] >= Settings().skill_canonicalize_floor

    # Wrong domain -> the store returns nothing -> UNRESOLVED (domain scoping holds).
    resp2 = client.post(
        "/skills/canonicalize",
        json={"phrase": "lathe operation", "domain_id": "welding"},
    )
    assert resp2.json()["status"] == "unresolved"


def test_worker_and_job_paths_share_one_id_space(monkeypatch):
    """The shared-id proof (TAX-6 acceptance): the WORKER side calls canonicalize_skill
    directly (via canonicalize_labels in extract); the JOB side reaches it through this
    endpoint. Same phrase + same store ⇒ the SAME skill_id on both sides."""
    enabled = Settings(skill_canonicalize_enabled=True)
    store = OneHitStore()

    # Worker-side result (direct library call — what the extract wiring runs).
    worker_side = canonicalize_skill("lathe operation", "cnc-machining", store, enabled)

    # Job-side result (the HTTP seam the api uses at posting create/update).
    monkeypatch.setattr(app_main, "get_settings", lambda: enabled)
    monkeypatch.setattr(app_main, "get_skill_store", lambda s: store)
    job_side = client.post(
        "/skills/canonicalize",
        json={"phrase": "lathe operation", "domain_id": "cnc-machining"},
    ).json()

    assert worker_side.status == "matched" and job_side["status"] == "matched"
    assert worker_side.skill_id == job_side["skill_id"] == "skill_turning"
