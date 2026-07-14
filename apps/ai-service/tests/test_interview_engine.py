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
