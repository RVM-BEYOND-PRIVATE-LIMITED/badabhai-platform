"""Issue #1875 — an employer written in CAPITALS is masked; shouted ordinary speech is not.

THE GAP, measured on main before the fix: `_COMPANY_SUFFIX` is case-sensitive, so

    pseudonymize("  TATA MOTORS LTD").text            -> "  TATA MOTORS LTD"   (0 masked)
    certified_clean_skill_labels(["TATA MOTORS LTD"])  -> ["TATA MOTORS LTD"]   (kept as a skill)

THE RULE (`pseudonymize._EMPLOYER_CAPS_RE`, documented above `_CORPORATE_FORM_CAPS`): in capitals a
span is an employer only when it ENDS in a corporate form (LTD, LIMITED, PVT, CORP, CORPORATION,
INDUSTRIES, ENTERPRISES, LLP, LLC, W.L.L, and — guarded — PRIVATE, COMPANY, INDUSTRY, CO). A trade
word (STEEL, AUTO, PRECISION …) never ends one, because in capitals it is ordinary shouted speech
("MAIN STEEL PLANT MEIN THA"). It runs AFTER the title-case rule and both name rules, on their
output (rule 4b in `_mask`), so title-case and name-rule behaviour is byte-identical to main.

Each section below was seen to FAIL against at least one mutation of the rule: the rule removed;
the dash guard on every form, or on none; the CO compound list removed; trade words allowed to end
a span; the rule folded into `_COMPANY_SUFFIX` as an alternation; joiners removed; the 7-digit
refusal removed; the word unbounded; INC put back; a six-word window; the rule moved back ahead of
the name rules. Stdlib + pytest only, like `test_pseudonymize.py`. All inputs are fabricated.
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
#: The passes #1892 added after this rule (`tests/test_pseudonymize_employer_residuals.py`). The
#: "main" this file compares with is the gateway before #1875, so they are switched off with it.
_RULES_1892 = (
    "_EMPLOYER_LONG_RE",
    "_EMPLOYER_TITLE_FORM_RE",
    "_EMPLOYER_LOWER_RE",
    "_EMPLOYER_MS_CUE_RE",
    "_EMPLOYER_ABSORB_RE",
)


@pytest.fixture
def main_gateway(monkeypatch):
    """The gateway as on main before #1875: the capitals rule and #1892's later passes switched
    off, nothing else touched.

    Sound because each is a SEPARATE pass that runs after the title-case rule and both name rules —
    with them matching nothing, every other rule sees byte-identical input. Measured against the
    real main module over the 31,907-string corpus: 0 outputs differ."""

    def run(fn, *args):
        with monkeypatch.context() as patch:
            for name in ("_EMPLOYER_CAPS_RE", *_RULES_1892):
                patch.setattr(gateway, name, _NEVER)
            return fn(*args)

    return run


# --- 1. the issue's regressions, and the shapes around them -------------------------------


@pytest.mark.parametrize(
    ("text", "expected", "leaked"),
    [
        # The three regressions the issue names.
        ("TATA MOTORS LTD", "[EMPLOYER_1]", ("TATA", "MOTORS")),
        ("BHARAT FORGE LIMITED", "[EMPLOYER_1]", ("BHARAT", "FORGE")),
        # Already masked on main (the title-case "Pvt"/"Ltd" carry it) — pinned so it stays so.
        ("Tata MOTORS Pvt Ltd", "[EMPLOYER_1]", ("Tata", "MOTORS")),
        # A trade word still counts INSIDE a capitals name; it just cannot END one.
        ("XYZ ENGINEERING WORKS PVT LTD", "[EMPLOYER_1]", ("XYZ", "ENGINEERING", "WORKS")),
        ("SHREE GANESH INDUSTRIES", "[EMPLOYER_1]", ("SHREE", "GANESH")),
        ("Tata MOTORS LTD", "[EMPLOYER_1]", ("Tata", "MOTORS")),
        # Every corporate form, and the dotted abbreviations (the dot is left, as in title case).
        ("SHREE BALAJI PRIVATE", "[EMPLOYER_1]", ("SHREE", "BALAJI")),
        ("JYOTI CNC PVT", "[EMPLOYER_1]", ("JYOTI",)),
        ("XYZ PVT. LTD.", "[EMPLOYER_1].", ("XYZ",)),
        ("RAMA TOOLS CO.", "[EMPLOYER_1].", ("RAMA",)),
        ("RAMA TOOLS CO", "[EMPLOYER_1]", ("RAMA",)),
        ("ACME CORP.", "[EMPLOYER_1].", ("ACME",)),
        ("MUNICIPAL CORPORATION", "[EMPLOYER_1]", ("MUNICIPAL",)),
        ("MARUTI COMPANY", "[EMPLOYER_1]", ("MARUTI",)),
        ("GANESH INDUSTRY", "[EMPLOYER_1]", ("GANESH",)),
        ("SHREE ENTERPRISES", "[EMPLOYER_1]", ("SHREE",)),
        ("ACME LLP", "[EMPLOYER_1]", ("ACME",)),
        ("Acme LLP", "[EMPLOYER_1]", ("Acme",)),
        # The Gulf forms a migrant worker's history carries.
        ("AL FUTTAIM LLC", "[EMPLOYER_1]", ("FUTTAIM",)),
        ("XYZ CONTRACTING W.L.L", "[EMPLOYER_1]", ("XYZ", "CONTRACTING")),
        # Joiners: a bare "&" and the Indian "(P)" / "(I)" / "(INDIA)" / "(OPC)" abbreviations.
        # Each was raw or half-raw before (`LARSEN & [EMPLOYER_1]`, "XYZ (P) LTD" certified clean).
        ("SHARMA & CO.", "[EMPLOYER_1].", ("SHARMA",)),
        ("SHARMA & CO", "[EMPLOYER_1]", ("SHARMA",)),
        ("LARSEN & TOUBRO LIMITED", "[EMPLOYER_1]", ("LARSEN", "TOUBRO")),
        ("MAHINDRA & MAHINDRA LTD", "[EMPLOYER_1]", ("MAHINDRA",)),
        ("L & T LTD", "[EMPLOYER_1]", ("L & T",)),
        ("J.K. TYRE & INDUSTRIES LTD", "[EMPLOYER_1]", ("J.K.", "TYRE")),
        ("XYZ (P) LTD", "[EMPLOYER_1]", ("XYZ",)),
        ("ABC ENGINEERS (P) LTD.", "[EMPLOYER_1].", ("ABC", "ENGINEERS")),
        ("ABC ENGINEERS (I) PVT. LTD.", "[EMPLOYER_1].", ("ABC", "ENGINEERS")),
        ("XYZ ENGINEERING (INDIA) PVT LTD", "[EMPLOYER_1]", ("XYZ", "ENGINEERING")),
        ("XYZ (OPC) PVT LTD", "[EMPLOYER_1]", ("XYZ",)),
        # A joiner does not count toward the four name words.
        ("SHREE GANESH AUTO COMPONENTS (P) LTD", "[EMPLOYER_1]", ("SHREE", "GANESH")),
        # Digit-led and dash-joined name words.
        ("3M INDIA LTD", "[EMPLOYER_1]", ("3M", "INDIA")),
        ("24X7 SECURITY SERVICES PVT LTD", "[EMPLOYER_1]", ("24X7", "SECURITY")),
        ("TATA-MOTORS LTD", "[EMPLOYER_1]", ("TATA",)),
        ("WARANA CO-OPERATIVE SUGAR MILLS LTD", "[EMPLOYER_1]", ("WARANA", "SUGAR")),
    ],
)
def test_an_all_caps_employer_is_masked(text, expected, leaked):
    result = pseudonymize(text)
    assert result.blocked is False
    assert result.text == expected
    assert result.replaced_entities == 1
    assert result.placeholder_tokens == ["[EMPLOYER_1]"]
    for word in leaked:
        assert word not in result.text


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # A dash after a form that never compounds is a place or a unit (detail 2). Title case
        # already masks "Tata Motors Ltd-Pune" on main.
        ("BHARAT FORGE LTD-CHAKAN", "[EMPLOYER_1]-CHAKAN"),
        ("TATA MOTORS LIMITED-PUNE", "[EMPLOYER_1]-PUNE"),
        ("XYZ CORPORATION-PUNE", "[EMPLOYER_1]-PUNE"),
        ("XYZ INDUSTRIES-UNIT 3", "[EMPLOYER_1]-UNIT 3"),
        ("XYZ ENGINEERING PVT-LTD", "[EMPLOYER_1]-LTD"),
        ("TATA MOTORS LTD–PUNE", "[EMPLOYER_1]–PUNE"),  # en dash
        # CO's compound list is CLOSED (detail 3): these are still employers.
        ("XYZ & CO OPERATIONS MANAGER", "[EMPLOYER_1] OPERATIONS MANAGER"),
        ("SHARMA & CO 2 SAAL", "[EMPLOYER_1] 2 SAAL"),
        # A line break is no compound.
        ("SHARMA & CO\nOPERATION HEAD", "[EMPLOYER_1]\nOPERATION HEAD"),
    ],
)
def test_a_corporate_form_followed_by_a_place_or_a_word_still_masks(text, expected):
    result = pseudonymize(text)
    assert (result.text, result.blocked, result.replaced_entities) == (expected, False, 1)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("  TATA MOTORS LTD", "  [EMPLOYER_1]"),  # the exact string in the issue
        ("TATA MOTORS LTD  ", "[EMPLOYER_1]  "),
        ("\tTATA MOTORS LTD\n", "\t[EMPLOYER_1]\n"),
        ("   BHARAT FORGE LIMITED   ", "   [EMPLOYER_1]   "),
    ],
)
def test_surrounding_whitespace_is_kept_and_the_employer_masked(text, expected):
    result = pseudonymize(text)
    assert (result.text, result.blocked, result.replaced_entities) == (expected, False, 1)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("main TATA MOTORS LTD mein tha", "main [EMPLOYER_1] mein tha"),
        ("pehle BHARAT FORGE LIMITED, phir Pune", "pehle [EMPLOYER_1], phir Pune"),
        ("5 saal XYZ ENGINEERING WORKS PVT LTD mein", "5 saal [EMPLOYER_1] mein"),
        ("XYZ PVT LTD AUR ABC PVT LTD", "[EMPLOYER_1] [EMPLOYER_2]"),
        # A capitals employer beside a title-case one: both mask, each to its own token.
        (
            "TATA MOTORS LTD ke baad Bajaj Auto Ltd",
            "[EMPLOYER_2] ke baad [EMPLOYER_1]",  # title-case pass runs first, so mints first
        ),
    ],
)
def test_an_all_caps_employer_is_masked_inside_a_sentence(text, expected):
    result = pseudonymize(text)
    assert result.blocked is False
    assert result.text == expected


def test_the_same_capitals_employer_shares_one_token_under_a_scope():
    scope = TokenScope()
    message = pseudonymize("TATA MOTORS LTD chhoda, phir TATA MOTORS LTD wapas", scope=scope)
    assert message.text == "[EMPLOYER_1] chhoda, phir [EMPLOYER_1] wapas"
    assert message.replaced_entities == 1
    assert message.placeholder_tokens == ["[EMPLOYER_1]"]
    # The stored value spelled in title case is the SAME employer (equality is strip().lower()),
    # so the companion edit parser (ADR-0046) can match the message to the employment row.
    stored = pseudonymize("Tata Motors Ltd", scope=scope)
    assert stored.text == "[EMPLOYER_1]"
    other = pseudonymize("BHARAT FORGE LIMITED", scope=scope)
    assert other.text == "[EMPLOYER_2]"


# --- 2. NEGATIVE: shouted ordinary speech is not an employer --------------------------------

#: Every TRADE word of `_COMPANY_SUFFIX` (the title-case list minus its corporate forms), each in
#: suffix position — after a capitalised word — in a shouted sentence a worker could type.
_SHOUTED_ORDINARY = [
    "MAIN STEEL PLANT MEIN THA",
    "MAIN AUTO CHALATA HOON",
    "CNC PRECISION WORK KARTA HOON",
    "MAIN CUTTING TOOLS KA SETTING KARTA HOON",
    "ITI KE BAAD MECHANICAL ENGINEERING KI",
    "HUM DO ENGINEERS THE SHIFT MEIN",
    "BIKE MOTORS KI REPAIR KARTA HOON",
    "SHEET METAL FABRICATION AUR FAB KA KAAM",
    "HOT FORGINGS AUR CASTINGS KI GRINDING",
    "NAYI TECHNOLOGIES SEEKHNA HAI",
    "CNC TECHNOLOGY PE 5 SAAL",
    "AUTO TECH WALA KAAM",
    "QUALITY SOLUTIONS DENA MERA KAAM HAI",
    "AUTOMOBILE MANUFACTURING MEIN 3 SAAL",
    "PIPE FITTING WORKS KARTA HOON",
    # A dash after PRIVATE / COMPANY / INDUSTRY / CO makes a compound (detail 2), any dash.
    "QUALITY CO-ORDINATOR HOON",
    "MERA CO-WORKER BHI AAYEGA",
    "PEHLE PRIVATE-SECTOR MEIN THA",
    "PEHLE PRIVATE–SECTOR MEIN THA",  # en dash
    "QUALITY CO–ORDINATOR",  # en dash
    "QUALITY CO‐ORDINATOR",  # U+2010 hyphen
    "QUALITY CO‑ORDINATOR",  # U+2011 non-breaking hyphen
    "AUTO INDUSTRY-READY HOON",
    "HAMARI COMPANY-PAID ROOM MILTA HAI",
    # CO compounds across a space or a dot too (detail 3) — each masked before the closed list.
    "QUALITY CO ORDINATOR",
    "PRODUCTION CO ORDINATION",
    "SKILL INDIA CO ORDINATOR",
    "WORK CO ORDINATE SETTING",
    "G54 WORK CO ORDINATE SYSTEM",
    "OPERATING CO ORDINATE MEASURING MACHINE",
    "QUALITY CO.ORDINATOR",
    "THANKS FOR YOUR CO OPERATION",
    "PLEASE CO OPERATE SIR",
    "WARANA CO OPERATIVE MEIN THA",
    "SHIVAJI NAGAR PUNE CO OP SOCIETY",  # and the city with it, against the 2026-07-31 ruling
    "MERA CO WORKER BHI AAYEGA",
    "EXTRA CO CURRICULAR ACTIVITIES",
    "MIG CO 2 WELDING",
    "MIG CO 2 GAS SE WELDING",
    # CO2 is a welding process, not "CO".
    "CO2 WELDING KARTA HOON",
    "MIG CO2 WELDER",
    # INC is pay talk — incentive, including — not a corporate form.
    "OT AUR INC MILTA THA",
    "CTC 3 LPA INC. PF",
    "SALARY 15000 PLUS OT AND INC",
    # "&" alone is not a form.
    "TOM & JERRY KO DEKHA",
]

_CORPORATE_TITLE_FORMS = {
    "Industries",
    "Industry",
    "Pvt",
    "Private",
    "Ltd",
    "Limited",
    "Company",
    "Co",
    "Corp",
    "Corporation",
    "Enterprises",
}


def _trade_suffixes() -> set[str]:
    words = set(re.findall(r"[A-Za-z]+", gateway._COMPANY_SUFFIX))
    assert _CORPORATE_TITLE_FORMS <= words  # the split below is still the split of the real list
    return words - _CORPORATE_TITLE_FORMS


def test_the_negative_set_covers_every_trade_suffix_in_suffix_position():
    # Guards the guard: a trade word added to `_COMPANY_SUFFIX` must get a shouted negative case.
    trade = _trade_suffixes()
    assert len(trade) == 17
    for word in trade:
        shape = re.compile(r"\b[A-Z][\w&.]*\s+" + word.upper() + r"\b")
        assert any(shape.search(s) for s in _SHOUTED_ORDINARY), word


@pytest.mark.parametrize("text", _SHOUTED_ORDINARY)
def test_a_shouted_ordinary_sentence_is_not_masked(text):
    result = pseudonymize(text)
    assert result.blocked is False
    assert result.text == text
    assert result.replaced_entities == 0


@pytest.mark.parametrize(
    "text",
    [
        "STAINLESS STEEL",
        "DIPLOMA MECHANICAL ENGINEERING",
        "VMC TOOLS",
        "QUALITY CO ORDINATOR",
        "MIG CO 2 WELDING",
        "CO ORDINATE MEASURING MACHINE",
    ],
)
def test_a_shouted_skill_label_survives_every_clean_or_withhold_wall(text):
    # The cost of over-firing, refused: these would mask as [EMPLOYER_1], and `is_certified_clean`
    # (polish role gate, gate 6) would withhold them.
    assert is_certified_clean(text) is True
    assert certify_value(text) == (False, text)
    assert certified_clean_skill_labels([text]) == [text]


@pytest.mark.parametrize("text", ["QUALITY CO­ORDINATOR", "MERA CO​WORKER BHI"])
def test_an_invisible_inside_a_co_compound_does_not_block(text):
    # The #1738 spaced view turns the invisible into a space: "QUALITY CO ORDINATOR". Without the
    # compound list it masked there — over offsets the reader view left raw — and the gateway
    # BLOCKED an ordinary role. It passes, as on main.
    result = pseudonymize(text)
    assert result.blocked is False
    assert result.replaced_entities == 0


# --- 3. title case is untouched -------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Tata Steel Ltd", "[EMPLOYER_1]"),
        ("worked at ABC Industries in Faridabad", "worked at [EMPLOYER_1] in Faridabad"),
        ("Tata Motors Ltd-Pune", "[EMPLOYER_1]-Pune"),
        # The title-case over-fires stay exactly as on main (`certified_clean_skill_labels`).
        ("Stainless Steel", "[EMPLOYER_1]"),
        ("Diploma Mechanical Engineering", "[EMPLOYER_1]"),
        ("Quality Co-ordinator", "[EMPLOYER_1]-ordinator"),
        ("Quality Co ordinator", "[EMPLOYER_1] ordinator"),
        # No title-case "Inc" — not added here.
        ("Acme Inc", "Acme Inc"),
        # (The title-case match keeps its span, and this rule left the trailing capitals form
        # beside its token, "Tata Motors LTD" -> "[EMPLOYER_1] LTD"; #1892's absorb pass now folds
        # it in, pinned in test_pseudonymize_employer_residuals.py.)
        # ORDER PIN. Folded into `_COMPANY_SUFFIX` as an alternation, the capitals form would win
        # here and leave "Steel" raw: "[EMPLOYER_1] Steel".
        ("Om Sai Ram Krishna LTD Steel", "Om [EMPLOYER_1]"),
        ("Main Private Company mein tha", "[EMPLOYER_1] mein tha"),
    ],
)
def test_title_case_masking_is_byte_identical_to_main(text, expected, main_gateway):
    assert pseudonymize(text).text == expected
    assert pseudonymize(text) == main_gateway(pseudonymize, text)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # Security review F2. Ahead of the name rules the capitals rule ATE THE CUE and the name
        # egressed: "[EMPLOYER_1] Ramesh", "[EMPLOYER_1] RAMESH", "[EMPLOYER_1] Ramesh Kumar".
        ("MY NAME IS CO Ramesh", "MY NAME IS [PERSON_1]"),
        ("MERA NAAM PVT RAMESH", "MERA NAAM [PERSON_1]"),
        # The cue takes two words, so main leaves "Kumar" raw here; the pin is "exactly main".
        ("I AM LIMITED Ramesh Kumar", "I AM [PERSON_1] Kumar"),
    ],
)
def test_a_name_cue_before_a_capitals_form_masks_the_name_exactly_as_on_main(
    text, expected, main_gateway
):
    result = pseudonymize(text)
    assert (result.text, result.blocked) == (expected, False)
    assert result == main_gateway(pseudonymize, text)
    assert "Ramesh" not in result.text and "RAMESH" not in result.text


@pytest.mark.parametrize(
    ("text", "main_text", "expected"),
    [
        # Main masks the name and leaves the employer; the branch masks both. Before the reorder
        # the first gave "MERA NAAM [EMPLOYER_1]" — RAMESH swallowed into the employer span.
        (
            "MERA NAAM RAMESH HAI TATA MOTORS LTD",
            "MERA NAAM [PERSON_1] TATA MOTORS LTD",
            "MERA NAAM [PERSON_1] [EMPLOYER_1]",
        ),
        (
            "NAAM Ramesh TATA MOTORS LTD",
            "NAAM [PERSON_1] MOTORS LTD",
            "NAAM [PERSON_1] [EMPLOYER_1]",
        ),
        (
            "MY NAME IS Ramesh, TATA MOTORS LTD",
            "MY NAME IS [PERSON_1], TATA MOTORS LTD",
            "MY NAME IS [PERSON_1], [EMPLOYER_1]",
        ),
    ],
)
def test_a_name_cue_and_a_capitals_employer_both_mask(text, main_text, expected, main_gateway):
    assert main_gateway(pseudonymize, text).text == main_text
    result = pseudonymize(text)
    assert (result.text, result.blocked) == (expected, False)
    assert sorted(result.placeholder_tokens) == ["[EMPLOYER_1]", "[PERSON_1]"]


_TITLE = ["Tata", "Bharat", "Om", "Sai", "Shree", "Ganesh", "Main", "Xyz", "Ramesh"]
_CAPS = [w.upper() for w in _TITLE]
_SUFFIX_WORDS = sorted(set(re.findall(r"[A-Za-z]+", gateway._COMPANY_SUFFIX)))
_FORMS = [
    "LTD", "LTD.", "LIMITED", "PVT", "PRIVATE", "CO", "CORP", "COMPANY", "INDUSTRIES", "LLP", "LLC",
    "LTD-PUNE", "CO-ORDINATOR", "INC",
]  # fmt: skip
_JOINED = ["&", "(P)", "(I)", "3M", "TATA-MOTORS", "J.K."]
#: Words that make main BLOCK (7-8 digits out of salary range) or mask money (in range).
_DIGITS = ["X12345678", "TM12345678", "AB1234567", "12345678"]
_LOWER = ["mein", "tha", "aur", "se", "ke", "baad", ",", "5", "ORDINATOR", "OP", "2", "WELDING"]
#: Every cue `_NAME_CUE_RE` reads that a worker types in capitals, and the same in lower case.
_CUES = ["MY NAME IS", "MERA NAAM", "MYSELF", "I AM", "NAAM"]
#: Characters the reader view DELETES and the spaced view turns into a space (#1738): zero-width
#: space, zero-width non-joiner, word joiner, soft hyphen. `_sample` glues each to its neighbours,
#: so it is the SOLE separator between two words — the shape where the two views disagree.
_INVISIBLES = ["​", "‌", "⁠", "­"]
_POOLS = [
    _TITLE,
    _CAPS,
    _SUFFIX_WORDS,
    [w.upper() for w in _SUFFIX_WORDS],
    _FORMS,
    _JOINED,
    _DIGITS,
    _LOWER,
    _CUES + [c.lower() for c in _CUES],
    _INVISIBLES,
]
_ANY_CAPITALS_FORM = re.compile(r"\b" + gateway._CORPORATE_FORM_CAPS + r"\b")


def _sample(rng: random.Random) -> str:
    parts = [rng.choice(rng.choice(_POOLS)) for _ in range(rng.randint(1, 9))]
    text = parts[0]
    for previous, part in pairwise(parts):
        text += ("" if previous in _INVISIBLES or part in _INVISIBLES else " ") + part
    return text


def _raw_words(text: str) -> Counter[str]:
    return Counter(re.findall(r"[^\W_]+", re.sub(r"\[[A-Z]+_\d+\]", " ", text)))


def _a_later_pass_may_change(text: str, main_text: str) -> bool:
    """Could #1892's passes move this text's output? Only when one of their gates opens on it, or
    main's output holds an employer token for the absorb pass to fold something into."""
    return "[EMPLOYER_" in main_text or any(
        gate.search(text) for _rule, gate in gateway._RULE_GATES.values()
    )


def _two_view_verdict(text: str) -> str:
    """How #1738's two-view check in `pseudonymize` treats ``text`` on the module as it stands.

    "blocks"  — a view's residual guard trips, or a spaced-view region overlaps no reader mask.
    "full"    — it passes, and every offset of every spaced-view region that the reader view KEPT
                (did not delete) is reader-masked: nothing the spaced view found egresses raw.
    "partial" — it passes although a spaced-view region holds a kept offset the reader view left
                raw; the region merely OVERLAPS a reader mask. That is R49 (#1890): under its
                mitigation (covered only if every kept offset is reader-masked) it would block.
    """
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


def test_property_the_capitals_rule_only_ever_adds_masking(main_gateway):
    """What this PROVES, exactly — over 4,000 samples of THIS seeded generator, not over all inputs.

    The pools: title-case and capitals names, every `_COMPANY_SUFFIX` word in both cases, the
    capitals forms and their compounds, joiners, digit words main blocks on or masks as money,
    Hinglish fillers, the five name cues (MY NAME IS, MERA NAAM, MYSELF, I AM, NAAM) in capitals
    and lower case, and four invisible characters (U+200B, U+200C, U+2060, U+00AD) glued in as the
    SOLE separator between two words.

    "Main" is the gateway before this rule (the `main_gateway` fixture); since #1892 the branch
    carries #1892's later passes too, so the byte-identity clauses below also require that none of
    them could act (`_a_later_pass_may_change`). The rest holds for the whole stack.

    1. IN EACH VIEW (#1738's reader and spaced view, through `_mask`): every region main masked is
       masked over exactly the same source offsets — so the rule never shortens a title-case match
       and never eats a name cue — no word main masked is left raw, every residual-digit block
       main raised is still raised, and with no capitals corporate form in the view (and nothing
       for #1892) the result and its regions are byte-identical to main's. No exception.
    2. END TO END (`pseudonymize`): the same — no word main masked is left raw, every block main
       raised is still raised, no form in either view means byte-identical — EXCEPT where main
       blocked on the two-view check and the branch passes. That happens two ways, and each such
       turn is asserted to be one of them (`_two_view_verdict`):
       a. "full": the branch's reader view now masks every kept offset its spaced view masked, so
          the check, as designed, has nothing to block on and nothing either view found egresses
          raw. Main refused the whole turn; the branch releases it with every found span masked,
          and each word it releases was raw in main's reader view too (by 1). Measured 2026-10-01:
          18 of the 4,000.
       b. "partial": a spaced-view region merely OVERLAPS a reader mask and a kept offset of it
          egresses raw. That is R49 (#1890), pre-existing on main with title-case suffixes.
          Measured 2026-10-01: 10 of the 4,000 (11 with the rule ahead of the name rules). Pinned
          on its own by
          `test_KNOWN_RESIDUAL_a_name_hidden_by_an_invisible_beside_a_capitals_form_egresses`.

    What it does NOT prove: anything outside these pools (other cues, other invisibles, other
    scripts), or that the masking is CORRECT — only how it compares with main's. The construction
    (rule 4b runs after every rule that could compete with it, and refuses a 7+ digit run) is the
    argument; this catches it being undone. The floors at the end show each part was exercised."""
    rng = random.Random(1875)
    seen: Counter[str] = Counter()
    for _ in range(4_000):
        text = _sample(rng)
        for view in gateway._build_views(text):
            new_view, new_regions = gateway._mask(view, True)
            old_view, old_regions = main_gateway(gateway._mask, view, True)
            assert old_view.blocked <= new_view.blocked, text
            assert all(region in new_regions for region in old_regions), (text, view.text)
            assert not (_raw_words(new_view.text) - _raw_words(old_view.text)), (text, view.text)
            if not _ANY_CAPITALS_FORM.search(view.text) and not _a_later_pass_may_change(
                view.text, old_view.text
            ):
                assert (new_view, new_regions) == (old_view, old_regions), text
        new, old = pseudonymize(text), main_gateway(pseudonymize, text)
        seen["main blocked"] += old.blocked
        seen["main two-view block"] += old.blocked_reason == gateway._INVISIBLE_BYPASS_REASON
        seen["cue beside a capitals form"] += bool(
            "[PERSON_" in old.text and _ANY_CAPITALS_FORM.search(text)
        )
        if old.blocked and not new.blocked:
            assert old.blocked_reason == gateway._INVISIBLE_BYPASS_REASON, text
            verdict = _two_view_verdict(text)
            assert verdict in ("full", "partial"), (text, verdict)
            seen[f"unblocked, {verdict}"] += 1
            continue
        assert old.blocked <= new.blocked, text
        assert not (_raw_words(new.text) - _raw_words(old.text)), (text, old.text, new.text)
        views = gateway._build_views(text)
        if not any(_ANY_CAPITALS_FORM.search(v.text) for v in views) and not any(
            _a_later_pass_may_change(v.text, old.text) for v in views
        ):
            assert new == old, text  # nothing for the capitals rule or #1892 -> byte-identical
    assert seen["main blocked"] > 600, seen
    assert seen["main two-view block"] > 70, seen
    assert seen["cue beside a capitals form"] > 200, seen


# --- 4. the stated boundary, both directions --------------------------------------------------


@pytest.mark.parametrize(
    ("text", "title_case_twin"),
    [
        ("MAIN PRIVATE COMPANY MEIN THA", "Main Private Company mein tha"),
        ("MERA LIMITED EXPERIENCE HAI", "Mera Limited experience hai"),
        ("MAINE GANESH INDUSTRIES MEIN KAAM KIYA", "Maine Ganesh Industries mein kaam kiya"),
    ],
)
def test_ACCEPTED_a_shouted_corporate_word_over_masks_exactly_like_its_title_case_twin(
    text, title_case_twin
):
    # A corporate word used as ordinary speech masks, in capitals as in title case, and the span
    # takes the same four words. Over-masking an identity class is the safe direction; narrowing
    # PRIVATE/COMPANY/INDUSTRY as END forms is a privacy decision recorded at
    # `_CORPORATE_FORM_CAPS`, not taken here.
    shouted, titled = pseudonymize(text), pseudonymize(title_case_twin)
    assert shouted.text.upper() == titled.text.upper()
    assert "[EMPLOYER_1]" in shouted.text


@pytest.mark.parametrize(
    "text",
    [
        "MAIN TATA MOTORS MEIN THA",
        "BAJAJ AUTO",
        "JYOTI CNC",
        "GUPTA & SONS",
    ],
)
def test_KNOWN_RESIDUAL_an_all_caps_employer_without_a_corporate_form_is_not_masked(text):
    # The price of not masking "MAIN STEEL PLANT MEIN THA": with no corporate form, a capitals
    # employer is indistinguishable from shouted trade speech. If this starts masking, the
    # boundary moved — re-run the over-mask measurement and update the register (R48). An M/S firm
    # ("M/S SHARMA TRADERS") left this list with #1892's cue rule.
    result = pseudonymize(text)
    assert result.text == text
    assert result.replaced_entities == 0


@pytest.mark.parametrize(
    ("text", "expected", "why"),
    [
        ("ACME INC", "ACME INC", "INC is pay talk here, not a form"),
        ("AL KHALEEJ EST.", "AL KHALEEJ EST.", "EST. is also 'estimated'"),
        ("MARUTI COMPANY-PUNE", "MARUTI COMPANY-PUNE", "a dash after a guarded form"),
    ],
)
def test_KNOWN_RESIDUAL_stated_under_masking(text, expected, why):
    # Each is recorded as a residual in risks-register R48 and docs/ai/pseudonymization.md. If one
    # of these starts masking, the boundary moved: re-measure and update both. The lower-case
    # ("tata motors ltd"), 5+ word and title-case-twin ("Sharma & Co.", "Xyz (P) Ltd", "Acme Llp")
    # rows left this list with #1892: test_pseudonymize_employer_residuals.py.
    assert pseudonymize(text).text == expected, why


@pytest.mark.parametrize(
    ("text", "leaked"),
    [
        ("my name is​Ramesh Kumar CO", "my name isRamesh [EMPLOYER_1]"),
        ("my name is​Ramesh Kumar LTD", "my name isRamesh [EMPLOYER_1]"),
        ("mera naam​Ramesh Kumar PVT LTD", "mera naamRamesh [EMPLOYER_1]"),
    ],
)
def test_KNOWN_RESIDUAL_a_name_hidden_by_an_invisible_beside_a_capitals_form_egresses(
    text, leaked, main_gateway
):
    """R49 / #1890 — pre-existing in #1738's two-view check, NOT fixed here (security review F1).

    The reader view deletes the U+200B and merges "isRamesh", so the cue misses and the capitals
    rule masks "Kumar CO". The spaced view masks "Ramesh Kumar" as a name. `pseudonymize` counts
    the spaced region as covered because it OVERLAPS the reader mask on "Kumar", so the turn
    passes with "Ramesh" raw. Main BLOCKED it: no reader mask to overlap. If this starts blocking,
    R49 is fixed — turn this into a blocking pin and close R49 / #1890."""
    assert main_gateway(pseudonymize, text).blocked_reason == gateway._INVISIBLE_BYPASS_REASON
    result = pseudonymize(text)
    assert (result.text, result.blocked) == (leaked, False)
    assert _two_view_verdict(text) == "partial"


def test_KNOWN_RESIDUAL_r49_predates_the_capitals_rule(main_gateway):
    # Main passes the title-case twin the same way: "Kumar Steel" is the reader mask "Ramesh
    # Kumar" overlaps. The capitals rule extends the shape to the capitals forms; it did not
    # create it (R49, #1890).
    text = "my name is​Ramesh Kumar Steel"
    result = main_gateway(pseudonymize, text)
    assert (result.text, result.blocked) == ("my name isRamesh [EMPLOYER_1]", False)
    assert main_gateway(_two_view_verdict, text) == "partial"
    assert pseudonymize(text) == result


# --- 5. fail-closed and the certifiers --------------------------------------------------------


@pytest.mark.parametrize("text", ["TATA MOTORS​LTD", "TATA MOTORS­LTD"])
def test_an_invisible_separator_before_the_corporate_form_fails_closed(text):
    # The reader view merges "MOTORS<ZWSP>LTD" into one word, so it cannot mask; the spaced view
    # masks the employer — over source offsets the reader left raw — so the gateway BLOCKS
    # (#1738 F1). Without the capitals rule neither view masks and the employer egresses.
    result = pseudonymize(text)
    assert result.blocked is True
    assert result.text == ""
    assert result.blocked_reason == gateway._INVISIBLE_BYPASS_REASON


@pytest.mark.parametrize(
    "text", ["X12345678 LTD", "EMP CODE TM12345678 AT TATA MOTORS LTD", "TM-12345678 TATA LTD"]
)
def test_a_turn_main_blocks_on_its_digits_still_blocks(text, main_gateway):
    # Detail 4. In capitals every word is a name word; without the 7-digit refusal the run was
    # swallowed into [EMPLOYER_1], the residual net never saw it, and the walls that read
    # `.blocked` as their refusal passed text main refused.
    assert main_gateway(pseudonymize, text).blocked is True
    result = pseudonymize(text)
    assert result.blocked is True
    assert result.blocked_reason == "residual numeric sequence detected"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("AB1234567 LTD", "AB[AMOUNT_1] LTD"),  # exactly main's output
        ("AB1234567 TATA MOTORS LTD", "AB[AMOUNT_1] [EMPLOYER_1]"),
    ],
)
def test_an_in_range_amount_glued_to_a_word_is_still_money(text, expected):
    result = pseudonymize(text)
    assert (result.text, result.blocked) == (expected, False)


def test_fullwidth_capitals_are_folded_and_masked():
    result = pseudonymize("ＴＡＴＡ ＭＯＴＯＲＳ ＬＴＤ")
    assert (result.text, result.blocked) == ("[EMPLOYER_1]", False)


def test_a_capitals_employer_no_longer_certifies_clean():
    assert is_certified_clean("TATA MOTORS LTD") is False
    assert certify_value("TATA MOTORS LTD") == (False, "[EMPLOYER_1]")
    assert certified_clean_skill_labels(
        [
            "TATA MOTORS LTD",
            "XYZ ENGINEERING WORKS PVT LTD",
            "SHREE GANESH INDUSTRIES",
            "XYZ (P) LTD",
            "SHARMA & CO.",
            "BHARAT FORGE LTD-CHAKAN",
            "STAINLESS STEEL",
            "Stainless Steel",
            "VMC Operation",
            "CNC PRECISION WORK",
            "QUALITY CO ORDINATOR",
        ]
    ) == [
        "STAINLESS STEEL",
        "Stainless Steel",
        "VMC Operation",
        "CNC PRECISION WORK",
        "QUALITY CO ORDINATOR",
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
    # Every lexicon string (trade, skill, education, certification labels, aliases …) as written,
    # UPPER and Title: the three clean-or-withhold walls decide exactly as on main.
    labels = _lexicon_strings()
    assert len(labels) > 1_000
    for label in sorted({v for s in labels for v in (s, s.upper(), s.title())}):
        for wall in (is_certified_clean, certify_value):
            assert wall(label) == main_gateway(wall, label), (wall.__name__, label)
        assert certified_clean_skill_labels([label]) == main_gateway(
            certified_clean_skill_labels, [label]
        ), label


# --- 6. the work per character is bounded (detail 5) ------------------------------------------

# Generous ceiling, after the `test_egress_gates` precedent. The structural test below is the real
# guard; this one is the backstop. The worst input measured costs 42 ms for this rule alone, but
# 265-330 ms on a loaded laptop — `test_egress_gates`' 250 ms flaked on it. The unbounded first cut
# cost 1,575 ms on "A." * 10000, so 750 ms still fails loudly on a reintroduced quadratic scan.
_REDOS_BUDGET_MS = 750


def test_the_capitals_name_word_is_bounded_and_possessive():
    word = gateway._CAPS_NAME_WORD
    assert "]*" not in word and "]+" not in word  # no unbounded run over the word class
    assert word.endswith(f"{{0,{gateway._CAPS_NAME_WORD_MAX - 5}}}+")


@pytest.mark.parametrize(
    "text",
    [
        "A." * 10_000,  # the measured quadratic: every letter after a "." is a word start
        "A&" * 10_000,
        "A-" * 10_000,
        (("A." * 30) + " ") * 327,  # dotted 60-character words: the worst measured for this rule
        "A & " * 5_000,
        "CO-" * 6_666,
    ],
)
def test_the_capitals_rule_is_not_quadratic(text):
    # The rule alone. `pseudonymize` end to end was still ~1.5 s on "A." * 10000 because of title
    # case's own unbounded `[\w&.]*`; #1891 bounded it, pinned in
    # `test_pseudonymize_title_employer_bound.py`.
    text = text[: gateway.DEFAULT_MAX_LENGTH]
    start = time.perf_counter()
    gateway._EMPLOYER_CAPS_RE.sub("X", text)
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms on {len(text)} chars"
