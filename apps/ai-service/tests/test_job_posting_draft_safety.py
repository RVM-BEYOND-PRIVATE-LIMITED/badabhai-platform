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


def test_a_PAY_RANGE_typed_with_a_dash_is_read_as_a_PHONE_and_blanks_the_payer_s_figure():
    """OBSERVED BEHAVIOUR, PRE-EXISTING, and recorded rather than asserted as correct.

    R30's narrowing (PR #392) masks 9–13 digits joined by any separator run, which is what a
    phone split across a dash looks like — and also what ``18000-22000`` looks like. Ten digits,
    one separator. The gateway mints ``[PHONE_1]``, that arms this gate, and the payer's own pay
    range disappears from their own draft.

    IT IS PINNED HERE BECAUSE IT IS INVISIBLE OTHERWISE. Nothing errors, nothing logs, and the
    payer sees a token where their number was with a clarification question asking them to retype
    the field they just typed. The comment above ``_IDENTITY_TOKEN_RE`` argues CITY / STATE /
    AMOUNT out of the gate precisely so a pay figure survives — and a dashed RANGE defeats that
    reasoning by never being classified as an amount in the first place.

    NOT FIXED HERE. Narrowing R30's separator rule to spare a pay range is a change to the phone
    net on the one risk the owner has accepted in writing, and it belongs to the pseudonymisation
    owner rather than to a job-posting test. Found while adding the EMAIL class (R6).
    """
    drafted = _through_gateway("CNC turner chahiye, 18000-22000 salary")
    assert "18000-22000" not in drafted
    assert "[PHONE_1]" in drafted
    # The single-figure form is unaffected, which is what makes this a RANGE problem.
    single = "CNC turner chahiye, 20000 salary"
    assert _through_gateway(single) == single


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
