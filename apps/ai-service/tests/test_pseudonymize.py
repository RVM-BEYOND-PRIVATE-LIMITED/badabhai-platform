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
    # An 8-digit run is not phone-like enough to mask but is potential PII.
    result = pseudonymize("reference number 12345678 please")
    assert result.blocked is True
    assert "residual" in (result.blocked_reason or "")


def test_empty_string_is_not_blocked():
    result = pseudonymize("")
    assert result.blocked is False
    assert result.text == ""
    assert result.replaced_entities == 0


def test_greeting_is_not_masked_as_person():
    result = pseudonymize("Hello, I run a VMC machine")
    assert "[PERSON_1]" not in result.text
    assert "Hello" in result.text
