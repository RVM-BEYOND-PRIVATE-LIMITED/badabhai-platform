"""Issue #1935 — the experience and salary matchers do linear work on a whitespace run (R55).

THE DEFECT: two `/profile/extract` detectors, run inline in `async def` on the worker's own text,
were O(k^2) on a whitespace run (lexicon `experience.json` and `salary.json` `matcher`, shared with
`packages/profiling-lexicon`):

- experience: `\\s*\\+?\\s*` between the number and the unit. A number word, then a run with no
  unit, tried every split of the run: `extract("adhai" + " " * 10_000 + "5")` took 4.9 s.
- salary: `(?:₹|rs\\.?|inr)?\\s*` before the digits. Every position of a run started a match that
  scanned to the run's end, so ANY run with no digit after it was quadratic, no cue needed:
  `extract("hello" + " " * 16_000 + "world")` took 25 s.

THE FIX: experience `\\s*(?:\\+\\s*)?` (the plus owns its trailing space); salary lead
`(?:(?:₹|rs\\.?|inr)\\s*|(?<!\\s)\\s+)?` (a bare run is read only from its first character).

WHY NO MATCH MOVES. Experience: the two connectors accept the same strings, and the unit starts
on a letter, so for each number the connector's length is forced and the priority order is the
same. Salary: main's lead succeeds at a whitespace position only when the run from there reaches
the digits, and then it also succeeded at the run's first character. A scan from the start of the
text reaches that first character first, and a previous `finditer` match never ends inside a run
(its trailing `\\s*` is greedy), so every reader in the repo (`finditer`, `search`, `matchAll`,
`exec`) sees the same spans. The one input that differs is a search STARTED inside a run, which
no caller makes; section 4 pins it. Sections 2 and 3 measure the claim rather than trust it,
span for span against main's text over the repo corpus and a seeded phrase generator, and end to
end through `signals.detect` and the `values` normalizers. MAIN is each shipped matcher with
main's connector put back and nothing else touched (`scripts/measure_profile_matchers_linear.py`,
which also reproduces the full-corpus and timing numbers).

Each section was seen to fail against a mutation (2026-10-05). Main's lexicon mirror put back:
21 of these 27 tests fail, among them every timing test except the two inputs main also reads in
linear time ("5\\t" repeated, and a run a digit ends). The oracle's `loose` variant (no space after
the plus, no bare-run lead) is what section 3 checks the harness can see.
Stdlib, git and pytest only. All inputs are fabricated.
"""

from __future__ import annotations

import importlib.util
import json
import random
import re
import time
from pathlib import Path

import pytest

from app.profiling import profile_extractor, signals, values


def _load_measure_script():
    path = Path(__file__).resolve().parents[1] / "scripts" / "measure_profile_matchers_linear.py"
    spec = importlib.util.spec_from_file_location("measure_profile_matchers_linear", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


measure = _load_measure_script()
_LEXICON = Path(__file__).resolve().parents[1] / "app" / "profiling" / "lexicon_data"

#: The connectors #1935 ships, and main's, exactly as the lexicon spells them.
_SHIPPED = {
    "experience": r"\s*(?:\+\s*)?(?:years",
    "salary": r"(?:(?:₹|rs\.?|inr)\s*|(?<!\s)\s+)?([",
}
_MAIN = {
    "experience": r"\s*\+?\s*(?:years",
    "salary": r"(?:₹|rs\.?|inr)?\s*([",
}


# --- 1. the shipped lexicon carries the linear connectors ---------------------------------------


@pytest.mark.parametrize("name", ["experience", "salary"])
def test_the_lexicon_mirror_ships_the_linear_connector(name: str) -> None:
    source = json.loads((_LEXICON / f"{name}.json").read_text(encoding="utf-8"))["matcher"][
        "source"
    ]
    assert source.count(_SHIPPED[name]) == 1
    assert _MAIN[name] not in source
    assert getattr(signals, measure.MATCHERS[name][0]).pattern.count(_SHIPPED[name]) == 1


@pytest.mark.parametrize("name", ["experience", "salary"])
def test_the_oracle_is_the_shipped_matcher_with_mains_connector(name: str) -> None:
    shipped = measure.variant(name, "shipped").pattern
    main = measure.variant(name, "main").pattern
    assert shipped == getattr(signals, measure.MATCHERS[name][0]).pattern
    assert main == shipped.replace(_SHIPPED[name], _MAIN[name])


# --- 2. the same spans as main over realistic and repo text -------------------------------------

#: Realistic phrases, each read by main and the shipped matchers: Hindi, Hinglish and English,
#: digits and number words, the "+" forms, every currency word and some that are not ones.
KNOWN = [
    "5 saal ka experience hai",
    "5+ years",
    "5 + saal",
    "5 +saal",
    "5+  yrs",
    "5\t+\nyears",
    "5 ++ years",
    "adhai saal",
    "paune do saal kaam kiya",
    "dedh  saal",
    "do saal se CNC chala raha hun",
    "teen sal",
    "das   years",
    "२ साल",
    "२ saal",
    "1.5 yrs",
    "12years",
    "experience 3 +years in welding",
    "mera salary 15000 hai",
    "salary rs 15,000",
    "Rs.18000 per month",
    "₹ 25,000 chahiye",
    "₹25000",
    "INR 2.5 lakh saal ka",
    "inr   30k",
    "20 hazaar milta hai",
    "15 hazar",
    "1,20,000 per annum",
    "२५००० रुपये",
    "25000 rupaye",
    "25 thousand rupees",
    "pichhle saal 18000, ab 22000 chahiye",
    "abhi   25000\n35000 chahiye",
    "reg no 123456 salary 15000",
    "NSQF level 4 kiya hai",
    "rs",
    "rs.   ",
    "   5000",
    "hello     world",
    "5 saal\n\n\n25000 mahina",
]


def test_known_phrases_read_the_same() -> None:
    moved = [t for t in KNOWN if measure.differences(t)]
    assert moved == []


def test_known_phrases_still_read_what_they_read() -> None:
    # A spot check of the values downstream, on top of the span parity above.
    assert values.parse_experience_years("5+ years").value == 5.0
    assert values.parse_experience_years("5 + saal").value == 5.0
    assert values.parse_experience_years("adhai saal").value == 2.5
    assert signals.detect("salary rs 15,000").current_salary == 15000
    assert signals.detect("₹ 25,000 chahiye").expected_salary == 25000


def test_the_seeded_phrase_generator_reads_the_same() -> None:
    rng = random.Random(1935)
    samples = [measure.sample(rng) for _ in range(20_000)]
    moved = [t for t in samples if measure.differences(t)]
    assert moved == []


@pytest.fixture(scope="module")
def corpus() -> list[str]:
    return measure.distinct(measure.corpus())


def test_the_corpus_is_the_repos_text(corpus: list[str]) -> None:
    # The question packs and the lexicon are in it, and the corpus is big enough to mean something.
    parts = measure.corpus()
    assert {"question_packs", "lexicon_data", "lexicon_fixtures", "ai_service_tests"} <= set(parts)
    assert all(parts[name] for name in parts)
    assert len(corpus) > 30_000


@pytest.mark.parametrize("view", list(measure.VIEWS))
def test_every_corpus_string_reads_the_same(corpus: list[str], view: str) -> None:
    transform = measure.VIEWS[view]
    moved = [t for t in corpus if measure.differences(transform(t))]
    assert moved == []


#: The corpus sources the end-to-end run reads: the worker-facing text. The script's `parity`
#: runs the whole corpus in every view (0 of 103,661 texts change, 2026-10-05).
_END_TO_END_SOURCES = ("question_packs", "lexicon_fixtures", "lexicon_data", "ai_service_tests")


def test_end_to_end_detect_and_values_do_not_move() -> None:
    parts = measure.corpus()
    rng = random.Random(19350)
    texts = [s for name in _END_TO_END_SOURCES for s in parts[name]] + KNOWN
    texts = [t for t in texts + [measure.sample(rng) for _ in range(3_000)] if measure.touched(t)]
    with measure.matchers("main"):
        base = [measure.end_to_end(t) for t in texts]
    new = [measure.end_to_end(t) for t in texts]
    changed = [t for t, b, n in zip(texts, base, new, strict=True) if b != n]
    assert changed == []


# --- 3. the harness can see a change --------------------------------------------------------------


def test_the_harness_sees_a_connector_that_moves_spans(corpus: list[str]) -> None:
    moved_known = [t for t in KNOWN if measure.differences(t, against="loose")]
    assert "5 + saal" in moved_known
    assert "   5000" in moved_known
    assert "hello     world" not in moved_known
    assert any(measure.differences(t, against="loose") for t in corpus)
    texts = [t for t in KNOWN if measure.touched(t)]
    with measure.matchers("main"):
        base = [measure.end_to_end(t) for t in texts]
    with measure.matchers("loose"):
        loose = [measure.end_to_end(t) for t in texts]
    assert base != loose


# --- 4. the one input that differs: a search started inside a run --------------------------------


def test_known_residual_a_search_started_inside_a_run_starts_at_the_digit() -> None:
    # No caller does this: every reader scans from the start of the text. Pinned so that a new
    # `pattern.search(text, pos)` caller learns the lead reads a run only from its first character.
    text = "salary    5000"
    main, shipped = measure.variant("salary", "main"), signals._SALARY_RE
    assert main.search(text).span() == shipped.search(text).span() == (6, 14)
    assert main.search(text, 8).span() == (8, 14)
    assert shipped.search(text, 8).span() == (10, 14)
    assert main.search(text, 8).span(1) == shipped.search(text, 8).span(1) == (10, 14)


# --- 5. timing: linear in the run, through the matchers and through the extractor ----------------

_REGEX_BUDGET_S = 0.25
_EXTRACT_BUDGET_S = 2.0


def _best_of_3(fn, text: str) -> float:
    best = float("inf")
    for _ in range(3):
        start = time.perf_counter()
        fn(text)
        best = min(best, time.perf_counter() - start)
    return best


@pytest.mark.parametrize(
    ("name", "text"),
    [
        ("experience", "adhai" + " " * 20_000 + "5"),
        ("experience", "5" + " " * 9_000 + "+" + " " * 9_000 + "!"),
        ("experience", "5\t" * 6_000 + "!"),
        ("salary", "hello" + " " * 20_000 + "world"),
        ("salary", "rs" + " " * 20_000 + "!"),
        ("salary", "₹" + " " * 20_000 + "x"),
    ],
)
def test_each_matcher_is_linear_on_a_whitespace_run(name: str, text: str) -> None:
    pattern = getattr(signals, measure.MATCHERS[name][0])
    assert _best_of_3(lambda t: list(pattern.finditer(t)), text) < _REGEX_BUDGET_S


@pytest.mark.parametrize(
    "text",
    [
        "adhai" + " " * 10_000 + "5",
        "hello" + " " * 16_000 + "world",
        "x" + " " * 19_990 + "5000",
        "paune do" + "\n" * 19_000 + "saalo",
    ],
)
def test_profile_extract_is_linear_on_a_whitespace_run(text: str) -> None:
    # Main: 4.9 s, 25 s, and longer (2026-10-05). The budget is far above the fix's 40-130 ms.
    assert _best_of_3(profile_extractor.extract, text) < _EXTRACT_BUDGET_S


def test_the_matchers_still_find_a_number_across_a_long_run() -> None:
    # Linear, and still correct: a long run between the parts reads as before.
    assert signals._EXPERIENCE_RE.search("5" + " " * 5_000 + "+ saal").group(1) == "5"
    found = [m.group(1) for m in signals._SALARY_RE.finditer("rs" + " " * 5_000 + "25000")]
    assert found == ["25000"]


def test_the_timing_inputs_hold_no_digits_the_matcher_could_end_on() -> None:
    # Guards the guard: the slow inputs must FAIL the matcher, or the timing tests prove nothing.
    for text in ("hello" + " " * 100 + "world", "rs" + " " * 100 + "!"):
        assert signals._SALARY_RE.search(text) is None
    assert signals._EXPERIENCE_RE.search("adhai" + " " * 100 + "5") is None
    assert not re.search(r"\d", "paune do" + "\n" * 10 + "saalo")
