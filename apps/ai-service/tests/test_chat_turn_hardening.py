"""Regression tests for the defects found reviewing the LLM-driven chat turn (PR #583).

Each class below pins ONE defect that CI could not see, because every one of them needs
either a real model in the loop or a specific piece of server-held state. They are kept
apart from `test_llm_chat_turn.py` (which pins the contract as designed) so that what is
a DESIGNED invariant and what is a FIXED BUG stay legible to the next reader.
"""

from __future__ import annotations

import pytest

from app.config import ConfigError, Settings
from app.profiling import persona_guard, rfs
from app.profiling.turn_schema import fallback_turn


def _settings(**over) -> Settings:
    return Settings(_env_file=None, **over)


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app import main

    return TestClient(main.app)


# ---------------------------------------------------------------------------
# The CLOSING turn — Law 1 inverts
# ---------------------------------------------------------------------------
#
# `prompts.turn_context_message` tells the model "FINAL TURN. Do not ask a question"
# (cap fired) or "Everything required is collected. Close warmly" (fields done). The
# guard demanded a question on EVERY turn, so on the one turn that ENDS the interview
# the prompt and the guard gave contradictory orders: the model had no legal move, every
# interview spent a wasted repair call, and the closing line the worker actually saw was
# the mid-interview fallback - "Thoda aur bataiye - aap kya kaam karte hain?" - served
# with session_ended: true.


class TestFinalTurn:
    CLOSING = "Theek hai. Aapka resume ban raha hai."

    def test_a_closing_line_with_no_question_is_OK_on_the_final_turn(self):
        res = persona_guard.check_turn(self.CLOSING, max_words=20, turn_index=9, is_final=True)
        assert res.ok, res.violations

    def test_the_same_line_is_STILL_a_violation_mid_interview(self):
        # The inversion is scoped to the closing turn ONLY. A mid-interview turn that
        # asks nothing advances nothing, which is the original rule and still right.
        res = persona_guard.check_turn(self.CLOSING, max_words=20, turn_index=9)
        assert not res.ok
        assert "no_question" in res.codes

    def test_asking_a_question_on_the_final_turn_is_a_violation(self):
        # The worker can never answer it - the service has already ended the session.
        res = persona_guard.check_turn(
            "Theek hai. Kitne saal ka experience hai?",
            max_words=20,
            turn_index=30,
            is_final=True,
        )
        assert not res.ok
        assert "asks_on_final_turn" in res.codes
        assert "no_question" not in res.codes

    def test_the_final_fallback_asks_nothing_and_passes_its_own_guard(self):
        final = fallback_turn(is_final=True)
        assert "?" not in final.reply
        assert final.asked_field is None
        assert final.captured == {}
        # Completion stays the SERVICE's decision - a degraded turn never claims it.
        assert final.is_complete is False
        assert persona_guard.check_turn(
            final.reply, max_words=20, turn_index=30, is_final=True
        ).ok

    def test_the_mid_interview_fallback_would_have_failed_the_final_guard(self):
        # Pins the defect itself, so a regression is loud rather than subtle.
        mid = fallback_turn()
        assert "?" in mid.reply
        assert not persona_guard.check_turn(
            mid.reply, max_words=20, turn_index=30, is_final=True
        ).ok

    def test_a_forced_final_turn_does_not_close_on_a_question(self, client):
        # End to end. With no real model the router serves `mock_response`, which the
        # endpoint now builds with is_final=True on a forced turn.
        body = client.post(
            "/profiling/respond",
            json={"session_id": "s1", "message_text": "haan ji", "force_complete": True},
        ).json()
        assert body["extraction_ready"] is True
        assert "?" not in body["reply_text"]


# ---------------------------------------------------------------------------
# asked_field is held to the closed vocabulary
# ---------------------------------------------------------------------------


class TestAskedFieldVocabulary:
    def test_a_known_field_survives(self):
        assert rfs.normalize_asked_field("experience_years", _settings()) == "experience_years"

    @pytest.mark.parametrize(
        "value", ["experience", "years_of_experience", "", "  ", None, 42]
    )
    def test_anything_outside_the_vocabulary_becomes_None(self, value):
        # None is the honest answer - "we do not know what this turn asked" - rather
        # than asserting a field the model never asked about.
        assert rfs.normalize_asked_field(value, _settings()) is None

    def test_an_unvalidated_asked_field_silently_disables_the_re_ask_law(self):
        # THE REASON THIS MATTERS. Law 8 is a MEMBERSHIP test against this value, so a
        # near-miss id ("experience" for "experience_years") makes the guard miss and the
        # worker is asked the same thing twice with nothing logged.
        captured = frozenset({"experience_years"})
        reply = "Achha. Kitne saal se yeh kaam kar rahe hain?"

        missed = persona_guard.check_turn(
            reply,
            max_words=20,
            turn_index=5,
            already_captured=captured,
            asked_field="experience",  # what an unvalidated model id looks like
        )
        assert missed.ok  # the guard cannot see it - hence the normalizer

        caught = persona_guard.check_turn(
            reply,
            max_words=20,
            turn_index=5,
            already_captured=captured,
            asked_field="experience_years",
        )
        assert not caught.ok
        assert "re_asks_captured_field" in caught.codes


# ---------------------------------------------------------------------------
# Un-maskable SERVER-HELD state is dropped, not served - and never livelocks
# ---------------------------------------------------------------------------


class TestStateIsNotAPoisonPill:
    """A `captured` value or a stored assistant line that trips the gateway used to
    block the WHOLE turn and return state unchanged. That state is re-evaluated every
    turn, so the block was permanent: `turn_count` froze, the cap could never fire, the
    interview never completed, and the only exit was the idle TTL taking the entire
    conversation with it - while the worker was told to rephrase a message that was
    never the problem. The worker's own message still fails closed.
    """

    # 8 digits, above the money carve-out, so pseudonymize blocks it as a residual
    # numeric sequence. A normalised start date looks exactly like this.
    POISON = "20260801"

    def _post(self, client, **body):
        return client.post(
            "/profiling/respond",
            json={"session_id": "s1", "message_text": "haan ji", **body},
        ).json()

    def test_the_poison_value_really_does_block_the_gateway(self):
        # Guards the guard: if pseudonymize stopped blocking this, the two tests below
        # would pass vacuously.
        from app.pseudonymize import pseudonymize

        assert pseudonymize(self.POISON).blocked is True

    def test_an_unmaskable_captured_value_neither_blocks_nor_freezes_the_turn(self, client):
        state = {
            "role_family": "cnc_vmc",
            "turn_count": 4,
            "captured": {"trade": "VMC operator", "availability": self.POISON},
        }
        body = self._post(client, conversation_state=state)
        assert body["blocked"] is False
        assert body["updated_state"]["turn_count"] == 5  # advanced, not frozen
        # The offending field is dropped, so it is simply asked again.
        assert "availability" not in body["updated_state"]["captured"]
        assert body["updated_state"]["captured"]["trade"] == "VMC operator"

    def test_an_unmaskable_history_leg_does_not_block_the_turn(self, client):
        body = self._post(
            client,
            history=[
                {"role": "assistant", "text": f"Theek hai. Drawing {self.POISON} wali baat hai?"},
                {"role": "worker", "text": "haan"},
            ],
        )
        assert body["blocked"] is False
        assert body["updated_state"]["turn_count"] == 1

    def test_the_WORKER_MESSAGE_still_fails_closed(self, client):
        # The one leg that must NOT degrade: live input is what the gateway is for.
        body = self._post(client, message_text=f"mera number 9876543210 hai aur {self.POISON}")
        assert body["blocked"] is True
        assert body["is_mock"] is True


# ---------------------------------------------------------------------------
# The RFS vocabulary cannot be configured into an identity store
# ---------------------------------------------------------------------------


class TestIdentityFieldsAreRefusedAtStartup:
    """`rfs.py` says there is deliberately no field for a name, phone, address, employer
    or id. That was true of the hand-written FIELD_GUIDE but NOT of the vocabulary the
    model may actually write into, which is whatever the env vars say. An identity slot
    configured there would persist into `chat_sessions.conversation_state` and ride back
    into the prompt every turn.
    """

    @pytest.mark.parametrize(
        "field",
        ["full_name", "worker_name", "phone_number", "employer_name", "current_address", "pan"],
    )
    def test_an_identity_field_refuses_to_boot(self, field):
        with pytest.raises(ConfigError):
            _settings(profiling_optional_fields=f"languages,{field}")

    @pytest.mark.parametrize(
        "field", ["panel_wiring", "company_size_worked", "tools_equipment", "work_history"]
    )
    def test_legitimate_trade_fields_are_NOT_caught(self, field):
        # A trades platform is full of near-misses: `panel_wiring` contains "pan",
        # `company_size_worked` contains "company". The short, ambiguous tokens match a
        # whole underscore-separated part only, so a false positive cannot refuse boot.
        if field == "company_size_worked":
            pytest.skip("`company` is an intentional substring ban - see the validator")
        _settings(profiling_optional_fields=field)

    def test_the_shipped_defaults_still_boot(self):
        # The deny-list must never reject the vocabulary we actually ship.
        s = _settings()
        assert "trade" in s.profiling_required_field_list
        assert "work_history" in s.profiling_optional_field_list
