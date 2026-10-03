"""Issue #1892 — the employer shapes #1875 left raw are masked; ordinary speech still is not.

THE GAP, measured on main before the fix (2026-10-03):

    pseudonymize("tata motors ltd").text          -> "tata motors ltd"         (0 masked)
    pseudonymize("Larsen & Toubro Limited").text  -> "Larsen & [EMPLOYER_1]"
    pseudonymize("Sharma & Co.").text             -> "Sharma & Co."            (0 masked)
    pseudonymize("M/S SHARMA TRADERS").text       -> "M/S SHARMA TRADERS"      (0 masked)
    pseudonymize("RAMESH KUMAR SHARMA ENGINEERING WORKS PVT LTD").text -> "RAMESH [EMPLOYER_1] LTD"

and each certified clean. THE RULES (documented above `pseudonymize._EMPLOYER_STOPWORDS`): five
separate passes after the capitals rule's neighbours — lower and sentence case before a form that
stays corporate in lower case (`_EMPLOYER_LOWER_RE`); the title-case twins of #1875's forms
(`_EMPLOYER_TITLE_FORM_RE`) and the absorb pass that folds what the title-case rule left beside a
token into it (`_EMPLOYER_ABSORB_RE`); the M/S cue (`_EMPLOYER_MS_CUE_RE`); five or six name words
before a strong form (`_EMPLOYER_LONG_RE`). Each pass is gated on its mandatory piece
(`_RULE_GATES`). Measured over 50,918 repo strings, 1,324 fabricated negative lines and 576
fabricated employer lines before any rule was written; the numbers are in the module notes.

Each section was seen to FAIL against a mutation of the rules (see the PR). Stdlib + pytest only,
like `test_pseudonymize.py`. All inputs are fabricated.
"""

from __future__ import annotations

import json
import random
import re
import time
from collections import Counter
from itertools import pairwise
from pathlib import Path

import pytest

import app.pseudonymize as gateway
from app.profiling import lexicon
from app.pseudonymize import (
    TokenScope,
    certified_clean_skill_labels,
    certify_value,
    is_certified_clean,
    pseudonymize,
)

_NEVER = re.compile(r"(?!x)x")
_RULES_1892 = (
    "_EMPLOYER_LONG_RE",
    "_EMPLOYER_TITLE_FORM_RE",
    "_EMPLOYER_LOWER_RE",
    "_EMPLOYER_MS_CUE_RE",
    "_EMPLOYER_ABSORB_RE",
)
_ZWSP = "​"


@pytest.fixture
def main_gateway(monkeypatch):
    """The gateway as #1891 left it: the five #1892 passes switched off, nothing else touched.

    Sound because each is a SEPARATE pass after the title-case rule, both name rules and the
    capitals rule; with them matching nothing every other rule sees byte-identical input. Measured
    over the 50,918-string corpus: identical to the module before #1892."""

    def run(fn, *args):
        with monkeypatch.context() as patch:
            for name in _RULES_1892:
                patch.setattr(gateway, name, _NEVER)
            return fn(*args)

    return run


def _masks_to(text: str, expected: str, tokens: int = 1) -> None:
    result = pseudonymize(text)
    assert (result.text, result.blocked, result.replaced_entities) == (expected, False, tokens)


# --- 1. lower and sentence case -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # The three shapes the issue names, and their neighbours.
        ("tata motors ltd", "[EMPLOYER_1]"),
        ("Tata motors ltd", "[EMPLOYER_1]"),
        ("TATA MOTORS ltd", "[EMPLOYER_1]"),
        ("tata motors Ltd", "[EMPLOYER_1]"),
        ("main tata motors ltd mein tha", "main [EMPLOYER_1] mein tha"),
        ("tata motors ltd mein 5 saal", "[EMPLOYER_1] mein 5 saal"),
        # Every form that stays corporate in lower case after one name word.
        ("bharat forge private limited", "[EMPLOYER_1]"),
        ("xyz engineering works pvt ltd", "[EMPLOYER_1]"),
        ("xyz industries pvt. ltd.", "[EMPLOYER_1]."),
        ("sharma & co.", "[EMPLOYER_1]."),
        ("acme llp", "[EMPLOYER_1]"),
        ("al futtaim llc", "[EMPLOYER_1]"),
        ("xyz contracting w.l.l", "[EMPLOYER_1]"),
        # The weak forms, after two or more name words.
        ("jai bhavani industries bhosari me", "[EMPLOYER_1] bhosari me"),
        ("om sai enterprises me electrician", "[EMPLOYER_1] me electrician"),
        ("ambika steel corporation me", "[EMPLOYER_1] me"),
        ("verma brothers co. me driver", "[EMPLOYER_1] me driver"),
    ],
)
def test_a_lower_or_sentence_case_employer_is_masked(text, expected, main_gateway):
    assert main_gateway(pseudonymize, text).text == text  # raw on main
    _masks_to(text, expected)


def test_two_lower_case_employers_get_two_tokens():
    _masks_to("tata motors ltd aur bajaj auto ltd", "[EMPLOYER_1] aur [EMPLOYER_2]", tokens=2)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # In lower case every word is a candidate; a stopword neither opens nor sits in the span.
        ("cnc turner at tata motors ltd, pune", "cnc turner at [EMPLOYER_1], pune"),
        ("operator at kalyani pvt ltd", "operator at [EMPLOYER_1]"),
        ("pf at acme pvt ltd", "pf at [EMPLOYER_1]"),
        ("bus from acme private limited", "bus from [EMPLOYER_1]"),
        ("maine welding kiya tata motors ltd mein", "maine welding kiya [EMPLOYER_1] mein"),
        # A sentence-final stopword still stops the span; "kiya." is not a name word.
        ("kaam kiya. tata motors ltd", "kaam kiya. [EMPLOYER_1]"),
    ],
)
def test_a_stopword_keeps_the_words_around_a_lower_case_employer(text, expected):
    _masks_to(text, expected)


@pytest.mark.parametrize(
    "text",
    [
        # A generic firm: a determiner, then a form, then no proper noun.
        "ek pvt ltd company mein tha",
        "koi pvt. ltd. ho to batana",
        "working in a reputed pvt. ltd. company",
        # The forms that are ordinary words in lower case are not forms at all.
        "limited experience hai",
        "programming ka knowledge limited hai",
        "Limited seats hai",
        "usually limited range",
        "pvt job hai",
        "private company mein tha",
        "meri company mein kaam",
        "mera co worker bhi aayega",
        "fitter & co-worker",
        "co2 welding aati hai",
        "auto industry mein 5 saal",
        # A weak form after ONE word: "various industries", "municipal corporation".
        "various industries mein kaam kiya",
        "municipal corporation ka kaam",
    ],
)
def test_ordinary_lower_case_speech_is_not_masked(text):
    result = pseudonymize(text)
    assert (result.text, result.blocked, result.replaced_entities) == (text, False, 0)


# --- 2. the title-case twins of #1875's forms ----------------------------------------------------


@pytest.mark.parametrize(
    ("text", "main_text", "expected"),
    [
        # Raw on main: a joiner or a form the title-case suffix list lacks.
        ("Sharma & Co.", "Sharma & Co.", "[EMPLOYER_1]."),
        ("Xyz (P) Ltd", "Xyz (P) Ltd", "[EMPLOYER_1]"),
        ("Acme Llp", "Acme Llp", "[EMPLOYER_1]"),
        ("Acme Llc", "Acme Llc", "[EMPLOYER_1]"),
        # Half-masked on main; the absorb pass folds the rest into the token.
        ("Larsen & Toubro Limited", "Larsen & [EMPLOYER_1]", "[EMPLOYER_1]"),
        ("Mahindra & Mahindra Ltd", "Mahindra & [EMPLOYER_1]", "[EMPLOYER_1]"),
        ("Shah Sharma & Sons Ltd", "Shah Sharma & [EMPLOYER_1]", "[EMPLOYER_1]"),
        ("3M India Ltd", "3M [EMPLOYER_1]", "[EMPLOYER_1]"),
        ("Hero-Honda Ltd", "Hero-[EMPLOYER_1]", "[EMPLOYER_1]"),
        # A trailing form left beside the token.
        ("Tata Motors LTD", "[EMPLOYER_1] LTD", "[EMPLOYER_1]"),
        ("Tata Motors ltd", "[EMPLOYER_1] ltd", "[EMPLOYER_1]"),
        ("Tata Motors pvt ltd", "[EMPLOYER_1] pvt ltd", "[EMPLOYER_1]"),
        ("Bajaj Auto LTD", "[EMPLOYER_1] LTD", "[EMPLOYER_1]"),
        ("Tata Steel LIMITED", "[EMPLOYER_1] LIMITED", "[EMPLOYER_1]"),
        ("Shree Ganesh Auto Components Pvt Ltd", "[EMPLOYER_1] Ltd", "[EMPLOYER_1]"),
    ],
)
def test_a_title_case_twin_masks_whole(text, main_text, expected, main_gateway):
    assert main_gateway(pseudonymize, text).text == main_text
    # The absorb pass mints nothing: one employer, one token.
    _masks_to(text, expected)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # A curated trade word before the joiner is a skill, not a name: exactly main's output.
        ("Welding & Stainless Steel", "Welding & [EMPLOYER_1]"),
        # A stopword before the joiner is not absorbed ("3 YRS & ABOVE …").
        ("3 YRS & ABOVE EXPERIENCE IN AUTO INDUSTRY", "3 YRS & [EMPLOYER_1]"),
        ("Quality & Co-ordination", "Quality & Co-ordination"),
        # Two firms joined by "(I)" keep their two tokens.
        ("Abc Engineers (I) Pvt. Ltd.", "[EMPLOYER_1] (I) [EMPLOYER_2]."),
    ],
)
def test_the_absorb_pass_leaves_these_exactly_as_main(text, expected, main_gateway):
    result = pseudonymize(text)
    assert result.text == expected
    assert result == main_gateway(pseudonymize, text)


# --- 3. the M/S cue -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("M/S. KRISHNA FABRICATORS", "M/S. [EMPLOYER_1]"),
        ("M/S SHARMA TRADERS", "M/S [EMPLOYER_1]"),
        ("M/s. Krishna Fabricators", "M/s. [EMPLOYER_1]"),
        ("worked at m/s sharma traders", "worked at m/s [EMPLOYER_1]"),
        ("M / S KRISHNA FABRICATORS ME WELDER", "M / S [EMPLOYER_1] ME WELDER"),
        ("M/S: Om Sai Traders, Pune", "M/S: [EMPLOYER_1], Pune"),
        ("M/S A-ONE FABRICATORS ME WELDER", "M/S [EMPLOYER_1] ME WELDER"),
        ("M/s 3S Engineering Services me technician", "M/s [EMPLOYER_1] me technician"),
        ("m/s gupta & sons, bhosari", "m/s [EMPLOYER_1], bhosari"),
        # A stopword ends the firm...
        ("M/S SHARMA TRADERS mein 3 saal", "M/S [EMPLOYER_1] mein 3 saal"),
        # ...and so does a city after the first word: cities are never redacted (2026-07-31).
        ("M/S KRISHNA FABRICATORS, PUNE", "M/S [EMPLOYER_1], PUNE"),
        (
            "worked at M/S SHARMA TRADERS PUNE MEIN 3 SAAL",
            "worked at M/S [EMPLOYER_1] PUNE MEIN 3 SAAL",
        ),
        # ...and so does a line break: the next line is the role, not the firm.
        ("M/S SHARMA TRADERS\nCNC OPERATOR", "M/S [EMPLOYER_1]\nCNC OPERATOR"),
    ],
)
def test_a_firm_after_an_m_s_cue_is_masked(text, expected, main_gateway):
    assert main_gateway(pseudonymize, text).text == text  # raw on main
    _masks_to(text, expected)


@pytest.mark.parametrize(
    ("text", "main_text", "expected"),
    [
        # The title-case rule took the cue's "S" as a name word; the token keeps it.
        (
            "M/S Hanuman Steel Traders me loader",
            "M/[EMPLOYER_1] Traders me loader",
            "M/[EMPLOYER_1] me loader",
        ),
        # A firm the title-case rule half-masked keeps its token and takes the rest.
        (
            "M/s Jagdamba Steel Furniture me fabrication",
            "M/s [EMPLOYER_1] Furniture me fabrication",
            "M/s [EMPLOYER_1] me fabrication",
        ),
        # The "S" of the cue never opens a span (`_SPAN_START`).
        ("M/S SHREE GANESH AUTO COMPONENTS LTD", "M/S [EMPLOYER_1]", "M/S [EMPLOYER_1]"),
    ],
)
def test_an_m_s_firm_an_earlier_rule_half_masked_keeps_one_token(
    text, main_text, expected, main_gateway
):
    assert main_gateway(pseudonymize, text).text == main_text
    _masks_to(text, expected)


@pytest.mark.parametrize(
    "text",
    [
        # Metres per second: after a number, or explained.
        "speed 5 m/s",
        "SPEED 5 M/S HAI",
        "cutting speed 2.5m/s",
        "WIND SPEED 9 M/S SE UPAR",
        "speed in m/s hoti hai",
        "m/s matlab meter per second hota hai",
        "mera kaam tha conveyor ki speed m/s check karna",
        # Mild steel.
        "m/s plate aur angle ka kaam",
        "M/S PLATE CUTTING GAS SE KARTA HU",
        "M/S ANGLE CUTTING",
        # Not the cue at all.
        "feed 150 mm/s",
        "speed 3 km/s",
    ],
)
def test_m_s_as_a_unit_or_mild_steel_is_not_a_firm(text):
    result = pseudonymize(text)
    assert (result.text, result.blocked, result.replaced_entities) == (text, False, 0)


# --- 4. five or six name words --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "main_text", "expected"),
    [
        (
            "RAMESH KUMAR SHARMA ENGINEERING WORKS PVT LTD",
            "RAMESH [EMPLOYER_1] LTD",
            "[EMPLOYER_1]",
        ),
        ("ramesh kumar sharma engineering works pvt ltd", None, "[EMPLOYER_1]"),
        ("SRI RAMA KRISHNA CASTING AND FORGING LTD", "SRI RAMA [EMPLOYER_1]", "[EMPLOYER_1]"),
        (
            "SHIV SHAKTI PLASTIC MOULDING AND PACKAGING PVT LTD",
            "SHIV SHAKTI [EMPLOYER_1] LTD",
            "[EMPLOYER_1]",
        ),
        ("new india precision tools and dies pvt ltd me", None, "[EMPLOYER_1] me"),
        (
            "MAINE 5 SAAL SHREE GANESH ENGINEERING WORKS PVT LTD MEIN",
            "MAINE 5 SAAL [EMPLOYER_1] LTD MEIN",
            "MAINE 5 SAAL [EMPLOYER_1] MEIN",
        ),
    ],
)
def test_five_or_six_name_words_before_a_strong_form_mask_whole(
    text, main_text, expected, main_gateway
):
    assert main_gateway(pseudonymize, text).text == (text if main_text is None else main_text)
    _masks_to(text, expected)


# --- 5. the stated boundary, both directions -----------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected", "why"),
    [
        (
            "bharat forge limited",
            "bharat forge limited",
            "'limited' alone is ordinary in lower case",
        ),
        ("omkar engineering company chakan", "omkar engineering company chakan", "nor 'company'"),
        ("gupta industries me", "gupta industries me", "a weak form needs two name words"),
        ("balaji enterprises me tha", "balaji enterprises me tha", "a weak form needs two words"),
        ("tata motors mein tha", "tata motors mein tha", "no form, no cue"),
        ("SHREE SAI ENGINEERING WORKS", "SHREE SAI ENGINEERING WORKS", "no form, no cue"),
        ("BAJAJ AUTO", "BAJAJ AUTO", "no form, no cue"),
        ("GUPTA & SONS", "GUPTA & SONS", "no form, no cue"),
        ("xyz and sons ltd", "xyz and [EMPLOYER_1]", "'and' is a stopword in lower case"),
        ("A B C D E F G PVT LTD", "A [EMPLOYER_1]", "seven name words; the window is six"),
        (
            "SRI RAMA KRISHNA CASTING AND FORGING LIMITED",
            "SRI RAMA [EMPLOYER_1]",
            "LIMITED is not a strong form",
        ),
        ("M/S STEEL CENTRE", "M/S STEEL CENTRE", "a mild-steel word cannot open an M/S firm"),
    ],
)
def test_KNOWN_RESIDUAL_stated_under_masking(text, expected, why):
    # Each is recorded in risks-register R48 and the module notes, with the measurement that kept it
    # out. If one of these starts masking, the boundary moved: re-measure and update both.
    assert pseudonymize(text).text == expected, why


@pytest.mark.parametrize(
    ("text", "main_text", "expected"),
    [
        # The absorb pass extends an over-mask the title-case rule already makes on main.
        (
            "Hiring Fitter & Welder For Steel Industry Project",
            "Hiring Fitter & [EMPLOYER_1] Project",
            "Hiring [EMPLOYER_1] Project",
        ),
        (
            "Walk-In Interview For Quality Co-ordinator",
            "Walk-[EMPLOYER_1]-ordinator",
            "[EMPLOYER_1]-ordinator",
        ),
        # The long rule widens a capitals span before PVT LTD on telegraphic text.
        (
            "SENIOR QUALITY ENGINEER WITH PPAP APQP FMEA MSA SPC KNOWLEDGE PVT LTD",
            "SENIOR QUALITY ENGINEER WITH PPAP APQP [EMPLOYER_1] LTD",
            "SENIOR QUALITY ENGINEER WITH [EMPLOYER_1]",
        ),
        # "ltd" as an abbreviation of "limited".
        (
            "posts ltd hai, jaldi bhejo profile",
            "posts ltd hai, jaldi bhejo profile",
            "[EMPLOYER_1] hai, jaldi bhejo profile",
        ),
    ],
)
def test_ACCEPTED_over_masking(text, main_text, expected, main_gateway):
    # Measured: 9 of 1,324 fabricated negative lines over-mask as written; these are the shapes.
    # Over-masking an identity class is the safe direction (module notes, OVER).
    assert main_gateway(pseudonymize, text).text == main_text
    assert pseudonymize(text).text == expected


# --- 6. order, name cues, digits and the two views ------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "MY NAME IS CO Ramesh",
        "MERA NAAM PVT RAMESH",
        "I AM LIMITED Ramesh Kumar",
        "Om Sai Ram Krishna LTD Steel",
        "Main Private Company mein tha",
        "Stainless Steel",
        "Quality Co-ordinator",
        "Tata Motors Ltd-Pune",
        "Ramesh Kumar Sharma Engineering Works Pvt Ltd",
    ],
)
def test_every_earlier_rule_keeps_its_span(text, main_gateway):
    # The passes run after the name rules, the title-case rule and the capitals rule, on their
    # output: a name cue is never eaten and an earlier match is never shortened.
    assert pseudonymize(text) == main_gateway(pseudonymize, text)


def test_a_name_and_a_lower_case_employer_both_mask():
    _masks_to("mera naam ramesh, tata motors ltd", "mera naam ramesh, [EMPLOYER_1]")
    result = pseudonymize("mera naam Ramesh, tata motors ltd")
    assert result.text == "mera naam [PERSON_1], [EMPLOYER_1]"


@pytest.mark.parametrize(
    ("text", "expected_blocked", "expected_text"),
    [
        # A word holding 7+ digits is never a name word, so main's block stands...
        ("X12345678 ltd", True, None),
        ("tm12345678 tata motors ltd", True, None),
        # ...and an in-range amount glued to a word is still money.
        ("ab1234567 tata motors ltd", False, "ab[AMOUNT_1] [EMPLOYER_1]"),
    ],
)
def test_digits_keep_main_s_fail_closed_path(text, expected_blocked, expected_text, main_gateway):
    result = pseudonymize(text)
    assert result.blocked is expected_blocked
    if expected_blocked:
        assert main_gateway(pseudonymize, text).blocked is True
        assert result.blocked_reason == "residual numeric sequence detected"
    else:
        assert result.text == expected_text


@pytest.mark.parametrize(
    "text",
    [
        "tata motors​ltd",  # the reader view merges "motorsltd"; the spaced view masks
        "M/S​SHARMA TRADERS",  # the reader view merges "M/SSHARMA"; the spaced view masks
        "Larsen &​Toubro Limited",  # main passed this with "Larsen" raw
    ],
)
def test_an_invisible_that_hides_an_employer_fails_closed(text):
    result = pseudonymize(text)
    assert (result.text, result.blocked) == ("", True)
    assert result.blocked_reason == gateway._INVISIBLE_BYPASS_REASON


def _two_view_verdict(text: str) -> str:
    """As in `test_pseudonymize_allcaps_employer.py`: "blocks", "full" or "partial" (R49)."""
    reader_view, spaced_view = gateway._build_views(text)
    reader, reader_regions = gateway._mask(reader_view, True)
    spaced, spaced_regions = gateway._mask(spaced_view, True)
    reader_masked: set[int] = set().union(*reader_regions)
    if (
        reader.blocked
        or spaced.blocked
        or any(not (region & reader_masked) for region in spaced_regions)
    ):
        return "blocks"
    kept = set(reader_view.src)
    if any((region & kept) - reader_masked for region in spaced_regions):
        return "partial"
    return "full"


def test_a_name_hidden_by_an_invisible_is_now_masked_whole(main_gateway):
    # Main BLOCKED this (the spaced view's name overlapped no reader mask). The lower-case rule's
    # reader-view span now covers "isRamesh Kumar", so every offset the spaced view masked is
    # masked: the two-view check passes it, as designed, with the name under an employer label.
    text = "my name is​Ramesh Kumar ltd"
    assert main_gateway(pseudonymize, text).blocked_reason == gateway._INVISIBLE_BYPASS_REASON
    assert pseudonymize(text).text == "my [EMPLOYER_1]"
    assert _two_view_verdict(text) == "full"


@pytest.mark.parametrize(
    ("text", "leaked"),
    [
        ("my name is​Ramesh Kumar Llp", "my name isRamesh [EMPLOYER_1]"),
        ("my name is​Ramesh Kumar & Co.", "my name isRamesh [EMPLOYER_1]."),
    ],
)
def test_KNOWN_RESIDUAL_r49_extends_to_the_title_case_forms(text, leaked, main_gateway):
    """R49 / #1890, pre-existing in #1738's two-view check (see the capitals file's twin test).

    The reader view merges "isRamesh", so the cue misses and the title-form pass masks "Kumar Llp";
    the spaced view masks "Ramesh Kumar" as a name, which merely OVERLAPS that mask, so "Ramesh"
    egresses where main blocked. #1892 extends the shape to the title-case forms, as #1875 did to
    the capitals ones. If this starts blocking, R49 is fixed: make it a blocking pin."""
    assert main_gateway(pseudonymize, text).blocked_reason == gateway._INVISIBLE_BYPASS_REASON
    result = pseudonymize(text)
    assert (result.text, result.blocked) == (leaked, False)
    assert _two_view_verdict(text) == "partial"


# --- 7. scope and the certifiers ------------------------------------------------------------------


def test_every_spelling_of_one_employer_shares_one_token_under_a_scope():
    scope = TokenScope()
    assert pseudonymize("tata motors ltd chhoda", scope=scope).text == "[EMPLOYER_1] chhoda"
    assert pseudonymize("Tata Motors Ltd", scope=scope).text == "[EMPLOYER_1]"
    assert pseudonymize("TATA MOTORS LTD", scope=scope).text == "[EMPLOYER_1]"
    assert pseudonymize("bharat forge pvt ltd", scope=scope).text == "[EMPLOYER_2]"


def test_an_employer_these_passes_mask_no_longer_certifies_clean():
    for label in (
        "tata motors ltd",
        "M/S SHARMA TRADERS",
        "Sharma & Co.",
        "Larsen & Toubro Limited",
    ):
        assert is_certified_clean(label) is False, label
        assert certify_value(label)[1] != label, label
    assert certified_clean_skill_labels(
        [
            "tata motors ltd",
            "M/S SHARMA TRADERS",
            "Welding & Stainless Steel",
            "Stainless Steel",
            "STAINLESS STEEL",
            "m/s plate cutting",
            "VMC Operation",
        ]
    ) == [
        "Welding & Stainless Steel",
        "Stainless Steel",
        "STAINLESS STEEL",
        "m/s plate cutting",
        "VMC Operation",
    ]


def _lexicon_strings() -> list[str]:
    found: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, str):
            found.append(node)
        elif isinstance(node, dict):
            for key, value in node.items():
                found.append(key)
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    data_dir = Path(lexicon.__file__).resolve().parent / "lexicon_data"
    for path in sorted(data_dir.glob("*.json")):
        walk(json.loads(path.read_text(encoding="utf-8")))
    return sorted(set(found))


def test_no_certifier_outcome_moves_on_the_lexicon_vocabulary(main_gateway):
    # Every lexicon string as written, UPPER, Title and lower: the three clean-or-withhold walls
    # decide exactly as before #1892. Lower case matters here: these passes read any case.
    labels = _lexicon_strings()
    assert len(labels) > 1_000
    casings = {v for s in labels for v in (s, s.upper(), s.title(), s.lower())}
    for label in sorted(casings):
        for wall in (is_certified_clean, certify_value):
            assert wall(label) == main_gateway(wall, label), (wall.__name__, label)
        assert certified_clean_skill_labels([label]) == main_gateway(
            certified_clean_skill_labels, [label]
        ), label


# --- 8. the passes only ever add masking ---------------------------------------------------------

_NAMES = ["Tata", "TATA", "tata", "Sharma", "sharma", "Krishna", "KRISHNA", "Om", "sai", "Jai"]
_TRADE = ["Motors", "motors", "Steel", "auto", "Engineering", "WORKS", "Traders", "Fabricators"]
_FORMS = [
    "ltd", "Ltd", "LTD", "ltd.", "llp", "Llp", "llc", "pvt ltd", "PVT LTD", "private limited",
    "industries", "enterprises", "corporation", "co.", "Co.", "co", "limited", "Limited", "company",
    "pvt", "LIMITED", "INDUSTRIES",
]  # fmt: skip
_CUES = ["M/S", "M/s.", "m/s", "M / S", "M/S:", "5 m/s", "mera naam", "MY NAME IS", "my name is"]
_JOINED = ["&", "(P)", "(I)", "and", "3M", "Hero-Honda", "A-ONE", "J.K."]
_FILLERS = ["mein", "at", "ek", "koi", "the", "plate", "angle", "Pune", "PUNE", "chakan", ",", "5"]
_DIGITS = ["X12345678", "12345678", "ab1234567"]
_INVISIBLES = ["​", "‌", "⁠", "­"]
_POOLS = [_NAMES, _TRADE, _FORMS, _CUES, _JOINED, _FILLERS, _DIGITS, _INVISIBLES]


def _sample(rng: random.Random) -> str:
    parts = [rng.choice(rng.choice(_POOLS)) for _ in range(rng.randint(1, 9))]
    text = parts[0]
    for previous, part in pairwise(parts):
        text += ("" if previous in _INVISIBLES or part in _INVISIBLES else " ") + part
    return text


def _raw_words(text: str) -> Counter[str]:
    return Counter(re.findall(r"[^\W_]+", re.sub(r"\[[A-Z]+_\d+\]", " ", text)))


def _a_pass_may_act(text: str, main_text: str) -> bool:
    return "[EMPLOYER_" in main_text or any(
        gate.search(text) for _rule, gate in gateway._RULE_GATES.values()
    )


def test_property_the_1892_passes_only_ever_add_masking(main_gateway):
    """What this PROVES, exactly — over 4,000 samples of THIS seeded generator, not over all inputs.

    The pools: names and trade words in three cases, every form these passes read and the ordinary
    words they must not ("limited", "company", "pvt"), the M/S cue in five spellings and as a unit,
    the name cues, joiners, dash- and digit-led words, stopwords, mild-steel words, cities, digit
    words main blocks on or masks as money, and four invisibles glued in as the SOLE separator.

    1. IN EACH VIEW (`_mask`): every source offset main masked is still masked (a region may grow:
       the long rule runs ahead of the capitals rule and can take its span whole), no word main
       masked is left raw, every residual-digit block main raised is still raised, and when no pass
       could act (`_a_pass_may_act`) the result and regions are byte-identical. The title-case and
       name rules run first, so their spans are exactly main's (`test_every_earlier_rule_keeps…`).
    2. END TO END (`pseudonymize`): the same, EXCEPT where main blocked on the two-view check and
       the branch passes, each such turn asserted to be "full" (the reader view now masks every
       kept offset the spaced view masked; 9 of the 4,000) or "partial" (R49, #1890; 5 of the
       4,000). Measured 2026-10-03, what the 5 leave raw: four the "S" of an M/S cue (the reader
       view keeps it as the cue, the spaced view's title-case rule took it as a name word), one
       the forms " co PVT LTD"; none a name word. The shape that does leave a name raw is pinned
       on its own by `test_KNOWN_RESIDUAL_r49_extends_to_the_title_case_forms`.

    What it does NOT prove: anything outside these pools, or that the masking is CORRECT."""
    rng = random.Random(1892)
    seen: Counter[str] = Counter()
    for _ in range(4_000):
        text = _sample(rng)
        for view in gateway._build_views(text):
            new_view, new_regions = gateway._mask(view, True)
            old_view, old_regions = main_gateway(gateway._mask, view, True)
            assert old_view.blocked <= new_view.blocked, text
            new_masked: set[int] = set().union(*new_regions)
            assert all(region <= new_masked for region in old_regions), (text, view.text)
            seen["a region grew"] += any(region not in new_regions for region in old_regions)
            assert not (_raw_words(new_view.text) - _raw_words(old_view.text)), (text, view.text)
            if not _a_pass_may_act(view.text, old_view.text):
                assert (new_view, new_regions) == (old_view, old_regions), text
        new, old = pseudonymize(text), main_gateway(pseudonymize, text)
        seen["changed"] += new != old
        seen["main blocked"] += old.blocked
        if old.blocked and not new.blocked:
            assert old.blocked_reason == gateway._INVISIBLE_BYPASS_REASON, text
            verdict = _two_view_verdict(text)
            assert verdict in ("full", "partial"), (text, verdict)
            seen[f"unblocked, {verdict}"] += 1
            continue
        assert old.blocked <= new.blocked, text
        assert not (_raw_words(new.text) - _raw_words(old.text)), (text, old.text, new.text)
        if not any(_a_pass_may_act(v.text, old.text) for v in gateway._build_views(text)):
            assert new == old, text
    # Measured 2026-10-03: 854 outputs change, 1,326 turns main blocked, 9 regions grew; of the
    # turns main blocked that now pass, 9 are "full" and 5 "partial" (R49).
    assert seen["changed"] > 700, seen
    assert seen["main blocked"] > 1_000, seen
    assert seen["a region grew"] > 0, seen


# --- 9. the gates and the cost --------------------------------------------------------------------


def test_every_gate_is_a_necessary_condition_of_its_rule():
    # A gate that missed a text its rule matches would silently switch the rule off there. Each
    # gate is the rule's own mandatory piece; this checks it over the property pools and the
    # shapes above.
    rng = random.Random(18921)
    texts = [_sample(rng) for _ in range(3_000)]
    texts += [
        "M/[EMPLOYER_1] Traders",
        "Larsen & [EMPLOYER_1]",
        "[EMPLOYER_1] pvt ltd",
        "Hero-[EMPLOYER_1]",
    ]
    assert len(gateway._RULE_GATES) == len(_RULES_1892)
    for rule, gate in gateway._RULE_GATES.values():
        assert any(rule is getattr(gateway, name) for name in _RULES_1892)
        for text in texts:
            for view in gateway._build_views(text):
                for candidate in (view.text, gateway._mask(view)[0].text):
                    if rule.search(candidate):
                        assert gate.search(candidate), (rule.pattern[:40], candidate)


def test_a_swapped_rule_runs_ungated(monkeypatch):
    # The gates are keyed by the shipped pattern's identity: a test that swaps a rule in is not
    # silently gated by the old rule's gate.
    swapped = re.compile(r"\bQQQ\b")
    monkeypatch.setattr(gateway, "_EMPLOYER_LOWER_RE", swapped)
    assert gateway._gate_is_shut(swapped, "QQQ") is False
    assert gateway._gate_is_shut(gateway._EMPLOYER_ABSORB_RE, "no token here") is True


def test_every_new_name_word_is_bounded_and_possessive():
    for word in (gateway._ANY_NAME_WORD, gateway._MS_NAME_WORD):
        assert re.search(r"\{0,\d+\}\+$", word), word  # possessive and bounded
        assert "]*" not in word and "]+" not in word  # no unbounded run over a character class


# Generous ceiling, after the `_CREDENTIAL_ID_LOOKAHEAD_MAX` precedent and the two employer files.
# Measured 2026-10-03 for `pseudonymize` end to end: 6-29 ms on these (9-14 ms before #1892).
_REDOS_BUDGET_MS = 750


@pytest.mark.parametrize(
    "text",
    [
        "M/S " * 5_000,
        "m/s a " * 3_333,
        "a " * 10_000,
        "A& " * 6_666,
        "Ab (P) " * 2_857,
        "Ab & Tata Steel LTD " * 1_000,
        "abcdefgh " * 2_222,
        "a." * 10_000,
        "tata​motors ltd " * 1_000,
    ],
    ids=["M/S", "m/s a", "a", "A&", "Ab (P)", "absorb", "words", "a.", "zwsp"],
)
def test_pseudonymize_stays_linear_on_worst_inputs(text):
    text = text[: gateway.DEFAULT_MAX_LENGTH]
    start = time.perf_counter()
    pseudonymize(text)
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms on {len(text)} chars"
