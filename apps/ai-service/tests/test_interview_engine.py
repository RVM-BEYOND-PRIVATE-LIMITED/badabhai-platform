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
    # Issue #424 (owner ruling 2026-07-18): essentials answered is NO LONGER enough.
    # salary_current / salary_expected / availability joined MUST_ASK, so the engine
    # keeps interviewing until they have been RAISED.
    assert ready is False
    assert asked_id is not None
    _further, state, ready = _drive_to_wrap_up(state, asked_id, lambda tid: _ANSWERS[tid])
    assert ready is True  # ...and then it wraps up
    for topic_id in interview_engine.MUST_ASK_TOPICS:
        assert topic_id in state.answered_topics or topic_id in state.asked_question_ids


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


def _drive_to_wrap_up(state, asked_id, reply_for, max_turns: int = 40):
    """Continue an IN-PROGRESS interview to the wrap-up turn, answering each ask via
    ``reply_for(asked_id)``. Returns ``(further_ask_log, final_state, final_ready)``.

    Needed since #424: essentials-answered no longer wraps up in a single turn, so a
    test that owns some OTHER property (detection keying, vocative placement) has to
    walk the rest of the interview instead of asserting an immediate close."""
    ask_log: list[str] = []
    ready = False
    for _ in range(max_turns):
        if asked_id is None:
            return ask_log, state, ready
        ask_log.append(asked_id)
        _reply, asked_id, state, ready = interview_engine.next_turn(
            state, reply_for(asked_id), "cnc_vmc"
        )
    raise AssertionError(f"interview did not wrap up — further asks: {ask_log}")


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
    # #424 generalizes this to EVERY must-ask: a worker who answers none of them
    # still reaches wrap-up, because the obligation is on us to ASK, not on them
    # to answer. This drives the whole tail with a non-answer to prove exactly that.
    _r1, asked1, st1, ready1 = interview_engine.next_turn(
        None, "vmc operator, 4 saal, setting aata hai, faridabad me hu", "cnc_vmc"
    )
    assert asked1 == "preferred_locations" and ready1 is False
    further, st2, ready2 = _drive_to_wrap_up(st1, asked1, lambda _tid: "theek hai ji")
    assert ready2 is True  # asked (not answered) satisfies MUST_ASK
    for topic_id in interview_engine.MUST_ASK_TOPICS:
        assert topic_id in st2.asked_question_ids, f"{topic_id} never asked: {further}"
        assert topic_id not in st2.answered_topics  # ...and never answered
    assert len(further) == len(set(further))  # no nagging on the way there


def test_b4_single_city_reply_to_preferred_question_keys_the_right_field():
    # Answered-detection keys on the RIGHT field: "Delhi chalega" in reply to the
    # preferred question is a PREFERENCE, not a current location.
    _r1, asked1, st1, _ = interview_engine.next_turn(
        None, "vmc operator, 4 saal, setting aata hai, faridabad me hu", "cnc_vmc"
    )
    assert asked1 == "preferred_locations"
    _r2, _a2, st2, ready2 = interview_engine.next_turn(st1, "Delhi bhi chalega", "cnc_vmc")
    assert ready2 is False  # #424: salary/availability must-asks still pending
    assert st2.collected["preferred_locations"] == ["Delhi"]
    assert st2.collected["current_location"] == "Faridabad"  # unchanged


def test_b4_flexibility_reply_answers_preferred():
    _r1, asked1, st1, _ = interview_engine.next_turn(
        None, "vmc operator, 4 saal, setting aata hai, faridabad me hu", "cnc_vmc"
    )
    assert asked1 == "preferred_locations"
    _r2, _a2, st2, ready2 = interview_engine.next_turn(st1, "kahin bhi chalega", "cnc_vmc")
    assert ready2 is False  # #424: salary/availability must-asks still pending
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
    # #424: both location topics are satisfied, but the salary/availability
    # must-asks are not — so the engine keeps going instead of wrapping up here.
    assert ready is False and asked_id is not None


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
    _r3, asked3, st3, ready3 = interview_engine.next_turn(st2, "Delhi chalega", "cnc_vmc")
    # #424: the legacy "salary" id normalizes to salary_current (answered), but
    # salary_expected and availability are new must-asks and were never raised
    # under the old bank either — so they are still owed before wrap-up.
    assert ready3 is False and asked3 is not None
    assert "salary_current" in st3.answered_topics
    _further, st4, ready4 = _drive_to_wrap_up(st3, asked3, lambda _tid: "theek hai ji")
    assert ready4 is True
    for topic_id in ("salary_expected", "availability"):
        assert topic_id in st4.asked_question_ids


# --- Issue #424: salary + availability are MUST_ASK (owner ruling 2026-07-18) ---
# The readiness gate used to cover 5 topics. Because `next_turn` wraps up the instant
# readiness flips, and `detect_answered_topics` can mark several topics answered from
# ONE fluent sentence, a worker could be wrapped up having never been asked what they
# earn, what they want, or when they can join — the exact fields payers filter on.
# The ruling promotes all three to MUST_ASK (they must be ASKED) and DELIBERATELY NOT
# to ESSENTIAL (they need not be ANSWERED — nobody is forced to disclose their salary
# to get a profile).


def test_424_salary_and_availability_are_must_ask_but_never_essential():
    """The ruling, pinned as a constant so a later edit is a deliberate decision."""
    for topic_id in ("salary_current", "salary_expected", "availability"):
        assert topic_id in interview_engine.MUST_ASK_TOPICS, topic_id
        # The other half of the ruling, and the one that protects the worker: an
        # ESSENTIAL must be ANSWERED, so adding these there would let a refusal to
        # state a salary keep re-asking and land on `unanswered_essentials`.
        assert topic_id not in interview_engine.ESSENTIAL_TOPICS, topic_id
    # preferred_locations (B-4) is unchanged — this is additive, not a replacement.
    assert "preferred_locations" in interview_engine.MUST_ASK_TOPICS


def test_424_every_must_ask_id_exists_verbatim_in_the_question_bank():
    """A must-ask id with no matching bank topic could never be SERVED by
    `_next_topic`, so readiness would stay False until the ask ceiling tripped —
    a silent, hard-to-diagnose stall. This pins the ids against the bank."""
    bank_ids = {t.id for t in topics_for("cnc_vmc")}
    for topic_id in interview_engine.MUST_ASK_TOPICS:
        assert topic_id in bank_ids, f"must-ask {topic_id!r} is not a bank topic"
        assert topic_by_id("cnc_vmc", topic_id) is not None


def test_424_a_fluent_worker_is_still_asked_salary_and_availability():
    """THE ISSUE #424 REGRESSION TEST. One message answers every essential plus both
    location topics — under the old 5-topic gate the engine wrapped up right there and
    money/notice-period were never raised. Now it must keep interviewing."""
    _reply, asked_id, state, ready = interview_engine.next_turn(
        None,
        "vmc operator, 4 saal, setting aur drawing reading karta hu, "
        "faridabad me hu pune chalega",
        "cnc_vmc",
    )
    assert all(t in state.answered_topics for t in interview_engine.ESSENTIAL_TOPICS)
    assert "preferred_locations" in state.answered_topics
    assert ready is False, "wrapped up before salary/availability were raised"

    further, state, ready = _drive_to_wrap_up(state, asked_id, lambda _tid: "theek hai ji")
    assert ready is True
    for topic_id in ("salary_current", "salary_expected", "availability"):
        assert topic_id in further, f"{topic_id} never asked: {further}"
        assert topic_id in state.asked_question_ids


def test_424_no_worker_persona_reaches_wrap_up_with_a_must_ask_unraised():
    """The INVARIANT, swept over how differently workers actually reply: whatever the
    path, `extraction_ready` may not be True at wrap-up unless every MUST_ASK topic was
    ASKED. The 'answers every topic' persona is the discriminating one — it is exactly
    the fluent worker the old gate cut short.

    ASKED, not "asked or answered". The weaker `asked or answered` form is what let the
    availability over-match hide (post-merge review of #429): ``_ANSWERS`` answers the
    SALARY question with "abhi 25000 milte hain", and the old bare-substring cue read
    the "abhi" in it as ``availability = immediate``. So availability was marked
    ANSWERED without ever being asked, the weaker assertion passed through that branch,
    and the docstring's claim to cover "exactly the fluent worker the old gate cut
    short" was not true on the common path. A must-ask topic the worker was never asked
    is not raised, however it got into ``answered_topics``.
    """
    for label, reply_for in (
        ("answers every topic", lambda tid: _ANSWERS[tid]),
        ("answers nothing extractable", lambda _tid: _GARBAGE),
        ("one-word replies", lambda _tid: "haan"),
    ):
        _log, state, ready, _turns = _run_interview(reply_for)
        assert ready is True, label
        # Checked against the CONSTANT (so the invariant tracks any future must-ask)
        # AND against the three ids the ruling named LITERALLY — without the literals
        # this test would pass vacuously if someone reverted the constant.
        expected = set(interview_engine.MUST_ASK_TOPICS) | {
            "salary_current",
            "salary_expected",
            "availability",
        }
        for topic_id in sorted(expected):
            assert topic_id in state.asked_question_ids, (
                f"[{label}] wrapped up with {topic_id} never ASKED "
                f"(answered_topics={state.answered_topics})"
            )


def test_424_promoting_the_topics_did_not_start_nagging_the_worker():
    """The cost side of the ruling: MUST_ASK topics are non-essential, so they keep
    the ask-ONCE rule even when the worker never answers them. If this fails, the
    promotion accidentally made them re-askable and the interview nags about money."""
    ask_log, state, _ready, _turns = _run_interview(lambda _tid: "theek hai ji")
    counts = Counter(ask_log)
    for topic_id in ("salary_current", "salary_expected", "availability"):
        assert counts[topic_id] == 1, (topic_id, dict(counts))
        assert topic_id not in state.answered_topics  # asked, never answered
        assert topic_id not in state.unanswered_essentials  # ...and not an essential
    # The whole run still fits the ask budget the backstop is sized against.
    assert sum(state.ask_counts.values()) < interview_engine.MAX_ENGINE_ASKS


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
# "answered" is judged by a FINITE gazetteer: an out-of-scope worker (a fitter, an
# electrician) giving a PERFECT answer reads as unanswered, and an unbounded re-ask
# would loop them forever. The bound is the safety property of this whole change.
# (TAX-WELD-1 moved WELDING in-scope, so a welder is no longer an example of this —
# but the bound is not about welding: it must hold for whatever is out of scope
# next, which is why the locks below stub the detector blind rather than name a trade.)

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

    The gazetteer is finite, so an out-of-scope worker's perfect answer can read as
    NO answer at all. This stubs detection to ALWAYS fail (the worst case, strictly
    worse than any real gazetteer gap) and proves the interview still TERMINATES and
    that MAX_ASKS_PER_TOPIC is never exceeded by ANY topic. Deliberately trade-
    agnostic: TAX-WELD-1 brought welding in scope and this lock did not move, which
    is the point — the bound cannot depend on which trades the gazetteer knows.

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
    # It TERMINATED — the point of the bound.
    assert turns <= interview_engine.MAX_INTERVIEW_TURNS + 1
    assert state.answered_topics == []
    # ...and it still hands the worker off to extraction (see the regression guard
    # below), declaring the gaps explicitly rather than silently.
    assert ready is True
    assert state.unanswered_essentials == list(interview_engine.ESSENTIAL_TOPICS)


def test_the_ask_ceiling_terminates_the_interview_as_a_final_backstop(monkeypatch):
    """Ceiling backstop: even with a blind detector AND an inflated topic bank, the
    interview stops once the ENGINE ASK budget is spent. Counting asks (not turns)
    is what makes this backstop immune to clarify turns — see HIGH-1 above."""
    monkeypatch.setattr(
        interview_engine.signals, "detect_answered_topics", lambda *a, **k: {}
    )
    # 40 extra always-open topics: without the ceiling this would run 40+ asks.
    from app.profiling.question_bank import Topic

    inflated = list(topics_for("cnc_vmc")) + [
        Topic(f"filler_{i}", f"F{i}", f"Filler {i} kya hai?") for i in range(40)
    ]
    monkeypatch.setattr(interview_engine, "topics_for", lambda _rf: inflated)
    ask_log, state, ready, turns = _run_interview(lambda _tid: _GARBAGE, max_turns=200)
    assert len(ask_log) == interview_engine.MAX_ENGINE_ASKS
    assert sum(state.ask_counts.values()) == interview_engine.MAX_ENGINE_ASKS
    assert turns == interview_engine.MAX_ENGINE_ASKS + 1
    # The turn ceiling is the slack outer guard, DERIVED from the ask budget and the
    # clarify bound rather than guessed — so it can never bind before the asks do.
    assert interview_engine.MAX_INTERVIEW_TURNS == interview_engine.MAX_ENGINE_ASKS * (
        1 + interview_engine._MAX_CONSECUTIVE_CLARIFIES
    )
    assert interview_engine.MAX_INTERVIEW_TURNS > interview_engine.MAX_ENGINE_ASKS
    assert state.turn_count == interview_engine.MAX_ENGINE_ASKS + 1
    # Wrapping up at the ceiling still runs extraction, with the gaps declared.
    assert ready is True
    assert state.unanswered_essentials == list(interview_engine.ESSENTIAL_TOPICS)


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


def test_wrap_up_is_extraction_ready_EVEN_WITH_essentials_unanswered(monkeypatch):
    """THE REGRESSION GUARD. `extraction_ready` keeps its frozen v1 meaning: "the
    interview is OVER, run extraction".

    It is the SOLE gate on the profile.extraction_ready event in
    apps/api/src/chat/chat.service.ts, and therefore on extraction itself. If it
    went False on a gap, a worker whose answers the finite gazetteer cannot parse
    (a fitter saying "assembly line pe fitting karta hu") would finish the interview
    with NO profile and NO resume — strictly worse than the bug INTERVIEW-1 fixes,
    and aimed at exactly the population we are trying to help. Changing when a frozen
    v1 signal fires is also a behavioural contract change (CLAUDE.md §2 #8).

    The example is deliberately no longer a welder: TAX-WELD-1 brought welding in
    scope. The guard is unchanged, because the NEXT out-of-scope trade needs it just
    as much — which is why the detector is stubbed blind rather than fed a trade.

    Mutation proof: make the wrap-up branch return `extraction_ready` (the honest
    readiness) instead of True and this test fails.
    """
    monkeypatch.setattr(
        interview_engine.signals, "detect_answered_topics", lambda *a, **k: {}
    )
    _ask_log, state, ready, _turns = _run_interview(lambda _tid: _GARBAGE)

    # NOTHING was answered...
    assert state.answered_topics == []
    assert interview_engine._extraction_ready(state) is False
    # ...and the worker is STILL handed off to extraction.
    assert ready is True
    # The incompleteness is explicit, not silent: extraction/ops can see the gaps.
    assert state.unanswered_essentials == list(interview_engine.ESSENTIAL_TOPICS)


# --- HIGH-1: the ceiling must not be able to truncate the interview ----------
# The first cut spent the backstop in TURNS (15) while a blind run needs EXACTLY
# 15 asks — zero headroom — and clarify_turn increments turn_count while serving
# NO topic. So one "matlab kya?" cost the worker the LAST topic of the interview,
# and six cost them preferred_locations (the sole MUST_ASK). The budget is now
# spent in ENGINE ASKS, which clarify turns cannot consume.


def _blind_ask_budget() -> int:
    """The most asks a BLIND run of the current bank can possibly need."""
    return sum(
        interview_engine.MAX_ASKS_PER_TOPIC
        if t.id in interview_engine.ESSENTIAL_TOPICS
        else 1
        for t in topics_for("cnc_vmc")
    )


def test_the_ask_budget_has_real_headroom_over_a_blind_run(monkeypatch):
    """THE PIN for HIGH-1. Ties the constant to the bank's actual worst case, so a
    zero-margin ceiling can never silently come back — if someone adds topics or
    raises MAX_ASKS_PER_TOPIC without raising MAX_ENGINE_ASKS, this fails."""
    budget = _blind_ask_budget()
    assert budget == 15  # 4 essentials x 2 + 7 ask-once topics, for today's bank
    assert interview_engine.MAX_ENGINE_ASKS > budget, (
        "MAX_ENGINE_ASKS must exceed the blind-run budget, or the backstop itself "
        "truncates the interview and starves the tail topics"
    )

    # And the blind run really does spend exactly that many asks, no more.
    monkeypatch.setattr(
        interview_engine.signals, "detect_answered_topics", lambda *a, **k: {}
    )
    ask_log, state, _ready, _turns = _run_interview(lambda _tid: _GARBAGE)
    assert len(ask_log) == budget
    assert sum(state.ask_counts.values()) == budget


def test_actually_asking_availability_did_not_move_the_ask_budget():
    """The #424 follow-up (the availability over-match fix) makes `availability` get
    ASKED on paths where a fabricated "immediate" used to close it. That spends one
    more ask on those paths — this pins that it cannot approach the ceiling.

    The arithmetic is unchanged, because `availability` is a NON-essential, ask-ONCE
    topic and was therefore ALREADY counted once in the blind-run worst case:

        4 essentials x MAX_ASKS_PER_TOPIC(2) = 8
      + 7 ask-once topics x 1                = 7
      -------------------------------------------
        blind-run worst case                 = 15   <  MAX_ENGINE_ASKS = 20

    So the fix moves REAL runs closer to that bound, never past it. Measured: the
    fluent 'answers every topic' persona went 8 -> 9 asks (availability now asked),
    and the worst persona is unchanged at 15.
    """
    log_fluent, state_fluent, ready, _turns = _run_interview(lambda tid: _ANSWERS[tid])
    assert ready is True
    assert "availability" in state_fluent.asked_question_ids
    assert len(log_fluent) == 9

    worst = 0
    for reply_for in (
        lambda tid: _ANSWERS[tid],
        lambda _tid: _GARBAGE,
        lambda _tid: "haan",
        lambda _tid: "theek hai ji",
    ):
        _log, state, _ready, _turns = _run_interview(reply_for)
        worst = max(worst, sum(state.ask_counts.values()))
    assert worst == _blind_ask_budget() == 15
    assert worst < interview_engine.MAX_ENGINE_ASKS


def _drive_with_clarifies(message: str, max_turns: int = 200):
    """Mirror main.py's dispatch: clarify_turn first when the message reads as a
    clarification, else next_turn. This is the path a real worker takes."""
    state = None
    ask_log: list[str] = []
    for _ in range(max_turns):
        turn = None
        if interview_engine.needs_rephrase(message):
            turn = interview_engine.clarify_turn(state, message, "cnc_vmc")
        is_clarify = turn is not None
        if turn is None:
            turn = interview_engine.next_turn(state, message, "cnc_vmc")
        _reply, asked_id, state, _ready = turn
        if asked_id is None:
            return ask_log, state
        if not is_clarify:  # only ENGINE asks count as coverage
            ask_log.append(asked_id)
    raise AssertionError(f"did not terminate — ask log: {ask_log}")


def test_clarify_turns_cannot_starve_the_tail_of_the_interview(monkeypatch):
    """HIGH-1 regression: a worker who replies 'matlab kya?' every single turn must
    still be asked EVERY topic. On the first cut this reached only
    ['role','role','machines','machines','experience'] — current_location (an
    ESSENTIAL) and preferred_locations (the sole MUST_ASK) were never asked at all.
    """
    monkeypatch.setattr(
        interview_engine.signals, "detect_answered_topics", lambda *a, **k: {}
    )
    ask_log, _state = _drive_with_clarifies("matlab kya?")

    asked = set(ask_log)
    for topic_id in interview_engine.ESSENTIAL_TOPICS:
        assert topic_id in asked, f"ESSENTIAL {topic_id} never asked: {ask_log}"
    for topic_id in interview_engine.MUST_ASK_TOPICS:
        assert topic_id in asked, f"MUST_ASK {topic_id} never asked: {ask_log}"
    assert asked == {t.id for t in topics_for("cnc_vmc")}  # full coverage
    # The bound still holds on the clarify-heavy path.
    assert max(Counter(ask_log).values()) <= interview_engine.MAX_ASKS_PER_TOPIC


def test_graded_clarify_load_never_drops_a_topic(monkeypatch):
    """The review graded this: 1 clarify dropped `education`, 6 dropped
    `preferred_locations`. Sweep the load and assert coverage is constant."""
    monkeypatch.setattr(
        interview_engine.signals, "detect_answered_topics", lambda *a, **k: {}
    )
    expected = {t.id for t in topics_for("cnc_vmc")}
    for n_clarifies in (0, 1, 2, 6, 12, 30):
        state = None
        ask_log: list[str] = []
        sent = 0
        for _ in range(300):
            msg = "matlab kya?" if sent < n_clarifies else _GARBAGE
            turn = None
            if interview_engine.needs_rephrase(msg):
                turn = interview_engine.clarify_turn(state, msg, "cnc_vmc")
            is_clarify = turn is not None
            if turn is None:
                turn = interview_engine.next_turn(state, msg, "cnc_vmc")
            _reply, asked_id, state, _ready = turn
            if is_clarify:
                sent += 1
            if asked_id is None:
                break
            if not is_clarify:
                ask_log.append(asked_id)
        assert set(ask_log) == expected, f"{n_clarifies} clarifies dropped topics"


def test_the_ask_ceiling_is_immune_to_an_inflated_turn_count():
    """The ask budget is spent by asks, not turns: a huge turn_count (many clarify
    turns) must not by itself end the interview early."""
    from app.contracts import ConversationState

    st = ConversationState(role_family="cnc_vmc", turn_count=40)
    _reply, asked_id, _st2, _ready = interview_engine.next_turn(st, _GARBAGE, "cnc_vmc")
    assert asked_id == "role"  # still interviewing, despite 40 prior turns


def test_unanswered_essentials_lists_exactly_the_essentials_still_missing():
    """The completeness signal is specific, not a bare bool — it names the gaps."""
    _r1, _a1, st1, _rd1 = interview_engine.next_turn(None, "cnc turner hoon", "cnc_vmc")
    assert "role" in st1.answered_topics
    assert st1.unanswered_essentials == ["machines", "experience", "current_location"]

    _r2, _a2, st2, _rd2 = interview_engine.next_turn(st1, "vmc chalata hu", "cnc_vmc")
    assert st2.unanswered_essentials == ["experience", "current_location"]
    # Order is ESSENTIAL_TOPICS order, and it only ever shrinks as answers land.
    assert st2.unanswered_essentials == [
        t for t in interview_engine.ESSENTIAL_TOPICS if t not in st2.answered_topics
    ]


def test_unanswered_essentials_is_empty_when_everything_is_answered():
    _reply, asked_id, state, ready = interview_engine.next_turn(
        None,
        "vmc operator, 4 saal, setting aur drawing reading karta hu, "
        "faridabad me hu pune chalega",
        "cnc_vmc",
    )
    assert state.unanswered_essentials == []  # clean default = complete
    # #424: the ESSENTIALS gap list is empty, yet readiness is still False — the two
    # gates are deliberately independent. unanswered_essentials tracks what must be
    # ANSWERED; MUST_ASK tracks what must be RAISED. Promoting salary/availability to
    # MUST_ASK must NOT make them show up as unanswered essentials.
    assert ready is False and asked_id is not None
    for topic_id in ("salary_current", "salary_expected", "availability"):
        assert topic_id not in state.unanswered_essentials
    _further, state, ready = _drive_to_wrap_up(state, asked_id, lambda _tid: "theek hai ji")
    assert ready is True
    assert state.unanswered_essentials == []


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
    assert legacy.unanswered_essentials == []  # ditto — both fields are additive
    # machines was already asked once under the old state shape -> it gets ONE more
    # ask (2 total), never two more.
    assert interview_engine._ask_count(legacy, "machines") == 1

    _reply, asked_id, st, _ready = interview_engine.next_turn(legacy, _GARBAGE, "cnc_vmc")
    assert asked_id == "machines"
    assert st.ask_counts["machines"] == 2
    _r2, asked2, st2, _rd2 = interview_engine.next_turn(st, _GARBAGE, "cnc_vmc")
    assert asked2 != "machines"  # budget spent — no third ask
    assert st2.ask_counts["machines"] == 2


# --- MEDIUM-2: a hostile/corrupt ask_counts must not defeat the bound --------


def test_a_negative_ask_count_cannot_buy_extra_asks(monkeypatch):
    """`_ask_count` clamps at 0. Without the clamp a stored -1000000 bought
    effectively unlimited asks and only the (then-broken) turn ceiling stopped it —
    the bound must not depend on the caller having validated the state."""
    from app.contracts import ConversationState

    monkeypatch.setattr(
        interview_engine.signals, "detect_answered_topics", lambda *a, **k: {}
    )
    st = ConversationState(role_family="cnc_vmc")
    st.ask_counts["role"] = -1_000_000  # post-validation mutation, as model_copy allows
    assert interview_engine._ask_count(st, "role") == 0

    ask_log: list[str] = []
    state = st
    for _ in range(40):
        _reply, asked_id, state, _ready = interview_engine.next_turn(
            state, _GARBAGE, "cnc_vmc"
        )
        if asked_id is None:
            break
        ask_log.append(asked_id)
    assert Counter(ask_log)["role"] <= interview_engine.MAX_ASKS_PER_TOPIC


def test_pydantic_rejects_the_same_ask_counts_zod_rejects():
    """§7 parity: Zod's `z.number().int().nonnegative()` rejects -1 and "2". Plain
    `int` accepted both (Pydantic coerces "2" -> 2), so the schemas disagreed on the
    input domain — and the PERMISSIVE side was the one enforcing the bound."""
    import pytest
    from pydantic import ValidationError

    from app.contracts import ConversationState

    for bad in ({"role": -1}, {"role": "2"}, {"role": 1.5}):
        with pytest.raises(ValidationError):
            ConversationState.model_validate({"ask_counts": bad})
    # ...and the valid shape still loads.
    assert ConversationState.model_validate({"ask_counts": {"role": 2}}).ask_counts == {
        "role": 2
    }


# --- MEDIUM-3: only solicit answers the detector can actually resolve --------


def test_every_retry_option_offered_actually_resolves_against_the_detector():
    """The retry wording is a UX rewording, NOT a detection fix — but it must not
    invite answers we provably cannot record. Every example option offered in a
    retry_question is executed against the real detector here.

    THE PROPERTY: every option we OFFER for topic T resolves T against
    ``detect_answered_topics``. Mutation proof: add an option to any retry_question
    that the detector cannot key to that topic (e.g. put "TIG" in the `machines`
    retry, or "fitter" in the `role` retry) and the first loop below fails.

    TAX-WELD-1 changed what belongs here. Welding used to be listed as a documented
    limitation ('welder'/'TIG'/'MIG' returned {}); it now resolves, so 'welder' is
    OFFERED under `role` and carries the property like any other option. What is
    still asserted below is the narrower, real constraint: welding keys `role` and
    `skills` but NOT `machines`, which is exactly why the `machines` retry must not
    offer it.
    """
    from app.profiling import signals

    offered = {
        # TAX-WELD-1: 'welder' joins this list — it is now a recordable answer.
        "role": ["VMC operator", "CNC turner", "setter", "programmer", "welder"],
        "machines": ["VMC", "lathe", "HMC"],
        "experience": ["2 saal", "5 saal"],
        "current_location": ["Pune", "Delhi", "Rajkot"],
    }
    for topic_id, options in offered.items():
        retry = topic_by_id("cnc_vmc", topic_id).retry_question
        for option in options:
            assert option.lower() in retry.lower(), f"{option!r} not offered in {retry!r}"
            assert topic_id in signals.detect_answered_topics(option, topic_id), (
                f"retry for {topic_id} offers {option!r}, which does NOT resolve"
            )

    # Bare 'operator' keys skills, NOT role — so it is never offered alone.
    assert "role" not in signals.detect_answered_topics("operator", "role")

    # TAX-WELD-1: welding answers resolve, but they key `role`/`skills` only. There
    # is no welding `mach_*` id in the taxonomy, so they can never answer `machines`.
    # This is why the `machines` retry offers VMC/lathe/HMC and not TIG/MIG.
    machines_retry = topic_by_id("cnc_vmc", "machines").retry_question.lower()
    for welding_answer in ("welder", "TIG", "MIG", "TIG aur MIG"):
        resolved = signals.detect_answered_topics(welding_answer, "machines")
        assert "machines" not in resolved, (
            f"{welding_answer!r} now keys `machines` — the machines retry may offer it"
        )
        assert "role" in resolved, f"{welding_answer!r} no longer resolves role"
        assert welding_answer.lower() not in machines_retry, (
            f"machines retry offers {welding_answer!r}, which cannot answer `machines`"
        )

    # ...and a genuinely out-of-scope trade still resolves NOTHING. This is the
    # population the ASK BOUND (not the wording) exists to protect.
    for out_of_scope in ("fitter", "electrician", "carpenter"):
        assert signals.detect_answered_topics(out_of_scope, "role") == {}


# --- LOW-4: clarify must re-serve the wording the worker actually saw --------


def test_clarify_re_serves_the_retry_wording_after_a_re_ask():
    """Replying to 'matlab kya?' with the ORIGINAL, earlier wording reads as the bot
    going backwards. The re-serve is re-derived from ask_counts."""
    from app.contracts import ConversationState

    topic = topic_by_id("cnc_vmc", "role")
    # Asked ONCE -> the worker saw the original wording.
    st1 = ConversationState(asked_question_ids=["role"], ask_counts={"role": 1})
    out1 = interview_engine.clarify_turn(st1, "matlab kya?", "cnc_vmc")
    assert out1 is not None and out1[0] == topic.question

    # Asked TWICE -> the worker saw the RETRY wording, so that is what is re-served.
    st2 = ConversationState(asked_question_ids=["role"], ask_counts={"role": 2})
    out2 = interview_engine.clarify_turn(st2, "matlab kya?", "cnc_vmc")
    assert out2 is not None and out2[0] == topic.retry_question
    assert out2[0] != topic.question
    # A clarify is not an ask: the budget stays clarify-immune.
    assert out2[2].ask_counts == {"role": 2}


def test_clarify_re_serve_matches_what_next_turn_actually_served():
    """End-to-end: whatever string the engine served last, clarify_turn repeats THAT
    one — asserted for both the first ask and the bounded re-ask."""
    served, state = [], None
    for _ in range(2):
        reply, asked_id, state, _ready = interview_engine.next_turn(
            state, _GARBAGE, "cnc_vmc"
        )
        assert asked_id == "role"  # role is unanswered, so it gets both asks
        served.append(reply)
        out = interview_engine.clarify_turn(state, "matlab kya?", "cnc_vmc")
        assert out is not None
        assert served[-1].endswith(out[0]), (
            f"clarify re-served {out[0]!r} but the worker saw {served[-1]!r}"
        )
    assert served[0] != served[1]  # and the two asks used different wordings


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
