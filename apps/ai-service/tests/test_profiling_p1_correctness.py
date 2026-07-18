"""PRIORITY-1 profiling correctness — regression locks.

Every test here reproduces a defect that shipped WRONG DATA onto a worker's
resume. Each was written FAILING against the pre-fix parser, and each names the
observed wrong value in its assertion message so a regression reads as an
incident, not as a diff.

Three defect families (measured on the deterministic parser, no network):

- **P1-1 overwrite** — a later, INCIDENTAL mention silently replaced an
  established collected value (a 10-year machinist shipped as 3-year).
- **P1-2 negation** — a denial was read as an assertion ("iti nahi kiya" ->
  education ["ITI"]), i.e. the OPPOSITE of what the worker said.
- **P1-3 value parsing** — decimals lost their integer part ("2.5 saal" -> 5.0),
  annual pay was stored as monthly, and a start YEAR was stored as a salary.

All fixtures are SYNTHETIC: no real worker text, no real phone/employer/name.
"""

from __future__ import annotations

import pytest

from app.contracts import ConversationState
from app.profiling import interview_engine, signals


def _state(**kw) -> ConversationState:
    return ConversationState(role_family="cnc_vmc", **kw)


def _turn(state, message, **kw):
    """next_turn -> updated state only (the engine's collected/answered result)."""
    _reply, _asked, st, _ready = interview_engine.next_turn(state, message, **kw)
    return st


# ---------------------------------------------------------------------------
# P1-1 — collected values must not be silently overwritten
# ---------------------------------------------------------------------------
def test_incidental_experience_does_not_clobber_the_established_answer():
    """THE HEADLINE DEFECT. The worker answers experience "10 saal"; later, while
    answering the EDUCATION question, they mention a 3-year apprenticeship. Pre-fix
    collected["experience"] was reset to 3.0 — a ten-year machinist shipped as a
    three-year one."""
    st = _state(asked_question_ids=["experience"])
    st = _turn(st, "10 saal ka experience hai")
    assert st.collected["experience"] == 10.0

    # the engine has now moved on; the education question is the one on screen
    st.asked_question_ids.append("education")
    st = _turn(st, "ITI kiya hai, uske baad 3 saal apprenticeship")

    assert st.collected["experience"] == 10.0, (
        "incidental cross-topic mention overwrote an established value "
        f"(got {st.collected['experience']}, pre-fix bug shipped 3.0)"
    )
    assert st.collected["education"] == ["ITI"]  # the ASKED topic still commits


def test_answer_to_the_asked_topic_still_overwrites():
    """The rule must not freeze the interview: a second answer to the question
    actually on screen (e.g. the engine's ONE bounded re-ask) still commits."""
    st = _state(asked_question_ids=["experience"])
    st = _turn(st, "2 saal")
    assert st.collected["experience"] == 2.0
    st.asked_question_ids.append("experience")
    st = _turn(st, "sorry, 6 saal")
    assert st.collected["experience"] == 6.0


def test_explicit_correction_overwrites_across_topics():
    """A DELIBERATE correction must still work while a different question is on
    screen — this is the escape hatch that makes first-write-wins safe."""
    st = _state(asked_question_ids=["experience"])
    st = _turn(st, "3 saal")
    assert st.collected["experience"] == 3.0
    st.asked_question_ids.append("current_location")
    st = _turn(st, "nahi nahi, 10 saal ka experience hai")
    assert st.collected["experience"] == 10.0, (
        "an explicit self-correction was ignored — first-write-wins must not "
        "trap a worker with a wrong value"
    )


def test_incidental_signal_still_fills_an_empty_slot():
    """First-write-wins only protects an EXISTING value; volunteered information
    for an untouched topic is still free and must be recorded."""
    st = _state(asked_question_ids=["role"])
    st = _turn(st, "VMC operator hu, 5 saal se")
    assert st.collected["role"] == "VMC Operator"
    assert st.collected["experience"] == 5.0


def test_is_correction_is_tight_enough_to_not_fire_on_a_plain_answer():
    assert signals.is_correction("nahi nahi, 10 saal") is True
    assert signals.is_correction("galat bola, 5 saal") is True
    assert signals.is_correction("main VMC chalata hu 4 saal se") is False
    assert signals.is_correction("setting nahi aati") is False


# ---------------------------------------------------------------------------
# P1-2 — negation must not be read as an assertion
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("message", "wrong_value"),
    [
        ("iti nahi kiya", "ITI"),
        ("ITI nahi kiya hai", "ITI"),
        ("diploma nahi hai", "Diploma"),
        ("maine diploma nahin kiya", "Diploma"),
        ("iti nhi kiya", "ITI"),
        ("ITI बिल्कुल नहीं की", "ITI"),
    ],
)
def test_denied_education_is_never_recorded(message, wrong_value):
    sig = signals.detect(message)
    assert wrong_value not in sig.education, (
        f"{message!r} recorded {wrong_value!r} — the OPPOSITE of what the worker said"
    )


def test_denied_skill_is_never_recorded():
    sig = signals.detect("setting nahi aati, sirf chalata hu")
    assert not any("setting" in s for s in sig.skills), (
        f"denied skill recorded: {sig.skills} (pre-fix: ['basic setting'])"
    )
    assert sig.setting_knowledge == "unknown"
    # …and the part the worker DID assert survives the negation scope.
    assert sig.operation_knowledge == "strong"
    assert "machine operation" in sig.skills


def test_negation_scope_does_not_swallow_the_contrast():
    """'CNC nahi, VMC karta hu' must still yield VMC — the correction after the
    negator is the value the worker is actually asserting."""
    sig = signals.detect("CNC nahi, VMC karta hu")
    assert "VMC" in sig.machines
    assert sig.primary_role == "VMC Operator"


def test_negation_scope_is_clause_local():
    """A denial in one clause must not delete assertions in another."""
    sig = signals.detect("VMC chalata hu 5 saal se, lekin program edit nahi aata")
    assert "VMC" in sig.machines
    assert sig.experience_years == 5.0
    assert "program editing" not in sig.skills


def test_affirmative_tag_na_is_not_a_denial():
    """Hinglish 'na' is also an affirmative TAG ('VMC chalata hu na' = 'I do run
    VMC, right?'). Reading it as a denial would delete the claim just made."""
    sig = signals.detect("VMC chalata hu na")
    assert "VMC" in sig.machines
    sig2 = signals.detect("haan VMC chalata hu na sir")
    assert "VMC" in sig2.machines


def test_denial_answers_the_question_it_was_asked():
    """A denial is an ANSWER: the topic is marked answered (so it is not re-asked
    and is not mistaken for a clarification) but nothing is collected."""
    answered = signals.detect_answered_topics("iti nahi kiya", "education")
    assert "education" in answered
    assert answered["education"] is None

    st = _turn(_state(asked_question_ids=["education"]), "iti nahi kiya")
    assert "education" in st.answered_topics
    assert "education" not in st.collected


def test_incidental_denial_does_not_close_an_essential_ask():
    """'VMC nahi chalaya' while another question is on screen must NOT mark the
    essential machines topic answered — a denial there is not an answer."""
    answered = signals.detect_answered_topics("VMC nahi chalaya kabhi", "role")
    assert "machines" not in answered


# ---------------------------------------------------------------------------
# P1-3 — value parsing
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("2.5 saal ka experience", 2.5),
        ("1.5 saal", 1.5),
        ("10 saal", 10.0),
        ("4 years", 4.0),
        ("12.5 years experience", 12.5),
    ],
)
def test_decimal_experience_parses_the_whole_number(message, expected):
    """Pre-fix `(\\d{1,2})` had no left boundary, so '2.5 saal' matched the
    FRACTION and scored 5.0 — double the worker's real experience."""
    sig = signals.detect(message)
    assert sig.experience_years == expected, (
        f"{message!r} -> {sig.experience_years} (pre-fix '2.5 saal' shipped 5.0)"
    )


def test_a_digit_run_before_salary_is_not_read_as_years_of_experience():
    """The same missing boundary, second face: with no left anchor the engine
    matched the LAST TWO DIGITS of an amount, and the bare 'sal' alternative
    matched inside 'salary' — so "22000 salary" scored 0 years of experience."""
    assert signals.detect("22000 salary milti hai").experience_years is None


def test_annual_pay_is_not_stored_as_a_monthly_wage():
    """'1.5 lakh saal ka' is ANNUAL. Pre-fix it was stored as a ₹1,50,000 MONTHLY
    salary — a 12x overstatement on the worker's profile."""
    sig = signals.detect("1.5 lakh saal ka milta hai")
    assert sig.current_salary != 150_000, "annual pay stored as a monthly wage"
    assert sig.current_salary == 12_500


def test_monthly_pay_is_unchanged():
    assert signals.detect("22000 mahine ka milta hai").current_salary == 22_000
    assert signals.detect("salary 22k hai").current_salary == 22_000


def test_experience_clause_before_an_amount_does_not_make_it_annual():
    """'5 saal se 25000 milta hai' — the 'saal' belongs to the EXPERIENCE clause;
    treating it as a period cue would divide a correct monthly wage by twelve."""
    assert signals.detect("5 saal se 25000 milta hai").current_salary == 25_000


def test_ambiguous_period_records_nothing():
    """Contradictory period cues around one amount ("salana … mahine ka") ->
    prefer NO number over a wrong number, per the P1-3 ruling."""
    sig = signals.detect("salana 25000 mahine ka")
    assert sig.current_salary is None


@pytest.mark.parametrize(
    "message",
    [
        "2012 se kaam kar raha hu",
        "2015 se is line me hu",
        "1998 batch hu",
    ],
)
def test_a_four_digit_year_is_never_read_as_a_salary(message):
    sig = signals.detect(message)
    assert sig.current_salary is None, (
        f"{message!r} recorded a salary of {sig.current_salary} — that is a YEAR"
    )
    assert sig.expected_salary is None


def test_a_four_digit_amount_with_money_context_is_still_a_salary():
    """The year guard must not swallow real pay: an explicit money cue keeps it."""
    assert signals.detect("salary 2012 rupees hai").current_salary == 2012
