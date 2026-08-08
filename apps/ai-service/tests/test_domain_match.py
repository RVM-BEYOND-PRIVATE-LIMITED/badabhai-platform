"""The RAG job-domain match: retrieve → the model picks → code re-validates.

WHAT THESE TESTS ARE ACTUALLY DEFENDING. Not "does it match" — that is the easy half and
a vector search does it. The hard half is everything the pass must REFUSE to do: never
invent an id, never accept one it did not retrieve, never guess when the shortlist is
noise, and never let any of those failures take an extraction down with it. A worker with
no domain is described less precisely; a worker with the WRONG domain is described
falsely, and every test below draws that line somewhere.
"""

from __future__ import annotations

import pytest

from app.ai.embeddings import EmbeddingResult
from app.config import Settings
from app.profiling import domain_match as dm

# ---------------------------------------------------------------------------
# Doubles
# ---------------------------------------------------------------------------


class FakeStore:
    def __init__(self, candidates: list[dm.DomainCandidate]):
        self._candidates = candidates
        self.calls: list[int] = []

    def nearest_domains(self, query_vector: list[float], k: int) -> list[dm.DomainCandidate]:
        self.calls.append(k)
        return self._candidates[:k]


class FakeRouter:
    """Stands in for AIRouter. Records what it was asked and returns a canned answer."""

    def __init__(self, reply: str = '{"job_domain_id": null, "confidence": 0.0}'):
        self.reply = reply
        self.messages: list[list[dict[str, str]]] = []

    async def run(self, task_type, *, messages, mock_response, **_kw):
        self.messages.append(messages)
        return self.reply, type("Meta", (), {"real_call": False})()


def ok_embed(_text: str, _settings: Settings) -> EmbeddingResult:
    return EmbeddingResult(
        vector=[0.1] * 768, blocked=False, is_mock=True, model="mock-embedding", text="masked"
    )


def blocked_embed(_text: str, _settings: Settings) -> EmbeddingResult:
    return EmbeddingResult(
        vector=None, blocked=True, is_mock=True, model="mock-embedding", text=None
    )


def settings(**over) -> Settings:
    base = {
        "domain_match_enabled": True,
        "domain_match_top_k": 10,
        "domain_match_floor": 0.55,
        "domain_match_auto_floor": 0.88,
        "domain_match_auto_margin": 0.08,
    }
    base.update(over)
    return Settings(**base)


def cands(*pairs: tuple[str, float]) -> list[dm.DomainCandidate]:
    return [dm.DomainCandidate(did, did.replace("_", " ").title(), score) for did, score in pairs]


async def match(
    store,
    router,
    *,
    embed=ok_embed,
    query="lathe operator",
    pinned_job_domain_id=None,
    **over,
):
    # `pinned_job_domain_id` is named EXPLICITLY rather than swept into `**over`, which
    # goes to `settings()`: a pin passed through the settings kwargs would raise a
    # validation error rather than reach the code under test.
    return await dm.match_domain(
        query,
        store=store,
        settings=settings(**over),
        router=router,
        embed=embed,
        pinned_job_domain_id=pinned_job_domain_id,
    )


# ---------------------------------------------------------------------------
# The query
# ---------------------------------------------------------------------------


class TestQueryText:
    def test_it_leads_with_the_trade_then_machines_then_skills(self):
        q = dm.build_query_text(
            trade="VMC Operator", machines=["VMC", "CNC Lathe"], skills=["tool offset setting"]
        )
        assert q == "VMC Operator, VMC, CNC Lathe, tool offset setting"

    def test_it_works_with_NO_trade_at_all(self):
        # Common, and the reason skills are in the query: "main setting karta hun,
        # drawing padh leta hun" is a job description with no job title in it.
        q = dm.build_query_text(trade=None, skills=["setting", "drawing reading"])
        assert q == "setting, drawing reading"

    def test_it_dedupes_case_insensitively(self):
        # "VMC" as both the trade word and a machine should not be weighted twice.
        q = dm.build_query_text(trade="VMC", machines=["vmc", "VMC "], skills=["milling"])
        assert q == "VMC, milling"

    def test_it_is_EMPTY_when_nothing_trade_shaped_was_extracted(self):
        assert dm.build_query_text(trade=None, skills=[], machines=[]) == ""

    def test_it_is_bounded(self):
        q = dm.build_query_text(trade="t", skills=[f"skill {i}" for i in range(50)])
        assert len(q.split(", ")) <= 12
        assert len(q) <= 400


# ---------------------------------------------------------------------------
# The three ways a match can legitimately happen or not happen
# ---------------------------------------------------------------------------


@pytest.mark.anyio
class TestMatching:
    async def test_a_clear_winner_is_taken_WITHOUT_calling_the_model(self):
        # 0.95 vs 0.60: there is nothing to weigh. Deterministic, free, reproducible.
        router = FakeRouter()
        res = await match(FakeStore(cands(("lathe_operator", 0.95), ("fitter", 0.60))), router)
        assert res.status == dm.MATCHED_AUTO
        assert res.job_domain_id == "lathe_operator"
        assert router.messages == []

    async def test_a_NEAR_TIE_is_now_UNMATCHED_and_no_model_is_asked(self):
        # 0.90 vs 0.89 is exactly the case a score-only rule gets wrong most confidently:
        # "Lathe Operator" and "Lathe Maintenance Fitter" are different jobs.
        #
        # THIS USED TO GO TO THE MODEL. The LLM pick is deleted (OIE Phase 8), and the
        # ambiguity it existed to resolve is now settled DURING the interview — by showing
        # the worker the candidates and recording which one they tap. This path only runs
        # for a session with no answer map, so refusing to guess is the correct trade: an
        # honest "unmatched" beats a confident coin flip between two different jobs.
        router = FakeRouter()
        near_tie = FakeStore(cands(("lathe_operator", 0.90), ("lathe_fitter", 0.89)))
        res = await match(near_tie, router)
        assert res.status == dm.UNMATCHED_LLM_DECLINED
        assert res.job_domain_id is None
        assert router.messages == []

    async def test_a_PINNED_occupation_short_circuits_retrieval_entirely(self):
        # The interview already placed this worker, deterministically, from their own
        # words. No embed, no ANN probe, no rupee -- and no second opinion.
        store, router = FakeStore(cands(("a", 0.99))), FakeRouter()
        res = await match(store, router, pinned_job_domain_id="jd_nco_7531_0100")
        assert res.status == dm.MATCHED_AUTO
        assert res.job_domain_id == "jd_nco_7531_0100"
        assert store.calls == [] and router.messages == []
        # NO FABRICATED SCORE. No retrieval ran, so there is no retrieval similarity --
        # writing 1.0 here would pollute the column the floors are tuned against.
        assert res.score is None

    async def test_the_shortlist_is_recorded_for_observability(self):
        router = FakeRouter()
        res = await match(FakeStore(cands(("a", 0.80), ("b", 0.79), ("c", 0.70))), router)
        assert res.considered == ["a", "b", "c"]


# ---------------------------------------------------------------------------
# Everything it must refuse to do
# ---------------------------------------------------------------------------


@pytest.mark.anyio
class TestRefusals:
    async def test_BELOW_THE_FLOOR_nothing_is_matched(self):
        # If the best alias in the whole catalog is this far away, the shortlist is noise.
        router = FakeRouter()
        res = await match(FakeStore(cands(("lathe_operator", 0.31), ("fitter", 0.30))), router)
        assert res.status == dm.UNMATCHED_BELOW_FLOOR
        assert res.job_domain_id is None

    async def test_NOTHING_reaches_the_router_on_ANY_path(self):
        # THE STRUCTURAL ASSERTION, and the one worth keeping over the five it replaced.
        # Five tests here used to describe how a model's pick was validated -- hallucinated
        # ids rejected, real-but-not-retrieved ids rejected the same way, an explicit null
        # honoured, unreadable output treated as a decline, fenced JSON still read. Every
        # one of them tested code that no longer exists. What replaces them is the property
        # that makes all five moot: this module never calls a model again, on any input, so
        # there is no pick left to validate.
        for shortlist in (
            cands(("lathe_operator", 0.95), ("fitter", 0.60)),        # clear winner
            cands(("lathe_operator", 0.90), ("lathe_fitter", 0.89)),  # near tie
            cands(("lathe_operator", 0.31), ("fitter", 0.30)),        # below floor
            cands(),                                                  # nothing retrieved
        ):
            router = FakeRouter()
            await match(FakeStore(shortlist), router)
            assert router.messages == []


# ---------------------------------------------------------------------------
# Degradation: a classification must never cost a worker their profile
# ---------------------------------------------------------------------------


@pytest.mark.anyio
class TestDegradation:
    async def test_the_flag_off_short_circuits_before_any_work(self):
        store, router = FakeStore(cands(("a", 0.99))), FakeRouter()
        res = await match(store, router, domain_match_enabled=False)
        assert res.status == dm.UNMATCHED_DEGRADED
        assert store.calls == [] and router.messages == []

    async def test_an_EMPTY_query_does_not_spend_an_embed_call(self):
        store = FakeStore(cands(("a", 0.99)))
        res = await match(store, FakeRouter(), query="   ")
        assert res.status == dm.UNMATCHED_DEGRADED
        assert store.calls == []

    async def test_a_BLOCKED_pseudonymization_fails_closed_and_never_retrieves(self):
        # SG-2. A blocked query still holds whatever residual PII blocked it, so it must
        # not be embedded — and must not be retried in the clear either.
        store = FakeStore(cands(("a", 0.99)))
        res = await match(store, FakeRouter(), embed=blocked_embed)
        assert res.status == dm.UNMATCHED_DEGRADED
        assert store.calls == []

    async def test_an_EMPTY_shortlist_is_degraded_not_matched(self):
        res = await match(FakeStore([]), FakeRouter())
        assert res.status == dm.UNMATCHED_DEGRADED
        assert res.job_domain_id is None

    async def test_a_DOWN_retrieval_seam_returns_an_empty_shortlist_rather_than_raising(self):
        # The store owns its own failure: a transport error becomes `[]`, which
        # match_domain then reads as "nothing retrieved" → UNMATCHED_DEGRADED. Failing
        # OPEN here is correct because the consequence is a missing label, not a wrong
        # one — the opposite posture from the pseudonymize gate above it.
        store = dm.HttpDomainStore("http://127.0.0.1:1", "token")
        assert store.nearest_domains([0.1] * 768, 5) == []
        res = await match(store, FakeRouter())
        assert res.status == dm.UNMATCHED_DEGRADED

    async def test_the_top_k_from_config_reaches_the_store(self):
        store = FakeStore(cands(("a", 0.99), ("b", 0.5)))
        await match(store, FakeRouter(), domain_match_top_k=3)
        assert store.calls == [3]


# ---------------------------------------------------------------------------
# The status vocabulary is a CONTRACT with the database
# ---------------------------------------------------------------------------


def test_every_status_matches_the_worker_profiles_CHECK_constraint():
    # These five strings are duplicated in packages/db/src/schema/worker.ts as the
    # `job_domain_match_status` CHECK. A value invented here would be rejected at write
    # time, at the end of a long async pipeline, for one worker at a time.
    assert {
        dm.MATCHED_AUTO,
        dm.MATCHED_LLM,
        dm.UNMATCHED_BELOW_FLOOR,
        dm.UNMATCHED_LLM_DECLINED,
        dm.UNMATCHED_DEGRADED,
    } == {
        "matched_auto",
        "matched_llm",
        "unmatched_below_floor",
        "unmatched_llm_declined",
        "unmatched_degraded",
    }

def test_the_store_factory_is_inert_until_the_seam_is_fully_configured():
    # A half-configured deployment must degrade to "no domain", never error.
    assert isinstance(dm.get_domain_store(settings()), dm.NullDomainStore)
    wired = settings(backend_api_url="http://api:3000", skills_internal_token="t" * 16)
    assert isinstance(dm.get_domain_store(wired), dm.HttpDomainStore)


# ---------------------------------------------------------------------------
# The endpoint wiring. The pure function is covered above; this is the JOIN —
# /profile/extract with the flag ON, which conftest pins OFF for every other test.
# ---------------------------------------------------------------------------


@pytest.mark.anyio
class TestExtractEndpointWiring:
    """DOMAIN_MATCH_ENABLED is false for the whole suite (conftest), so without
    these the entire main.py -> domain_match join ships unexercised."""

    def _client(self, monkeypatch, *, store, router=None, embed=ok_embed):
        from fastapi.testclient import TestClient

        from app import main
        from app.routers import profile as profile_router

        # POST /profile/extract now lives in app.routers.profile and resolves
        # `settings` / `get_domain_store` / `embed_text` / `router` from THAT module's
        # globals, so the seams have to be patched there rather than on app.main.
        # (`get_settings` is deliberately not patched: the extract handler never reads
        # it — only app.main's service-auth middleware does.)
        enabled = profile_router.settings.model_copy(update={"domain_match_enabled": True})
        monkeypatch.setattr(profile_router, "settings", enabled)
        monkeypatch.setattr(profile_router, "get_domain_store", lambda _s: store)
        monkeypatch.setattr(profile_router, "embed_text", embed)
        if router is not None:
            monkeypatch.setattr(profile_router, "router", router)
        return TestClient(main.app)

    async def test_a_match_reaches_the_response(self, monkeypatch):
        store = FakeStore(cands(("isco_7223", 0.95), ("isco_7233", 0.40)))
        client = self._client(monkeypatch, store=store)
        res = client.post(
            "/profile/extract",
            json={"transcript": "I run a VMC, 5 years experience, Fanuc controller"},
        )
        assert res.status_code == 200
        match = res.json()["job_domain_match"]
        # The clear-winner shortcut, so no model was needed.
        assert match["status"] == dm.MATCHED_AUTO
        assert match["job_domain_id"] == "isco_7223"

    async def test_the_query_is_built_from_PHRASES_not_taxonomy_ids(self, monkeypatch):
        # The retrieval embeds the worker's own words. If the legacy id arrays were used
        # instead, every worker would embed strings like "skill_milling" and match
        # nothing — a failure that looks like a bad catalog rather than a bad query.
        seen: dict[str, str] = {}

        def spy_embed(text, settings):
            seen["text"] = text
            return ok_embed(text, settings)

        store = FakeStore(cands(("isco_7223", 0.95)))
        client = self._client(monkeypatch, store=store, embed=spy_embed)
        client.post(
            "/profile/extract",
            json={"transcript": "I run a VMC machine and a CNC lathe, 5 years"},
        )
        assert "text" in seen
        assert "skill_" not in seen["text"]
        assert "mach_" not in seen["text"]
        assert "role_" not in seen["text"]

    async def test_a_store_that_RAISES_yields_unmatched_and_a_200(self, monkeypatch):
        # The broad except in main.py. A classification that failed must cost the worker
        # a label, never their extracted profile.
        class ExplodingStore:
            def nearest_domains(self, *_a, **_k):
                raise RuntimeError("boom")

        client = self._client(monkeypatch, store=ExplodingStore())
        res = client.post("/profile/extract", json={"transcript": "I run a VMC"})
        assert res.status_code == 200
        assert res.json()["job_domain_match"]["status"] == dm.UNMATCHED_DEGRADED
        # …and the profile itself still came back.
        assert res.json()["profile"] is not None

    async def test_the_flag_OFF_leaves_the_field_null_rather_than_degraded(self, monkeypatch):
        # NULL means "the pass did not run". Recording "degraded" would make a disabled
        # feature indistinguishable from a workforce the catalog cannot describe.
        from fastapi.testclient import TestClient

        from app import main

        res = TestClient(main.app).post("/profile/extract", json={"transcript": "I run a VMC"})
        assert res.status_code == 200
        assert res.json()["job_domain_match"] is None
