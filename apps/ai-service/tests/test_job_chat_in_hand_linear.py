"""Code scanning alert #31 (py/polynomial-redos) — the "in hand" / "take home" cue is linear.

THE DEFECT: `in\\s*-?\\s*hand` and `take\\s*-?\\s*home`. With no dash the two `\\s*` split the same
whitespace run every possible way before the word after it fails, so "in" or "take" followed by
k spaces cost O(k^2) at every such start. Measured 2026-11-20 on a laptop: `_PAY_ANSWER_WORD_RE`
(reached through `pay_text_for` on the payer's pay answer) took 42 ms at 4,000 characters and
1.9 s / 6.2 s at 20,000 ("in" / "take"); `_PAY_BASIS_KINDS["in_hand"]`, the same text unflagged,
took 5.1 s. The pattern appeared at four sites in `answers.py`.

THE FIX: `\\s*(?:-\\s*)?` — the dash owns the whitespace after it, so a run has exactly one split.
It matches exactly the strings the old text matched (whitespace, an optional dash, whitespace),
and section 1 checks that every shipped pattern's matches (spans and groups) are identical to the
old text's on a fixed list and a seeded generator.

FOUND ALONGSIDE (not flagged): `_PAY_TYPE_AFTER_RES` opened with `\\s*,?\\s*(?:PERIOD)?\\s*,?\\s*`,
four `\\s*` in a row once the optionals are empty: 75 ms at 50 spaces, 1.9 s at 100, 56 s at 200.
Latent — `_cross_topic_pay_type` collapses whitespace before matching — but one refactor from
live. Same fix (each optional piece owns the whitespace after it), same oracle.

Stdlib and pytest only. All inputs are fabricated.
"""

from __future__ import annotations

import random
import re
import signal
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager

import pytest

from app.job_posting_chat import answers

_OLD = r"\s*-?\s*"
_NEW = r"\s*(?:-\s*)?"


def _shipped_patterns() -> dict[str, re.Pattern[str]]:
    """Every compiled pattern `answers` holds (directly or in a dict) that carries the fix."""
    found: dict[str, re.Pattern[str]] = {}
    for name, value in vars(answers).items():
        items = value.items() if isinstance(value, dict) else [(None, value)]
        for key, pattern in items:
            if isinstance(pattern, re.Pattern) and _NEW in pattern.pattern:
                found[name if key is None else f"{name}[{key}]"] = pattern
    return found


SHIPPED = _shipped_patterns()


def _old(pattern: re.Pattern[str]) -> re.Pattern[str]:
    return re.compile(pattern.pattern.replace(_NEW, _OLD), pattern.flags)


def test_the_fix_reaches_every_site() -> None:
    names = set(SHIPPED)
    assert {
        "_PAY_ANSWER_WORD_RE",
        "_PAY_BASIS_KINDS[in_hand]",
        "_PAY_TYPE_ANSWER_RES[in_hand]",
    } <= names
    # The cross cues are compiled into the before/after patterns.
    assert any(n.startswith("_PAY_TYPE_AFTER_RES") for n in names)
    for name, value in vars(answers).items():
        items = value.items() if isinstance(value, dict) else [(None, value)]
        for _, pattern in items:
            if isinstance(pattern, re.Pattern):
                assert _OLD not in pattern.pattern, name
            elif isinstance(pattern, str):
                assert _OLD not in pattern, name


# --- 1. the same matches as the old text --------------------------------------------------------

KNOWN = [
    "in hand",
    "inhand",
    "in-hand",
    "in - hand",
    "in  -\thand",
    "in\n-\nhand",
    "in--hand",
    "in -  - hand",
    "take home",
    "take-home",
    "take  -  home",
    "takehome",
    "20-25k in hand",
    "salary 18000 in hand per month",
    "CTC 3 lakh, take home 22k",
    "it is in-hand salary",
    "good in hand tools",
    "in - hand work",
    "in hand - tools",
    "in" + " " * 50 + "x",
    "take" + " " * 50 + "-" + " " * 50 + "home",
]

_PIECES = [
    "in",
    "take",
    "hand",
    "home",
    " ",
    "  ",
    "\t",
    "\n",
    "-",
    "--",
    "20k",
    "salary",
    "x",
    "tools",
]


def _samples() -> list[str]:
    rng = random.Random(31)
    return KNOWN + [
        "".join(rng.choice(_PIECES) for _ in range(rng.randint(1, 9))) for _ in range(5_000)
    ]


def _matches(pattern: re.Pattern[str], text: str) -> list[tuple[tuple[int, int], tuple]]:
    return [(m.span(), m.groups()) for m in pattern.finditer(text)]


@pytest.mark.parametrize("name", list(SHIPPED))
def test_each_pattern_matches_exactly_as_the_old_text(name: str) -> None:
    new = SHIPPED[name]
    old = _old(new)
    assert old.pattern != new.pattern
    for text in _samples():
        assert _matches(new, text) == _matches(old, text), text
        assert bool(new.fullmatch(text)) == bool(old.fullmatch(text)), text


#: `_PAY_TYPE_AFTER_RES` as it was spelled before this fix: four `\s*` in a row once the optional
#: comma and period are empty, catastrophic on a whitespace run (56 s at 200 spaces).
_OLD_AFTER_PREFIX = r"\s*,?\s*(?:(?:per\s+month|pm|p\.m\.?|monthly|/\s*month)(?![a-z]))?\s*,?\s*"
_AFTER_PIECES = [
    " ",
    "  ",
    "\t",
    ",",
    ", ",
    "pm",
    "p.m.",
    "per month",
    "monthly",
    "/ month",
    "/month",
    "in hand",
    "in-hand",
    "take home",
    "net salary",
    "gross pay",
    "ctc",
    "c.t.c",
    "x",
    "tools",
]


def test_the_after_cue_matches_exactly_as_the_old_text() -> None:
    rng = random.Random(1183)
    # Short pieces only: the old prefix is exponential past ~50 spaces.
    samples = [
        "".join(rng.choice(_AFTER_PIECES) for _ in range(rng.randint(1, 7))) for _ in range(5_000)
    ]
    samples += [
        " pm, in hand",
        ", per month in hand",
        " , monthly , take home",
        "  ,  ctc",
        " gross pay",
    ]
    for kind, body in answers._PAY_TYPE_CROSS_CUES.items():
        new = answers._PAY_TYPE_AFTER_RES[kind]
        old = re.compile(_OLD_AFTER_PREFIX + answers._cue(body))
        assert old.pattern != new.pattern
        hits = 0
        for text in samples:
            for pos in range(len(text) + 1):  # the caller matches at a figure's end
                got, want = new.match(text, pos), old.match(text, pos)
                assert (got and got.span()) == (want and want.span()), (kind, text, pos)
                hits += got is not None
        assert hits > 100, kind  # the oracle saw real matches, not only misses


def test_the_samples_exercise_the_dash_and_the_runs() -> None:
    # Guards the guard: the oracle proves less than it claims if no sample matches with a dash
    # or across a whitespace run.
    word = SHIPPED["_PAY_ANSWER_WORD_RE"]
    hits = [m.group(0) for t in _samples() for m in word.finditer(t)]
    assert any("-" in h and ("in" in h or "take" in h) for h in hits)
    assert any(re.search(r"\s{2,}", h) for h in hits)


# --- 2. timing: linear in the run ---------------------------------------------------------------

#: The fix takes well under 1 ms at 20k; the old text took 1.9-6.2 s. 50 ms + 15 ms per 1,000
#: characters (200 ms at 10k, 350 ms at 20k) leaves a slow CI runner 100x+ headroom and is still
#: far below the old text. A hard per-test timeout stops a regression from stalling the suite.
_FLOOR_MS = 50.0
_MS_PER_1K = 15.0
_TIMEOUT_S = 30.0
_RUNS = (10_000, 20_000)


def _budget_s(k: int) -> float:
    return (_FLOOR_MS + _MS_PER_1K * k / 1_000) / 1_000


@contextmanager
def _hard_timeout(seconds: float) -> Iterator[None]:
    """Fail after `seconds`, even inside a regex. SIGALRM is POSIX and main-thread only;
    elsewhere the timing bound alone applies."""
    if (
        not hasattr(signal, "setitimer")
        or threading.current_thread() is not threading.main_thread()
    ):
        yield
        return

    def _expire(signum: int, frame: object) -> None:
        raise TimeoutError(f"hard timeout: {seconds:.0f} s")

    previous = signal.signal(signal.SIGALRM, _expire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def _best_of_3(fn: Callable[[str], object], text: str) -> float:
    best = float("inf")
    with _hard_timeout(_TIMEOUT_S):
        for _ in range(3):
            start = time.perf_counter()
            fn(text)
            best = min(best, time.perf_counter() - start)
    return best


@pytest.mark.parametrize("k", _RUNS)
@pytest.mark.parametrize("head", ["in", "take", "in -", "take-"])
@pytest.mark.parametrize("name", [n for n in SHIPPED if not n.startswith("_PAY_TYPE_AFTER_RES")])
def test_each_pattern_is_linear_on_a_whitespace_run(name: str, head: str, k: int) -> None:
    # `_PAY_TYPE_AFTER_RES` opens with `\s*` and is only ever `.match`ed at a figure's end; a
    # search from every position of a run is O(k) per start by construction. Timed as called below.
    pattern = SHIPPED[name]
    text = head + " " * k + "x"
    assert _best_of_3(lambda t: pattern.sub(" ", t), text) < _budget_s(k)


@pytest.mark.parametrize("k", _RUNS)
@pytest.mark.parametrize("kind", ["in_hand", "gross", "ctc"])
def test_the_after_cue_is_linear_on_a_whitespace_run(kind: str, k: int) -> None:
    pattern = answers._PAY_TYPE_AFTER_RES[kind]
    for text in (" " * k + "x", " " * k + "," + " " * k + "x", " pm" + " " * k + "x"):
        assert _best_of_3(lambda t: pattern.match(t), text) < _budget_s(2 * k)


@pytest.mark.parametrize("k", _RUNS)
def test_pay_text_for_is_linear_on_a_whitespace_run(k: int) -> None:
    raw = "20000-25000 take" + " " * k + "x"
    assert _best_of_3(lambda t: answers.pay_text_for(t, ["[PHONE_1]"]), raw) < _budget_s(k)
    # A word that is not a pay word is still refused after the run.
    assert answers.pay_text_for(raw, ["[PHONE_1]"]) is None
    assert answers.pay_text_for("20000-25000 take" + " " * k + "home", ["[PHONE_1]"]) is not None
