"""Tests for the pseudonymization gateway. Stdlib-only — no FastAPI/pydantic."""

import re

import pytest

from app.pseudonymize import _MONEY_MIN_INR, pseudonymize


def test_example_from_spec_is_fully_masked():
    text = "Rahul, phone 9876543210, worked at ABC Industries in Faridabad"
    result = pseudonymize(text)
    assert result.blocked is False
    assert result.text == "[PERSON_1], phone [PHONE_1], worked at [EMPLOYER_1] in [CITY_1]"
    assert result.replaced_entities == 4
    # The raw values must be gone.
    for leaked in ("Rahul", "9876543210", "ABC Industries", "Faridabad"):
        assert leaked not in result.text


def test_only_placeholder_labels_are_returned_not_raw_values():
    result = pseudonymize("Rahul, phone 9876543210")
    # placeholder_tokens are labels only — they must not contain raw data.
    for tok in result.placeholder_tokens:
        assert tok.startswith("[") and tok.endswith("]")
    assert "9876543210" not in "".join(result.placeholder_tokens)


def test_phone_number_is_replaced():
    result = pseudonymize("call me on +91 98765 43210 anytime")
    assert "98765" not in result.text
    assert "[PHONE_1]" in result.text
    assert result.blocked is False


def test_pan_id_is_replaced():
    result = pseudonymize("PAN ABCDE1234F for records")
    assert "[ID_1]" in result.text
    assert "ABCDE1234F" not in result.text
    assert result.blocked is False


def test_repeated_entity_reuses_same_token():
    result = pseudonymize("9876543210 and again 9876543210")
    assert result.text.count("[PHONE_1]") == 2
    assert result.replaced_entities == 1


def test_fails_closed_on_oversize_input():
    result = pseudonymize("a" * 50, max_length=10)
    assert result.blocked is True
    assert "exceeds" in (result.blocked_reason or "")
    assert result.text == ""


def test_fails_closed_on_residual_numeric_sequence():
    # An 8-digit run OUTSIDE the plausible-salary range (12,345,678 > 10,000,000)
    # is not phone-like enough to mask but is potential PII -> block.
    result = pseudonymize("reference number 12345678 please")
    assert result.blocked is True
    assert "residual" in (result.blocked_reason or "")


# --- D-1 money-amount carve-out ---------------------------------------------
# docs/registers/context-drift-2026-07-16.md row D-1 (owner ruling 2026-07-17):
# "salary 1000000 blocks the conversation" — the residual-digit net blocked any
# 7+ digit run while signals.py accepts salaries to 10,000,000. The carve-out
# MASKS an in-range 7-8 digit run to [AMOUNT_n] (digits still never reach an
# LLM) instead of blocking the turn; everything ambiguous still fails closed.


def test_d1_in_range_salary_is_amount_masked_not_blocked():
    """Register row D-1: a worker typing their salary must not be blocked."""
    result = pseudonymize("1000000")
    assert result.blocked is False
    assert result.text == "[AMOUNT_1]"
    assert "1000000" not in result.text  # digits never reach the LLM


def test_d1_salary_sentence_passes_through_and_reaches_signals():
    """Register row D-1: the turn proceeds AND the raw text (read locally, never
    sent) still yields the salary via signals — the two layers now agree."""
    from app.profiling import signals

    text = "10 lakh salary 1200000"
    result = pseudonymize(text)
    assert result.blocked is False
    assert "1200000" not in result.text
    assert "[AMOUNT_1]" in result.text
    sig = signals.detect(text)
    assert sig.current_salary == 1_000_000  # "10 lakh" — signals sees the raw text


def test_d1_ten_digit_phone_still_masked_never_amount():
    # (a) of the ruling: a 10-digit run is a phone shape — ALWAYS masked as
    # [PHONE_n] before the money step; never re-labelled as money.
    result = pseudonymize("9876543210")
    assert result.blocked is False
    assert result.text == "[PHONE_1]"
    assert "AMOUNT" not in result.text
    assert "9876543210" not in result.text


def test_d1_nine_digit_run_still_masked_as_phone():
    result = pseudonymize("call me 987654321")
    assert "987654321" not in result.text
    assert "[PHONE_1]" in result.text
    assert "AMOUNT" not in result.text


def test_d1_upper_boundary_ten_million_is_masked_amount():
    # 10,000,000 is signals' salary ceiling (inclusive) -> masked, not blocked.
    result = pseudonymize("10000000")
    assert result.blocked is False
    assert result.text == "[AMOUNT_1]"


def test_d1_eight_digit_run_above_salary_ceiling_still_blocks():
    # 10,000,001 parses over signals' ceiling -> NOT money -> fail closed.
    result = pseudonymize("10000001")
    assert result.blocked is True
    assert "residual" in (result.blocked_reason or "")


def test_d1_out_of_range_eight_digit_run_still_blocks():
    result = pseudonymize("99999999 hai mera")
    assert result.blocked is True


@pytest.mark.parametrize("text", ["01000000", "09999999", "01500000"])
def test_d1_zero_led_run_that_parses_in_range_still_blocks(text):
    """The zero-led guard, tested where it actually BITES (PR #392 S-2 mutation
    finding). These 8-digit runs parse to 1,000,000 / 9,999,999 / 1,500,000 —
    squarely inside the money range — so ONLY the leading-zero rule stops them
    becoming [AMOUNT_n]. A zero-led run is a reference/account shape, not money
    (no one writes a salary as "01500000") -> ambiguous -> fail closed.

    NB: a 7-digit "0999999" parses to 999,999, BELOW the range, so it would block
    with or without the guard — it cannot detect the guard's removal.
    """
    assert int(text) >= _MONEY_MIN_INR  # precondition: the guard is what bites
    result = pseudonymize(text)
    assert result.blocked is True
    assert "AMOUNT" not in result.text


def test_d1_zero_led_below_range_also_blocks():
    # Blocks via the range check rather than the guard — kept for completeness.
    assert pseudonymize("0999999").blocked is True


def test_d1_six_digit_run_untouched_as_before():
    result = pseudonymize("salary 999999")
    assert result.blocked is False
    assert "999999" in result.text  # below the residual net, unchanged behavior


def test_d1_two_amounts_get_distinct_tokens():
    result = pseudonymize("abhi 1500000 hai, 2000000 chahiye")
    assert result.blocked is False
    assert "[AMOUNT_1]" in result.text and "[AMOUNT_2]" in result.text
    assert "1500000" not in result.text and "2000000" not in result.text


def test_d1_amount_next_to_phone_masks_both_correctly():
    result = pseudonymize("9876543210 pe call karo, salary 1500000 hai")
    assert result.blocked is False
    assert "[PHONE_1]" in result.text and "[AMOUNT_1]" in result.text
    assert "9876543210" not in result.text and "1500000" not in result.text


def test_d1_indian_landline_shapes_still_block():
    # 8-digit landlines start 2-9 -> parse above the 10,000,000 ceiling -> not
    # money -> fail closed. (Only "10000000" itself is in range, and it reads as
    # a salary.) Guards the carve-out against the nearest real phone shape.
    for landline in ("22334455", "20123456", "44112233", "80123456", "19999999"):
        assert pseudonymize(landline).blocked is True, landline


def test_d1_seven_digit_phone_fragment_is_masked_not_leaked():
    # A 7-digit run could be a phone FRAGMENT and does fall in the money range, so
    # it is labelled [AMOUNT_n] rather than blocked. The label is imprecise; the
    # SAFETY property is not: the digits are still masked out of the text and can
    # never reach an LLM. (Over-masking is the locked safe direction.)
    result = pseudonymize("my no 9876543")
    assert "9876543" not in result.text
    assert result.text == "my no [AMOUNT_1]"


# --- S-1: separator-split phone numbers (PR #392 security review) ------------
# The old char-count phone rule accepted ONLY space/dash as separators, so a phone
# split on any other char matched neither it NOR the residual net (which needs 7+
# CONSECUTIVE digits) and egressed raw. The hole PRE-DATES D-1 and was only ever
# covered incidentally (the residual net blocked the turn when some other 7-8 digit
# run co-occurred) — D-1 removes exactly that cover in the salary case. Detection
# is now DIGIT-COUNT based (9-13 digits joined by at most one separator each).

_SPLIT_PHONES = [
    "9876.543.210",
    "9876,543,210",
    "(98765)43210",
    "98765_43210",
    "98765-43210",
    "98765 43210",
]


@pytest.mark.parametrize("text", _SPLIT_PHONES)
def test_s1_separator_split_phone_never_egresses(text):
    """PR #392 S-1: each separator form must be masked, never returned raw."""
    result = pseudonymize(text)
    assert result.blocked is False
    assert "[PHONE_1]" in result.text
    # No digit of the original survives anywhere in the returned text.
    assert not re.search(r"\d", re.sub(r"\[[A-Z]+_\d+\]", "", result.text)), result.text


def test_s1_salary_and_split_phone_together_masks_both():
    """PR #392 S-1, THE regression: this is the case that proves the D-1 carve-out
    did not open a hole. Pre-fix on this branch the amount masked to [AMOUNT_1],
    which removed the residual net's incidental block, and the full 10-digit phone
    egressed. Both must now mask."""
    result = pseudonymize("meri salary 1500000 hai, mera number 98765.43210 hai")
    assert result.blocked is False
    assert "[AMOUNT_1]" in result.text and "[PHONE_1]" in result.text
    assert "98765.43210" not in result.text
    assert "9876543210" not in result.text
    assert "1500000" not in result.text
    assert not re.search(r"\d", re.sub(r"\[[A-Z]+_\d+\]", "", result.text)), result.text


@pytest.mark.parametrize(
    "text",
    [
        "1000000",  # in-range salary -> AMOUNT, never PHONE
        "999999",  # below every net
        "normal text 2024, 15 items",
        "1,500,000",  # Indian thousands separator: 7 digits, NOT a phone
        "15,00,000",  # Indian lakh grouping: 7 digits
        "salary 15,00,000, 2,50,000 expected",  # ", " splits -> two amounts
        "12.05.2024",  # date: 8 digits
        "10.5 lakh",
        "version 1.2.3",
    ],
)
def test_s1_digit_count_detection_has_no_phone_false_positives(text):
    """Digit-COUNT (not char-count) is what makes widening the separator set safe:
    a comma-grouped salary is 7 digits and can never become a [PHONE_n]."""
    assert "[PHONE_1]" not in pseudonymize(text).text


def test_s1_fourteen_digit_run_falls_to_the_residual_net():
    # Too long to be a phone -> matches no mask -> residual net blocks (fail closed).
    result = pseudonymize("12345678901234")
    assert result.blocked is True


# --- S-2: lock the ARCHITECTURAL invariants the property test cannot see ------
# PR #392 S-2: mutation testing showed dropping the lookarounds, widening the money
# run, or reordering money-before-phone all SURVIVED the suite. These pin the two
# properties the D-1 design argument actually rests on.


@pytest.mark.parametrize("length", [9, 10, 11, 12, 13])
def test_s2_a_long_run_can_never_be_labelled_money(length):
    """ORDER + lookaround lock: a 9-13 digit run is identity-shaped and must be
    MASKED — never labelled money. If money ever ran BEFORE phone, or the
    (?<!\\d)/(?!\\d) guards were dropped so a 7-8 digit sub-run could be carved out
    of a longer one, an [AMOUNT_n] would appear here.

    The token is [PHONE_n] except at length 12, where the Aadhaar rule legitimately
    claims it first ([ID_n]) — both are correct maskings, so this asserts the
    invariant that matters (masked, not money, no digits left) rather than pinning
    which identity token wins.
    """
    run = "9" * length
    result = pseudonymize(run)
    assert "AMOUNT" not in result.text, f"{run!r} -> {result.text!r}"
    assert result.blocked is False
    assert re.fullmatch(r"\[(?:PHONE|ID)_1\]", result.text), result.text


def test_s2_money_regex_cannot_match_inside_a_longer_run():
    """The lookarounds are load-bearing, asserted directly on the pattern: no 9+
    digit run may yield a money candidate at all."""
    from app.pseudonymize import _MONEY_RUN_RE

    for length in range(9, 15):
        assert _MONEY_RUN_RE.findall("1" * length) == [], length
    # ...while a bare in-range 7-digit run still matches (the carve-out works).
    assert _MONEY_RUN_RE.findall("1000000") == ["1000000"]


@pytest.mark.parametrize("phone", ["1234567.890", "12345678.90", "9876543.210"])
def test_s2_phone_masking_runs_before_money_masking(phone):
    """ORDER lock (PR #392 S-2), tested where the order actually BITES.

    On a CONSECUTIVE run the lookarounds alone prevent money from biting, so
    running money first would be harmless and undetectable. A SEPARATOR-SPLIT
    phone is different: it exposes a 7-8 digit CONSECUTIVE sub-run ("1234567" in
    "1234567.890"). If money ran first it would tokenise that sub-run to
    [AMOUNT_n] and leave the REST of the phone ("890") raw — a partial mask AND a
    mislabel. Phone-first consumes the whole number.
    """
    from app.pseudonymize import _MONEY_RUN_RE

    # Precondition: this input really does expose a money-shaped sub-run.
    assert _MONEY_RUN_RE.findall(phone), phone

    result = pseudonymize(f"mera number {phone} hai")
    assert "[PHONE_1]" in result.text
    assert "AMOUNT" not in result.text, f"money ran first: {result.text!r}"
    assert not re.search(r"\d", re.sub(r"\[[A-Z]+_\d+\]", "", result.text)), result.text


_PROPERTY_TEMPLATES = (
    "%s",
    "salary %s hai",
    "call me %s",
    "ref %s please",
    "meri salary 1500000 hai, mera number %s hai",  # the S-1 co-occurrence shape
)
_PROPERTY_SEPARATORS = (".", ",", "-", "_", " ", ")")


def _split_once(digits: list[str], sep: str, cut: int) -> str:
    return "".join(digits[:cut]) + sep + "".join(digits[cut:])


def test_property_phone_shaped_runs_never_egress_bare_or_split():
    """THE security property behind D-1 + S-1 (register D-1; PR #392 S-1).

    For every PHONE-SHAPED run (9-13 digits) — bare, separator-split on any of the
    separators the gateway accepts, and co-occurring with a salary — the gateway
    either BLOCKS (nothing is sent to an LLM) or MASKS the run out of the returned
    text. No third outcome egresses digits. Deterministic seed => stable CI.

    Scope, stated honestly (PR #392 S-3): randomised over a FIXED template set —
    not a proof over all inputs. The exact case count is asserted below so it can
    never be overstated again. The split + co-occurrence templates exist precisely
    because the original single-run version could not see S-1.
    """
    import random

    rng = random.Random(7)
    cases = 0
    for _ in range(2000):
        length = rng.randint(9, 13)  # phone-shaped
        digits = [rng.choice("0123456789") for _ in range(length)]
        sep = rng.choice(_PROPERTY_SEPARATORS)
        cut = rng.randint(1, length - 1)
        for run in ("".join(digits), _split_once(digits, sep, cut)):
            bare = "".join(ch for ch in run if ch.isdigit())
            for template in _PROPERTY_TEMPLATES:
                text = template % run
                result = pseudonymize(text)
                cases += 1
                if result.blocked:
                    continue  # fail-closed: the LLM is never called
                assert bare not in result.text, f"egressed: {text!r} -> {result.text!r}"
                assert run not in result.text, f"egressed: {text!r} -> {result.text!r}"
                assert not re.search(r"\d{7,}", result.text), result.text
    # Lock the ACTUAL case count so the PR body cites it truthfully (S-3).
    assert cases == 2000 * 2 * len(_PROPERTY_TEMPLATES) == 20_000


def test_property_consecutive_seven_to_eight_digit_runs_never_egress():
    """The D-1 half: a CONSECUTIVE 7-8 digit run either masks to [AMOUNT_n] (in
    range) or blocks (out of range / zero-led). Never egresses either way."""
    import random

    rng = random.Random(11)
    cases = 0
    for _ in range(2000):
        length = rng.randint(7, 8)
        run = "".join(rng.choice("0123456789") for _ in range(length))
        for template in _PROPERTY_TEMPLATES:
            text = template % run
            result = pseudonymize(text)
            cases += 1
            if result.blocked:
                continue
            assert run not in result.text, f"egressed: {text!r} -> {result.text!r}"
            assert not re.search(r"\d{7,}", result.text), result.text
    assert cases == 2000 * len(_PROPERTY_TEMPLATES) == 10_000


def test_documented_boundary_split_short_runs_are_not_phone_shaped():
    """HONEST NEGATIVE (documents a real, pre-existing limit — see the risks
    register row for S-1). A 7-8 digit run SPLIT by a separator ("1_661318",
    "12.05.2024") is not phone-shaped (< 9 digits) and has no 7 CONSECUTIVE
    digits, so it matches no net and passes through — exactly as it does on main.

    This is deliberate, not an oversight: extending the residual net to
    separator-split short runs would BLOCK every date a worker types
    ("12.05.2024 ko join kiya") and comma-grouped salaries ("15,00,000") — the
    over-blocking class D-1 exists to eliminate. Recorded so the boundary is a
    decision on the record rather than an accident. If this test ever starts
    failing, the gateway got STRICTER — re-check the date/salary UX before
    accepting it.
    """
    for text in ("1_661318", "12.05.2024", "15,00,000"):
        result = pseudonymize(text)
        assert result.blocked is False
        assert result.text == text  # untouched: not phone-shaped, not consecutive
    # ...but the same digits CONSECUTIVE are caught (masked or blocked).
    assert pseudonymize("1661318").text == "[AMOUNT_1]"
    assert pseudonymize("12052024").blocked is True


def test_empty_string_is_not_blocked():
    result = pseudonymize("")
    assert result.blocked is False
    assert result.text == ""
    assert result.replaced_entities == 0


def test_greeting_is_not_masked_as_person():
    result = pseudonymize("Hello, I run a VMC machine")
    assert "[PERSON_1]" not in result.text
    assert "Hello" in result.text
