"""`TokenScope` — one request's placeholder numbering across several `pseudonymize` calls.

THE CONTRACT UNDER TEST, in order of importance:

1. OTHER CALLERS ARE UNTOUCHED. `pseudonymize(text)` (no scope) and `pseudonymize(text,
   scope=TokenScope())` give byte-identical results on every shape the gateway handles —
   identity classes, money, the fail-closed blocks.
2. A SHARED SCOPE CORRELATES, IT DOES NOT MERGE: the same original gets the same token in
   every call of the request; two different originals never share one.
3. THE SCOPE HOLDS NO ORIGINAL TEXT and cannot be serialized, copied or read back — the
   original<->token mapping is still never persisted or returned.
4. Fail-closed is unchanged under a shared scope.

Stdlib-only, like `test_pseudonymize.py`. All inputs are fabricated.
"""

from __future__ import annotations

import copy
import pickle

import pytest

from app.pseudonymize import TokenScope, pseudonymize

#: One line per masking rule and per fail-closed path — the equivalence corpus for rule 1.
_CORPUS = [
    "Rahul, phone 9876543210, worked at ABC Industries in Faridabad",
    "mera naam Suresh Kumar hai, Tata Motors Ltd aur Bajaj Auto Ltd mein kaam kiya",
    "email ramesh.kumar@example.co.in, PAN ABCDE1234F, aadhaar 1234 5678 9012",
    "roll number R/2019/123456 aur registration MH2019CN4471",
    "salary 1200000 chahiye, number 98765.43210 hai",
    "Tata Motors Ltd, Tata Motors Ltd, TATA MOTORS LTD",
    "reference number 12345678",  # residual digits -> blocked
    "x" * 20_001,  # oversize -> blocked
    "Welding, grinding",  # the trade-vocabulary carve-out
    # #1738 F1: the two-view path (an invisible present) — masked, and the concealment block.
    "​Ramesh, Tata Motors Ltd mein welder",
    "Mera​naam Ramesh",
    "",
]


@pytest.mark.parametrize("text", _CORPUS)
def test_a_fresh_scope_is_byte_identical_to_the_default(text: str) -> None:
    assert pseudonymize(text, scope=TokenScope()) == pseudonymize(text)


def test_a_shared_scope_gives_one_token_per_original_across_calls() -> None:
    scope = TokenScope()
    message = pseudonymize("Bajaj Auto Ltd ko hatao", scope=scope)
    e1 = pseudonymize("Tata Motors Ltd", scope=scope)
    e2 = pseudonymize("Bajaj Auto Ltd", scope=scope)
    e3 = pseudonymize("Tata Motors", scope=scope)

    assert message.text == "[EMPLOYER_1] ko hatao"
    # The message's employer is e2's, and only e2's.
    assert e2.text == "[EMPLOYER_1]"
    assert {e1.text, e3.text}.isdisjoint({"[EMPLOYER_1]"})
    # Three different originals, three different tokens.
    assert len({e1.text, e2.text, e3.text}) == 3


def test_equality_is_the_old_normalised_rule() -> None:
    # Case never splits one entity (strip().lower(), as before).
    scope = TokenScope()
    first = pseudonymize("Tata Motors Ltd", scope=scope)
    second = pseudonymize("TATA Motors Ltd ki jagah", scope=scope)
    assert first.text == "[EMPLOYER_1]"
    assert second.text == "[EMPLOYER_1] ki jagah"


def test_per_call_accounting_describes_the_call_not_the_scope() -> None:
    scope = TokenScope()
    pseudonymize("Tata Motors Ltd aur Bajaj Auto Ltd", scope=scope)
    reused = pseudonymize("Bajaj Auto Ltd", scope=scope)
    # The reused token is reported for THIS text, and the count is this text's entities.
    assert reused.placeholder_tokens == ["[EMPLOYER_2]"]
    assert reused.replaced_entities == 1


def test_the_prefixes_number_independently_in_a_shared_scope() -> None:
    scope = TokenScope()
    pseudonymize("Tata Motors Ltd", scope=scope)
    phone = pseudonymize("number 9876543210", scope=scope)
    assert phone.text == "number [PHONE_1]"


def test_fail_closed_is_unchanged_under_a_shared_scope() -> None:
    scope = TokenScope()
    pseudonymize("Tata Motors Ltd", scope=scope)
    blocked = pseudonymize("reference number 12345678", scope=scope)
    assert blocked.blocked is True
    oversize = pseudonymize("y" * 20_001, scope=scope)
    assert oversize.blocked is True
    assert oversize.text == ""
    not_text = pseudonymize(None, scope=scope)  # type: ignore[arg-type]
    assert not_text.blocked is True


def test_the_scope_holds_no_original_text() -> None:
    scope = TokenScope()
    originals = ["Tata Motors Ltd", "Bajaj Auto Ltd", "9876543210", "ramesh@example.com"]
    for original in originals:
        pseudonymize(original, scope=scope)

    # Every slot of the object, rendered: no original (in either case) appears anywhere.
    dumped = repr(scope) + "".join(repr(getattr(scope, slot)) for slot in TokenScope.__slots__)
    for original in originals:
        assert original not in dumped
        assert original.lower() not in dumped
    assert "Tata" not in repr(scope)


def test_the_same_original_digests_differently_in_two_scopes() -> None:
    # A per-scope random key: nothing held by one request correlates with another's.
    first, second = TokenScope(), TokenScope()
    pseudonymize("Tata Motors Ltd", scope=first)
    pseudonymize("Tata Motors Ltd", scope=second)
    assert set(first._tokens) != set(second._tokens)


@pytest.mark.parametrize(
    "clone",
    [pickle.dumps, copy.copy, copy.deepcopy],
    ids=["pickle", "copy", "deepcopy"],
)
def test_a_scope_cannot_be_serialized_or_copied(clone) -> None:
    scope = TokenScope()
    pseudonymize("Tata Motors Ltd", scope=scope)
    with pytest.raises(TypeError, match="request-scoped"):
        clone(scope)


def test_the_spaced_detector_pass_never_spends_the_shared_numbering() -> None:
    """#1738 F1 masks a SPACED view too when an invisible is present — a detector that never
    egresses. Only the READER pass may use the caller's scope. Here the invisible re-segments the
    name, so the two passes see DIFFERENT originals ("TataMotors Ltd" vs "Tata Motors Ltd"); had
    the detector shared the scope, its own mint would have pushed the next employer to
    [EMPLOYER_3]."""
    scope = TokenScope()
    first = pseudonymize("Tata​Motors Ltd mein kaam", scope=scope)
    assert first.blocked is False
    assert first.text == "[EMPLOYER_1] mein kaam"
    assert pseudonymize("Bajaj Auto Ltd", scope=scope).text == "[EMPLOYER_2]"
