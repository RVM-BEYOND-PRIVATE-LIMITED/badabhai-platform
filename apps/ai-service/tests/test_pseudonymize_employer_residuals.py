"""Issue #1892 — the employer shapes #1875 left raw are masked; ordinary speech still is not.

THE GAP, measured on main before the fix (2026-10-03):

    pseudonymize("tata motors ltd").text          -> "tata motors ltd"         (0 masked)
    pseudonymize("Larsen & Toubro Limited").text  -> "Larsen & [EMPLOYER_1]"
    pseudonymize("Sharma & Co.").text             -> "Sharma & Co."            (0 masked)
    pseudonymize("M/S SHARMA TRADERS").text       -> "M/S SHARMA TRADERS"      (0 masked)
    pseudonymize("RAMESH KUMAR SHARMA ENGINEERING WORKS PVT LTD").text -> "RAMESH [EMPLOYER_1] LTD"

the three left wholly raw also certified clean. THE RULES (documented above
`pseudonymize._EMPLOYER_STOPWORDS`): five
separate passes around the capitals rule — lower and sentence case before a form that stays
corporate in lower case (`_EMPLOYER_LOWER_RE`); the title-case twins of #1875's forms
(`_EMPLOYER_TITLE_FORM_RE`) and the absorb pass that folds what the title-case rule left beside a
token into it (`_EMPLOYER_ABSORB_RE`); the M/S cue before a firm that ends on a firm word
(`_EMPLOYER_MS_CUE_RE`); five or six name words before a strong form (`_EMPLOYER_LONG_RE`). Each
pass is gated on its mandatory piece (`_RULE_GATES`). Measured with every pass on against off over
50,918 repo strings, 1,324 fabricated negative lines, 576 fabricated employer lines and the third
and fourth reviews' 804 and 678 lines, after each of four review rounds and a final check
(security, code, performance, red team, mutation, claims, sweep); the numbers are in the module
notes.

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
from employer_masking_helpers import NEVER, RULES_1892, raw_egress, raw_words, two_view_verdict

import app.pseudonymize as gateway
from app.profiling import lexicon
from app.pseudonymize import (
    TokenScope,
    certified_clean_skill_labels,
    certify_value,
    is_certified_clean,
    pseudonymize,
)

_ZWSP = "\u200b"
_NL = "\n"


@pytest.fixture
def main_gateway(monkeypatch):
    """The gateway as #1891 left it: the five #1892 passes switched off, nothing else touched.

    Sound because each is a SEPARATE pass; with them matching nothing every other rule — the
    capitals rule included, which the long pass runs ahead of — sees byte-identical input. Measured
    over the 50,918-string corpus: identical to the module before #1892."""

    def run(fn, *args):
        with monkeypatch.context() as patch:
            for name in RULES_1892:
                patch.setattr(gateway, name, NEVER)
            return fn(*args)

    return run


def _masks_to(text: str, expected: str, tokens: int = 1) -> None:
    result = pseudonymize(text)
    assert (result.text, result.blocked, result.replaced_entities) == (expected, False, tokens)
    for token in result.placeholder_tokens:  # no pass drops a minted token from the text
        assert token in result.text, (token, result.text)


def _unchanged(text: str) -> None:
    result = pseudonymize(text)
    assert (result.text, result.blocked, result.replaced_entities) == (text, False, 0)


def test_the_1892_rule_list_is_complete():
    # One list (`employer_masking_helpers.RULES_1892`) switches the passes off in both test files;
    # a sixth pass added to the module without it would be invisible to every "main" comparison.
    gated = {id(rule) for rule, _gate in gateway._RULE_GATES.values()}
    assert gated == {id(getattr(gateway, name)) for name in RULES_1892}


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
        # The glued and abbreviated double forms.
        ("sharma engineering pvt.ltd", "[EMPLOYER_1]"),
        ("XYZ ENGINEERING (P)LTD", "[EMPLOYER_1]"),
        # The weak forms, after two or more name words.
        ("jai bhavani industries bhosari me", "[EMPLOYER_1] bhosari me"),
        ("om sai enterprises me electrician", "[EMPLOYER_1] me electrician"),
        ("ambika steel corporation me", "[EMPLOYER_1] me"),
        ("verma brothers co. me driver", "[EMPLOYER_1] me driver"),
        # Words ending in -ly are names here, not adverbs (the adverbs are stopwords).
        ("sourav ganguly enterprises me", "[EMPLOYER_1] me"),
        ("om sai supply corporation me", "[EMPLOYER_1] me"),
        # An initial is not the stopword "a": "a.k." is one name word.
        ("a.k. fabricators pvt ltd", "[EMPLOYER_1]"),
        # A sector word that ends in "-ing" is a name word before a weak form, not a process.
        ("durga engineering industries me", "[EMPLOYER_1] me"),
        ("kalyani packaging industries ke liye", "[EMPLOYER_1] ke liye"),
        ("sharma trading co. me", "[EMPLOYER_1] me"),
        # A brand from the curated vocabulary is a firm before a strong form (fourth review).
        ("siemens ltd me", "[EMPLOYER_1] me"),
        # A generic adjective may open a longer firm.
        ("indian oil corporation ltd", "[EMPLOYER_1]"),
    ],
)
def test_a_lower_or_sentence_case_employer_is_masked(text, expected, main_gateway):
    assert main_gateway(pseudonymize, text).text == text  # raw on main
    _masks_to(text, expected)


def test_company_may_sit_inside_a_lower_case_firm():
    _masks_to("sharma company pvt ltd", "[EMPLOYER_1]")
    _masks_to("abc company ltd", "[EMPLOYER_1]")


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
        # A role, a qualification or a pay word never opens a span (`_ROLE_WORDS`)...
        ("hiring cnc operator xyz pvt ltd chakan", "hiring cnc operator [EMPLOYER_1] chakan"),
        (
            "iti fitter tata motors ltd se apprentice kiya",
            "iti fitter [EMPLOYER_1] se apprentice kiya",
        ),
        ("diploma mechanical tata motors ltd", "diploma mechanical [EMPLOYER_1]"),
        ("15000 salary xyz pvt ltd", "15000 salary [EMPLOYER_1]"),
        # ...nor a department (`_DEPARTMENT_WORDS`; third review)...
        (
            "quality inspector bharat forge ltd me 2 saal",
            "quality inspector [EMPLOYER_1] me 2 saal",
        ),
        ("store keeper xyz engineering pvt ltd", "store keeper [EMPLOYER_1]"),
        ("mason l&t ltd site pe", "mason [EMPLOYER_1] site pe"),
        # ...nor does a job word sit inside the span: it starts after the job (fourth review).
        ("machine operator xyz pvt ltd 2018-2020", "machine operator [EMPLOYER_1] 2018-2020"),
        ("gas cutter jsw steel ltd dolvi", "gas cutter [EMPLOYER_1] dolvi"),
        (
            "MACHINE OPERATOR SHREE GANESH ENGINEERING WORKS PVT LTD",
            "MACHINE OPERATOR [EMPLOYER_1]",
        ),
        # (The trade words firms are named with may: `_FIRM_NAME_TRADE_WORDS`.)
        ("xyz electrical works pvt ltd", "[EMPLOYER_1]"),
        (
            "QUALITY INSPECTOR SHREE SAI PRECISION ENGINEERING PVT LTD",
            "QUALITY INSPECTOR [EMPLOYER_1]",
        ),
        # ...though a firm may hold one.
        ("xyz security services pvt ltd", "[EMPLOYER_1]"),
        # ...nor does a city: a city never OPENS a lower-case or long span (owner ruling
        # 2026-07-31; one inside a span is masked with it — `test_ACCEPTED_over_masking`).
        ("pune tata motors ltd", "pune [EMPLOYER_1]"),
        ("nashik bosch ltd me 3 saal", "nashik [EMPLOYER_1] me 3 saal"),
        ("Hosur ashok leyland ltd", "Hosur [EMPLOYER_1]"),
    ],
)
def test_the_words_around_a_lower_case_employer_stay(text, expected):
    _masks_to(text, expected)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # No #1892 span crosses a line: a résumé's role line or city line stays its own.
        (
            f"cnc operator{_NL}xyz engineering pvt ltd{_NL}pune",
            f"cnc operator{_NL}[EMPLOYER_1]{_NL}pune",
        ),
        (f"fitter{_NL}tata motors ltd", f"fitter{_NL}[EMPLOYER_1]"),
        (
            f"CNC OPERATOR{_NL}SHREE GANESH ENGINEERING WORKS PVT LTD",
            f"CNC OPERATOR{_NL}[EMPLOYER_1]",
        ),
        (
            f"Welder{_NL}Mahindra & Mahindra Ltd{_NL}2018-2020",
            f"Welder{_NL}[EMPLOYER_1]{_NL}2018-2020",
        ),
        (f"Pune{_NL}Larsen & Toubro Limited", f"Pune{_NL}[EMPLOYER_1]"),
        (f"Cnc Operator{_NL}Sharma & Co.", f"Cnc Operator{_NL}[EMPLOYER_1]."),
    ],
)
def test_no_span_crosses_a_line(text, expected):
    _masks_to(text, expected)


@pytest.mark.parametrize(
    "text",
    [
        # A generic firm: a determiner, then a form, then no proper noun.
        "ek pvt ltd company mein tha",
        "koi pvt. ltd. ho to batana",
        "working in a reputed pvt. ltd. company",
        "ek choti pvt ltd company me tha",
        "kisi achhe pvt ltd company mein job chahiye",
        "local pvt ltd company me",
        # "company" never opens a span; a possessive is a stopword.
        "hamari company pvt ltd hai",
        "meri company private limited hai",
        "company pvt ltd hai kya",
        # A role or a want in front of the generic phrase.
        "cnc operator pvt ltd company me 3 saal",
        "job chahiye pvt ltd company mein",
        "experience certificate pvt ltd ka chahiye",
        "posts ltd hai, jaldi bhejo profile",
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
        # A weak form after ONE word, an adverb or quantifiers...
        "various industries mein kaam kiya",
        "municipal corporation ka kaam",
        "fabrication jobs mostly industries mein",
        "fabrication jobs mainly industries mein",
        "steel parts usually industries me jaate",
        "alag alag industries mein kaam kiya hai",
        "kai sari industries me kaam kiya",
        # ...or after nothing but sector words: an industry, not a firm (`_SECTOR_WORDS`), before
        # a strong form too (third review)...
        "auto ancillary industries mein kaam",
        "micro irrigation industries",
        "district industries centre",
        "food processing industries me helper",
        "plastic moulding industries me operator",
        "oil & gas industries",
        "automobile pvt ltd company me job chahiye",
        "forging pvt ltd company me helper chahiye",
        # Demonstratives, numerals and adjectives of "a pvt ltd company" (third review).
        "ye pvt ltd hai ya llp",
        "teen pvt ltd company me kaam kiya",
        "korean pvt ltd company me operator",
    ],
)
def test_ordinary_lower_case_speech_is_not_masked(text):
    _unchanged(text)


# --- 2. the title-case twins of #1875's forms ----------------------------------------------------


@pytest.mark.parametrize(
    ("text", "main_text", "expected"),
    [
        # Raw on main: a joiner or a form the title-case suffix list lacks.
        ("Sharma & Co.", "Sharma & Co.", "[EMPLOYER_1]."),
        ("Xyz (P) Ltd", "Xyz (P) Ltd", "[EMPLOYER_1]"),
        ("Acme Llp", "Acme Llp", "[EMPLOYER_1]"),
        ("Acme Llc", "Acme Llc", "[EMPLOYER_1]"),
        # Only the title-form pass masks these (the lower-case pass reads no bare "Company",
        # "Limited" or "Corp"): they pin that pass on its own.
        ("Sharma & Company", "Sharma & Company", "[EMPLOYER_1]"),
        ("Xyz (P) Limited", "Xyz (P) Limited", "[EMPLOYER_1]"),
        ("Verma (OPC) Corp", "Verma (OPC) Corp", "[EMPLOYER_1]"),
        # Half-masked on main; the absorb pass folds the rest into the token.
        ("Larsen & Toubro Limited", "Larsen & [EMPLOYER_1]", "[EMPLOYER_1]"),
        ("Mahindra & Mahindra Ltd", "Mahindra & [EMPLOYER_1]", "[EMPLOYER_1]"),
        ("Shah Sharma & Sons Ltd", "Shah Sharma & [EMPLOYER_1]", "[EMPLOYER_1]"),
        ("3M India Ltd", "3M [EMPLOYER_1]", "[EMPLOYER_1]"),
        ("Hero-Honda Ltd", "Hero-[EMPLOYER_1]", "[EMPLOYER_1]"),
        # A trailing form left beside the token, a weak form included: one firm, one token.
        ("Tata Motors LTD", "[EMPLOYER_1] LTD", "[EMPLOYER_1]"),
        ("Tata Motors ltd", "[EMPLOYER_1] ltd", "[EMPLOYER_1]"),
        ("Tata Motors pvt ltd", "[EMPLOYER_1] pvt ltd", "[EMPLOYER_1]"),
        ("Bajaj Auto LTD", "[EMPLOYER_1] LTD", "[EMPLOYER_1]"),
        ("Tata Steel LIMITED", "[EMPLOYER_1] LIMITED", "[EMPLOYER_1]"),
        ("Shree Ganesh Auto Components Pvt Ltd", "[EMPLOYER_1] Ltd", "[EMPLOYER_1]"),
        ("Tata Steel industries pvt ltd", "[EMPLOYER_1] industries pvt ltd", "[EMPLOYER_1]"),
        ("Tata Steel enterprises pvt ltd", "[EMPLOYER_1] enterprises pvt ltd", "[EMPLOYER_1]"),
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
        # ...and a sector word names an industry (`_SECTOR_WORDS`).
        ("Oil & Gas Industry", "Oil & [EMPLOYER_1]"),
        ("Food & Beverage Industry", "Food & [EMPLOYER_1]"),
        ("Iron & Steel Industries", "Iron & [EMPLOYER_1]"),
        # A stopword before the joiner is not absorbed ("3 YRS & ABOVE …").
        ("3 YRS & ABOVE EXPERIENCE IN AUTO INDUSTRY", "3 YRS & [EMPLOYER_1]"),
        # A duration or a class is not a digit-led name.
        ("Experience 3Yrs Tata Motors Ltd", "Experience 3Yrs [EMPLOYER_1]"),
        ("10Th Pass Tata Motors Ltd", "10Th [EMPLOYER_1]"),
        # A city is never absorbed, before a joiner or a dash.
        ("Pune-Tata Motors Ltd", "Pune-[EMPLOYER_1]"),
        ("Pune & Tata Motors Ltd", "Pune & [EMPLOYER_1]"),
        # Two firms joined by "(I)" keep their two tokens.
        ("Abc Engineers (I) Pvt. Ltd.", "[EMPLOYER_1] (I) [EMPLOYER_2]."),
    ],
)
def test_the_absorb_pass_leaves_these_exactly_as_main(text, expected, main_gateway):
    result = pseudonymize(text)
    assert result.text == expected
    assert result == main_gateway(pseudonymize, text)


@pytest.mark.parametrize(
    "text",
    [
        # Pvt and Private name a firm only with Ltd or Limited after them.
        "Govt & Private Jobs",
        "Public & Private Sector",
        "Abc (I) Pvt",
        "Quality & Co-ordination",
    ],
)
def test_a_title_case_job_preference_is_not_a_firm(text):
    _unchanged(text)


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
        ("M/S-KRISHNA FABRICATORS", "M/S-[EMPLOYER_1]"),
        ("M/S :- KRISHNA FABRICATORS", "M/S :- [EMPLOYER_1]"),
        ("M/S A-ONE FABRICATORS ME WELDER", "M/S [EMPLOYER_1] ME WELDER"),
        ("M/s 3S Engineering Services me technician", "M/s [EMPLOYER_1] me technician"),
        ("m/s gupta & sons, bhosari", "m/s [EMPLOYER_1], bhosari"),
        ("M/S XYZ SECURITY SERVICES", "M/S [EMPLOYER_1]"),
        # "Fabrication" names firms: it does not make a generic firm word trade talk.
        ("m/s nandi fabrication works hubli me 2 saal", "m/s [EMPLOYER_1] hubli me 2 saal"),
        # A résumé's dates may stand before the cue (a measurement, 1-3 digits or a decimal, not).
        ("2016-2019 M/S XYZ TRADERS", "2016-2019 M/S [EMPLOYER_1]"),
        (
            "07/2016 TO 06/2019 M/S SHIVAM ENGINEERING BHOSARI MIDC PUNE",
            "07/2016 TO 06/2019 M/S [EMPLOYER_1] BHOSARI MIDC PUNE",
        ),
        # An initial is a name word, not the stopword "a".
        ("M/S. A.K. ENGINEERING WORKS", "M/S. [EMPLOYER_1]"),
        ("m/s a.k. traders", "m/s [EMPLOYER_1]"),
        # The firm ends on its firm word: what follows stays raw — a stopword, a city (cities are
        # never redacted, 2026-07-31), a locality, a role, a payer's verb...
        ("M/S SHARMA TRADERS mein 3 saal", "M/S [EMPLOYER_1] mein 3 saal"),
        ("M/S KRISHNA FABRICATORS, PUNE", "M/S [EMPLOYER_1], PUNE"),
        (
            "worked at M/S SHARMA TRADERS PUNE MEIN 3 SAAL",
            "worked at M/S [EMPLOYER_1] PUNE MEIN 3 SAAL",
        ),
        ("M/S SHARMA TRADERS BHOSARI ME HELPER", "M/S [EMPLOYER_1] BHOSARI ME HELPER"),
        ("M/S SHARMA TRADERS WELDER", "M/S [EMPLOYER_1] WELDER"),
        ("M/S Sharma Traders needs 5 helpers", "M/S [EMPLOYER_1] needs 5 helpers"),
        ("M/S KRISHNA FAB WORKS CNC OPERATOR", "M/S [EMPLOYER_1] CNC OPERATOR"),
        # ...and a city a dash glues on.
        ("M/S SHARMA TRADERS-PUNE", "M/S [EMPLOYER_1]-PUNE"),
        ("M/S SHARMA TRADERS-BHOSARI", "M/S [EMPLOYER_1]-BHOSARI"),
        (
            "M/S KRISHNA FABRICATORS-CHAKAN ME WELDER",
            "M/S [EMPLOYER_1]-CHAKAN ME WELDER",
        ),
        # "CNC" can sit inside the firm before its firm word.
        ("M/S. AMBIKA CNC WORKS, BHOSARI", "M/S. [EMPLOYER_1], BHOSARI"),
        (
            "Required CNC operator at M/s Precision Components, Chakan",
            "Required CNC operator at M/s [EMPLOYER_1], Chakan",
        ),
        # ...and a line break: the next line is the role, not the firm.
        (f"M/S SHARMA TRADERS{_NL}CNC OPERATOR", f"M/S [EMPLOYER_1]{_NL}CNC OPERATOR"),
    ],
)
def test_a_firm_after_an_m_s_cue_is_masked(text, expected, main_gateway):
    assert main_gateway(pseudonymize, text).text == text  # raw on main
    _masks_to(text, expected)


def test_two_m_s_firms_in_a_row_keep_two_cues():
    # The first firm never takes the next cue's "M" as a name word.
    _masks_to(
        "M/S Sharma Traders M/S Gupta Fabricators", "M/S [EMPLOYER_1] M/S [EMPLOYER_2]", tokens=2
    )
    _masks_to(
        "m/s sharma traders m/s gupta fabricators", "m/s [EMPLOYER_1] m/s [EMPLOYER_2]", tokens=2
    )
    _masks_to(
        "M/S SHARMA TRADERS M / S VERMA STEELS", "M/S [EMPLOYER_1] M / S [EMPLOYER_2]", tokens=2
    )


@pytest.mark.parametrize(
    ("text", "main_text", "expected", "tokens"),
    [
        # The title-case rule took the cue's "S" as a name word; the token keeps it.
        (
            "M/S Hanuman Steel Traders me loader",
            "M/[EMPLOYER_1] Traders me loader",
            "M/[EMPLOYER_1] me loader",
            1,
        ),
        # A firm the title-case rule half-masked keeps its token and takes the firm word right after
        # it...
        (
            "M/s Jagdamba Steel Traders me fabrication",
            "M/s [EMPLOYER_1] Traders me fabrication",
            "M/s [EMPLOYER_1] me fabrication",
            1,
        ),
        # ...and none past a firm that is already whole: a payer's verb and role stay (third
        # review: "requires CNC" was folded into the token).
        (
            "M/s ABC Engineering Pvt Ltd requires CNC operators at Chakan",
            "M/s [EMPLOYER_1] requires CNC operators at Chakan",
            "M/s [EMPLOYER_1] requires CNC operators at Chakan",
            1,
        ),
        (
            "M/s Kalyani Forge Ltd CNC operator chahiye",
            "M/s [EMPLOYER_1] CNC operator chahiye",
            "M/s [EMPLOYER_1] CNC operator chahiye",
            1,
        ),
        # ...even when a firm word follows a few words on (fourth review).
        (
            "M/S TATA MOTORS LTD SPARE PARTS",
            "M/[EMPLOYER_1] SPARE PARTS",
            "M/[EMPLOYER_1] SPARE PARTS",
            1,
        ),
        # The "S" of the cue never opens a span (`_SPAN_START`).
        ("M/S SHREE GANESH AUTO COMPONENTS LTD", "M/S [EMPLOYER_1]", "M/S [EMPLOYER_1]", 1),
        # Two tokens under one cue are left as they are: folding them would drop a minted token.
        (
            "M/S Tata Motors Ltd & Bajaj Auto Ltd",
            "M/[EMPLOYER_1] & [EMPLOYER_2]",
            "M/[EMPLOYER_1] & [EMPLOYER_2]",
            2,
        ),
    ],
)
def test_an_m_s_firm_an_earlier_rule_masked_keeps_its_tokens(
    text, main_text, expected, tokens, main_gateway
):
    assert main_gateway(pseudonymize, text).text == main_text
    _masks_to(text, expected, tokens=tokens)


@pytest.mark.parametrize(
    "text",
    [
        # Metres per second, after a number or explained: the measurement guard, or no firm word.
        "speed 5 m/s",
        "speed 5 m/s rakhte",
        "speed 5  m/s rakhni hai",
        "SPEED 5 M/S HAI",
        "cutting speed 2.5m/s",
        "WIND SPEED 9 M/S SE UPAR",
        "speed in m/s hoti hai",
        "m/s matlab meter per second hota hai",
        "mera kaam tha conveyor ki speed m/s check karna",
        # Mild steel: stock, work, trades and the curated trade vocabulary.
        "m/s plate aur angle ka kaam",
        "M/S PLATE CUTTING GAS SE KARTA HU",
        "M/S ANGLE CUTTING",
        "M/S Tig Welding",
        "M/S GAS CUTTING",
        "M/S Fitter",
        "M/S Welder",
        "m/s welder hu 5 saal se",
        "m/s fabricator hu",
        "m/s door window banata hu",
        "M/S S/S WELDING",
        "Required M/S Welder for Pune site",
        "m/s nahi pata",
        "m/s piping ka kaam kiya",
        "M/S TURNING KA KAAM 3 SAAL",
        "M/S AutoCAD drafting",
        "m/s plumbing aur fitting",
        # Mild-steel talk that opens on a word no list holds rarely reaches a firm word (third
        # review: 71 of 125 such lines masked before `_MS_FIRM_WORD`).
        "m/s hollow section ka fabrication kiya hai",
        "M/S CHEQUERED PLATE CUTTING",
        "m/s 2mm sheet bending",
        "m/s lathe machine pe kaam",
        "Walk-in for M/S fabricators",
        "M/S Grinders required",
        "M/s Engineering Unit Hai Speed Ki, Meter Per Second",
        "speed  m/s air velocity",
        "speed 5   m/s rakhni hai",
        # A measurement before the cue: one to three digits or a decimal (fourth review).
        "discharge 3 m/s submersible pumps me",
        "flow rate 1.5 m/s hydraulic systems",
        # A generic firm word after mild-steel stock, or after sector words in lower case.
        "m/s truck body works me 4 saal",
        "M/S WATER TANK FABRICATION WORKS ME 3 SAAL",
        "m/s power tools",
        "m/s civil engineering",
        "m/s auto parts welding",
        # A "firm" of nothing but curated trade vocabulary is a skill (`replace_ms_firm`).
        "M/S PIPING SYSTEMS",
        "M/S TOOL TECH",
        # Not the cue at all, or the cue named.
        "feed 150 mm/s",
        "speed 3 km/s",
        "M/S firms",
        "an M/S firm",
        "m/s pune",
    ],
)
def test_m_s_as_a_unit_or_mild_steel_is_not_a_firm(text):
    _unchanged(text)


def test_a_mild_steel_skill_label_still_certifies():
    labels = [
        "M/S Tig Welding", "M/S Fitter", "m/s gas cutting", "M/S Welder", "M/S Arc Welding",
        "M/S Plasma Cutting", "M/S Laser Cutting", "m/s spot welding",
        "m/s hollow section fabrication", "m/s heavy fabrication",
        "m/s heavy structure works", "m/s truck body works", "m/s power tools",
        "m/s auto parts welding", "m/s civil engineering", "m/s staircase railing works",
        "M/S TRUCK BODY WORKS",
    ]  # fmt: skip
    assert certified_clean_skill_labels(labels) == labels


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
        # A joiner before the form does not count: "(P) LTD" is the double form's short spelling.
        ("RAMESH KUMAR SHARMA ENGINEERING WORKS (P) LTD", "RAMESH [EMPLOYER_1]", "[EMPLOYER_1]"),
        # A city never opens the span, and one a dash glues on after the form stays raw.
        (
            "PUNE SHREE GANESH ENGINEERING WORKS PVT LTD",
            "PUNE [EMPLOYER_1] LTD",
            "PUNE [EMPLOYER_1]",
        ),
        (
            "RAMESH KUMAR SHARMA ENGINEERING WORKS PVT LTD-CHAKAN",
            "RAMESH [EMPLOYER_1] LTD-CHAKAN",
            "[EMPLOYER_1]-CHAKAN",
        ),
    ],
)
def test_five_or_six_name_words_before_a_strong_form_mask_whole(
    text, main_text, expected, main_gateway
):
    assert main_gateway(pseudonymize, text).text == (text if main_text is None else main_text)
    _masks_to(text, expected)


@pytest.mark.parametrize(
    ("text", "main_text", "expected"),
    [
        # Security review: a long span that began on "INDUSTRIES" took the capitals span's form
        # and left "KRISHNA" raw. No form word sits inside a long span
        # (`_NOT_A_CAPITALS_OR_TITLE_FORM_WORD`)...
        (
            "KRISHNA INDUSTRIES turning milling grinding drilling tapping pvt ltd",
            "[EMPLOYER_1] turning milling grinding drilling tapping pvt ltd",
            "[EMPLOYER_2] [EMPLOYER_1]",
        ),
        (
            "RAMESH KUMAR SHARMA COMPANY d e f g LTD",
            "[EMPLOYER_1] d e f g LTD",
            "[EMPLOYER_1] [EMPLOYER_2]",
        ),
        # ...including one the capitals rule ends on with a dash after it (second review: the
        # long span took "Traders INDUSTRIES-PUNE …" and left "Hero" raw).
        (
            "Hero Traders INDUSTRIES-PUNE BHARAT Sharma shop ltd",
            "[EMPLOYER_1]-PUNE BHARAT Sharma shop ltd",
            "[EMPLOYER_1]-PUNE [EMPLOYER_2]",
        ),
        # Nor does its own strong form end inside a capitals name word (third review: the long
        # span ended at "LTD" of "LTD-patil" and left "patil" raw; `_LONG_FORM_END`).
        (
            "ramesh kumar sharma auto works LTD-patil MOTORS LTD",
            "ramesh kumar sharma auto works [EMPLOYER_1]",
            "ramesh kumar sharma auto works [EMPLOYER_1]",
        ),
        (
            "jai bhavani steel fab works (P)LTD-hero LTD",
            "jai bhavani steel fab works (P)[EMPLOYER_1]",
            "jai bhavani steel fab works (P)[EMPLOYER_1]",
        ),
        (
            "ramesh kumar sharma auto works LTD-pune-patil MOTORS LTD",
            "ramesh kumar sharma auto works [EMPLOYER_1]",
            "ramesh kumar sharma auto works [EMPLOYER_1]",
        ),
        # A joiner in the capitals span costs no word (final check).
        (
            "ramesh kumar sharma auto works LTD-patil A B C & CO",
            "ramesh kumar sharma auto works [EMPLOYER_1]",
            "ramesh kumar sharma auto works [EMPLOYER_1]",
        ),
    ],
)
def test_the_long_pass_never_takes_a_capitals_span_s_name(text, main_text, expected, main_gateway):
    old = main_gateway(pseudonymize, text)
    assert old.text == main_text
    result = pseudonymize(text)
    assert (result.text, result.blocked) == (expected, False)
    assert not (raw_words(result.text) - raw_words(old.text))


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
        (
            "precision engineering industries",
            "precision engineering industries",
            "a weak form after nothing but sector words names an industry",
        ),
        ("tata motors mein tha", "tata motors mein tha", "no form, no cue"),
        ("SHREE SAI ENGINEERING WORKS", "SHREE SAI ENGINEERING WORKS", "no form, no cue"),
        ("BAJAJ AUTO", "BAJAJ AUTO", "no form, no cue"),
        ("GUPTA & SONS", "GUPTA & SONS", "no form, no cue"),
        ("xyz and sons ltd", "xyz and [EMPLOYER_1]", "'and' is a stopword in lower case"),
        ("steel authority of india ltd", "steel authority of [EMPLOYER_1]", "'of' is a stopword"),
        ("sharma &  co", "sharma &  co", "'& co' wants exactly one space"),
        ("fitter/tata motors ltd", "fitter/tata [EMPLOYER_1]", "a slash glues a word on"),
        (
            "pune-tata motors ltd",
            "pune-tata [EMPLOYER_1]",
            "a dash, a dot or '&' glues the first name word to a city, which never opens a span",
        ),
        ("nashik-sharma & co", "nashik-sharma & co", "so a glued firm of one word stays raw"),
        (
            f"shree ganesh engineering{_NL}works pvt ltd",
            f"shree ganesh engineering{_NL}[EMPLOYER_1]",
            "no span crosses a line, a wrapped firm included",
        ),
        ("B C D E F G H PVT LTD", "B [EMPLOYER_1]", "seven name words; the window is six"),
        (
            "SRI RAMA KRISHNA CASTING AND FORGING LIMITED",
            "SRI RAMA [EMPLOYER_1]",
            "LIMITED is not a strong form",
        ),
        ("M/S STEEL CENTRE", "M/S STEEL CENTRE", "a mild-steel word cannot open an M/S firm"),
        ("M/S THE ROYAL ENGINEERS", "M/S THE ROYAL ENGINEERS", "nor can a stopword"),
        ("M/S CNC TURNING WORKS", "M/S CNC TURNING WORKS", "nor can a role word"),
        ("M/S PUNE SHARMA TRADERS", "M/S PUNE SHARMA TRADERS", "nor can a city"),
        ("M/S TOOL CRAFT", "M/S TOOL CRAFT", "an M/S firm ends on a firm word"),
        (
            "M/S SAI PRECISION REQUIRES VMC OPERATORS",
            "M/S SAI PRECISION REQUIRES VMC OPERATORS",
            "so a firm with none stays raw, as on main",
        ),
        ("M/S SIEMENS", "M/S SIEMENS", "a one-word M/S firm has no firm word either"),
        ("1 M/S SHARMA TRADERS", "1 M/S SHARMA TRADERS", "nor after a small number (a unit)"),
        ("M/S SHARMA TRADERS.PUNE", "M/S SHARMA TRADERS.PUNE", "nor before a dot or a slash"),
        (
            "pune industrial gases pvt ltd",
            "pune [EMPLOYER_1]",
            "a city as the first word of a firm stays raw",
        ),
        ("pune.tata motors ltd", "pune.tata [EMPLOYER_1]", "as does a word a dot glues on"),
        (
            "M/S Hanuman Steel Om Sai Traders me loader",
            "M/[EMPLOYER_1] Om Sai Traders me loader",
            "a half-masked firm's token takes only a firm word right after it",
        ),
        (
            "M/S BALAJI STRUCTURE WORKS",
            "M/S BALAJI STRUCTURE WORKS",
            "stock before a generic firm word",
        ),
        (
            "water tech industries me",
            "water tech industries me",
            "a weak form after vocabulary only",
        ),
        (
            "RAMESH KUMAR SHARMA ENGINEERING WORKS PVT LTD.CHAKAN",
            "RAMESH [EMPLOYER_1]CHAKAN",
            "a dot glued after the long form, as main",
        ),
        (
            "SRI SAI IRON AND STEEL PVT LTD",
            "SRI [EMPLOYER_1]",
            "four name words and a joiner: the capitals window leaves the first, as on main",
        ),
    ],
)
def test_KNOWN_RESIDUAL_stated_under_masking(text, expected, why):
    # Each is recorded in the module notes and docs/ai/pseudonymization.md (R48 summarises them),
    # with the measurement that kept it out. If one of these starts masking, the boundary moved:
    # re-measure and update them.
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
        # A weak form after two ordinary words (the one NCO prose shape left in the repo corpus).
        ("garbage removal corporation", "garbage removal corporation", "[EMPLOYER_1]"),
        # The title-form pass takes a leading city, as the title-case and capitals rules do...
        ("Pune Sharma & Co.", "Pune Sharma & Co.", "[EMPLOYER_1]."),
        # ...and a city INSIDE a lower-case or long span is masked with it (only the first word is
        # guarded; main's capitals and title-case rules do the same in their cases).
        ("bhosari pune tata motors ltd", "bhosari pune tata motors ltd", "[EMPLOYER_1]"),
        # A weak form after a product noun, and a payer's benefit before "pvt ltd company" (third
        # review's sweep: 28 of 30 and 7 of 50 lines built for these shapes).
        (
            "rice mill industries me loader",
            "rice mill industries me loader",
            "[EMPLOYER_1] me loader",
        ),
        ("bus facility pvt ltd company", "bus facility pvt ltd company", "[EMPLOYER_1] company"),
        (
            "agarbatti making industries me kaam kiya",
            "agarbatti making industries me kaam kiya",
            "[EMPLOYER_1] me kaam kiya",
        ),
        # A locality outside the gazetteer, or a job the lists lack, opens a lower-case span.
        (
            "chakan bharat forge ltd me fitter",
            "chakan bharat forge ltd me fitter",
            "[EMPLOYER_1] me fitter",
        ),
        ("forklift tata motors ltd me", "forklift tata motors ltd me", "[EMPLOYER_1] me"),
        # Trade talk ending on a generic firm word, with no stock word and not all sector words.
        ("m/s hand tools se kaam", "m/s hand tools se kaam", "m/s [EMPLOYER_1] se kaam"),
    ],
)
def test_ACCEPTED_over_masking(text, main_text, expected, main_gateway):
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
        f"CNC OPERATOR{_NL}TATA MOTORS LTD",
    ],
)
def test_every_earlier_rule_keeps_its_span(text, main_gateway):
    # The passes run after the name rules, the title-case rule and (all but the long pass) the
    # capitals rule, on their output: a name cue is never eaten, an earlier match never shortened.
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
        # ...nor absorbed as a dash- or digit-led lead: before that refusal these passed as
        # "[EMPLOYER_1]" with their digits folded in (security review), and a fake token did too.
        ("AB12345678-Tata Steel", True, None),
        ("A12345678-Tata Motors Ltd", True, None),
        ("1A12345678 Tata Motors Ltd", True, None),
        ("Landline A23456789-[EMPLOYER_1] pe call karo", True, None),
        # ...nor cut by an M/S firm: a word longer than the bound fails the match, not the digits.
        ("M/S 1a" + "b" * 56 + "12345678", True, None),
        # An in-range amount glued to a word is still money, as on main.
        ("ab1234567 tata motors ltd", False, "ab[AMOUNT_1] [EMPLOYER_1]"),
        ("X1234567-Tata Motors Ltd", False, "X[AMOUNT_1]-[EMPLOYER_1]"),
        ("1X2345678 Tata Steel", False, "1X[AMOUNT_1] [EMPLOYER_1]"),
        ("M/S " + "A" * 58 + "1234567", False, "M/S " + "A" * 58 + "[AMOUNT_1]"),
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
        "tata motors\u200bltd",  # the reader view merges "motorsltd"; the spaced view masks
        "M/S\u200bSHARMA TRADERS",  # the reader view merges "M/SSHARMA"; the spaced view masks
        "Larsen &\u200bToubro Limited",  # main passed this with "Larsen" raw
        # A firm the lower-case pass left alone in the spaced view (sector words only) and the M/S
        # pass then masked: its region is recorded, so the reader view's raw firm blocks (`_apply`
        # keeps a vetoed match's source offsets; fourth review \u2014 main passes these raw).
        "m/s\u200bprecision engineering pvt ltd",
        "m/s\u2060auto parts ltd",
        "m/s\u200bpower tools pvt ltd",
        # ...and two the fourth review found blocked in round 3 and passed in round 4.
        "m/s\u200bsiemens ltd",
        "m/s\u200bsharma trading co.",
        # A job word no longer sits in the spaced view's span (second review's R49 pin).
        "X1234567-Hero WORKS\u00adEngineering operator INDUSTRIES-PUNE",
    ],
)
def test_an_invisible_that_hides_an_employer_fails_closed(text):
    result = pseudonymize(text)
    assert (result.text, result.blocked) == ("", True)
    assert result.blocked_reason == gateway._INVISIBLE_BYPASS_REASON


def test_a_name_hidden_by_an_invisible_is_now_masked_whole(main_gateway):
    # Main BLOCKED this (the spaced view's name overlapped no reader mask). The lower-case rule's
    # reader-view span now covers "isRamesh Kumar", so every offset the spaced view masked is
    # masked: the two-view check passes it, as designed, with the name under an employer label.
    text = "my name is\u200bRamesh Kumar ltd"
    assert main_gateway(pseudonymize, text).blocked_reason == gateway._INVISIBLE_BYPASS_REASON
    assert pseudonymize(text).text == "my [EMPLOYER_1]"
    assert two_view_verdict(text) == "full"


@pytest.mark.parametrize(
    ("text", "leaked", "raw"),
    [
        # The title-form pass (Llp, Llc, W.l.l, (P) Ltd, & Co.)...
        ("my name is\u200bRamesh Kumar Llp", "my name isRamesh [EMPLOYER_1]", "Ramesh "),
        ("this is\u200bRamesh Kumar Llc", "this isRamesh [EMPLOYER_1]", "Ramesh "),
        ("my name is\u200bRamesh Kumar W.l.l", "my name isRamesh [EMPLOYER_1]", "Ramesh "),
        ("my name is\u200bRamesh Kumar (P) Ltd", "my name isRamesh [EMPLOYER_1]", "Ramesh "),
        ("my name is\u200bRamesh Kumar & Co.", "my name isRamesh [EMPLOYER_1].", "Ramesh "),
        # ...the absorb pass ("Kumar &" or "Kumar-" folded into the token)...
        ("my name is\u200bRamesh Kumar & Toubro Ltd", "my name isRamesh [EMPLOYER_1]", "Ramesh "),
        ("mera naam\u200bSuresh Patil & Sons Ltd", "mera naamSuresh [EMPLOYER_1]", "Suresh "),
        ("my name is\u200bRamesh Kumar-Toubro Ltd", "my name isRamesh [EMPLOYER_1]", "Ramesh "),
        # ...and a long lower-case span.
        (
            "my name is\u200bRamesh Kumar aa bb cc dd ee ltd",
            "my name isRamesh [EMPLOYER_1]",
            "Ramesh ",
        ),
        # No cue: an invisible that merges a word into a dash-glued run (second review, the wider
        # generator).
        ("Sharma Motors\u2060A-ONE Motors", "Sharma [EMPLOYER_1]", "Sharma "),
    ],
)
def test_KNOWN_RESIDUAL_r49_extends_to_the_1892_passes(text, leaked, raw, main_gateway):
    """R49 / #1890, pre-existing in #1738's two-view check (see the capitals file's twin test).

    An invisible right after a name cue merges "isRamesh" in the reader view, so the cue misses and
    a #1892 pass masks the name's tail with the firm; the spaced view masks "Ramesh Kumar" as a
    name, which merely OVERLAPS that mask, so "Ramesh" egresses where main blocked. An invisible
    inside a dash-glued run does the same with no cue: the reader view merges "MotorsA-", the
    absorb pass folds it into the token, and that token merely overlaps the spaced view's "Sharma
    Motors". #1892 extends the shape to its passes, as #1875 did to the capitals forms. The fix is
    #1890 (covered only when every kept offset is reader-masked); when it lands these block: make
    them blocking pins."""
    assert main_gateway(pseudonymize, text).blocked_reason == gateway._INVISIBLE_BYPASS_REASON
    result = pseudonymize(text)
    assert (result.text, result.blocked) == (leaked, False)
    assert raw_egress(text) == ("partial", raw)


# --- 7. scope and the certifiers ------------------------------------------------------------------


def test_lower_title_and_capitals_spellings_share_one_token_under_a_scope():
    # Equality is on the matched span, lower-cased; a span the absorb pass widened keeps the token
    # of the span an earlier rule matched, as on main.
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
    # decide exactly as before #1892. Lower case matters here: these passes read any case. And every
    # curated trade label behind an "M/S " cue, the way mild steel is written ("M/S Tig Welding"):
    # an M/S cue before any other word is a firm by design, so only these are checked.
    labels = _lexicon_strings()
    assert len(labels) > 1_000
    casings = {v for s in labels for v in (s, s.upper(), s.title(), s.lower())}
    trade = {s for s in labels if gateway._is_known_trade_vocabulary(s)}
    assert len(trade) > 100
    casings |= {f"{cue} {s}" for s in trade for cue in ("M/S", "m/s")}
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
    "pvt", "LIMITED", "INDUSTRIES", "pvt.ltd", "(P)LTD",
]  # fmt: skip
_CUES = ["M/S", "M/s.", "m/s", "M / S", "M/S:", "M/S:-", "5 m/s", "mera naam", "MY NAME IS"]
#: ... with a form a dash glues on, which the capitals rule still ends on (second review), and a
#: name word glued after one, which it takes whole (third review).
_JOINED = [
    "&", "(P)", "(I)", "and", "3M", "Hero-Honda", "A-ONE", "J.K.", "a.k.", "Pune-Tata",
    "INDUSTRIES-PUNE", "Ltd-Pune", "LTD-patil",
]  # fmt: skip
_FILLERS = [
    "mein", "at", "ek", "koi", "the", "plate", "angle", "Pune", "PUNE", "chakan", ",", "5", "\n",
    "welder", "CNC", "operator", "iti", "salary",
]  # fmt: skip
#: Words main blocks on or masks as money — spaced, dash-glued and digit-led (absorb leads).
_DIGITS = ["X12345678", "12345678", "ab1234567", "AB12345678-Tata", "1X2345678", "X1234567-Hero"]
_INVISIBLES = ["\u200b", "\u200c", "\u2060", "\u00ad"]
_POOLS = [_NAMES, _TRADE, _FORMS, _CUES, _JOINED, _FILLERS, _DIGITS, _INVISIBLES]


def _sample(rng: random.Random) -> str:
    """Up to 12 parts, so long spans and spans running past a capitals form are reachable."""
    parts = [rng.choice(rng.choice(_POOLS)) for _ in range(rng.randint(1, 12))]
    text = parts[0]
    for previous, part in pairwise(parts):
        text += ("" if previous in _INVISIBLES or part in _INVISIBLES else " ") + part
    return text


def _a_pass_may_act(text: str, main_text: str) -> bool:
    return "[EMPLOYER_" in main_text or any(
        gate.search(text) for _rule, gate in gateway._RULE_GATES.values()
    )


def test_property_the_1892_passes_only_ever_add_masking(main_gateway):
    """What this PROVES, exactly — over 6,000 samples of THIS seeded generator, not over all inputs.

    The pools: names and trade words in three cases, every form these passes read (glued spellings
    too) and the ordinary words they must not ("limited", "company", "pvt"), the M/S cue in six
    spellings and as a unit, the name cues, joiners, dash-, dot- and digit-led words, stopwords,
    roles, mild-steel words, cities, line breaks, digit words main blocks on or masks as money
    (spaced and glued), and four invisibles glued in as the SOLE separator.

    1. IN EACH VIEW (`_mask`): every source offset main masked is still masked (a region may grow:
       the long pass runs ahead of the capitals rule and can take its span whole, never a part of
       it), no word main masked is left raw, every residual-digit block main raised is still
       raised, and when no pass could act (`_a_pass_may_act`) the result and regions are
       byte-identical. The title-case and name rules run first, so their spans are exactly main's.
    2. END TO END (`pseudonymize`): the same, EXCEPT where main blocked on the two-view check and
       the branch passes, each such turn asserted to be "full" (the reader view now masks every
       kept offset the spaced view masked) or "partial" (R49, #1890) — and the partial turns are
       BOUNDED, so a change that widens R49 further fails here. The shapes that leave a name word
       raw are pinned on their own by `test_KNOWN_RESIDUAL_r49_extends_to_the_1892_passes`.

    What it does NOT prove: anything outside these pools, or that the masking is CORRECT."""
    rng = random.Random(1892)
    seen: Counter[str] = Counter()
    for _ in range(6_000):
        text = _sample(rng)
        for view in gateway._build_views(text):
            new_view, new_regions = gateway._mask(view, True)
            old_view, old_regions = main_gateway(gateway._mask, view, True)
            assert old_view.blocked <= new_view.blocked, text
            new_masked: set[int] = set().union(*new_regions)
            assert all(region <= new_masked for region in old_regions), (text, view.text)
            seen["a region grew"] += any(region not in new_regions for region in old_regions)
            assert not (raw_words(new_view.text) - raw_words(old_view.text)), (text, view.text)
            if not _a_pass_may_act(view.text, old_view.text):
                assert (new_view, new_regions) == (old_view, old_regions), text
        new, old = pseudonymize(text), main_gateway(pseudonymize, text)
        seen["changed"] += new != old
        seen["main blocked"] += old.blocked
        if old.blocked and not new.blocked:
            assert old.blocked_reason == gateway._INVISIBLE_BYPASS_REASON, text
            verdict = two_view_verdict(text)
            assert verdict in ("full", "partial"), (text, verdict)
            seen[f"unblocked, {verdict}"] += 1
            continue
        assert old.blocked <= new.blocked, text
        assert not (raw_words(new.text) - raw_words(old.text)), (text, old.text, new.text)
        if not any(_a_pass_may_act(v.text, old.text) for v in gateway._build_views(text)):
            assert new == old, text
    # Measured 2026-10-03 (fourth review): 1,060 outputs change and main blocks 1,999 turns; of
    # those, 20 now pass with full cover and none as an R49 partial. (Before the M/S firm word and
    # with smaller pools: 7 partials, two leaving a name word — "Sharma Fabricators", "Hero". The
    # first is pinned in `test_KNOWN_RESIDUAL_r49_extends_to_the_1892_passes`; the second now
    # fails closed.)
    assert seen["changed"] > 900, seen
    assert seen["main blocked"] > 1_500, seen
    assert seen["a region grew"] > 0, seen
    assert seen["unblocked, partial"] <= _R49_PARTIAL_BOUND, seen


#: The R49 partial turns the property test's 6,000 samples may hold: none measured, a little slack.
_R49_PARTIAL_BOUND = 2


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
        "sharma engineering pvt.ltd",
        "M / S KRISHNA",
    ]
    for rule, gate in gateway._RULE_GATES.values():
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


def test_every_new_name_word_is_bounded_possessive_and_refuses_seven_digits():
    for word in (gateway._ANY_NAME_WORD, gateway._MS_NAME_WORD):
        assert re.search(r"\{0,\d+\}\+$", word), word  # possessive and bounded
        assert "]*" not in word and "]+" not in word  # no unbounded run over a character class
        assert r"\d{7})" in word  # detail 4
    # The absorb lead's dash-glued word is hand-built: it carries the refusal too (security review).
    assert gateway._NO_SEVEN_DIGIT_RUN in gateway._EMPLOYER_ABSORB_LEAD
    assert gateway._EMPLOYER_ABSORB_LEAD.count(gateway._CAPS_NAME_WORD) == 3


# Generous ceilings, after the `_CREDENTIAL_ID_LOOKAHEAD_MAX` precedent and the two employer files.
# Measured 2026-10-03 (module notes, COST). End to end the dense shapes below are dominated by the
# rules #1892 did not touch (~150 ms on a quiet laptop, 1.4 s under a loaded test run), so they are
# pinned two load-proof ways instead: each new pass ALONE, and the end-to-end cost RELATIVE to the
# same gateway with the passes off, interleaved in one process.
_REDOS_BUDGET_MS = 750
_PASS_BUDGET_MS = 250
_DENSE = ("B." * 28 + " & ") * 400
_DENSE_SHAPES = {
    # The reviewers' worst shapes: dotted words joined by "&" or "and" with every gate open. Each
    # cost x5.3 its base before spans opened only at a real word start.
    "dense": _DENSE[:19_970] + " ltd Ltd M/ [EMPLOYER_1]",
    "dense+zwsp": "\u200b" + _DENSE[:19_969] + " ltd Ltd M/ [EMPLOYER_1]",
    "and": (("b." * 30 + " and ") * 400)[:19_992] + " pvt ltd",
    "dotted": "B." * 9_988 + " ltd Ltd M/ [EMPLOYER_1]",
}


@pytest.mark.parametrize(
    "text",
    [
        "M/S " * 5_000,
        "m/s b " * 3_333,
        "b " * 9_990 + " ltd",
        "B& " * 6_660 + " Ltd",
        "Ab (P) " * 2_850 + " ltd",
        "Ab & Tata Steel LTD " * 1_000,
        "abcdefgh " * 2_220 + " pvt ltd",
        "tata\u200bmotors ltd " * 1_000,
    ],
    ids=["M/S", "m/s b", "b ltd", "B& Ltd", "Ab (P)", "absorb", "words", "zwsp"],
)
def test_pseudonymize_stays_linear_on_worst_inputs(text):
    text = text[: gateway.DEFAULT_MAX_LENGTH]
    start = time.perf_counter()
    pseudonymize(text)
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms on {len(text)} chars"


@pytest.mark.parametrize("rule", RULES_1892)
@pytest.mark.parametrize("shape", sorted(_DENSE_SHAPES))
def test_each_pass_alone_is_cheap_on_the_dense_shapes(rule, shape):
    # 1-6 ms each on a quiet laptop; the regex itself, ungated.
    text = _DENSE_SHAPES[shape]
    start = time.perf_counter()
    getattr(gateway, rule).sub("X", text)
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert elapsed_ms < _PASS_BUDGET_MS, f"{rule}: {elapsed_ms:.0f}ms on {shape}"


@pytest.mark.parametrize("shape", sorted(_DENSE_SHAPES))
def test_the_passes_add_a_bounded_share_end_to_end(shape, main_gateway):
    # x1.1-1.4 measured; the defect the review found was x5.3. Min of 3, interleaved, so machine
    # load moves both sides together. (Inputs with a larger share by design, such as one firm after
    # another, are pinned by `test_pseudonymize_stays_linear_on_worst_inputs`.)
    text = _DENSE_SHAPES[shape]
    assert len(text) <= gateway.DEFAULT_MAX_LENGTH  # a longer one is refused before any rule runs

    def best(fn) -> float:
        times = []
        for _ in range(3):
            start = time.perf_counter()
            fn(text)
            times.append(time.perf_counter() - start)
        return min(times)

    new = best(pseudonymize)
    old = best(lambda t: main_gateway(pseudonymize, t))
    assert new < 2.5 * old + 0.02, f"{new * 1000:.0f}ms vs {old * 1000:.0f}ms on {shape}"
