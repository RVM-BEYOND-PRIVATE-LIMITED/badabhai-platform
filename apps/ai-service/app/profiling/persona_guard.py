"""Runtime enforcement of the mechanically-checkable persona laws.

THE ARGUMENT FOR THIS FILE. A prompt is a request, not a guarantee. The old design did
not need one - a deterministic engine emitted the questions, so "under 20 words, one
question mark, never say bhai" were properties of a hand-written string. Now a model
writes every line a worker reads, and on its bad days it will write two questions, or
an exclamation mark, or "bhaiya". The persona spec is unusually mechanical, so most of
it survives as an OUTPUT CONTRACT instead of an aspiration.

WHAT IS ENFORCED (string-checkable, zero judgement):
  * exactly one "?" - Law 1
  * at most PROFILING_MAX_REPLY_WORDS words - Law 1
  * no banned vocative / tu-form / gush / promise / deictic - Laws 6, 7, 9, 10
  * no exclamation mark, no emoji - §3
  * acknowledgement from the closed set, at most 3 words - §3
  * appreciation budget across the conversation - §3
  * never re-ask an already-captured field - Law 8 / §5

WHAT IS NOT, AND WHY. "Never grade the person", "praise proportionate to the claim",
"same warmth, plainer voice for a trade we don't cover" are judgements. A keyword
heuristic for them would reject good turns, and a false rejection costs a real LLM call
and degrades a real worker's chat. Those stay in the prompt and are evaluated, never
asserted. Being honest about the boundary is what keeps this file trustworthy.

THE REPAIR LOOP lives in the endpoint, not here: this module only ever REPORTS. That
split matters because the repair costs money (one more real call) and the endpoint owns
the spend decision.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .persona import (
    ACKNOWLEDGEMENTS,
    APPRECIATIONS,
    GUARANTEE_LINE,
    MAX_ACK_WORDS,
    MAX_APPRECIATIONS_PER_CONVERSATION,
    MAX_QUESTION_MARKS,
    MIN_TURN_BEFORE_APPRECIATION,
    all_banned_tokens,
)

# "Bada Bhai" is the persona's NAME, so the bigram is removed before the vocative scan -
# the bot introduces itself, and a brand mention must not read as calling the worker
# "bhai". Same device for the sanctioned refusal: §5's own honest line opens with
# "Guarantee nahi de sakta", so the banned word "guarantee" appears in the one place it
# is allowed. Strip it first, then scan; otherwise the honest refusal fails the promise
# check and gets rewritten into the promise Law 9 forbids.
_BRAND_RE = re.compile(r"bada\s+bhai", re.IGNORECASE)
_SANCTIONED_REFUSAL_RE = re.compile(r"guarantee\s+nahi\s+de\s+sakta", re.IGNORECASE)

# The worker's own first name is interpolated downstream, so the placeholder is not a
# violation and must survive the scan intact.
_NAME_TOKEN_RE = re.compile(r"\{\{\s*worker_name\s*\}\}")

_EXCLAMATION_RE = re.compile(r"!")

# Emoji + pictographs. Deliberately a RANGE scan rather than a list: a list of emoji is
# out of date the day it is written.
_EMOJI_RE = re.compile(
    "["
    "\U0001f300-\U0001faff"  # symbols, pictographs, supplemental
    "\U00002600-\U000027bf"  # misc symbols + dingbats
    "\U0001f1e6-\U0001f1ff"  # regional indicators (flags)
    "\U00002190-\U000021ff"  # arrows
    "\U0000fe0f"  # variation selector-16
    "]",
    flags=re.UNICODE,
)


@dataclass
class GuardResult:
    """What the guard found. `ok` is the only thing the happy path reads.

    TWO PARALLEL LISTS, and the split is a privacy boundary rather than a convenience.
    ``violations`` are written FOR THE MODEL: they quote the offending words so the
    repair attempt knows what to change, which means one of them (the acknowledgement
    rule) interpolates a slice of the reply — and that branch fires precisely when the
    model paraphrased back what the worker just said. Those strings may go to the
    provider, which has already seen the text; they must NEVER go to a log line.
    ``codes`` are the same findings as a closed vocabulary, safe to log and to count.
    """

    ok: bool
    violations: list[str] = field(default_factory=list)
    #: Closed-set reason codes, one per violation, positionally aligned with
    #: ``violations``. Content-free by construction — this is what observability reads.
    codes: list[str] = field(default_factory=list)

    @property
    def summary(self) -> str:
        return "; ".join(self.violations)


def _scannable(reply: str) -> str:
    """The reply with the legitimate exceptions removed, ready to scan."""
    text = _NAME_TOKEN_RE.sub("", reply)
    text = _SANCTIONED_REFUSAL_RE.sub("", text)
    return _BRAND_RE.sub("", text)


def _has_word(text: str, word: str) -> bool:
    """Whole-word match. Load-bearing for the tu-form list: a substring scan for "tu"
    fires inside "status", "tube" and "tumhara"-free words like "situation", and a
    substring scan for "wah" fires inside "wahan"."""
    return re.search(rf"\b{re.escape(word)}\b", text, re.IGNORECASE) is not None


def check_turn(
    reply: str,
    *,
    max_words: int,
    turn_index: int = 1,
    appreciations_used: int = 0,
    previous_had_appreciation: bool = False,
    worker_said_dont_know: bool = False,
    already_captured: frozenset[str] | None = None,
    asked_field: str | None = None,
) -> GuardResult:
    """Check one reply against the enforceable persona laws.

    Every argument beyond `reply` exists for a STATEFUL law - the appreciation budget
    and the never-re-ask rule cannot be judged from a single line in isolation, which
    is precisely why they were the rules most likely to drift.
    """
    violations: list[str] = []
    codes: list[str] = []

    def _add(code: str, message: str) -> None:
        """Record one finding twice: a content-free CODE for logs, and a message for
        the model. Keeping them positionally aligned is what lets the endpoint log the
        codes and send the messages, with no risk of reaching for the wrong list."""
        codes.append(code)
        violations.append(message)

    text = _scannable(reply)
    words = text.split()

    # Law 1 - one question, one mark, bounded length, no preamble.
    marks = text.count("?")
    if marks == 0:
        _add("no_question", "no question was asked (every turn must ask exactly one)")
    elif marks > MAX_QUESTION_MARKS:
        _add("multi_question", f"{marks} question marks (exactly {MAX_QUESTION_MARKS} allowed)")
    if len(words) > max_words:
        _add("too_long", f"{len(words)} words (limit {max_words})")

    # §3 - punctuation and emoji are absolute.
    if _EXCLAMATION_RE.search(text):
        _add("exclamation", "contains an exclamation mark")
    if _EMOJI_RE.search(text):
        _add("emoji", "contains an emoji")

    # Laws 6, 7, 9, 10 - the never-says list.
    for token in all_banned_tokens():
        if _has_word(text, token):
            _add("banned_word", f"uses the banned word {token!r}")

    # §3 - the acknowledgement is a CLOSED set. Only checked when the reply opens with
    # something before the question; a reply that is purely a question is fine.
    lowered = text.lstrip().lower()
    if not lowered.startswith("?"):
        opener = text.split("?")[0]
        if opener and opener.strip() != text.strip():
            lead = opener.split()[: MAX_ACK_WORDS + 1]
            lead_text = " ".join(lead).lower()
            known = tuple(a.lower().rstrip(".") for a in ACKNOWLEDGEMENTS + APPRECIATIONS) + (
                "koi baat nahi",
                "samajh sakta hoon",
                GUARANTEE_LINE.split("—")[0].strip().lower(),
            )
            if lead_text and not any(lead_text.startswith(k) for k in known):
                # Advisory rather than hard: the model may open straight into the
                # question, which is legal. Only flag a lead-in that is neither a
                # sanctioned acknowledgement nor part of the question itself.
                first_sentence = opener.strip()
                if len(first_sentence.split()) <= MAX_ACK_WORDS and first_sentence.endswith("."):
                    _add(
                        "unknown_acknowledgement",
                        f"acknowledgement {first_sentence!r} is not in the closed set",
                    )

    # §3 - the appreciation budget, which is why this function takes conversation state.
    used_appreciation = any(_has_word(text, a.rstrip(".").split()[0]) for a in APPRECIATIONS)
    if used_appreciation:
        if turn_index < MIN_TURN_BEFORE_APPRECIATION:
            _add(
                "appreciation_too_early",
                f"appreciation before turn {MIN_TURN_BEFORE_APPRECIATION}",
            )
        if appreciations_used >= MAX_APPRECIATIONS_PER_CONVERSATION:
            _add(
                "appreciation_budget_spent",
                f"appreciation budget spent "
                f"({MAX_APPRECIATIONS_PER_CONVERSATION} per conversation)",
            )
        if previous_had_appreciation:
            _add("consecutive_appreciation", "consecutive appreciation")
        if worker_said_dont_know:
            _add("appreciation_after_dont_know", "appreciation on a 'nahi pata' turn")

    # Law 8 / §5 - never ask what has already been answered.
    if asked_field and already_captured and asked_field in already_captured:
        _add("re_asks_captured_field", f"re-asks {asked_field!r}, which is already answered")

    return GuardResult(ok=not violations, violations=violations, codes=codes)


def repair_instruction(result: GuardResult) -> str:
    """The correction handed back to the model for its ONE repair attempt.

    Quotes the specific broken rule rather than re-sending the whole persona: the model
    already had the persona and still broke it, so repeating it is not the correction.
    Naming the violation is."""
    return (
        "Your previous reply broke these rules: "
        + result.summary
        + ". Rewrite it. Same meaning, same question, obeying every rule. "
        "Return the same JSON object shape, nothing else."
    )


def count_appreciations(replies: list[str]) -> int:
    """How much of the appreciation budget the conversation has already spent.

    Computed from the transcript rather than tracked in state, so it stays correct
    across a resumed session where the in-memory counter would have been lost.
    """
    total = 0
    for reply in replies:
        text = _scannable(reply)
        if any(_has_word(text, a.rstrip(".").split()[0]) for a in APPRECIATIONS):
            total += 1
    return total
