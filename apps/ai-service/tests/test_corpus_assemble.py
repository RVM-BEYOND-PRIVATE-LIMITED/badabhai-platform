"""Corpus assembly — schema contract + end-to-end consent/PII guarantees
(ADR-0018 §D2/§D4 build-blockers)."""

from __future__ import annotations

from datetime import UTC, datetime

from app.corpus.assemble import (
    CORPUS_ITEM_FIELDS,
    CORPUS_TEXT_FIELDS,
    CorpusItem,
    SourceRecord,
    assemble_corpus,
)
from app.corpus.consent_gate import ConsentRecord

_T0 = datetime(2026, 1, 1, tzinfo=UTC)
_SENTINEL = "my name is Ramesh Kumar, I worked at Sharma Engineering Works, call 9876543210"


def _consent(worker_id: str, granted: bool) -> ConsentRecord:
    return ConsentRecord(
        worker_id=worker_id,
        consent_version="2026-06-01",
        purposes=("profiling", "model_training") if granted else ("profiling",),
        created_at=_T0,
    )


def test_corpus_item_schema_is_pii_free_and_single_text_field():
    expected = {
        "source_kind", "source_ref", "worker_id", "consent_version",
        "deid_method", "deid_version", "content", "token_count", "lang",
    }
    assert CORPUS_ITEM_FIELDS == expected
    # The only free-text field is the de-identified `content`.
    assert CORPUS_TEXT_FIELDS == {"content"}
    # No field may hint at raw PII storage.
    forbidden = ("transcript", "raw", "phone", "body", "email", "audio", "address", "full_name")
    for fld in CORPUS_ITEM_FIELDS:
        assert not any(bad in fld for bad in forbidden), fld


def test_only_consented_workers_contribute_and_no_pii_leaks_into_corpus():
    records = [
        SourceRecord("w_yes", "voice_transcript", "vn1", _SENTINEL, "hi"),
        SourceRecord("w_no", "chat_message", "cm1", _SENTINEL, "hi"),
    ]
    consent = {
        "w_yes": [_consent("w_yes", granted=True)],
        "w_no": [_consent("w_no", granted=False)],
    }
    result = assemble_corpus(records, consent, profile="sample")

    assert result.admitted == 1
    assert result.excluded_no_consent == 1
    item = result.items[0]
    assert item.worker_id == "w_yes"
    assert item.consent_version == "2026-06-01"

    # No raw PII anywhere in the corpus content...
    for raw in ("Ramesh", "Sharma Engineering", "9876543210"):
        assert raw not in item.content
    # ...nor in the result's full repr (counts/provenance only, no excluded text).
    assert "Ramesh" not in repr(result)


def test_bad_records_are_counted_not_crashed():
    bad = SourceRecord("w_yes", "not_a_kind", "x", "hi", "hi")
    result = assemble_corpus([bad], {"w_yes": [_consent("w_yes", True)]}, profile="sample")
    assert result.admitted == 0
    assert result.excluded_bad_record == 1


def test_assembly_is_deterministic():
    records = [SourceRecord("w", "voice_transcript", "vn1", "CNC lathe operator 5 years", "hi")]
    consent = {"w": [_consent("w", True)]}
    a = assemble_corpus(records, consent, profile="sample")
    b = assemble_corpus(records, consent, profile="sample")
    assert a == b
    assert isinstance(a.items[0], CorpusItem)
