"""What may and may not survive into a payer's persisted draft — and into a published posting.

WHY THIS FILE EXISTS. `safe_draft_text` is the last thing between text a payer typed into a free
-form description and a job posting other people read. It had no test of its own. The gate it
depends on, `_IDENTITY_TOKEN_RE`, listed PHONE / PERSON / EMPLOYER / ID and **not EMAIL** — an
omission rather than a decision, since every other class is argued for or against by name in the
comment above it.

That gap was invisible for a reason worth recording: masking a leading city used to mint a
`[PERSON_n]` token incidentally, which armed the gate and masked the email standing beside it. The
R6 city carve-out removed that accident, and the ai-engineer review of it found what the accident
had been hiding. It was never a real mitigation — a message that did not begin `Word,` already
drafted the address raw.

THE GATE IS TESTED FOR WHAT IT PERMITS, not only for what it catches. A gate that masked
everything would pass every "does it block X" test and would be deleted the first time it blanked
a payer's own pay figure — which is exactly the value the posting exists to carry.
"""

from __future__ import annotations

import pytest

from app.job_posting_chat.answers import carries_identity, safe_draft_text
from app.pseudonymize import pseudonymize

RAW_EMAIL = "Resume bhejo hr.ramesh@tatasteel.co.in pe"


def _through_gateway(text: str) -> str:
    """The real path: gateway, then the draft-safety decision on its own output."""
    result = pseudonymize(text)
    return safe_draft_text(text, result.text, result.placeholder_tokens)


# ---------------------------------------------------------------------------
# What the gate must CATCH
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("token", "why"),
    [
        ("[EMAIL_1]", "a direct contact channel that routes around the unlock"),
        ("[PHONE_1]", "the class this gate was built for"),
        ("[PERSON_1]", "a named individual in a posting other people read"),
        ("[EMPLOYER_1]", "the hiring company, masked by owner ruling"),
        ("[ID_1]", "a credential or registration number"),
    ],
)
def test_every_identity_class_arms_the_gate(token: str, why: str):
    assert carries_identity([token]) is True, why


def test_an_email_typed_into_a_description_never_reaches_the_draft():
    # THE REGRESSION. Before EMAIL joined the gate this returned the RAW text, address intact,
    # for every message that did not happen to begin with a capitalised word and a comma.
    drafted = _through_gateway(RAW_EMAIL)
    assert "hr.ramesh@tatasteel.co.in" not in drafted
    assert "[EMAIL_1]" in drafted


def test_the_leading_city_carve_out_no_longer_hides_the_email_gap():
    # The exact pair the ai-engineer review measured. Both must mask the address now; before the
    # fix the first one masked it by ACCIDENT (via [PERSON_1]) and the second not at all.
    with_city = _through_gateway("Faridabad, resume bhejo hr.ramesh@tatasteel.co.in pe")
    without_city = _through_gateway(RAW_EMAIL)
    for drafted in (with_city, without_city):
        assert "hr.ramesh@tatasteel.co.in" not in drafted
    # And the city itself still survives — the carve-out is not undone by arming the gate.
    assert "Faridabad" in with_city


# ---------------------------------------------------------------------------
# What the gate must PERMIT — the half that makes it usable
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("token", ["[CITY_1]", "[STATE_1]", "[AMOUNT_1]"])
def test_a_posting_s_own_subject_matter_does_NOT_arm_the_gate(token: str):
    # A job's city and its pay are the whole point of the posting. Masking them would make the
    # draft useless, and a guard nobody can live with is a guard that gets deleted.
    assert carries_identity([token]) is False


def test_ordinary_business_copy_is_stored_exactly_as_the_payer_typed_it():
    raw = "CNC turner chahiye Manesar plant ke liye, rotational shift, PF aur ESI ke saath"
    assert _through_gateway(raw) == raw


def test_a_dashed_PAY_RANGE_now_reaches_the_draft_when_the_turn_is_about_pay():
    """#1731 — this used to be pinned as OBSERVED, UNFIXED behaviour.

    R30's narrowing (PR #392, owner-accepted) masks 9–13 digits joined by any separator run, which
    is what a phone split across a dash looks like — and also what ``18000-22000`` looks like. The
    gateway still mints ``[PHONE_1]`` for it (asserted below: the phone net is NOT narrowed). What
    changed is only the job chat's own draft: when the gateway's only identity finding was a round,
    ascending rupee range and the turn is about pay, the draft keeps the payer's figure.
    """
    text = "CNC turner chahiye, 18000-22000 salary"
    assert pseudonymize(text).text == "CNC turner chahiye, [PHONE_1] salary"  # gateway unchanged
    assert _through_gateway(text) == text
    # The single-figure form was never affected.
    single = "CNC turner chahiye, 20000 salary"
    assert _through_gateway(single) == single


def _pay_answer(text: str) -> str:
    """The draft text for ``text`` given as the answer to the PAY question."""
    result = pseudonymize(text)
    return safe_draft_text(text, result.text, result.placeholder_tokens, pay_question=True)


@pytest.mark.parametrize(
    "text",
    [
        "20000-25000",
        "20000 - 25000",
        "20,000-25,000",
        "Rs 20,000 - 25,000",
        "₹15000–18000",
        "15000-18000 per month",
        "8000-12000",
        "12500-15500",
        "1,20,000-1,50,000",
        "60000-70000",
        "18000-22000 in hand",
        "25000-30000 CTC",
    ],
)
def test_a_pay_range_answer_keeps_the_payer_s_figure(text: str):
    assert "[PHONE_" in pseudonymize(text).text  # the gateway still calls it a phone
    assert _pay_answer(text) == text


@pytest.mark.parametrize(
    "text",
    [
        "98765-43210",  # a real mobile: descending halves
        "98765 43210",  # the canonical phone split — a space is not a range
        "20000 25000",  # ascending and round, but a space is still not a range dash
        "9876543210",
        "+91 98765 43210",
        "12345-23456",  # not round
        "10000-90000",  # ratio 9: not a pay band
        "salary 20000-25000, call 9876543210",  # a real phone beside the range
        "Ramesh, 20000-25000",  # another identity class in the same turn
        "20000-25000 hr.ramesh@tatasteel.co.in",  # an email in the same turn
    ],
)
def test_the_pay_exception_never_keeps_a_real_phone_or_other_identity(text: str):
    drafted = _pay_answer(text)
    assert drafted == pseudonymize(text).text  # the masked text, exactly as before #1731
    assert "[" in drafted


@pytest.mark.parametrize("text", ["20000-25000", "call 98000-99000", "office 20000-25000 wala"])
def test_without_a_pay_context_a_phone_shaped_range_stays_masked(text: str):
    # Not the pay question and no money word: a dashed number in a description is a number.
    assert _through_gateway(text) == pseudonymize(text).text


def test_is_money_range_is_exact():
    from app.job_posting_chat.answers import is_money_range

    assert is_money_range("20000-25000")
    assert is_money_range("20,000 – 25,000")
    assert is_money_range("1,20,000-1,50,000")
    assert not is_money_range("25000-20000")  # descending
    assert not is_money_range("20000-20000")  # not a range
    assert not is_money_range("98765-43210")
    assert not is_money_range("20050-25000")  # not round to 100
    assert not is_money_range("500-1000")  # below the pay floor
    assert not is_money_range("20000 25000")  # a space is not a range dash


def test_the_route_records_a_dashed_pay_range_on_the_pay_question():
    """End to end through /job-posting-chat/respond: the pay band lands on the draft, and a real
    phone typed the same way does not — neither as text nor as numbers."""
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    state = {
        "answered_topics": ["role_title", "location_label", "city", "vacancy", "skills"],
        "asked_question_ids": ["role_title", "location_label", "vacancy", "skills", "pay_range"],
        "ask_counts": {
            "role_title": 1,
            "location_label": 1,
            "vacancy": 1,
            "skills": 1,
            "pay_range": 1,
        },
        "turn_count": 5,
    }

    def respond(message: str) -> dict:
        res = client.post(
            "/job-posting-chat/respond",
            json={"session_id": "s1", "message_text": message, "conversation_state": state},
        )
        assert res.status_code == 200
        return res.json()

    body = respond("20000-25000")
    assert (body["draft"]["pay_min"], body["draft"]["pay_max"]) == (20000, 25000)

    body = respond("18000-22000 in hand")
    assert (body["draft"]["pay_min"], body["draft"]["pay_max"]) == (18000, 22000)
    assert body["draft"]["pay_type"] == "in_hand"

    body = respond("98765-43210")
    assert body["draft"]["pay_min"] is None and body["draft"]["pay_max"] is None
    assert "98765" not in str(body) and "43210" not in str(body)


def test_no_tokens_at_all_means_raw():
    assert carries_identity([]) is False
    assert carries_identity(None) is False
    assert safe_draft_text("raw", "masked", []) == "raw"


def test_the_gate_matches_a_WHOLE_token_and_not_a_substring():
    # `^...$` anchoring, asserted rather than assumed: a payer writing about "[PHONE_1] support"
    # in prose must not be able to arm or evade the gate through a partial match.
    assert carries_identity(["prefix[PHONE_1]"]) is False
    assert carries_identity(["[PHONE_1]suffix"]) is False
    assert carries_identity(["[PHONE_]"]) is False
