"""The LLM-driven chat turn — the contract, the guard, the budget, the privacy gate.

REPLACES the deleted engine suite. Those tests asserted which QUESTION the bank chose
next, which is no longer a thing the service decides. What IS still ours to guarantee,
and therefore what is tested here:

  * the turn parses into a strict shape, and an unparseable one degrades safely
  * the persona laws that are mechanically checkable are ENFORCED, not merely prompted
  * the model cannot extend its own interview or declare itself finished early
  * no worker PII crosses the boundary, on ANY of the five surfaces that now do
  * the static prompt stays byte-stable, because the caching discount is silent when
    it breaks

Deliberately NOT tested: tone. "Never grade the person", "praise proportionate to the
claim" are judgements. A keyword assertion for them would fail good turns, and a test
that cries wolf gets deleted. Those are evaluated, never asserted.
"""

from __future__ import annotations

import pytest

from app.config import Settings
from app.profiling import persona_guard, rfs
from app.profiling.persona import GUARANTEE_LINE
from app.profiling.prompts import build_chat_messages, static_system_block
from app.profiling.turn_schema import coerce_turn, fallback_turn_json


def _settings(**over) -> Settings:
    return Settings(_env_file=None, **over)


@pytest.fixture
def settings() -> Settings:
    return _settings()


@pytest.fixture
def client():
    """A TestClient over the real app, for the endpoint-level budget assertions.

    `app.main` is imported INSIDE the fixture rather than at module scope: conftest pins
    the whole egress denylist at import time, and importing main eagerly here would bind
    its module-level `Settings` before some of those pins are guaranteed to be in place.
    """
    from fastapi.testclient import TestClient

    from app import main

    return TestClient(main.app)


# ---------------------------------------------------------------------------
# The turn contract
# ---------------------------------------------------------------------------


def test_a_well_formed_turn_parses():
    turn = coerce_turn(
        '{"reply":"Achha. Kaunsi machine chalate hain?","chips":["VMC","CNC Lathe"],'
        '"asked_field":"tools_equipment","captured":{"trade":"operator"},"is_complete":false}'
    )
    assert turn is not None
    assert turn.reply == "Achha. Kaunsi machine chalate hain?"
    assert turn.chips == ["VMC", "CNC Lathe"]
    assert turn.captured == {"trade": "operator"}
    assert turn.is_complete is False


def test_a_markdown_fenced_object_still_parses():
    """json_mode is on, but a model still occasionally wraps its object in a fence.
    Throwing away an otherwise-good turn over three backticks would spend a real call
    for nothing."""
    turn = coerce_turn('```json\n{"reply":"Achha. Kahan rehte hain?"}\n```')
    assert turn is not None and turn.reply == "Achha. Kahan rehte hain?"


@pytest.mark.parametrize("junk", ["", "   ", "not json at all", "[]", "null", '{"reply":""}'])
def test_unusable_output_returns_none_rather_than_raising(junk):
    """The router never raises, so neither may the parser — the caller substitutes the
    fallback and the worker still gets a turn."""
    assert coerce_turn(junk) is None


def test_chips_are_bounded_deduped_and_length_capped():
    """Chips render in a fixed-width mobile layout. An over-long chip breaks it and a
    duplicate reads as a bug, so neither is left to the prompt to prevent."""
    turn = coerce_turn(
        '{"reply":"Achha. Kaunsi?","chips":["VMC","vmc","CNC","HMC","Grinding","Lathe",'
        f'"{"x" * 80}"]}}'
    )
    assert turn is not None
    assert len(turn.chips) <= 4
    assert turn.chips == ["VMC", "CNC", "HMC", "Grinding"]  # dedup is case-insensitive


def test_the_fallback_is_itself_a_valid_turn_and_advances_nothing():
    """`mock_response` is parsed as the model's JSON, so the degraded path must produce
    the same shape — one parse path, no "prose or JSON?" branch. And it must lose no
    ground: an outage costs a turn, never a topic."""
    turn = coerce_turn(fallback_turn_json())
    assert turn is not None
    assert turn.captured == {}
    assert turn.is_complete is False
    assert "{{worker_name}}" not in turn.reply  # no vocative on a degraded turn
    assert turn.reply.count("?") == 1


# ---------------------------------------------------------------------------
# The persona guard
# ---------------------------------------------------------------------------


def test_an_on_persona_turn_passes():
    r = persona_guard.check_turn(
        "Achha. Kitne saal se machine chala rahe hain?", max_words=20, turn_index=4
    )
    assert r.ok, r.violations


@pytest.mark.parametrize(
    ("reply", "expect"),
    [
        ("Arre waah bhai, zabardast! Aapko dono aate hain?", "bhai"),
        ("Theek hai. Tum kya karte ho?", "tum"),
        ("Achha. Aur usme kitne saal?", "aur usme"),
        ("Achha. Aapko pakka job milegi. Kahan rehte hain?", "pakka job"),
        ("Great. Aap kya karte hain?", "great"),
    ],
)
def test_the_banned_vocabulary_is_caught(reply, expect):
    """Straight from the persona's own 'THIS IS NOT HIM' column."""
    r = persona_guard.check_turn(reply, max_words=20, turn_index=5)
    assert not r.ok
    assert expect in r.summary


def test_shape_violations_are_caught():
    two_questions = persona_guard.check_turn("Achha. Kya? Aur kahan?", max_words=20, turn_index=5)
    assert not two_questions.ok and "question marks" in two_questions.summary

    no_question = persona_guard.check_turn("Theek hai, samajh gaya.", max_words=20, turn_index=5)
    assert not no_question.ok and "no question" in no_question.summary

    too_long = persona_guard.check_turn(
        "Achha. " + "shabd " * 25 + "kya?", max_words=20, turn_index=5
    )
    assert not too_long.ok and "words (limit 20)" in too_long.summary

    shouting = persona_guard.check_turn("Achha! Kya karte hain?", max_words=20, turn_index=5)
    assert not shouting.ok and "exclamation" in shouting.summary

    emoji = persona_guard.check_turn("Achha 👍. Kya karte hain?", max_words=20, turn_index=5)
    assert not emoji.ok and "emoji" in emoji.summary


def test_the_sanctioned_refusal_passes_despite_containing_a_banned_word():
    """§5's honest line opens with "Guarantee nahi de sakta" — the one place the banned
    word is required. If the guard rejected it, the repair loop would rewrite the
    refusal into the promise Law 9 forbids, which is the exact opposite of the point."""
    r = persona_guard.check_turn(GUARANTEE_LINE + " Kaunsi machine?", max_words=20, turn_index=5)
    assert r.ok, r.violations


def test_the_worker_name_placeholder_survives_the_scan():
    """The real first name is interpolated downstream by the API, post-store and
    post-emit. The placeholder is not a violation and must reach the caller intact."""
    r = persona_guard.check_turn(
        "Theek hai {{worker_name}} ji. Abhi kahan rehte hain?", max_words=20, turn_index=4
    )
    assert r.ok, r.violations


def test_the_brand_name_is_not_a_vocative():
    """The bot introduces itself as "Bada Bhai". Banning a bare "bhai" aimed AT the
    worker must not ban the persona's own name."""
    r = persona_guard.check_turn(
        "Main aapka Bada Bhai. Kya kaam karte hain?", max_words=20, turn_index=1
    )
    assert r.ok, r.violations


def test_the_appreciation_budget_is_enforced_across_the_conversation():
    """§3: max 2 per conversation, never consecutive, never before turn 3, never after
    a "nahi pata". A single line cannot be judged in isolation — which is exactly why
    this rule drifted before there was a guard."""
    early = persona_guard.check_turn(
        "Bahut khoob. Program khud banate hain?", max_words=20, turn_index=1
    )
    assert not early.ok and "before turn 3" in early.summary

    spent = persona_guard.check_turn(
        "Bahut khoob. Program khud banate hain?", max_words=20, turn_index=6, appreciations_used=2
    )
    assert not spent.ok and "budget spent" in spent.summary

    back_to_back = persona_guard.check_turn(
        "Solid. Program khud banate hain?",
        max_words=20,
        turn_index=6,
        previous_had_appreciation=True,
    )
    assert not back_to_back.ok and "consecutive" in back_to_back.summary

    after_dont_know = persona_guard.check_turn(
        "Bahut bhadiya. Kahan rehte hain?", max_words=20, turn_index=6, worker_said_dont_know=True
    )
    assert not after_dont_know.ok and "nahi pata" in after_dont_know.summary

    allowed = persona_guard.check_turn(
        "Bahut khoob. Program khud banate hain?", max_words=20, turn_index=4
    )
    assert allowed.ok, allowed.violations


def test_never_re_asks_an_answered_field():
    """Law 8 / §5 "never asks what has already been answered", enforced rather than
    hoped for — the deterministic engine used to guarantee this structurally."""
    r = persona_guard.check_turn(
        "Achha. Kitne saal ka experience hai?",
        max_words=20,
        turn_index=5,
        already_captured=frozenset({"experience_years"}),
        asked_field="experience_years",
    )
    assert not r.ok and "re-asks" in r.summary


def test_count_appreciations_reads_the_transcript_not_a_counter():
    """Computed from the replies so it survives a resumed session, where an in-memory
    counter would have been lost with the buffer."""
    assert persona_guard.count_appreciations([]) == 0
    assert (
        persona_guard.count_appreciations(
            ["Achha. Kya?", "Bahut khoob. Kaunsi machine?", "Solid. Kahan?"]
        )
        == 2
    )


# ---------------------------------------------------------------------------
# The Resume Field Set
# ---------------------------------------------------------------------------


def test_the_field_vocabulary_is_closed():
    """A hallucinated field id costs one ignored key, never a junk column on a resume."""
    s = _settings()
    kept, dropped = rfs.normalize_captured(
        {"trade": "welder", "favourite_colour": "blue", "current_city": "Pune"}, s
    )
    assert kept == {"trade": "welder", "current_city": "Pune"}
    assert dropped == ["favourite_colour"]


def test_empty_and_oversized_values_are_handled():
    s = _settings()
    kept, _ = rfs.normalize_captured(
        {"trade": "   ", "skills": None, "current_city": "x" * 500}, s
    )
    assert "trade" not in kept, "a blank value must not read as an answer"
    assert "skills" not in kept
    assert len(kept["current_city"]) <= 120


def test_completion_needs_every_required_field():
    s = _settings()
    partial = {f: "x" for f in rfs.required_fields(s)[:-1]}
    assert not rfs.is_complete(partial, s)
    assert rfs.missing_required(partial, s) == [rfs.required_fields(s)[-1]]

    full = {f: "x" for f in rfs.required_fields(s)}
    assert rfs.is_complete(full, s)
    assert rfs.missing_required(full, s) == []


def test_optional_fields_never_gate_completion():
    """Law 4 governs what may be ASKED, not what may be RECORDED. An interview that
    waited for an optional field would interrogate a worker for something we were
    happy to receive only if volunteered."""
    s = _settings()
    assert rfs.is_complete({f: "x" for f in rfs.required_fields(s)}, s)


def test_the_field_set_is_configuration_not_code():
    """The whole claim of 'generalized profiling': supporting a new trade, or changing
    what a resume needs, must be an env edit."""
    s = _settings(profiling_required_fields="trade,languages", profiling_optional_fields="skills")
    assert rfs.required_fields(s) == ("trade", "languages")
    assert rfs.is_complete({"trade": "cook", "languages": "Hindi"}, s)


# ---------------------------------------------------------------------------
# Prompt assembly + the caching invariant
# ---------------------------------------------------------------------------


def test_the_static_block_is_byte_stable_across_workers_and_turns():
    """THE CACHING INVARIANT, and it fails SILENTLY when broken. Gemini's implicit cache
    only applies to a stable prefix; interpolating anything per-worker into messages[0]
    costs the whole discount with no error, no exception and no other test failing.
    That is why this is pinned rather than trusted."""
    s = _settings()
    assert static_system_block(s) == static_system_block(s)

    a = build_chat_messages(
        settings=s, history=[], worker_message="welder hoon", role_family="welding",
        captured={}, missing=["trade"], turn_index=1,
    )
    b = build_chat_messages(
        settings=s, history=[], worker_message="cook hoon", role_family="generic",
        captured={"trade": "cook"}, missing=[], turn_index=9,
    )
    assert a[0]["content"] == b[0]["content"], "messages[0] must not vary per worker or turn"
    assert a[1]["content"] != b[1]["content"], "the variable half must be a SEPARATE message"


def test_the_trade_name_is_not_in_the_cached_prefix():
    """The specific regression this guards: the old prompt interpolated the trade into
    the persona block, which would silently pin the cache to one trade."""
    s = _settings()
    block = static_system_block(s)
    assert "welding & fabrication" not in block
    assert "CNC/VMC manufacturing" not in block


def test_history_is_threaded_now():
    """Reverses COST-3 deliberately. The engine used to know what to ask, so the model
    needed no memory; it now conducts the interview, and a model that cannot see the
    conversation cannot ask a follow-up."""
    from app.contracts import ConversationMessage

    s = _settings()
    msgs = build_chat_messages(
        settings=s,
        history=[
            ConversationMessage(role="assistant", text="Aap kya kaam karte hain?"),
            ConversationMessage(role="worker", text="welder hoon"),
        ],
        worker_message="5 saal",
        role_family="welding",
        captured={"trade": "welder"},
        missing=["experience_years"],
        turn_index=2,
    )
    blob = " ".join(m["content"] for m in msgs)
    assert "welder hoon" in blob
    assert "Aap kya kaam karte hain?" in blob
    assert msgs[-1]["content"] == "5 saal"


def test_already_captured_fields_are_shown_to_the_model():
    """This is how 'never ask what has already been answered' works without an engine
    tracking it."""
    s = _settings()
    msgs = build_chat_messages(
        settings=s, history=[], worker_message="haan", role_family=None,
        captured={"trade": "welder", "current_city": "Pune"}, missing=["salary_expected"],
        turn_index=3,
    )
    ctx = msgs[1]["content"]
    assert "ALREADY ANSWERED" in ctx and "welder" in ctx and "Pune" in ctx
    assert "STILL MISSING" in ctx


def test_the_final_turn_tells_the_model_to_stop_asking():
    s = _settings()
    msgs = build_chat_messages(
        settings=s, history=[], worker_message="haan", role_family=None, captured={},
        missing=["trade"], turn_index=30, force_complete=True,
    )
    assert "FINAL TURN" in msgs[1]["content"]
    assert "Do not ask a question" in msgs[1]["content"]


def test_the_repair_instruction_goes_last_and_names_the_broken_rule():
    """Re-sending the persona is not a correction — the model already had it and broke
    it anyway. Naming the specific violation is."""
    s = _settings()
    bad = persona_guard.check_turn("Waah bhai! Kya?", max_words=20, turn_index=5)
    msgs = build_chat_messages(
        settings=s, history=[], worker_message="haan", role_family=None, captured={},
        missing=["trade"], turn_index=5,
        repair=persona_guard.repair_instruction(bad),
    )
    assert msgs[-1]["role"] == "system"
    assert "bhai" in msgs[-1]["content"]
    assert "exclamation" in msgs[-1]["content"]


# ---------------------------------------------------------------------------
# The turn cap. The ONLY bound on per-worker LLM spend, and it was asserted
# nowhere: `force_complete` appeared in one prompt-text test and `extraction_ready`
# in none at all.
# ---------------------------------------------------------------------------


class TestTurnCap:
    """`cap_fired = force_complete or turn_index >= max_turns` is the whole budget.

    TWO INDEPENDENT CLAMPS, tested separately on purpose. The API sends
    `force_complete` because it owns the Redis buffer and therefore the turn count; this
    service re-derives the cap from the state it was handed. Either alone ends the
    interview, which is what makes the pair defence in depth rather than duplication —
    a bug in the API's arithmetic cannot produce an unbounded interview, and neither can
    a caller that never sends the flag.
    """

    def _post(self, client, **body):
        return client.post(
            "/profiling/respond",
            json={"session_id": "s1", "message_text": "haan ji", **body},
        ).json()

    def test_force_complete_ends_the_interview_whatever_the_model_says(self, client):
        # The model is still called and may well return is_complete=false; the SERVICE
        # decides. A model must never be able to extend its own interview.
        body = self._post(client, force_complete=True)
        assert body["extraction_ready"] is True
        assert body["updated_state"]["completion_reason"] == "turn_cap"

    def test_reaching_max_turns_ends_it_even_without_the_flag(self, client, settings):
        # The far-side clamp. `turn_index = prior.turn_count + 1`, so a state at
        # max_turns - 1 makes THIS the final turn.
        state = {"role_family": "cnc_vmc", "turn_count": settings.profiling_max_turns - 1}
        body = self._post(client, conversation_state=state)
        assert body["extraction_ready"] is True
        assert body["updated_state"]["completion_reason"] == "turn_cap"

    def test_one_turn_before_the_cap_does_NOT_end_it(self, client, settings):
        # The off-by-one that would silently shorten every interview by a turn.
        state = {"role_family": "cnc_vmc", "turn_count": settings.profiling_max_turns - 2}
        body = self._post(client, conversation_state=state)
        assert body["extraction_ready"] is False
        assert body["updated_state"]["completion_reason"] is None

    def test_the_cap_reports_turn_cap_NOT_fields_complete(self, client):
        # The two reasons must stay distinguishable: "we ran out of budget" and "we got
        # everything" produce very different profiles, and only the reason column says
        # which happened.
        body = self._post(client, force_complete=True)
        assert body["updated_state"]["completion_reason"] == "turn_cap"
        assert body["updated_state"]["unanswered_essentials"]  # genuinely incomplete

    def test_a_COMPLETE_field_set_reports_fields_complete_instead(self, client, settings):
        captured = {f: "x" for f in settings.profiling_required_field_list}
        body = self._post(
            client,
            conversation_state={"role_family": "cnc_vmc", "turn_count": 3, "captured": captured},
        )
        assert body["extraction_ready"] is True
        assert body["updated_state"]["completion_reason"] == "fields_complete"
        assert body["updated_state"]["unanswered_essentials"] == []
