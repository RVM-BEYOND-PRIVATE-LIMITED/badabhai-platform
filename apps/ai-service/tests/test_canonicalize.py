"""Skill-phrase canonicalization tests (ADR-0030 / TAX-4) — mock embedder, zero spend.

Covers the acceptance test cases: (1) in-vocab → correct id ≥ floor, (2) below-floor →
UNRESOLVED + a recorded (pseudonymized) unresolved row, (3) domain mismatch → no cross-domain
match, (4) an LLM-proposed phrase never yields an id the vector layer did not assign, plus
fail-closed (blocked → UNRESOLVED, not recorded), the inclusive floor boundary, and the flagged
extraction wiring. Contract (Zod↔Pydantic) parity is asserted in
packages/ai-contracts/src/ai-contracts.test.ts + the Pydantic-side test below.
"""

from __future__ import annotations

import math

from app.ai import embeddings
from app.ai.canonicalize import canonicalize_labels, canonicalize_skill
from app.ai.embeddings import embed_text
from app.config import Settings
from app.contracts import SkillCanonicalization, SkillCanonicalizationInput
from app.pseudonymize import PseudonymizationResult


def _settings(**over) -> Settings:
    # Real calls OFF (default) → the deterministic mock embedder, so alias/query vectors of
    # the SAME text are identical and cosine == 1.0. Zero spend.
    return Settings(**over)


def _pseudo(text: str = "", *, blocked: bool = False, reason: str | None = None):
    return PseudonymizationResult(
        text=text,
        blocked=blocked,
        blocked_reason=reason,
        replaced_entities=0,
        placeholder_tokens=[],
    )


def _vec(text: str) -> list[float]:
    res = embed_text(text, _settings())
    assert res.vector is not None
    return res.vector


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


class MemCanonStore:
    """In-memory SkillCanonicalStore. `nearest_aliases` computes cosine on the mock vectors
    and is DOMAIN-SCOPED (mirrors the SQL WHERE domain_id=$d). `record_unresolved` captures
    what a real upsert would persist so tests can assert SG-1 (pseudonymized text only)."""

    def __init__(self):
        self.aliases: list[tuple[str, str, list[float]]] = []  # (skill_id, domain_id, vector)
        self.unresolved: list[tuple[str, str, str]] = []  # (phrase, domain_id, lang)

    def seed(self, skill_id: str, domain_id: str, text: str) -> None:
        self.aliases.append((skill_id, domain_id, _vec(text)))

    def nearest_aliases(self, domain_id, query_vector, k):
        scored = [
            (sid, _cosine(query_vector, vec))
            for sid, dom, vec in self.aliases
            if dom == domain_id  # domain scoping — the WHERE clause
        ]
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:k]

    def record_unresolved(self, phrase, domain_id, lang):
        self.unresolved.append((phrase, domain_id, lang))


class ScriptedStore:
    """Returns one candidate with a fixed score — to test the floor boundary exactly."""

    def __init__(self, score: float):
        self.score = score
        self.unresolved: list[tuple[str, str, str]] = []

    def nearest_aliases(self, domain_id, query_vector, k):
        return [("skill_x", self.score)]

    def record_unresolved(self, phrase, domain_id, lang):
        self.unresolved.append((phrase, domain_id, lang))


# --- (1) in-vocab phrase → correct id, score >= floor ------------------------
def test_in_vocab_phrase_assigns_correct_id_above_floor():
    store = MemCanonStore()
    store.seed("skill_vmc_operator", "vmc-machining", "VMC operator")
    store.seed("skill_cnc_turner", "cnc-machining", "CNC turner")

    res = canonicalize_skill("VMC operator", "vmc-machining", store, _settings())
    assert res.status == "matched"
    assert res.skill_id == "skill_vmc_operator"
    assert res.score is not None and res.score >= _settings().skill_canonicalize_floor
    assert store.unresolved == []  # a hit is never recorded as unresolved


# --- (2) below-floor phrase → UNRESOLVED + a recorded (pseudonymized) row -----
def test_below_floor_phrase_is_unresolved_and_recorded():
    store = MemCanonStore()
    store.seed("skill_vmc_operator", "vmc-machining", "VMC operator")

    res = canonicalize_skill("astrophysics lecturer", "vmc-machining", store, _settings())
    assert res.status == "unresolved"
    assert res.skill_id is None and res.score is None
    assert len(store.unresolved) == 1
    phrase, dom, lang = store.unresolved[0]
    assert dom == "vmc-machining" and lang == "en"
    assert "astrophysics" in phrase  # the (pseudonymized) miss text is recorded for learning


# --- SG-1 discriminator: the RECORDED miss text is masked, never the raw phrase ---
def test_below_floor_miss_records_masked_text_not_raw_pii():
    # An employer name MASKS but does NOT block (no residual digit run). This is the only
    # assertion that actually proves record_unresolved gets emb.text (masked), not the raw
    # `phrase` — a PII-free miss phrase can't distinguish the two.
    store = MemCanonStore()
    store.seed("skill_vmc_operator", "vmc-machining", "VMC operator")

    res = canonicalize_skill("welder at Tata Motors", "vmc-machining", store, _settings())
    assert res.status == "unresolved"
    assert len(store.unresolved) == 1
    recorded = store.unresolved[0][0]
    assert "Tata" not in recorded and "Motors" not in recorded  # raw employer never stored
    assert "[EMPLOYER_1]" in recorded  # the pseudonymized placeholder is what got recorded


# --- (3) domain mismatch → no cross-domain match -----------------------------
def test_same_phrase_in_wrong_domain_does_not_match():
    store = MemCanonStore()
    store.seed("skill_vmc_operator", "vmc-machining", "VMC operator")

    res = canonicalize_skill("VMC operator", "welding", store, _settings())
    assert res.status == "unresolved"  # the alias exists, but in a different domain
    assert res.skill_id is None
    # recorded under the QUERIED domain, not the alias's domain
    assert store.unresolved and store.unresolved[0][1] == "welding"


# --- (4) an LLM-proposed phrase never yields an id the vector layer didn't set -
def test_canonicalize_labels_only_returns_vector_assigned_ids():
    store = MemCanonStore()
    store.seed("skill_vmc_operator", "vmc-machining", "VMC operator")
    store.seed("skill_surface_grinding", "vmc-machining", "surface grinding")

    labels = ["VMC operator", "surface grinding", "underwater basket weaving"]
    assigned, unresolved = canonicalize_labels(labels, "vmc-machining", store, _settings())

    assert assigned == ["skill_vmc_operator", "skill_surface_grinding"]
    assert unresolved == ["underwater basket weaving"]  # no match → not assigned, recorded
    # SG-3: every assigned id came from the seeded (closed) set — none fabricated.
    assert set(assigned) <= {"skill_vmc_operator", "skill_surface_grinding"}


def test_canonicalize_labels_dedupes_and_skips_blank():
    store = MemCanonStore()
    store.seed("skill_vmc_operator", "vmc-machining", "VMC operator")
    assigned, _ = canonicalize_labels(
        ["VMC operator", "  ", "VMC operator"], "vmc-machining", store, _settings()
    )
    assert assigned == ["skill_vmc_operator"]  # de-duplicated, blank skipped


# --- fail-closed: a blocked phrase is UNRESOLVED and NOT recorded -------------
def test_blocked_phrase_is_unresolved_and_not_recorded(monkeypatch):
    monkeypatch.setattr(
        embeddings, "pseudonymize", lambda *_a, **_k: _pseudo(blocked=True, reason="residual")
    )
    store = MemCanonStore()
    res = canonicalize_skill("ref 12345678", "vmc-machining", store, _settings())
    assert res.status == "unresolved" and res.skill_id is None
    assert store.unresolved == []  # blocked → nothing safe to store (SG-1/SG-2 fail-closed)


# --- the floor is an INCLUSIVE boundary (>=), never forced --------------------
def test_floor_is_inclusive_and_below_is_never_forced():
    s = _settings()  # floor 0.82
    at = canonicalize_skill("x", "d", ScriptedStore(s.skill_canonicalize_floor), s)
    assert at.status == "matched" and at.skill_id == "skill_x"

    just_under = ScriptedStore(s.skill_canonicalize_floor - 0.0001)
    under = canonicalize_skill("x", "d", just_under, s)
    assert under.status == "unresolved"  # borderline is NEVER forced to a match
    assert just_under.unresolved  # the borderline miss is recorded


# --- extraction wiring (flagged, default off) --------------------------------
def test_map_rich_to_legacy_vector_canonicalizes_when_enabled():
    from app.contracts import WorkerProfileDraft
    from app.profiling.profile_extractor import map_rich_to_legacy

    store = MemCanonStore()
    # default domain = cnc-machining (Settings.skill_canonicalize_default_domain)
    store.seed("skill_vmc_operator", "cnc-machining", "VMC operator")
    rich = WorkerProfileDraft(skills=["VMC operator"])

    legacy = map_rich_to_legacy(
        rich, None, skill_store=store, settings=_settings(skill_canonicalize_enabled=True)
    )
    assert "skill_vmc_operator" in legacy.skills  # vector-assigned id landed
    assert "VMC operator" not in legacy.skills  # the raw LABEL is never stored as an id


def test_map_rich_to_legacy_is_noop_when_flag_off():
    from app.contracts import WorkerProfileDraft
    from app.profiling.profile_extractor import map_rich_to_legacy

    store = MemCanonStore()
    store.seed("skill_vmc_operator", "cnc-machining", "VMC operator")
    rich = WorkerProfileDraft(skills=["VMC operator"])

    legacy = map_rich_to_legacy(
        rich, None, skill_store=store, settings=_settings(skill_canonicalize_enabled=False)
    )
    assert "skill_vmc_operator" not in legacy.skills  # gazetteer-only; no vector canonicalize
    assert store.unresolved == []  # canonicalize never ran


# --- (5) Pydantic contract shape (Zod parity asserted in ai-contracts.test.ts) -
def test_pydantic_contract_defaults():
    r = SkillCanonicalization(status="unresolved")
    assert r.skill_id is None and r.score is None
    matched = SkillCanonicalization(status="matched", skill_id="skill_x", score=0.9)
    assert matched.status == "matched" and matched.skill_id == "skill_x"
    inp = SkillCanonicalizationInput(phrase="VMC operator", domain_id="vmc-machining")
    assert inp.lang == "en"
