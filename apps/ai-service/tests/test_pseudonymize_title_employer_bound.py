"""Issue #1891 — the title-case employer rule does bounded work per character.

THE DEFECT, at 20,000 characters (under `DEFAULT_MAX_LENGTH`, so the size gate never fires): the
name word of `_EMPLOYER_RE` was `[A-Z][\\w&.]*`, unbounded. On a run with many word boundaries and
no whitespace, every letter after a "." or "&" opened a match that scanned to the end of the run,
so `pseudonymize("A." * 10000)` took 2.1 s, and 4.3 s with one invisible character (#1738's two
views each run the rule; 2026-10-03, min of 5). `/profiling/respond` and `/profile/extract` call
`pseudonymize()` inline inside `async def`, so the stall is the event loop, for every worker.

THE FIX (`pseudonymize._TITLE_NAME_WORD`): the capitals rule's bound, `_CAPS_NAME_WORD_MAX` (64)
characters, matched possessively: 37 and 82 ms on those two inputs. Possessive changes no match;
the bound changes only a name word over 64 characters (section 3). Re-measured over the #1875
corpus (31,984 distinct strings, as written and upper-cased) and its 4,765 certifier labels: no
output, no blocked status and no certifier outcome moves. `scripts/measure_title_employer_bound.py`
reproduces that from tracked files (32,006 strings on this commit, the same zeros); section 5 keeps
it measuring this rule.

Each section was seen to FAIL against a mutation of the rule: main's unbounded word (1, 3; 12
failures); possessive but unbounded (1, 3; 11); bounded but not possessive (1, the structural test
only); a 65-character bound (1, 3); a 32-character bound (1, 2, 3); an 8-character bound (1, 2, 3,
including "L&T Engineering Works" and "Stainless Steel"). Section 4 (the boundary under the two
views) fails 3 of 3 against both unbounded mutations, and its blocking case fails against a 32- or
8-character bound. Section 5 fails against every one of them: the script's `bound64` must equal the
shipped rule. Stdlib + pytest only, like `test_pseudonymize.py`. All inputs are fabricated.
"""

from __future__ import annotations

import importlib.util
import random
import re
import time
from collections import Counter
from itertools import pairwise
from pathlib import Path

import pytest

import app.pseudonymize as gateway
from app.pseudonymize import (
    certified_clean_skill_labels,
    certify_value,
    is_certified_clean,
    pseudonymize,
)

#: Main's rule before #1891, the oracle for "no output moves".
_MAIN_EMPLOYER_RE = re.compile(r"\b(?:[A-Z][\w&.]*\s+){1,4}" + gateway._COMPANY_SUFFIX + r"\b")
_ZWSP = "\u200b"


@pytest.fixture
def main_gateway(monkeypatch):
    """The gateway with main's unbounded title-case rule, nothing else touched.

    Sound because `_EMPLOYER_RE` is the only rule #1891 changed. Measured against the real main
    module over the #1875 corpus: its outputs and certifier outcomes are byte-identical."""

    def run(fn, *args):
        with monkeypatch.context() as patch:
            patch.setattr(gateway, "_EMPLOYER_RE", _MAIN_EMPLOYER_RE)
            return fn(*args)

    return run


# --- 1. the work per character is bounded ------------------------------------------------------

# Generous ceiling, after the `_CREDENTIAL_ID_LOOKAHEAD_MAX` precedent in `test_egress_gates` and
# the capitals rule's own timing test (whose 250 ms flaked on a loaded laptop, hence 750 ms there
# and here). Measured 2026-10-03, min of 5: main 1.2-4.3 s on these inputs, bounded 26-100 ms. A
# background run that Windows parks on an efficiency core measured the bounded invisible-character
# input at 350-500 ms, which is why the ceiling is not tighter. The structural test below is the
# real guard; this is the backstop.
_REDOS_BUDGET_MS = 750


def test_the_title_case_name_word_is_bounded_and_possessive():
    word = gateway._TITLE_NAME_WORD
    assert word.endswith(f"{{0,{gateway._CAPS_NAME_WORD_MAX - 1}}}+")
    pattern = gateway._EMPLOYER_RE.pattern
    assert pattern.startswith(r"\b(?:" + word + r"\s+){1,4}")
    assert "]*" not in pattern and "]+" not in pattern  # no unbounded run over a character class


@pytest.mark.parametrize(
    "text",
    [
        "A." * 10_000,  # the issue's measured case: every letter after a "." is a word start
        "A&" * 10_000,
        "Ab." * 6_666,
        # One invisible character: the reader and the spaced view (#1738) each run the rule.
        "A." * 9_999 + _ZWSP,
        "A&" * 9_999 + _ZWSP,
    ],
    ids=["A.", "A&", "Ab.", "A.+ZWSP", "A&+ZWSP"],
)
def test_pseudonymize_is_not_quadratic_on_a_dotted_run(text):
    text = text[: gateway.DEFAULT_MAX_LENGTH]
    start = time.perf_counter()
    result = pseudonymize(text)
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms on {len(text)} chars"
    # Behaviour is unchanged: no suffix and no digit, so nothing masks and nothing blocks.
    assert (result.text, result.blocked, result.replaced_entities) == (
        text.replace(_ZWSP, ""),
        False,
        0,
    )


_WALLS = {
    "is_certified_clean": is_certified_clean,
    "certify_value": certify_value,
    "certified_clean_skill_labels": lambda text: certified_clean_skill_labels([text]),
}


@pytest.mark.parametrize("wall", sorted(_WALLS))
def test_every_clean_or_withhold_wall_is_bounded_too(wall):
    # The walls run the rule through `pseudonymize()` whatever AI_RAW_PII_ENABLED says (ADR-0047
    # §4), and none keeps a copy of it, so the one bound covers them.
    text = "A." * 10_000
    start = time.perf_counter()
    _WALLS[wall](text)
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms"


# --- 2. no output moves while every name word is 64 characters or shorter -----------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Tata Steel Ltd", "[EMPLOYER_1]"),
        ("worked at Shree Ganesh Industries in Faridabad", "worked at [EMPLOYER_1] in Faridabad"),
        ("J.K. Tyre Industries", "[EMPLOYER_1]"),
        ("M&M Auto", "[EMPLOYER_1]"),
        ("L&T Engineering Works", "[EMPLOYER_1]"),
        ("A.B.C. Engineering Works Pvt. Ltd.", "[EMPLOYER_1]."),
        ("Om Sai Ram Krishna LTD Steel", "Om [EMPLOYER_1]"),
        ("Tata Motors Ltd-Pune", "[EMPLOYER_1]-Pune"),
        # The over-fires `certified_clean_skill_labels` rescues stay exactly as they were.
        ("Stainless Steel", "[EMPLOYER_1]"),
        ("Quality Co-ordinator", "[EMPLOYER_1]-ordinator"),
        # Exactly 64 characters is still a name word.
        ("A" + "b" * 63 + " Steel", "[EMPLOYER_1]"),
        ("A." * 32 + " Steel", "[EMPLOYER_1]"),
    ],
)
def test_a_real_employer_masks_exactly_as_on_main(text, expected, main_gateway):
    result = pseudonymize(text)
    assert (result.text, result.blocked) == (expected, False)
    assert result == main_gateway(pseudonymize, text)


_NAMES = ["Tata", "Bharat", "Om", "Sai", "Shree", "Ramesh", "Xyz", "Main", "J.K.", "M&M", "L&T"]
_SUFFIXES = sorted(set(re.findall(r"[A-Za-z]+", gateway._COMPANY_SUFFIX))) + ["Pvt.", "Ltd.", "Co."]
_FILLERS = ["mein", "tha", "aur", "se", ",", "5", "Pune", "TATA", "LTD"]
_INVISIBLES = [_ZWSP, "\u00ad"]  # zero-width space, soft hyphen
_WORD_CHARS = "abcdefghijklmnopqrstuvwxyz&."
_CLASS_RUN = re.compile(r"[\w&.]+")


def _long_word(rng: random.Random) -> str:
    """A title-case name word of 40 to 64 characters, dotted, glued with "&", or plain."""
    length = rng.randint(40, 64)
    if rng.random() < 0.3:
        return ("A." * 32)[:length]
    return rng.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ") + "".join(
        rng.choice(_WORD_CHARS) for _ in range(length - 1)
    )


def _sample(rng: random.Random) -> str:
    pools = [_NAMES, _SUFFIXES, _FILLERS, _INVISIBLES]
    parts = []
    for _ in range(rng.randint(1, 8)):
        pick = rng.randrange(len(pools) + 1)
        parts.append(_long_word(rng) if pick == len(pools) else rng.choice(pools[pick]))
    text = parts[0]
    for previous, part in pairwise(parts):
        text += ("" if previous in _INVISIBLES or part in _INVISIBLES else " ") + part
    return text


def test_property_the_bound_moves_nothing_while_no_word_exceeds_64_characters(main_gateway):
    """Over 3,000 samples of THIS seeded generator: title-case and dotted names, every
    `_COMPANY_SUFFIX` word, fillers, name words of 40-64 characters, and two invisibles glued in as
    the sole separator (so the two #1738 views differ).

    IN EACH VIEW: when no run of `[\\w&.]` is over 64 characters, `_mask` gives main's result and
    main's masked regions exactly. END TO END: when that holds in both views, `pseudonymize` gives
    main's result exactly. A run over 64 characters only arises here by gluing two words with an
    invisible; those samples are skipped (section 3 pins that boundary). The floors at the end show
    the long words, the employers and the two views were all exercised."""
    rng = random.Random(1891)
    seen: Counter[str] = Counter()
    for _ in range(3_000):
        text = _sample(rng)
        views = gateway._build_views(text)
        short = [max(map(len, _CLASS_RUN.findall(v.text)), default=0) <= 64 for v in views]
        for view, ok in zip(views, short, strict=True):
            if ok:
                new = gateway._mask(view, True)
                assert new == main_gateway(gateway._mask, view, True), (text, view.text)
        if not all(short):
            seen["skipped, a run over 64"] += 1
            continue
        result = pseudonymize(text)
        assert result == main_gateway(pseudonymize, text), text
        seen["compared"] += 1
        seen["an [EMPLOYER_n]"] += "[EMPLOYER_" in result.text
        seen["two views differ"] += views[0].text != views[1].text
        seen["a 50-64 character word before a suffix"] += bool(
            re.search(r"[\w&.]{50,64}\s+(?:" + gateway._COMPANY_SUFFIX + r")\b", views[0].text)
        )
    assert seen["compared"] > 2_500, seen
    assert seen["an [EMPLOYER_n]"] > 800, seen
    assert seen["two views differ"] > 1_200, seen
    assert seen["a 50-64 character word before a suffix"] > 150, seen


# --- 3. the stated boundary: a name word over 64 characters -------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # No span opens on an undotted word of 65 characters...
        ("A" + "b" * 64 + " Steel", "A" + "b" * 64 + " Steel"),
        # ...and none passes through one, so a name before it is not swept up either.
        ("Ramesh " + "A" + "b" * 64 + " Steel", "Ramesh " + "A" + "b" * 64 + " Steel"),
        # A dotted word masks from the first "." boundary within 64 characters of its end.
        ("A." * 40 + " Steel", "A." * 8 + "[EMPLOYER_1]"),
    ],
    ids=["65-letter word", "a name before it", "80-character dotted word"],
)
def test_KNOWN_RESIDUAL_a_name_word_over_64_characters_is_not_masked_whole(
    text, expected, main_gateway
):
    # Main masked each of these whole. No employer has a 65-character word: none of the 31,984
    # corpus strings holds a capital-led `[\w&.]` run over 43 characters as written, or over 64
    # upper-cased (the 64s are SHA-256 hex digests in test fixtures). The "Ramesh" left raw was only
    # ever masked by accident: a bare "Ramesh" is raw on main too (no cue, no comma). It is the
    # shape the capitals rule has had since #1875 (risks-register R48). If this starts masking
    # whole, the bound moved.
    assert main_gateway(pseudonymize, text).text == "[EMPLOYER_1]"
    result = pseudonymize(text)
    assert (result.text, result.blocked) == (expected, False)
    # A clean-or-withhold wall now passes the undotted ones raw; main withheld them as employers.
    assert is_certified_clean(text) is (expected == text)


# --- 4. the boundary under #1738's two views ----------------------------------------------------
# The property test skips a run over 64 that only an invisible creates. Here are both outcomes.


def test_a_word_joined_past_64_by_an_invisible_blocks_when_it_is_the_only_name_word(main_gateway):
    # The reader view reads one 80-letter word and opens no span. The spaced view reads two
    # 40-letter words and masks "<A40> <B40> Steel", a region the reader view left raw, so the
    # two-view check fails closed. Main masked it whole in both views.
    text = "A" * 40 + _ZWSP + "B" * 40 + " Steel"
    assert main_gateway(pseudonymize, text).text == "[EMPLOYER_1]"
    result = pseudonymize(text)
    assert (result.text, result.blocked) == ("", True)
    assert is_certified_clean(text) is False


@pytest.mark.parametrize(
    "text",
    [
        "A" * 40 + _ZWSP + "B" * 40 + " Steel Works",
        "Ramesh" + _ZWSP + "K" * 60 + " Steel Works",
    ],
    ids=["two 40-letter words", "a name glued to a 60-letter word"],
)
def test_KNOWN_RESIDUAL_r49_a_word_joined_past_64_egresses_as_the_reader_view(text, main_gateway):
    # "Steel" is a second name word before "Works", so the reader view masks "Steel Works". The
    # spaced-view span overlaps that mask, and R49 (#1890) counts a partial overlap as covered.
    # What egresses is the reader view: the same output, byte for byte, as the word written with
    # no invisible (section 3), so the invisible adds no exposure. When #1890 lands (only full
    # cover counts), this blocks; move it to the test above.
    assert main_gateway(pseudonymize, text).text == "[EMPLOYER_1]"
    result = pseudonymize(text)
    reader_view = text.replace(_ZWSP, "")
    expected = reader_view.replace(" Steel Works", " [EMPLOYER_1]")
    assert (result.text, result.blocked) == (expected, False)
    no_invisible = pseudonymize(reader_view)
    assert (no_invisible.text, no_invisible.blocked) == (result.text, False)


# --- 5. the measurement script measures this rule -----------------------------------------------
# `scripts/measure_title_employer_bound.py` reproduces the over-mask, timing and boundary numbers.
# Its MAIN must be this file's oracle, and its `boundN` variants must be the shipped rule with only
# the bound changed, or `--against bound8` would not be the sensitivity run it claims to be.


@pytest.fixture(scope="module")
def measure_script():
    path = Path(__file__).resolve().parents[1] / "scripts" / "measure_title_employer_bound.py"
    spec = importlib.util.spec_from_file_location("measure_title_employer_bound", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_measurement_script_compares_main_with_the_shipped_rule(measure_script):
    assert measure_script.gateway is gateway
    assert measure_script.MAIN_EMPLOYER_RE.pattern == _MAIN_EMPLOYER_RE.pattern
    assert measure_script.variant("main") is measure_script.MAIN_EMPLOYER_RE
    assert measure_script.variant("module") is gateway._EMPLOYER_RE
    shipped_bound = f"bound{gateway._CAPS_NAME_WORD_MAX}"
    assert measure_script.variant(shipped_bound).pattern == gateway._EMPLOYER_RE.pattern
    assert measure_script.variant("bound8").pattern != gateway._EMPLOYER_RE.pattern


def test_the_measurement_script_restores_the_shipped_rule(measure_script):
    shipped = gateway._EMPLOYER_RE
    with pytest.raises(RuntimeError), measure_script.employer_rule(_MAIN_EMPLOYER_RE):
        assert gateway._EMPLOYER_RE is _MAIN_EMPLOYER_RE
        raise RuntimeError
    assert gateway._EMPLOYER_RE is shipped
