"""Issue #2049 — the gateway masks every cue's value (risks-register R62).

THE DEFECT, found 2026-10-06 by the security review of #1950: `pseudonymize()` ran
`_CREDENTIAL_ID_RE` as a non-overlapping `sub` ahead of the phone rule, and a value runs to the end
of its token, so the masked text was not monotone across cues. "Cert NAPS/2020/reg: 445566" came
out "Cert [ID_1]: 445566": the value took "reg", whose own ID was then never matched. "Licence
098765 43210" came out "Licence [ID_1] 43210": the phone rule saw five digits. In both, NOT reading
the first cue masked more. G1/G2 and the certifiers search rather than substitute, so they refused
both texts; the masked text was what fell short (the prompt with AI_RAW_PII_ENABLED off, and the
at-rest copies and the embedding input under both settings).

THE FIX is in the scan, not the rule (`_cued_id_values`): the union of the values the rule matches
from every cue start, and a value that a phone run starts inside and runs past grows through the
rest of its run of digits and phone separators. `_CREDENTIAL_ID_RE` and its four other copies are
unchanged; those copies only search, so none of them could cut anything.

PINNED: the shapes (section 1); the consequences decided on purpose (section 2: a block that becomes
a mask, the grown token's label, and the next-line salary the owner ruled on 2026-10-07); only more
than the old scan and never short of an every-start oracle over a seeded fuzz of glued cue lines
(section 3); the repo corpus and the certifiers (section 4); linear at the size cap (section 5);
the probe, the two views and the script (section 6); and what the fix does not cover (section 7).

OLD is the scan as #1950 left it, swapped in by `scripts/measure_cued_id_monotone.py`. All inputs
are fabricated. Stdlib, git and pytest only.
"""

from __future__ import annotations

import importlib.util
import inspect
import random
import re
import time
from collections import Counter
from pathlib import Path

import pytest

import app.pseudonymize as gateway
from app.profiling import signals
from app.pseudonymize import contains_hard_identifier, pseudonymize


def _load_script(name: str):
    path = Path(__file__).resolve().parents[1] / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


measure = _load_script("measure_cued_id_monotone")


def under_old(text: str) -> gateway.PseudonymizationResult:
    with measure.old_scan():
        return pseudonymize(text)


# --- 1. the shapes -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "masked", "old"),
    [
        # The issue's two shapes, as written and with #1950's dot.
        ("Cert NAPS/2020/reg: 445566", "Cert [ID_1]: [ID_2]", "Cert [ID_1]: 445566"),
        ("Cert. NAPS/2020/reg: 445566", "Cert. [ID_1]: [ID_2]", "Cert. [ID_1]: 445566"),
        ("Licence 098765 43210", "Licence [ID_1]", "Licence [ID_1] 43210"),
        ("Licence. 098765 43210", "Licence. [ID_1]", "Licence. [ID_1] 43210"),
        # A later cue glued on by "-", and a third cue: each one's value is masked.
        ("Licence DL-0420-reg 445566", "Licence [ID_1] [ID_2]", "Licence [ID_1] 445566"),
        (
            "Cert NAPS/2020/reg-2019/roll: 445566",
            "Cert [ID_1]: [ID_2]",
            "Cert [ID_1]: 445566",
        ),
        # A phone run that starts inside the value, not at its start.
        ("Reg AB1234 567890", "Reg [ID_1]", "Reg [ID_1] 567890"),
        ("Licence 098765 43210, salary 18000", "Licence [ID_1], salary 18000", None),
    ],
)
def test_every_cue_value_and_the_phone_it_cuts_are_masked(text, masked, old):
    result = pseudonymize(text)
    assert (result.text, result.blocked) == (masked, False)
    if old is not None:
        assert under_old(text).text == old
    # The walls never read the scan: their verdict is the one they always gave.
    assert contains_hard_identifier(text) in ("credential_id", "phone")
    new_masked, _ = measure.masked_offsets(text)
    with measure.old_scan():
        old_masked, _ = measure.masked_offsets(text)
    assert old_masked <= new_masked
    assert measure.oracle(text) <= new_masked


def test_the_run_is_masked_through_to_its_last_digit_not_to_the_cut_phones_end():
    """Why `_cued_id_values` grows a value through the whole run of digits and separators. The phone
    rule splits a run where it starts reading it: from "123456" it reads "123456 25000" and stops
    (13 digits at most); from after it, the old scan's phone rule read "25000 43210". Grown only to
    the cut phone's end, "43210" was left raw where the old scan masked it."""
    text = "reg no 123456 25000 43210"
    assert under_old(text).text == "reg no [ID_1] [PHONE_1]"
    assert [m.group() for m in gateway._PHONE_RE.finditer(text)] == ["123456 25000"]
    assert pseudonymize(text).text == "reg no [ID_1]"


@pytest.mark.parametrize(
    "text",
    [
        "Reg.No.:- 123456",
        "NCVT Regn. No.:- R/2019/123456 hai",
        "Roll 12345678901",  # a phone-shaped value: still one ID
        "Licence 98765-43210",  # "-" is in the value's class, so the value holds the whole number
        "reg-1-reg-1-reg-1-reg-1-",  # cues inside one value: one ID, as before
        "Reg no 123456 salary 25000",  # a word ends the run: the wage stays
        "mera naam Ramesh, reg no 123456, phone 98765 43210",
        "roll no R/2019/123456, phone 98765 43210",
    ],
)
def test_one_cue_and_no_cut_phone_mask_exactly_as_before(text):
    assert pseudonymize(text) == under_old(text)


# --- 2. decided ----------------------------------------------------------------------------------


def test_DECIDED_a_value_that_cut_a_phone_masks_it_where_the_residual_net_used_to_block():
    """The old scan masked "AB1234" and left "56789012", eight digits over the money range, so the
    residual net blocked the whole turn. Now the digits are masked inside the ID, which is what the
    phone rule does with them when no cue is read; nothing raw is left for the net to catch. Digits
    never egress either way."""
    text = "Reg AB1234 56789012"
    assert under_old(text).blocked is True
    result = pseudonymize(text)
    assert (result.text, result.blocked) == ("Reg [ID_1]", False)
    assert pseudonymize("AB1234 56789012").text == "AB[PHONE_1]"


def test_DECIDED_the_grown_token_is_an_id_not_a_phone():
    """A value that a phone run continues stays one [ID_n] token. Labels are no privacy control, and
    a cue's outcome must not depend on whether the cue sits inside another value: "reg 445566 7890"
    masks [ID_1] alone and [ID_2] after "Cert 2020/", where the old scan's phone rule took it."""
    assert pseudonymize("Licence 098765 43210").text == "Licence [ID_1]"
    assert pseudonymize("098765 43210").text == "[PHONE_1]"
    assert pseudonymize("reg 445566 7890").text == "reg [ID_1]"
    text = "Cert 2020/reg 445566 7890"
    assert pseudonymize(text).text == "Cert [ID_1] [ID_2]"
    assert under_old(text).text == "Cert [ID_1] [PHONE_1]"


def test_DECIDED_a_salary_on_the_next_line_is_masked_with_the_id_it_continues():
    """Owner ruling 2026-10-07 (#2049): the masking crosses a line break. The phone rule reads
    "123456\\n25000" as an 11-digit phone across the break, and without the cue the gateway already
    masks this text that way; so the cued value grows through it. The one corpus string that moves
    (section 4). The salary detector reads the raw text, so the wage is still recorded."""
    text = "NCVT roll number R/2019/123456\n25000 milta hai"
    assert under_old(text).text == "NCVT roll number [ID_1]\n25000 milta hai"
    assert pseudonymize(text).text == "NCVT roll number [ID_1] milta hai"
    assert pseudonymize("R/2019/123456\n25000 milta hai").text == "R/2019/[PHONE_1] milta hai"
    assert signals.detect(text).current_salary == 25000


# --- 3. only more, never short: a seeded fuzz of glued cue lines ---------------------------------


def test_property_only_more_than_the_old_scan_and_never_short_of_the_oracle():
    """20,000 lines of `measure.chained`: one to four of #1933's cue lines glued by a space, "/",
    "-", ", " or nothing, some ending in a number a value can cut. No line masks an offset less than
    the old scan, and none leaves raw an offset of a value the rule matches from ANY offset or of a
    phone run (`measure.oracle`, brute force). The floors show the generator reaches the R62 shape:
    measured 2026-10-07, 340 lines the old scan left short, 379 that moved, 19 blocks that became
    masks."""
    rng = random.Random(2049)
    seen: Counter[str] = Counter()
    for _ in range(20_000):
        text = measure.chained(rng)
        verdict = measure.judge(text)
        assert not verdict["less"], text
        assert not verdict["short"], text
        seen.update(name for name, hit in verdict.items() if hit)
    assert seen["old short"] > 250, seen
    assert seen["moved"] > 250, seen
    assert seen["block became a mask"] > 5, seen


# --- 4. the repo corpus and the certifiers (#1875's method) --------------------------------------

#: The corpus strings that move, decided (section 2): the next-line salary, in #1950's four views.
DECIDED_MOVES = {
    "NCVT roll number R/2019/123456\n25000 milta hai",
    "NCVT ROLL NUMBER R/2019/123456\n25000 MILTA HAI",
    "NCVT  \t\u00a0roll  \t\u00a0number  \t\u00a0R/2019/123456"
    "\n \t\u00a025000  \t\u00a0milta  \t\u00a0hai",
}


def test_no_corpus_string_moves_but_the_decided_one():
    """#1950's corpus (git-tracked files only, the cued-ID test files left out) in its four views.
    A string the rule matches nowhere is scanned alike by both (each finds no value), so only the
    ones it matches run (62 distinct views on 2026-10-07). Measured the same day with
    `measure_cued_id_monotone.py overmask` over all 2,690 cue-bearing strings: 1 moves per view,
    the decided one."""
    cued = measure.dot.cue_bearing(measure.distinct(measure.dot.corpus()))
    views = {
        view
        for text in cued
        for view in (transform(text) for transform in measure.dot.VIEWS.values())
        if gateway._CREDENTIAL_ID_RE.search(view)
    }
    assert len(views) > 40, len(views)
    moved = {text for text, _old, _new in measure.changes(sorted(views))}
    assert moved == DECIDED_MOVES


def test_no_certifier_label_changes_outcome():
    labels = measure.certifier_labels(measure.employer_corpus())
    assert len(labels) > 4_000, len(labels)
    assert measure.certifier_moves(labels) == []


# --- 5. linear at the size cap -------------------------------------------------------------------

# The 750 ms ceiling of #1933 and #1950 (#1941: a timing test gets a generous, explicit budget).
# Measured 2026-10-07, min of 3, local: 4-21 ms for every input below under the new scan.
_REDOS_BUDGET_MS = 750


@pytest.mark.parametrize("label", sorted(measure.TIMING_INPUTS))
def test_the_every_start_scan_stays_linear_at_the_size_cap(label):
    text = measure.TIMING_INPUTS[label]
    assert len(text) <= gateway.DEFAULT_MAX_LENGTH
    start = time.perf_counter()
    pseudonymize(text)
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms on {label}"


# --- 6. the probe, the two views, the script -----------------------------------------------------


def test_the_probe_reads_every_offset_as_the_rule_does():
    """`_cued_id_probe` is the rule with its value cut to six characters; it must succeed where the
    rule does, with the same value start, or the scan would skip or invent a value."""
    rule = gateway._CREDENTIAL_ID_RE
    probe = gateway._cued_id_probe(rule)
    rng = random.Random(2049)
    checked = 0
    for _ in range(10_000):
        text = measure.chained(rng)
        for start in range(len(text)):
            full, cut = rule.match(text, start), probe.match(text, start)
            assert (full is None) == (cut is None), (text, start)
            if full is not None:
                assert full.start(1) == cut.start(1), (text, start)
                checked += 1
    assert checked > 800, checked


def test_the_probe_follows_a_swapped_rule_and_a_rule_it_cannot_cut_fails_closed(monkeypatch):
    swapped = re.compile(r"(?i:\breg\b\s*)([A-Za-z0-9][A-Za-z0-9/\-]{5,})")
    monkeypatch.setattr(gateway, "_CREDENTIAL_ID_RE", swapped)
    assert gateway._cued_id_probe(swapped).pattern.endswith(r"[A-Za-z0-9/\-]{5})")
    assert pseudonymize("reg ABC123").text == "reg [ID_1]"
    monkeypatch.setattr(gateway, "_CREDENTIAL_ID_RE", re.compile(r"\breg\b\s*(\d{6,})"))
    with pytest.raises(ValueError):
        gateway._cued_id_values("reg 123456")
    result = pseudonymize("reg 123456")
    assert result.blocked is True
    assert result.blocked_reason.startswith("pseudonymization error")


@pytest.mark.parametrize(
    ("text", "masked"),
    [
        ("Licence 098765\u200b 43210", "Licence [ID_1]"),
        ("Cert\u200b NAPS/2020/reg: 445566", "Cert [ID_1]: [ID_2]"),
        ("Reg AB1234\u00a0567890", "Reg [ID_1]"),
    ],
)
def test_an_invisible_or_a_no_break_space_masks_as_the_plain_text_does(text, masked):
    """The two views of #1738 run the same scan, so an invisible (deleted in the reader view, a
    space in the spaced one) neither unmasks a value nor trips the fail-closed reconciliation."""
    result = pseudonymize(text)
    assert (result.text, result.blocked) == (masked, False)


def test_the_rules_ahead_of_the_scan_are_these():
    """`measure.scan_input` replays the rules `_mask` runs before the scan; pin their order."""
    source = inspect.getsource(gateway._mask)
    order = [*measure.EARLIER, "_SpanRule(_cued_id_values)", "(_PHONE_RE,"]
    positions = [source.index(name) for name in order]
    assert positions == sorted(positions)


def test_the_script_restores_the_shipped_scan():
    shipped = gateway._cued_id_values
    with pytest.raises(RuntimeError), measure.old_scan():
        assert gateway._cued_id_values is measure.old_values
        raise RuntimeError
    assert gateway._cued_id_values is shipped


def test_the_corpus_leaves_this_file_out():
    listed = {path.name for paths in measure.linear.corpus_files().values() for path in paths}
    assert "test_pseudonymize_cued_id_monotone.py" not in listed


# --- 7. what #2049 does not cover ----------------------------------------------------------------


def test_KNOWN_RESIDUAL_a_value_can_swallow_another_rules_cue():
    """#2049 makes the cued-ID scan and the phone rule monotone; the rules after them still read
    the scan's output. A value glued by "/" to a NAME cue takes the cue word into the ID, so the
    name after it is not masked, where without the credential cue the name rule masks it. G1/G2
    reads no names (ruled 2026-09-11, ADR-0041 §3.3). No such string is in the corpus."""
    assert pseudonymize("ABC123/naam Ramesh").text == "ABC123/naam [PERSON_1]"
    assert pseudonymize("Cert ABC123/naam Ramesh").text == "Cert [ID_1] Ramesh"
