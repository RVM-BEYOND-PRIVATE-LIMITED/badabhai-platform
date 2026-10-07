"""Issue #1950 — a dot after the cue, a ":-" separator and the "regn" cue (risks-register R56).

THE DEFECT: the cued-ID rules read the gap between a cue word and its value with
`\\s*(?:(?:no\\.?|number|num|#)\\s*)?(?:[:\\-]\\s*)?` (#1933's linear connector). No token of it
starts with ".", the separator is one character and "regn" is no cue, so the common Indian
certificate spellings "Reg.No.:- 123456", "Regn. No. MH2019CN4471", "Roll.No-4567890" and
"Passport.No: K1234567" never reached their value. Measured 2026-10-03 on origin/main 32545450:
`pseudonymize` left the ID raw (no seven-digit run for the residual net), so it was stored and
embedded raw under both AI_RAW_PII_ENABLED postures; `contains_hard_identifier` (G1/G2, the output
floor of ADR-0047 §6) admitted it; and `signals.detect` recorded its digits as pay (123456, and
4471 from MH2019CN4471). "reg no:- 123456" missed for the separator alone.

THE FIX: three additive tokens, in all five copies (`_CREDENTIAL_ID_RE`, `_RESUME_CUED_ID_RE`,
lexicon `credentialBefore` and its mirror, the two TypeScript ports): `\\.?` straight after the
cue word, "regn" among the credential cues, and `-?` after the separator. None is whitespace and
each is followed by a different class, so the rules stay linear (section 6).

EVERY VERDICT ONLY GROWS, AND ONLY WHERE IT MEANS TO (section 5). The accepted language grows, so
a G1/G2 refusal or a salary-guard drop can never be lost; per cue, every identifier character the
old rule masked is still masked; every line that moves holds one of the new shapes; and the dot is
TRANSPARENT: "Cue." decides exactly as "Cue" wherever the cue already ended on a boundary. That
last property is the deliberate answer to the sentence-end question (section 3): a number written
straight after "certificate." masks, or is dropped as pay, exactly as one after "certificate"
always was. Over the repo corpus (#1875's method, section 4) no string and no certifier label
changes outcome. The masked TEXT is not monotone ACROSS cues (the security review of #1950):
`sub` is non-overlapping, so a newly read dotted cue's value can swallow a later glued cue or the
first group of a spaced phone, exactly as the undotted spelling already did. The walls still
refuse both; pinned as `KNOWN_RESIDUAL` in section 7 and tracked as risks-register R62.

WHAT IT STILL DOES NOT READ, pinned as `KNOWN_RESIDUAL` (section 7): a SPACED dot ("Reg . No ."),
a dot after "Num"/"Number", the separators "No: -", an en dash, "No #" and "No.=" (all
pre-existing, named by the security review), and, separately, the salary guard has no résumé
cues, so
"Passport.No. M123456" still records 123456 as pay (split out by the owner on 2026-10-06 as
#2043).

PRE is each rule as #1933 shipped it, frozen in `scripts/measure_cued_id_dot.py`; section 1 pins
that the shipped rules are PRE with exactly #1950's edits, so every "as on PRE" below isolates
#1950. All inputs are fabricated. Stdlib, git and pytest only.
"""

from __future__ import annotations

import importlib.util
import random
import time
from collections import Counter
from collections.abc import Callable
from pathlib import Path

import pytest

import app.pseudonymize as gateway
from app.profiling import lexicon, profile_extractor, signals
from app.pseudonymize import contains_hard_identifier, is_certified_clean, pseudonymize


def _load_script(name: str):
    path = Path(__file__).resolve().parents[1] / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


measure = _load_script("measure_cued_id_dot")
RULES = sorted(measure.linear.RULES)


def under_pre(fn: Callable[..., object], *args: object) -> object:
    """``fn`` with the three rules as #1933 shipped them, nothing else touched."""
    with measure.pre_rules():
        return fn(*args)


# --- 1. the shipped rules are #1933's with exactly #1950's edits ---------------------------------


@pytest.mark.parametrize("name", RULES)
def test_the_shipped_rule_is_pre_with_exactly_the_1950_edits(name):
    shipped = measure.shipped_source(name)
    assert measure.apply_1950(name, measure.PRE_1950[name]) == shipped
    assert measure.PRE_1950[name] != shipped
    assert measure.pre(name).flags == measure.linear.shipped(name).flags


@pytest.mark.parametrize("name", RULES)
def test_the_three_tokens_are_in_every_python_read_copy(name):
    source = measure.shipped_source(name)
    assert r"\.?" in source  # the abbreviation dot, straight after the cue word
    assert "]-?" in source  # the separator may be doubled: ":-", "--"
    assert ("|regn|" in source) == (name != "resume_cued_id")  # "regn" is a credential cue
    compiled = measure.linear.shipped(name)
    assert compiled.search(
        "reg.no.:- 123456" if name != "resume_cued_id" else "passport.no:- m1234567"
    )


def test_the_salary_guard_reads_the_lexicon_copy_both_engines_read():
    # `packages/profiling-lexicon/data/salary.json` is canonical and `lexicon_data/` its mirror
    # (`test_lexicon_parity` pins the bytes); the TypeScript embedding is regenerated from it.
    spec = lexicon.load("salary")["credentialBefore"]
    assert signals._CREDENTIAL_BEFORE_RE.pattern == lexicon.compile_pattern(spec).pattern


# --- 2. the issue's shapes mask, refuse and record no pay ----------------------------------------


@pytest.mark.parametrize(
    ("text", "masked"),
    [
        ("Reg.No.:- 123456", "Reg.No.:- [ID_1]"),  # the issue's headline shape
        ("Reg.No.: MH2019CN4471", "Reg.No.: [ID_1]"),
        ("Reg. No. MH2019CN4471", "Reg. No. [ID_1]"),
        ("Regn. No. MH2019CN4471", "Regn. No. [ID_1]"),
        ("Roll.No-4567890", "Roll.No-[ID_1]"),
        ("Roll.No. 123456", "Roll.No. [ID_1]"),
        ("Cert. No. NAPS/2020/44521", "Cert. No. [ID_1]"),
        ("Regd. No. 123456", "Regd. No. [ID_1]"),
        ("REG.NO.:- 123456", "REG.NO.:- [ID_1]"),
        ("Reg.123456", "Reg.[ID_1]"),
        ("reg no:- 123456", "reg no:- [ID_1]"),  # the separator alone, no dot anywhere
        ("Licence No.-- DL04201100", "Licence No.-- [ID_1]"),
        ("Regn:- 123456", "Regn:- [ID_1]"),
        ("Regn 2019ME4417", "Regn [ID_1]"),  # "regn" alone
        ("NCVT Regn. No.:- R/2019/123456 hai", "NCVT Regn. No.:- [ID_1] hai"),
    ],
)
def test_a_credential_id_after_a_dot_or_a_doubled_separator_masks(text, masked):
    result = pseudonymize(text)
    assert (result.text, result.blocked, result.replaced_entities) == (masked, False, 1)
    assert contains_hard_identifier(text) == "credential_id"
    assert is_certified_clean(text) is False  # the clean-or-withhold walls now withhold it
    sig = signals.detect(text)
    assert (sig.current_salary, sig.expected_salary) == (None, None)
    # On #1933's rules G1/G2 admitted every one of these and the gateway left the ID unmasked
    # (raw, or only its seven digits taken as money by the D-1 carve-out: "Roll.No-[AMOUNT_1]").
    assert "[ID_" not in under_pre(pseudonymize, text).text
    assert under_pre(contains_hard_identifier, text) is None


@pytest.mark.parametrize(
    "text",
    [
        "Passport.No: K1234567",
        "Passport.No. M123456",
        "A/c. No. 12345678",
        "A/c.No.12345678",
        "Voter.ID:- ABC1234567",
        "DOB.:- 12/05/1988",
        "IFSC.: SBIN0001234",
    ],
)
def test_g1_g2_refuses_a_resume_id_after_a_dot_or_a_doubled_separator(text):
    # `_RESUME_CUED_ID_RE` runs in G1/G2 only (ADR-0047 §6); the gateway carries no résumé rule,
    # so its output on these is #1933's, unchanged.
    assert contains_hard_identifier(text) == "credential_id"
    assert under_pre(contains_hard_identifier, text) is None
    assert pseudonymize(text) == under_pre(pseudonymize, text)


def test_the_cases_the_issue_measured_flip_from_pay_to_nothing():
    for text, pay in [
        ("Reg.No.:- 123456", 123456),
        ("Reg.No.: MH2019CN4471", 4471),
        ("Roll.No. 123456", 123456),
        ("Cert. No. NAPS/2020/44521", 44521),
    ]:
        assert under_pre(signals.detect, text).current_salary == pay, text
        assert signals.detect(text).current_salary is None, text


# --- 3. near misses: each decided, each pinned ---------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Reg. Office: Plot 45, MIDC Bhosari",  # no digit in the word after the dot
        "Regd. Office, Pune 411001",  # the number is not behind the cue
        "ITI cert. course 2019 mein kiya",
        "cert. 2019 mein mila",  # four characters: too short for an ID, as without the dot
        "Reg. No. kya hai?",
        "Registration. Kal karunga",
        "Passport. size photo lagaya",
        "Account. Manager tha",
        "a/c. holder ka naam",
        "DOB. pata nahi",
        "Reg..123456",  # two dots: the abbreviation takes one
    ],
)
def test_a_near_miss_is_decided_exactly_as_on_pre(text):
    assert pseudonymize(text) == under_pre(pseudonymize, text)
    assert contains_hard_identifier(text) is None
    assert signals.detect(text) == under_pre(signals.detect, text)


@pytest.mark.parametrize(
    ("dotted", "plain", "masked", "verdict", "pay"),
    [
        (
            "NCVT certificate. 250000 salary",
            "NCVT certificate 250000 salary",
            "NCVT certificate. [ID_1] salary",
            "credential_id",
            None,
        ),
        (
            "NCVT certificate. 25000 milta hai",
            "NCVT certificate 25000 milta hai",
            "NCVT certificate. 25000 milta hai",
            None,
            None,
        ),
        ("cert. 2019-2021", "cert 2019-2021", "cert. [ID_1]", "credential_id", None),
        (
            "Mera licence. 250000 salary chahiye",
            "Mera licence 250000 salary chahiye",
            "Mera licence. [ID_1] salary chahiye",
            "credential_id",
            None,
        ),
    ],
)
def test_DECIDED_the_dot_is_transparent_at_a_sentence_end(dotted, plain, masked, verdict, pay):
    """A cue word that ENDS a sentence, followed by a number, now reads as the abbreviation did.
    Decided, not overlooked (confirmed by the owner on 2026-10-06, #1950): the dot cannot tell
    "certificate." from "Cert.", and #1933 already
    masked a six-character value and dropped any number written straight after a credential cue
    without the dot (the salary guard's PROXIMITY rule). So the dot changes nothing a worker
    could not already hit by leaving it out, the direction is the safe one twice over (masking
    more; recording no pay rather than a wrong one, which is re-askable), and the corpus holds no
    such string. A five-digit wage is not an ID (too short), so only the pay is dropped."""
    for text in (dotted, plain):
        assert pseudonymize(text).blocked is False, text
        assert contains_hard_identifier(text) == verdict, text
        sig = signals.detect(text)
        assert (sig.current_salary, sig.expected_salary) == (pay, None), text
    assert pseudonymize(dotted).text == masked
    assert pseudonymize(plain).text == masked.replace(". ", " ", 1)


def test_DECIDED_a_short_roll_number_after_a_doubled_separator_is_not_pay():
    # Five characters stay too short for an ID, exactly as "roll no 12345" (#1933's negative), so
    # nothing masks. But the salary guard now reads the ":-" and drops 12345 as pay, as it always
    # dropped it after "roll no 12345": a roll number is not a wage.
    text = "roll no.:- 12345"
    assert pseudonymize(text).text == text
    assert contains_hard_identifier(text) is None
    assert under_pre(signals.detect, text).current_salary == 12345
    assert signals.detect(text).current_salary is None
    assert signals.detect("roll no 12345").current_salary is None


def test_a_wage_beside_a_dotted_cue_is_kept():
    text = "abhi 25000 milta hai, 35000 chahiye, NCVT certificate. hai"
    sig = signals.detect(text)
    assert (sig.current_salary, sig.expected_salary) == (25000, 35000)


# --- 4. over-mask over the repo corpus (#1875's method) ------------------------------------------


@pytest.fixture(scope="module")
def corpus() -> list[str]:
    parts = measure.corpus()
    strings = measure.distinct(parts)
    assert len(strings) > 30_000, {name: len(texts) for name, texts in parts.items()}
    return strings


@pytest.fixture(scope="module")
def cue_bearing(corpus) -> list[str]:
    texts = measure.cue_bearing(corpus)
    assert len(texts) > 2_000, len(texts)
    return texts


def test_no_corpus_string_changes_a_decision(cue_bearing):
    """Every cue-bearing string of the repo's tracked text, in each of `measure.VIEWS` (as written,
    whitespace stretched, separators spaced, upper-cased): the masked values, G1/G2's verdict and
    the salary guard's verdict on every slice equal PRE's. Measured 2026-10-06 on the branch
    rebased onto main: 0 of 2,646 in every view (0 of 2,603 on 2026-10-03), so the widening costs
    nothing the corpus can see. The floors show the rules met
    cued values. `measure_cued_id_dot.py overmask` runs the same strings end to end."""
    rules = measure.variants()
    moved: list[str] = []
    seen: Counter[str] = Counter()
    for text in cue_bearing:
        for view in (transform(text) for transform in measure.VIEWS.values()):
            shipped = measure.decisions(rules["shipped"], view)
            if measure.decisions(rules["pre"], view) != shipped:
                moved.append(view[:100])
            seen["masked"] += bool(shipped[0])
            seen["refused by G1/G2's résumé rule"] += shipped[1]
            seen["a guard slice dropped"] += any(shipped[2])
    assert moved == [], moved[:10]
    assert seen["masked"] > 25, seen
    assert seen["refused by G1/G2's résumé rule"] > 15, seen
    assert seen["a guard slice dropped"] > 10, seen


def test_end_to_end_no_cued_corpus_string_changes(cue_bearing):
    """Every view on which any of the six rules (PRE's and shipped) matches: `pseudonymize`,
    `contains_hard_identifier` and `signals.detect` each give PRE's result."""
    rules = measure.variants()

    def matched(text: str) -> bool:
        decided = (measure.decisions(patterns, text) for patterns in rules.values())
        return any(values or refused or any(guard) for values, refused, guard in decided)

    views = [
        view
        for text in cue_bearing
        for view in (transform(text) for transform in measure.VIEWS.values())
        if matched(view)
    ]
    assert len(views) > 100, len(views)
    assert measure.changes(views) == []


def test_no_certifier_label_changes_outcome():
    """#1891's certifier set (the vocabulary and both lexicon copies, as written, UPPER and Title)
    through `is_certified_clean`, `certify_value` and `certified_clean_skill_labels`."""
    labels = measure.certifier_labels(measure.employer_corpus())
    assert len(labels) > 4_000, len(labels)
    assert measure.certifier_moves(labels) == []


# --- 5. only more, attributed, transparent: a seeded fuzz of cue lines ---------------------------


def test_property_shipped_only_ever_decides_more_and_only_on_a_new_shape():
    """20,000 samples of #1933's generator (`cue_line_parts`, which now writes the dot and "regn").
    No sample loses an identifier character, a G1/G2 refusal or a guard drop (the characters PRE
    masks and shipped does not are only connector text PRE swallowed into a value, "NO--" in
    "NO--abc9"); every sample whose decisions move holds a new shape. The generator joins its one
    to three cue lines with a space, so no cue is ever glued to the previous value by "/" or "-"
    and none is followed by a spaced phone: this says nothing about those shapes. See the R62
    residual in section 7."""
    rules = measure.variants()
    rng = random.Random(1950)
    seen: Counter[str] = Counter()
    for _ in range(20_000):
        text = measure.linear.sample(rng)
        assert measure.only_more(text, rules) == [], text
        if measure.decisions(rules["pre"], text) != measure.decisions(rules["shipped"], text):
            seen["moved"] += 1
            assert measure.NEW_SHAPE.search(text), text
        seen["masked"] += bool(measure.masked_spans(rules["shipped"]["credential_id"], text))
    assert seen["moved"] > 1_500, seen
    assert seen["masked"] > 1_200, seen


def test_property_the_dot_regn_and_the_doubled_separator_are_transparent():
    """Over 20,000 seeded lines: written with "." after the cue word, with "regn" for "reg", or with
    the separator doubled, each line decides as it did without, wherever the line did not already
    hold the shape (`measure.twins`). The one exception is #1933's own: a doubled dash that the
    rule reads INSIDE a value run can lengthen it, and there PRE decides the twin exactly as
    shipped does."""
    rules = measure.variants()
    rng = random.Random(1950)
    seen: Counter[str] = Counter()
    for _ in range(20_000):
        for kind, line, at, insert in measure.twins(rng):
            seen[kind] += 1
            if measure.transparent(rules["shipped"], line, at, insert):
                continue
            twin = line[:at] + insert + line[at:]
            assert kind == "separator", (kind, line)
            assert measure.decisions(rules["pre"], twin) == measure.decisions(
                rules["shipped"], twin
            ), (line, twin)
            seen["value run"] += 1
    assert seen["dot"] > 15_000, seen
    assert seen["separator"] > 5_000, seen
    assert seen["regn"] > 400, seen
    assert seen["value run"] < seen["separator"] // 100, seen


# --- 6. the new tokens keep the rules linear ----------------------------------------------------

# The 750 ms ceiling of `test_pseudonymize_cued_id_linear` (#1941: timing tests get a generous,
# explicit budget). Measured 2026-10-03, min of 3: every input below at the size cap took 2-21 ms
# in `pseudonymize`, `contains_hard_identifier` and the salary guard. The structural tests above
# and #1933's are the real guard; this is the backstop.
_REDOS_BUDGET_MS = 750


def _elapsed_ms(fn: Callable[[str], object], text: str) -> float:
    start = time.perf_counter()
    fn(text)
    return (time.perf_counter() - start) * 1000


@pytest.mark.parametrize("label", sorted(measure.TIMING_INPUTS))
@pytest.mark.parametrize("entry", sorted(measure.ENTRY_POINTS))
def test_the_new_tokens_stay_linear_at_the_size_cap(label, entry):
    text = measure.TIMING_INPUTS[label]
    assert len(text) <= gateway.DEFAULT_MAX_LENGTH
    elapsed_ms = _elapsed_ms(measure.ENTRY_POINTS[entry], text)
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms on {label}"


@pytest.mark.parametrize("cue", ["Reg.", "reg no:-", "Regn.:-"])
def test_the_salary_detector_stays_linear_after_a_dotted_cue(cue):
    # At the size cap the extractor's time is the salary matcher's own scan (R55 (b), about 6 s
    # under PRE and shipped alike), so the run here is #1933's 1,000 spaces.
    text = cue + " " * measure.EXTRACT_RUN + "!5000"
    elapsed_ms = _elapsed_ms(profile_extractor.extract, text)
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms"
    # Whitespace and "!" are no identifier, so 5000 is still money.
    assert signals.detect(text).current_salary == 5000


# --- 7. what #1950 does not read -----------------------------------------------------------------


@pytest.mark.parametrize("text", ["Reg . No . 123456", "Reg. Num. 123456", "Regn. Number. 123456"])
def test_KNOWN_RESIDUAL_a_spaced_dot_or_a_dot_after_num_is_not_read(text):
    """Not read by #1950, on purpose and recorded in R56's resolution. The dot is read where print
    puts it, straight after the cue word and after "no"; a dot with a space BEFORE it, or after
    "Num"/"Number", is not a connector token, so the ID stays raw, G1/G2 admits it and its digits
    are pay. Reading "\\s*\\." would add a whitespace quantifier in front of a token (linear, but a
    new #1933-class review), and neither shape is in the corpus."""
    assert pseudonymize(text).text == text
    assert contains_hard_identifier(text) is None
    assert signals.detect(text).current_salary == 123456


def test_KNOWN_RESIDUAL_the_salary_guard_has_no_resume_cue():
    """R56's adjacent finding, split out by the owner on 2026-10-06 as #2043: `credentialBefore`
    holds the credential cues only, so a passport number G1/G2 refuses is still recorded as pay.
    Unchanged by #1950, which reads the dot in the guard but adds no cue to it."""
    text = "Passport.No. M123456"
    assert contains_hard_identifier(text) == "credential_id"
    assert signals.detect(text).current_salary == 123456
    assert signals.detect("Passport No. M123456").current_salary == 123456


@pytest.mark.parametrize(
    "text", ["Reg No: - 123456", "Reg. No. – 123456", "Reg No #123456", "Reg.No.=123456"]
)
def test_KNOWN_RESIDUAL_a_spaced_dash_an_en_dash_a_hash_or_an_equals_is_not_read(text):
    """Named by the security review of #1950, pre-existing and unchanged by it: the connector reads
    one ":" or "-" (now with an optional "-" after it), so a separator written "No: -", with an en
    dash (Word's autocorrect), as "No #" or as "No.=" never reaches the value, on PRE and here
    alike. The ID stays raw, G1/G2 admits it and its digits are pay. Recorded in R56."""
    for decide in (lambda fn, t: fn(t), under_pre):
        assert decide(pseudonymize, text).text == text
        assert decide(contains_hard_identifier, text) is None
        assert decide(signals.detect, text).current_salary == 123456


@pytest.mark.parametrize(
    ("dotted", "undotted", "masked_pre", "masked", "verdict"),
    [
        (
            "Cert. NAPS/2020/reg: 445566",
            "Cert NAPS/2020/reg: 445566",
            "Cert. NAPS/2020/reg: [ID_1]",
            "Cert. [ID_1]: 445566",
            "credential_id",
        ),
        (
            "Licence. 098765 43210",
            "Licence 098765 43210",
            "Licence. [PHONE_1]",
            "Licence. [ID_1] 43210",
            "phone",
        ),
    ],
)
def test_KNOWN_RESIDUAL_r62_masked_text_is_not_monotone_across_cues(
    dotted, undotted, masked_pre, masked, verdict
):
    """Risks-register R62, found by the security review of #1950. The gateway's `sub` is
    non-overlapping and the cued-ID rule runs before the phone rule, so a cue's value runs to the
    end of its token and takes a later cue glued on by "/" (whose own ID is then never matched), or
    the first group of a spaced phone. On PRE the dotted spelling was not read, so the later cue or
    the phone rule masked the digits; now the dot reads as the undotted spelling always did, and
    leaves the same tail raw. The walls are untouched: G1/G2 refuses all four texts."""
    assert under_pre(pseudonymize, dotted).text == masked_pre
    assert pseudonymize(dotted).text == masked
    undotted_masked = masked.replace(". ", " ", 1)
    assert pseudonymize(undotted).text == undotted_masked
    assert under_pre(pseudonymize, undotted).text == undotted_masked
    for text in (dotted, undotted):
        assert contains_hard_identifier(text) == verdict
        assert under_pre(contains_hard_identifier, text) == verdict


# --- 8. the script measures these rules ----------------------------------------------------------


def test_the_script_restores_the_shipped_rules():
    shipped = {name: measure.linear.shipped(name) for name in measure.linear.RULES}
    with pytest.raises(RuntimeError), measure.pre_rules():
        assert gateway._CREDENTIAL_ID_RE.pattern == measure.PRE_1950["credential_id"]
        assert gateway._RESUME_CUED_ID_RE.pattern == measure.PRE_1950["resume_cued_id"]
        assert "regn" not in signals._CREDENTIAL_BEFORE_RE.pattern
        raise RuntimeError
    assert {name: measure.linear.shipped(name) for name in measure.linear.RULES} == shipped


def test_an_edit_that_no_longer_lands_fails_loudly():
    with pytest.raises(ValueError):
        measure.apply_1950("credential_id", measure.PRE_1950["resume_cued_id"])


def test_the_corpus_leaves_both_cued_id_test_files_out():
    listed = {path.name for paths in measure.linear.corpus_files().values() for path in paths}
    assert "test_pseudonymize_cued_id_dot.py" not in listed
    assert "test_pseudonymize_cued_id_linear.py" not in listed
    assert "test_pseudonymize.py" in listed  # the rest of the service's tests are read
