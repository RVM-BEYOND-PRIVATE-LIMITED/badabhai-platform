"""Issue #2050 — the salary detector reads a split phone's groups as pay.

THE DEFECT (found 2026-10-06 by the security review of #1950): the salary matcher reads digits
split by a space or a dash as separate numbers, so a spaced phone's first group was a wage.
`signals.detect("mera number 98765 43210 hai").current_salary == 98765`, and "987 654 3210" gave
3210. Traced 2026-10-07: with a want cue near it ("job chahiye mera number 98765 43210") the group
became the EXPECTED salary, which `/profile/extract` stores in `salary_expectation.amount_min`,
the reach engine scores (weight 0.10) and the worker's own résumé prints ("expects ₹98,765"). And
"number 98765 43210, salary 25000" lost the real wage to it: first writer wins.

THE FIX (lexicon `salary.json` `phoneChain`, both engines): a run of 9+ digits on one line joined
only by spaces or dashes is phone-shaped, and none of its figures is pay, unless it is a pay range:
two round, rising figures at most 5x apart (#1731's rule). A space-joined pair counts as a range too
(owner decision 2026-10-07).

Pinned here: the phone shapes (1), the wages and ranges that must not move (2), the decided cases
(3), the measurement (4), linearity (5) and what the guard does not read (6). The TypeScript port
is pinned in `packages/profiling-lexicon/src/values/salary-phone-chain.test.ts`, and the parity
corpus (`build_lexicon_corpus.py`, family `salph`) runs both engines on the same rows.

BEFORE is the detector with the guard off (`measure.no_guard`). All inputs are fabricated.
"""

from __future__ import annotations

import importlib.util
import time
from pathlib import Path

import pytest

from app.profiling import lexicon, profile_extractor, signals
from app.pseudonymize import DEFAULT_MAX_LENGTH, contains_hard_identifier


def _load_script(name: str):
    path = Path(__file__).resolve().parents[1] / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


measure = _load_script("measure_salary_phone_chain")

NBSP = chr(0xA0)
EN_DASH = chr(0x2013)


def devanagari(digits: str) -> str:
    return "".join(chr(0x966 + int(d)) if d.isdigit() else d for d in digits)


def reading(text: str) -> tuple[int | None, int | None]:
    return measure.reading(text)


def before(text: str) -> tuple[int | None, int | None]:
    with measure.no_guard():
        return reading(text)


# --- 1. a phone's groups are not pay -------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "was"),
    [
        ("mera number 98765 43210 hai", (98765, None)),
        ("phone 98765-43210", (98765, None)),
        ("mera number 9876 543 210", (9876, None)),
        ("mera number 987 654 3210", (3210, None)),
        ("+91 98765 43210", (98765, None)),
        ("call 098765 43210", (98765, None)),
        (f"whatsapp 98765{NBSP}43210 pe", (98765, None)),
        (f"number 98765{EN_DASH}43210", (98765, None)),
        (devanagari("98765 43210") + " mera number hai", (98765, None)),
        # The traced harm: the want cue made the group the EXPECTED salary.
        ("job chahiye mera number 98765 43210", (43210, 98765)),
    ],
)
def test_a_phones_groups_record_no_pay(text, was):
    assert before(text) == was
    assert reading(text) == (None, None)
    # The output floor already called each of these a phone; the detector now agrees.
    assert contains_hard_identifier(text) == "phone"


def test_the_traced_path_stores_no_expected_salary():
    rich, legacy = profile_extractor.extract("job chahiye mera number 98765 43210")
    assert legacy.salary_expectation.amount_min is None
    assert (rich.current_salary, rich.expected_salary) == (None, None)


@pytest.mark.parametrize(
    ("text", "was", "now"),
    [
        ("number 98765 43210, salary 25000", (98765, None), (25000, None)),
        ("job chahiye, 20000 chahiye, mera number 98765 43210", (98765, 20000), (None, 20000)),
        ("salary 25000, number 98765 43210", (25000, None), (25000, None)),
    ],
)
def test_a_wage_beside_a_phone_is_recorded(text, was, now):
    assert before(text) == was
    assert reading(text) == now


# --- 2. wages and pay ranges read as before ------------------------------------------------------


@pytest.mark.parametrize("text", measure.WAGES)
def test_a_wage_line_reads_as_before(text):
    assert reading(text) == before(text)


@pytest.mark.parametrize(
    ("text", "now"),
    [
        ("15000-20000 chahiye", (15000, 20000)),
        (f"18500{EN_DASH}22000 milta hai", (18500, None)),
        ("60000-70000", (60000, None)),
        ("5000 6000 milta hai", (5000, None)),  # eight digits: below the phone length
    ],
)
def test_a_pay_range_is_pay(text, now):
    assert reading(text) == now == before(text)


@pytest.mark.parametrize(
    "text",
    [
        "10000-90000",  # nine times apart
        "25000-20000",  # falling
        "20050-25000",  # not a multiple of 100
        "20000-20000",  # not rising
        "12345 6789",  # nine digits, no range
    ],
)
def test_a_phone_length_run_that_is_no_pay_range_records_nothing(text):
    """#1731's money-range rule, read the same way here: outside it, a phone-length run of two
    figures is a phone. Each recorded its first figure before."""
    assert before(text)[0] is not None
    assert reading(text) == (None, None)


# --- 3. decided ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "now"),
    [("salary 15000 18000", (15000, None)), ("25000 30000 ke beech chahiye", (25000, None))],
)
def test_DECIDED_a_space_joined_round_pair_is_a_pay_range(text, now):
    """Owner decision 2026-10-07 (#2050): a round, rising pair joined by a space counts as a range,
    as one joined by a dash does, so these read as before. A phone both of whose halves are
    multiples of 100 is about 1 in 10,000."""
    assert reading(text) == now == before(text)


def test_DECIDED_a_wage_glued_to_a_phone_by_a_space_is_not_recorded():
    """"salary 25000 98765 43210" is one 15-digit run and no range, so 25000 goes with the phone.
    Prefer no number over a wrong one: a missing wage is asked again, a phone group is not."""
    text = "salary 25000 98765 43210"
    assert before(text) == (25000, None)
    assert reading(text) == (None, None)


# --- 4. the rule is the lexicon's, and nothing else moves ----------------------------------------


def test_the_detector_reads_the_lexicon_copy_both_engines_read():
    spec = lexicon.load("salary")
    assert signals._PHONE_CHAIN_RE.pattern == lexicon.compile_pattern(spec["phoneChain"]).pattern
    assert signals._PHONE_CHAIN_MIN_DIGITS == spec["phoneChainMinDigits"] == 9
    assert (spec["payRangeMaxRatio"], spec["payRangeRoundTo"]) == (5, 100)


def test_no_lexicon_utterance_moves_but_the_phone_rows():
    """The parity corpus (559 rows on 2026-10-07): only #2050's own `salph` rows move."""
    moved = {text for text, _b, _a in measure.moves(measure.lexicon_texts())}
    assert moved == {
        "mera number 98765 43210 hai",
        "phone 98765-43210",
        "mera number 987 654 3210",
        "+91 98765 43210",
        "job chahiye mera number 98765 43210",
        "number 98765 43210, salary 25000",
        devanagari("98765 43210") + " mera number hai",
        "salary 25000 98765 43210",
    }


# --- 5. linear -----------------------------------------------------------------------------------

# #1941: a timing test gets a generous, explicit budget. `signals.detect` at the size cap is the
# salary matcher's own scan (R55 (b): up to about 10 s on some shapes, BEFORE and shipped alike), so
# the guard's own scan is what is timed here. Measured 2026-10-07: 2-12 ms on each input below.
_BUDGET_MS = 750


@pytest.mark.parametrize("label", sorted(measure.TIMING_INPUTS))
def test_the_phone_chain_scan_is_linear_at_the_size_cap(label):
    text = measure.TIMING_INPUTS[label]
    assert len(text) <= DEFAULT_MAX_LENGTH
    start = time.perf_counter()
    signals._phone_chains(text)
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert elapsed_ms < _BUDGET_MS, f"{elapsed_ms:.0f}ms on {label}"


# --- 6. what the guard does not read -------------------------------------------------------------


@pytest.mark.parametrize("text", ["98765\n43210", "98765,43210 pe call karo", "98765.43210"])
def test_KNOWN_RESIDUAL_a_phone_split_by_a_line_break_a_comma_or_a_dot_reads_as_before(text):
    """Not joined, on purpose: a line break separates two answers ("25000\\n35000 chahiye"), a
    comma groups money ("25,000"), and a dot is a decimal ("2.5 lakh"). The gateway still masks all
    three and the output floor refuses them as phones."""
    assert reading(text) == before(text)
    assert contains_hard_identifier(text) == "phone"
