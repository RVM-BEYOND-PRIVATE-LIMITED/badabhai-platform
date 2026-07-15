"""Skill-phrase canonicalization (ADR-0030 / TAX-4) — deterministic, floor-gated, never
fabricates, always records a miss for later learning.

``canonicalize_skill(phrase, domain_id)`` → an ASSIGNED ``{skill_id, score}`` (top match at or
above the floor) or ``UNRESOLVED``. The pipeline is:

    pseudonymize (SG-2, fail-closed)  →  embed (TAX-3 adapter, MOCK by default)
      →  nearest skill_alias vectors IN THAT DOMAIN  →  floor gate:
         top.score >= FLOOR  →  return {skill_id, score}      (ASSIGN an existing id)
         else                →  record unresolved_phrase + return UNRESOLVED

INVARIANTS (ADR-0030):
- **SG-2**: every phrase is pseudonymized (fail-closed) BEFORE the embed — inherited from
  :func:`app.ai.embeddings.embed_text`. A blocked phrase is never embedded and never recorded
  (its text still holds the residual PII that blocked it), so it fails closed to UNRESOLVED.
- **SG-3**: this layer ASSIGNS a ``skill_id`` from the CLOSED ``skill_alias`` set — it never
  RANKS a worker/job and never INVENTS an id. ``skill_id`` is None unless the vector search
  returned it. The score is a match confidence, not a ranking (ADR-0030 invariant-#4 boundary).
- **SG-1**: a miss is recorded to ``unresolved_phrase`` using the PSEUDONYMIZED text only
  (never the raw phrase), so later learning (TAX-5) never sees raw PII.

The ai-service stays DB-free: the vector search + the unresolved upsert are a
:class:`SkillCanonicalStore` seam the caller supplies (a db-side runner / the backend).
:class:`NullSkillStore` is the safe default — no vocabulary, no recording — so an un-wired
extraction path keeps the raw phrase (status quo). The real DB-backed store + the real
embedding provider are §7/DB-wiring gated (TAX-3 SG-4).
"""

from __future__ import annotations

from typing import Protocol

from ..config import Settings
from ..contracts import SkillCanonicalization
from .embeddings import embed_text

MATCHED = "matched"
UNRESOLVED = "unresolved"


class SkillCanonicalStore(Protocol):
    """The DB seam canonicalization reads/writes. Supplied by the caller (the ai-service is
    DB-free). Both methods are DOMAIN-SCOPED — an alias in another domain must never be
    returned, and an unresolved miss is bucketed by ``(phrase, domain_id, lang)``."""

    def nearest_aliases(
        self, domain_id: str, query_vector: list[float], k: int
    ) -> list[tuple[str, float]]:
        """Return up to ``k`` ``(skill_id, score)`` for aliases WHERE ``domain_id`` matches,
        ``score = 1 - (embedding <=> $q)`` (cosine similarity), ordered DESC. SQL shape:
        ``SELECT skill_id, 1 - (embedding <=> $q) AS score FROM skill_alias WHERE domain_id=$d
        AND embedding IS NOT NULL ORDER BY embedding <=> $q LIMIT $k``. Domain scoping is the
        WHERE clause — the same phrase in the wrong domain returns no rows."""
        ...

    def record_unresolved(self, phrase: str, domain_id: str, lang: str) -> None:
        """Upsert ``unresolved_phrase`` (``phrase`` is ALREADY pseudonymized): insert a new
        row, or on the ``(phrase, domain_id, lang)`` unique key increment ``count`` and bump
        ``last_seen``. Records the miss for later learning (TAX-5). Stores no raw PII."""
        ...


class NullSkillStore:
    """Default store: empty vocabulary, no recording. Keeps an un-wired extraction path on the
    status quo — nothing canonicalizes, nothing is persisted, the raw phrase is kept. The real
    DB-backed store is the §7/DB-wiring runner."""

    def nearest_aliases(
        self, domain_id: str, query_vector: list[float], k: int
    ) -> list[tuple[str, float]]:
        return []

    def record_unresolved(self, phrase: str, domain_id: str, lang: str) -> None:
        return None


def canonicalize_skill(
    phrase: str,
    domain_id: str,
    store: SkillCanonicalStore,
    settings: Settings,
    *,
    lang: str = "en",
    top_k: int | None = None,
    floor: float | None = None,
) -> SkillCanonicalization:
    """Canonicalize one skill phrase within ``domain_id``. Returns a MATCHED result with the
    assigned ``skill_id`` + ``score`` (top score >= floor), else UNRESOLVED (miss recorded).

    Deterministic given the store + the (mock) embedder. Never fabricates a ``skill_id``:
    ``skill_id`` is only ever a value the vector search returned.
    """
    top_k = settings.skill_canonicalize_top_k if top_k is None else top_k
    floor = settings.skill_canonicalize_floor if floor is None else floor

    # SG-2: pseudonymize + embed (mock unless SG-4). A blocked phrase cannot be embedded and
    # its text still holds the residual PII that blocked it -> fail closed to UNRESOLVED and do
    # NOT record it (there is nothing safe to store).
    emb = embed_text(phrase, settings)
    if emb.blocked or emb.vector is None:
        return SkillCanonicalization(status=UNRESOLVED)

    candidates = store.nearest_aliases(domain_id, emb.vector, top_k)
    if candidates:
        # Defensive: take the true max rather than trusting the store's DESC order — a future
        # runner that drops ORDER BY must not cause a valid >=floor match to be missed. SG-3
        # holds either way: any id chosen is still one the store returned, never invented.
        top_skill_id, top_score = max(candidates, key=lambda c: c[1])
        if top_score >= floor:
            return SkillCanonicalization(
                status=MATCHED, skill_id=top_skill_id, score=round(float(top_score), 6)
            )

    # Miss (no candidate, or top below floor): record the PSEUDONYMIZED text (emb.text, SG-1)
    # for later learning, then return UNRESOLVED. The raw phrase is never stored.
    store.record_unresolved(emb.text or "", domain_id, lang)
    return SkillCanonicalization(status=UNRESOLVED)


def canonicalize_labels(
    labels: list[str],
    domain_id: str,
    store: SkillCanonicalStore,
    settings: Settings,
    *,
    lang: str = "en",
) -> tuple[list[str], list[str]]:
    """Canonicalize a list of model-emitted skill LABELS. Returns ``(assigned_skill_ids,
    unresolved_labels)`` — assigned ids are de-duplicated in first-seen order; misses are
    recorded (pseudonymized) by the store. SG-3: only vector-assigned ids are returned, so an
    LLM-proposed phrase can NEVER inject an id the vector layer did not assign."""
    assigned: list[str] = []
    unresolved: list[str] = []
    for label in labels:
        if not label or not label.strip():
            continue
        res = canonicalize_skill(label, domain_id, store, settings, lang=lang)
        if res.status == MATCHED and res.skill_id is not None:
            if res.skill_id not in assigned:
                assigned.append(res.skill_id)
        else:
            unresolved.append(label)
    return assigned, unresolved
