"""PER-MESSAGE pseudonymization for the parse call — and the fix for a live fail-closed defect.

`/profile/extract` pseudonymizes the CONCATENATED transcript in one call, and `pseudonymize`
refuses any input over `DEFAULT_MAX_LENGTH` (20,000 chars) as a fail-closed guard against a payload
nobody can reason about. Those two facts compose badly: a thorough interview crosses 20,000
characters somewhere around thirty turns, the whole gate returns `blocked`, and the worker gets an
EMPTY profile with no explanation — punished, precisely, for answering at length. The guard was
never wrong; applying it to a concatenation was.

So the parse call masks EACH MESSAGE ON ITS OWN, at `PARSE_MESSAGE_MAX_CHARS`. That bound is about
one utterance, not one interview, so length stops being a property of the conversation and becomes
a property of the message — and an interview of any length is now maskable.

A blocked leg is DROPPED AND COUNTED, NEVER FATAL. This is the same reasoning the chat turn already
applies to its history and captured state: the answer map plus the surviving transcript is still a
real profile, whereas failing the whole parse over one un-maskable line throws away every other
answer the worker gave. Strictly less leaves the service than before, which is the only direction
the privacy guarantee cares about.

`i` IS PRESERVED ON SURVIVORS. Dropping a line makes list position and `i` diverge, and `i` is what
evidence spans point at — which is exactly why the gates resolve a citation by `i` and never by
position.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..contracts import AnswerRecord, ProfileParseInput, TranscriptLine
from ..pseudonymize import pseudonymize
from .parse_gates import strings_in

#: The per-message bound. One worker utterance, not one interview. Deliberately far below
#: `pseudonymize.DEFAULT_MAX_LENGTH`: a single message this long is not something a worker typed or
#: dictated, so refusing it costs nothing real and bounds the masker's work per line.
PARSE_MESSAGE_MAX_CHARS = 4_000

#: `(text) -> (blocked, masked_text)`.
Masker = Callable[[str], tuple[bool, str]]


def default_masker(text: str) -> tuple[bool, str]:
    result = pseudonymize(text, max_length=PARSE_MESSAGE_MAX_CHARS)
    return result.blocked, result.text


def passthrough_masker(text: str) -> tuple[bool, str]:
    """The SYNTHETIC-PERSONA masker: nothing is masked and nothing is blocked (R7 §1).

    IT IS A FUNCTION IN THE PRODUCTION TREE AND THAT IS DELIBERATE. The alternative — a harness
    that monkey-patches ``default_masker``, or a copy of the extract handler that skips the
    masking line — is worse in the way that matters: it would drift from the shipped handler,
    and then the thing being measured would stop being the thing that ships.

    IT REACHES NO REAL WORKER. Selecting it requires ``AI_SYNTHETIC_PERSONA_MODE``, and the only
    routes that can select it are registered ONLY when that reason is set (``main.py``). The
    real-worker routes name ``default_masker`` directly and cannot be pointed at this one.

    WHY BYPASSING IS THE POINT rather than a convenience. Personas are invented — invented names,
    phones, employers, cities — so masking them measures the gateway, which already has its own
    tests, instead of measuring what the interview extracts. With the gateway in the way a
    persona's employer arrives as ``[EMPLOYER_1]`` and the sheet cannot be diffed against the
    ratified sample at all.
    """
    return False, text


@dataclass(frozen=True)
class MaskedAnswer:
    """One answer as the MODEL will see it. Not a contract type — this never leaves the process."""

    field_id: str
    #: The worker's own sentence, masked. `None` when masking refused it.
    value_raw: str | None
    #: The deterministic typed value, included ONLY when it is verbatim-clean (see below).
    value_normalized: Any | None
    turn: int


@dataclass
class MaskedParseInput:
    transcript: list[TranscriptLine] = field(default_factory=list)
    answers: list[MaskedAnswer] = field(default_factory=list)
    #: Counts only — the offending text is by definition un-maskable, so it is the last thing that
    #: may be logged.
    dropped_lines: int = 0
    dropped_raw_answers: int = 0
    withheld_normalized: int = 0


def mask_parse_input(
    body: ProfileParseInput,
    mask: Masker = default_masker,
) -> MaskedParseInput:
    """Mask every worker-derived surface of a parse request, one message at a time."""
    masked = MaskedParseInput()

    for line in body.transcript:
        blocked, text = mask(line.text)
        if blocked:
            masked.dropped_lines += 1
            continue
        masked.transcript.append(TranscriptLine(i=line.i, role=line.role, text=text))

    for record in body.answer_map:
        if record.status != "answered":
            # An `unanswered` record has nothing to type and a `declined` one is a complete answer
            # with no resume value. Neither belongs in a prompt that asks the model to cite a span.
            continue
        key = record.target_field if record.target_field is not None else record.question_key
        raw: str | None = None
        if record.value_raw:
            blocked, text = mask(record.value_raw)
            if blocked:
                masked.dropped_raw_answers += 1
            else:
                raw = text
        normalized, withheld = _publishable_normalized(record, mask)
        masked.withheld_normalized += withheld
        masked.answers.append(
            MaskedAnswer(
                field_id=key,
                value_raw=raw,
                value_normalized=normalized,
                turn=record.turn,
            )
        )

    return masked


def _publishable_normalized(record: AnswerRecord, mask: Masker) -> tuple[Any | None, int]:
    """The deterministic value, shown to the model only if EVERY string inside it is already clean.

    WHY "EVERY STRING INSIDE IT" AND NOT "IF IT IS A STRING". The first version of this checked
    `isinstance(value, str)` and let anything else through verbatim, on the reasoning that a
    non-string normalized value is server-computed closed-set data — a year count, a rupee figure,
    an availability enum, a boolean. That reasoning described the CURRENT producer, not the
    contract: `AnswerRecord.value_normalized` is typed `Any`, `TargetField.type` includes
    `string_array` in both walls, and `FIELD_CROSSWALK` declares six RFS fields as string arrays —
    among them `work_history`, whose own comment says §2 forbids storing employer names. A
    list-valued record therefore rendered straight into the prompt, and `router.run` joins the
    messages into the text it hands the Langfuse tracer. Measured: employer, person name, phone and
    Aadhaar all crossed the boundary unmasked. The route is the pseudonymization gateway; the
    guarantee has to be structural, not a bet on what today's caller happens to emit.

    WHY WITHHOLD RATHER THAN SUBSTITUTE THE MASKED FORM. Gate 4 compares the model's answer against
    the ORIGINAL `value_normalized`, so showing the model a REWRITTEN value would invite it to echo
    the rewrite and then reject that echo as a disagreement — a fabricated disagreement event about
    a field the worker answered correctly. Withholding costs the model a hint; the transcript still
    carries the answer.
    """
    value = record.value_normalized
    if value is None:
        return None, 0
    for leaf in strings_in(value):
        blocked, certified = mask(leaf)
        if blocked or certified != leaf:
            return None, 1
    return value, 0


def mask_transcript_lines(
    lines: list[TranscriptLine], mask: Masker = default_masker
) -> list[TranscriptLine]:
    """Mask a transcript PER MESSAGE, dropping only what the gateway refuses.

    The LLM-led interview's twin of `mask_parse_input`, for the two routes that carry a
    transcript and no answer map. Same bound and the same reason: `PARSE_MESSAGE_MAX_CHARS`
    per line, never one 20k blob, because a blob gate returns `blocked` for the WHOLE
    conversation once an interview gets long — which is how a thorough worker was handed an
    empty profile for the crime of answering at length.

    `i` IS PRESERVED ON SURVIVORS and never renumbered. It is a stable reference into the
    conversation the caller still holds, so closing the gaps would silently re-point every
    index that outlives this call.
    """
    out: list[TranscriptLine] = []
    for line in lines:
        blocked, text = mask(line.text)
        if blocked or not text.strip():
            continue
        out.append(TranscriptLine(i=line.i, role=line.role, text=text))
    return out
