"""The GENERIC role family — uncovered trades (persona v3.2, worked conversation #04).

THE DEFECT. ``question_bank.topics_for()`` fell back to ``_CNC_VMC_TOPICS`` for any
family it did not know, and ``/profiling/respond`` resolved the family as
``detect_role_family(msg) or body.role_family`` — where apps/api always supplies
``priorState?.role_family ?? "cnc_vmc"``. So the fallback could never be reached from
production: a hotel cook, a tailor and a driver were all handed the CNC/VMC bank and
asked

    "Kaunsi machine — VMC, CNC lathe, HMC ya grinding?"

and offered ``VMC / CNC lathe / HMC / Grinding`` chips to TAP — and the worker app sends
a tapped chip's label verbatim as the worker's message, so one tap would have recorded
a machine the cook has never touched.

THE PERSONA SHEET is explicit about the shape of the fix:

    "Same warmth, plainer voice, fewer questions. Never says we don't serve that trade.
     No faked expertise."
    "faked fluency is worse than plainness"

So the ``generic`` family: the same neutral role question, then the sheet's own line
"Is kaam mein aap kya-kya karte hain?", then the shared topics (owner ruling 2026-07-31:
keep education/certifications — "fewer questions" is satisfied by dropping the CNC block,
not by cutting a worker's ITI off their resume). No chips on the trade topics, because
every chip in this repo must resolve through ``signals.detect_answered_topics`` and an
open trade space cannot guarantee that.

WHAT IS NOT DONE, deliberately: the worker is never told their trade is unsupported, and
their raw phrases still flow to extraction unchanged — they are the vocabulary the next
phase is built from.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.contracts import ConversationState
from app.main import app
from app.profiling import interview_engine, signals
from app.profiling.question_bank import (
    GENERIC_ROLE_FAMILY,
    ONE_SHOT_OPENER,
    one_shot_opener_for,
    options_for,
    topic_by_id,
    topics_for,
)

client = TestClient(app)

# Vocabulary that must NEVER be put to a worker whose trade we could not place. Every
# entry is a real string from the CNC/VMC, welding, plumbing, carpentry or design banks.
_TRADE_SPECIFIC_WORDS = (
    "vmc",
    "cnc",
    "hmc",
    "lathe",
    "grinding",
    "fanuc",
    "siemens",
    "mitsubishi",
    "haas",
    "heidenhain",
    "controller",
    "welding",
    "mig",
    "tig",
    "plasma",
    "autocad",
    "solidworks",
    "sketchup",
    "revit",
    "catia",
    "photoshop",
    "pipe wrench",
    "circular saw",
    "planer",
    "tool offset",
)

_COOK = ("main hotel me kaam karta hu", "khana banata hu", "tandoor aur curry banata hu")
_TAILOR = ("main darzi hu", "kapde silta hu", "shirt pant silai karta hu")
_DRIVER = ("gaadi chalata hu", "delivery ka kaam karta hu", "truck le jata hu")


# --- 1. the bank itself ------------------------------------------------------


def test_the_generic_bank_is_registered_and_is_the_unknown_family_fallback():
    assert GENERIC_ROLE_FAMILY == "generic"
    ids = [t.id for t in topics_for(GENERIC_ROLE_FAMILY)]
    assert ids[:2] == ["role", "daily_tasks"]
    # The fallback moved OFF cnc_vmc — that move is the whole fix.
    for unknown in ("hotel_kitchen", "tailoring", "", None):
        assert topics_for(unknown) is topics_for(GENERIC_ROLE_FAMILY)
    assert topics_for("cnc_vmc") is not topics_for(GENERIC_ROLE_FAMILY)


def test_the_generic_bank_names_no_machine_controller_or_software_anywhere():
    """THE property, swept over every worker-facing string the family can serve:
    question, retry wording, chips."""
    for topic in topics_for(GENERIC_ROLE_FAMILY):
        strings = [topic.question, topic.retry_question or "", *topic.options]
        for raw in strings:
            low = raw.lower()
            for word in _TRADE_SPECIFIC_WORDS:
                assert word not in low, f"{topic.id}: trade-specific {word!r} in {raw!r}"


def test_the_daily_tasks_question_is_the_persona_sheets_line_verbatim():
    topic = topic_by_id(GENERIC_ROLE_FAMILY, "daily_tasks")
    assert topic is not None
    assert topic.question == "Is kaam mein aap kya-kya karte hain?"
    assert topic.question.count("?") == 1  # B-5: one ask per turn
    assert len(topic.question.split()) <= 20


def test_the_generic_trade_topics_carry_no_chips_and_the_shared_ones_keep_theirs():
    """A tapped chip becomes the worker's answer of record, and every chip in this repo
    is executed against the detector (tests/test_answer_chips.py). The generic trade
    space is open, so no chip we could write is guaranteed to resolve — none are
    offered. The SHARED topics are trade-independent and keep theirs."""
    for topic_id in ("role", "daily_tasks"):
        assert options_for(GENERIC_ROLE_FAMILY, topic_id) == []
    assert options_for(GENERIC_ROLE_FAMILY, "experience") == [
        "1 saal",
        "3 saal",
        "5 saal",
        "10 saal",
    ]
    assert options_for(GENERIC_ROLE_FAMILY, "availability") == [
        "Turant",
        "15 din",
        "1 mahina",
        "2 mahina",
    ]
    # ...and every chip the generic family DOES serve still resolves its own topic.
    for topic in topics_for(GENERIC_ROLE_FAMILY):
        for option in topic.options:
            assert topic.id in signals.detect_answered_topics(option, topic.id), (
                f"generic chip {option!r} does not answer {topic.id!r}"
            )


def test_the_generic_family_keeps_education_and_certifications():
    """Owner ruling 2026-07-31: "fewer questions" must not cost an uncovered-trade
    worker their ITI. Every shared topic survives."""
    generic_ids = {t.id for t in topics_for(GENERIC_ROLE_FAMILY)}
    for topic_id in ("education", "education_level", "education_field", "certifications"):
        assert topic_id in generic_ids
    for topic_id in interview_engine.MUST_ASK_TOPICS:
        assert topic_id in generic_ids


def test_the_generic_family_has_a_working_opener_that_names_no_machine():
    opener = one_shot_opener_for(GENERIC_ROLE_FAMILY)
    assert opener == ONE_SHOT_OPENER  # the copy is shared because it was already neutral
    low = opener.lower()
    for word in _TRADE_SPECIFIC_WORDS:
        assert word not in low, f"opener names {word!r}"
    assert interview_engine.opening_message(GENERIC_ROLE_FAMILY) == opener


# --- 2. detection / persistence ---------------------------------------------


def test_detect_role_family_still_returns_none_for_an_uncovered_trade():
    """The precondition the resolution rests on — asserted, not assumed."""
    for transcript in (_COOK, _TAILOR, _DRIVER):
        for message in transcript:
            assert signals.detect_role_family(message) is None, message


def test_a_positive_detection_always_wins_over_everything_else():
    st = ConversationState(role_family=GENERIC_ROLE_FAMILY, asked_question_ids=["role"])
    assert interview_engine.resolve_role_family(st, "vmc chalata hu", "generic") == "cnc_vmc"
    assert interview_engine.resolve_role_family(None, "welding karta hu", "generic") == "welding"


def test_the_handover_waits_for_the_role_ask_budget_and_then_fires_once():
    # Turn 1: nothing asked yet -> the caller's family stands (a "namaste" must not
    # cost a real CNC worker their bank).
    assert interview_engine.resolve_role_family(None, "namaste", "cnc_vmc") == "cnc_vmc"

    # Role asked ONCE and unanswered -> still the caller's family (one fumble is what
    # the bounded re-ask exists for).
    st1 = ConversationState(
        role_family="cnc_vmc", asked_question_ids=["role"], ask_counts={"role": 1}
    )
    assert interview_engine.resolve_role_family(st1, "hmm", "cnc_vmc") == "cnc_vmc"

    # Budget spent, still unplaced -> generic.
    st2 = ConversationState(
        role_family="cnc_vmc", asked_question_ids=["role"], ask_counts={"role": 2}
    )
    assert (
        interview_engine.resolve_role_family(st2, "khana banata hu", "cnc_vmc")
        == GENERIC_ROLE_FAMILY
    )

    # ...and it is ONE-SHOT: once the interview has moved on, the predicate cannot fire
    # again, so a family recovered by detection is never dragged back.
    st3 = ConversationState(
        role_family="cnc_vmc",
        asked_question_ids=["role", "machines"],
        ask_counts={"role": 2, "machines": 1},
    )
    assert interview_engine.resolve_role_family(st3, "haan ji", "cnc_vmc") == "cnc_vmc"

    # An ANSWERED role is never a give-up, whatever the ask count.
    st4 = ConversationState(
        role_family="cnc_vmc",
        asked_question_ids=["role"],
        answered_topics=["role"],
        ask_counts={"role": 2},
    )
    assert interview_engine.resolve_role_family(st4, "haan ji", "cnc_vmc") == "cnc_vmc"


def test_the_resolution_is_pure_and_persists_through_the_existing_state_field():
    """No contract change: the family rides ``ConversationState.role_family``, which
    already exists and which apps/api already round-trips."""
    st = ConversationState(
        role_family="cnc_vmc", asked_question_ids=["role"], ask_counts={"role": 2}
    )
    before = st.model_dump()
    assert (
        interview_engine.resolve_role_family(st, "khana banata hu", "cnc_vmc")
        == GENERIC_ROLE_FAMILY
    )
    assert st.model_dump() == before  # pure — the resolver mutates nothing

    _reply, _asked, updated, _ready = interview_engine.next_turn(
        st, "khana banata hu", GENERIC_ROLE_FAMILY
    )
    assert updated.role_family == GENERIC_ROLE_FAMILY  # ...next_turn is what stamps it
    assert set(ConversationState.model_fields) == set(before)  # no new field


# --- 3. end to end through the endpoint -------------------------------------


def _post(message: str, state: dict | None, role_family: str = "cnc_vmc") -> dict:
    body: dict = {
        "session_id": "11111111-1111-4111-8111-111111111111",
        "worker_ref": "w-generic",
        "message_text": message,
        "role_family": role_family,
    }
    if state is not None:
        body["conversation_state"] = state
    res = client.post("/profiling/respond", json=body)
    assert res.status_code == 200, res.text
    return res.json()


def _run_transcript(transcript: tuple[str, ...], max_turns: int = 40) -> dict:
    """Drive /profiling/respond with the transcript, then repeat its last line until
    wrap-up. Returns {'asked': [...], 'served': [...], 'state': {...}, 'ready': bool}."""
    asked: list[str] = []
    served: list[str] = []
    state: dict | None = None
    ready = False
    messages = list(transcript)
    for turn in range(max_turns):
        message = messages[turn] if turn < len(messages) else messages[-1]
        body = _post(message, state)
        served.append(body["reply_text"])
        state = body["updated_state"]
        ready = body["extraction_ready"]
        if body["asked_question_id"] is None:
            return {"asked": asked, "served": served, "state": state, "ready": ready}
        asked.append(body["asked_question_id"])
        assert body["suggested_followups"] == options_for(
            state["role_family"], body["asked_question_id"]
        )
    raise AssertionError(f"interview did not wrap up — asked: {asked}")


def test_a_cook_is_never_asked_which_machine_they_run_and_reaches_the_wrap_up():
    run = _run_transcript(_COOK)
    assert run["state"]["role_family"] == GENERIC_ROLE_FAMILY
    assert run["ready"] is True
    # THE SHEET'S NAMED DEFECT, gone: "Kaunsi machine — VMC, CNC lathe, HMC ya
    # grinding?" and its four tap-to-answer machine chips are never put to a cook.
    assert "machines" not in run["asked"]
    assert "controllers" not in run["asked"]
    assert "skills" not in run["asked"]
    assert "daily_tasks" in run["asked"]  # ...the plain question is asked instead
    assert not any("machine" in q.lower() and "?" in q for q in run["served"][2:])

    # ACCEPTED COST, pinned rather than hidden. The handover fires only once `role`'s
    # bounded re-ask budget is spent, so the first two turns are still served from the
    # family apps/api sent — a cook can see the CNC role question's chips and its retry
    # examples ONCE. That is the deliberate trade: firing earlier would drop a real CNC
    # worker who typed "operator hu" out of the launch bank for a single fumble, losing
    # them machines/skills/controllers. From the handover onward nothing trade-specific
    # is ever shown again, which is what this asserts.
    after_handover = "\n".join(run["served"][2:]).lower()
    for word in _TRADE_SPECIFIC_WORDS:
        assert word not in after_handover, f"a cook was shown {word!r} after the handover"
    assert len(run["served"]) > 4  # the sweep above is not vacuous


def test_a_tailor_and_a_driver_get_the_same_treatment():
    for transcript in (_TAILOR, _DRIVER):
        run = _run_transcript(transcript)
        assert run["state"]["role_family"] == GENERIC_ROLE_FAMILY, transcript
        assert run["ready"] is True, transcript
        assert "machines" not in run["asked"], transcript
        assert "daily_tasks" in run["asked"], transcript


def test_the_worker_is_never_told_their_trade_is_unsupported():
    """The persona sheet's hardest rule: "Never says we don't serve that trade"."""
    run = _run_transcript(_TAILOR)
    text = "\n".join(run["served"]).lower()
    for apology in (
        "sorry",
        "support",
        "nahi karte",
        "available nahi",
        "not available",
        "cannot",
        "unable",
        "abhi hum",
    ):
        assert apology not in text, f"the bot said {apology!r}: {text!r}"


def test_a_cnc_worker_never_falls_into_the_generic_bank():
    """The counter-property. A worker who names their trade is placed on turn 1 and
    keeps the full CNC interview — the handover must not cost the launch family."""
    body = _post("vmc operator hu", None)
    assert body["updated_state"]["role_family"] == "cnc_vmc"
    assert body["suggested_followups"] == options_for("cnc_vmc", body["asked_question_id"])


def test_a_fumbled_start_recovers_the_full_cnc_interview_once_the_worker_names_a_machine():
    """THE RECOVERY PATH, which is why `generic` is a safe waypoint and not a dead end.
    A CNC worker whose first two replies place nothing is handed to `generic` — and the
    moment they name a machine they are handed BACK, with `machines` / `skills` /
    `controllers` still unasked and therefore still served."""
    state = None
    asked: list[str] = []
    for message in ("hmm", "operator hu", "abhi hu"):
        body = _post(message, state)
        state = body["updated_state"]
        if body["asked_question_id"]:
            asked.append(body["asked_question_id"])
    assert state["role_family"] == GENERIC_ROLE_FAMILY  # handed over...
    assert "machines" not in asked

    body = _post("vmc chalata hu", state)  # ...and handed straight back
    state = body["updated_state"]
    assert state["role_family"] == "cnc_vmc"
    assert "machines" in state["answered_topics"]

    for _ in range(20):
        if body["asked_question_id"] is None:
            break
        asked.append(body["asked_question_id"])
        body = _post("theek hai ji", state)
        state = body["updated_state"]
    assert "skills" in asked and "controllers" in asked, asked


def test_the_workers_raw_phrases_are_untouched_by_the_generic_path():
    """Their words are the vocabulary the next phase is built from, so the generic bank
    must not filter or rewrite anything. The endpoint masks nothing here (no PII in the
    message) and the turn is not blocked."""
    body = _post("main darzi hu, kapde silta hu", None)
    assert body["blocked"] is False
    assert body["pseudonymization_metadata"]["replaced_entities"] == 0
    assert body["pseudonymization_metadata"]["placeholder_tokens"] == []
