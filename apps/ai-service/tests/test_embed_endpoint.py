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
    body = resp.json()
    assert body["is_mock"] is True
    assert body["budget_stopped"] is False and body["errors"] == 0
    assert called == []  # SG-4: default settings -> mock path only, no provider call


def _force_real(monkeypatch):
    """Make the endpoint's get_settings() return REAL-enabled settings (module-level
    monkeypatch — the endpoint resolves settings per request)."""
    from app import main as app_main
    from app.config import Settings

    real = Settings(ai_enable_real_calls=True, gemini_flash_api_key="test-key")
    monkeypatch.setattr(app_main, "get_settings", lambda: real)
    return real


def test_real_budget_ceiling_stops_batch_with_partial_results(monkeypatch):
    # TD64 interim guard ON THE ENDPOINT PATH (the one the runner actually hits): with a
    # tiny per-request ceiling the batch stops early, returns the paid embeds, omits the
    # rest (rows stay NULL -> a later run resumes), and reports budget_stopped.
    real = _force_real(monkeypatch)
    real.ai_max_call_cost_inr = 0.0000001  # below one 3-token embed's cost
    monkeypatch.setattr(embeddings, "_real_embedding", lambda t, s: [0.1] * 768)

    items = [{"alias_id": f"a{i}", "text": f"skill number {i}"} for i in range(5)]
    resp = client.post("/embeddings/skill-alias", json={"items": items})
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_mock"] is False
    assert body["budget_stopped"] is True
    assert len(body["results"]) == 1  # stopped right after the first paid embed
    assert body["estimated_cost_inr"] > 0  # unrounded accumulation (not zeroed)


def test_real_per_item_failure_skips_item_keeps_paid_embeds(monkeypatch):
    # One provider failure must NOT 500 the request / discard already-paid embeds: the
    # failing item is omitted (counted in errors) and the batch continues.
    _force_real(monkeypatch)

    def flaky(text, settings):
        if "boom" in text:
            raise RuntimeError("skill_embedding provider HTTP 503")
        return [0.2] * 768

    monkeypatch.setattr(embeddings, "_real_embedding", flaky)
    resp = client.post(
        "/embeddings/skill-alias",
        json={
            "items": [
                {"alias_id": "ok1", "text": "milling"},
                {"alias_id": "bad", "text": "boom lathe"},
                {"alias_id": "ok2", "text": "grinding"},
            ]
        },
    )
    assert resp.status_code == 200  # NOT 500
    body = resp.json()
    assert body["errors"] == 1
    ids = [r["alias_id"] for r in body["results"]]
    assert ids == ["ok1", "ok2"]  # failing item omitted; both paid embeds kept
