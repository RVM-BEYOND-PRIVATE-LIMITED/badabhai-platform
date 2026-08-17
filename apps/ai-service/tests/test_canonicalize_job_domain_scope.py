"""Phase 1.5 canonicalizer cutover — the CANONICAL `job_domain_id` scope (ai-service half).

WHAT THIS FILE EXISTS TO CATCH. Migration 0076 made `job_domain_skill(job_domain_id,
skill_id, status)` authoritative and demoted `skill_alias.domain_id` to nullable legacy
metadata. The canonicalizer resolved candidates ONLY through that legacy column, so a
canonical skill minted with no slug was INVISIBLE to it — every phrase for it came back
UNRESOLVED, silently, with a paid embed and a growth-queue row to show for it. Nothing
raised; the vocabulary just looked empty. `test_a_skill_with_a_null_legacy_domain_*` is
that regression, and it fails on the pre-cutover code.

FOUR PROPERTIES ARE LOAD-BEARING HERE:
1. The canonical scope reaches a skill whose legacy domain is NULL (the cutover itself).
2. The legacy scope is BYTE-IDENTICAL — same positional store call, no new kwarg, so a
   pre-Phase-1.5 store implementation keeps working untouched.
3. NO SCOPE IS A REFUSAL, NEVER A WILDCARD. "no domain" must never widen into "search the
   whole vocabulary" — a cook would be offered lathe skills. Refused at the contract, and
   again inside `canonicalize_skill` before a single embed is spent.
4. Every existing safety posture survives: fail-soft store, SG-1 (only pseudonymized text
   is recorded), SG-2 (a blocked phrase is never embedded and never recorded), SG-3 (an id
   only ever comes from what the vector search returned).
"""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import main as app_main
from app.ai import canonicalize as canon_mod
from app.ai import embeddings
from app.ai import skill_store as ss
from app.ai.canonicalize import canonicalize_labels, canonicalize_skill
from app.ai.embeddings import EmbeddingResult, embed_text
from app.ai.skill_store import HttpSkillStore
from app.config import Settings
from app.contracts import SkillCanonicalizationInput, exactly_one_skill_scope
from app.pseudonymize import PseudonymizationResult
from app.routers import skills as skills_router

LEGACY_DOMAIN = "cnc-machining"
JOB_DOMAIN = "jd_welding"
OTHER_JOB_DOMAIN = "jd_cnc_machining"


def _settings(**over) -> Settings:
    # Real calls OFF -> the deterministic mock embedder (same text => same vector,
    # cosine == 1.0). Zero spend, zero network.
    return Settings(_env_file=None, **over)


def _vec(text: str) -> list[float]:
    res = embed_text(text, _settings())
    assert res.vector is not None
    return res.vector


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


# --- the fakes --------------------------------------------------------------
class TaxonomyStore:
    """Models the POST-0076 schema, which is the only way to test the cutover honestly:
    `skill_alias` rows carry a NULLABLE legacy `domain_id`, and the authoritative
    domain<->skill relationship lives in a separate `job_domain_skill` link table with a
    `status`. The two `nearest_aliases` branches mirror the two SQL statements exactly."""

    def __init__(self) -> None:
        self.aliases: list[tuple[str, str | None, list[float]]] = []  # skill_id, legacy dom, vec
        self.links: list[tuple[str, str, str]] = []  # job_domain_id, skill_id, status
        self.searches: list[dict[str, object]] = []
        self.unresolved: list[dict[str, object]] = []

    def seed_canonical(
        self,
        skill_id: str,
        job_domain_id: str,
        text: str,
        *,
        status: str = "active",
        legacy_domain: str | None = None,
    ) -> None:
        """A canonical skill. `legacy_domain` DEFAULTS TO None — a bootstrap-minted skill
        that migration 0076 leaves with no slug at all."""
        self.aliases.append((skill_id, legacy_domain, _vec(text)))
        self.links.append((job_domain_id, skill_id, status))

    def seed_legacy(self, skill_id: str, domain_id: str, text: str) -> None:
        """A pre-0076 alias: a slug, and no `job_domain_skill` link."""
        self.aliases.append((skill_id, domain_id, _vec(text)))

    def nearest_aliases(self, domain_id, query_vector, k, *, job_domain_id=None):
        self.searches.append({"domain_id": domain_id, "job_domain_id": job_domain_id, "k": k})
        if job_domain_id is not None:
            # JOIN job_domain_skill jds ... WHERE jds.job_domain_id = $1 AND jds.status='active'
            linked = {s for jd, s, st in self.links if jd == job_domain_id and st == "active"}
            rows = [(s, _cosine(query_vector, v)) for s, _d, v in self.aliases if s in linked]
        else:
            # LEGACY: WHERE skill_alias.domain_id = $1
            rows = [(s, _cosine(query_vector, v)) for s, d, v in self.aliases if d == domain_id]
        rows.sort(key=lambda r: r[1], reverse=True)
        return rows[:k]

    def record_unresolved(self, phrase, domain_id, lang):
        self.unresolved.append({"phrase": phrase, "domain_id": domain_id, "lang": lang})


class PrePhase15Store:
    """A store written BEFORE the cutover: `nearest_aliases` has NO `job_domain_id`
    parameter. Passing the kwarg to it is a `TypeError` — which is precisely why the legacy
    path must not pass it, and why the canonical path must degrade instead of exploding."""

    def __init__(self) -> None:
        self.calls: list[tuple[str | None, int]] = []
        self.unresolved: list[tuple[str, str | None, str]] = []

    def nearest_aliases(self, domain_id, query_vector, k):
        self.calls.append((domain_id, k))
        return [("skill_turning", 0.95)] if domain_id == LEGACY_DOMAIN else []

    def record_unresolved(self, phrase, domain_id, lang):
        self.unresolved.append((phrase, domain_id, lang))


class ExplodingStore:
    """Every method raises. The seam must absorb it: canonicalization NEVER blocks the
    caller (TAX-8), so this degrades to UNRESOLVED rather than propagating."""

    def nearest_aliases(self, domain_id, query_vector, k, *, job_domain_id=None):
        raise RuntimeError("db is on fire")

    def record_unresolved(self, phrase, domain_id, lang):
        raise RuntimeError("still on fire")


class ForbiddenStore:
    """Any touch is a test failure — for the paths that must refuse before the store."""

    def nearest_aliases(self, domain_id, query_vector, k, *, job_domain_id=None):
        raise AssertionError("the store must not be reached on this path")

    def record_unresolved(self, phrase, domain_id, lang):
        raise AssertionError("nothing may be recorded on this path")


def _spy_embed(monkeypatch) -> list[str]:
    """Record every phrase that reaches the embedder (the paid call), without embedding."""
    seen: list[str] = []

    def _fake(text, settings):
        seen.append(text)
        return EmbeddingResult(
            vector=[0.1] * 768, blocked=False, is_mock=True, model="m", text=text
        )

    monkeypatch.setattr(canon_mod, "embed_text", _fake)
    return seen


# ---------------------------------------------------------------------------
# 1. THE CUTOVER: a NULL legacy domain is no longer invisible
# ---------------------------------------------------------------------------
def test_a_skill_with_a_null_legacy_domain_canonicalizes_under_a_job_domain_scope():
    store = TaxonomyStore()
    # `legacy_domain=None` — exactly what 0076 leaves behind for a canonical skill.
    store.seed_canonical("skill_mig_welding", JOB_DOMAIN, "MIG welding")

    res = canonicalize_skill("MIG welding", None, store, _settings(), job_domain_id=JOB_DOMAIN)

    assert res.status == "matched"
    assert res.skill_id == "skill_mig_welding"  # SG-3: the id came from the search
    assert res.score is not None and res.score >= _settings().skill_canonicalize_floor
    assert store.unresolved == []  # a hit is never queued for growth


def test_that_same_skill_is_unreachable_through_the_legacy_column():
    """The CONTROL for the test above, and the reason the cutover exists at all.

    Without this assertion the previous test could pass on the old code path by accident.
    A NULL legacy domain matches no `WHERE domain_id = $1`, for ANY slug."""
    store = TaxonomyStore()
    store.seed_canonical("skill_mig_welding", JOB_DOMAIN, "MIG welding")

    for slug in (LEGACY_DOMAIN, "welding", "fabrication"):
        res = canonicalize_skill("MIG welding", slug, store, _settings())
        assert res.status == "unresolved", f"legacy scan must not see a NULL-domain skill ({slug})"


def test_the_store_is_asked_for_the_job_domain_and_never_a_fabricated_legacy_domain():
    store = TaxonomyStore()
    store.seed_canonical("skill_mig_welding", JOB_DOMAIN, "MIG welding")

    canonicalize_skill("MIG welding", None, store, _settings(), job_domain_id=JOB_DOMAIN)

    assert len(store.searches) == 1
    search = store.searches[0]
    assert search["job_domain_id"] == JOB_DOMAIN
    # Constraint: never invent a legacy slug to make the canonical path "work" — that would
    # write a second id space into the legacy column's meaning.
    assert search["domain_id"] is None


def test_an_inactive_job_domain_skill_link_is_not_a_candidate():
    """`jds.status = 'active'` is part of the canonical WHERE clause: a deprecated link
    must not resurrect a skill into a domain it was removed from."""
    store = TaxonomyStore()
    store.seed_canonical("skill_mig_welding", JOB_DOMAIN, "MIG welding", status="deprecated")

    res = canonicalize_skill("MIG welding", None, store, _settings(), job_domain_id=JOB_DOMAIN)
    assert res.status == "unresolved" and res.skill_id is None


def test_a_canonical_scope_does_not_leak_across_job_domains():
    store = TaxonomyStore()
    store.seed_canonical("skill_mig_welding", JOB_DOMAIN, "MIG welding")

    res = canonicalize_skill(
        "MIG welding", None, store, _settings(), job_domain_id=OTHER_JOB_DOMAIN
    )
    assert res.status == "unresolved"  # the alias exists, but not in THIS job domain


def test_both_scopes_reach_the_same_id_for_a_dual_tagged_skill():
    """One id space (ADR-0028/0030). A skill that still carries a slug AND has a canonical
    link resolves to the SAME id whichever scope asked — the cutover is a widening of
    reachability, not a fork in the taxonomy."""
    store = TaxonomyStore()
    store.seed_canonical(
        "skill_turning", JOB_DOMAIN, "lathe operation", legacy_domain=LEGACY_DOMAIN
    )

    legacy = canonicalize_skill("lathe operation", LEGACY_DOMAIN, store, _settings())
    canonical = canonicalize_skill(
        "lathe operation", None, store, _settings(), job_domain_id=JOB_DOMAIN
    )
    assert legacy.status == canonical.status == "matched"
    assert legacy.skill_id == canonical.skill_id == "skill_turning"


# ---------------------------------------------------------------------------
# 2. THE LEGACY PATH IS UNTOUCHED
# ---------------------------------------------------------------------------
def test_the_legacy_path_calls_a_pre_phase_1_5_store_with_the_old_signature():
    """BACKWARD COMPATIBILITY, PROVEN BY CONSTRUCTION: `PrePhase15Store.nearest_aliases`
    accepts no `job_domain_id`, so if the legacy path ever started passing the kwarg this
    test would degrade to UNRESOLVED (the TypeError is swallowed fail-soft) and go red."""
    store = PrePhase15Store()

    res = canonicalize_skill("lathe operation", LEGACY_DOMAIN, store, _settings())

    assert res.status == "matched" and res.skill_id == "skill_turning"
    assert store.calls == [(LEGACY_DOMAIN, _settings().skill_canonicalize_top_k)]


def test_the_legacy_miss_still_records_its_slug():
    store = TaxonomyStore()
    store.seed_legacy("skill_turning", LEGACY_DOMAIN, "lathe operation")

    res = canonicalize_skill("astrophysics lecturer", LEGACY_DOMAIN, store, _settings())

    assert res.status == "unresolved"
    assert store.unresolved == [
        {"phrase": "astrophysics lecturer", "domain_id": LEGACY_DOMAIN, "lang": "en"}
    ]


def test_canonicalize_labels_threads_the_job_domain_scope_and_defaults_to_legacy():
    store = TaxonomyStore()
    store.seed_canonical("skill_mig_welding", JOB_DOMAIN, "MIG welding")
    store.seed_legacy("skill_turning", LEGACY_DOMAIN, "lathe operation")

    assigned, unresolved, costs = canonicalize_labels(
        ["MIG welding", "lathe operation"], None, store, _settings(), job_domain_id=JOB_DOMAIN
    )
    assert assigned == ["skill_mig_welding"]  # only the canonically-linked one is in scope
    assert unresolved == ["lathe operation"]
    assert len(costs) == 2  # a miss costs the same embed as a hit (#745)

    # The unchanged legacy fan-out — same call shape every existing caller uses.
    assigned_legacy, _u, _c = canonicalize_labels(
        ["lathe operation"], LEGACY_DOMAIN, store, _settings()
    )
    assert assigned_legacy == ["skill_turning"]


# ---------------------------------------------------------------------------
# 3. NO SCOPE IS A REFUSAL — at the contract, and again before the embed
# ---------------------------------------------------------------------------
def test_the_contract_rejects_neither_scope():
    with pytest.raises(ValidationError):
        SkillCanonicalizationInput(phrase="MIG welding")


def test_the_contract_rejects_both_scopes():
    with pytest.raises(ValidationError):
        SkillCanonicalizationInput(
            phrase="MIG welding", domain_id=LEGACY_DOMAIN, job_domain_id=JOB_DOMAIN
        )


def test_the_contract_accepts_exactly_one_scope():
    legacy = SkillCanonicalizationInput(phrase="p", domain_id=LEGACY_DOMAIN)
    assert legacy.job_domain_id is None and legacy.lang == "en"
    canonical = SkillCanonicalizationInput(phrase="p", job_domain_id=JOB_DOMAIN, lang="hi")
    assert canonical.domain_id is None and canonical.lang == "hi"


def test_an_explicit_null_scope_is_still_a_rejection():
    """`{"domain_id": null}` is ABSENT, not "all domains" — the wildcard reading is the one
    thing this rule exists to prevent."""
    with pytest.raises(ValidationError):
        SkillCanonicalizationInput(phrase="p", domain_id=None, job_domain_id=None)


def test_the_shared_scope_rule_is_an_exclusive_or():
    """One helper, three consumers (both contract validators + `canonicalize_skill`), so the
    rule cannot drift between the HTTP seam and the library entry point."""
    assert exactly_one_skill_scope(LEGACY_DOMAIN, None) is True
    assert exactly_one_skill_scope(None, JOB_DOMAIN) is True
    assert exactly_one_skill_scope(None, None) is False
    assert exactly_one_skill_scope(LEGACY_DOMAIN, JOB_DOMAIN) is False
    # PRESENCE, not truthiness: an empty slug is SUPPLIED (it scopes to a domain with no
    # aliases — safe), so an existing caller sending "" keeps its exact current behaviour.
    assert exactly_one_skill_scope("", None) is True


def test_the_model_level_rule_is_a_live_backstop_not_decoration():
    """The field validator normally fires first (it is the PII-safe error), which would
    leave the model-level rule unexercised and free to rot. Reach it directly, past field
    validation, so both layers are pinned."""
    unvalidated = SkillCanonicalizationInput.model_construct(
        phrase="p", domain_id=LEGACY_DOMAIN, job_domain_id=JOB_DOMAIN, lang="en"
    )
    with pytest.raises(ValueError):
        unvalidated._exactly_one_domain_scope()

    scopeless = SkillCanonicalizationInput.model_construct(
        phrase="p", domain_id=None, job_domain_id=None, lang="en"
    )
    with pytest.raises(ValueError):
        scopeless._exactly_one_domain_scope()


def test_the_rejection_never_echoes_the_phrase(monkeypatch):
    """PII CONTROL, MEASURED. FastAPI renders a 422 as `{"detail": exc.errors()}`, and a
    pydantic error entry carries `input` VERBATIM — a `model_validator(mode="after")`
    rejection reports `input: {"phrase": "<the raw phrase>"}`, putting worker text in an
    HTTP body any caller may log. The rule is therefore raised from the `job_domain_id`
    FIELD, whose `input` is the (closed-set, PII-free) id itself.

    The probe phrase carries a 10-digit run so a leak is unmistakable."""
    seen = _spy_embed(monkeypatch)
    client = TestClient(app_main.app)

    resp = client.post("/skills/canonicalize", json={"phrase": "call me on 9876543210"})

    assert resp.status_code == 422
    assert "9876543210" not in resp.text
    assert "call me" not in resp.text
    assert seen == []  # a scope-less request never reaches the embedder


def test_the_endpoint_rejects_both_scopes_without_embedding(monkeypatch):
    seen = _spy_embed(monkeypatch)
    client = TestClient(app_main.app)

    resp = client.post(
        "/skills/canonicalize",
        json={"phrase": "lathe operation", "domain_id": LEGACY_DOMAIN, "job_domain_id": JOB_DOMAIN},
    )
    assert resp.status_code == 422
    assert seen == []


def test_canonicalize_skill_refuses_a_scopeless_call_before_the_embed(monkeypatch):
    """DEFENCE IN DEPTH BEHIND THE CONTRACT. `canonicalize_skill` is a library entry point
    (the extraction fan-out calls it directly, no FastAPI validation in front), so the
    refusal has to live here too: no embed spent, no store touched, nothing recorded."""
    seen = _spy_embed(monkeypatch)

    res = canonicalize_skill("MIG welding", None, ForbiddenStore(), _settings())

    assert res.status == "unresolved" and res.skill_id is None
    assert res.ai_metadata is None  # nothing was attempted, so nothing is billed
    assert seen == []


def test_canonicalize_skill_refuses_a_double_scoped_call_before_the_embed(monkeypatch):
    seen = _spy_embed(monkeypatch)

    res = canonicalize_skill(
        "MIG welding", LEGACY_DOMAIN, ForbiddenStore(), _settings(), job_domain_id=JOB_DOMAIN
    )

    assert res.status == "unresolved" and res.ai_metadata is None
    assert seen == []


def test_canonicalize_labels_refuses_every_label_when_unscoped(monkeypatch):
    seen = _spy_embed(monkeypatch)

    assigned, unresolved, costs = canonicalize_labels(
        ["MIG welding", "lathe operation"], None, ForbiddenStore(), _settings()
    )

    assert assigned == [] and unresolved == ["MIG welding", "lathe operation"]
    assert costs == [] and seen == []


# ---------------------------------------------------------------------------
# 4. THE MISS: a canonical-scoped miss records a NULL domain, never a jd_* id
# ---------------------------------------------------------------------------
def test_a_canonical_scoped_miss_is_not_queued_at_all_and_still_returns_unresolved():
    """THIS TEST WAS INVERTED, and the inversion is the ruling landing.

    It used to assert the miss was recorded with `domain_id=None`. That required the v1
    `skill.phrase_unresolved` payload to accept a null `domain_id`, i.e. mutating a shipped
    event schema — a CLAUDE.md §3 non-negotiable. The Architect ruled: keep v1 intact and
    close the path instead.

    So a canonical-scoped miss is now NOT QUEUED. The two rejected alternatives are worth
    naming, because "not queued" sounds like the lazy option and is not: writing `jd_welding`
    into the LEGACY-slug `domain_id` column would put two id spaces in one column and corrupt
    every per-domain reader of the growth queue; and writing the row with a null domain would
    write it and THEN fail event validation, leaving a queued phrase with no event.

    The embed is still paid for and the result is still UNRESOLVED — the caller sees exactly
    what it saw before. Only the growth-queue side effect is missing, and it is missing
    LOUDLY (an INFO log naming the reason), not silently.

    Reopened by: adding `job_domain_id` to `unresolved_phrase` + an ADDITIVE optional field
    on the event payload (additive is not a mutation). Hard prerequisite of the payer picker.
    """
    store = TaxonomyStore()
    store.seed_canonical("skill_mig_welding", JOB_DOMAIN, "MIG welding")

    res = canonicalize_skill(
        "underwater basket weaving", None, store, _settings(), job_domain_id=JOB_DOMAIN
    )

    assert res.status == "unresolved" and res.skill_id is None
    assert res.ai_metadata is not None  # the embed was still paid for (#745)
    assert store.unresolved == [], "a canonical-scoped miss has no queue to land in yet"


def test_a_LEGACY_scoped_miss_is_still_queued_exactly_as_before():
    """The regression pin for the half that did NOT change. Closing the canonical miss path
    must not touch the legacy one, which is the only one reachable in production today."""
    store = TaxonomyStore()
    store.seed_legacy("skill_mig_welding", LEGACY_DOMAIN, "MIG welding")

    res = canonicalize_skill("underwater basket weaving", LEGACY_DOMAIN, store, _settings())

    assert res.status == "unresolved"
    assert len(store.unresolved) == 1
    row = store.unresolved[0]
    assert row["domain_id"] == LEGACY_DOMAIN
    assert row["lang"] == "en"
    assert "jd_" not in str(row), "a jd_* id must never be written into the legacy slug column"


def test_a_legacy_scoped_miss_records_the_masked_text_not_the_raw_phrase():
    """SG-1. An employer name MASKS without blocking, which is the only input that can tell
    `emb.text` and the raw `phrase` apart. Moved onto the LEGACY scope because the canonical
    scope no longer records at all — the property still needs a live path to be pinned on."""
    store = TaxonomyStore()
    store.seed_legacy("skill_mig_welding", LEGACY_DOMAIN, "MIG welding")

    canonicalize_skill("welder at Tata Motors", LEGACY_DOMAIN, store, _settings())

    recorded = str(store.unresolved[0]["phrase"])
    assert "Tata" not in recorded and "Motors" not in recorded
    assert "[EMPLOYER_1]" in recorded


# ---------------------------------------------------------------------------
# 5. FAIL-SOFT + FAIL-CLOSED postures survive the cutover
# ---------------------------------------------------------------------------
def test_a_store_that_raises_degrades_to_unresolved_on_the_canonical_path():
    res = canonicalize_skill(
        "MIG welding", None, ExplodingStore(), _settings(), job_domain_id=JOB_DOMAIN
    )
    assert res.status == "unresolved" and res.skill_id is None


def test_a_store_that_raises_degrades_to_unresolved_on_the_legacy_path():
    res = canonicalize_skill("lathe operation", LEGACY_DOMAIN, ExplodingStore(), _settings())
    assert res.status == "unresolved" and res.skill_id is None


def test_a_pre_phase_1_5_store_asked_for_a_canonical_scope_degrades_instead_of_raising():
    """The rollout hazard: the seam widened, an implementation did not. A `TypeError` from
    an out-of-date store must look like an outage (UNRESOLVED + a warning log), never a 500
    on a worker's profile turn."""
    store = PrePhase15Store()

    res = canonicalize_skill("MIG welding", None, store, _settings(), job_domain_id=JOB_DOMAIN)

    assert res.status == "unresolved"
    assert store.calls == []  # it never accepted the call


def test_a_blocked_phrase_under_a_canonical_scope_is_unresolved_and_records_nothing(monkeypatch):
    """SG-2 fail-closed, unchanged by the cutover: a pseudonymize block is never embedded,
    and its text still holds the residual PII that blocked it — so nothing is recorded and
    no cost metadata is emitted (no provider was reached)."""
    monkeypatch.setattr(
        embeddings,
        "pseudonymize",
        lambda *_a, **_k: PseudonymizationResult(
            text="",
            blocked=True,
            blocked_reason="residual_digits",
            replaced_entities=0,
            placeholder_tokens=[],
        ),
    )
    store = ForbiddenStore()

    res = canonicalize_skill("ref 12345678", None, store, _settings(), job_domain_id=JOB_DOMAIN)

    assert res.status == "unresolved" and res.skill_id is None
    assert res.ai_metadata is None


# ---------------------------------------------------------------------------
# 6. THE WIRE: HttpSkillStore sends exactly one scope key
# ---------------------------------------------------------------------------
class _FakeResponse:
    def __init__(self, status_code: int, body: dict | None = None):
        self.status_code = status_code
        self._body = body or {}

    def json(self):
        return self._body


class _FakeClient:
    calls: list[tuple[str, dict]] = []
    response: _FakeResponse = _FakeResponse(200, {"candidates": []})

    def __init__(self, *a, **k):
        pass

    def post(self, url, headers=None, json=None):
        _FakeClient.calls.append((url, {"headers": headers, "json": json}))
        return _FakeClient.response


def _use_fake_client(monkeypatch, response=None):
    _FakeClient.calls = []
    _FakeClient.response = response or _FakeResponse(200, {"candidates": []})
    monkeypatch.setattr(ss.httpx, "Client", _FakeClient)
    return HttpSkillStore("http://api.internal:3001/", "test-token")


def test_the_canonical_search_body_carries_job_domain_id_and_omits_domain_id(monkeypatch):
    store = _use_fake_client(
        monkeypatch, _FakeResponse(200, {"candidates": [{"skill_id": "skill_x", "score": 0.9}]})
    )

    out = store.nearest_aliases(None, [0.1] * 768, 5, job_domain_id=JOB_DOMAIN)

    assert out == [("skill_x", 0.9)]
    body = _FakeClient.calls[0][1]["json"]
    assert body["job_domain_id"] == JOB_DOMAIN
    # OMITTED, not null: the api 400s a body carrying both keys.
    assert "domain_id" not in body
    assert body["k"] == 5


def test_the_legacy_search_body_is_unchanged(monkeypatch):
    store = _use_fake_client(monkeypatch)

    store.nearest_aliases(LEGACY_DOMAIN, [0.1] * 768, 5)

    body = _FakeClient.calls[0][1]["json"]
    assert body["domain_id"] == LEGACY_DOMAIN
    assert "job_domain_id" not in body
    assert list(body.keys()) == ["domain_id", "vector", "k"]  # byte-identical to pre-1.5


def test_the_store_refuses_to_search_with_no_scope_and_makes_no_request(monkeypatch):
    store = _use_fake_client(monkeypatch)

    assert store.nearest_aliases(None, [0.1] * 768, 5) == []
    assert _FakeClient.calls == []  # never posted an unscoped body


def test_the_store_refuses_to_search_with_both_scopes(monkeypatch):
    store = _use_fake_client(monkeypatch)

    assert store.nearest_aliases(LEGACY_DOMAIN, [0.1] * 768, 5, job_domain_id=JOB_DOMAIN) == []
    assert _FakeClient.calls == []


def test_the_unresolved_post_refuses_a_null_domain_locally_and_spends_no_round_trip(monkeypatch):
    """INVERTED alongside the schema ruling. The api route requires a non-null `domain_id`
    (the v1 event payload declares `string`), so posting null would earn a 400 and log a
    misleading "failed" warning. The store refuses locally instead — defence in depth behind
    `_safe_record`, which already skips this case."""
    store = _use_fake_client(monkeypatch, _FakeResponse(204))

    store.record_unresolved("[EMPLOYER_1] polish work", None, "en")

    assert _FakeClient.calls == [], "no HTTP call should be made for a null domain"


def test_the_unresolved_post_still_sends_a_legacy_domain_unchanged(monkeypatch):
    """The regression pin: refusing null must not disturb the path that actually runs."""
    store = _use_fake_client(monkeypatch, _FakeResponse(204))

    store.record_unresolved("[EMPLOYER_1] polish work", LEGACY_DOMAIN, "en")

    url, req = _FakeClient.calls[0]
    assert url.endswith("/internal/skills/unresolved")
    assert req["json"] == {
        "phrase": "[EMPLOYER_1] polish work",
        "domain_id": LEGACY_DOMAIN,
        "lang": "en",
    }


# ---------------------------------------------------------------------------
# 7. THE ENDPOINT threads the scope through (and traces it PII-free)
# ---------------------------------------------------------------------------
class _RecordingObservation:
    def __init__(self) -> None:
        self.updates: list[dict] = []

    def update(self, **fields):
        self.updates.append(fields)


class _RecordingTracer:
    def __init__(self) -> None:
        self.tasks: list[dict] = []
        self.observation_count = 0

    def task(self, **kwargs):
        self.tasks.append(kwargs)
        self.observation_count += 1
        obs = _RecordingObservation()

        class _Ctx:
            def __enter__(self_inner):
                return obs

            def __exit__(self_inner, *exc):
                return False

        return _Ctx()


def test_the_endpoint_canonicalizes_through_the_job_domain_scope(monkeypatch):
    store = TaxonomyStore()
    store.seed_canonical("skill_mig_welding", JOB_DOMAIN, "MIG welding")
    enabled = _settings(skill_canonicalize_enabled=True)
    monkeypatch.setattr(skills_router, "get_settings", lambda: enabled)
    monkeypatch.setattr(skills_router, "get_skill_store", lambda s: store)

    body = (
        TestClient(app_main.app)
        .post("/skills/canonicalize", json={"phrase": "MIG welding", "job_domain_id": JOB_DOMAIN})
        .json()
    )

    assert body["status"] == "matched"
    assert body["skill_id"] == "skill_mig_welding"
    assert store.searches == [{"domain_id": None, "job_domain_id": JOB_DOMAIN, "k": 5}]


def test_the_endpoint_traces_both_scope_keys_and_never_the_phrase(monkeypatch):
    store = TaxonomyStore()
    store.seed_canonical("skill_mig_welding", JOB_DOMAIN, "MIG welding")
    enabled = _settings(skill_canonicalize_enabled=True)
    tracer = _RecordingTracer()
    monkeypatch.setattr(skills_router, "get_settings", lambda: enabled)
    monkeypatch.setattr(skills_router, "get_skill_store", lambda s: store)
    monkeypatch.setattr(skills_router, "get_tracer", lambda: tracer)

    TestClient(app_main.app).post(
        "/skills/canonicalize", json={"phrase": "MIG welding", "job_domain_id": JOB_DOMAIN}
    )

    # ONE task, exactly as before the cutover — no observation added or removed.
    assert tracer.observation_count == 1
    traced = tracer.tasks[0]["input"]
    assert traced == {"domain_id": None, "job_domain_id": JOB_DOMAIN, "lang": "en"}
    assert "MIG welding" not in str(traced)


def test_the_endpoint_legacy_request_is_unchanged(monkeypatch):
    store = TaxonomyStore()
    store.seed_legacy("skill_turning", LEGACY_DOMAIN, "lathe operation")
    enabled = _settings(skill_canonicalize_enabled=True)
    monkeypatch.setattr(skills_router, "get_settings", lambda: enabled)
    monkeypatch.setattr(skills_router, "get_skill_store", lambda s: store)

    body = (
        TestClient(app_main.app)
        .post(
            "/skills/canonicalize", json={"phrase": "lathe operation", "domain_id": LEGACY_DOMAIN}
        )
        .json()
    )

    assert body["status"] == "matched" and body["skill_id"] == "skill_turning"
    assert store.searches == [{"domain_id": LEGACY_DOMAIN, "job_domain_id": None, "k": 5}]
