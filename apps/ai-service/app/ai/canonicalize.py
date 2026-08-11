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

import time
from typing import Protocol

from ..config import Settings
from ..contracts import AICallMetadata, SkillCanonicalization
from . import cost_tracker
from .embeddings import EMBEDDING_TASK_TYPE, embed_text

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
    started = time.perf_counter()
    emb = embed_text(phrase, settings)
    latency_ms = int((time.perf_counter() - started) * 1000)
    if emb.blocked or emb.vector is None:
        # NO METADATA ON A BLOCK (#745): the gate refused before the provider, so there is no
        # call to record. This is the one place that differs from a MOCK embed below — a mock
        # ran the pipeline and is reported with `real_call=False` (rupees already zeroed),
        # whereas a block attempted nothing at all. Emitting a zero-cost record here would put
        # a call that never happened into `ai.cost_recorded`.
        return SkillCanonicalization(status=UNRESOLVED)

    # #745: THE COST RECORD FOR THE EMBED, BUILT HERE BECAUSE THIS IS WHERE THE OUTCOME IS
    # KNOWN. The router only knows what it RESERVED; `emb` knows whether a provider was
    # actually reached (`is_mock`) and which model answered, and `real_call` has to follow the
    # money rather than the intent. Built on EVERY outcome below — matched, below-floor, and
    # no-candidate all paid for the same embed, so recording only the matches would under-count
    # exactly the phrases the vocabulary is worst at.
    #
    # Costs one `ai_call` log line per embed, including the `canonicalize_labels` fan-out on
    # `/profile/extract` where these calls were previously invisible. That is the point: they
    # were always real provider calls and were always unmeasured. `canonicalize_labels`
    # collects these onto `ProfileExtractionOutput.skill_embedding_metadata`, so the fan-out
    # reaches the same ledger as the single-phrase route rather than stopping at this log line.
    meta = cost_tracker.build_call_metadata(
        task_type=EMBEDDING_TASK_TYPE,
        model=emb.model,
        real_call=not emb.is_mock,
        # The MASKED text is what the provider was actually billed for, not the raw phrase.
        input_tokens=cost_tracker.estimate_tokens(emb.text or ""),
        output_tokens=0,
        latency_ms=latency_ms,
        success=True,
        settings=settings,
    )

    candidates = store.nearest_aliases(domain_id, emb.vector, top_k)
    if candidates:
        # Defensive: take the true max rather than trusting the store's DESC order — a future
        # runner that drops ORDER BY must not cause a valid >=floor match to be missed. SG-3
        # holds either way: any id chosen is still one the store returned, never invented.
        top_skill_id, top_score = max(candidates, key=lambda c: c[1])
        if top_score >= floor:
            return SkillCanonicalization(
                status=MATCHED,
                skill_id=top_skill_id,
                score=round(float(top_score), 6),
                ai_metadata=meta,
            )

    # Miss (no candidate, or top below floor): record the PSEUDONYMIZED text (emb.text, SG-1)
    # for later learning, then return UNRESOLVED. The raw phrase is never stored.
    store.record_unresolved(emb.text or "", domain_id, lang)
    return SkillCanonicalization(status=UNRESOLVED, ai_metadata=meta)


def canonicalize_labels(
    labels: list[str],
    domain_id: str,
    store: SkillCanonicalStore,
    settings: Settings,
    *,
    lang: str = "en",
) -> tuple[list[str], list[str], list[AICallMetadata]]:
    """Canonicalize a list of model-emitted skill LABELS. Returns ``(assigned_skill_ids,
    unresolved_labels, embed_cost_records)`` — assigned ids are de-duplicated in first-seen
    order; misses are recorded (pseudonymized) by the store. SG-3: only vector-assigned ids
    are returned, so an LLM-proposed phrase can NEVER inject an id the vector layer did not
    assign.

    THE THIRD RETURN VALUE IS THE #745 FIX ON THIS PATH, and it exists because the first
    version of that fix only covered one of the task type's two call paths.
    ``/skills/canonicalize`` returns ONE ``SkillCanonicalization`` and its ``ai_metadata``
    rides home on it, so the job-posting write could record its embeds. This function
    collapsed N results into ids-and-labels and dropped every ``ai_metadata`` on the floor,
    so the ``/profile/extract`` fan-out reached no ledger at all.

    That left the worst available shape: ``WHERE task_type = 'skill_embedding'`` returning
    SOME rows. An empty result reads as "not instrumented" and invites a look; a partial one
    reads as complete and does not. One record per embed, on every outcome, is the same rule
    ``canonicalize_skill`` already applies to matched-vs-miss, applied one level up.

    ONE ENTRY PER EMBED THAT REACHED THE PIPELINE — never per label, and never per pass. A
    blank label is skipped before any embed and contributes nothing; a pseudonymize-blocked
    label produces no metadata (nothing was attempted) and so contributes nothing either.
    The list is therefore <= the number of labels, and a caller must not infer either count
    from the other."""
    assigned: list[str] = []
    unresolved: list[str] = []
    cost_records: list[AICallMetadata] = []
    for label in labels:
        if not label or not label.strip():
            continue
        res = canonicalize_skill(label, domain_id, store, settings, lang=lang)
        if res.ai_metadata is not None:
            cost_records.append(res.ai_metadata)
        if res.status == MATCHED and res.skill_id is not None:
            if res.skill_id not in assigned:
                assigned.append(res.skill_id)
        else:
            unresolved.append(label)
    return assigned, unresolved, cost_records
