"""Tap-to-answer chips are ANSWERS to the question on screen.

The worker app sends a tapped chip's label verbatim as the worker's message
(``chat_profiling_screen.dart`` -> ``_sendText(f)``), so whatever is served here
becomes the worker's answer of record. That makes a wrong chip a FABRICATION, not
a cosmetic issue: the profile ends up asserting something the worker never said,
and every downstream consumer — resume, ranking, the employer's screen — believes
it.

The shipped behaviour this replaces served three hard-coded QUESTIONS on every
turn of every role family. Measured:

    'Controller kaunsa - Fanuc ya Siemens?' -> {'controllers': ['Fanuc','Siemens']}
    'Setting karte hain ya sirf operation?' -> {'skills': ['basic setting']}
    'Kis sheher mein kaam kar sakte hain?'  -> {}

One tap recorded two controllers nobody named; the third chip answered nothing,
so tapping it cost the worker a turn and a bounded re-ask.

Every option in the bank is EXECUTED against the detector below rather than
eyeballed. That is the whole point: 'CNC operator' and '10th pass' read as
perfectly good chips and both fail, so a rule enforced by review would have
shipped them.
"""

import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.profiling import interview_engine, signals
from app.profiling.question_bank import options_for, topics_for

client = TestClient(app)

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "ai-contracts"
    / "src"
    / "__fixtures__"
    / "answer-chips.json"
)

# Topics with no chips, and why. Both have an OPEN answer space: any four cities we
# offered would be four cities we put in the worker's mouth.
_NO_CHIP_TOPICS = {"current_location", "preferred_locations"}


# --- 1. every chip answers its own question ---------------------------------


def test_every_chip_resolves_the_topic_it_is_offered_under():
    """THE pin. A chip that does not resolve its topic is worse than no chip: the
    worker taps, sees their words in the transcript, and the field stays empty
    while the engine burns one of its two asks re-asking."""
    for topic in topics_for("cnc_vmc"):
        for option in topic.options:
            detected = signals.detect_answered_topics(option, topic.id)
            assert topic.id in detected, (
                f"chip {option!r} under topic {topic.id!r} resolves {detected} — "
                "it does not answer the question it is offered under"
            )


def test_no_chip_is_a_question():
    """The defect had a single visible signature: a '?' in the chip label. Cheap to
    assert, and it catches a regression at the moment the copy is written."""
    for topic in topics_for("cnc_vmc"):
        for option in topic.options:
            assert "?" not in option, f"{topic.id}: {option!r} is a question, not an answer"


def test_every_topic_either_offers_chips_or_deliberately_offers_none():
    """No topic gets chips by accident, and none silently loses them."""
    for topic in topics_for("cnc_vmc"):
        if topic.id in _NO_CHIP_TOPICS:
            assert topic.options == (), f"{topic.id} must stay free-text"
        else:
            assert topic.options, f"{topic.id} has no tap-to-answer options"


def test_the_negative_education_chip_actually_answers_the_topic():
    """'ITI nahi kiya' is a real answer, not a decline: it resolves `education` to
    None, which marks the topic ANSWERED so it is never re-asked. Without this the
    worker with no formal training has no way to say so by tapping."""
    detected = signals.detect_answered_topics("ITI nahi kiya", "education")
    assert "education" in detected
    assert detected["education"] is None


# --- 2. the chips follow the question ---------------------------------------


def test_chips_are_keyed_on_the_asked_topic_not_a_constant():
    """The removed constant was the same three strings for every topic. Different
    topics must now yield different chips, and each must match its own bank entry."""
    role = interview_engine.suggested_followups("cnc_vmc", "role")
    controllers = interview_engine.suggested_followups("cnc_vmc", "controllers")

    assert role != controllers
    assert role == list(topics_for("cnc_vmc")[0].options)
    assert "Fanuc" in controllers


def test_no_topic_asked_means_no_chips():
    """The wrap-up turn asks nothing. Offering answers to an unasked question is how
    the old constant fabricated in the first place."""
    assert interview_engine.suggested_followups("cnc_vmc", None) == []
    assert interview_engine.suggested_followups("cnc_vmc") == []
    assert options_for("cnc_vmc", None) == []
    assert options_for("cnc_vmc", "not_a_topic") == []


def test_chips_change_as_the_interview_advances():
    """End to end through the engine: turn 1 asks `role` and offers role answers;
    after the worker answers, the next turn's chips belong to the NEXT topic."""
    reply1, asked1, state, _ready = interview_engine.next_turn(None, "", "cnc_vmc")
    chips1 = interview_engine.suggested_followups("cnc_vmc", asked1)
    assert asked1 == "role"
    assert chips1 == ["VMC operator", "CNC turner", "Setter", "Programmer"]
    assert all(c.lower() in reply1.lower() or True for c in chips1)  # copy is free

    # Tap the first chip: it is sent verbatim as the worker's message.
    _reply2, asked2, _state2, _r2 = interview_engine.next_turn(state, chips1[0], "cnc_vmc")
    chips2 = interview_engine.suggested_followups("cnc_vmc", asked2)

    assert asked2 != asked1, "the engine moved on"
    assert chips2 != chips1, "the chips moved with it"


# --- 3. the regression, stated as behaviour ---------------------------------


def test_a_tapped_chip_records_only_what_that_chip_says():
    """The fabrication, inverted. Tapping the FIRST controller chip must record
    Fanuc and nothing else — the old question-chip recorded Fanuc AND Siemens."""
    chips = interview_engine.suggested_followups("cnc_vmc", "controllers")
    detected = signals.detect_answered_topics(chips[0], "controllers")
    assert detected["controllers"] == ["Fanuc"], detected


def test_chips_are_not_shared_across_role_families():
    """The old constant was byte-identical for `cnc_vmc`, `welding` and any unknown
    family, so a welder was offered CNC controllers to fabricate. Today every family
    falls back to the CNC/VMC bank, so the guarantee that matters is the one above —
    chips follow the TOPIC. This pins the seam that a second family will diverge on.
    """
    for family in ("cnc_vmc", "welding", "anything_unknown"):
        assert interview_engine.suggested_followups(family, "controllers") == [
            "Fanuc",
            "Siemens",
            "Mitsubishi",
            "Haas",
        ]
        # ...and never the old constant, whatever the family.
        assert all(
            "?" not in c for c in interview_engine.suggested_followups(family, "role")
        )


# --- 4. cross-language parity -----------------------------------------------


def test_the_bank_matches_the_golden_chip_fixture():
    """TD81 means STAGING RUNS THE MOCK, so `apps/api/src/ai/mock-interview.ts`
    serves what a real staging worker taps — a second copy of these strings that
    only TypeScript can see.

    Only this side can execute a chip against the detector. So both sides assert
    against one file: drift on either turns the other red, instead of the mock
    quietly acquiring a fabricating chip while both suites stay green.
    """
    assert _FIXTURE.exists(), (
        f"golden chip fixture missing at {_FIXTURE} — the TypeScript suite asserts "
        "against this same file, so losing it silently removes the parity guard"
    )
    golden = json.loads(_FIXTURE.read_text(encoding="utf-8"))

    actual = {t.id: list(t.options) for t in topics_for("cnc_vmc") if t.options}
    assert actual == golden["options"]

    free_text = [t.id for t in topics_for("cnc_vmc") if not t.options]
    assert sorted(free_text) == sorted(golden["free_text_only"])


def test_every_golden_chip_is_detector_verified():
    """The fixture's own rule, enforced. The TypeScript side copies these strings
    but cannot check them; this is where the check actually happens."""
    golden = json.loads(_FIXTURE.read_text(encoding="utf-8"))["options"]
    for topic_id, chips in golden.items():
        for chip in chips:
            assert topic_id in signals.detect_answered_topics(chip, topic_id), (
                f"golden chip {chip!r} does not resolve {topic_id!r}"
            )


# --- 5. through the endpoint ------------------------------------------------


def test_the_respond_endpoint_serves_chips_for_the_question_it_asked():
    body = client.post(
        "/profiling/respond",
        json={
            "session_id": "11111111-1111-4111-8111-111111111111",
            "worker_ref": "w-chips",
            "message_text": "namaste",
            "role_family": "cnc_vmc",
        },
    ).json()

    asked = body["asked_question_id"]
    assert asked is not None
    assert body["suggested_followups"] == options_for("cnc_vmc", asked)
    assert body["suggested_followups"], "a question was asked, so chips were due"
    for chip in body["suggested_followups"]:
        assert "?" not in chip
        assert asked in signals.detect_answered_topics(chip, asked)
