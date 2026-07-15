"""ADR-0030 / TAX-7 growth-loop clustering tests (`pytest -k growth`).

The /growth/cluster endpoint is PURE COMPUTE over caller-supplied vectors, so these
tests craft synthetic 768-dim vectors with exact cosines (no embedder, no DB, no spend):
``blend(i, j, c)`` returns a unit vector whose cosine against basis ``axis(i)`` is
exactly ``c``. Locked properties:

- deterministic greedy clustering (shuffle-stable), guards (size OR frequency),
- band routing: near-anchor → alias proposal, far → provisional,
- SG-3: an alias proposal's skill_id is ALWAYS one of the input anchors,
- SG-5: a provisional proposal NEVER carries a skill_id (no id minted),
- >= floor still emits a PROPOSAL (drift note) — nothing auto-activates,
- input hygiene: wrong-dim / non-finite vectors are a 422, caps enforced.
"""

from __future__ import annotations

import math
import random

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.ai.growth import growth_cluster
from app.config import Settings
from app.contracts import (
    GrowthAnchor,
    GrowthClusterInput,
    GrowthPhrase,
)
from app.main import app

DIM = 768


def axis(i: int) -> list[float]:
    v = [0.0] * DIM
    v[i] = 1.0
    return v


def blend(i: int, j: int, cos_with_i: float) -> list[float]:
    """Unit vector with cosine exactly ``cos_with_i`` against axis(i), remainder on axis(j)."""
    v = [0.0] * DIM
    v[i] = cos_with_i
    v[j] = math.sqrt(max(0.0, 1.0 - cos_with_i * cos_with_i))
    return v


def phrase(pid: str, text: str, vec: list[float], count: int = 1) -> GrowthPhrase:
    return GrowthPhrase(id=pid, phrase=text, count=count, vector=vec)


def settings() -> Settings:
    return Settings(
        skill_growth_min_cluster_size=2,
        skill_growth_min_total_count=3,
        skill_growth_cluster_threshold=0.80,
        skill_growth_band_low=0.60,
        skill_canonicalize_floor=0.75,
    )


def run(phrases, anchors, **params):
    inp = GrowthClusterInput(
        domain_id="cnc-machining", phrases=phrases, anchors=anchors, **params
    )
    return growth_cluster(inp, settings())


class TestGrowthClustering:
    def test_similar_phrases_cluster_orthogonal_stays_apart(self):
        out = run(
            [
                phrase("p1", "welding ka kaam", axis(0), count=3),
                phrase("p2", "welding karna", blend(0, 1, 0.9)),
                phrase("p3", "polishing", axis(2), count=5),
            ],
            [],
        )
        assert out.clusters_total == 2
        by_leader = {p.leader_phrase: p for p in out.proposals}
        assert set(by_leader["polishing"].member_ids) == {"p3"}
        assert set(by_leader["welding ka kaam"].member_ids) == {"p1", "p2"}

    def test_guards_skip_one_off_noise_but_keep_high_frequency_singleton(self):
        out = run(
            [
                # size 1, count 1 → below BOTH guards → skipped.
                phrase("noise", "one-off typo", axis(0)),
                # size 1 but count 5 >= min_total_count → eligible via frequency.
                phrase("hot", "hot phrase", axis(2), count=5),
            ],
            [],
        )
        assert out.clusters_total == 2
        assert out.clusters_eligible == 1
        assert out.skipped_below_guards == 1
        assert [p.leader_phrase for p in out.proposals] == ["hot phrase"]

    def test_deterministic_under_input_shuffle(self):
        base = [
            phrase("a", "a", blend(0, 1, 0.95), count=2),
            phrase("b", "b", axis(0), count=4),
            phrase("c", "c", axis(3), count=3),
            phrase("d", "d", blend(0, 2, 0.9), count=1),
            phrase("e", "e", blend(3, 4, 0.85), count=1),
        ]
        anchors = [GrowthAnchor(skill_id="skill_x", vector=blend(0, 5, 0.7))]
        reference = run(list(base), anchors).model_dump()
        rng = random.Random(42)
        for _ in range(5):
            shuffled = list(base)
            rng.shuffle(shuffled)
            assert run(shuffled, anchors).model_dump() == reference

    def test_leader_is_highest_count_then_id(self):
        out = run(
            [
                phrase("z-low", "variant", blend(0, 1, 0.9), count=1),
                phrase("a-high", "the canonical phrasing", axis(0), count=7),
            ],
            [],
        )
        assert out.proposals[0].leader_phrase == "the canonical phrasing"
        assert out.proposals[0].total_count == 8


class TestGrowthProposalRouting:
    def test_near_anchor_in_band_proposes_alias_on_that_skill(self):
        anchors = [
            GrowthAnchor(skill_id="skill_grinding_ops", vector=blend(0, 1, 0.65)),
            GrowthAnchor(skill_id="skill_turning", vector=blend(0, 2, 0.30)),
        ]
        out = run([phrase("p1", "kharad jaisa kaam", axis(0), count=4)], anchors)
        (p,) = out.proposals
        assert p.kind == "alias"
        assert p.skill_id == "skill_grinding_ops"  # the nearest anchor, in [0.60, 0.75)
        assert p.nearest_score is not None and 0.60 <= p.nearest_score < 0.75
        assert p.note is None

    def test_far_from_all_anchors_proposes_provisional_without_id(self):
        anchors = [GrowthAnchor(skill_id="skill_turning", vector=blend(0, 1, 0.2))]
        out = run([phrase("p1", "unobtainium polishing", axis(0), count=4)], anchors)
        (p,) = out.proposals
        assert p.kind == "provisional_skill"
        assert p.skill_id is None  # SG-5: no id minted.
        # Diagnostics still name the nearest known skill for the reviewer.
        assert p.nearest_skill_id == "skill_turning"

    def test_no_anchors_at_all_proposes_provisional(self):
        out = run([phrase("p1", "brand new trade", axis(0), count=4)], [])
        (p,) = out.proposals
        assert p.kind == "provisional_skill"
        assert p.skill_id is None
        assert p.nearest_skill_id is None and p.nearest_score is None

    def test_at_or_above_floor_is_still_only_a_proposal_with_drift_note(self):
        anchors = [GrowthAnchor(skill_id="skill_milling", vector=blend(0, 1, 0.9))]
        out = run([phrase("p1", "chhilai type kaam", axis(0), count=4)], anchors)
        (p,) = out.proposals
        assert p.kind == "alias"
        assert p.skill_id == "skill_milling"
        assert p.note is not None and "floor" in p.note  # drift → verify then ratify

    def test_sg3_alias_ids_only_ever_come_from_the_anchor_set(self):
        anchor_ids = {"skill_a", "skill_b", "skill_c"}
        anchors = [
            GrowthAnchor(skill_id="skill_a", vector=blend(0, 1, 0.68)),
            GrowthAnchor(skill_id="skill_b", vector=blend(2, 3, 0.7)),
            GrowthAnchor(skill_id="skill_c", vector=axis(9)),
        ]
        phrases = [
            phrase("p1", "x", axis(0), count=4),
            phrase("p2", "y", blend(2, 4, 0.95), count=4),
            phrase("p3", "z", axis(20), count=4),
        ]
        out = run(phrases, anchors)
        for p in out.proposals:
            if p.kind == "alias":
                assert p.skill_id in anchor_ids
            else:
                assert p.skill_id is None

    def test_centroid_is_count_weighted_toward_heavy_member(self):
        # Heavy member sits ON the anchor axis; light member 0.85 off it. The count-weighted
        # centroid must land close enough to the anchor to stay an alias proposal.
        anchors = [GrowthAnchor(skill_id="skill_x", vector=blend(0, 5, 0.70))]
        out = run(
            [
                phrase("heavy", "heavy", axis(0), count=9),
                phrase("light", "light", blend(0, 1, 0.85), count=1),
            ],
            anchors,
        )
        (p,) = out.proposals
        assert p.kind == "alias" and set(p.member_ids) == {"heavy", "light"}


class TestGrowthEndpoint:
    def test_endpoint_round_trip(self):
        client = TestClient(app)
        resp = client.post(
            "/growth/cluster",
            json={
                "domain_id": "cnc-machining",
                "phrases": [
                    {"id": "p1", "phrase": "naya kaam", "count": 4, "vector": axis(0)}
                ],
                "anchors": [{"skill_id": "skill_turning", "vector": blend(0, 1, 0.65)}],
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["phrases_in"] == 1
        assert data["proposals"][0]["kind"] == "alias"
        assert data["proposals"][0]["skill_id"] == "skill_turning"

    def test_wrong_dimension_vector_is_422(self):
        client = TestClient(app)
        resp = client.post(
            "/growth/cluster",
            json={
                "domain_id": "d",
                "phrases": [{"id": "p1", "phrase": "x", "count": 1, "vector": [1.0] * 5}],
                "anchors": [],
            },
        )
        assert resp.status_code == 422

    def test_non_finite_vector_never_reaches_compute(self):
        # A NaN/inf vector would silently poison every cosine. The contract rejects it:
        with pytest.raises(ValidationError):
            GrowthClusterInput(
                domain_id="d",
                phrases=[],
                anchors=[
                    GrowthAnchor(skill_id="s", vector=[math.inf] + [0.0] * (DIM - 1))
                ],
            )
        # And over HTTP it can never 200: Python's json.loads accepts the non-standard
        # Infinity literal, so a hostile client CAN land inf on the server; the contract
        # 422s it (and if the error echo itself can't serialize inf, starlette turns
        # that into a 500 — either way the request FAILS before clustering runs).
        client = TestClient(app, raise_server_exceptions=False)
        vector = "[Infinity" + ", 0.0" * (DIM - 1) + "]"
        body = (
            '{"domain_id": "d", "phrases": [], '
            '"anchors": [{"skill_id": "s", "vector": ' + vector + "}]}"
        )
        resp = client.post(
            "/growth/cluster", content=body, headers={"content-type": "application/json"}
        )
        assert resp.status_code >= 400

    def test_phrase_cap_is_enforced(self):
        too_many = [
            GrowthPhrase(id=f"p{i}", phrase="x", count=1, vector=axis(0))
            for i in range(501)
        ]
        try:
            GrowthClusterInput(domain_id="d", phrases=too_many, anchors=[])
            raise AssertionError("expected validation error on >500 phrases")
        except ValueError:
            pass
