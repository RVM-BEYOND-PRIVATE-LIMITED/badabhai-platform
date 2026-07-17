"""Tests for the pseudonymization gateway. Stdlib-only — no FastAPI/pydantic."""

from app.pseudonymize import pseudonymize


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


def test_d1_zero_led_seven_digit_run_still_blocks():
    # "0999999" would parse in-range as int but a zero-led run is a
    # reference/account shape, not money -> genuinely ambiguous -> fail closed.
    result = pseudonymize("0999999")
    assert result.blocked is True


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


def test_d1_no_long_digit_run_ever_survives_unmasked():
    """THE fail-closed invariant behind the D-1 carve-out (register row D-1).

    For ANY 7-10 digit run in any context, the gateway either BLOCKS (so nothing
    is sent to an LLM at all) or MASKS the run out of the returned text. There is
    no third outcome in which raw digits egress. Deterministic seed => stable CI.
    """
    import random
    import re

    rng = random.Random(7)
    for _ in range(4000):
        length = rng.randint(7, 10)
        run = "".join(rng.choice("0123456789") for _ in range(length))
        for template in ("%s", "salary %s hai", "call me %s", "ref %s please"):
            text = template % run
            result = pseudonymize(text)
            if result.blocked:
                continue  # fail-closed: the LLM is never called
            assert run not in result.text, f"digits egressed: {text!r} -> {result.text!r}"
            # And nothing 7+ digits long is left behind anywhere in the output.
            assert not re.search(r"\d{7,}", result.text), result.text


def test_empty_string_is_not_blocked():
    result = pseudonymize("")
    assert result.blocked is False
    assert result.text == ""
    assert result.replaced_entities == 0


def test_greeting_is_not_masked_as_person():
    result = pseudonymize("Hello, I run a VMC machine")
    assert "[PERSON_1]" not in result.text
    assert "Hello" in result.text
