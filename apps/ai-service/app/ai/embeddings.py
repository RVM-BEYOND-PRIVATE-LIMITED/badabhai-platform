"""Skill-alias embedding generation (ADR-0030 / TAX-3) — the OFFLINE corpus embed.

Embeds skill_alias TEXT (aliases, not labels) into a vector(768) so TAX-4/TAX-6 can
nearest-neighbour against it. This is the offline corpus embed, NOT the request-path
worker/job embed (that is TAX-4/TAX-6).

INVARIANTS (ADR-0030):
- **SG-2**: every text is pseudonymized (fail-closed) BEFORE the embed call — even though
  skill phrases are PII-light, a residual employer name must never egress to the provider
  unmasked. A blocked phrase is skipped, never embedded.
- **SG-4**: the REAL provider call requires ``AI_ENABLE_REAL_CALLS`` + a key (staging-first,
  allowlisted per-task). The DEFAULT is a deterministic MOCK embedding, so the pipeline +
  TAX-4 tests run with ZERO spend.
- **SG-3**: these embeddings feed CANONICALIZATION (nearest-neighbour id assignment), NEVER
  ranking (ADR-0030 invariant-#4 boundary).
- Dimension **768** matches ``skill_alias.embedding`` (Vertex text-multilingual-embedding-002
  / the configured Gemini embedding model — confirm at the staging real run, §7).

The batch operates over an :class:`AliasStore` seam so the (DB-free by design) ai-service
does not gain a DB client here: the DB read/write of ``skill_alias`` is provided by the
caller. Resumable = ``fetch_unembedded`` only ever returns rows whose embedding is NULL.
"""

from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass, field
from typing import Protocol

import httpx

from ..config import Settings
from ..logging_config import get_logger
from ..pseudonymize import pseudonymize
from . import cost_tracker
from .model_config import rate_inr_per_1k

logger = get_logger("ai.embeddings")

# Dimension of the stored vector — MUST equal skill_alias.embedding vector(768).
EMBEDDING_DIMENSION = 768
# Task-type key for the per-task real-call allowlist (config.ai_real_call_tasks).
EMBEDDING_TASK_TYPE = "skill_embedding"
# Label recorded on mock rows (never a real spend).
MOCK_MODEL = "mock-embedding"

_GEMINI_EMBED_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
_TIMEOUT_SECONDS = 30.0


@dataclass
class EmbeddingResult:
    """One embed outcome. ``vector`` is None iff the text was blocked (fail-closed) —
    the caller SKIPS that row, leaving its embedding NULL for a later re-run.

    ``text`` is the PSEUDONYMIZED (safe) text that was actually embedded — the single
    place SG-2's output surfaces, so a caller (TAX-4 unresolved_phrase, cost accounting)
    reuses it WITHOUT re-pseudonymizing. It is None when blocked: a blocked phrase's
    ``pseudonymize().text`` still holds the residual PII that TRIGGERED the block, so it
    must never be handed back (fail-closed for the record path too)."""

    vector: list[float] | None
    blocked: bool
    is_mock: bool
    model: str
    text: str | None = None


def _mock_embedding(text: str) -> list[float]:
    """Deterministic hash -> 768-vector in [-1, 1). Same text -> same vector, so the
    seed is idempotent and TAX-4 tests run offline with zero spend. NOT semantically
    meaningful — a stand-in until the real provider is wired (§7)."""
    out: list[float] = []
    counter = 0
    while len(out) < EMBEDDING_DIMENSION:
        digest = hashlib.sha256(f"{text}:{counter}".encode()).digest()
        for i in range(0, len(digest), 4):
            (n,) = struct.unpack(">I", digest[i : i + 4])
            out.append((n / 2**32) * 2.0 - 1.0)
        counter += 1
    return out[:EMBEDDING_DIMENSION]


def _real_embedding(text: str, settings: Settings) -> list[float]:
    """Call the configured real embedding provider (Gemini ``embedContent``). Reached
    ONLY when SG-4 is satisfied. STAGING-UNVERIFIED until the first gated staging run
    (§7): the request/response shape + the exact model + 768-dim output are confirmed
    there. Never logs the text (pseudonymized, but still content)."""
    api_key = settings.gemini_flash_api_key
    if not api_key:
        raise RuntimeError("skill_embedding: real call enabled but GEMINI_FLASH_API_KEY unset")
    model = settings.embedding_model
    url = f"{_GEMINI_EMBED_BASE}/{model}:embedContent"
    body = {"model": f"models/{model}", "content": {"parts": [{"text": text}]}}
    headers = {"x-goog-api-key": api_key}  # header, never a ?key= (avoids URL-log leak)
    with httpx.Client(timeout=_TIMEOUT_SECONDS) as client:
        resp = client.post(url, headers=headers, json=body)
    if resp.status_code < 200 or resp.status_code >= 300:
        raise RuntimeError(f"skill_embedding provider HTTP {resp.status_code}")
    values = (resp.json().get("embedding") or {}).get("values") or []
    if len(values) != EMBEDDING_DIMENSION:
        raise RuntimeError(
            f"skill_embedding dim mismatch: got {len(values)}, expected {EMBEDDING_DIMENSION}"
        )
    return [float(v) for v in values]


def embed_text(text: str, settings: Settings) -> EmbeddingResult:
    """Pseudonymize (fail-closed) THEN embed. Mock by default; real only under SG-4."""
    # SG-2: pseudonymize FIRST — a blocked phrase is never sent to the provider.
    result = pseudonymize(text)
    if result.blocked:
        return EmbeddingResult(vector=None, blocked=True, is_mock=True, model=MOCK_MODEL, text=None)

    # ``result.text`` is the masked text — the ONLY thing the embedder ever sees, and the
    # safe text the caller reuses (never the raw ``text``).
    safe = result.text
    if settings.real_call_enabled_for(EMBEDDING_TASK_TYPE):
        vector = _real_embedding(safe, settings)
        return EmbeddingResult(
            vector=vector, blocked=False, is_mock=False, model=settings.embedding_model, text=safe
        )

    return EmbeddingResult(
        vector=_mock_embedding(safe), blocked=False, is_mock=True, model=MOCK_MODEL, text=safe
    )


class AliasStore(Protocol):
    """The DB seam the batch reads/writes. The ai-service stays DB-free — the caller
    (a db-side runner with the owner connection) supplies this. `fetch_unembedded` MUST
    return only rows whose embedding is NULL, which is what makes the batch resumable."""

    def fetch_unembedded(
        self, limit: int, exclude_ids: frozenset[str] = frozenset()
    ) -> list[tuple[str, str]]:
        """Return up to ``limit`` (alias_id, text) rows whose embedding is NULL AND whose
        id is NOT in ``exclude_ids``. The exclude set carries the rows this run already
        attempted-and-BLOCKED: a blocked row is never embedded, so it stays NULL and a
        naive ``WHERE embedding IS NULL LIMIT n`` would re-return it every batch — clogging
        the window (starving rows behind it) and re-counting it. Excluding them makes the
        batch strictly progress-or-stop. SQL shape: ``... WHERE embedding IS NULL AND id <>
        ALL($exclude) ORDER BY id LIMIT $limit``."""
        ...

    def save_embedding(self, alias_id: str, vector: list[float]) -> None:
        """Persist the vector for one alias (sets embedding for that row)."""
        ...


@dataclass
class EmbedBatchReport:
    embedded: int = 0
    blocked: int = 0
    is_mock: bool = True
    model: str = MOCK_MODEL
    estimated_cost_inr: float = 0.0
    blocked_alias_ids: list[str] = field(default_factory=list)
    # True when the REAL batch stopped early because the projected spend would exceed
    # the batch budget (TD64 interim guard). Remaining rows stay NULL — resume later.
    budget_stopped: bool = False


def embed_aliases(
    store: AliasStore,
    settings: Settings,
    *,
    batch_size: int = 100,
    max_rows: int | None = None,
    budget_inr: float | None = None,
) -> EmbedBatchReport:
    """Embed all NULL-embedding aliases (resumable, idempotent, pseudonymize-first).

    Idempotent: a re-run only sees rows still NULL, so a completed corpus is a no-op. A
    blocked (fail-closed) phrase is left NULL + counted, never embedded.

    ``budget_inr`` bounds the REAL batch's estimated spend (TD64 interim guard — the full
    SpendLedger reserve/record wiring is the precondition for the §7 staging run). Default
    = ``settings.ai_max_daily_cost_inr``. When the accumulated estimate reaches it the
    batch STOPS (``budget_stopped=True``); remaining rows stay NULL and a later run
    resumes. The mock path spends nothing and is never budget-stopped.
    """
    report = EmbedBatchReport(is_mock=not settings.real_call_enabled_for(EMBEDDING_TASK_TYPE))
    report.model = settings.embedding_model if not report.is_mock else MOCK_MODEL
    if budget_inr is None:
        budget_inr = settings.ai_max_daily_cost_inr
    processed = 0
    # Rows attempted this run and BLOCKED. They stay NULL (never embedded), so they must be
    # excluded from every subsequent fetch — otherwise a window of blocked NULL rows would
    # be re-returned forever (infinite loop) or re-counted each batch. Each iteration then
    # strictly makes progress: it either embeds >=1 clean row (that row leaves the NULL set)
    # or adds >=1 id to `blocked` (that id leaves the fetchable set) — so the loop always
    # drains and terminates.
    blocked: set[str] = set()
    while True:
        limit = batch_size
        if max_rows is not None:
            limit = min(limit, max_rows - processed)
        if limit <= 0:
            break
        fetched = store.fetch_unembedded(limit, frozenset(blocked))
        # Defensive vs a NON-CONFORMING store that ignores ``exclude_ids``: drop ids we
        # already attempted-and-blocked, so termination never depends on the store honoring
        # the contract (a mis-written SQL runner must not hang or double-count).
        rows = [(aid, text) for aid, text in fetched if aid not in blocked]
        if not rows:
            break
        for alias_id, text in rows:
            processed += 1
            res = embed_text(text, settings)
            if res.blocked or res.vector is None:
                report.blocked += 1
                report.blocked_alias_ids.append(alias_id)
                blocked.add(alias_id)  # exclude from future fetches — no re-count, no loop
                continue
            store.save_embedding(alias_id, res.vector)
            report.embedded += 1
            if not res.is_mock:
                # Cost on the PSEUDONYMIZED text actually sent (res.text), not the raw
                # input — accumulated UNROUNDED per row: alias texts are ~3-token strings
                # whose per-row estimate_cost_inr (4-dp rounding) is exactly 0.0, which
                # would zero the whole batch estimate AND blind the budget stop.
                in_rate, _out = rate_inr_per_1k(settings.embedding_model)
                tokens = cost_tracker.estimate_tokens(res.text or "")
                report.estimated_cost_inr += (tokens / 1000.0) * in_rate
                if report.estimated_cost_inr >= budget_inr:
                    # Hard stop: never let an unattended corpus batch spend past the budget.
                    report.budget_stopped = True
                    break
        if report.budget_stopped:
            break
    # Round once on the TOTAL (6 dp — embeds are sub-paisa) so the report is stable while
    # per-row accumulation stayed exact.
    report.estimated_cost_inr = round(report.estimated_cost_inr, 6)
    logger.info(
        "embed_aliases done",
        extra={
            "extra": {
                "embedded": report.embedded,
                "blocked": report.blocked,
                "is_mock": report.is_mock,
                "model": report.model,
            }
        },
    )
    return report
