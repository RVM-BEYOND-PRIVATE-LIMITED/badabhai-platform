"""Conversational predicates — the Python side of the dual-language pair.

The TypeScript orchestrator (`packages/profiling-lexicon/src/predicates/index.ts`) is what
actually runs these on the live turn loop. This module exists so the two implementations can be
asserted against ONE corpus (`packages/profiling-lexicon/__fixtures__/utterances.jsonl`) by two
suites — the same mechanism, and the same reasoning, as `test_contract_parity.py`.

The individual detectors are NOT reimplemented here: they are `signals.py`'s, unchanged and
still the shipped ones. Both languages read the same cue data out of `lexicon_data/`, so what
this file adds is only the classification PRECEDENCE, which had no Python home before because
the old interview engine made the same decision inline and differently at each call site.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from . import lexicon, signals

UtteranceClass = Literal[
    "answer",
    "dont_know",
    "correction",
    "hardship",
    "question_back",
    "abusive",
    "empty",
    "off_topic",
]

# Characters that do not make a message meaningful on their own. Includes the Devanagari danda:
# `।` is a full stop in Hindi, so a worker who sends one has said exactly as much as one who
# sends ".".
_PUNCTUATION_ONLY_RE = lexicon.compile_pattern(
    {"source": "^[\\s.,;:!?'\"()\\[\\]{}\\-–—।|/\\\\]*$", "flags": ""}
)


@dataclass(frozen=True)
class UtteranceSignal:
    cls: UtteranceClass
    #: Which detector fired, for observability. NEVER carries worker text — this reaches logs.
    detector: str


def is_dont_know(text: str) -> bool:
    """"nahi pata", "pata nahi", "malum nahi". Delegates to the shipped detector."""
    return signals.is_dont_know(text)


def is_correction(text: str) -> bool:
    """"nahi nahi, 10 saal". Case-folded SUBSTRING matching — see predicates.json."""
    return signals.is_correction(text)


def is_hardship(text: str) -> bool:
    """Fires on personal hardship, never on hard work or an achievement."""
    return signals.is_hardship(text)


def is_abusive(text: str) -> bool:
    """Deliberately narrow. See predicates.json for what is excluded and why."""
    return signals.is_abusive(text)


def asks_question_back(text: str) -> bool:
    """"job milegi kya?" — both the prospect cue AND an interrogative shape must match."""
    return signals.asks_about_job_prospects(text)


def has_first_person_claim(text: str) -> bool:
    """TD98/TD101: does the worker claim this of THEMSELVES?"""
    return signals.has_first_person_claim(text)


def classify_utterance(text: str) -> UtteranceSignal:
    """Classify one worker message. PURE — no clock, no randomness, no I/O.

    The precedence order is the contract, and it is documented once, in
    `packages/profiling-lexicon/src/predicates/index.ts`. Changing it here without changing it
    there turns the parity corpus red, which is the point.

    ``answer`` is never returned: whether a message answers the question ON SCREEN depends on
    the question, which this function deliberately does not see. That judgement belongs to
    answer capture, which runs the value normalizers against the asked field.
    """
    message = text or ""

    if len(message.strip()) < 2 or _PUNCTUATION_ONLY_RE.search(message):
        return UtteranceSignal("empty", "empty")
    if is_abusive(message):
        return UtteranceSignal("abusive", "abuse")
    if is_correction(message):
        return UtteranceSignal("correction", "correction_markers")
    if is_dont_know(message):
        return UtteranceSignal("dont_know", "dont_know")
    if asks_question_back(message):
        return UtteranceSignal("question_back", "job_prospect")
    if is_hardship(message):
        return UtteranceSignal("hardship", "hardship")
    return UtteranceSignal("off_topic", "none")


#: Fixture predicate name -> implementation. The parity corpus addresses detectors by the
#: TypeScript export name so one record reads identically from either side.
PREDICATE_BY_NAME = {
    "isDontKnow": is_dont_know,
    "isCorrection": is_correction,
    "isHardship": is_hardship,
    "isAbusive": is_abusive,
    "asksQuestionBack": asks_question_back,
    "hasFirstPersonClaim": has_first_person_claim,
}
