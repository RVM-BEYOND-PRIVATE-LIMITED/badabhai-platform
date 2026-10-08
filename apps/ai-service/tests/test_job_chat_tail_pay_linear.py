"""Issue #1995 — the job-posting chat's label tail, pay-clause splitter and pay-range parser are
linear on a whitespace run (risks-register R53 (d), (e) and (c)).

THE DEFECT: three `app/job_posting_chat/answers.py` regexes, run inline in `async def` on the
payer's turn, were O(k^2) on a whitespace run:

- `_LABEL_TAIL_RE` (d), `\\s+\\b(?:in|at|...)\\b.*$` with `.sub()`: every position of a run in a
  captured role or location label started a scan to the run's end. `detect_answers("need welder"
  + " " * 10_000 + "x", "role_title")` took 547 ms (#1995).
- `_PAY_CLAUSE_BOUNDARY_RE` (e): the same unanchored `\\s+and\\s+` arm #1934 fixed in the phrase
  splitter, on any turn with a pay figure: "salary 20k bonus" + 10,000 spaces took 463 ms.
- `_PAY_RANGE_RE` (c): `\\s*` + optional suffix + `\\s*` after a number (and `\\s*` + optional
  currency + `\\s*` before the high one): "salary 20k 5" + 10,000 spaces + "!" took 3.5 s.

THE FIX: the tail is anchored on the run's start, `(?<!\\s)\\s+\\b...`; the clause's "and" arm is
#1934's `_PHRASE_SPLIT_RE` shape, `(?<!\\s)\\n*[^\\S\\n]\\s*and\\s+`, listed first; the range's
optional suffix and currency own their whitespace, `(?:\\s*SUFFIX)?\\s*` and `\\s*(?:CUR\\s*)?`.

WHAT MOVES: nothing a caller reads. The tail's `.sub()` result and every range match (span and
groups; `figure.end` is read) are identical to main's. The clause splitter's boundaries differ
only where a newline-led run precedes "and": main split at each newline and then matched the
arm, the fix matches once (`merged`); the boundaries touch and hold no figure, so every clause
`_pay_clause` returns is unchanged. `detect_answers` is unchanged on every text. Section 2 measures
this against main's text (`scripts/measure_job_chat_tail_pay_linear.py`, which also reproduces the
full corpus numbers and the timings).

Seen to fail against a mutation (2026-10-06): with main's three regexes put back in `answers.py`,
the timing tests fail on behaviour (each hits its bound or its hard timeout), and the oracle and
parity tests fail on the harness's own guard (the shipped text is gone). Stdlib, git and pytest
only. All inputs are fabricated.
"""

from __future__ import annotations

import importlib.util
import random
import signal
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

from app.job_posting_chat import answers


def _load_measure_script():
    path = Path(__file__).resolve().parents[1] / "scripts" / "measure_job_chat_tail_pay_linear.py"
    spec = importlib.util.spec_from_file_location("measure_job_chat_tail_pay_linear", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


measure = _load_measure_script()

#: Main's text, as `answers.py` spelled it before #1995 — with #2088's "and"/"aur" word set and
#: #2132's suffix word boundary, which the shipped regexes carry too (the oracle compares the
#: whitespace shape around the optional suffix, not the suffix's own text).
_MAIN_FRAGMENTS = {
    "tail": r"\s+\b(?:in|at|for|with|on|near|from|starting|salary|pay|shift|urgently|",
    "clause": r"(?<![A-Za-z])plus(?![A-Za-z])|\s+(?:and|aur)\s+",
    "range": (
        r"(?<![\d.])(\d[\d,]*(?:\.\d+)?)\s*"
        r"(?:(k|thousand|thousands|hazar|hazaar|lakh|lakhs|lakhh|lac|lacs|lack|lacks)"
        r"(?!(?!(?:(?:to|se|upto)(?:rs|inr)?|pm|p\.m|per|permonth|month|monthly|mahina|mahine)"
        r"(?![A-Za-z]))[A-Za-z]))?\s*"
    ),
}


# --- 1. the shipped module carries the linear regexes -------------------------------------------


@pytest.mark.parametrize("name", list(measure.RULES))
def test_answers_ships_the_linear_regex(name: str) -> None:
    pattern = getattr(answers, measure.RULES[name]).pattern
    assert pattern == measure.SOURCES[name]["shipped"]
    # Main's tail is the shipped one minus its anchor, so it is checked at the start.
    assert not pattern.startswith(_MAIN_FRAGMENTS[name])
    assert name == "tail" or _MAIN_FRAGMENTS[name] not in pattern
    assert measure.SOURCES[name]["main"] != pattern


def test_the_oracle_holds_mains_text() -> None:
    measure.check_shipped()
    for name, fragment in _MAIN_FRAGMENTS.items():
        assert fragment in measure.SOURCES[name]["main"]


# --- 2. correctness and parity: every caller-visible result reads as on main ---------------------


@pytest.mark.parametrize(
    ("text", "topic", "expected"),
    [
        ("need 5 CNC operators in Pune at 20k", "role_title", "CNC operators"),
        ("need welder for night shift", "role_title", "welder"),
        ("need helper urgently", "role_title", "helper"),
        ("need welder\tin Pune", "role_title", "welder"),
        ("the plant is in Chakan for a client", "location_label", "Chakan"),
        ("plant is in Pune near station", "location_label", "Pune"),
    ],
)
def test_the_label_tail_trims_as_before(text: str, topic: str, expected: str) -> None:
    assert answers.detect_answers(text, topic).get(topic) == expected
    with measure.regexes("main"):
        assert answers.detect_answers(text, topic).get(topic) == expected


@pytest.mark.parametrize(
    ("text", "pay"),
    [
        ("salary 20-25k", {"pay_min": 20_000, "pay_max": 25_000}),
        ("20 k - 25 k per month", {"pay_min": 20_000, "pay_max": 25_000}),
        ("between 18000 and 22000", {"pay_min": 18_000, "pay_max": 22_000}),
        ("Rs 15,000 to Rs 18,000", {"pay_min": 15_000, "pay_max": 18_000}),
        ("15 hazar se 18 hazar", {"pay_min": 15_000, "pay_max": 18_000}),
        ("in hand 20k, OT extra 2000", {"pay_min": 20_000, "pay_max": None}),
        ("salary 20k\n and bonus 2k", {"pay_min": 20_000, "pay_max": None}),
        ("salary 20k \n\n and bonus 2k", {"pay_min": 20_000, "pay_max": None}),
        ("Salary 20k + 2k bonus", {"pay_min": 20_000, "pay_max": None}),
    ],
)
def test_the_pay_parsers_read_as_before(text: str, pay: dict[str, int | None]) -> None:
    assert answers.detect_answers(text, "pay_range").get("pay_range") == pay
    with measure.regexes("main"):
        assert answers.detect_answers(text, "pay_range").get("pay_range") == pay


def test_a_newline_led_and_is_one_clause_boundary_with_the_same_clauses() -> None:
    text = "salary 20k\n and bonus 2k"
    main = [m.span() for m in measure.variant("clause", "main").finditer(text)]
    shipped = [m.span() for m in answers._PAY_CLAUSE_BOUNDARY_RE.finditer(text)]
    assert main == [(10, 11), (11, 16)]
    assert shipped == [(10, 16)]
    assert measure.clause_class(text) == "merged"


KNOWN = [
    "need 5 CNC operators in Pune at 20k",
    "need welder. in Pune",
    "hiring CNC operators at Chakan salary 20k",
    "the plant is in Chakan for a client",
    "salary 20-25k in hand",
    "18,000 - 22,000 per month and PF",
    "in hand 20k, OT extra 2000",
    "gross 30k\n and in hand 25k",
    "CTC 3 lakh, take home 22k",
    "Established 1998, salary 15000",
    "1998-2005 se kaam, salary 18 thousand",
    "Rs 15,000 to ₹ 18,000 /-",
    "20 k  -  25 k plus OT",
    "PF\n and ESI aur canteen",
]


def test_known_phrases_move_only_as_intended() -> None:
    assert [t for t in KNOWN if measure.disallowed(t)] == []
    assert measure.e2e_changes(KNOWN) == []


def test_the_seeded_phrase_generator_moves_only_as_intended() -> None:
    rng = random.Random(1995)
    samples = [measure.sample(rng) for _ in range(4_000)]
    assert [t for t in samples if measure.disallowed(t)] == []
    # It exercises the one allowed difference, or the line above proves less than it claims.
    assert any(measure.classes(t) == {"clause": "merged"} for t in samples)
    assert measure.e2e_changes(samples) == []


@pytest.fixture(scope="module")
def corpus() -> list[str]:
    return measure.base.distinct(measure.base.corpus())


@pytest.mark.parametrize("view", ["as written", "newline runs"])
def test_every_corpus_string_moves_only_as_intended(corpus: list[str], view: str) -> None:
    transform = measure.base.VIEWS[view]
    assert len(corpus) > 30_000
    assert [t for t in corpus if measure.disallowed(transform(t))] == []


def test_the_harness_sees_a_variant_that_moves_results() -> None:
    assert measure.tail_class("welder. in Pune", against="loose") == "unexplained"
    assert measure.clause_class("salary 20k\n and bonus 2k", against="loose") == "unexplained"
    assert measure.range_class("20 k - 25", against="loose") == "unexplained"
    changed = measure.e2e_changes(["need welder. in Pune", "20 k - 25 per month"], "loose")
    assert {text for text, _ in changed} == {"need welder. in Pune", "20 k - 25 per month"}


# --- 3. timing: linear in the run ---------------------------------------------------------------

#: Generous linear bounds. Main measured 0.4-0.8 s at 10k and 1.9-4.1 s at 20k on the tail and
#: clause shapes, and 3.5-7 s / 15-22 s on the range shape; the fix takes 2-25 ms. The bounds are
#: 200 ms at 10k and 350 ms at 20k: 10x+ headroom over the fix on a slow CI runner, and still below
#: main on every shape. A hard per-test timeout stops a regression from stalling the suite.
_FLOOR_MS = 50.0
_MS_PER_1K = 15.0
_TIMEOUT_S = 30.0
_RUNS = (10_000, 20_000)


def _budget_s(k: int) -> float:
    return (_FLOOR_MS + _MS_PER_1K * k / 1_000) / 1_000


@contextmanager
def _hard_timeout(seconds: float) -> Iterator[None]:
    """Fail the test after `seconds`, even inside a regex (CPython's `re` checks for signals).
    SIGALRM is POSIX and main-thread only; elsewhere the timing bound alone applies."""
    main_thread = threading.current_thread() is threading.main_thread()
    if not hasattr(signal, "setitimer") or not main_thread:
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
@pytest.mark.parametrize("shape", list(measure.SHAPES))
def test_detect_answers_is_linear_on_a_whitespace_run(shape: str, k: int) -> None:
    template, topic = measure.SHAPES[shape]
    text = template.format(" " * k)
    assert _best_of_3(lambda t: answers.detect_answers(t, topic), text) < _budget_s(k)


@pytest.mark.parametrize("run", [" ", "\t", " \n", "\n ", "　"])
def test_each_regex_is_linear_on_a_run_of_any_whitespace(run: str) -> None:
    k = 20_000
    ws = run * (k // len(run))
    tail = lambda t: answers._LABEL_TAIL_RE.sub("", t)  # noqa: E731
    assert _best_of_3(tail, "welder" + ws + "x") < _budget_s(k)
    assert _best_of_3(answers._PAY_CLAUSE_BOUNDARY_RE.findall, "20k" + ws + "x") < _budget_s(k)
    assert _best_of_3(answers._PAY_RANGE_RE.findall, "5" + ws + "!") < _budget_s(k)
    assert _best_of_3(answers._PAY_RANGE_RE.findall, "5 to" + ws + "!") < _budget_s(k)


def test_the_parsers_still_read_across_a_long_run() -> None:
    run = " " * 5_000
    assert answers.detect_answers("need welder" + run + "in Pune", "role_title") == {
        "role_title": "welder"
    }
    assert answers.detect_answers("20k" + run + "-" + run + "25k", "pay_range")["pay_range"] == {
        "pay_min": 20_000,
        "pay_max": 25_000,
    }
    clause = "salary 20k" + run + "and" + run + "bonus 2k"
    assert answers.detect_answers(clause, "pay_range")["pay_range"] == {
        "pay_min": 20_000,
        "pay_max": None,
    }


def test_the_timing_inputs_take_the_slow_path() -> None:
    # Guards the guard: each slow input must fail the regex it targets (or the timing tests prove
    # nothing), and the tail must actually be reached, through a cue that matched.
    ws = " " * 100
    assert answers._LABEL_TAIL_RE.sub("", "welder" + ws + "x") == "welder" + ws + "x"
    assert answers._ROLE_CUE_RE.search("need welder" + ws + "x") is not None
    assert answers._LOCATION_CUE_RE.search("plant is in Pune" + ws + "x") is not None
    assert answers._PAY_CLAUSE_BOUNDARY_RE.search("salary 20k bonus" + ws + "x") is None
    assert answers._PAY_RANGE_RE.search("salary 20k 5" + ws + "!") is None


# --- 4. many figures: the pay parser is linear in the FIGURE count too (#2088) ------------------
#: Each shape repeats a pay figure until the message is k characters long. Before #2088 the
#: clause screen scanned every boundary per figure, the residue was re-copied per range, and the
#: year screen searched the whole prefix per year-shaped amount: O(n^2), 3-95 s at 20k-40k.
_MANY_FIGURES = {
    "split and pairs": "20k and 2k ",
    "comma list": "20k, ",
    "rising and pairs": "20k and 25k ",
    "aur pairs": "20 hazaar aur 2 hazaar ",
    "dashed ranges": "15-20k ",
    "bare years": "1998 ",
}


@pytest.mark.parametrize("k", _RUNS)
@pytest.mark.parametrize("topic", [None, "pay_range"])
@pytest.mark.parametrize("unit", list(_MANY_FIGURES.values()), ids=list(_MANY_FIGURES))
def test_detect_answers_is_linear_in_the_figure_count(unit: str, topic: str | None, k: int) -> None:
    text = unit * (k // len(unit)) + "bonus"
    assert _best_of_3(lambda t: answers.detect_answers(t, topic), text) < _budget_s(k)


# --- 5. the "wage, amount, label" add-on screen is linear in the figure count too (#2133) ------
#: name -> (head, unit, tail); the unit repeats until the message is k characters long. "one
#: clause" puts every figure in ONE clause with no add-on word: a bare test per figure there reads
#: the whole clause per figure, O(n^2) — measured 0.76 s at 10k and 2.95 s at 20k with the
#: one-figure-per-clause guard removed, 14 ms and 30 ms with it. The other two repeat a whole
#: "wage, amount, label" run, so every amount walks back to its wage and on to its label, once
#: through single newlines and once through runs of empty clauses.
_NEXT_CLAUSE_SHAPES = {
    "one clause of small figures": ("salary 20000 ", "1000 ", "\nfood allowance"),
    "wage, amount, label per line": ("salary ", "20000\n1000\nfood allowance\n", ""),
    "runs of empty clauses": ("salary ", "20000" + "\n" * 8 + "1000" + "\n" * 8 + "bonus\n", ""),
}


def _next_clause_text(shape: str, k: int) -> str:
    head, unit, tail = _NEXT_CLAUSE_SHAPES[shape]
    return head + unit * ((k - len(head)) // len(unit)) + tail


def test_the_next_clause_timing_inputs_reach_the_screen() -> None:
    # Guards the guard: every small figure passes the ratio test against the 20000, so only the
    # one-figure-per-clause guard keeps "one clause" from a bare test per figure (and it keeps the
    # fold); in the other two the screen really drops every amount, so every walk ran.
    expected = {
        "one clause of small figures": {"pay_min": 1000, "pay_max": 20000},
        "wage, amount, label per line": {"pay_min": 20000, "pay_max": None},
        "runs of empty clauses": {"pay_min": 20000, "pay_max": None},
    }
    for shape, pay in expected.items():
        text = _next_clause_text(shape, 400)
        figures = answers._pay_figures(text)
        assert len(figures) > 10
        assert {f.low for f in figures} == {1000, 20000}
        assert answers.detect_answers(text, "pay_range")["pay_range"] == pay


@pytest.mark.parametrize("k", _RUNS)
@pytest.mark.parametrize("topic", [None, "pay_range"])
@pytest.mark.parametrize("shape", list(_NEXT_CLAUSE_SHAPES))
def test_the_next_clause_screen_is_linear_in_the_figure_count(
    shape: str, topic: str | None, k: int
) -> None:
    text = _next_clause_text(shape, k)
    assert _best_of_3(lambda t: answers.detect_answers(t, topic), text) < _budget_s(k)
