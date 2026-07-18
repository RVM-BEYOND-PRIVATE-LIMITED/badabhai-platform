"""Interview engine tests (CNC/VMC)."""

from collections import Counter

from app.profiling import interview_engine
from app.profiling.question_bank import topic_by_id, topics_for


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


# --- INTERVIEW-1: bounded re-ask ---------------------------------------------
# Before INTERVIEW-1, _next_topic closed a topic the moment it was ASKED, so an
# ESSENTIAL topic the worker never actually answered silently shipped an
# incomplete profile. It is now re-asked — but ONLY under a hard bound, because
# "answered" is judged by the CNC/VMC-only gazetteer: an out-of-scope worker
# (welding) giving a PERFECT answer reads as unanswered, and an unbounded re-ask
# would loop them forever. The bound is the safety property of this whole change.

_ANSWERS = {
    "role": "cnc turner hoon",
    "machines": "vmc chalata hu",
    "experience": "4 saal ka experience hai",
    "skills": "setting aur drawing reading aata hai",
    "current_location": "pune me hu",
    "preferred_locations": "delhi bhi chalega",
    "controllers": "fanuc chalaya hai",
    "salary_current": "abhi 25000 milte hain",
    "salary_expected": "30000 chahiye",
    "availability": "15 din lagenge",
    "education": "ITI kiya hai",
}
_GARBAGE = "haan ji theek hai"


def _run_interview(reply_for, max_turns: int = 40):
    """Drive next_turn until wrap-up. ``reply_for(asked_id)`` supplies the worker's
    message. Returns ``(ask_log, final_state, final_ready, turns)``."""
    state = None
    ask_log: list[str] = []
    message = "namaste"
    ready = False
    for turn in range(1, max_turns + 1):
        _reply, asked_id, state, ready = interview_engine.next_turn(
            state, message, "cnc_vmc"
        )
        if asked_id is None:
            return ask_log, state, ready, turn
        ask_log.append(asked_id)
        message = reply_for(asked_id)
    raise AssertionError(
        f"interview did not terminate in {max_turns} turns — ask log: {ask_log}"
    )


def test_worker_who_answers_everything_is_asked_each_topic_exactly_once():
    """Required test 1: the happy path must not regress into nagging."""
    ask_log, state, _ready, _turns = _run_interview(lambda tid: _ANSWERS[tid])
    assert len(ask_log) == len(set(ask_log)), f"a topic was re-asked: {ask_log}"
    assert all(c == 1 for c in state.ask_counts.values()), state.ask_counts
    assert set(state.ask_counts) == set(ask_log)


def test_unparseable_machines_answer_is_re_asked_once_then_the_engine_moves_on():
    """Required test 2: an essential the detector cannot parse gets a SECOND ask
    (with the retry wording) and then the interview moves on — never a third."""
    served: list[str] = []
    state = None
    message = "cnc turner hoon"
    for _ in range(12):
        reply, asked_id, state, _ready = interview_engine.next_turn(
            state, message, "cnc_vmc"
        )
        if asked_id is None:
            break
        served.append(reply)
        # Answer everything EXCEPT machines, which gets an unparseable reply.
        message = _GARBAGE if asked_id == "machines" else _ANSWERS[asked_id]

    assert state.ask_counts["machines"] == 2
    assert "machines" not in state.answered_topics
    machines_turns = [r for r in served if "machine" in r.lower()]
    assert len(machines_turns) == 2, machines_turns
    # The second serve uses the NARROWER retry wording, not the same string again.
    retry = topic_by_id("cnc_vmc", "machines").retry_question
    assert machines_turns[0] != machines_turns[1]
    assert machines_turns[1].endswith(retry)
    assert retry.count("?") == 1 and len(retry.split()) <= 20


def test_no_topic_is_ever_asked_more_than_twice_under_a_totally_blind_detector(
    monkeypatch,
):
    """Required test 3 — THE ANTI-LOOP LOCK, the most important test here.

    The gazetteer is CNC/VMC-only, so a welder's perfect answer can read as NO
    answer at all. This stubs detection to ALWAYS fail (the worst case, strictly
    worse than the real welding gap) and proves the interview still TERMINATES and
    that MAX_ASKS_PER_TOPIC is never exceeded by ANY topic.

    Mutation proof: delete the `_ask_count(...) < MAX_ASKS_PER_TOPIC` guard from
    `_next_topic` and this test fails — the essential re-ask branch then returns the
    same unanswered essential forever and `_run_interview` raises "did not
    terminate".
    """
    monkeypatch.setattr(
        interview_engine.signals, "detect_answered_topics", lambda *a, **k: {}
    )
    ask_log, state, ready, turns = _run_interview(lambda _tid: _GARBAGE)

    counts = Counter(ask_log)
    assert max(counts.values()) <= interview_engine.MAX_ASKS_PER_TOPIC, counts
    assert counts == Counter(state.ask_counts)
    # Every ESSENTIAL topic got its full (bounded) budget: exactly two asks.
    for topic_id in interview_engine.ESSENTIAL_TOPICS:
        assert counts[topic_id] == 2, (topic_id, counts)
    # ...and nothing else was re-asked: optional/non-essential topics ask ONCE.
    for topic_id, n in counts.items():
        if topic_id not in interview_engine.ESSENTIAL_TOPICS:
            assert n == 1, (topic_id, counts)
    # It terminated, and honestly: nothing was answered, so it is NOT ready.
    assert turns <= interview_engine.MAX_INTERVIEW_TURNS + 1
    assert ready is False
    assert state.answered_topics == []


def test_the_turn_ceiling_terminates_the_interview_as_a_final_backstop(monkeypatch):
    """Required test 6 (ceiling): even with a blind detector AND an inflated topic
    bank, no interview can serve questions past MAX_INTERVIEW_TURNS."""
    monkeypatch.setattr(
        interview_engine.signals, "detect_answered_topics", lambda *a, **k: {}
    )
    # 40 extra always-open topics: without the ceiling this would run 40+ turns.
    from app.profiling.question_bank import Topic, topics_for

    inflated = list(topics_for("cnc_vmc")) + [
        Topic(f"filler_{i}", f"F{i}", f"Filler {i} kya hai?") for i in range(40)
    ]
    monkeypatch.setattr(
        interview_engine, "topics_for", lambda _rf: inflated
    )
    _ask_log, state, ready, turns = _run_interview(lambda _tid: _GARBAGE, max_turns=80)
    assert turns == interview_engine.MAX_INTERVIEW_TURNS + 1
    assert state.turn_count == interview_engine.MAX_INTERVIEW_TURNS + 1
    assert ready is False


def test_an_answered_topic_is_never_re_asked(monkeypatch):
    """Required test 4: the ABSOLUTE rule — re-ask is only ever for UNANSWERED
    topics. Asserted even with the detector blind AFTER the first answer, so the
    only thing keeping the topic closed is `answered_topics`."""
    _r1, asked1, st1, _ready1 = interview_engine.next_turn(
        None, "cnc turner hoon", "cnc_vmc"
    )
    assert asked1 == "machines"  # role answered on turn 1, so it is NOT re-asked
    assert "role" in st1.answered_topics

    # Blind the detector from here: nothing more can be answered, so `role` staying
    # closed is due to `answered_topics` alone — not to the ask bound.
    monkeypatch.setattr(
        interview_engine.signals, "detect_answered_topics", lambda *a, **k: {}
    )
    state = st1
    for _ in range(25):
        _reply, asked_id, state, _rd = interview_engine.next_turn(
            state, _GARBAGE, "cnc_vmc"
        )
        if asked_id is None:
            break
        assert asked_id != "role", "an ANSWERED topic was re-asked"
    # role was answered on turn 1 before it was ever asked, so it is never served.
    assert state.ask_counts.get("role", 0) == 0
    assert "role" not in state.asked_question_ids


def test_extraction_ready_is_false_when_essentials_are_unanswered(monkeypatch):
    """Required test 5 — the false-ready fix. Running out of questions is NOT the
    same as being ready; the old code returned a hardcoded True there, which is how
    an unanswered essential shipped as a 'complete' profile.

    Mutation proof: restore `return ..., True` on the wrap-up branch of `next_turn`
    and this test fails.
    """
    monkeypatch.setattr(
        interview_engine.signals, "detect_answered_topics", lambda *a, **k: {}
    )
    _ask_log, state, ready, _turns = _run_interview(lambda _tid: _GARBAGE)
    assert ready is False
    assert interview_engine._extraction_ready(state) is False
    assert not any(t in state.answered_topics for t in interview_engine.ESSENTIAL_TOPICS)


def test_legacy_state_without_ask_counts_deserializes_and_stays_bounded():
    """Required test 6 (back-compat, CLAUDE.md §2 #8): ask_counts is additive +
    defaulted, so an in-flight state minted before INTERVIEW-1 must load — and must
    NOT be handed a fresh full ask budget for topics it already asked."""
    from app.contracts import ConversationState

    legacy = ConversationState.model_validate(
        {
            "role_family": "cnc_vmc",
            "turn_count": 3,
            "answered_topics": ["role"],
            "asked_question_ids": ["role", "machines"],
            "collected": {"role": "CNC Turner/Operator"},
        }
    )
    assert legacy.ask_counts == {}  # defaulted, not required
    # machines was already asked once under the old state shape -> it gets ONE more
    # ask (2 total), never two more.
    assert interview_engine._ask_count(legacy, "machines") == 1

    _reply, asked_id, st, _ready = interview_engine.next_turn(legacy, _GARBAGE, "cnc_vmc")
    assert asked_id == "machines"
    assert st.ask_counts["machines"] == 2
    _r2, asked2, st2, _rd2 = interview_engine.next_turn(st, _GARBAGE, "cnc_vmc")
    assert asked2 != "machines"  # budget spent — no third ask
    assert st2.ask_counts["machines"] == 2


def test_ask_counts_holds_topic_ids_only_no_pii():
    """CLAUDE.md §2 #2: ConversationState carries profile signals, never identity
    PII. ask_counts keys are bank topic ids and values are ints — by construction."""
    known = {t.id for t in topics_for("cnc_vmc")}
    _ask_log, state, _ready, _turns = _run_interview(lambda tid: _ANSWERS[tid])
    assert set(state.ask_counts) <= known
    assert all(isinstance(v, int) for v in state.ask_counts.values())


def test_b5_bare_amount_reply_to_expected_salary_keys_expected():
    # B-5 salary split: a cue-less "25000" answering the EXPECTED question is
    # attributed to salary_expected (detect() alone would call it current).
    from app.contracts import ConversationState

    st = ConversationState(asked_question_ids=["salary_expected"], turn_count=1)
    _reply, _asked, st2, _ready = interview_engine.next_turn(st, "25000", "cnc_vmc")
    assert "salary_expected" in st2.answered_topics
    assert "salary_current" not in st2.answered_topics
    assert st2.collected["salary_expected"] == 25000
