"""Issue #2043 (split from #1950 / R56): the salary guard reads the identifier-only résumé cues.

THE DEFECT. The salary detector drops a number when its line, up to the number, ends in a
credential cue, a connector and an identifier-like run (lexicon `credentialBefore`). It knew only
the CREDENTIAL cues (roll, reg, certificate, licence, …), so an identifier the G1/G2 output floor
refuses on its RÉSUMÉ cue was still recorded as pay: "Passport No. M123456" -> 123456, "Voter ID
ABC1234567" -> 1234567, "GSTIN 27ABCDE1234F1Z5" -> 1234, and "dob 1995, salary 18000" -> 1995.
And with no leading word boundary, "payroll" ended in the cue "roll", so "payroll: 18000" lost a
real wage.

THE FIX. A leading `{WB}`; the cues passport, voter, gstin, uan, provident fund, ifsc, dob and
date of birth; and the "id" word in the connector's "no"-word slot ("Voter ID ABC1234567"), as the
G1/G2 résumé rule's connector reads it. Measured and LEFT OUT
(`scripts/measure_salary_guard_resume_cues.py`): "account" / "a/c" and "esic" sit right before
real wages, and protect nothing, since a full account, ESIC or UAN number is too long to be read
as pay. The connector keeps #1933's folded shape; #1933's and #1950's harnesses take #2043's
edits into their baselines, so each still measures its own tokens.

Both engines read the one lexicon file; `salary-credential-guard.test.ts` pins the TypeScript side.
All inputs are fabricated.
"""

from __future__ import annotations

import importlib.util
import time
from pathlib import Path

import pytest

from app.profiling import profile_extractor, signals
from app.pseudonymize import contains_hard_identifier


def _load_script(name: str):
    path = Path(__file__).resolve().parents[1] / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


measure = _load_script("measure_salary_guard_resume_cues")


def pay(text: str) -> tuple[object, object]:
    sig = signals.detect(text)
    return sig.current_salary, sig.expected_salary


# --- 1. the shipped guard is the #1950 guard with exactly #2043's edits ---------------------------


def test_the_shipped_guard_is_the_1950_guard_with_exactly_the_2043_edits():
    shipped = measure.shipped_source()  # asserts equality inside
    assert shipped.startswith("{WB}(?:roll|")
    for cue in measure.SHIPPED_CUES:
        assert f"|{cue}" in shipped
    for cue in measure.LEFT_OUT:
        assert f"|{cue}|" not in shipped and f"|{cue})" not in shipped


# --- 2. an identifier after a résumé cue is not pay ----------------------------------------------


@pytest.mark.parametrize(
    ("text", "before"),
    [
        ("Passport No. M123456", 123456),
        ("Passport.No. M123456", 123456),
        ("passport number Z7654321 hai", 7654321),
        ("Voter ID ABC1234567", 1234567),
        ("Voter ID: ABC1234567", 1234567),
        ("Provident Fund no MH/BAN/12345/678", 12345),
        ("provident fund number 45678", 45678),
        ("GSTIN 27ABCDE1234F1Z5", 1234),
        ("IFSC SBIN0001234", 1234),
    ],
)
def test_an_identifier_after_a_resume_cue_is_not_pay(text, before):
    with measure.guard(measure.BEFORE):
        assert pay(text) == (before, None)
    assert pay(text) == (None, None)


def test_a_birth_year_is_not_the_salary():
    # Before #2043 the year of birth was the current salary and the real one was lost.
    text = "dob 1995, salary 18000"
    with measure.guard(measure.BEFORE):
        assert pay(text) == (1995, None)
    assert pay(text) == (18000, None)


# --- 3. a real wage is kept ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # the left-out cues, right before a real wage
        ("salary account 25000 aata hai", (25000, None)),
        ("a/c: 18000 credit hota hai", (18000, None)),
        ("har mahine account 15000 credit", (15000, None)),
        ("ESIC 15000 milta hai", (15000, None)),
        # a résumé cue NEAR a wage: only the identifier run right after a cue is dropped
        ("PF ESIC ke saath 18000 milta hai", (18000, None)),
        ("UAN hai, salary 20000", (20000, None)),
        ("provident fund kat ke 17000", (17000, None)),
        ("passport ready hai 45000 chahiye", (None, 45000)),
        ("voter card hai 12000 milta hai", (12000, None)),
        ("ifsc diya hai, 21000 aayega", (21000, None)),
        ("date of birth 12/05/1995 hai aur 20000 chahiye", (None, 20000)),
        # a cue inside a word: "dobara" is not "dob", "payroll" is not "roll"
        ("dobara 18000 milega", (18000, None)),
        ("company payroll pe 19000", (19000, None)),
    ],
)
def test_a_real_wage_is_kept(text, expected):
    assert pay(text) == expected


@pytest.mark.parametrize(
    "text",
    ["Company payroll. 18000 milta hai", "on payroll:- 18000 milta hai", "payroll 18000",
     "payroll: 18000"],
)  # fmt: skip
def test_payroll_no_longer_ends_in_the_cue_roll(text):
    # The #1950 security review's nit: without a leading boundary "payroll" read as "roll".
    with measure.guard(measure.BEFORE):
        assert pay(text) == (None, None)
    assert pay(text) == (18000, None)


@pytest.mark.parametrize("cue", measure.LEFT_OUT)
def test_the_left_out_cues_would_drop_a_real_wage(cue):
    """Why each is left out: with it, a wage written right after it is lost."""
    text = {"esic": "ESIC 15000 milta hai", "account": "salary account 25000 aata hai",
            "a/c": "a/c: 18000 credit hota hai"}[cue]  # fmt: skip
    kept = pay(text)
    assert kept[0] is not None
    with measure.guard(measure.with_cues([*measure.SHIPPED_CUES, cue], boundary=True)):
        assert pay(text) == (None, None)


# --- 4. nothing else moves: the lexicon parity corpus --------------------------------------------


def test_no_lexicon_utterance_changes_its_salary():
    texts = measure.lexicon_texts()
    assert len(texts) > 500
    with measure.guard(measure.BEFORE):
        before = [pay(t) for t in texts]
    after = [pay(t) for t in texts]
    moved = [t for t, b, a in zip(texts, before, after, strict=True) if b != a]
    assert moved == []
    assert sum(1 for p in after if p != (None, None)) > 40  # the corpus does carry salaries


# --- 5. the G1/G2 floor and the guard now agree on these cues ------------------------------------


@pytest.mark.parametrize(
    "text",
    ["Passport No: K1234567", "Voter ID: ABC1234567", "GSTIN 27ABCDE1234F1Z5", "IFSC SBIN0001234"],
)
def test_what_g1_g2_refuses_on_a_resume_cue_is_not_pay(text):
    assert contains_hard_identifier(text) == "credential_id"
    assert pay(text) == (None, None)


@pytest.mark.parametrize(
    "text", ["voter id no XYZ9876543", "Voter ID No: XYZ9876543", "IFSC code HDFC0004321"]
)
def test_a_two_word_label_is_read_by_both_rules_since_2091(text):
    """Pinned here as `KNOWN_RESIDUAL` until #2091: both connectors read ONE number word, so "ID No"
    and the word "code" were read by neither the guard nor the G1/G2 résumé rule, G1/G2 admitted
    the text and its digits were pay (9876543, 4321). #2091 reads up to two label words in front
    of the number word, in the shared connector, so both rules agree on these the other way
    round. `test_pseudonymize_cued_id_two_word.py` pins the widening and its measurement."""
    assert contains_hard_identifier(text) == "credential_id"
    assert pay(text) == (None, None)


# --- 6. linear on a whitespace run after each new cue --------------------------------------------

#: #1933's budget and run length (`test_pseudonymize_cued_id_linear.py`): a super-linear connector
#: costs seconds at 1,000 characters, and a linear one a few ms, with room for a contended runner.
#: The structural guard is that the connector is #1933's, unchanged.
_BUDGET_MS = 750
_RUN = 1_000


@pytest.mark.parametrize(
    "cue", ["passport", "voter", "voter id", "provident fund", "dob", "date of birth"]
)
@pytest.mark.parametrize("entry", ["detect", "extract"])
def test_the_new_cues_stay_linear(cue, entry):
    text = cue + " " * _RUN + "!5000"
    fn = signals.detect if entry == "detect" else profile_extractor.extract
    started = time.perf_counter()
    fn(text)
    elapsed_ms = (time.perf_counter() - started) * 1000
    assert elapsed_ms < _BUDGET_MS, f"{elapsed_ms:.0f}ms"
    assert signals.detect(text).current_salary == 5000  # whitespace and "!" are no identifier
