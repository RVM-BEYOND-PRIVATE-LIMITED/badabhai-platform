"""THE SIX "NEVER INVENT" GATES — the ai-service half of the double wall.

This is the FIRST wall. It runs here, before the parse response ever leaves the service, and the
identical six checks run again in `apps/api/src/profiling/parse-gates.ts` before anything is
persisted — the same double-wall discipline the domain match already uses. Two walls only mean
something if they say the same thing, so this module is a deliberate MIRROR of that file: same six
gate ids, same closed set of rejection reasons, same order, same bounds. `tests/test_parse_gates.py`
reads the TypeScript source and fails if any of that drifts.

PURE, and that is deliberate: `(output, input, certify) -> GateResult`. No settings, no I/O, no
clock. The PII certifier is INJECTED rather than imported so this module stays trivially testable
and the route supplies the real `pseudonymize`.

THE FRAMING IS THE ENFORCEMENT. The model is never asked "what is this worker's salary". It is
asked to TYPE AND CITE the answer the deterministic map already holds, and may add coverage only
from transcript spans. Each gate removes one way of answering that question dishonestly:

  1. PROVENANCE — the quote must literally appear in the cited message.
  2. ROLE — the cited message must be the WORKER's, never our own question.
  3. TYPE/RANGE — the value must be the right shape and a survivable magnitude.
  4. AGREEMENT — the deterministic map wins any disagreement, always.
  5. VOCABULARY — a field nobody asked for is dropped.
  6. PII — every surviving string is re-certified before it can be stored.

FAIL CLOSED, PER FIELD. A field that fails any gate is DROPPED and counted, never repaired and
never allowed through "mostly correct". Dropping is safe because of the property the whole design
rests on: the deterministic answer map alone is already a usable profile, so the LLM is an overlay
that can only ADD coverage. Losing an overlay field costs coverage; keeping a fabricated one costs
the worker their credibility with an employer.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from ..contracts import (
    AnswerRecord,
    EvidenceSpan,
    ParsedField,
    ProfileParseOutput,
    TargetField,
    TranscriptLine,
)
from .values import canonical_city

GateId = Literal["provenance", "role", "type_range", "agreement", "vocabulary", "pii"]

#: Which gate rejected a field. Ids and counts only — never values (§2).
GATE_IDS: tuple[GateId, ...] = (
    "provenance",
    "role",
    "type_range",
    "agreement",
    "vocabulary",
    "pii",
)

#: Every reason a gate may give, as a CLOSED SET. Mirrors `REJECTION_REASONS` in the TypeScript
#: wall; the parity test reads that array out of the .ts file and asserts this tuple is identical.
REJECTION_REASONS: tuple[str, ...] = (
    "message_index_out_of_range",
    "quote_not_in_message",
    "span_not_from_worker",
    "value_absent",
    "not_a_number",
    "not_a_string",
    "not_a_boolean",
    "not_an_array",
    "experience_years_out_of_range",
    "salary_out_of_range",
    "availability_not_in_enum",
    "value_not_in_enum",
    "disagrees_with_answer_map",
    "field_id_not_requested",
    "pii_blocked",
    "pii_altered",
    "gate_error",
)

#: The bounds the plan fixes. Stated once, here, mirrored in the TypeScript wall, parity-tested.
EXPERIENCE_YEARS_MIN = 0
EXPERIENCE_YEARS_MAX = 60
SALARY_INR_PER_MONTH_MIN = 1_000
SALARY_INR_PER_MONTH_MAX = 500_000
AVAILABILITY_VALUES: tuple[str, ...] = ("immediate", "notice_period", "not_looking", "unknown")

#: `(text) -> (blocked, certified_text)`. Injected because pseudonymization is a boundary concern;
#: this module stays pure and the route supplies the wall.
PiiCertifier = Callable[[str], tuple[bool, str]]


@dataclass(frozen=True)
class Rejection:
    field_id: str
    gate: GateId
    #: PII-FREE. A reason code from `REJECTION_REASONS`, never the offending value.
    reason: str


@dataclass
class GateResult:
    #: The fields that survived all six gates.
    accepted: dict[str, ParsedField] = field(default_factory=dict)
    rejections: list[Rejection] = field(default_factory=list)
    #: Field ids where the LLM disagreed with the deterministic map. The map's value stands; these
    #: feed `profile.parse_disagreement` (ids and counts only, never values).
    disagreements: list[str] = field(default_factory=list)
    #: `current_city` values gate 3 kept but the gazetteer does not recognise. Flagged, not dropped.
    unrecognized_cities: list[str] = field(default_factory=list)


_WHITESPACE_RE = re.compile(r"\s+")


def _normalize_whitespace(text: str) -> str:
    """The model reflows whitespace constantly — a newline becomes a space, a double space
    collapses — and rejecting on that would fail honest citations while catching no fabrications.
    Everything else about the quote must be literal."""
    return _WHITESPACE_RE.sub(" ", text).strip()


def _quote_appears_in(line: str, quote: str) -> bool:
    return _normalize_whitespace(quote) in _normalize_whitespace(line)


def _line_at(transcript: list[TranscriptLine], message_index: int) -> TranscriptLine | None:
    """The cited line, found BY ITS `i` — never by list position.

    The contract is explicit that "`i` is what evidence spans point at", and the difference is not
    academic here: this service DROPS any transcript line pseudonymization cannot mask, so list
    position and `i` diverge the moment one line is dropped. Indexing the list would then check the
    provenance and the ROLE of a different message than the one cited — which can pass an assistant
    line off as a worker line purely by offset.
    """
    for line in transcript:
        if line.i == message_index:
            return line
    return None


# ---------------------------------------------------------------------------
# Gate 1 — PROVENANCE
# ---------------------------------------------------------------------------


def check_provenance(evidence: EvidenceSpan, transcript: list[TranscriptLine]) -> str | None:
    """The quote must be a literal substring of the message it cites.

    THE STRONGEST GATE, because it inverts the burden: a hallucinated value has no span to point at.
    A model that invents "12 years" cannot produce a message containing it, so the fabrication is
    caught structurally rather than by anyone judging plausibility.
    """
    line = _line_at(transcript, evidence.message_index)
    if line is None:
        return "message_index_out_of_range"
    if not _quote_appears_in(line.text, evidence.quote):
        return "quote_not_in_message"
    return None


# ---------------------------------------------------------------------------
# Gate 2 — ROLE
# ---------------------------------------------------------------------------


def check_role(evidence: EvidenceSpan, transcript: list[TranscriptLine]) -> str | None:
    """The cited span must come from a `role: "worker"` line.

    THIS IS A DEFECT WE HAVE ALREADY PAID FOR: a controller question that listed example controllers
    produced five controllers for a worker who named one. The examples were in OUR text, the quote
    was perfectly real, and provenance alone happily passed it. Sourcing from the assistant's own
    words is how a system interviews itself.
    """
    line = _line_at(transcript, evidence.message_index)
    if line is None:
        return "message_index_out_of_range"
    if line.role != "worker":
        return "span_not_from_worker"
    return None


# ---------------------------------------------------------------------------
# Gate 3 — TYPE / ENUM / RANGE
# ---------------------------------------------------------------------------


def _is_real_number(value: Any) -> bool:
    """A number, and NOT a bool.

    TWO PYTHON-ONLY HAZARDS, neither of which exists on the TypeScript side:

    `isinstance(True, int)` is True, so without the bool check a `true` for `experience_years`
    reads as 1 year and sails through the range check. `typeof true === "boolean"` already handles
    that over there.

    `int` is ARBITRARY PRECISION, and `math.isfinite` converts its argument to a float — so a
    401-digit integer from the model raised `OverflowError` here, escaped `apply_parse_gates`, and
    turned a hallucination into an HTTP 500. A Python int is never inf or nan by construction, so
    it needs no finiteness check at all; only floats do. The magnitude is then the RANGE check's
    job, which compares int-to-int without ever touching a float.
    """
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value)


def check_type_range(field_id: str, value: Any, target: TargetField | None) -> str | None:
    """The value must be the declared type, inside the declared range, and inside the declared enum.

    `current_city` is the ONE field kept on failure rather than dropped: an unrecognized city is
    still evidence of where a worker lives, and deleting it would lose a strong matching signal over
    a gazetteer gap. It is reported by `is_city_unrecognized` so a human can extend the gazetteer,
    which is the recoverable direction.
    """
    if value is None:
        return "value_absent"

    if field_id == "experience_years":
        if not _is_real_number(value):
            return "not_a_number"
        if value < EXPERIENCE_YEARS_MIN or value > EXPERIENCE_YEARS_MAX:
            return "experience_years_out_of_range"
        return None

    if field_id in ("salary_expected", "salary_current"):
        if not _is_real_number(value):
            return "not_a_number"
        if value < SALARY_INR_PER_MONTH_MIN or value > SALARY_INR_PER_MONTH_MAX:
            # Catches the 12x period error in both directions: an annual figure read as monthly,
            # and a monthly figure read as annual.
            return "salary_out_of_range"
        return None

    if field_id == "availability":
        if not isinstance(value, str):
            return "not_a_string"
        if value not in AVAILABILITY_VALUES:
            return "availability_not_in_enum"
        return None

    if field_id == "current_city":
        if not isinstance(value, str) or not value.strip():
            return "not_a_string"
        # ALWAYS ACCEPTED once it is a non-empty string. Recognition is reported separately by
        # `is_city_unrecognized` — deliberately NOT a rejection.
        return None

    # Generic checks from the declared target, for every other field.
    if target is None:
        return None
    if target.type == "number" and not _is_real_number(value):
        return "not_a_number"
    if target.type == "boolean" and not isinstance(value, bool):
        return "not_a_boolean"
    if target.type == "string" and not isinstance(value, str):
        return "not_a_string"
    if target.type == "string_array":
        if not isinstance(value, list):
            return "not_an_array"
        # THE ITEMS, TOO. `isinstance(value, list)` alone let `["lathe", {"note": "call
        # 9876543210"}]` through as a valid string_array, and gate 6 then skipped the dict because
        # it only looked at string members — so a nested object walked out of the service with the
        # wall reporting all six counters at zero. A "string array" whose items are not strings is
        # not the declared type.
        if any(not isinstance(item, str) for item in value):
            return "not_a_string"
    if target.type == "enum":
        if not isinstance(value, str):
            return "not_a_string"
        if target.enum is not None and value not in target.enum:
            return "value_not_in_enum"
    return None


def is_city_unrecognized(field_id: str, value: Any) -> bool:
    """Did gate 3 accept `current_city` but fail to recognize it? Flagged, never dropped."""
    return field_id == "current_city" and isinstance(value, str) and canonical_city(value) is None


# ---------------------------------------------------------------------------
# Gate 4 — ANSWER-MAP AGREEMENT
# ---------------------------------------------------------------------------


def check_agreement(field_id: str, value: Any, answer_map: list[AnswerRecord]) -> str | None:
    """Where the deterministic map holds a live value, the LLM must agree with it — or be discarded.

    THIS IS THE MECHANISM THAT MAKES THE MODEL STRUCTURALLY INCAPABLE OF OVERRIDING THE RECORD. It
    can reformat, translate and type what the worker said; it cannot change it. Every other gate
    removes a way of inventing; this one removes the ability to contradict.

    Compared on the NORMALIZED value, and only against a live record — a `superseded` history entry
    is a value the worker themselves replaced, so a parse matching the NEW value must not be judged
    against the old one.
    """
    for record in answer_map:
        # `target_field if not None` — never `or`, which would also fall through on an empty
        # string and quietly re-key the record onto its question_key.
        key = record.target_field if record.target_field is not None else record.question_key
        if key != field_id:
            continue
        if record.status != "answered":
            continue
        if record.value_normalized is None:
            return None
        return None if _same_value(record.value_normalized, value) else "disagrees_with_answer_map"
    return None


def _same_value(a: Any, b: Any) -> bool:
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same_value(x, y) for x, y in zip(a, b, strict=True))
    # Case- and whitespace-insensitive for strings: "pune" and "Pune " are the SAME answer, and
    # treating them as a disagreement would discard a correct parse and emit a false event.
    if isinstance(a, str) and isinstance(b, str):
        return _normalize_whitespace(a).lower() == _normalize_whitespace(b).lower()
    # `True == 1` in Python. The TypeScript wall's `Object.is(true, 1)` is false, and the honest
    # reading is the TypeScript one: a boolean and a number are not the same answer.
    if isinstance(a, bool) != isinstance(b, bool):
        return False
    return a == b


# ---------------------------------------------------------------------------
# Gate 5 — CLOSED VOCABULARY
# ---------------------------------------------------------------------------


def check_vocabulary(field_id: str, targets: list[TargetField]) -> str | None:
    """A field id outside `target_fields` was never asked for, and is dropped and counted."""
    return None if any(t.field_id == field_id for t in targets) else "field_id_not_requested"


# ---------------------------------------------------------------------------
# Gate 6 — PII RE-CERTIFICATION
# ---------------------------------------------------------------------------


def check_pii(value: Any, certify: PiiCertifier) -> str | None:
    """EVERY string in the value, at ANY depth, goes back through pseudonymization; blocked or
    ALTERED ⇒ the whole field is rejected.

    ALTERED IS THE LOAD-BEARING WORD. "Blocked" catches the obvious case, but a value the
    pseudonymizer silently rewrites — a phone number turned into a token — is a value that CONTAINED
    PII, and storing the rewritten form would record that the worker said something they did not.

    AT ANY DEPTH is the other load-bearing phrase, and it was learned the hard way. An earlier
    version inspected only TOP-LEVEL strings, so `["lathe", {"note": "call 9876543210"}]` had the
    dict quietly filtered out of the list it was checking: the phone number was certified by
    nothing, the field was ACCEPTED, and the observability line reported all six gate counters at
    zero. `strings_in` walks lists, dicts, and dict KEYS — the model chooses those too — so there
    is no container shape in which a string can hide from this gate.
    """
    for item in strings_in(value):
        blocked, certified = certify(item)
        if blocked:
            return "pii_blocked"
        if certified != item:
            return "pii_altered"
    return None


def strings_in(value: Any) -> list[str]:
    """Every string reachable inside `value`, including dict keys. Order is deterministic.

    Shared with `parse_masking`, which needs exactly the same reach for the same reason: a leaf a
    walker cannot see is a leaf no wall can certify. JSON has no cycles and `json.loads` already
    refuses pathological nesting, so this recursion is bounded by the parser above it.
    """
    found: list[str] = []
    _collect_strings(value, found)
    return found


def _collect_strings(value: Any, found: list[str]) -> None:
    if isinstance(value, str):
        found.append(value)
    elif isinstance(value, list):
        for item in value:
            _collect_strings(item, found)
    elif isinstance(value, dict):
        for key, item in value.items():
            if isinstance(key, str):
                found.append(key)
            _collect_strings(item, found)


# ---------------------------------------------------------------------------
# The wall
# ---------------------------------------------------------------------------


def apply_parse_gates(
    output: ProfileParseOutput,
    answer_map: list[AnswerRecord],
    transcript: list[TranscriptLine],
    target_fields: list[TargetField],
    certify: PiiCertifier,
) -> GateResult:
    """Run all six gates over a parse output. Pure, total, and never raises.

    ORDER IS DELIBERATE, and identical to the TypeScript wall: vocabulary first (cheapest, and a
    field nobody asked for should not be examined at all), then provenance and role (which need no
    domain knowledge), then type, then agreement, then PII last — because PII re-certification is
    the only gate with a real cost, and it should only ever run on values that have already earned
    the right to be stored.
    """
    result = GateResult()

    for field_id, parsed in (output.fields or {}).items():
        # A null field is the model saying "I looked and found nothing citable" — an honest answer,
        # not a rejection, and not something to count as a failure.
        if parsed is None:
            continue
        try:
            _gate_one_field(
                field_id, parsed, result, answer_map, transcript, target_fields, certify
            )
        except Exception:  # noqa: BLE001 — see below; this is the totality guarantee, not a mask
            # "PURE, TOTAL, AND NEVER RAISES" IS A CLAIM THIS MAKES TRUE.
            #
            # It used to be an aspiration, and the difference cost a worker their whole parse: a
            # 401-digit integer from the model reached `math.isfinite`, which converts to float and
            # raised `OverflowError`, which escaped this function and returned HTTP 500. One
            # fabricated number took down every honest field in the same response — the exact
            # opposite of the per-field fail-closed design.
            #
            # That specific bug is fixed at its source in `_is_real_number`. This guard is the
            # STRUCTURAL version of the same lesson: an unforeseen exception must cost ONE field,
            # never the interview. Deliberately NOT silent — the field is DROPPED (never accepted)
            # and counted under its own `gate_error` reason, so a wall failing this way shows up in
            # the per-gate counters instead of looking like a clean pass.
            result.rejections.append(
                Rejection(field_id=field_id, gate="type_range", reason="gate_error")
            )

    return result


def _gate_one_field(
    field_id: str,
    parsed: ParsedField,
    result: GateResult,
    answer_map: list[AnswerRecord],
    transcript: list[TranscriptLine],
    target_fields: list[TargetField],
    certify: PiiCertifier,
) -> None:
    """One field through all six gates, in order. Appends to `result`; returns nothing.

    Extracted so the caller can wrap exactly one field's worth of work in the totality guard — a
    `try` around the whole loop would have let one bad field skip every field after it, which is a
    worse failure than the one being guarded against.
    """

    def reject(gate: GateId, reason: str) -> None:
        result.rejections.append(Rejection(field_id=field_id, gate=gate, reason=reason))

    vocabulary = check_vocabulary(field_id, target_fields)
    if vocabulary:
        reject("vocabulary", vocabulary)
        return

    provenance = check_provenance(parsed.evidence, transcript)
    if provenance:
        reject("provenance", provenance)
        return

    role = check_role(parsed.evidence, transcript)
    if role:
        reject("role", role)
        return

    target = next((t for t in target_fields if t.field_id == field_id), None)
    type_range = check_type_range(field_id, parsed.value, target)
    if type_range:
        reject("type_range", type_range)
        return

    agreement = check_agreement(field_id, parsed.value, answer_map)
    if agreement:
        # NOT merely a rejection: the deterministic value stands and this is reported so
        # `profile.parse_disagreement` can be emitted with ids and counts only.
        reject("agreement", agreement)
        result.disagreements.append(field_id)
        return

    pii = check_pii(parsed.value, certify)
    if pii:
        reject("pii", pii)
        return

    if is_city_unrecognized(field_id, parsed.value):
        result.unrecognized_cities.append(field_id)
    result.accepted[field_id] = parsed


def count_by_gate(rejections: list[Rejection]) -> dict[str, int]:
    """Rejection counts per gate — the shape observability wants. Ids and counts only."""
    counts = {gate: 0 for gate in GATE_IDS}
    for rejection in rejections:
        counts[rejection.gate] += 1
    return counts
