"""Interview engine tests (CNC/VMC)."""

from app.profiling import interview_engine


def test_first_question_is_role_and_neutral_toned():
    topic_id, question = interview_engine.first_question("cnc_vmc")
    assert topic_id == "role"
    # AI-PERSONA-2: default emits the placeholder token, never a real name; no gush.
    low = question.lower()
    for banned in ("bhai", "bhaiya", "beta", "behen", "yaar", "waah", "zabardast"):
        assert banned not in low
    assert question.startswith("{{worker_name}} ji, ")
    assert len(question.split()) <= 20


def test_first_question_prefixes_name_when_given():
    _topic_id, question = interview_engine.first_question("cnc_vmc", worker_name="Nitin")
    assert question.startswith("Nitin ji, ")


def test_messy_vmc_answer_updates_state():
    reply, asked_id, state, ready = interview_engine.next_turn(
        None, "vmc chalata hu 4 saal se", "cnc_vmc"
    )
    assert state.turn_count == 1
    assert "role" in state.answered_topics
    assert "machines" in state.answered_topics
    assert "experience" in state.answered_topics
    # Not enough core topics yet -> keep interviewing.
    assert ready is False
    assert asked_id is not None
    # AI-PERSONA-2: turn 1 is the OPEN vocative slot → placeholder token, no ack.
    assert reply.startswith("{{worker_name}} ji, ")


def test_extraction_ready_after_essential_info():
    # One rich answer covering role, machine, experience, and location.
    msg = "vmc operator, 4 saal, setting aur drawing reading karta hu, faridabad me hu pune chalega"
    _reply, asked_id, state, ready = interview_engine.next_turn(None, msg, "cnc_vmc")
    assert all(t in state.answered_topics for t in interview_engine.ESSENTIAL_TOPICS)
    assert ready is True
    assert asked_id is None  # wrap-up, no further question


def test_state_carries_forward_across_turns():
    _r1, _a1, state1, _ready1 = interview_engine.next_turn(
        None, "main vmc operator hoon", "cnc_vmc"
    )
    _r2, _a2, state2, _ready2 = interview_engine.next_turn(
        state1, "4 saal ka experience hai", "cnc_vmc"
    )
    assert state2.turn_count == 2
    assert "role" in state2.answered_topics
    assert "experience" in state2.answered_topics


# --- B-4: current vs preferred location, never conflated ---------------------
# docs/registers/context-drift-2026-07-16.md row B-4 (owner ruling 2026-07-17
# "current AND preferred — do not conflate"): the old single `location` topic was
# marked answered on EITHER field, so extraction_ready could flip with preferred
# location never asked. Now current_location is answer-essential and
# preferred_locations must at least be ASKED before readiness.


def _drive(messages: list[str], state=None):
    """Run next_turn over messages, returning the final (reply, asked, state, ready)."""
    out = None
    for msg in messages:
        out = interview_engine.next_turn(state, msg, "cnc_vmc")
        state = out[2]
    return out


def test_b4_ready_cannot_flip_until_preferred_locations_is_asked():
    """Register row B-4: essentials answered (current location included) is NOT
    enough — the preferred-locations question must have been served."""
    _reply, asked_id, state, ready = interview_engine.next_turn(
        None, "vmc operator, 4 saal, setting aata hai, faridabad me hu", "cnc_vmc"
    )
    assert "current_location" in state.answered_topics
    assert "preferred_locations" not in state.answered_topics
    assert all(t in state.answered_topics for t in interview_engine.ESSENTIAL_TOPICS)
    assert ready is False  # preferred never asked -> not ready
    assert asked_id == "preferred_locations"  # ...and it is the next ask


def test_b4_preferred_asked_but_unanswered_satisfies_the_gate():
    # The schema keeps preferred_locations optional (contracts.py: default []),
    # so the ASK satisfies the gate — a worker with no preference is not stuck.
    _r1, asked1, st1, ready1 = interview_engine.next_turn(
        None, "vmc operator, 4 saal, setting aata hai, faridabad me hu", "cnc_vmc"
    )
    assert asked1 == "preferred_locations" and ready1 is False
    _r2, asked2, st2, ready2 = interview_engine.next_turn(st1, "theek hai ji", "cnc_vmc")
    assert ready2 is True  # asked (not answered) satisfies MUST_ASK
    assert asked2 is None  # wrap-up


def test_b4_single_city_reply_to_preferred_question_keys_the_right_field():
    # Answered-detection keys on the RIGHT field: "Delhi chalega" in reply to the
    # preferred question is a PREFERENCE, not a current location.
    _r1, asked1, st1, _ = interview_engine.next_turn(
        None, "vmc operator, 4 saal, setting aata hai, faridabad me hu", "cnc_vmc"
    )
    assert asked1 == "preferred_locations"
    _r2, _a2, st2, ready2 = interview_engine.next_turn(st1, "Delhi bhi chalega", "cnc_vmc")
    assert ready2 is True
    assert st2.collected["preferred_locations"] == ["Delhi"]
    assert st2.collected["current_location"] == "Faridabad"  # unchanged


def test_b4_flexibility_reply_answers_preferred():
    _r1, asked1, st1, _ = interview_engine.next_turn(
        None, "vmc operator, 4 saal, setting aata hai, faridabad me hu", "cnc_vmc"
    )
    assert asked1 == "preferred_locations"
    _r2, _a2, st2, ready2 = interview_engine.next_turn(st1, "kahin bhi chalega", "cnc_vmc")
    assert ready2 is True
    assert "preferred_locations" in st2.answered_topics


def test_b4_combined_answer_satisfies_both_location_topics():
    """Register row B-4: "Pune mein hoon, Delhi bhi chalega" answers BOTH."""
    _reply, asked_id, state, ready = interview_engine.next_turn(
        None,
        "vmc operator, 4 saal, setting aata hai, Pune mein hoon, Delhi bhi chalega",
        "cnc_vmc",
    )
    assert "current_location" in state.answered_topics
    assert "preferred_locations" in state.answered_topics
    assert state.collected["current_location"] == "Pune"
    assert state.collected["preferred_locations"] == ["Delhi"]
    assert ready is True and asked_id is None


def test_b4_legacy_combined_state_ids_are_normalized_and_preferred_still_asked():
    # In-flight states minted under the old bank carry "location"/"salary" —
    # they map to current_location/salary_current, and preferred_locations
    # (never asked under the old bank) still gets its owner-ruled ask.
    from app.contracts import ConversationState

    legacy = ConversationState(
        role_family="cnc_vmc",
        turn_count=4,
        answered_topics=["role", "machines", "experience", "location", "salary"],
        asked_question_ids=["role", "machines", "experience", "location", "salary"],
    )
    _reply, asked_id, st, ready = interview_engine.next_turn(legacy, "haan ji", "cnc_vmc")
    assert "current_location" in st.answered_topics
    assert "location" not in st.answered_topics
    assert "salary_current" in st.answered_topics
    assert ready is False  # preferred_locations never asked under the old bank
    # skills is the first open core topic in bank order, then preferred follows.
    assert asked_id == "skills"
    _r2, asked2, st2, ready2 = interview_engine.next_turn(st, "setting aata hai", "cnc_vmc")
    assert asked2 == "preferred_locations" and ready2 is False
    _r3, asked3, _st3, ready3 = interview_engine.next_turn(st2, "Delhi chalega", "cnc_vmc")
    assert ready3 is True and asked3 is None


def test_b4_state_only_answer_does_not_satisfy_current_location():
    # The current_location topic keys on the CITY only. A state-only answer
    # ("bihar mai hu") must NOT mark it answered — otherwise the engine skips
    # "Abhi kis sheher mein hain?" and we lose the city, which is strictly better
    # matching data than a state. The state is still captured on the profile
    # (signals.current_state, the WS3 welder fix) — it just is not a city.
    from app.profiling import signals

    _reply, _asked, state, ready = interview_engine.next_turn(
        None, "vmc operator, 4 saal, setting aata hai, bihar mai hu", "cnc_vmc"
    )
    assert "current_location" not in state.answered_topics
    assert ready is False
    assert signals.detect("bihar mai hu").current_state == "Bihar"  # not dropped


def test_b5_bare_amount_reply_to_expected_salary_keys_expected():
    # B-5 salary split: a cue-less "25000" answering the EXPECTED question is
    # attributed to salary_expected (detect() alone would call it current).
    from app.contracts import ConversationState

    st = ConversationState(asked_question_ids=["salary_expected"], turn_count=1)
    _reply, _asked, st2, _ready = interview_engine.next_turn(st, "25000", "cnc_vmc")
    assert "salary_expected" in st2.answered_topics
    assert "salary_current" not in st2.answered_topics
    assert st2.collected["salary_expected"] == 25000
