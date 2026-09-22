"""Gate 6 for the resume-import route - what may reach the DATABASE."""

from __future__ import annotations

# ---------------------------------------------------------------------------
# #1658 - a pseudonymization placeholder must never be stored as a fact
#
# With RESUME_PARSE_RAW_TEXT_ENABLED off (the default on every box unless the owner
# armed it), `default_masker` runs over each line before the model sees it. On a real
# CNC-turner CV that produced line 33 as:
#
#     '[EMPLOYER_1] & [EMPLOYER_2]., Jaipur, Rajasthan'
#
# That string carries no hard identifier, so it passed gate 6. It is a literal substring
# of the line, so it passed gate 1. It is exactly what the prompt asks for. So an
# employment row whose employer was the literal text "[EMPLOYER_1] & [EMPLOYER_2]." was
# staged, offered to the worker, and could reach `employer_name_enc` and the resume sheet.
#
# NOT A PRIVACY FAILURE - the wall held, nothing leaked. It is the WALL'S OUTPUT being
# recorded as something the worker asserted.
# ---------------------------------------------------------------------------
from app.resume_import.parse_policy import contains_mask_placeholder, resume_value_certifier


def test_the_measured_failing_employer_is_refused():
    blocked, certified = resume_value_certifier("[EMPLOYER_1] & [EMPLOYER_2].")
    assert blocked is True
    # NEVER REWRITTEN. Gate 6 returns the text unchanged and rejects on the flag; a
    # rewrite would record that the worker's resume said something it did not.
    assert certified == "[EMPLOYER_1] & [EMPLOYER_2]."


def test_a_partly_masked_value_is_refused_too():
    # The damaging value is only PARTLY a placeholder. An employer name half-replaced by
    # tokens is no more a fact about the worker than one wholly replaced, which is why
    # the check is a search and not a fullmatch.
    assert contains_mask_placeholder("[EMPLOYER_1] Components, Faridabad, Haryana") is True
    assert contains_mask_placeholder("[PERSON_1], Micrometer & Bore Gauge") is True


def test_every_minted_prefix_is_covered_by_shape():
    # Matched by SHAPE, not by a list of known prefixes, so a prefix added to the masker
    # tomorrow is covered the day it ships. These five are what `pseudonymize` mints today.
    for prefix in ("PERSON", "EMPLOYER", "PHONE", "EMAIL", "AMOUNT"):
        assert contains_mask_placeholder(f"[{prefix}_1]") is True
    # ...and a prefix that does not exist yet is covered by the same rule.
    assert contains_mask_placeholder("[SOMETHINGNEW_2]") is True


def test_honest_resume_values_still_pass():
    # VACUITY GUARD. A refusal that blocked everything would satisfy every assertion
    # above while destroying the feature. These are real values from the same CV.
    for value in (
        "Apex Auto Components",
        "CNC Turner",
        "ITI - Turner Trade",
        "Vernier, Micrometer & Bore Gauge",
        "Precision Engineering & Auto Components Pvt. Ltd.",
    ):
        blocked, _ = resume_value_certifier(value)
        assert blocked is False, value


def test_bracketed_text_that_is_not_a_placeholder_passes():
    # The shape is `[UPPER_digits]`. Ordinary bracketed prose must not trip it.
    assert contains_mask_placeholder("Bracket [not] a token") is False
    assert contains_mask_placeholder("Shift [A]") is False
    assert contains_mask_placeholder("lot [batch_2]") is False


def test_the_certifier_still_takes_no_policy_argument():
    # THE DISCIPLINE THAT MAKES GATE 6 UNSWITCHABLE. `apply_parse_gates` wants a
    # (text) -> (blocked, certified) certifier, the same shape as a Masker - so a
    # `certify=` parameter here would make it a one-character edit to hand gate 6 the
    # INPUT policy and turn the raw-text flag into a silent PII leak. #1658 added a second
    # refusal to this function and must not have added such a parameter along the way.
    import inspect

    for fn in (resume_value_certifier, contains_mask_placeholder):
        params = list(inspect.signature(fn).parameters)
        assert params == ["text"], f"{fn.__name__} gained a parameter: {params}"
