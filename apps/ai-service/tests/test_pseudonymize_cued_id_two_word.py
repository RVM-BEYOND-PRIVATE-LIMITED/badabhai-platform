"""Issue #2091 (risks-register R56): the cued-ID connector reads a two-word label.

THE DEFECT. The connector between a cue and its value read ONE number word ("no", "number",
"num", "#"; the résumé rule and the salary guard also "id"), so a label written as two words never
reached its value. "Voter ID No: XYZ9876543", the label printed on the EPIC card, and "IFSC code
HDFC0004321", how bank details are written on a résumé, passed the G1/G2 floor (ADR-0047 §6)
under both `AI_RAW_PII_ENABLED` postures, and the salary detector recorded their digits as pay
(9876543, 4321). The gateway's `_CREDENTIAL_ID_RE` had no "id" word at all, so "Registration ID
123456" stayed raw in the at-rest copies and the embedding input, and G1/G2 admitted it too.

THE FIX, in all five copies (`_CREDENTIAL_ID_RE`, `_RESUME_CUED_ID_RE`, lexicon `credentialBefore`
and its mirror, the two TypeScript ports in `resume-parse-gates.ts`): in front of the number word
the connector reads up to two label words, in a fixed order, "id", then "card" or "code". So "ID
No", "ID Number", "Card No", "ID Card No", "Code" and "ID" read. Owner ruling 2026-10-08: these
three words, in all five copies. Each word is its own optional token with its own trailing `\\s*`,
#1933's fold, so the rules stay linear (R54). The language only grows, so every verdict only grows.

WHAT IS MEASURED (`scripts/measure_cued_id_two_word.py`). PRE is each rule as it shipped before
#2091, and section 1 pins that shipped is PRE with exactly #2091's edits. Sections 2-4 pin the
shapes, the near misses and the residuals, each against PRE. Section 5 is #1875's over-mask method
over the repo corpus and the certifier labels: nothing moves. Section 6 fuzzes cue lines with label
phrases: nothing decides less, every move holds a label word, and #1933's fold still holds.
Section 7 times the new tokens at the size cap. The V8 copies are pinned in
`resume-parse-gates.linear.test.ts` and `salary-credential-guard.test.ts`. All inputs are
fabricated.
"""

from __future__ import annotations

import importlib.util
import random
import time
from collections import Counter
from pathlib import Path

import pytest

import app.pseudonymize as gateway
from app.profiling import profile_extractor, signals
from app.pseudonymize import contains_hard_identifier, pseudonymize


def _load_script(name: str):
    path = Path(__file__).resolve().parents[1] / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


measure = _load_script("measure_cued_id_two_word")
RULES = sorted(measure.PRE_2091)


def pay(text: str) -> tuple[object, object]:
    sig = signals.detect(text)
    return sig.current_salary, sig.expected_salary


def under_pre(fn, *args):
    with measure.pre_rules():
        return fn(*args)


# --- 1. the shipped rules are PRE with exactly #2091's edits --------------------------------------


@pytest.mark.parametrize("name", RULES)
def test_the_shipped_rule_is_pre_with_exactly_the_2091_edits(name):
    shipped = measure.shipped_source(name)
    assert measure.apply_2091(name, measure.PRE_2091[name]) == shipped
    assert measure.PRE_2091[name] != shipped
    assert measure.pre(name).flags == measure.linear.shipped(name).flags


@pytest.mark.parametrize("name", RULES)
def test_every_python_read_copy_carries_the_one_connector(name):
    source = measure.shipped_source(name)
    assert measure.LABELS_2091 in source
    assert "|id|" not in source  # "id" left the "no"-word group for the first label slot


# --- 2. the shapes now read -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "digits"),
    [
        ("Voter ID No: XYZ9876543", 9876543),
        ("voter id no XYZ9876543", 9876543),
        ("IFSC code HDFC0004321", 4321),
    ],
)
def test_the_cases_the_issue_measured_flip_from_admitted_and_pay_to_refused(text, digits):
    assert under_pre(contains_hard_identifier, text) is None
    assert under_pre(pay, text) == (digits, None)
    assert contains_hard_identifier(text) == "credential_id"
    assert pay(text) == (None, None)


@pytest.mark.parametrize(
    "text",
    [
        "Voter ID Number ABC1234567",
        "Voter Card No. ABC1234567",
        "Voter ID Card No. ABC1234567",
        "voter id  card  no:- ABC1234567",
        "IFSC Code: SBIN0001234",
        "Passport ID No. M1234567",
    ],
)
def test_g1_g2_refuses_a_resume_id_after_a_two_word_label(text):
    # The gateway leaves these to its other rules (the money carve-out masks "1234567"); G1/G2 and
    # the salary guard read the résumé cue.
    assert under_pre(contains_hard_identifier, text) is None
    assert contains_hard_identifier(text) == "credential_id"
    assert pay(text) == (None, None)


@pytest.mark.parametrize(
    ("text", "masked", "pre_pay"),
    [
        ("Registration ID 123456", "Registration ID [ID_1]", None),
        ("Enrollment ID No: 2019AB12345", "Enrollment ID No: [ID_1]", 12345),
        ("Reg. Code: MH2019CN4471", "Reg. Code: [ID_1]", 4471),
        ("Certificate ID No. NAPS/2020/44521", "Certificate ID No. [ID_1]", 44521),
        ("roll code 4567890", "roll code [ID_1]", 4567890),
    ],
)
def test_a_credential_id_after_a_label_word_masks_and_is_not_pay(text, masked, pre_pay):
    before = under_pre(pseudonymize, text)
    assert "[ID_" not in before.text
    assert under_pre(contains_hard_identifier, text) is None
    assert under_pre(pay, text) == (pre_pay, None)
    result = pseudonymize(text)
    assert (result.text, result.blocked) == (masked, False)
    assert contains_hard_identifier(text) == "credential_id"
    assert pay(text) == (None, None)


def test_DECIDED_a_block_can_become_a_mask():
    """ "Licence ID DL04201100" was BLOCKED: the cued rule did not read "ID", so the residual net
    tripped on the eight raw digits. It is now masked as an ID and the turn goes on. The digits
    never egress either way; what goes away is the accidental block, as #2049 decided for a run a
    value grows through (the fuzz below counts these)."""
    before = under_pre(pseudonymize, "Licence ID DL04201100")
    assert (before.text, before.blocked) == ("Licence ID DL04201100", True)
    result = pseudonymize("Licence ID DL04201100")
    assert (result.text, result.blocked) == ("Licence ID [ID_1]", False)
    assert contains_hard_identifier("Licence ID DL04201100") == "credential_id"


def test_connector_text_pre_swallowed_into_a_value_is_read_as_the_connector():
    # PRE could not read "code", so the value started on it; shipped reads it and masks the ID.
    # No digit is unmasked, and G1/G2 refuses under both.
    text = "cert code123456 hai"
    assert under_pre(pseudonymize, text).text == "cert [ID_1] hai"
    assert pseudonymize(text).text == "cert code[ID_1] hai"
    assert contains_hard_identifier(text) == under_pre(contains_hard_identifier, text)


def test_a_wage_beside_a_two_word_label_is_kept():
    text = "abhi 25000 milta hai, IFSC code SBIN0001234"
    assert pay(text) == (25000, None)
    assert contains_hard_identifier(text) == "credential_id"


# --- 3. the near misses are decided exactly as on PRE ---------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Voter ID card banwana hai",
        "ID card hai mere paas",
        "IFSC code ke saath 25000 salary aati hai",
        "Account Code Manager",
        "registration id 2019",
        "certificate id hai, 25000 milta hai",
        "Mera card 18000 ka recharge",
        "voter id card 2019 mein bana",
        "code 25000 salary",
        "reg id12345",
    ],
)
def test_a_near_miss_is_decided_exactly_as_on_pre(text):
    assert measure.outcome(text) == under_pre(measure.outcome, text)


@pytest.mark.parametrize(
    ("text", "wage"),
    [
        ("IFSC code ke saath 25000 salary aati hai", 25000),
        ("certificate id hai, 25000 milta hai", 25000),
        ("Mera card 18000 ka recharge", 18000),
    ],
)
def test_a_wage_after_a_label_with_words_in_between_is_still_pay(text, wage):
    assert pay(text) == (wage, None)
    assert contains_hard_identifier(text) is None


# --- 4. residuals ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "digits"),
    [
        ("Voter Card ID No. ABC1234567", 1234567),  # the label words out of order
        ("Voter I.D. No. ABC1234567", 1234567),  # a dotted "I.D."
        ("EPIC No: XYZ9876543", 9876543),  # "EPIC" is no cue
        ("PF No: MH/BAN/12345/678", 12345),  # "PF" is no cue ("provident fund" is)
    ],
)
def test_KNOWN_RESIDUAL_a_label_out_of_order_dotted_or_without_a_cue_is_not_read(text, digits):
    """Recorded in R56's resolution. G1/G2 admits each and its digits are pay, on PRE and shipped
    alike. None is in the corpus. Reading "card id" or "i.d." is a wider connector; "EPIC" and "PF"
    are new cues, each a measurement of its own (#2043 measured the résumé cues one by one)."""
    assert contains_hard_identifier(text) is None
    assert pay(text) == (digits, None)
    assert measure.outcome(text) == under_pre(measure.outcome, text)


# --- 5. #1875's over-mask method: nothing in the repo corpus or the certifier labels moves --------


@pytest.fixture(scope="module")
def cue_bearing() -> list[str]:
    strings = measure.distinct(measure.dot.corpus())
    assert len(strings) > 30_000, len(strings)
    texts = measure.dot.cue_bearing(strings)
    assert len(texts) > 2_000, len(texts)
    return texts


def _rule_decisions(rules, text: str) -> tuple[object, ...]:
    return (
        [m.span(1) for m in rules["credential_id"].finditer(text)],
        bool(rules["resume_cued_id"].search(text)),
        [bool(rules["credential_before"].search(p)) for p in measure.linear.guard_slices(text)],
    )


def test_no_corpus_string_changes_a_rule_decision_in_any_view(cue_bearing):
    """Each rule's matches and the guard's verdict on every slice, PRE against shipped, over every
    cue-bearing corpus string in #1950's four views. The floors show cued values were met."""
    pre = {name: measure.pre(name) for name in RULES}
    shipped = {name: measure.linear.shipped(name) for name in RULES}
    seen: Counter[str] = Counter()
    moved = []
    for transform in measure.dot.VIEWS.values():
        for text in map(transform, cue_bearing):
            decided = _rule_decisions(shipped, text)
            if _rule_decisions(pre, text) != decided:
                moved.append(text[:90])
            seen["a credential value"] += bool(decided[0])
            seen["a résumé refusal"] += decided[1]
            seen["a guard drop"] += any(decided[2])
    assert moved == [], moved[:10]
    assert seen["a credential value"] > 60, seen
    assert seen["a résumé refusal"] > 50, seen
    assert seen["a guard drop"] > 100, seen


def test_end_to_end_no_cued_corpus_string_changes(cue_bearing):
    """`pseudonymize`, `contains_hard_identifier` and `signals.detect` as written; the script runs
    all four views (`overmask`)."""
    assert measure.changes(cue_bearing) == []


def test_no_certifier_label_changes_outcome():
    labels = measure.certifier_labels(measure.employer_corpus())
    assert len(labels) > 4_000, len(labels)
    assert measure.certifier_moves(labels) == []


# --- 6. a seeded fuzz of cue lines with label phrases ---------------------------------------------


def test_property_only_more_only_on_a_label_word_and_still_folded():
    """4,000 samples of the script's generator (`measure.sample`: #1933's cue lines, the "no"-word
    slot a label phrase half of the time). No sample loses a masked offset (but connector text PRE
    swallowed into a value), a G1/G2 refusal or a guard drop; every sample whose decisions move
    holds a label word; and each rule matches exactly as its unfolded twin, #1933's property on the
    new tokens. The script runs 60,000."""
    rng = random.Random(2091)
    seen: Counter[str] = Counter()
    for _ in range(4_000):
        text = measure.sample(rng)
        verdict = measure.judge(text)
        assert not verdict["less"], text
        assert not verdict["fold broken"], text
        if verdict["moved"]:
            seen["moved"] += 1
            assert measure.NEW_SHAPE.search(text), text
        seen["block became a mask"] += verdict["block became a mask"]
    assert seen["moved"] > 200, seen


def test_the_loss_check_fires_the_other_way_round():
    """Sensitivity: with shipped as the baseline and PRE as the candidate, the checks `judge` runs
    report the loss on a line the label words read, so their silence above means something."""
    text = "Registration ID 123456"
    (shipped_mask, _), shipped_verdict, _ = measure.decisions(text)
    (pre_mask, _), pre_verdict, _ = under_pre(measure.decisions, text)
    assert measure.lost_offsets(text, shipped_mask, pre_mask) == ["123456"]
    assert measure.lost_offsets(text, pre_mask, shipped_mask) == []
    assert (shipped_verdict, pre_verdict) == ("credential_id", None)


# --- 7. linear at the size cap --------------------------------------------------------------------

#: #1933's budget (`test_pseudonymize_cued_id_linear.py`): a super-linear connector costs seconds
#: at these lengths, and a linear one a few ms, with room for a contended runner.
_BUDGET_MS = 750


@pytest.mark.parametrize("entry", sorted(measure.ENTRY_POINTS))
@pytest.mark.parametrize("shape", sorted(measure.TIMING_INPUTS))
def test_the_label_words_stay_linear_at_the_size_cap(shape, entry):
    text = measure.TIMING_INPUTS[shape]
    assert len(text) <= gateway.DEFAULT_MAX_LENGTH
    elapsed_ms = measure._once_ms(measure.ENTRY_POINTS[entry], text)
    assert elapsed_ms < _BUDGET_MS, f"{elapsed_ms:.0f}ms"


@pytest.mark.parametrize("cue", ["voter id card no", "IFSC code", "reg id"])
def test_the_salary_detector_stays_linear_after_a_label(cue):
    text = cue + " " * measure.EXTRACT_RUN + "!5000"
    started = time.perf_counter()
    profile_extractor.extract(text)
    elapsed_ms = (time.perf_counter() - started) * 1000
    assert elapsed_ms < _BUDGET_MS, f"{elapsed_ms:.0f}ms"
    assert signals.detect(text).current_salary == 5000  # whitespace and "!" are no identifier


# --- 8. the script measures these rules -----------------------------------------------------------


def test_the_script_restores_the_shipped_rules():
    shipped = {name: measure.linear.shipped(name) for name in measure.linear.RULES}
    with pytest.raises(RuntimeError), measure.pre_rules():
        assert gateway._CREDENTIAL_ID_RE.pattern == measure.PRE_2091["credential_id"]
        assert gateway._RESUME_CUED_ID_RE.pattern == measure.PRE_2091["resume_cued_id"]
        assert "card" not in signals._CREDENTIAL_BEFORE_RE.pattern
        raise RuntimeError
    assert {name: measure.linear.shipped(name) for name in measure.linear.RULES} == shipped


def test_an_edit_that_no_longer_lands_fails_loudly():
    with pytest.raises(ValueError):
        measure.apply_2091("credential_id", measure.PRE_2091["resume_cued_id"])


def test_the_corpus_leaves_this_file_out():
    listed = {path.name for paths in measure.linear.corpus_files().values() for path in paths}
    assert "test_pseudonymize_cued_id_two_word.py" not in listed
    assert "test_pseudonymize.py" in listed  # the rest of the service's tests are read
