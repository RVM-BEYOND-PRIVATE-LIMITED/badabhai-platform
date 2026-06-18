"""Corpus de-identification — sentinel-PII + residual scan + exclude-on-doubt
(ADR-0018 §D2 build-blockers)."""

from __future__ import annotations

import pytest

from app.corpus.deidentify import deidentify_for_corpus

# Cue-shaped PII the v1 detector provably catches (sample-profile contract).
_SENTINEL = "my name is Ramesh Kumar, I worked at Sharma Engineering Works, call 9876543210"


def test_sentinel_pii_never_survives_into_clean_text():
    r = deidentify_for_corpus(_SENTINEL, profile="sample")
    assert r.admitted is True
    assert r.clean_text is not None
    for raw in ("Ramesh", "Kumar", "Sharma Engineering", "9876543210"):
        assert raw not in r.clean_text


def test_email_missed_by_pseudonymizer_is_excluded_by_residual_scan():
    # pseudonymize.py has no email rule; the independent corpus scan must catch it.
    r = deidentify_for_corpus("reach me at ramesh@gmail.com", profile="sample")
    assert r.admitted is False
    assert r.clean_text is None


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
