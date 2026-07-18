"""Issue #424 follow-up — the availability detector must not FABRICATE a value.

THE BUG (found in the post-merge review of PR #429, measured not hypothesised).
``signals`` matched availability with BARE SUBSTRINGS::

    _IMMEDIATE_CUES = ("immediate", "abhi", "turant", "free", "available", ...)
    _NOTICE_CUES    = ("notice", "din lag", "days", "month", "mahina", ...)

"abhi" only means "right now / currently", and the question bank's own questions
OPEN with it — "Abhi kis sheher mein hain?" (current_location, question_bank.py) and
"Abhi salary kitni hai?" (salary_current). So the natural answer to OUR question
invented an availability the worker never stated::

    "abhi pune me hu"  ->  {"current_location": "Pune", "availability": "immediate"}

WHY THIS IS FABRICATION AND NOT A COVERAGE GAP:

1. The value is LIVE. ``availability`` is a reach scoring signal
   (apps/api/src/reach/reach.job-source.ts) and is rendered on the worker's resume
   via ``humanizeAvailability``. We were telling payers a worker could start
   immediately purely because of the adverb in our own question.
2. It silently satisfied the must-ask gate #429 had just added for ``availability``
   (interview_engine.MUST_ASK_TOPICS), so the #424 ruling was not actually delivered
   on the common path: the topic was marked ANSWERED without ever being ASKED.
3. A fabricated value is never corrected — ``interview_engine._next_topic`` never
   returns a topic already in ``answered_topics``. A MISSING one just gets asked.

Hence the fail direction locked below: prefer NOT detecting over fabricating.
"""

from __future__ import annotations

import pytest

from app.profiling import interview_engine, signals


def _availability(text: str, asked: str | None = None) -> object:
    return signals.detect_answered_topics(text, asked).get("availability")


# --- The exact reported case ------------------------------------------------


def test_the_reported_case_answering_the_location_question_sets_no_availability():
    """'abhi pune me hu' — the answer to the bank's OWN "Abhi kis sheher mein hain?".

    Before the fix this returned
    ``{"current_location": "Pune", "availability": "immediate"}``.
    """
    detected = signals.detect_answered_topics("abhi pune me hu", "current_location")
    assert detected == {"current_location": "Pune"}
    assert "availability" not in detected


def test_the_reported_case_answering_the_salary_question_sets_no_availability():
    """'abhi 25000 milte hain' — the answer to "Abhi salary kitni hai?".

    This exact string is ``tests/test_interview_engine.py::_ANSWERS["salary_current"]``,
    which is how the over-match got INTO the suite and then hid behind an
    `asked or answered` assertion.
    """
    detected = signals.detect_answered_topics("abhi 25000 milte hain", "salary_current")
    assert detected == {"salary_current": 25000}
    assert "availability" not in detected


# --- Negative sweep: a bare adverb in an answer to some OTHER question -------


@pytest.mark.parametrize(
    ("text", "asked"),
    [
        ("abhi pune me hu", "current_location"),
        ("abhi delhi mein rehta hu", "current_location"),
        ("abhi mai bangalore me kaam karta hu", "current_location"),
        ("abhi 25000 milte hain", "salary_current"),
        ("abhi tankha 22000 hai", "salary_current"),
        ("abhi VMC chalata hu", "role"),
        ("abhi 5 saal ka experience hai", "experience"),
        ("abhi Fanuc controller par kaam karta hu", "controllers"),
        ("abhi ITI kar raha hu", "education"),
        ("abhi setting bhi karta hu", "skills"),
        # "abhi" as a SUBSTRING of an unrelated word — the word-boundary half.
        ("kabhi", "machines"),
        ("kabhi kabhi", "machines"),
        ("vmc nahi chalaya kabhi", "machines"),
        # "free" as a substring / an adjective on something that is not the worker.
        ("freelance kaam karta hu", "role"),
        ("VMC free size job karta hu", "machines"),
        # "available" attributed to a MACHINE or a VACANCY, not to the worker.
        ("mai available machine par kaam karta hu", "machines"),
        ("koi job available hai kya", "role"),
        # A duration that is EXPERIENCE, not a notice period. These used to come back
        # notice_period off the bare "month"/"mahina"/"days" cues.
        ("6 month ka experience hai", "experience"),
        ("2 saal 3 month ka experience", "experience"),
        ("chah mahina se VMC chala raha hu", "experience"),
    ],
)
def test_no_availability_is_invented_from_an_unrelated_answer(text: str, asked: str):
    assert _availability(text, asked) is None, (
        f"fabricated availability from an answer to {asked!r}"
    )


# --- Positive sweep: a GENUINE cue must still resolve ------------------------
#
# Losing these would be a regression in the OTHER direction, so they are pinned
# just as hard as the negatives above.


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # Immediacy words that ARE the answer on their own.
        ("turant", "immediate"),
        ("turant join kar sakta hu", "immediate"),
        ("immediately available", "immediate"),
        ("ready to join", "immediate"),
        # Being free / idle NOW. "abhi" is allowed to contribute here because a real
        # availability cue ("free hu") sits next to it.
        ("abhi free hu", "immediate"),
        ("job chhod di hai, abhi free hu", "immediate"),
        ("abhi khaali hu, kaam nahi kar raha", "immediate"),
        ("main available hu", "immediate"),
        ("abhi kuch nahi kar raha", "immediate"),
        # A time adverb NEXT TO a join/start intent — the only way "abhi"/"aaj"/"kal"
        # can count.
        ("abhi join kar sakta hu", "immediate"),
        ("aaj hi join kar sakta hu", "immediate"),
        ("kal se join kar lunga", "immediate"),
        ("aaj se ready hu", "immediate"),
        # Notice periods: a duration that is the time something TAKES.
        ("15 din lagenge", "notice_period"),
        ("do mahine lagenge", "notice_period"),
        ("ek mahina lagega", "notice_period"),
        ("30 din baad join karunga", "notice_period"),
        ("notice period 30 din ka hai", "notice_period"),
        ("1 month notice hai", "notice_period"),
        ("notice de diya hai", "notice_period"),
    ],
)
def test_a_genuine_availability_cue_still_resolves(text: str, expected: str):
    assert _availability(text, "availability") == expected


def test_an_employed_worker_serving_notice_is_not_read_as_immediate():
    """'abhi job kar raha hu, 1 mahina lagega' is the WORST old failure of the two:
    the worker says they are EMPLOYED with a month's notice, and the "abhi" made it
    ``immediate`` — the exact opposite, on a field payers filter on."""
    assert _availability("abhi job kar raha hu, 1 mahina lagega", "availability") == (
        "notice_period"
    )


# --- The context gate -------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("15 din", "notice_period"),
        ("7 din", "notice_period"),
        ("10 days", "notice_period"),
        ("ek mahina", "notice_period"),
        ("2 hafte", "notice_period"),
        ("kabhi bhi", "immediate"),
        ("jab bolo tab", "immediate"),
        ("kal se", "immediate"),
        ("abhi", "immediate"),
    ],
)
def test_bare_answers_resolve_only_when_availability_was_the_question(
    text: str, expected: str
):
    """A bare duration or time adverb IS an answer to "Join karne mein kitne din
    lagenge?" — and says nothing about availability anywhere else. Same shape as the
    B-4 location and B-5 salary attribution: read it only in the context that earns
    it. Reading "6 month" context-free is precisely how the notice-period side of
    this bug worked."""
    assert _availability(text, "availability") == expected
    assert _availability(text, "experience") is None
    assert _availability(text, "salary_current") is None


def test_a_past_tense_join_is_history_not_availability():
    """"2019 me company join ki thi" is where the worker HAS worked, not when they
    can start. The join cue matches ability/future forms only."""
    assert _availability("2019 me ek company join ki thi", "role") is None
    assert _availability("kal wali company join ki thi", "role") is None


# --- The engine-level consequence -------------------------------------------


def test_the_fabricated_value_no_longer_satisfies_the_424_must_ask_gate():
    """The #429 gate, delivered. A worker whose first message answers every essential
    the way real workers phrase it — starting with "abhi" — must still be ASKED about
    availability rather than having it inferred from that adverb."""
    _reply, _asked, state, ready = interview_engine.next_turn(
        None,
        "vmc operator hu, 4 saal ka experience, setting aata hai, abhi pune me hu",
        "cnc_vmc",
    )
    assert "availability" not in state.answered_topics
    assert "availability" not in state.collected
    assert ready is False, "wrapped up with a fabricated availability"
    assert "availability" in interview_engine.MUST_ASK_TOPICS
