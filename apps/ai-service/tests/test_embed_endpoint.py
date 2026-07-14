"""POST /embeddings/skill-alias — the fork-B seam (ADR-0030 / TAX-3 runner endpoint).

The db-side runner (packages/db/src/embed-skill-aliases.ts, owner connection) POSTs alias
text batches; the ai-service embeds (pseudonymize-first, SG-2) and returns vectors — the
service stays DB-free. Mock by default (zero spend); real is SG-4-gated.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.ai import embeddings
from app.main import app

client = TestClient(app)


def test_mock_batch_returns_768_dim_vector_per_item():
    resp = client.post(
        "/embeddings/skill-alias",
        json={
            "items": [
                {"alias_id": "a1", "text": "CNC milling"},
                {"alias_id": "a2", "text": "TIG welding"},
            ]
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_mock"] is True and body["model"] == "mock-embedding"
    assert [r["alias_id"] for r in body["results"]] == ["a1", "a2"]
    for r in body["results"]:
        assert r["blocked"] is False
        assert r["vector"] is not None and len(r["vector"]) == 768
    # Deterministic mock: same text -> same vector across calls (idempotent re-runs).
    again = client.post(
        "/embeddings/skill-alias",
        json={"items": [{"alias_id": "a1", "text": "CNC milling"}]},
    ).json()
    assert again["results"][0]["vector"] == body["results"][0]["vector"]


def test_blocked_item_returns_null_vector_others_still_embed():
    # An 8-digit run trips the fail-closed residual-digits rule -> blocked, no vector.
    resp = client.post(
        "/embeddings/skill-alias",
        json={
            "items": [
                {"alias_id": "ok", "text": "surface grinding"},
                {"alias_id": "bad", "text": "ref 12345678"},
            ]
        },
    )
    assert resp.status_code == 200
    by_id = {r["alias_id"]: r for r in resp.json()["results"]}
    assert by_id["ok"]["blocked"] is False and by_id["ok"]["vector"] is not None
    assert by_id["bad"]["blocked"] is True and by_id["bad"]["vector"] is None


def test_batch_cap_enforced():
    items = [{"alias_id": f"a{i}", "text": "milling"} for i in range(201)]
    resp = client.post("/embeddings/skill-alias", json={"items": items})
    assert resp.status_code == 422  # over the 200-item contract cap


def test_real_provider_never_called_by_default(monkeypatch):
    called: list[str] = []
    monkeypatch.setattr(
        embeddings, "_real_embedding", lambda t, s: called.append(t) or [0.0] * 768
    )
    resp = client.post(
        "/embeddings/skill-alias",
        json={"items": [{"alias_id": "a1", "text": "vmc operator"}]},
    )
    assert resp.status_code == 200
    assert resp.json()["is_mock"] is True
    assert called == []  # SG-4: default settings -> mock path only, no provider call
