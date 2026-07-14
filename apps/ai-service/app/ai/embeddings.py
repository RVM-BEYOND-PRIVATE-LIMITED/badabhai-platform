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
    the caller SKIPS that row, leaving its embedding NULL for a later re-run."""

    vector: list[float] | None
    blocked: bool
    is_mock: bool
    model: str


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
        return EmbeddingResult(vector=None, blocked=True, is_mock=True, model=MOCK_MODEL)

    if settings.real_call_enabled_for(EMBEDDING_TASK_TYPE):
        vector = _real_embedding(result.text, settings)
        # Cost-track the real call (input tokens only — embeddings have no output tokens).
        in_tok = cost_tracker.estimate_tokens(result.text)
        cost_tracker.estimate_cost_inr(settings.embedding_model, in_tok, 0)
        return EmbeddingResult(
            vector=vector, blocked=False, is_mock=False, model=settings.embedding_model
        )

    return EmbeddingResult(
        vector=_mock_embedding(result.text), blocked=False, is_mock=True, model=MOCK_MODEL
    )


class AliasStore(Protocol):
    """The DB seam the batch reads/writes. The ai-service stays DB-free — the caller
    (a db-side runner with the owner connection) supplies this. `fetch_unembedded` MUST
    return only rows whose embedding is NULL, which is what makes the batch resumable."""

    def fetch_unembedded(self, limit: int) -> list[tuple[str, str]]:
        """Return up to ``limit`` (alias_id, text) rows whose embedding is NULL."""
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


def embed_aliases(
    store: AliasStore, settings: Settings, *, batch_size: int = 100, max_rows: int | None = None
) -> EmbedBatchReport:
    """Embed all NULL-embedding aliases (resumable, idempotent, pseudonymize-first).

    Idempotent: a re-run only sees rows still NULL, so a completed corpus is a no-op. A
    blocked (fail-closed) phrase is left NULL + counted, never embedded.
    """
    report = EmbedBatchReport(is_mock=not settings.real_call_enabled_for(EMBEDDING_TASK_TYPE))
    report.model = settings.embedding_model if not report.is_mock else MOCK_MODEL
    processed = 0
    while True:
        limit = batch_size
        if max_rows is not None:
            limit = min(limit, max_rows - processed)
        if limit <= 0:
            break
        rows = store.fetch_unembedded(limit)
        if not rows:
            break
        embedded_before = report.embedded
        for alias_id, text in rows:
            processed += 1
            res = embed_text(text, settings)
            if res.blocked or res.vector is None:
                report.blocked += 1
                report.blocked_alias_ids.append(alias_id)
                continue
            store.save_embedding(alias_id, res.vector)
            report.embedded += 1
            if not res.is_mock:
                report.estimated_cost_inr += cost_tracker.estimate_cost_inr(
                    settings.embedding_model, cost_tracker.estimate_tokens(text), 0
                )
        # Termination: stop if the store is drained (short batch) OR this batch made NO
        # progress — a full batch of BLOCKED rows stays NULL, so `fetch_unembedded` would
        # return the SAME rows forever otherwise (infinite loop). No progress ⇒ the rest
        # are unembeddable; leave them NULL for a later re-run once the blocker is fixed.
        if len(rows) < limit or report.embedded == embedded_before:
            break
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
