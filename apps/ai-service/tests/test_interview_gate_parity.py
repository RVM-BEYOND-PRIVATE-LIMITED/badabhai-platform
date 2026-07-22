"""The interview gate, pinned ACROSS the language boundary.

``ESSENTIAL_TOPICS`` / ``MUST_ASK_TOPICS`` and the bank's topic ids exist in two
hand-maintained copies — this engine and ``apps/api/src/ai/mock-interview.ts`` —
and until this file nothing compared them. Each side pinned itself:
``test_profiling_parser_coverage.py::test_the_429_must_ask_gate_holds_across_every_scripted_interview``
holds the Python literal, ``mock-interview.test.ts`` holds the TypeScript one, and
the mock's only MUST_ASK assertion was a SUBSET check against the mock's own bank,
which stays true whatever this module does.

MEASURED, and the reason this file exists: deleting ``"availability"`` from
``MUST_ASK_TOPICS`` left BOTH suites green. Not "green after a plausible edit" —
green after deleting one of the three fields issue #424 was filed about.

Under TD81 the TypeScript mock is what actually runs on staging, so the copy that
drifts unnoticed is the copy a real staging worker meets. Both sides now assert
against one JSON file: drift on either turns the OTHER red.

This is ADDITIVE to the per-side literal pins, which are deliberately kept. They
answer a different question — "was this edit deliberate?" — and a shared fixture
cannot answer it, because a careless edit can update the fixture too. The literal
pins carry the ticket ids and the ruling text that make someone stop and think;
this file makes sure that when they do change it, they change it in both languages.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.profiling.interview_engine import ESSENTIAL_TOPICS, MUST_ASK_TOPICS
from app.profiling.question_bank import topic_by_id, topics_for

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "ai-contracts"
    / "src"
    / "__fixtures__"
    / "interview-gate.json"
)


def _golden() -> dict:
    assert _FIXTURE.exists(), (
        f"golden interview-gate fixture missing at {_FIXTURE} — the TypeScript suite "
        "asserts against this same file, so losing it silently removes the only guard "
        "that the two copies of the gate still agree"
    )
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


def _bank_ids() -> list[str]:
    return [t.id for t in topics_for("cnc_vmc")]


# --- 1. the two gates, membership AND order ---------------------------------


def test_essential_topics_match_the_golden_gate():
    """ORDERED equality, not a set comparison.

    ``_unanswered_essentials`` returns ``[t for t in ESSENTIAL_TOPICS if ...]``, so
    this tuple's order IS the order of the ``unanswered_essentials`` list that
    crosses the wire to the client (CHAT-UE-1). The mock recomputes the same list
    from its own copy; if the two orders diverge, a session that falls back to the
    mock mid-interview reorders a client-visible field for no reason.
    """
    assert list(ESSENTIAL_TOPICS) == _golden()["essential_topics"]


def test_must_ask_topics_match_the_golden_gate():
    """THE assertion this file was written for.

    Membership and order together: ``MUST_ASK_TOPICS`` is iterated by
    ``_extraction_ready``, by ``cli/trace.py`` (which renders it in order as an
    operator-facing readiness strip) and by the mock's ``mustAskSatisfied``. Order
    is not load-bearing for the gate itself — every id must be satisfied — but it
    is the cheapest available signal that the two lists were edited together
    rather than one being appended to.
    """
    assert list(MUST_ASK_TOPICS) == _golden()["must_ask_topics"]


def test_bank_topic_ids_match_the_golden_gate_in_ask_order():
    """The ids cross the wire in ``asked_question_ids`` / ``answered_topics`` and a
    session can switch between this engine and the mock MID-INTERVIEW (that is the
    whole point of the mock: the AI service being unreachable must not end the
    conversation). So the ids are not either side's to vary, and the ORDER is the
    ask sequence the mock's ``MOCK_TOPICS.find`` and this engine's ``_next_topic``
    both walk. The mock pinned these ids as a literal; nothing compared them here.
    """
    assert _bank_ids() == _golden()["topic_ids"]


# --- 2. the invariants the two lists have to satisfy together ---------------


def test_every_gated_id_is_a_bank_topic_on_both_sides():
    """A gated id with no bank topic could never be SERVED by ``_next_topic``, so
    readiness would stay False until the ask ceiling tripped — a silent stall.
    ``test_424_every_must_ask_id_exists_verbatim_in_the_question_bank`` pins that
    for this engine against THIS bank; here the same claim is stated over the
    fixture, so an id added to the shared contract that only one bank can serve is
    caught on whichever side is missing it.
    """
    golden = _golden()
    bank = set(golden["topic_ids"])
    for topic_id in golden["essential_topics"] + golden["must_ask_topics"]:
        assert topic_id in bank, f"gated id {topic_id!r} is not in the shared bank order"
        assert topic_by_id("cnc_vmc", topic_id) is not None, (
            f"gated id {topic_id!r} is in the shared contract but not in this bank"
        )


def test_the_two_gates_stay_disjoint():
    """The #424 ruling's protective half, stated over the FIXTURE so it binds both
    languages. An ESSENTIAL must be ANSWERED; a MUST_ASK need only be ASKED. Moving
    an id from must-ask to essential would force a worker to disclose their salary
    before they could get a profile, and — for education/certifications, which the
    local detector genuinely cannot parse — would ship a false
    ``unanswered_essentials`` for a worker who answered perfectly well.
    """
    golden = _golden()
    overlap = set(golden["essential_topics"]) & set(golden["must_ask_topics"])
    assert overlap == set(), (
        f"{sorted(overlap)} is both essential and must-ask — an essential must be "
        "ANSWERED, so this silently makes the answer compulsory (interview_engine.py:44-73)"
    )


def test_the_gate_fixture_pins_ids_only_and_never_question_copy():
    """The mock's phrasing is deliberately WARMER than this engine's (mock-interview.ts
    documents that at length: mock mode replies with its ``question`` verbatim, while
    the engine's is neutral-mentor per persona rule G4). Pinning copy here would
    collapse a distinction both files argue for.

    Chips are the opposite case and are pinned byte-identical in ``answer-chips.json``,
    because a tapped chip becomes the worker's answer of record. Keeping the two
    fixtures honest about which is which is what stops someone 'completing' this one
    with the questions.
    """
    golden = _golden()
    for key, ids in golden.items():
        if key.startswith("_"):  # narrative keys carry the WHY and may say anything
            continue
        for value in ids:
            assert "?" not in value, f"{key}: {value!r} is question copy, not a topic id"
            assert value == value.lower().strip(), f"{key}: {value!r} is not a bare topic id"
            assert " " not in value, f"{key}: {value!r} is not a bare topic id"
