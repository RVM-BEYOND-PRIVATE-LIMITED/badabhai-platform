"""#1984 (R59): the G1 hard-identifier floor and the clean-or-withhold certifier fail closed on a
Unicode control character (category Cc: C0, DEL, C1).

No rule in `pseudonymize.py` sees through a control character, so one inside an identifier split
it past both walls. Measured on main before this change (all values fabricated):

    value                        certified_clean_skill_labels   contains_hard_identifier
    "call 9876\\x00543210"        kept                           None
    "anil\\x00@example.com"       kept                           None
    "W\\x01elding, Anil Kumar"    kept                           None
    "W\\x85elding, Anil Kumar"    kept                           None

Both walls now WITHHOLD such a value; nothing is normalised. The floor reads tab, LF and CR as a
space (free text legitimately carries them, and every pattern already treats a space as a
separator); the certifier refuses even those, since a label or scalar is one line. Cf (ZWJ / ZWNJ)
is untouched — Devanagari conjuncts use it — and pinned below. Every caller named in the issue is
exercised through its own entry point. Reads no flag, so nothing here is parametrised on
`AI_RAW_PII_ENABLED`.
"""

from __future__ import annotations

import json
import sys
import unicodedata

import pytest

import app.pseudonymize as pseudonymize_module
from app.certified_values import certified_items, certified_scalar
from app.companion import edit_parse
from app.output_floor import carries_hard_identifier, floored_items, floored_scalar
from app.profiling.profile_extractor import clamp_skill_labels, sanitize_skill_labels
from app.pseudonymize import (
    _CONTROL_CHAR_RE,
    _NON_LAYOUT_CONTROL_CHAR_RE,
    CONTROL_CHARACTER_REFUSAL,
    HARD_IDENTIFIER_CLASSES,
    certified_clean_skill_labels,
    certify_value,
    contains_hard_identifier,
    has_control_character,
    is_certified_clean,
)
from app.resume_import.parse_policy import resume_value_certifier

#: The issue's table, verbatim. Fabricated values only.
_ISSUE_VALUES = (
    "call 9876\x00543210",
    "anil\x00@example.com",
    "W\x01elding, Anil Kumar",
    "W\x85elding, Anil Kumar",
)

#: One of each control family the issue names, splitting a fabricated phone number.
_FAMILY_VALUES = (
    "call 9876\x01543210",  # C0
    "call 9876\x1f543210",  # C0, top of the block
    "call 9876\x7f543210",  # DEL
    "call 9876\x80543210",  # C1, bottom of the block
    "call 9876\x85543210",  # C1, NEL (renders as a line break)
    "call 9876\x9f543210",  # C1, top of the block
)

_ALL_CONTROL = _ISSUE_VALUES + _FAMILY_VALUES

#: Clean Devanagari labels shaped with a ZWJ / ZWNJ (category Cf, NOT Cc). They must stay kept.
_DEVANAGARI_WITH_JOINERS = (
    "वेल्‍डिंग",
    "क्‍ष",
    "वेल्‌डिंग मशीन",
)


# --- the class itself -----------------------------------------------------------------------


def test_the_control_class_is_exactly_unicode_cc() -> None:
    """The regex spells Cc as explicit ranges; this pins it to `unicodedata` over all of Unicode,
    so a mistyped bound cannot leave one control character unread."""
    cc = {cp for cp in range(sys.maxunicode + 1) if unicodedata.category(chr(cp)) == "Cc"}
    matched = {cp for cp in range(0x2000) if _CONTROL_CHAR_RE.match(chr(cp))}
    assert matched == cc
    non_layout = {cp for cp in range(0x2000) if _NON_LAYOUT_CONTROL_CHAR_RE.match(chr(cp))}
    assert non_layout == cc - {0x09, 0x0A, 0x0D}


def test_the_refusal_is_not_a_hard_identifier_class() -> None:
    """The TypeScript wall pins `HARD_IDENTIFIER_CLASSES` through a shared fixture; the refusal
    is a fail-closed class of its own, like "scanner_error"."""
    assert CONTROL_CHARACTER_REFUSAL not in HARD_IDENTIFIER_CLASSES


# --- the G1 floor ---------------------------------------------------------------------------


@pytest.mark.parametrize("value", _ALL_CONTROL)
def test_the_floor_refuses_a_value_carrying_a_control_character(value: str) -> None:
    assert contains_hard_identifier(value) == CONTROL_CHARACTER_REFUSAL
    assert carries_hard_identifier(value)
    assert floored_scalar(value) is None
    assert floored_items(["VMC", value, "Fanuc"]) == ["VMC", "Fanuc"]


@pytest.mark.parametrize("sep", ["\t", "\n", "\r", "\r\n"])
def test_the_floor_reads_layout_whitespace_as_a_space(sep: str) -> None:
    """Tab / LF / CR split nothing a typed space could not: the phone, PAN and email still read,
    and an honest multi-line value is kept."""
    assert contains_hard_identifier(f"call 9876{sep}543210") == "phone"
    assert contains_hard_identifier(f"PAN{sep}ABCDE1234F") == "pan"
    assert contains_hard_identifier(f"mail{sep}anil@example.com") == "email"
    assert contains_hard_identifier(f"CNC turning{sep}VMC setting") is None
    assert floored_scalar(f"CNC turning{sep}VMC setting") == f"CNC turning{sep}VMC setting"


def test_the_floor_still_passes_a_clean_value() -> None:
    assert contains_hard_identifier("Welding, grinding") is None
    assert floored_scalar("Stainless Steel") == "Stainless Steel"


# --- the certifier --------------------------------------------------------------------------


@pytest.mark.parametrize("value", _ALL_CONTROL)
def test_the_certifier_withholds_a_value_carrying_a_control_character(value: str) -> None:
    assert has_control_character(value)
    assert certified_clean_skill_labels(["VMC Operation", value]) == ["VMC Operation"]
    assert not is_certified_clean(value)  # the polish role gate
    blocked, certified = certify_value(value)  # gate 6 of /profile/parse
    assert blocked or certified != value


@pytest.mark.parametrize("sep", ["\t", "\n", "\r"])
def test_the_certifier_withholds_layout_whitespace_too(sep: str) -> None:
    """A label is one line: even a tab or newline does not certify."""
    assert certified_clean_skill_labels([f"Welding{sep}Grinding"]) == []


def test_the_employer_rescue_cannot_keep_a_control_character() -> None:
    """The FIX-5 rescue path keeps a label the gateway masked as an employer; a control
    character drops it before that path is reached."""
    assert certified_clean_skill_labels(["Stainless Steel"]) == ["Stainless Steel"]
    assert certified_clean_skill_labels(["Stainless\x85Steel", "Stainless\x00 Steel"]) == []


def test_the_rescue_drops_a_control_character_even_if_the_vocabulary_matched(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Today the vocabulary rejects "Stainless\\x85Steel" on its own; the certifier must not
    rely on that. With a vocabulary that says yes to everything, the label still drops."""
    monkeypatch.setattr(pseudonymize_module, "_is_employer_rescue_vocabulary", lambda _label: True)
    assert pseudonymize_module.pseudonymize("Stainless\x85Steel").placeholder_tokens == [
        "[EMPLOYER_1]"
    ]
    assert certified_clean_skill_labels(["Stainless\x85Steel", "Stainless\tSteel"]) == []


@pytest.mark.parametrize("label", _DEVANAGARI_WITH_JOINERS)
def test_devanagari_shaped_with_a_joiner_stays_kept(label: str) -> None:
    """Cf is NOT Cc: a ZWJ / ZWNJ conjunct is part of the word and must survive both walls."""
    assert not has_control_character(label)
    assert certified_clean_skill_labels([label]) == [label]
    assert is_certified_clean(label)
    assert contains_hard_identifier(label) is None
    assert certified_scalar(label) == label


# --- every caller the issue names ------------------------------------------------------------


@pytest.mark.parametrize("value", _ALL_CONTROL)
def test_the_education_scalars_and_list_certifier_withhold(value: str) -> None:
    """#1739's `certified_scalar` (education level / field, the Phase C scalars) and
    `certified_items` had no control-character check of their own."""
    assert certified_scalar(value) is None
    assert certified_items(["ITI Fitter", value]) == ["ITI Fitter"]


@pytest.mark.parametrize("value", _ALL_CONTROL)
def test_the_resume_gate_6_refuses(value: str) -> None:
    blocked, certified = resume_value_certifier(value)
    assert blocked


def test_the_legacy_clamp_c1_gap_is_closed() -> None:
    """`clamp_skill_labels` strips C0 and DEL only; a C1 character survives it — and is now
    withheld by the certifier behind it rather than stored on `profile.skill_labels`."""
    labels = ["VMC Operation", "W\x85elding, Anil Kumar", "Fitter\x9f9876543210"]
    assert clamp_skill_labels(labels) == labels  # the gap the issue measured, unchanged
    assert sanitize_skill_labels(labels) == ["VMC Operation"]


@pytest.mark.parametrize("value", _ALL_CONTROL)
def test_the_companion_edit_rows_drop(value: str) -> None:
    rows = [
        {"op": "add", "section": "skills", "field": "skill", "value": value},
        {"op": "add", "section": "skills", "field": "skill", "value": "welding"},
    ]
    parsed = edit_parse.parse_edit_rows(json.dumps({"rows": rows}), max_rows=3)
    assert [row.value for row in parsed.rows] == ["welding"]
