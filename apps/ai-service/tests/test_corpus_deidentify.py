"""Corpus de-identification — sentinel-PII + residual scan + exclude-on-doubt
(ADR-0018 §D2 build-blockers)."""

from __future__ import annotations

import pytest

from app.corpus.deidentify import _has_residual_pii, deidentify_for_corpus

# Cue-shaped PII the v1 detector provably catches (sample-profile contract).
_SENTINEL = "my name is Ramesh Kumar, I worked at Sharma Engineering Works, call 9876543210"


def test_sentinel_pii_never_survives_into_clean_text():
    r = deidentify_for_corpus(_SENTINEL, profile="sample")
    assert r.admitted is True
    assert r.clean_text is not None
    for raw in ("Ramesh", "Kumar", "Sharma Engineering", "9876543210"):
        assert raw not in r.clean_text


def test_an_email_is_now_masked_by_layer_one_and_the_record_is_admitted_clean():
    """THIS TEST INVERTED, and the inversion is the fix landing.

    It used to read "pseudonymize.py has no email rule; the independent corpus scan
    must catch it" and assert `admitted is False`. That was an honest pin on a real
    gap: layer 1 was blind to emails, so the only thing standing between a worker's
    address and the corpus was layer 2 — which protected the corpus by throwing the
    ENTIRE transcript away.

    `pseudonymize` now masks emails (see `_EMAIL_RE`), so the record is de-identified
    rather than discarded: the address is gone AND the surrounding trade content
    survives. That is strictly better for a corpus whose whole purpose is to retain
    domain language, and it is the same direction as the FIX-5 / city rulings —
    stop destroying real content to remove something we can simply mask.

    Layer 2 is unchanged and still armed; the test below pins it separately.
    """
    r = deidentify_for_corpus("reach me at ramesh@gmail.com", profile="sample")
    assert r.admitted is True
    assert r.clean_text == "reach me at [EMAIL_1]"
    assert "ramesh@gmail.com" not in r.clean_text
    assert "@" not in r.clean_text


def test_the_independent_residual_scan_still_catches_an_email_on_its_own():
    """DEFENSE IN DEPTH, pinned at the layer itself rather than through layer 1.

    The property ADR-0018 §D2 actually requires is that the corpus scan is an
    INDEPENDENT second check — it must catch an email even if the pseudonymizer
    misses one. Asserting that end-to-end is no longer possible (layer 1 now masks
    every address layer 2 recognises), and contriving an input that slips past layer 1
    just to keep an integration assertion alive would pin an accident, not a contract.
    So this asserts the scanner directly.
    """
    assert _has_residual_pii("reach me at ramesh@gmail.com") is True
    assert _has_residual_pii("ref 12345678") is True
    assert _has_residual_pii("I run a CNC lathe and do VMC setting") is False


def test_blocked_paths_return_no_text_and_no_pii_in_reason():
    r = deidentify_for_corpus("", profile="sample")
    assert r.admitted is False and r.clean_text is None
    # The reason string must never carry source text.
    assert "ramesh" not in r.reason.lower()


def test_real_ner_profile_is_blocked_until_signed_off():
    with pytest.raises(NotImplementedError):
        deidentify_for_corpus(_SENTINEL, profile="ner")


def test_clean_domain_text_is_admitted():
    r = deidentify_for_corpus("I run a CNC lathe and do VMC setting for 5 years", profile="sample")
    assert r.admitted is True
    assert r.clean_text is not None
