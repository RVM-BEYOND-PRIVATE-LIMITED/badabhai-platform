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
from app.routers import skills as skills_router

client = TestClient(app_main.app)


class OneHitStore:
    def nearest_aliases(self, domain_id, query_vector, k):
        if domain_id == "cnc-machining":
            return [("skill_turning", 0.95)]
        return []

    def record_unresolved(self, phrase, domain_id, lang):
        pass


def test_flag_off_is_inert_unresolved(monkeypatch):
    # flag OFF default
    monkeypatch.setattr(skills_router, "get_settings", lambda: Settings(_env_file=None))
    resp = client.post(
        "/skills/canonicalize",
        json={"phrase": "lathe operation", "domain_id": "cnc-machining"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "unresolved" and body["skill_id"] is None


def test_matched_id_comes_only_from_the_store(monkeypatch):
    enabled = Settings(_env_file=None, skill_canonicalize_enabled=True)
    monkeypatch.setattr(skills_router, "get_settings", lambda: enabled)
    monkeypatch.setattr(skills_router, "get_skill_store", lambda s: OneHitStore())

    resp = client.post(
        "/skills/canonicalize",
        json={"phrase": "lathe operation", "domain_id": "cnc-machining"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "matched"
    assert body["skill_id"] == "skill_turning"  # the store's closed set — never invented
    assert body["score"] >= Settings(_env_file=None).skill_canonicalize_floor

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
    enabled = Settings(_env_file=None, skill_canonicalize_enabled=True)
    store = OneHitStore()

    # Worker-side result (direct library call — what the extract wiring runs).
    worker_side = canonicalize_skill("lathe operation", "cnc-machining", store, enabled)

    # Job-side result (the HTTP seam the api uses at posting create/update).
    monkeypatch.setattr(skills_router, "get_settings", lambda: enabled)
    monkeypatch.setattr(skills_router, "get_skill_store", lambda s: store)
    job_side = client.post(
        "/skills/canonicalize",
        json={"phrase": "lathe operation", "domain_id": "cnc-machining"},
    ).json()

    assert worker_side.status == "matched" and job_side["status"] == "matched"
    assert worker_side.skill_id == job_side["skill_id"] == "skill_turning"


# --- TD68: the REAL embed path rides the TD27 SpendLedger --------------------
class _FakeLedger:
    def __init__(self, block_reason=None):
        self.block_reason = block_reason
        self.reserves: list[float] = []
        self.records: list[tuple[float, float]] = []

    async def would_exceed_spend(self, projected_inr, settings, *, user_ref=None):
        self.reserves.append(projected_inr)
        return self.block_reason

    async def record_spend(self, reserved_inr, actual_inr, *, user_ref=None):
        self.records.append((reserved_inr, actual_inr))


def _install_ledger(monkeypatch, block_reason=None):
    from app.ai import cost_tracker

    fake = _FakeLedger(block_reason)
    monkeypatch.setattr(cost_tracker, "get_ledger", lambda: fake)
    return fake


def test_real_embed_ledger_block_returns_unresolved_without_embedding(monkeypatch):
    # TD68: a SpendLedger block on the REAL embed path returns UNRESOLVED (the caller
    # is NEVER blocked — same posture as every other failure) BEFORE any provider call.
    from app.ai import embeddings

    enabled = Settings(
        _env_file=None,
        skill_canonicalize_enabled=True,
        ai_enable_real_calls=True,
        gemini_flash_api_key="k",
        ai_real_call_tasks="skill_embedding",
    )
    monkeypatch.setattr(skills_router, "get_settings", lambda: enabled)
    monkeypatch.setattr(skills_router, "get_skill_store", lambda s: OneHitStore())
    fake = _install_ledger(monkeypatch, block_reason="cumulative_cap_exceeded")
    embed_calls: list[str] = []
    monkeypatch.setattr(
        embeddings, "_real_embedding", lambda t, s: embed_calls.append(t) or [0.1] * 768
    )

    resp = client.post(
        "/skills/canonicalize",
        json={"phrase": "lathe operation", "domain_id": "cnc-machining"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "unresolved"
    assert embed_calls == []  # blocked BEFORE the provider
    assert len(fake.reserves) == 1 and fake.reserves[0] > 0
    assert fake.records == []  # a block reserves nothing -> nothing to reconcile


def test_mock_embed_path_never_touches_the_ledger(monkeypatch):
    # TD68: mock embeds (real_call_enabled_for false) make ZERO ledger traffic.
    # no real flag/key -> mock embed
    enabled = Settings(_env_file=None, skill_canonicalize_enabled=True)
    monkeypatch.setattr(skills_router, "get_settings", lambda: enabled)
    monkeypatch.setattr(skills_router, "get_skill_store", lambda s: OneHitStore())
    fake = _install_ledger(monkeypatch)

    resp = client.post(
        "/skills/canonicalize",
        json={"phrase": "lathe operation", "domain_id": "cnc-machining"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "matched"
    assert fake.reserves == [] and fake.records == []


# --- #745: the embed's cost record rides home on the response ----------------
#
# ROOT CAUSE THIS CLOSES (the same one #738 fixed for STT): the response contract carried
# no cost field, so no emitter could exist in apps/api even if someone wrote one, and
# `SELECT ... WHERE task_type = 'skill_embedding'` came back empty — which reads as
# "no spend" rather than "not instrumented". `AiCostRecorder` swallows emit failures by
# design, so nothing anywhere raised. Only asserting on the field can catch it.


def test_matched_response_carries_the_embed_cost_record(monkeypatch):
    enabled = Settings(_env_file=None, skill_canonicalize_enabled=True)
    monkeypatch.setattr(skills_router, "get_settings", lambda: enabled)
    monkeypatch.setattr(skills_router, "get_skill_store", lambda s: OneHitStore())

    body = client.post(
        "/skills/canonicalize",
        json={"phrase": "lathe operation", "domain_id": "cnc-machining"},
    ).json()

    meta = body["ai_metadata"]
    assert meta is not None, "the embed is a billable call and must report one"
    assert meta["task_type"] == "skill_embedding"
    assert meta["ai_call_id"]  # the identity `ai.cost_recorded` is keyed on
    # MOCK RUN => NO MONEY. `real_call` follows the money, not the intent, so a mocked
    # environment records Rs 0 rather than the fiction TD81 used to write into staging.
    assert meta["real_call"] is False
    assert meta["estimated_cost_inr"] == 0.0


def test_an_unresolved_phrase_still_reports_its_cost(monkeypatch):
    """A miss costs the same embed as a hit.

    Recording only the matches would under-count exactly the phrases the vocabulary is
    worst at — which are the ones that justify growing it (TAX-5).
    """
    enabled = Settings(_env_file=None, skill_canonicalize_enabled=True)
    monkeypatch.setattr(skills_router, "get_settings", lambda: enabled)
    monkeypatch.setattr(skills_router, "get_skill_store", lambda s: OneHitStore())

    body = client.post(
        "/skills/canonicalize",
        json={"phrase": "lathe operation", "domain_id": "some-other-domain"},
    ).json()

    assert body["status"] == "unresolved"
    assert body["ai_metadata"] is not None
    assert body["ai_metadata"]["task_type"] == "skill_embedding"


def test_flag_off_reports_no_cost_at_all(monkeypatch):
    """No provider was reached, so there is nothing to record.

    An absent record is the honest answer; a synthesized zero-cost one would put a call
    that never happened onto the cost spine.
    """
    monkeypatch.setattr(skills_router, "get_settings", lambda: Settings(_env_file=None))
    body = client.post(
        "/skills/canonicalize",
        json={"phrase": "lathe operation", "domain_id": "cnc-machining"},
    ).json()
    assert body["status"] == "unresolved"
    assert body["ai_metadata"] is None


def test_a_pseudonymize_block_reports_no_cost(monkeypatch):
    """The gate refused BEFORE the provider — distinct from a mock, which ran the pipeline."""
    from app.ai import canonicalize as canon_mod
    from app.ai.embeddings import EmbeddingResult

    enabled = Settings(_env_file=None, skill_canonicalize_enabled=True)
    monkeypatch.setattr(skills_router, "get_settings", lambda: enabled)
    monkeypatch.setattr(skills_router, "get_skill_store", lambda s: OneHitStore())
    monkeypatch.setattr(
        canon_mod,
        "embed_text",
        lambda text, settings: EmbeddingResult(
            vector=None, blocked=True, is_mock=True, model="mock", text=None
        ),
    )

    body = client.post(
        "/skills/canonicalize",
        json={"phrase": "call me on 9876543210", "domain_id": "cnc-machining"},
    ).json()
    assert body["status"] == "unresolved"
    assert body["ai_metadata"] is None
