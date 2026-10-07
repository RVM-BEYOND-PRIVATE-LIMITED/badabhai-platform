"""Issue #1933 — the cued-ID rules do linear work on a whitespace run (risks-register R54).

THE DEFECT: `_CREDENTIAL_ID_RE` and `_RESUME_CUED_ID_RE` read the gap between the cue and the
value as `\\s*(?:no\\.?|number|num|#)?\\s*[:\\-]?\\s*`, three whitespace quantifiers with only
optional tokens between them. A cue followed by a whitespace run that then fails the digit
lookahead tried every split of the run among the three, O(k^3): `pseudonymize("reg" + " " * 800 +
"!")` took 1.6-6.0 s and `contains_hard_identifier("passport" + " " * 800 + "!")` 3.5-9.1 s
(2026-10-03, shared machine), far under `DEFAULT_MAX_LENGTH`, inline in `async def`. The salary
detector's credential guard (`signals._CREDENTIAL_BEFORE_RE`, lexicon `credentialBefore`) had the
same connector: `profile_extractor.extract("reg" + " " * 800 + "!5000")` took 2.6-7.9 s.

THE FIX: each whitespace quantifier is folded into the optional token it follows,
`\\s*(?:(?:no\\.?|number|num|#)\\s*)?(?:[:\\-]\\s*)?`. The "no" word and the separator never start
with whitespace, so after the leading `\\s*` a run has one reading, and the work is linear.

WHY NO MATCH MOVES, ON ANY INPUT: the two connectors accept the same strings, and a backtracking
engine tries value starts in the same priority order under both; main's form only adds repeats of
starts it already tried, or starts on whitespace, which the value's first character `[A-Za-z0-9]`
can never take. What follows the connector reads only the value start. Sections 2 and 3 measure
that rather than trust it, span for span against main over the repo corpus and a seeded fuzz of
cue lines; section 4 checks it end to end through `pseudonymize`, `contains_hard_identifier`
(G1/G2, ADR-0047 §6) and the salary detector. MAIN is each shipped rule with main's connector put
back and nothing else touched (`scripts/measure_cued_id_linear.py`, which also reproduces the
full-corpus and timing numbers; section 5 keeps it measuring these rules).

SINCE #1950 (R56) THE ORACLE IS CALLED UNFOLDED. #1950 added `-?` after the separator, so a
":-" reads, and the oracle carries that token too: the connector written main's way, each
whitespace quantifier standing alone, `\\s*(?:no\\.?|number|num|#)?\\s*(?:[:\\-]-?)?\\s*`. So these
sections still measure the folding and nothing else. #1950's other tokens (the `\\.?` after the cue
word, the "regn" cue) sit outside the connector, so the swap keeps them. What #1950 itself changed
is measured against the #1933 rule text in `test_pseudonymize_cued_id_dot.py`. The mutation counts
below were measured on #1933's text.

Each section was seen to FAIL against a mutation (re-measured 2026-10-03; failures of this file's
48). Main's connector back in all three copies: 43, including all 13 timing tests. Back in
`_RESUME_CUED_ID_RE` only: 30 (its 3 timing tests). Back in the lexicon mirror only: 29 (the
extractor's timing test). `_RESUME_CUED_ID_RE` linear but semantically different, with no `\\s*`
after the separator or no `id` word: 27 each, and the shared hard-identifier fixture in
`test_resume_parse` fails too. Each of those also breaks the oracle, which can no longer put
main's text back, so sections 2-4 were also run with the rules intact and the ORACLE's connector
changed, in the script and in `_UNFOLDED_CONNECTORS` alike (no `\\s*` before the separator, in all
three: 8; no `id`: 4). The corpus, the fuzz, the end-to-end run and the known cases each fail on a
real span difference. The two corpus tests in section 5 fail on the script before it read the
shared, tracked-only corpus. Stdlib, git and pytest only. All inputs are fabricated.
"""

from __future__ import annotations

import importlib.util
import random
import re
import time
import uuid
from collections import Counter
from collections.abc import Callable
from pathlib import Path

import pytest

import app.pseudonymize as gateway
from app.profiling import lexicon, profile_extractor, signals
from app.pseudonymize import (
    certified_clean_skill_labels,
    certify_value,
    contains_hard_identifier,
    is_certified_clean,
    pseudonymize,
)


def _load_measure_script():
    path = Path(__file__).resolve().parents[1] / "scripts" / "measure_cued_id_linear.py"
    spec = importlib.util.spec_from_file_location("measure_cued_id_linear", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


measure = _load_measure_script()
_ZWSP = "\u200b"

#: The connector written main's way (pre-#1933), carrying #1950's `-?`: the oracle's one
#: difference from the shipped rules.
_UNFOLDED_CONNECTORS = {
    "credential_id": r"\s*(?:no\.?|number|num|#)?\s*(?:[:\-]-?)?\s*",
    "resume_cued_id": r"\s*(?:no\.?|number|num|id|#)?\s*(?:[:\-]-?)?\s*",
    "credential_before": r"\s*(?:no\.?|number|num|id|#)?\s*(?:[:-]-?)?\s*",  # "id" since #2043
}
#: What follows the connector in each rule: the value's lookahead, or the guard's identifier tail.
_VALUE_AFTER = {
    "credential_id": r")(?=[A-Za-z0-9/\-]{0,",
    "resume_cued_id": r"(?=[A-Za-z0-9/\-]{0,",
    "credential_before": r"[A-Za-z0-9/-]{0,20}$",
}


# --- 1. the connector is linear -----------------------------------------------------------------


@pytest.mark.parametrize("name", sorted(measure.RULES))
def test_the_connector_folds_each_whitespace_run_into_the_token_it_follows(name):
    shipped = measure.shipped(name)
    _module, _attribute, unfolded_connector, linear = measure.RULES[name]
    assert unfolded_connector == _UNFOLDED_CONNECTORS[name]
    assert unfolded_connector not in shipped.pattern
    # The linear connector, and nothing after it but the value: a trailing `\s*` would put a
    # second whitespace quantifier back beside the first.
    assert linear + _VALUE_AFTER[name] in shipped.pattern
    # The oracle is the shipped rule with the unfolded connector, and nothing else, put back.
    oracle = measure.variant(name, "unfolded")
    assert oracle.pattern == shipped.pattern.replace(linear, unfolded_connector) != shipped.pattern
    assert oracle.flags == shipped.flags


def test_the_lexicon_copy_is_the_one_both_engines_read():
    # `packages/profiling-lexicon/data/salary.json` is canonical and `lexicon_data/` its mirror
    # (`test_lexicon_parity` pins the bytes). Read through the loader, the shipped source holds the
    # linear connector, so the TypeScript `CREDENTIAL_BEFORE` compiles the same text.
    source = lexicon.load("salary")["credentialBefore"]["source"]
    linear = measure.RULES["credential_before"][3]
    assert linear + _VALUE_AFTER["credential_before"] in source


# Generous ceiling, after `_REDOS_BUDGET_MS` in `test_pseudonymize_title_employer_bound` (750 ms;
# its 250 ms predecessor flaked on a loaded laptop). Measured 2026-10-03 on these inputs: main
# seconds (800 spaces took 1.6-9.7 s), the linear connector a few ms. The structural test above is
# the real guard; these are the backstop. A run with no "no" word stops at `_RUN`, well short of
# the size cap, because main's cubic cost there would not finish (1,600 spaces took 13-20 s).
_REDOS_BUDGET_MS = 750
_RUN = 1_000


def _to_the_cap(cue: str) -> str:
    """A cue, then whitespace up to the size cap, then "!". After a "no" word main's connector had
    only two quantifiers left, O(k^2): at this length it took 3.4 s ("roll no") and 4.8 s ("a/c
    no") in the rule alone (2026-10-03), so the run must be this long for the budget to see it."""
    return cue + " " * (gateway.DEFAULT_MAX_LENGTH - len(cue) - 1) + "!"


def _elapsed_ms(fn: Callable[[str], object], text: str) -> float:
    start = time.perf_counter()
    fn(text)
    return (time.perf_counter() - start) * 1000


@pytest.mark.parametrize(
    "text",
    [
        "reg" + " " * _RUN + "!",  # the issue's measured case
        "registration ka" + " " * _RUN + "!",  # through the possessive slot
        _to_the_cap("roll no"),  # after the "no" word
        "certificate" + " \t\n" * (_RUN // 3) + "!",  # mixed whitespace
        "licence" + " " * (_RUN - 1) + _ZWSP + "!",  # #1738's two views each run the rule
    ],
    ids=["reg", "possessive", "no-word", "mixed-whitespace", "two-views"],
)
def test_pseudonymize_is_linear_on_a_whitespace_run_after_a_cue(text):
    elapsed_ms = _elapsed_ms(pseudonymize, text)
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms on {len(text)} chars"
    # Behaviour is unchanged: no value follows the cue, so nothing masks and nothing blocks.
    result = pseudonymize(text)
    assert (result.blocked, result.replaced_entities) == (False, 0)


@pytest.mark.parametrize(
    "text",
    [
        "passport" + " " * _RUN + "!",
        "date of birth" + " " * _RUN + "!",
        _to_the_cap("a/c no"),
        "reg" + " " * _RUN + "!",
    ],
    ids=["passport", "date-of-birth", "a/c-no", "reg"],
)
def test_contains_hard_identifier_is_linear_on_a_whitespace_run_after_a_cue(text):
    # G1/G2: the output floor and the résumé value certifier (ADR-0047 §6).
    elapsed_ms = _elapsed_ms(contains_hard_identifier, text)
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms on {len(text)} chars"
    assert contains_hard_identifier(text) is None


_WALLS = {
    "is_certified_clean": is_certified_clean,
    "certify_value": certify_value,
    "certified_clean_skill_labels": lambda text: certified_clean_skill_labels([text]),
}


@pytest.mark.parametrize("wall", sorted(_WALLS))
def test_every_clean_or_withhold_wall_is_linear_too(wall):
    # The walls run `_CREDENTIAL_ID_RE` through `pseudonymize()` whatever AI_RAW_PII_ENABLED says
    # (ADR-0047 §4) and keep no copy of it, so the one connector covers them.
    elapsed_ms = _elapsed_ms(_WALLS[wall], "reg" + " " * _RUN + "!")
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms"


def test_the_salary_detector_is_linear_on_a_whitespace_run_after_a_cue():
    # `/profile/extract` runs the heuristic pass on the worker's own text, inline in `async def`.
    text = "reg" + " " * _RUN + "!5000"
    elapsed_ms = _elapsed_ms(profile_extractor.extract, text)
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms on {len(text)} chars"
    # The guard still reads the slice: whitespace and "!" are no identifier, so 5000 is money.
    assert signals.detect(text).current_salary == 5000


# --- 2. no span moves over the repo's own text --------------------------------------------------


@pytest.fixture(scope="module")
def corpus() -> list[str]:
    parts = measure.corpus()
    strings = measure.distinct(parts)
    assert len(strings) > 30_000, {name: len(texts) for name, texts in parts.items()}
    return strings


@pytest.fixture(scope="module")
def cue_bearing(corpus) -> list[str]:
    texts = [t for t in corpus if measure.ANY_CUE.search(t)]
    assert len(texts) > 2_000, len(texts)
    return texts


def _cue_words(name: str) -> list[str]:
    """Each rule's cue alternatives, read from its own pattern (its first group) and spelled out."""
    pattern = measure.shipped(name).pattern
    start = end = pattern.index("(?:") + 3
    depth = 0
    while depth or pattern[end] != ")":
        depth += {"(": 1, ")": -1}.get(pattern[end], 0)
        end += 1
    words = []
    for alternative in pattern[start:end].split("|"):  # its one nested group, (?:l)?, has no "|"
        spelled = alternative.replace(r"\s+", " ")
        words += [spelled.replace("(?:l)?", ""), spelled.replace("(?:l)?", "l")]
    return sorted(set(words))


@pytest.mark.parametrize("name", sorted(measure.RULES))
def test_every_cue_is_seen_by_the_prefilter(name):
    # Why section 2 may skip a string with no `ANY_CUE` hit: every rule needs one of its cues, and
    # each cue contains a prefilter word, matched the same case-insensitive way.
    words = _cue_words(name)
    assert len(words) >= 9, words
    for word in words:
        assert measure.ANY_CUE.search(word), (name, word)
        assert measure.ANY_CUE.search(word.upper()), (name, word)


def test_no_span_moves_over_the_repo_corpus(cue_bearing):
    """Over every cue-bearing corpus string in each of `measure.VIEWS` (as written, whitespace runs
    stretched, separators spaced): each rule's matches (whole span and every group span) equal
    the unfolded rule's, and the salary guard gives the unfolded verdict on every slice it is
    handed. The script runs the whole corpus, upper-cased too. The floors show cued values were
    met."""
    seen: Counter[str] = Counter()
    moved: list[tuple[str, list[str]]] = []
    for text in cue_bearing:
        for view in (transform(text) for transform in measure.VIEWS.values()):
            if differences := measure.differences(view):
                moved.append((view[:80], differences))
            for name in measure.RULES:
                seen[name] += bool(measure.shipped(name).search(view))
            seen["a guard slice hit"] += any(
                map(signals._CREDENTIAL_BEFORE_RE.search, measure.guard_slices(view))
            )
    assert moved == [], moved[:10]
    assert seen["credential_id"] > 25, seen
    assert seen["resume_cued_id"] > 15, seen
    assert seen["credential_before"] > 100, seen
    assert seen["a guard slice hit"] > 10, seen


# --- 3. no span moves over a seeded fuzz of cue lines -------------------------------------------


def test_property_no_span_moves_over_fuzzed_cue_lines():
    """20,000 samples of the script's seeded generator (`measure.sample`).

    Each rule's matches equal the unfolded rule's, and so does the salary guard on every slice.
    The floors show the generator reached every branch that decides a span."""
    rng = random.Random(1933)
    seen: Counter[str] = Counter()
    for _ in range(20_000):
        text = measure.sample(rng)
        assert measure.differences(text) == [], text
        cred = gateway._CREDENTIAL_ID_RE.search(text)
        seen["credential_id"] += bool(cred)
        seen["resume_cued_id"] += bool(gateway._RESUME_CUED_ID_RE.search(text))
        seen["credential_before"] += any(
            map(signals._CREDENTIAL_BEFORE_RE.search, measure.guard_slices(text))
        )
        if cred:
            gap = text[cred.start() : cred.start(1)]
            seen["a whitespace run of 3+ in the gap"] += bool(re.search(r"\s{3}", gap))
            seen["a number word in the gap"] += bool(re.search(r"(?i)\s(?:no|num|#)", gap))
            seen["a separator in the gap"] += bool(re.search(r"[:\-]", gap))
            seen["the possessive slot taken"] += bool(re.search(r"(?i)\s+(?:ka|ki|ke|mera)", gap))
    assert seen["credential_id"] > 1_200, seen
    assert seen["resume_cued_id"] > 600, seen
    assert seen["credential_before"] > 1_800, seen
    for branch in (
        "a whitespace run of 3+ in the gap",
        "a number word in the gap",
        "a separator in the gap",
        "the possessive slot taken",
    ):
        assert seen[branch] > 600, seen


# --- 4. end to end: the gateway, G1/G2 and the salary detector give the unfolded results -------


@pytest.fixture
def unfolded_rules():
    """Run ``fn`` with the three unfolded patterns swapped in, nothing else touched. Sound
    because the folding of the three connectors is the only thing #1933 changed."""

    def run(fn, *args):
        with measure.rules("unfolded"):
            return fn(*args)

    return run


def _matched_by_any_rule(text: str) -> bool:
    return any(measure.shipped(name).search(text) for name in measure.RULES) or any(
        map(signals._CREDENTIAL_BEFORE_RE.search, measure.guard_slices(text))
    )


def test_end_to_end_results_equal_the_unfolded_rules_where_a_rule_matches(
    cue_bearing, unfolded_rules
):
    """Every cue-bearing corpus string, in each of `measure.VIEWS`, on which some rule matches
    (section 2 shows the unfolded rules match exactly there too): `pseudonymize`,
    `contains_hard_identifier` and `signals.detect` each give the unfolded result. The script
    runs every cue-bearing string."""
    views = [
        view
        for text in cue_bearing
        for view in (transform(text) for transform in measure.VIEWS.values())
        if _matched_by_any_rule(view)
    ]
    assert len(views) > 150, len(views)
    seen: Counter[str] = Counter()
    for view in views:
        result = pseudonymize(view)
        assert result == unfolded_rules(pseudonymize, view), view[:120]
        verdict = contains_hard_identifier(view)
        assert verdict == unfolded_rules(contains_hard_identifier, view), view[:120]
        assert signals.detect(view) == unfolded_rules(signals.detect, view), view[:120]
        seen["[ID_n] masked"] += "[ID_" in result.text
        seen["credential_id verdict"] += verdict == "credential_id"
    assert seen["[ID_n] masked"] > 10, seen
    assert seen["credential_id verdict"] > 15, seen


@pytest.mark.parametrize(
    ("text", "masked", "verdict"),
    [
        ("roll number R/2019/123456 hai", "roll number [ID_1] hai", "credential_id"),
        ("certificate no MH2019CN4471", "certificate no [ID_1]", "credential_id"),
        ("registration no: ABCD1234EF", "registration no: [ID_1]", "credential_id"),
        ("licence ka no   :   DL04201100", "licence ka no   :   [ID_1]", "credential_id"),
        ("reg no123456", "reg no[ID_1]", "credential_id"),  # the "no" word, not the value
        ("reg\t#\t- AB/12/3456", "reg\t#\t- [ID_1]", "credential_id"),
        # The résumé rule runs in G1/G2 only; the gateway leaves these to its other rules.
        ("Passport No: M123456", "Passport No: M123456", "credential_id"),
        ("Voter ID - ABC123456", "Voter ID - ABC123456", "credential_id"),
        # The load-bearing negatives.
        ("NCVT certificate hai", "NCVT certificate hai", None),
        ("certificate number chahiye", "certificate number chahiye", None),
        ("Account Manager", "Account Manager", None),
        ("roll no 12345", "roll no 12345", None),  # five characters: too short for an ID
    ],
)
def test_the_known_cases_mask_and_refuse_as_unfolded(text, masked, verdict, unfolded_rules):
    result = pseudonymize(text)
    assert result.text == masked
    assert result == unfolded_rules(pseudonymize, text)
    assert contains_hard_identifier(text) == verdict
    assert unfolded_rules(contains_hard_identifier, text) == verdict


@pytest.mark.parametrize(
    ("text", "current", "expected"),
    [
        ("NCVT hai, roll number R/2019/123456", None, None),
        ("certificate number   :  4471 hai", None, None),
        ("abhi 25000 milta hai, 35000 chahiye, NCVT certificate hai", 25000, 35000),
    ],
)
def test_the_salary_guard_still_drops_a_roll_number_and_keeps_a_wage(
    text, current, expected, unfolded_rules
):
    sig = signals.detect(text)
    assert (sig.current_salary, sig.expected_salary) == (current, expected)
    assert sig == unfolded_rules(signals.detect, text)


@pytest.mark.parametrize(
    ("text", "masked"),
    [
        ("Reg.No.:- 123456", "Reg.No.:- [ID_1]"),
        ("Reg.No.: MH2019CN4471", "Reg.No.: [ID_1]"),
        ("Reg. No. MH2019CN4471", "Reg. No. [ID_1]"),
        ("Regn. No. MH2019CN4471", "Regn. No. [ID_1]"),
    ],
)
def test_a_dot_after_the_cue_masks_and_the_unfolded_rules_agree(text, masked, unfolded_rules):
    """Risks-register R56, fixed by #1950. These four were pinned here as `KNOWN_RESIDUAL`: no
    connector token started with "." and "regn" was no cue, so they never reached their value, on
    main and on #1933 alike. The ID stayed raw in the at-rest copies and the embedding input under
    both AI_RAW_PII_ENABLED postures, G1/G2 admitted it, and the salary detector recorded its
    digits as pay (123456, and 4471 from MH2019CN4471). #1950 reads a dot after the cue word, a
    ":-" separator and the "regn" cue, so they mask, refuse as `credential_id` and record no pay.
    The unfolded rules carry the same tokens and agree, so the folding moves nothing here either.
    `test_pseudonymize_cued_id_dot.py` pins the widening itself: the shapes, the near misses and
    the over-mask measurement."""
    result = pseudonymize(text)
    assert result.text == masked
    assert result == unfolded_rules(pseudonymize, text)
    assert contains_hard_identifier(text) == "credential_id"
    assert unfolded_rules(contains_hard_identifier, text) == "credential_id"
    assert signals.detect(text).current_salary is None
    assert unfolded_rules(signals.detect, text) == signals.detect(text)


# --- 5. the measurement script measures these rules ---------------------------------------------


def test_the_script_restores_the_shipped_rules():
    shipped = {name: measure.shipped(name) for name in measure.RULES}
    with pytest.raises(RuntimeError), measure.rules("unfolded"):
        assert _UNFOLDED_CONNECTORS["credential_id"] in gateway._CREDENTIAL_ID_RE.pattern
        assert _UNFOLDED_CONNECTORS["resume_cued_id"] in gateway._RESUME_CUED_ID_RE.pattern
        assert _UNFOLDED_CONNECTORS["credential_before"] in signals._CREDENTIAL_BEFORE_RE.pattern
        raise RuntimeError
    assert {name: measure.shipped(name) for name in measure.RULES} == shipped


@pytest.mark.parametrize(
    "text",
    ["reg no 123456", "passport no  M123456", "certificate number : 4471"],
)
def test_the_harness_sees_a_connector_that_changes_spans(text):
    # The sensitivity variant drops the `\s*` after the "no" word. If the harness reported no
    # difference here, its zeros above would mean nothing.
    assert measure.differences(text, "loose") != []
    assert measure.differences(text) == []


def test_the_corpus_reads_the_shared_readers():
    # One copy of the corpus readers (CLAUDE.md §8): the sibling script's, imported, so the two
    # measurements cannot drift apart on what a corpus file holds.
    for reader in (measure.tracked, measure.json_strings, measure.py_strings, measure.distinct):
        assert reader.__module__ == "measure_title_employer_bound", reader


def test_the_corpus_reads_tracked_files_only():
    """An untracked file in a corpus directory stays out, so the counts in the docs and the
    floors above hold on a dirty checkout exactly as in CI. This file stays out too: the fix is
    not measured against its own fixtures."""
    marker = f"reg no UNTRACKED{uuid.uuid4().hex}"
    probe = Path(__file__).resolve().with_name(f"_untracked_corpus_probe_{uuid.uuid4().hex}.py")
    probe.write_text(f"MARKER = {marker!r}\n", encoding="utf-8")
    try:
        assert marker not in measure.distinct(measure.corpus())
        files = measure.corpus_files()
    finally:
        probe.unlink()
    listed = {path for paths in files.values() for path in paths}
    assert probe not in listed
    assert Path(__file__).resolve() not in listed
    assert files["ai_service_tests"], files
