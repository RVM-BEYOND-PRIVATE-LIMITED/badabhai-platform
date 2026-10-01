"""Issue #1875 — an employer written in CAPITALS is masked; shouted ordinary speech is not.

THE GAP, measured on main before the fix: `_COMPANY_SUFFIX` is case-sensitive, so

    pseudonymize("  TATA MOTORS LTD").text            -> "  TATA MOTORS LTD"   (0 masked)
    certified_clean_skill_labels(["TATA MOTORS LTD"])  -> ["TATA MOTORS LTD"]   (kept as a skill)

THE RULE (`pseudonymize._EMPLOYER_CAPS_RE`, documented above `_CORPORATE_FORM_CAPS`): in capitals a
span is an employer only when it ENDS in a corporate form (LTD, LIMITED, PVT, CORP, CORPORATION,
INDUSTRIES, ENTERPRISES, LLP, LLC, W.L.L, and — guarded — PRIVATE, COMPANY, INDUSTRY, CO). A trade
word (STEEL, AUTO, PRECISION …) never ends one, because in capitals it is ordinary shouted speech
("MAIN STEEL PLANT MEIN THA"). It runs AFTER the title-case rule, on its output, so title-case
behaviour is byte-identical to main.

Each section below was seen to FAIL against at least one mutation of the rule: the rule removed;
the dash guard on every form, or on none; the CO compound list removed; trade words allowed to end
a span; the rule folded into `_COMPANY_SUFFIX` as an alternation; joiners removed; the 7-digit
refusal removed; the word unbounded; INC put back; a six-word window. Stdlib + pytest only, like
`test_pseudonymize.py`. All inputs are fabricated.
"""

from __future__ import annotations

import json
import random
import re
import time
from collections import Counter
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


@pytest.fixture
def main_gateway(monkeypatch):
    """The gateway exactly as on main: the capitals rule switched off, nothing else touched.

    Sound because the capitals rule is a SEPARATE pass that runs after the title-case rule — with
    it matching nothing, every other rule sees byte-identical input."""

    def run(fn, *args):
        with monkeypatch.context() as patch:
            patch.setattr(gateway, "_EMPLOYER_CAPS_RE", _NEVER)
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
        # The title-case match keeps its span; the capitals rule runs on its OUTPUT, so the
        # trailing capitals form beside a token is left exactly as main leaves it.
        ("Tata Motors LTD", "[EMPLOYER_1] LTD"),
        # ORDER PIN. Folded into `_COMPANY_SUFFIX` as an alternation, the capitals form would win
        # here and leave "Steel" raw: "[EMPLOYER_1] Steel".
        ("Om Sai Ram Krishna LTD Steel", "Om [EMPLOYER_1]"),
        ("Main Private Company mein tha", "[EMPLOYER_1] mein tha"),
    ],
)
def test_title_case_masking_is_byte_identical_to_main(text, expected, main_gateway):
    assert pseudonymize(text).text == expected
    assert pseudonymize(text) == main_gateway(pseudonymize, text)


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
_POOLS = [
    _TITLE,
    _CAPS,
    _SUFFIX_WORDS,
    [w.upper() for w in _SUFFIX_WORDS],
    _FORMS,
    _JOINED,
    _DIGITS,
    _LOWER,
]
_ANY_CAPITALS_FORM = re.compile(r"\b" + gateway._CORPORATE_FORM_CAPS + r"\b")


def _sample(rng: random.Random) -> str:
    return " ".join(rng.choice(rng.choice(_POOLS)) for _ in range(rng.randint(1, 9)))


def _raw_words(text: str) -> Counter[str]:
    return Counter(re.findall(r"[^\W_]+", re.sub(r"\[[A-Z]+_\d+\]", " ", text)))


def test_property_the_capitals_rule_only_ever_adds_masking(main_gateway):
    # 4,000 seeded mixed-case runs of names, trade words, corporate forms, joiners, digit words
    # that make main block, and Hinglish fillers. Over THIS generator's pools: every word main
    # masked is still masked, and every turn main blocked still blocks (detail 4). A fixed
    # generator, NOT a proof over all inputs — the construction (a separate pass on the
    # title-case rule's output) is the argument; this would catch it being undone.
    rng = random.Random(1875)
    blocked_by_main = 0
    for _ in range(4_000):
        text = _sample(rng)
        new, old = pseudonymize(text), main_gateway(pseudonymize, text)
        blocked_by_main += old.blocked
        assert old.blocked <= new.blocked, text
        assert not (_raw_words(new.text) - _raw_words(old.text)), (text, old.text, new.text)
        if not _ANY_CAPITALS_FORM.search(text):
            assert new == old, text  # no capitals corporate form -> byte-identical
    assert blocked_by_main > 100  # the block-preservation half is actually exercised


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
    # boundary moved — re-run the over-mask measurement and update the register (R48).
    result = pseudonymize(text)
    assert result.text == text
    assert result.replaced_entities == 0


@pytest.mark.parametrize(
    ("text", "expected", "why"),
    [
        ("tata motors ltd", "tata motors ltd", "lower case: its own over-mask measurement first"),
        ("TATA MOTORS ltd", "TATA MOTORS ltd", "lower-case form"),
        ("ACME INC", "ACME INC", "INC is pay talk here, not a form"),
        ("AL KHALEEJ EST.", "AL KHALEEJ EST.", "EST. is also 'estimated'"),
        ("MARUTI COMPANY-PUNE", "MARUTI COMPANY-PUNE", "a dash after a guarded form"),
        (
            "RAMESH KUMAR SHARMA ENGINEERING WORKS PVT LTD",
            "RAMESH [EMPLOYER_1] LTD",
            "five name words before the form; the window is four",
        ),
        ("Sharma & Co.", "Sharma & Co.", "title case is not touched here"),
        ("Xyz (P) Ltd", "Xyz (P) Ltd", "title case is not touched here"),
        ("Acme Llp", "Acme Llp", "no title-case Llp"),
    ],
)
def test_KNOWN_RESIDUAL_stated_under_masking(text, expected, why):
    # Each is recorded as a residual in risks-register R48 and docs/ai/pseudonymization.md. If one
    # of these starts masking, the boundary moved: re-measure and update both.
    assert pseudonymize(text).text == expected, why


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

# Generous ceiling, the `test_egress_gates` precedent: the worst input measured costs 42 ms for this
# rule alone and the unbounded first cut cost 1,575 ms on "A." * 10000. 250 ms fails loudly on a
# reintroduced quadratic scan and leaves headroom for a slow CI box.
_REDOS_BUDGET_MS = 250


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
    # The rule alone: `pseudonymize` on "A." * 10000 is still ~1.5 s because of title case's own
    # unbounded `[\w&.]*` — recorded in R48, not fixed here (it would touch title case).
    text = text[: gateway.DEFAULT_MAX_LENGTH]
    start = time.perf_counter()
    gateway._EMPLOYER_CAPS_RE.sub("X", text)
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms on {len(text)} chars"
