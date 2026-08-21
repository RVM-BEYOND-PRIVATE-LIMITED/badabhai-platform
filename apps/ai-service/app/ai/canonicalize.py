"""Skill-phrase canonicalization (ADR-0030 / TAX-4) — deterministic, floor-gated, never
fabricates, always records a miss for later learning.

``canonicalize_skill(phrase, domain_id)`` → an ASSIGNED ``{skill_id, score}`` (top match at or
above the floor) or ``UNRESOLVED``. The pipeline is:

    pseudonymize (SG-2, fail-closed)  →  embed (TAX-3 adapter, MOCK by default)
      →  nearest skill_alias vectors IN THAT SCOPE  →  floor gate:
         top.score >= FLOOR  →  return {skill_id, score}      (ASSIGN an existing id)
         else                →  record unresolved_phrase + return UNRESOLVED

SCOPE (Phase 1.5 canonicalizer cutover): EXACTLY ONE of the LEGACY ``domain_id`` slug (reads
``skill_alias.domain_id``, which migration 0076 made nullable/legacy) or the CANONICAL
``job_domain_id`` (resolves through ``job_domain_skill``, so a skill with NO legacy slug is
still reachable). Neither is REFUSED, never widened to an unscoped search.

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
from ..contracts import AICallMetadata, SkillCanonicalization, exactly_one_skill_scope
from ..logging_config import get_logger
from . import cost_tracker
from .embeddings import EMBEDDING_TASK_TYPE, embed_text

logger = get_logger("ai.canonicalize")

MATCHED = "matched"
UNRESOLVED = "unresolved"


class SkillCanonicalStore(Protocol):
    """The DB seam canonicalization reads/writes. Supplied by the caller (the ai-service is
    DB-free). Both methods are DOMAIN-SCOPED — an alias outside the requested scope must never
    be returned, and an unresolved miss is bucketed by phrase, lang, and the ONE scope id it
    missed under.

    PHASE 1.5 — TWO SCOPES, EXACTLY ONE PER CALL. ``job_domain_id`` is KEYWORD-ONLY AND
    DEFAULTED so every pre-existing implementation (and every existing call site) keeps
    working untouched: ``canonicalize_skill`` only passes it when a canonical scope was
    actually requested, so the legacy path calls these methods with the SAME positional
    signature it always did."""

    def nearest_aliases(
        self,
        domain_id: str | None,
        query_vector: list[float],
        k: int,
        *,
        job_domain_id: str | None = None,
    ) -> list[tuple[str, float]]:
        """Return up to ``k`` ``(skill_id, score)``, ``score = 1 - (embedding <=> $q)``
        (cosine similarity), ordered DESC.

        CANONICAL scope (``job_domain_id`` set) — the Phase 1.5 path. Candidates come from
        the authoritative ``job_domain_skill`` link table, NOT from the legacy denormalized
        column, so a skill whose ``skill_alias.domain_id`` is NULL is still reachable::

            SELECT sa.skill_id, 1 - (sa.embedding <=> $q) AS score
            FROM skill_alias sa
            JOIN job_domain_skill jds ON jds.skill_id = sa.skill_id
            WHERE jds.job_domain_id = $jobDomainId
              AND jds.status = 'active'
              AND sa.embedding IS NOT NULL
            ORDER BY sa.embedding <=> $q LIMIT $k

        LEGACY/FALLBACK scope (``domain_id`` set) — UNCHANGED, byte for byte::

            SELECT skill_id, 1 - (embedding <=> $q) AS score FROM skill_alias
            WHERE domain_id = $d AND embedding IS NOT NULL
            ORDER BY embedding <=> $q LIMIT $k

        Scoping is the WHERE clause in both — the same phrase in the wrong domain returns no
        rows. NEITHER id set is NOT "search everything": it is a refusal (``[]``), enforced by
        ``canonicalize_skill`` before the embed and again in the HTTP store."""
        ...

    def record_unresolved(
        self,
        phrase: str,
        domain_id: str | None,
        lang: str,
        *,
        job_domain_id: str | None = None,
    ) -> None:
        """Upsert ``unresolved_phrase`` (``phrase`` is ALREADY pseudonymized): insert a new
        row, or on the unique key increment ``count`` and bump ``last_seen``. Records the
        miss for later learning (TAX-5). Stores no raw PII.

        SCOPED BY EXACTLY ONE ID, matching :meth:`nearest_aliases` — a miss is bucketed
        under the scope it missed IN, because "this phrase is unknown" is only a useful
        signal alongside "unknown to whom". Legacy misses key on
        ``(phrase, domain_id, lang)``; canonical misses key on
        ``(phrase, job_domain_id, lang)``, which migration 0078 made representable by
        adding the column and widening ``unresolved_phrase_scope_uq`` to include it.

        ``job_domain_id`` is KEYWORD-ONLY AND DEFAULTED for the same reason it is on
        :meth:`nearest_aliases`: a store written before this parameter existed keeps
        working untouched, because the legacy path still calls this method with the exact
        positional signature it always did."""
        ...


class NullSkillStore:
    """Default store: empty vocabulary, no recording. Keeps an un-wired extraction path on the
    status quo — nothing canonicalizes, nothing is persisted, the raw phrase is kept. The real
    DB-backed store is the §7/DB-wiring runner."""

    def nearest_aliases(
        self,
        domain_id: str | None,
        query_vector: list[float],
        k: int,
        *,
        job_domain_id: str | None = None,
    ) -> list[tuple[str, float]]:
        return []

    def record_unresolved(
        self,
        phrase: str,
        domain_id: str | None,
        lang: str,
        *,
        job_domain_id: str | None = None,
    ) -> None:
        return None


def _safe_nearest(
    store: SkillCanonicalStore,
    domain_id: str | None,
    vector: list[float],
    k: int,
    **scope: str | None,
) -> list[tuple[str, float]]:
    """The search, FAIL-SOFT. Any store failure degrades to ``[]`` → UNRESOLVED → the caller
    keeps the raw phrase; canonicalization NEVER blocks extraction or a job posting (TAX-8).

    :class:`HttpSkillStore` already swallows its own transport errors; this is the seam-level
    net for EVERY implementation, and Phase 1.5 is why it now exists here: a store written
    before the ``job_domain_id`` kwarg raises ``TypeError`` when asked for a canonical scope,
    and that must degrade like an outage rather than 500 a worker's profile turn. Logged
    (type only, never the phrase) so a store that silently answers nothing is still visible.
    """
    try:
        return store.nearest_aliases(domain_id, vector, k, **scope)  # type: ignore[arg-type]
    except Exception as exc:
        logger.warning(
            "skill store nearest_aliases failed (degrading to UNRESOLVED)",
            extra={"extra": {"error": type(exc).__name__, "canonical_scope": bool(scope)}},
        )
        return []


def _safe_record(
    store: SkillCanonicalStore,
    phrase: str,
    domain_id: str | None,
    lang: str,
    *,
    job_domain_id: str | None = None,
) -> None:
    """The miss upsert, FAIL-SOFT. Losing one growth-queue row is acceptable; failing a
    worker's turn for it is not. ``phrase`` is ALREADY pseudonymized (SG-1) and is never
    logged here — only the exception TYPE is.

    BOTH SCOPES QUEUE NOW. A canonical-scoped miss used to be dropped here: the api route
    required a non-null legacy ``domain_id`` because recording emitted the v1
    ``skill.phrase_unresolved`` event, whose payload declares ``domain_id: string``, and
    relaxing a shipped payload is a CLAUDE.md §3 non-negotiable. Migration 0078 plus
    ``skill.phrase_unresolved_v2`` closed that without touching v1 — the table models
    ``job_domain_id``, the unique index includes it, and the service picks the payload
    GENERATION by scope — so the miss now has a home and this function passes the id on.

    That matters more than one queue row. ``unresolved_phrase`` is the table built to catch
    retrieval failures, and while this path was closed, flipping the S3-C read switch would
    have made every Path A miss invisible in the one place that records misses — including
    to the shadow instrumentation whose abort thresholds are derived from exactly that
    volume.

    NEITHER id still skips the call: with no scope there is no bucket to record under, and
    posting anyway would spend a round trip to earn a 400 (the DTO's exactly-one-of refine).
    Unreachable from :func:`canonicalize_skill`, which refuses that shape before the embed;
    kept for a direct caller.

    THE LEGACY CALL IS BYTE-IDENTICAL — positional, no kwarg — so a store predating the
    parameter keeps working, and one asked for a canonical scope raises ``TypeError`` into
    the same net that absorbs an outage rather than failing a worker's turn.
    """
    if domain_id is None and job_domain_id is None:
        logger.info(
            "skill miss not queued: no scope to record it under",
            extra={"extra": {"scope": None}},
        )
        return
    try:
        if job_domain_id is not None:
            store.record_unresolved(phrase, domain_id, lang, job_domain_id=job_domain_id)
        else:
            store.record_unresolved(phrase, domain_id, lang)
    except Exception as exc:
        logger.warning(
            "skill store record_unresolved failed (miss not recorded)",
            extra={
                "extra": {
                    "error": type(exc).__name__,
                    "canonical_scope": job_domain_id is not None,
                }
            },
        )


def canonicalize_skill(
    phrase: str,
    domain_id: str | None,
    store: SkillCanonicalStore,
    settings: Settings,
    *,
    lang: str = "en",
    top_k: int | None = None,
    floor: float | None = None,
    job_domain_id: str | None = None,
) -> SkillCanonicalization:
    """Canonicalize one skill phrase within EXACTLY ONE scope — the legacy ``domain_id`` slug
    or the canonical ``job_domain_id`` (Phase 1.5). Returns a MATCHED result with the assigned
    ``skill_id`` + ``score`` (top score >= floor), else UNRESOLVED (miss recorded).

    Deterministic given the store + the (mock) embedder. Never fabricates a ``skill_id``:
    ``skill_id`` is only ever a value the vector search returned.

    ``job_domain_id`` is keyword-only and defaults to None, so every existing caller is
    byte-identical: same embed, same positional store call, same result.
    """
    top_k = settings.skill_canonicalize_top_k if top_k is None else top_k
    floor = settings.skill_canonicalize_floor if floor is None else floor

    # SCOPE GATE, BEFORE THE EMBED (fail-closed, and defence in depth behind the contract's
    # own exactly-one-of rule — this function is a library entry point too, not only an HTTP
    # handler). NEITHER id means there is no WHERE clause to scope by, and an unscoped search
    # would return the nearest alias in the ENTIRE vocabulary — a cook offered lathe skills.
    # BOTH means two scopes with no defined precedence. Either way: refuse before spending an
    # embed, touch no store, record nothing (there is no bucket to record under).
    if not exactly_one_skill_scope(domain_id, job_domain_id):
        logger.warning(
            "skill canonicalization refused: scope must be exactly one of "
            "domain_id / job_domain_id",
            extra={
                "extra": {
                    "has_domain_id": domain_id is not None,
                    "has_job_domain_id": job_domain_id is not None,
                }
            },
        )
        return SkillCanonicalization(status=UNRESOLVED)

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

    # THE LEGACY CALL IS UNTOUCHED: when no canonical scope was requested the store is called
    # with the exact positional signature it has always been called with, so a pre-Phase-1.5
    # store implementation (one whose `nearest_aliases` has no `job_domain_id` parameter)
    # keeps working. The kwarg is only ever sent when a `jd_*` scope was actually supplied.
    if job_domain_id is not None:
        candidates = _safe_nearest(
            store, domain_id, emb.vector, top_k, job_domain_id=job_domain_id
        )
    else:
        candidates = _safe_nearest(store, domain_id, emb.vector, top_k)
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
    #
    # THE MISS IS QUEUED UNDER THE SCOPE IT MISSED IN — the legacy slug or the `jd_*` id,
    # whichever the caller supplied, never both and never a fabricated substitute. Exactly
    # one of them is non-None here (enforced above), so `_safe_record` sees precisely the
    # scope this canonicalization ran under.
    #
    # A `jd_*` id is NOT written into the legacy `domain_id` column, and that remains the
    # rule this path is careful about: two id spaces in one column would silently break
    # every per-domain reader of the growth queue (`growth-cluster.ts` batches OPEN rows per
    # legacy slug). Migration 0078 gave the canonical scope its OWN column instead, and the
    # api picks `skill.phrase_unresolved_v2` for it rather than relaxing v1.
    #
    # WHAT STILL DOES NOT CONSUME THESE ROWS: `growth-cluster.ts` filters `domainId === null`
    # out of its open set, and a canonical row's legacy `domain_id` IS null — so the TAX-7
    # growth loop skips canonical misses today. That is a smaller gap than the one this
    # closes (the rows now EXIST, are attributed, and are countable by the S3-D shadow), and
    # teaching the growth runner the second scope is tracked separately: it is a clustering
    # decision, not a recording one.
    _safe_record(store, emb.text or "", domain_id, lang, job_domain_id=job_domain_id)
    return SkillCanonicalization(status=UNRESOLVED, ai_metadata=meta)


def canonicalize_labels(
    labels: list[str],
    domain_id: str | None,
    store: SkillCanonicalStore,
    settings: Settings,
    *,
    lang: str = "en",
    job_domain_id: str | None = None,
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
    from the other.

    ONE SCOPE FOR THE WHOLE FAN-OUT (Phase 1.5): every label is canonicalized under the same
    legacy ``domain_id`` OR the same canonical ``job_domain_id``, exactly one of which must be
    supplied. Neither ⇒ every label refuses before its embed (no spend, nothing recorded)."""
    assigned: list[str] = []
    unresolved: list[str] = []
    cost_records: list[AICallMetadata] = []
    for label in labels:
        if not label or not label.strip():
            continue
        res = canonicalize_skill(
            label, domain_id, store, settings, lang=lang, job_domain_id=job_domain_id
        )
        if res.ai_metadata is not None:
            cost_records.append(res.ai_metadata)
        if res.status == MATCHED and res.skill_id is not None:
            if res.skill_id not in assigned:
                assigned.append(res.skill_id)
        else:
            unresolved.append(label)
    return assigned, unresolved, cost_records
