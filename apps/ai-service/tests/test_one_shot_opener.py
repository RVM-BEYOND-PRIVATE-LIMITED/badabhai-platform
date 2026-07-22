"""The one-shot opener (owner-approved 2026-07-22).

An invitation to answer everything in one message, for the worker who would rather
type once than be asked twelve times. Three properties matter, and each is measured
here rather than argued:

  1. The opener must not ANSWER ITS OWN QUESTIONS. It names twelve topics, which is
     exactly the shape PR #493 exists to stop being read as worker answers.
  2. The opener must not RECORD anything. Marking its topics "asked" would wrap the
     interview having served nothing — re-creating issue #424 from the other side.
  3. The opener must never be POSTED into the extraction transcript.
"""

from fastapi.testclient import TestClient

from app.main import app
from app.profiling import interview_engine, profile_extractor, signals
from app.profiling.question_bank import ONE_SHOT_OPENER, one_shot_opener_for, topics_for

client = TestClient(app)


# --- 1. the copy answers nothing --------------------------------------------


def test_the_opener_does_not_answer_its_own_questions():
    """THE pin. "No example values" is NOT a sufficient rule and must never be
    trusted as one: an earlier category-only draft still self-keyed `skills` (from
    "machine chalate hain") and `availability` (from "kitne din ka notice").
    Inertness is a property of the EXACT string, so the exact string is measured."""
    assert signals.detect_answered_topics(ONE_SHOT_OPENER, None) == {}


def test_the_opener_extracts_no_profile_fields():
    """The stronger form of the same claim, through the real extractor. A draft that
    named example values ("VMC, CNC lathe ... Fanuc, Siemens ... ITI, diploma")
    produced EIGHT populated fields including
    certifications=['NCVT','NSQF','Apprenticeship'] — a complete fabricated profile
    from a worker who had said nothing at all."""
    rich, legacy = profile_extractor.extract(ONE_SHOT_OPENER, "cnc_vmc")

    assert legacy.canonical_role_id is None
    assert legacy.machines == []
    assert legacy.skills == []
    assert legacy.experience.total_years is None
    assert legacy.location_preference.preferred_cities == []
    assert legacy.location_preference.current_city is None
    assert legacy.salary_expectation.amount_min is None
    assert legacy.availability.status == "unknown"
    assert rich.machines == []
    assert rich.controllers == []
    assert rich.education == []
    assert rich.certifications == []


def test_the_opener_holds_exactly_one_question_mark():
    """B-5 (owner ruling 2026-07-17) is one question mark per served message. The
    opener obeys the letter as the ONE sanctioned exception — it is an invitation the
    worker may ignore, not an ask they must answer. The ≤20-word cap deliberately
    does NOT apply here; that test iterates `topics_for()`, which this is not in."""
    assert ONE_SHOT_OPENER.count("?") == 1


def test_the_opener_names_no_certification():
    """`certifications` is the one topic the detector cannot read context-free, so
    naming it would guarantee the worker answers it here and is asked it again."""
    lowered = ONE_SHOT_OPENER.lower()
    for token in ("ncvt", "nsqf", "scvt", "certificate", "certification"):
        assert token not in lowered, token


def test_the_opener_is_not_in_the_question_bank():
    """It is not a Topic. If it were, `_next_topic` would serve it as a real ask."""
    assert ONE_SHOT_OPENER not in [t.question for t in topics_for("cnc_vmc")]
    assert one_shot_opener_for("cnc_vmc") == ONE_SHOT_OPENER
    assert one_shot_opener_for("anything_unknown") == ONE_SHOT_OPENER


# --- 2. the opener records nothing ------------------------------------------


def test_the_opener_is_pure_and_records_nothing():
    """`opening_message` takes and returns no ConversationState. That is the whole
    safety property — see the regression the next test measures."""
    assert interview_engine.opening_message() == ONE_SHOT_OPENER
    assert interview_engine.opening_message("cnc_vmc") == ONE_SHOT_OPENER


def test_marking_the_openers_topics_asked_would_break_must_ask_coverage():
    """WHY the opener records nothing, measured rather than asserted.

    The tempting "we just asked them all twelve things" shortcut wraps the interview
    on turn 1 having served ZERO questions, with every MUST_ASK topic silently never
    raised. This test pins the CORRECT behaviour beside the broken one so the
    shortcut cannot be reintroduced as an optimisation.
    """
    fluent = "VMC operator hu, 5 saal ka experience, Pune me hu, VMC aur CNC lathe chalata hu"

    # The real path: the opener recorded nothing, so the engine still asks.
    _reply, asked, state, ready = interview_engine.next_turn(None, fluent, "cnc_vmc")
    assert asked is not None, "the engine must still be asking after a one-shot answer"
    assert ready is False
    assert state.unanswered_essentials == []

    # The broken path, for contrast: pretend the opener marked its topics asked.
    seeded = interview_engine.ConversationState(
        role_family="cnc_vmc",
        asked_question_ids=[t.id for t in topics_for("cnc_vmc")],
    )
    _r2, asked2, state2, ready2 = interview_engine.next_turn(seeded, fluent, "cnc_vmc")
    assert asked2 is None and ready2 is True, "expected the seeded shortcut to wrap immediately"
    never_raised = [
        t
        for t in interview_engine.MUST_ASK_TOPICS
        if t not in state2.answered_topics and t not in seeded.asked_question_ids
    ]
    assert never_raised == [], "sanity: seeding marks them asked, which is exactly the lie"
    # ...and the damage: not one question was actually served to the worker.
    assert sum(state2.ask_counts.values()) == 0


def test_a_one_shot_answer_reaches_wrap_up_in_two_turns():
    """The measured payoff: 11 of 12 topics from one message, `certifications` the
    single follow-up, wrap on turn 2 instead of 13."""
    one_shot = (
        "VMC operator hu, 5 saal ka experience, Pune me hu, VMC aur CNC lathe chalata hu, "
        "setting aur tool offset aata hai, Fanuc controller, abhi 25000 milta hai, "
        "35000 chahiye, 15 din lagenge, ITI kiya hai, Nashik ya Aurangabad chalega"
    )
    _reply, asked, state, ready = interview_engine.next_turn(None, one_shot, "cnc_vmc")

    assert len(state.answered_topics) == 11
    assert asked == "certifications"
    assert ready is False

    _r2, asked2, state2, ready2 = interview_engine.next_turn(
        state, "NCVT certificate hai", "cnc_vmc"
    )
    assert asked2 is None and ready2 is True
    assert state2.turn_count == 2


# --- 3. the endpoint --------------------------------------------------------


def test_the_opening_endpoint_serves_the_constant():
    response = client.post("/profiling/opening", json={})
    assert response.status_code == 200
    assert response.json() == {"opening_text": ONE_SHOT_OPENER}


def test_the_opening_endpoint_defaults_its_role_family():
    """apps/api sends `{}`; an explicit family must give the same answer today."""
    bare = client.post("/profiling/opening", json={})
    explicit = client.post("/profiling/opening", json={"role_family": "cnc_vmc"})
    assert bare.json() == explicit.json()


# --- 4. never posted --------------------------------------------------------


def test_the_opener_posted_as_an_assistant_line_still_extracts_nothing():
    """Defence in depth. The opener must never be posted — but if it ever were, and
    the caller sends role-tagged `messages`, PR #493's split must keep it out of the
    detector. This pins that for the opener's specific shape.
    """
    worker = "fanuc chalata hu, 5 saal ho gaye"
    posted = client.post(
        "/profile/extract",
        json={
            "worker_ref": "w-opener",
            "transcript": f"Bada Bhai: {ONE_SHOT_OPENER}\nWorker: {worker}",
            "messages": [
                {"role": "assistant", "text": ONE_SHOT_OPENER},
                {"role": "worker", "text": worker},
            ],
        },
    ).json()
    absent = client.post(
        "/profile/extract",
        json={
            "worker_ref": "w-opener",
            "transcript": f"Worker: {worker}",
            "messages": [{"role": "worker", "text": worker}],
        },
    ).json()

    assert posted["profile"] == absent["profile"]
    assert posted["worker_profile_draft"] == absent["worker_profile_draft"]


def test_the_opener_is_inert_even_on_the_rollback_path():
    """The reason the copy names no example values, rather than relying on #493.

    PR #493 documents `messages`-absent as its ROLLBACK LEVER: drop the field and the
    service behaves as it did before the split. A value-naming opener would turn that
    documented safety lever into a fabrication event — measured on an earlier draft:
    four machines, five controllers, ITI+Diploma and NCVT+NSQF for a worker who named
    none of them. With the shipped copy the lever stays safe.
    """
    worker = "fanuc chalata hu, 5 saal ho gaye"
    body = client.post(
        "/profile/extract",
        json={
            "worker_ref": "w-opener",
            "transcript": f"Bada Bhai: {ONE_SHOT_OPENER}\nWorker: {worker}",
        },
    ).json()

    assert body["profile"]["machines"] == []
    assert body["worker_profile_draft"]["controllers"] == ["Fanuc"]
    assert body["worker_profile_draft"]["education"] == []
    assert body["worker_profile_draft"]["certifications"] == []
    assert body["profile"]["location_preference"]["preferred_cities"] == []
