"""Value normalizers — the Python side of the dual-language pair.

The TypeScript orchestrator (`packages/profiling-lexicon/src/values/`) is what runs these on the
live turn loop. This module exists so the two implementations can be asserted against ONE corpus
(`packages/profiling-lexicon/__fixtures__/utterances.jsonl`) by two suites — the same mechanism,
and the same reasoning, as `test_contract_parity.py`.

The detection logic is NOT reimplemented here: it is `signals.py`'s, unchanged and still the
shipped code. What this module adds is the SPAN — the character offsets of the match — which
`signals.py` never needed because its consumer only wanted the value.

The span is not cosmetic. It is what the Phase 7 parse call's provenance gate checks: a value
whose quote is not a literal substring of the transcript is rejected, which is what makes a
hallucinated value structurally impossible rather than merely unlikely.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Generic, TypeVar

from . import signals

T = TypeVar("T")

#: Digits the experience matcher accepts beyond ASCII. A quantity that MATCHED must not then
#: fail to convert and be silently dropped.
_DEVANAGARI_DIGITS = "०१२३४५६७८९"


@dataclass(frozen=True)
class Span:
    start: int
    end: int


@dataclass(frozen=True)
class NormalizedValue(Generic[T]):
    value: T
    span: Span
    #: True when the negation engine vetoed a match that would otherwise have fired.
    #: "abhi kaam nahi mil raha" must never become availability=immediate.
    negation_vetoed: bool


def _negation_spans(text: str) -> list[tuple[int, int]]:
    """Offsets of every negated span, recovered by diffing the masked text against the original.

    `_apply_negation` returns the MASKED STRING rather than the spans, and it is deliberately not
    changed here: it is shipped code on the extraction path. Masking replaces negated characters
    with spaces and preserves length, so a position-wise diff recovers the spans exactly.
    """
    masked, _topics = signals._apply_negation(text)
    spans: list[tuple[int, int]] = []
    start: int | None = None
    for i, (original, replaced) in enumerate(zip(text, masked, strict=True)):
        blanked = original != replaced and replaced == " "
        if blanked and start is None:
            start = i
        elif not blanked and start is not None:
            spans.append((start, i))
            start = None
    if start is not None:
        spans.append((start, len(text)))
    return spans


def _vetoed(text: str, start: int, end: int) -> bool:
    """Overlap, not containment: a negated span blanks whole tokens while a value span can start
    mid-token, so requiring containment would miss it."""
    return any(s < end and start < e for s, e in _negation_spans(text))


def _found(value: T, text: str, start: int, end: int) -> NormalizedValue[T]:
    return NormalizedValue(value, Span(start, end), _vetoed(text, start, end))


def canonical_city(text: str) -> NormalizedValue[str] | None:
    """Canonical city, resolved against the gazetteer. Aliases resolve INTO the closed set."""
    match = signals._CITY_RE.search(text or "")
    if not match:
        return None
    return _found(signals._canonical_city(match.group(0)), text or "", match.start(), match.end())


def canonical_state(text: str) -> NormalizedValue[str] | None:
    """Canonical state. Full names win over the case-sensitive two-letter abbreviations."""
    message = text or ""
    match = signals._STATE_NAME_RE.search(message)
    if match:
        name = signals._STATE_NAMES[match.group(0).lower()]
        return _found(name, message, match.start(), match.end())
    match = signals._STATE_ABBREV_RE.search(message)
    if match:
        return _found(signals._STATE_ABBREVS[match.group(0)], message, match.start(), match.end())
    return None


def canonical_region(text: str) -> NormalizedValue[str] | None:
    """A named multi-state region ("NCR", "South India"), or None. Whole phrases only."""
    message = text or ""
    match = signals._REGION_RE.search(message)
    if not match:
        return None
    region = signals._REGION_NAMES[match.group(0).lower()]
    return _found(region, message, match.start(), match.end())


def parse_experience_years(text: str) -> NormalizedValue[float] | None:
    """Years of experience, or None.

    Returns the first REGEX match, which is not the same as the first number in the string: the
    matcher requires the quantity to sit adjacent to the unit, so "7-8 saal" yields 8 — only the
    8 touches "saal". MEASURED, not assumed, and pinned by the corpus. Whether an uncertain range
    should record the lower end is a product decision, not something to change inside a refactor.
    """
    message = text or ""
    match = signals._EXPERIENCE_RE.search(message)
    if not match:
        return None
    quantity = match.group(1)
    value = signals._EXP_WORD_LOOKUP.get(quantity.lower())
    if value is None:
        # Devanagari digits reach here because the matcher accepts them; a quantity that MATCHED
        # must not then fail to convert and be silently dropped.
        normalized = "".join(
            str(_DEVANAGARI_DIGITS.index(c)) if c in _DEVANAGARI_DIGITS else c for c in quantity
        )
        try:
            value = float(normalized)
        except ValueError:
            return None
    return _found(float(value), message, match.start(), match.end())


def _salary_slot(text: str, *, expected: bool) -> NormalizedValue[int] | None:
    """The first salary filling one slot, or None.

    Reads `signals._iter_salaries` — the SAME generator `_detect_salary` consumes — so the period
    disambiguation is asserted here in exactly the form the extraction path runs it. First hit
    wins, matching `_detect_salary`'s first-writer-wins policy per slot.
    """
    message = text or ""
    for hit in signals._iter_salaries(message, message.lower()):
        if hit.expected == expected:
            return _found(hit.amount, message, hit.start, hit.end)
    return None


def salary_expected(text: str) -> NormalizedValue[int] | None:
    """Monthly rupees the worker is ASKING for — an expectation cue sits near the amount."""
    return _salary_slot(text, expected=True)


def salary_current(text: str) -> NormalizedValue[int] | None:
    """Monthly rupees the worker earns TODAY — no expectation cue near the amount."""
    return _salary_slot(text, expected=False)


def parse_salary_monthly(text: str) -> NormalizedValue[int] | None:
    """The single best monthly figure: the expected one when present, else the current one.

    Every question that reaches this normalizer asks what the worker WANTS, so "abhi 25000 milta
    hai, 35000 chahiye" answers `salary_expected` with 35000.
    """
    return salary_expected(text) or salary_current(text)


def parse_availability(text: str) -> NormalizedValue[dict[str, object]] | None:
    """Availability plus notice period, or None when the message states neither.

    IMMEDIATE WINS over a notice period when both fire: "abhi join kar sakta hu, 15 din me" is a
    worker saying they can start now. Never returns "not_looking"/"unknown" — those are the
    orchestrator's to record from a declined or unasked question, not inferences from free text.

    `negation_vetoed` is reported False rather than recomputed: the veto already ran inside the
    cue search, so a SURVIVING cue is by construction not negated. Recomputing it could only make
    the two disagree.
    """
    message = text or ""
    masked, _topics = signals._apply_negation(message)

    immediate = signals._first_immediate_cue(message, masked)
    if immediate is not None:
        start, end = immediate
        value: dict[str, object] = {"availability": "immediate", "noticeDays": None}
        return NormalizedValue(value, Span(start, end), False)

    notice = signals._first_notice_cue(message, masked)
    if notice is not None:
        start, end = notice
        days = signals._notice_period_days(message, masked)
        return NormalizedValue(
            {"availability": "notice_period", "noticeDays": days}, Span(start, end), False
        )
    return None


def parse_relocation_willingness(text: str) -> NormalizedValue[bool] | None:
    """Willingness to relocate, or None.

    Only ever returns True: a message with no cue returns None, because "did not say" is not
    "said no". Recording False from silence is the same fabrication this detector was rewritten
    to stop, pointing the other way.
    """
    message = text or ""
    masked, _topics = signals._apply_negation(message)
    cue = signals._first_relocate_cue(message, masked)
    if cue is None:
        return None
    start, end = cue
    return NormalizedValue(True, Span(start, end), False)


#: Fixture normalizer name -> implementation. Addressed by the TypeScript export name so one
#: corpus record reads identically from either side.
VALUE_BY_NAME = {
    "canonicalCity": canonical_city,
    "canonicalState": canonical_state,
    "canonicalRegion": canonical_region,
    "parseExperienceYears": parse_experience_years,
    "salaryExpected": salary_expected,
    "salaryCurrent": salary_current,
    "parseSalaryMonthly": parse_salary_monthly,
    "parseAvailability": parse_availability,
    "parseRelocationWillingness": parse_relocation_willingness,
}
