"""Issue #1934 — the job-posting chat's role cue and phrase splitter are linear on a whitespace run
(risks-register R53 (a) and (b)), and the role cue reads "an" as "an".

THE DEFECT: two `app/job_posting_chat/answers.py` parsers, run inline in `async def` on the
payer's turn, were O(k^2) on a whitespace run:

- `_ROLE_CUE_RE`: the cue's `\\s+`, then `(?:a|an|some|few|the)?\\s*`. A run that failed to match
  tried every split between the two quantifiers: `detect_answers("need" + " " * 15_000 + "5",
  "role_title")` took 945 ms (R53). The article also matched as a word PREFIX: "need an
  operator" recorded the role "n operator", and "hiring assistants" "ssistants".
- `_PHRASE_SPLIT_RE`: `\\s+and\\s+|\\s+aur\\s+` started a scan to the run's end at every position
  of the run, so ANY long run was quadratic, no cue needed: 730-800 ms for 10,000 spaces on the
  skills question (R53).

THE FIX: the article owns its whitespace, `(?:(?:an?|some|few|the)\\s+)?`; the splitter tries its
"and"/"aur" arm only where a whitespace run starts,
`(?<!\\s)\\n*[^\\S\\n]\\s*(?:and|aur)\\s+`, listed before the separator characters.

WHAT MOVES, AND WHAT DOES NOT. Role: only the intended fix, in two classes: `an-read-as-a` and
`article-prefix` (`measure.role_class`). Splitter: no phrase. Inside a run the old arm could
succeed only where the run's start also succeeds, and the scan reaches the start first. A run
that STARTS with a newline before an "and" used to split at each newline and then match the arm
from the first space; it is now one match from the newline, so `re.split` loses empty pieces
only (`empty-pieces`), which `_clean_label` drops. Sections 2 and 3 measure this rather than
trust it, against main's text over the repo corpus, seeded payer phrases and `detect_answers`.
MAIN is each shipped regex with main's text put back and nothing else touched
(`scripts/measure_job_chat_parsers_linear.py`, which also reproduces the full numbers).

Each section was seen to fail against a mutation (2026-10-05): with main's two regexes put back
in `answers.py`, the tests listed in the PR fail. Stdlib, git and pytest only. All inputs are
fabricated.
"""

from __future__ import annotations

import importlib.util
import random
import time
from pathlib import Path

import pytest

from app.job_posting_chat import answers


def _load_measure_script():
    path = Path(__file__).resolve().parents[1] / "scripts" / "measure_job_chat_parsers_linear.py"
    spec = importlib.util.spec_from_file_location("measure_job_chat_parsers_linear", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


measure = _load_measure_script()

#: The regex text #1934 ships, and main's, exactly as `answers.py` spells it.
_SHIPPED = {
    "role": r"(?:\d+\s+)?(?:(?:an?|some|few|the)\s+)?([A-Za-z]",
    "split": r"(?<!\s)\n*[^\S\n]\s*(?:and|aur)\s+|[,;/\n|+&]",
}
_MAIN = {
    "role": r"(?:\d+\s+)?(?:a|an|some|few|the)?\s*([A-Za-z]",
    "split": r"[,;/\n|+&]|\s+and\s+|\s+aur\s+",
}


def _role(text: str) -> object:
    return answers.detect_answers(text, "role_title").get("role_title")


# --- 1. the shipped module carries the linear regexes -------------------------------------------


@pytest.mark.parametrize("name", ["role", "split"])
def test_answers_ships_the_linear_regex(name: str) -> None:
    pattern = getattr(answers, measure.RULES[name]).pattern
    assert pattern.count(_SHIPPED[name]) == 1
    assert _MAIN[name] not in pattern


@pytest.mark.parametrize("name", ["role", "split"])
def test_the_oracle_is_the_shipped_regex_with_mains_text(name: str) -> None:
    shipped = measure.variant(name, "shipped").pattern
    main = measure.variant(name, "main").pattern
    assert shipped == getattr(answers, measure.RULES[name]).pattern
    assert main == shipped.replace(_SHIPPED[name], _MAIN[name])


# --- 2. correctness: the article is a whole word, and everything else reads as before -----------


@pytest.mark.parametrize(
    ("text", "role"),
    [
        # The issue's examples: main recorded "n operator" and "n electrician".
        ("need an operator", "operator"),
        ("looking for an electrician", "electrician"),
        ("Need An Operator", "Operator"),
        ("HIRING AN ELECTRICIAN", "ELECTRICIAN"),
        ("hiring an  \t electrician in Pune", "electrician"),
        # Each article, as a word, is still skipped.
        ("need a welder", "welder"),
        ("need A welder", "welder"),
        ("need some helpers", "helpers"),
        ("need few drivers", "drivers"),
        ("need the fitter", "fitter"),
        ("need 5 a welders", "welders"),
        ("hiring 10 an operators at Chakan", "operators"),
        ("need\ta\nwelder", "welder"),
        # A word an article is a prefix of is the role, not its remainder (main: "ssistants",
        # "C technician", "odolite operator", "chor fitter").
        ("hiring assistants", "assistants"),
        ("need accountant", "accountant"),
        ("need AC technician", "AC technician"),
        ("hiring theodolite operator", "theodolite operator"),
        ("need anchor fitter", "anchor fitter"),
        ("need fewster", "fewster"),
        # Unchanged by #1934.
        ("need 5 CNC operators in Pune at 20k", "CNC operators"),
        ("looking for welder", "welder"),
        ("need a", "a"),
    ],
)
def test_the_role_cue_reads_the_article_as_a_word(text: str, role: str) -> None:
    assert _role(text) == role


@pytest.mark.parametrize(
    ("text", "phrases"),
    [
        ("PF + ESI, canteen", ["PF", "ESI", "canteen"]),
        ("PF and ESI aur canteen", ["PF", "ESI", "canteen"]),
        ("PF AND ESI Aur canteen", ["PF", "ESI", "canteen"]),
        ("PF\n and ESI", ["PF", "ESI"]),
        ("PF\n\n \n and ESI", ["PF", "ESI"]),
        ("PF \n and ESI", ["PF", "ESI"]),
        ("PF\r\nand ESI", ["PF", "ESI"]),
        # A newline alone before the word was never an "and" separator, and still is not.
        ("PF\nand ESI", ["PF", "and ESI"]),
        ("PF, and ESI", ["PF", "ESI"]),
        ("Andheri and Aurangabad", ["Andheri", "Aurangabad"]),
        ("brand  sander", ["brand sander"]),
        ("TIG and　MIG", ["TIG", "MIG"]),
        (" and PF", ["PF"]),
        ("PF and", ["PF and"]),
    ],
)
def test_the_phrase_splitter_splits_as_before(text: str, phrases: list[str]) -> None:
    assert answers._split_phrases(text) == phrases
    with measure.regexes("main"):
        assert answers._split_phrases(text) == phrases


def test_a_newline_led_run_differs_from_main_by_empty_pieces_only() -> None:
    # The one `re.split` difference: main split at the newline, then matched from the space.
    main, shipped = measure.variant("split", "main"), answers._PHRASE_SPLIT_RE
    assert main.split("PF\n and ESI") == ["PF", "", "ESI"]
    assert shipped.split("PF\n and ESI") == ["PF", "ESI"]
    assert measure.split_class("PF\n and ESI") == "empty-pieces"


# --- 3. parity with main: only the intended differences -----------------------------------------

#: Realistic payer answers, Hindi, Hinglish and English, to the role and the three list questions.
KNOWN = [
    "need an operator",
    "looking for an electrician",
    "hiring assistants",
    "need 5 CNC operators in Pune",
    "Hamein 2 welder chahiye, need a TIG welder",
    "need some helpers aur ek supervisor",
    "Looking For The Fitter",
    "vacancy for VMC programmer",
    "posting for 3 machine operators at Chakan",
    "requires an ITI fitter urgently",
    "PF, ESI aur canteen",
    "PF + ESI + bus",
    "room and khana",
    "TIG welding and MIG\nAutoCAD",
    "PF\n and ESI",
    "ITI pass, 2 saal experience and Hindi aur English",
    "Andheri, Aurangabad",
    "overtime &  bonus / uniform | safety shoes; forklift",
    "salary 20k in hand and PF",
]


def test_known_phrases_move_only_as_intended() -> None:
    assert [t for t in KNOWN if measure.disallowed(t)] == []
    assert measure.role_class("need an operator") == "an-read-as-a"
    assert measure.role_class("hiring assistants") == "article-prefix"
    assert measure.role_class("need 5 CNC operators in Pune") is None


def test_the_seeded_phrase_generator_moves_only_as_intended() -> None:
    rng = random.Random(1934)
    samples = [measure.sample(rng) for _ in range(20_000)]
    assert [t for t in samples if measure.disallowed(t)] == []
    # It exercises both fixes, or the line above proves nothing.
    found = {c for t in samples for c in measure.classes(t).values()}
    assert {"an-read-as-a", "article-prefix", "empty-pieces"} <= found


@pytest.fixture(scope="module")
def corpus() -> list[str]:
    return measure.distinct(measure.corpus())


def test_the_corpus_is_the_repos_text(corpus: list[str]) -> None:
    parts = measure.corpus()
    assert {"question_packs", "ai_service_tests", "api_job_posting_chat"} <= set(parts)
    assert all(parts[name] for name in parts)
    assert len(corpus) > 30_000


@pytest.mark.parametrize("view", list(measure.VIEWS))
def test_every_corpus_string_moves_only_as_intended(corpus: list[str], view: str) -> None:
    transform = measure.VIEWS[view]
    assert [t for t in corpus if measure.disallowed(transform(t))] == []


def test_end_to_end_detect_answers_moves_only_the_role_fix() -> None:
    rng = random.Random(19340)
    texts = KNOWN + [measure.sample(rng) for _ in range(3_000)]
    assert measure.e2e_changes(texts) == []
    # And the role fix does reach `detect_answers`.
    with measure.regexes("main"):
        assert _role("need an operator") == "n operator"
    assert _role("need an operator") == "operator"


# --- 4. the harness can see a change --------------------------------------------------------------


def test_the_harness_sees_a_variant_that_moves_results() -> None:
    assert measure.role_class("need a welder", against="loose") == "unexplained"
    assert measure.split_class("PF\n and ESI", against="loose") == "unexplained"
    assert measure.disallowed("need a welder", against="loose")
    changed = measure.e2e_changes(["need a welder", "PF\n and ESI"], against="loose")
    assert {text for text, _ in changed} == {"need a welder", "PF\n and ESI"}


# --- 5. timing: linear in the run, through the regex and through detect_answers -----------------

#: A linear budget: main is quadratic, about 10, 21, 42 and 63 ms per 1k characters at 2.5k, 5k,
#: 10k and 15k on detect_answers (R53, and `measure timing`); the fix takes well under 1 ms per
#: 1k. So main passes at 2.5k only, and CI has 40x headroom at 15k.
_MS_PER_1K = 10.0
_FLOOR_MS = 25.0
_RUNS = measure.RUNS


def _budget_s(k: int) -> float:
    return (_FLOOR_MS + _MS_PER_1K * k / 1_000) / 1_000


def _best_of_3(fn, text: str) -> float:
    best = float("inf")
    for _ in range(3):
        start = time.perf_counter()
        fn(text)
        best = min(best, time.perf_counter() - start)
    return best


@pytest.mark.parametrize("k", _RUNS)
@pytest.mark.parametrize(
    ("topic", "shape"),
    [
        ("role_title", "need{}5"),
        ("role_title", "need 5{}!"),
        ("role_title", "looking for{}!"),
        ("skills", "PF{}ESI"),
        ("benefits", "PF{}and"),
        ("requirements", "PF{}x"),
    ],
)
def test_detect_answers_is_linear_on_a_whitespace_run(topic: str, shape: str, k: int) -> None:
    text = shape.format(" " * k)
    assert _best_of_3(lambda t: answers.detect_answers(t, topic), text) < _budget_s(k)


@pytest.mark.parametrize("k", _RUNS)
@pytest.mark.parametrize("run", [" ", "\t", " \n", "\n ", " "])
def test_each_regex_is_linear_on_a_run_of_any_whitespace(run: str, k: int) -> None:
    text = "need" + run * (k // len(run)) + "5"
    assert _best_of_3(answers._ROLE_CUE_RE.search, text) < _budget_s(k)
    assert _best_of_3(answers._PHRASE_SPLIT_RE.split, text) < _budget_s(k)


def test_the_parsers_still_read_across_a_long_run() -> None:
    # Linear, and still correct: a long run between the parts reads as before.
    assert _role("need" + " " * 5_000 + "an" + " " * 5_000 + "operator") == "operator"
    assert answers._split_phrases("PF" + " " * 5_000 + "and" + " " * 5_000 + "ESI") == ["PF", "ESI"]
    assert answers._split_phrases("PF" + " \n" * 2_500 + "and ESI") == ["PF", "ESI"]


def test_the_timing_inputs_fail_the_regexes() -> None:
    # Guards the guard: the slow inputs must FAIL the regex, or the timing tests prove nothing.
    for shape in ("need{}5", "need 5{}!", "looking for{}!"):
        assert answers._ROLE_CUE_RE.search(shape.format(" " * 100)) is None
    assert answers._PHRASE_SPLIT_RE.split("PF" + " " * 100 + "ESI") == ["PF" + " " * 100 + "ESI"]
