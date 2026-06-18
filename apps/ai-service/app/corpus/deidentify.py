"""Corpus-grade de-identification (ADR-0018 Decision 2) — FAIL-CLOSED, exclude-on-doubt.

The privacy heart. A transcript is admitted to the corpus ONLY if it can be
de-identified cleanly; **anything that cannot be confidently cleaned is EXCLUDED**
(over-exclusion is the safe direction). On any excluded/blocked path the raw text
is NEVER returned and NEVER logged — only counts leave this module.

Two layers, both must pass:
  1. the request-time :func:`pseudonymize` gateway (PAN/Aadhaar/phone/employer/
     name-cue/city → tokens; fails closed on residual digit runs); then
  2. an INDEPENDENT corpus residual scan (defense in depth) that re-checks the
     cleaned text for phone/email/ID shapes and refuses any survivor.

``profile="ner"`` (a REAL, non-sample corpus) is **intentionally not implemented**:
it raises, because corpus-strength multilingual NER for free-text person/employer
names (TD3) must be pinned and security-signed-off before any real corpus is built.
``profile="sample"`` operates only on curated sample data whose PII is of the
cue-based shapes the v1 detector provably catches.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from app.pseudonymize import pseudonymize

DEID_VERSION = "corpus-deid-1:pseudonymize+residual-scan(sample)"

DeidProfile = Literal["sample", "ner"]

# Independent corpus residual scanners — anything matching the CLEANED text means
# masking missed PII → exclude. Deliberately broad (false-positives only exclude).
_RESIDUAL_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b"),          # PAN
    re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b"),        # Aadhaar
    re.compile(r"(?<!\d)\+?\d[\d\s\-]{6,}\d(?!\d)"),  # phone-like run
    re.compile(r"\d{7,}"),                           # any long digit run
    re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+"),         # email
)


@dataclass(frozen=True)
class DeidResult:
    """Outcome for ONE record. ``clean_text`` is populated ONLY when admitted."""

    admitted: bool
    clean_text: str | None
    reason: str
    deid_version: str


def _has_residual_pii(text: str) -> bool:
    return any(p.search(text) for p in _RESIDUAL_PATTERNS)


def deidentify_for_corpus(text: str, *, profile: DeidProfile = "sample") -> DeidResult:
    """De-identify ``text`` for corpus entry, fail-closed.

    Returns :class:`DeidResult`. When ``admitted`` is False, ``clean_text`` is None
    and ``reason`` carries NO source text (safe to log/count).
    """
    if profile == "ner":
        raise NotImplementedError(
            "corpus-grade NER de-identifier (TD3) is not pinned; real-corpus "
            "assembly is BLOCKED until it is built and security-signed-off (ADR-0018 §D2)."
        )
    try:
        if not isinstance(text, str) or not text.strip():
            return DeidResult(False, None, "empty or non-string input", DEID_VERSION)

        masked = pseudonymize(text)
        if masked.blocked:
            # reason is the gateway's category string — never the text itself.
            return DeidResult(
                False, None, f"pseudonymizer blocked: {masked.blocked_reason}", DEID_VERSION
            )

        if _has_residual_pii(masked.text):
            return DeidResult(False, None, "residual PII after masking", DEID_VERSION)

        return DeidResult(True, masked.text, "clean", DEID_VERSION)
    except Exception as exc:  # defensive: any error → exclude (no text in the reason)
        return DeidResult(False, None, f"de-id error: {type(exc).__name__}", DEID_VERSION)
