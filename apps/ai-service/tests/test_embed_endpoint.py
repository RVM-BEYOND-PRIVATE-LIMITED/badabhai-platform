"""POST /embeddings/skill-alias — the fork-B seam (ADR-0030 / TAX-3 runner endpoint).

The db-side runner (packages/db/src/embed-skill-aliases.ts, owner connection) POSTs alias
text batches; the ai-service embeds (pseudonymize-first, SG-2) and returns vectors — the
service stays DB-free. Mock by default (zero spend); real is SG-4-gated.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.ai import cost_tracker, embeddings
from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _fresh_inprocess_ledger():
    """TD68: the real-path tests now reach ``cost_tracker.get_ledger()``. Force a
    fresh, deterministic IN-PROCESS ledger (ignore any ambient REDIS_URL / .env —
    a dev box's unreachable Redis would fail-closed and flip these tests) and never
    leak state across tests. Same idiom as test_spend_cap.py."""
    from app.config import Settings

    cost_tracker._ledger = cost_tracker.SpendLedger(Settings(_env_file=None, redis_url=None))
    yield
    cost_tracker._ledger = None


class _FakeLedger:
    """TD68 spy standing in for the TD27 SpendLedger: records every reserve /
    reconcile the endpoint makes; optionally blocks the reserve."""

    def __init__(self, block_reason: str | None = None) -> None:
        self.block_reason = block_reason
        self.reserves: list[float] = []
        self.records: list[tuple[float, float]] = []

    async def would_exceed_spend(self, projected_inr, settings, *, user_ref=None):
        self.reserves.append(projected_inr)
        return self.block_reason

    async def record_spend(self, reserved_inr, actual_inr, *, user_ref=None):
        self.records.append((reserved_inr, actual_inr))


def _install_ledger(monkeypatch, block_reason: str | None = None) -> _FakeLedger:
    """Swap the process SpendLedger singleton for the spy (main.py resolves it via
    ``cost_tracker.get_ledger()`` per request)."""
    fake = _FakeLedger(block_reason)
    monkeypatch.setattr(cost_tracker, "get_ledger", lambda: fake)
    return fake


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


# --- TD68: the real path rides the TD27 SpendLedger -------------------------
def test_real_path_ledger_block_stops_batch_before_any_embed(monkeypatch):
    # TD68 (i): a SpendLedger block (daily/cumulative/global caps) must stop the REAL
    # batch BEFORE any provider call — budget_stopped=True, results=[] (rows stay
    # NULL; the runner resumes later), and nothing to reconcile.
    _force_real(monkeypatch)
    fake = _install_ledger(monkeypatch, block_reason="daily_cap_exceeded")
    embed_calls: list[str] = []
    monkeypatch.setattr(
        embeddings, "_real_embedding", lambda t, s: embed_calls.append(t) or [0.1] * 768
    )
    resp = client.post(
        "/embeddings/skill-alias",
        json={
            "items": [
                {"alias_id": "a1", "text": "cnc milling"},
                {"alias_id": "a2", "text": "surface grinding"},
            ]
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["budget_stopped"] is True
    assert body["results"] == []
    assert body["is_mock"] is False
    assert body["estimated_cost_inr"] == 0.0
    assert embed_calls == []  # blocked BEFORE any provider call
    # #238 F3 halving: full batch (2 items) blocked, then the 1-item prefix retried
    # and blocked too -> descending projections, then a full stop.
    assert len(fake.reserves) == 2
    assert fake.reserves[0] > fake.reserves[1] > 0
    assert fake.records == []  # a block reserves nothing -> nothing to reconcile


def test_real_path_success_records_actual_spend_on_ledger(monkeypatch):
    # TD68 (ii): a successful REAL batch reserves the projected cost, then reconciles
    # the SAME reservation to the ACTUAL accumulated estimate via record_spend.
    _force_real(monkeypatch)
    fake = _install_ledger(monkeypatch)
    monkeypatch.setattr(embeddings, "_real_embedding", lambda t, s: [0.1] * 768)
    resp = client.post(
        "/embeddings/skill-alias",
        json={"items": [{"alias_id": "a1", "text": "cnc milling machine operation"}]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_mock"] is False and body["budget_stopped"] is False
    assert len(fake.reserves) == 1
    assert len(fake.records) == 1
    reserved, actual = fake.records[0]
    assert reserved == pytest.approx(fake.reserves[0])  # the same reservation reconciled
    assert actual > 0  # the accumulated (unrounded) estimate was recorded
    assert actual == pytest.approx(body["estimated_cost_inr"], abs=1e-6)


def test_real_path_ledger_block_halves_to_the_affordable_prefix(monkeypatch):
    # #238 F3: when the FULL batch's reserve blocks but a smaller prefix fits, the
    # endpoint embeds the affordable prefix and returns PARTIAL results with
    # budget_stopped=True (the runner resumes the omitted suffix) — instead of
    # starving fixed-size runner batches until UTC midnight.
    _force_real(monkeypatch)

    class _CapLedger(_FakeLedger):
        """Blocks any reserve whose projection exceeds the cap (headroom model)."""

        def __init__(self, cap_inr: float) -> None:
            super().__init__()
            self.cap_inr = cap_inr

        async def would_exceed_spend(self, projected_inr, settings, *, user_ref=None):
            self.reserves.append(projected_inr)
            return "daily_cap_exceeded" if projected_inr > self.cap_inr else None

    # 4 x 1-token items at Rs 0.0125/1k tokens: full batch projects 5e-05 INR;
    # the cap admits exactly the 2-item half (2.5e-05).
    fake = _CapLedger(cap_inr=3e-05)
    monkeypatch.setattr(cost_tracker, "get_ledger", lambda: fake)
    monkeypatch.setattr(embeddings, "_real_embedding", lambda t, s: [0.1] * 768)
    items = [{"alias_id": f"a{i}", "text": "milling"} for i in range(4)]
    resp = client.post("/embeddings/skill-alias", json={"items": items})
    assert resp.status_code == 200
    body = resp.json()
    assert body["budget_stopped"] is True  # partial => the runner resumes the rest
    assert [r["alias_id"] for r in body["results"]] == ["a0", "a1"]  # affordable prefix
    assert body["estimated_cost_inr"] > 0
    assert len(fake.reserves) == 2  # full blocked, half accepted
    assert len(fake.records) == 1
    reserved, actual = fake.records[0]
    assert reserved == pytest.approx(fake.reserves[-1])  # the ACCEPTED half reconciled
    assert actual > 0


def test_mock_path_never_touches_the_ledger(monkeypatch):
    # TD68 (iii): the mock (default) path makes ZERO ledger traffic — no reserve, no
    # record — exactly the pre-TD68 behavior.
    fake = _install_ledger(monkeypatch)
    resp = client.post(
        "/embeddings/skill-alias",
        json={"items": [{"alias_id": "a1", "text": "milling"}]},
    )
    assert resp.status_code == 200
    assert resp.json()["is_mock"] is True
    assert fake.reserves == [] and fake.records == []


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
