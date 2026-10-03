"""Corpus de-identification — sentinel-PII + residual scan + exclude-on-doubt
(ADR-0018 §D2 build-blockers)."""

from __future__ import annotations

import itertools
import random
import re
import time

import pytest

from app.corpus.deidentify import _RESIDUAL_PATTERNS, _has_residual_pii, deidentify_for_corpus

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


# --- #1936 (the #1924 follow-up): the residual scan's email shape is linear, no verdict moved ---

#: THE PRE-#1936 residual scan, frozen as the oracle. Its email pattern is the quadratic one, so
#: it only ever sees short strings here.
_PRE_1936_RESIDUAL_PATTERNS = (
    re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b"),
    re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b"),
    re.compile(r"(?<!\d)\+?\d[\d\s\-]{6,}\d(?!\d)"),
    re.compile(r"\d{7,}"),
    re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+"),
)


def _pre_1936_has_residual_pii(text: str) -> bool:
    return any(p.search(text) for p in _PRE_1936_RESIDUAL_PATTERNS)


@pytest.mark.parametrize(
    "text",
    [
        "reach me at ramesh@gmail.com",
        "first.last+tag@mail.example.co.in",
        "x@y.z",
        "@@a@b.co",
        "a@b@c.in",
        "रमेश@उदा.भारत",  # Devanagari
        "\U0001d4b6@b.co",  # an astral letter before the @
        "l" * 300 + "@acme.in",
    ],
)
def test_the_residual_scan_flags_the_email_shape(text):
    assert _has_residual_pii(text) is True
    assert _pre_1936_has_residual_pii(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "",
        "@",
        "a@",
        "@b.com",
        "a@b",
        "a @b.com",
        "a @b.com",
        "a@ b.com",
        "a@b　.com",
        "a@.com",
        "a@b.",
        "a@@b.com",
        "rate @ 500.00",
        "user@localhost",
        "[EMAIL_1]",
    ],
)
def test_the_residual_scan_passes_the_near_miss(text):
    assert _has_residual_pii(text) is False
    assert _pre_1936_has_residual_pii(text) is False


def test_the_residual_scan_agrees_with_the_pre_1936_oracle_on_every_short_string():
    # "@", ".", ASCII and Unicode whitespace, an ASCII and a Devanagari letter: every email,
    # near-miss, leading/trailing "@" and multiple-"@" shape that fits in 7 characters.
    alphabet = ("a", "क", "@", ".", " ", " ")
    flagged = 0
    for length in range(8):
        for chars in itertools.product(alphabet, repeat=length):
            text = "".join(chars)
            verdict = _has_residual_pii(text)
            assert verdict is _pre_1936_has_residual_pii(text), text
            flagged += verdict
    assert flagged > 3_000  # not vacuous: 4,077 of 335,923


def test_the_residual_scan_agrees_with_the_pre_1936_oracle_on_seeded_emails_and_near_misses():
    rng = random.Random(0x1936)
    chars = "abcxyzABC019._+-%!#'~éक"

    def run(lo: int, hi: int) -> str:
        return "".join(rng.choice(chars) for _ in range(rng.randint(lo, hi)))

    flagged = 0
    for _ in range(20_000):
        text = (
            rng.choice(["", "reach me at ", "contact:", "CNC operator\n", " ", "(", "@", "."])
            + (run(64, 300) if rng.random() < 0.05 else run(0, 10))
            + ("@" if rng.random() < 0.8 else rng.choice(["@@", " @", "@ ", "＠", "(at)"]))
            + (run(64, 300) if rng.random() < 0.05 else run(0, 10))
            + ("." if rng.random() < 0.75 else rng.choice(["..", ". ", " .", "。", ""]))
            + rng.choice(["com", "in", "co.in", "x", ""])
            + rng.choice(["", ".", "@", "@x", ")", " now", "\tPF + ESI", " "])
        )
        verdict = _has_residual_pii(text)
        assert verdict is _pre_1936_has_residual_pii(text), text
        flagged += verdict
    # Not vacuous: both verdicts are well represented.
    assert 4_000 < flagged < 16_000, flagged


def test_the_email_shape_matches_one_character_before_the_at():
    # The #1924 pin. Classes collapse to one token first, so the "@" found is the literal one,
    # not the "@" inside `[^\s@]`.
    (pattern,) = [p.pattern for p in _RESIDUAL_PATTERNS if "@" in p.pattern]
    tokens = re.sub(r"\[(?:\\.|[^\]\\])*\]", "C", pattern)
    assert tokens[: tokens.index("@")] == "C"


# Generous ceiling, after the #1891 precedent in `test_pseudonymize_title_employer_bound` (750 ms;
# 250 ms flaked on a loaded laptop). Measured 2026-10-03: the pre-#1936 scan took 16-31 s on the
# first three shapes, about 2 ms now. `finetune_sample` runs this same function. The oracle and
# the pin above are the guard; this is the backstop.
_REDOS_BUDGET_MS = 750


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("a" * 100_000, False),
        ("a" * 100_000 + "@", False),
        ("a" * 50_000 + "@" + "b" * 49_999, False),
        ("a@" * 50_000, False),
        ("x@" + "." * 99_998, True),
    ],
    ids=["no @", "a long run, then an @", "no dot after the @", "repeated @s", "dots after @"],
)
def test_the_residual_scan_is_linear_on_100k_characters(text, expected):
    start = time.perf_counter()
    verdict = _has_residual_pii(text)
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert verdict is expected
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms on {len(text)} chars"
