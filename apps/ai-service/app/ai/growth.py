"""Growth-loop clustering (ADR-0030 / TAX-7) — PURE COMPUTE, human-gated output.

Clusters below-floor ``unresolved_phrase`` rows (already PSEUDONYMIZED at rest — SG-1)
and proposes either an **alias on a NEAR existing skill** (cluster centroid lands in the
[band_low, floor) similarity band against the embedded ``skill_alias`` anchors) or a
**provisional skill** (no near anchor). Proposals are REPORT-ONLY:

- Nothing here writes a DB row, calls an LLM, or mints a ``skill_id``. **SG-5: a
  provisional-skill proposal carries NO id** — creating one is a human taxonomy decision
  in ``packages/taxonomy`` (skill-corpus / wedge-aliases + the ratification packet).
- **SG-3 holds:** the only ``skill_id`` a proposal may carry is one of the ANCHORS the
  caller supplied — the closed ``skill_alias`` set. This layer never invents and never
  ranks (invariant #4: proposals are vocabulary growth, not worker/job scoring).
- The ONLY activation path is the existing ratification flow: a human pastes the
  proposed entries into ``wedge-aliases.ts`` / the corpus (``ratified: false``), the RVM
  owner flips ``ratified``, the seed inserts, the embed runner backfills.

The db-side runner (``packages/db/src/growth-cluster.ts``, fork-B pattern — owner
connection) fetches the phrases + anchors and POSTs them to ``/growth/cluster``; this
module never touches the DB (the ai-service stays DB-free).

Clustering is DETERMINISTIC greedy leader clustering: phrases sorted by
``(count DESC, id ASC)``; each unassigned phrase in turn becomes a leader and absorbs
every unassigned phrase with cosine >= ``cluster_threshold`` against the LEADER vector
(single pass, order-stable). Eligibility guards (either satisfies): cluster size >=
``min_cluster_size`` OR summed phrase count >= ``min_total_count`` — so both a family
of variant phrasings and one high-frequency phrase surface, while one-off noise is
skipped. Never logs phrase text.
"""

from __future__ import annotations

import math

from ..config import Settings
from ..contracts import (
    GrowthClusterInput,
    GrowthClusterOutput,
    GrowthPhrase,
    GrowthProposal,
)

KIND_ALIAS = "alias"
KIND_PROVISIONAL = "provisional_skill"

_NOTE_DRIFT = (
    "Centroid scores AT/ABOVE the current floor — the corpus has likely grown since the "
    "miss was recorded. Verify, then ratify (still human-gated; nothing auto-activates)."
)
_NOTE_PROVISIONAL = (
    "No near skill in this domain. NO id is minted here (SG-5) — if this cluster is a "
    "real skill, a human adds it to packages/taxonomy (new immutable id) and re-seeds."
)


def _dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def _cosine(a: list[float], b: list[float]) -> float:
    na = math.sqrt(_dot(a, a))
    nb = math.sqrt(_dot(b, b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return _dot(a, b) / (na * nb)


def _centroid(members: list[GrowthPhrase]) -> list[float]:
    """Count-weighted mean of member vectors, L2-normalized. Falls back to the leader's
    vector if the weighted sum degenerates to (near-)zero norm."""
    dim = len(members[0].vector)
    acc = [0.0] * dim
    for m in members:
        w = float(m.count)
        for i, v in enumerate(m.vector):
            acc[i] += w * v
    norm = math.sqrt(sum(v * v for v in acc))
    if norm < 1e-12:
        return list(members[0].vector)
    return [v / norm for v in acc]


def _cluster(phrases: list[GrowthPhrase], threshold: float) -> list[list[GrowthPhrase]]:
    """Deterministic greedy leader clustering (see module docstring)."""
    ordered = sorted(phrases, key=lambda p: (-p.count, p.id))
    assigned: set[str] = set()
    clusters: list[list[GrowthPhrase]] = []
    for leader in ordered:
        if leader.id in assigned:
            continue
        assigned.add(leader.id)
        members = [leader]
        for cand in ordered:
            if cand.id in assigned:
                continue
            if _cosine(leader.vector, cand.vector) >= threshold:
                assigned.add(cand.id)
                members.append(cand)
        clusters.append(members)
    return clusters


def growth_cluster(inp: GrowthClusterInput, settings: Settings) -> GrowthClusterOutput:
    """Cluster + propose. Pure function of the input and the growth settings — no DB, no
    LLM, no randomness, no side effects. See the module docstring for the invariants."""
    min_cluster_size = (
        settings.skill_growth_min_cluster_size
        if inp.min_cluster_size is None
        else inp.min_cluster_size
    )
    min_total_count = (
        settings.skill_growth_min_total_count
        if inp.min_total_count is None
        else inp.min_total_count
    )
    threshold = (
        settings.skill_growth_cluster_threshold
        if inp.cluster_threshold is None
        else inp.cluster_threshold
    )
    band_low = settings.skill_growth_band_low if inp.band_low is None else inp.band_low
    floor = settings.skill_canonicalize_floor if inp.floor is None else inp.floor

    clusters = _cluster(list(inp.phrases), threshold)
    proposals: list[GrowthProposal] = []
    eligible = 0
    for members in clusters:
        total_count = sum(m.count for m in members)
        if len(members) < min_cluster_size and total_count < min_total_count:
            continue
        eligible += 1
        centroid = _centroid(members)

        nearest_skill_id: str | None = None
        nearest_score: float | None = None
        for anchor in inp.anchors:
            score = _cosine(centroid, anchor.vector)
            # Strict > keeps the winner stable for ties: anchors keep input order.
            if nearest_score is None or score > nearest_score:
                nearest_skill_id = anchor.skill_id
                nearest_score = score

        if nearest_score is not None and nearest_score >= band_low:
            kind = KIND_ALIAS
            # SG-3: the assigned id IS an anchor id — never invented.
            skill_id = nearest_skill_id
            note = _NOTE_DRIFT if nearest_score >= floor else None
        else:
            kind = KIND_PROVISIONAL
            skill_id = None  # SG-5: no id minted, ever.
            note = _NOTE_PROVISIONAL

        leader = members[0]
        proposals.append(
            GrowthProposal(
                kind=kind,
                skill_id=skill_id,
                leader_phrase=leader.phrase,
                member_ids=[m.id for m in members],
                member_phrases=[m.phrase for m in members],
                total_count=total_count,
                nearest_skill_id=nearest_skill_id,
                nearest_score=(
                    None if nearest_score is None else round(float(nearest_score), 6)
                ),
                note=note,
            )
        )

    return GrowthClusterOutput(
        proposals=proposals,
        phrases_in=len(inp.phrases),
        clusters_total=len(clusters),
        clusters_eligible=eligible,
        skipped_below_guards=len(clusters) - eligible,
    )
