"""Consent gate — FAIL-CLOSED, table-driven (ADR-0018 §D1 build-blocker)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.corpus.consent_gate import ConsentRecord, resolve_consent

_T0 = datetime(2026, 1, 1, tzinfo=UTC)


def _rec(purposes: tuple[str, ...], *, age_days: int = 0, revoked: bool = False) -> ConsentRecord:
    created = _T0 + timedelta(days=age_days)
    return ConsentRecord(
        worker_id="w1",
        consent_version="2026-06-01",
        purposes=purposes,
        created_at=created,
        revoked_at=(created + timedelta(hours=1)) if revoked else None,
    )


def test_active_model_training_consent_admits():
    d = resolve_consent([_rec(("profiling", "model_training"))])
    assert d.admitted is True
    assert d.consent_version == "2026-06-01"


@pytest.mark.parametrize(
    "records, why",
    [
        ([], "no records at all"),
        ([_rec(("profiling",))], "model_training not granted"),
        ([_rec(("model_training",), revoked=True)], "latest is revoked"),
        ([_rec(())], "empty purposes"),
    ],
)
def test_excludes_when_not_an_active_grant(records, why):
    assert resolve_consent(records).admitted is False, why


def test_latest_row_wins_newer_revocation_excludes():
    # An older grant + a newer revocation → excluded (revocation propagates).
    granted = _rec(("model_training",), age_days=0)
    revoked_later = _rec(("model_training",), age_days=10, revoked=True)
    assert resolve_consent([granted, revoked_later]).admitted is False


def test_latest_row_wins_newer_grant_admits():
    # An older non-grant + a newer grant → admitted on the latest row.
    old = _rec(("profiling",), age_days=0)
    new = _rec(("profiling", "model_training"), age_days=10)
    assert resolve_consent([old, new]).admitted is True


def test_unusable_timestamp_fails_closed():
    bad = ConsentRecord("w1", "2026-06-01", ("model_training",), created_at=None)  # type: ignore[arg-type]
    assert resolve_consent([bad]).admitted is False
