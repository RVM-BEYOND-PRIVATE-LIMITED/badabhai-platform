"""Corpus consent gate (ADR-0018 Decision 1) — FAIL-CLOSED.

A worker's records enter the model-training corpus ONLY if their **latest**
``worker_consents`` row grants the ``model_training`` purpose AND is not revoked.
This mirrors the ``ConsentGuard`` chokepoint (ADR-0010): a single resolver is the
only path that can admit, and **everything ambiguous EXCLUDES** — missing,
malformed, expired-by-newer-row, revoked, or any error resolving consent.
"never include on doubt".

Pure logic over consent records so it is unit-testable without a live DB; the
offline batch supplies the records through a thin adapter.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime

# Mirrors CONSENT_PURPOSES in packages/types — the model-training purpose.
MODEL_TRAINING_PURPOSE = "model_training"


@dataclass(frozen=True)
class ConsentRecord:
    """One append-only ``worker_consents`` row (the fields the gate needs)."""

    worker_id: str
    consent_version: str
    purposes: tuple[str, ...]
    created_at: datetime
    revoked_at: datetime | None = None


@dataclass(frozen=True)
class ConsentDecision:
    """The gate's verdict for ONE worker. ``consent_version`` is stamped on every
    corpus item the worker contributes (auditability); it is ``None`` when excluded."""

    admitted: bool
    reason: str
    consent_version: str | None


def _latest(records: list[ConsentRecord]) -> ConsentRecord | None:
    """Newest row by ``created_at``. Returns None if the set is empty or any row
    has an unusable timestamp (→ caller excludes: fail-closed)."""
    if not records:
        return None
    for r in records:
        if not isinstance(r.created_at, datetime):
            return None
    return max(records, key=lambda r: r.created_at)


def resolve_consent(records: Iterable[ConsentRecord]) -> ConsentDecision:
    """Resolve ONE worker's model-training consent from their consent history.

    FAIL-CLOSED: any condition that is not an unambiguous, active, non-revoked
    ``model_training`` grant on the latest row → ``admitted=False``.
    """
    try:
        latest = _latest(list(records))
        if latest is None:
            return ConsentDecision(False, "no resolvable consent record", None)
        if latest.revoked_at is not None:
            return ConsentDecision(False, "latest consent revoked", None)
        if MODEL_TRAINING_PURPOSE not in tuple(latest.purposes or ()):
            return ConsentDecision(False, "model_training not in latest purposes", None)
        if not latest.consent_version:
            return ConsentDecision(False, "missing consent_version", None)
        return ConsentDecision(True, "active model_training consent", latest.consent_version)
    except Exception as exc:  # defensive: any error → exclude
        return ConsentDecision(False, f"consent resolution error: {exc}", None)
