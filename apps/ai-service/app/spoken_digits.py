"""Redact SPOKEN phone numbers from an ASR transcript (#747 leg (a)).

WHAT THIS CLOSES. ``pseudonymize.py`` masks a phone by its SHAPE — ``_PHONE_RE`` wants 9-13
digits, ``_RESIDUAL_DIGITS_RE`` wants 7+ consecutive ones — and both are Unicode-aware, so
Devanagari numerals (०-९) are already covered. What no net in this service could see is a worker
SPEAKING the number: saarika returns "nau aath saat ..." as WORDS, carrying no digit characters
at all, so the whole gateway passes it through and the number reaches the LLM boundary intact.

WHERE IT RUNS, AND WHY THERE. On the STT response inside this service, BEFORE the transcript is
translated (a real Sarvam egress), before it is returned to the backend, and therefore before it
is persisted anywhere. Redacting later would mean the raw number had already been stored, which
is the thing being prevented rather than a detail of it.

FAIL CLOSED. Any failure to LOAD the lexicon raises at import — a redactor that silently degrades
to a no-op is worse than one that is absent, because the boundary would look guarded. Any failure
to redact a candidate run is not possible by construction: detection and replacement are the same
pass over the same token list.

WHAT IT DELIBERATELY DOES NOT DO. It does not touch a run of one or two digit words. Digit words
are ordinary Hinglish speech — "do saal", "saade teen saal", "char logon ki team" — and a redactor
that fired on any of them would destroy exactly the answers this form exists to capture while
looking like a privacy win. The permitted cases are tested as hard as the forbidden ones.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

_DATA_PATH = Path(__file__).resolve().parent / "pii_data" / "spoken_digits.json"


def _load() -> tuple[frozenset[str], int, int, str]:
    """Read the lexicon. Raises at import if it is missing or malformed — see FAIL CLOSED."""
    raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    words: set[str] = set()
    for spellings in raw["digits"].values():
        for word in spellings:
            words.add(word.casefold())
    if not words:
        raise ValueError(f"{_DATA_PATH} defines no digit words")
    return (
        frozenset(words),
        int(raw["phoneShapedMinTokens"]),
        int(raw["phoneShapedMaxTokens"]),
        str(raw["placeholder"]),
    )


DIGIT_WORDS, _MIN_TOKENS, _MAX_TOKENS, PLACEHOLDER = _load()

# A token is a maximal run of NON-SEPARATOR characters. Matching the complement of a separator
# set, rather than a word class, keeps the original spacing and punctuation addressable so the
# redacted string can be rebuilt byte-for-byte around the removed span — the transcript is the
# worker's answer of record and must not be silently reformatted while one span is cut out.
#
# `\w+` IS THE WRONG TOOL HERE AND FAILED IN THE ONE SCRIPT THAT MATTERS MOST. Devanagari vowel
# signs are non-spacing marks: `'ौ'.isalnum()` is False, so Python's `\w` excludes them and
# `\w+` SHATTERS the word — "नौ" tokenises as "न", "सात" as "स" + "त". Roman "nau aath saat"
# matched fine while the identical Devanagari utterance produced fragments that matched nothing,
# which is precisely the shape saarika returns at `hi-IN`. A gate that fires on the test fixture
# and not on production output is worse than no gate.
#
# The Devanagari danda (।) and double danda (॥) are separators: they are sentence punctuation,
# not word characters, and are easy to omit because they are outside the ASCII set everyone
# reaches for.
_SEPARATORS = r"\s,\.;:!?।॥()\[\]{}\"'“”‘’/\\|+–—-"
_TOKEN_RE = re.compile(rf"[^{_SEPARATORS}]+", re.UNICODE)


@dataclass(frozen=True)
class Redaction:
    """The transcript with spoken phone numbers removed, and how many were removed.

    ``count`` is the ONLY thing that may be logged, evented or returned. The raw digits are
    exactly what this exists to keep out of those places.
    """

    text: str
    count: int


def _digit_value_length(token: str) -> int:
    """How many DIGITS this token contributes to a run, or 0 if it is not a digit token.

    A numeric token counts its own length, so a mixed utterance — "nau aath saat 9876543" —
    is measured as one run rather than falling between the spoken net and the numeric one.
    That seam is the obvious way to evade both.
    """
    if token.casefold() in DIGIT_WORDS:
        return 1
    if token.isdigit():
        return len(token)
    return 0


def redact_spoken_digits(text: str) -> Redaction:
    """Replace phone-shaped runs of spoken digits with the placeholder.

    Phone-shaped means 9-13 digit tokens in a row, which is the threshold ``_PHONE_RE`` already
    applies to numerals — one definition in this service rather than two that can drift.
    """
    if not text:
        return Redaction(text=text, count=0)

    tokens = list(_TOKEN_RE.finditer(text))
    if not tokens:
        return Redaction(text=text, count=0)

    # Walk maximal runs of adjacent digit tokens. "Adjacent" is by TOKEN, so whatever sits
    # between them — spaces, commas, a dash — does not break the run, mirroring the separator
    # tolerance `_PHONE_RE` already has.
    spans: list[tuple[int, int]] = []
    run_start_char: int | None = None
    run_end_char = 0
    run_digits = 0
    run_has_word = False

    def close_run() -> None:
        # A RUN OF PURE NUMERALS IS NOT THIS MODULE'S JOB, and claiming it caused a real
        # regression. `pseudonymize.py` already masks numeric phones, and it does so with
        # NUMBERED masks (`[PHONE_1]`) so a reader can correlate the same number across a
        # document. Firing here first replaced that with this module's flat `[PHONE]` —
        # duplicating a reviewed gate and silently changing a shipped mask label. The existing
        # egress-gate test caught it, which is the argument for having it.
        #
        # So: only a run containing at least one spoken WORD belongs to this module. That still
        # covers the seam worth closing — "nau aath saat chhe paanch 43210", which is
        # word-and-numeral mixed and would otherwise fall between the two nets.
        nonlocal run_start_char, run_digits, run_end_char, run_has_word
        if (
            run_start_char is not None
            and run_has_word
            and _MIN_TOKENS <= run_digits <= _MAX_TOKENS
        ):
            spans.append((run_start_char, run_end_char))
        run_start_char = None
        run_digits = 0
        run_has_word = False

    for match in tokens:
        token = match.group(0)
        contributed = _digit_value_length(token)
        if contributed:
            if run_start_char is None:
                run_start_char = match.start()
            if token.casefold() in DIGIT_WORDS:
                run_has_word = True
            run_digits += contributed
            run_end_char = match.end()
            # A run longer than a phone number is not a phone number — an id, a recital, a
            # miscount — and the upper bound in `close_run` is the whole of that rule. An
            # earlier version also RESET the run on overflow so a trailing sub-run could still
            # match. No test could tell the two apart (the bound already refuses a 20-word run),
            # and what the reset actually changed — where a phone-shaped window inside a longer
            # contiguous recital gets cut — is a judgement nothing here justifies. Removed
            # rather than kept with a test invented to protect it.
        else:
            close_run()
    close_run()

    if not spans:
        return Redaction(text=text, count=0)

    out: list[str] = []
    cursor = 0
    for start, end in spans:
        out.append(text[cursor:start])
        out.append(PLACEHOLDER)
        cursor = end
    out.append(text[cursor:])
    return Redaction(text="".join(out), count=len(spans))
