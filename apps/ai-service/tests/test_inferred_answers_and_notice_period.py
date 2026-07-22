"""Two owner-reported defects from a real profiling session (2026-07-22).

1. An INFERRED value closed a question and then blocked the worker's real answer.
   "vmc operator hu" answers `role`, but the word "operator" also infers the
   generic skill "machine operation". That marked `skills` ANSWERED, so the skills
   question was never asked — and when the worker volunteered "setting aur tool
   offset aata hai, program edit nahi aata" two turns later it hit the P1-1
   first-write-wins rule as a non-asked topic and was DISCARDED. A specific,
   correctly-negated answer lost to a placeholder derived from the word "operator".

2. `notice_period_days` was never populated. "15 din lagenge" set the STATUS to
   notice_period and threw the number away.
"""

from app.profiling import interview_engine, signals

OWNER_SESSION = [
    "vmc operator hu",
    "vmc aur cnc lathe dono",
    "5 saal ho gaye",
    "setting aur tool offset aata hai, program edit nahi aata",
    "pune",
    "Nashik ya Aurangabad chalega",
    "fanuc",
    "25000",
    "35000 chahiye",
    "15 din lagenge",
    "ITI kiya hai",
    "NCVT certificate hai",
]


def _run(messages, role_family="cnc_vmc"):
    """Drive the engine the way main.py does, returning (ask_log, final_state)."""
    state, ask_log, message = None, [], "namaste"
    for i in range(len(messages) + 10):
        _reply, asked, state, _ready = interview_engine.next_turn(state, message, role_family)
        if asked is None:
            return ask_log, state
        ask_log.append(asked)
        message = messages[i] if i < len(messages) else "haan"
    raise AssertionError(f"interview never wrapped up: {ask_log}")


# --- 1. inferred values fill, but do not close ------------------------------


def test_an_inferred_skill_does_not_close_the_skills_topic():
    _reply, _asked, state, _ready = interview_engine.next_turn(None, "vmc operator hu", "cnc_vmc")

    # The value is still COLLECTED — free information fills an empty slot...
    assert state.collected["skills"] == ["machine operation"]
    # ...but the question is NOT considered answered, so it will still be asked.
    assert "skills" not in state.answered_topics
    # The genuinely-stated topics are unaffected.
    assert "role" in state.answered_topics
    assert "machines" in state.answered_topics


def test_a_real_skills_answer_replaces_the_inferred_one():
    """THE owner-reported defect, end to end."""
    _ask_log, state = _run(OWNER_SESSION)

    assert state.collected["skills"] == ["tool offset setting", "basic setting"]
    # The worker said "program edit nahi aata" — the denial must not become a skill.
    assert "program editing" not in state.collected["skills"]
    assert "machine operation" not in state.collected["skills"]


def test_a_generic_answer_to_the_skills_question_itself_still_counts():
    """`last_asked == "skills"` is a deliberate answer, however generic. Withholding
    the answered mark there would re-ask the same question until the bound tripped."""
    assert signals.detect_inferred_topics("chalata hu", "skills") == set()
    assert signals.detect_inferred_topics("vmc operator hu", None) == {"skills"}


def test_a_stated_skill_is_never_treated_as_inferred():
    """Only the bare generic is inferred. Anything the worker actually named — a
    gazetteer skill, drawing reading, setting knowledge — is a real answer."""
    for message in (
        "setting aata hai",
        "tool offset karta hu",
        "drawing padh leta hu",
        "vmc operator hu, setting bhi aati hai",
    ):
        assert signals.detect_inferred_topics(message, None) == set(), message


def test_first_write_wins_still_protects_a_REAL_established_value():
    """The P1-1 rule is not weakened: only an INFERRED fill may be replaced. A value
    the worker actually stated still beats an incidental later mention."""
    _r, _a, state, _ready = interview_engine.next_turn(None, "10 saal ka experience hai", "cnc_vmc")
    assert state.collected["experience"] == 10.0
    assert "experience" in state.answered_topics  # genuinely answered, not inferred

    # An incidental "3 saal" while answering something else must NOT overwrite it.
    _r2, _a2, state2, _ready2 = interview_engine.next_turn(
        state, "ITI aur 3 saal apprenticeship kiya hai", "cnc_vmc"
    )
    assert state2.collected["experience"] == 10.0


# --- 2. notice_period_days --------------------------------------------------


def test_notice_period_days_is_read_from_the_duration():
    for message, expected in (
        ("15 din lagenge", 15),
        ("pandrah din lagenge", 15),
        ("do mahine lagenge", 60),
        ("ek hafta lagega", 7),
        ("30 din baad join karunga", 30),
    ):
        sig = signals.detect(message)
        assert sig.availability == "notice_period", message
        assert sig.notice_period_days == expected, message


def test_notice_period_days_prefers_null_over_a_guess():
    """Every one of these must yield None — a fabricated notice period on a worker's
    resume is worse than a blank, and this field is payer-visible."""
    for message in (
        "15 din pehle join kiya tha",       # time AGO
        "hafte me 6 din kaam karta hu",     # a work WEEK
        "do mahine se salary nahi mili",    # time SINCE
        "15 din nahi lagenge",              # a denial
        "6 month ka experience hai",        # experience, not notice
        "resign kar diya hai",              # notice_period, but no duration stated
        "abhi free hu",                     # immediate
    ):
        assert signals.detect(message).notice_period_days is None, message


def test_notice_period_days_reaches_the_legacy_profile():
    from app.profiling import profile_extractor

    _rich, legacy = profile_extractor.extract("15 din lagenge", "cnc_vmc")
    assert legacy.availability.status == "notice_period"
    assert legacy.availability.notice_period_days == 15
