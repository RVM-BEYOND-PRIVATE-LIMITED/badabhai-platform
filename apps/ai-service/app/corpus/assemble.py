"""Corpus assembly (ADR-0018 Decision 3/4) — consent-gated, de-identified, PII-FREE.

Joins raw source records (voice transcripts / chat messages, which carry PII and
stay in their own boundary) to per-worker consent, runs each admitted record
through the corpus de-identifier, and emits :class:`CorpusItem`s that carry
**PII-free provenance + the de-identified text ONLY**.

Contract (asserted by tests, ADR-0018 §D2 schema obligation):
  - a :class:`CorpusItem` has a FIXED field set; the ONLY text-bearing field is
    ``content`` (de-identified); there is no transcript/name/phone/raw field;
  - ``worker_id`` is a consent/revocation JOIN KEY only — never a feature, never
    placed in ``content``;
  - excluded records contribute COUNTS only — never text, never a logged sample.

Offline + deterministic: same inputs → same items.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, fields

from .consent_gate import ConsentRecord, resolve_consent
from .deidentify import DeidProfile, deidentify_for_corpus

SOURCE_KINDS = ("voice_transcript", "chat_message")


@dataclass(frozen=True)
class SourceRecord:
    """A raw record read offline. ``text`` is RAW PII — this module never writes,
    returns, or logs it; it exists only so de-id can consume it in-process."""

    worker_id: str
    source_kind: str
    source_ref: str  # opaque pointer to the origin row (e.g. voice_notes.id)
    text: str
    lang: str = "hi"


@dataclass(frozen=True)
class CorpusItem:
    """One de-identified corpus unit. PII-FREE: provenance + de-identified text only.

    The field set is the contract — see the schema test. ``content`` is the single
    text field and is de-identified by construction (it only exists on the admitted
    path out of the de-identifier)."""

    source_kind: str
    source_ref: str
    worker_id: str  # consent/revocation join key ONLY
    consent_version: str
    deid_method: str
    deid_version: str
    content: str  # de-identified text — the ONLY text field
    token_count: int
    lang: str


# The exact, allowlisted CorpusItem field set. The schema test pins this so no
# raw-text/PII column can ever be added without the test failing on purpose.
CORPUS_ITEM_FIELDS: frozenset[str] = frozenset(f.name for f in fields(CorpusItem))
# The ONLY field permitted to carry free text (already de-identified).
CORPUS_TEXT_FIELDS: frozenset[str] = frozenset({"content"})


@dataclass(frozen=True)
class AssemblyResult:
    """Build outcome. Excluded records are COUNTS only — no text retained."""

    items: tuple[CorpusItem, ...]
    admitted: int
    excluded_no_consent: int
    excluded_deid: int
    excluded_bad_record: int


def _token_count(text: str) -> int:
    return len(text.split())


def assemble_corpus(
    records: Iterable[SourceRecord],
    consent_by_worker: Mapping[str, Iterable[ConsentRecord]],
    *,
    profile: DeidProfile = "sample",
    deid_method: str = "regex+gazetteer+residual-scan",
) -> AssemblyResult:
    """Assemble a PII-free corpus from source records + per-worker consent history.

    ``profile="ner"`` is blocked at the de-identifier (real corpus needs TD3 +
    sign-off). Everything ambiguous is EXCLUDED and counted, never retained.
    """
    items: list[CorpusItem] = []
    no_consent = 0
    bad_record = 0
    excluded_deid = 0

    for rec in records:
        if (
            not isinstance(rec, SourceRecord)
            or rec.source_kind not in SOURCE_KINDS
            or not rec.worker_id
        ):
            bad_record += 1
            continue

        decision = resolve_consent(consent_by_worker.get(rec.worker_id, ()))
        if not decision.admitted or decision.consent_version is None:
            no_consent += 1
            continue

        deid = deidentify_for_corpus(rec.text, profile=profile)
        if not deid.admitted or deid.clean_text is None:
            excluded_deid += 1
            continue

        items.append(
            CorpusItem(
                source_kind=rec.source_kind,
                source_ref=rec.source_ref,
                worker_id=rec.worker_id,
                consent_version=decision.consent_version,
                deid_method=deid_method,
                deid_version=deid.deid_version,
                content=deid.clean_text,
                token_count=_token_count(deid.clean_text),
                lang=rec.lang,
            )
        )

    return AssemblyResult(
        items=tuple(items),
        admitted=len(items),
        excluded_no_consent=no_consent,
        excluded_deid=excluded_deid,
        excluded_bad_record=bad_record,
    )
