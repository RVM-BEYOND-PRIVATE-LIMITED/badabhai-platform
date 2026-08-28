"""Which SLOT a stated wage lands in — current pay or asking price (R12 §1.3).

WHY THIS FILE EXISTS AND WHY IT IS A TABLE. Salary is the most load-bearing free-text field the
interview parses: guideline §4.4 calls expected salary mandatory, and the figure reaches the
résumé, `salary_expectation.amount_min`, and the deterministic ranking factor `reach.mappers.ts`
reads. Getting the AMOUNT right and the SLOT wrong is not a smaller error than getting the amount
wrong — a worker whose asking price is filed as his current pay has his negotiating position
advertised as his floor, on the sheet he hands an employer.

R11 probed twelve phrasings by hand and found five wrong. Twelve is small for a field this
load-bearing, and a hand probe is not a gate: it measured once and nothing kept it measured.

HOW A ROW WORKS, AND WHY EVERY ROW ASSERTS SOMETHING.
    `want` is what a human reads the sentence as.
    `gap`  is what the detector ACTUALLY does, present only where the two differ.

Every row asserts `gap if gap is not None else want`, so:
  - a covered row that regresses goes red;
  - a GAP row that gets FIXED also goes red, and the fix is not complete until its `gap` is
    deleted. A gap cannot be quietly widened and it cannot be quietly closed.

That second property is the point. A "known failures" list that merely skips is a list nobody ever
shortens; this one makes closing a gap a required, visible edit with the reason attached.

THE COVERAGE NUMBER IS REPORTED, NOT ASSERTED as a floor. A floor is a ratchet that tempts
somebody to delete an awkward row, and the corpus is more useful honest than green. `test_coverage`
prints it and asserts only that the pinned gap set is EXACTLY the observed one — the same
both-directions property as above, at the level of the table.

NOT A LEXICON PARITY TEST. `test_lexicon_parity.py` asserts the two engines agree; this asserts
what the shared behaviour IS. A wrong rule implemented identically in both languages passes that
one and fails this one.
"""

from __future__ import annotations

import pytest

from app.profiling import signals as S

#: `(current, expected)` in rupees per month. `None` means the slot was not written.
Slots = tuple[int | None, int | None]


def _attribute(text: str) -> Slots:
    """Run the shipped detector exactly as the orchestrator does, and read both slots."""
    sig = S.Signals()
    S._detect_salary(text, text.lower(), sig)
    return (sig.current_salary, sig.expected_salary)


# id, utterance, want, gap (None = the detector agrees with `want`), why the row is here
CASES: list[tuple[str, str, Slots, Slots | None, str]] = [
    # ── both figures in one breath — the shape R10 R-1 was really about ───────────────────
    ("both_digits", "abhi 14000 milta hai, 16000 chahiye", (14000, 16000), None, "baseline"),
    (
        "both_hazaar",
        "abhi 14 hazaar mil rahe hain, 16 hazaar chahiye",
        (14000, 16000),
        None,
        "R12 1.1 closed this: 'hazaar' now in thousandUnits ahead of 'hazar'",
    ),
    (
        "both_hazar",
        "abhi 14 hazar milta hai, 16 hazar chahiye",
        (14000, 16000),
        None,
        "spelling already covered",
    ),
    (
        "both_split_cue",
        "25000 mahina milta hai, 35000 chahiye",
        (25000, 35000),
        None,
        "cue reaches the second number",
    ),
    # ── the cue sits AFTER the amount with a period word in between ───────────────────────
    #
    # THE ONE FAILURE MODE, IN FIVE COSTUMES. `expectedWindowAfter` is 10 characters measured
    # from the end of the number, so any period word between the amount and `chahiye` pushes the
    # cue out of the window and the asking price is filed as current pay. Routed for ai-engineer
    # review as R12 §1.2 — the fix ANCHORS the window after the period phrase at the same width,
    # which is not the widening that produced the regression this file's docstring warns about.
    (
        "cue_after_mahina",
        "35000 mahina chahiye",
        (None, 35000),
        (35000, None),
        "period word displaces the cue",
    ),
    (
        "cue_after_permonth",
        "35000 per month chahiye",
        (None, 35000),
        (35000, None),
        "same, English period",
    ),
    (
        "cue_after_mahine_ki",
        "salary 35000 mahine ki chahiye",
        (None, 35000),
        (35000, None),
        "same, two words",
    ),
    (
        "cue_after_annual",
        "2.5 lakh saal ka chahiye",
        (None, 20833),
        (20833, None),
        "same; the 12x division is CORRECT",
    ),
    (
        "cue_after_pa",
        "3 lakh per annum chahiye",
        (None, 25000),
        (25000, None),
        "same; annual arithmetic correct",
    ),
    # ── the cue sits BEFORE the amount, or immediately after it — these all work ───────────
    ("cue_before_mujhe", "mujhe 35000 chahiye", (None, 35000), None, "cue within 25 chars before"),
    ("cue_before_leading", "chahiye 30000 mahina", (None, 30000), None, "cue leads the sentence"),
    ("cue_before_two_words", "mujhe chahiye 30000 per month", (None, 30000), None, ""),
    (
        "cue_adjacent_hazaar",
        "30 hazaar chahiye mahine ka",
        (None, 30000),
        None,
        "cue adjacent, period after",
    ),
    ("cue_adjacent_hazar", "30 hazar chahiye", (None, 30000), None, ""),
    ("cue_adjacent_k", "25k chahiye", (None, 25000), None, ""),
    ("cue_adjacent_18", "18 hazaar chahiye", (None, 18000), None, ""),
    # ── English, which the payer-facing copy and a literate worker both produce ────────────
    (
        "en_expectation",
        "my salary expectation is 30000 per month",
        (None, 30000),
        None,
        "'expect' stem",
    ),
    ("en_expected", "expected salary 30000 monthly", (None, 30000), None, ""),
    ("en_i_want", "I want 30000 a month", (None, 30000), None, "'want' cue"),
    # ── a BAND, which §4.4 asks for and the detector has no slot for ───────────────────────
    #
    # Two slots exist, `current` and `expected`, and neither is "expected max" — that lives on
    # the finishing form as `salary_expected_max` (R10 R-1). So the honest reading of a spoken
    # band is: the LOWER end is the asking price (the figure he will not go below, which is
    # exactly `salary_expected`'s documented meaning) and nothing is current pay.
    (
        "band_se",
        "30000 se 35000 chahiye mahina",
        (None, 30000),
        (30000, 35000),
        "MEASURED R12: the lower bound is filed as CURRENT PAY and the upper as expected — a "
        "worker who states a band has his floor advertised as what he already earns",
    ),
    (
        "band_dash",
        "30000-35000 mahina chahiye",
        (None, 30000),
        (30000, None),
        "MEASURED R12: whole band collapses to current pay and the upper end is lost outright",
    ),
    # ── no cue at all — the documented, CORRECT default ────────────────────────────────────
    #
    # Not a gap. An uncued figure is more likely current pay than an asking price, and the
    # orchestrator's `last_asked_topic_id == "salary_expected"` branch promotes it when the
    # engine has just asked. Pinned so a future change cannot quietly reverse the default.
    ("bare_number", "30000", (30000, None), None, "uncued -> current, by design"),
    ("bare_monthly", "30000 mahina", (30000, None), None, ""),
    ("bare_milta", "abhi 30000 milta hai", (30000, None), None, ""),
    ("bare_tankha", "meri tankha 18000 hai", (18000, None), None, "money cue, no expectation cue"),
    ("bare_pagar", "pagar 18000 mahina", (18000, None), None, ""),
    ("bare_k", "25 k mahina", (25000, None), None, ""),
    # ── THE ANCHOR PROPOSAL'S ADVERSARIAL SET — all correct today, and they must STAY correct ──
    #
    # These are not gaps. They are the cases the ai-engineer review of R12 §1.2 built to refute
    # the proposed fix, and every one of them passes on the shipped code. Pinning them is the
    # point: the proposal was to anchor the expected-cue window after the period phrase instead
    # of after the digits, at the same width — and a 7,150-utterance sweep measured **1,776
    # regressions** of exactly this shape, where a second amount's cue falls inside the first
    # amount's widened reach and first-writer-wins then drops the real asking price AND the real
    # current pay.
    #
    # So the review's verdict was do-not-ship-as-proposed, and three guards are required: no
    # extension across another number, none across a clause terminator, and none where a number
    # sits after the cue being reached. Whoever implements that will need a red test if any guard
    # is missing. These rows are it.
    (
        "adv_comma_30k",
        "abhi 25000 mahina, 30k chahiye",
        (25000, 30000),
        None,
        "the cheapest refutation: needs guards (a) and (b)",
    ),
    (
        "adv_bare_30k",
        "abhi 25000 mahina 30k chahiye",
        (25000, 30000),
        None,
        "no comma — guard (a), the next-number clamp",
    ),
    (
        "adv_cue_first",
        "abhi 25000 mahina, chahiye 30k",
        (25000, 30000),
        None,
        "guard (b), the clause terminator",
    ),
    (
        "adv_no_sep",
        "abhi 25000 milta hai mahine chahiye 30k",
        (25000, 30000),
        None,
        "neither comma nor intervening number — guard (c)",
    ),
    (
        "adv_want_35000",
        "25000 mahina hai want 35000",
        (25000, 35000),
        None,
        "guard (c) again, English cue",
    ),
    # ── spellings 1.1 deliberately did not add ────────────────────────────────────────────
    #
    # 1.1 ruled ONE spelling. These are the same failure chain and are left pinned rather than
    # fixed, because widening a vocabulary is a product call: each new spelling is a chance to
    # match something that is not a wage. Mirrored as sal_018 / sal_019 in the shared corpus.
    (
        "sp_hajar",
        "25 hajar per month",
        (25000, None),
        (None, None),
        "'hajar' absent -> nothing recorded",
    ),
    (
        "sp_hazzar",
        "25 hazzar per month",
        (25000, None),
        (None, None),
        "'hazzar' absent -> nothing recorded",
    ),
]


@pytest.mark.parametrize("case_id,text,want,gap,why", CASES, ids=[c[0] for c in CASES])
def test_slot_attribution(
    case_id: str, text: str, want: Slots, gap: Slots | None, why: str
) -> None:
    expected = gap if gap is not None else want
    got = _attribute(text)
    if gap is not None:
        assert got == expected, (
            f"{case_id}: PINNED GAP moved. A human reads {text!r} as {want}; the detector "
            f"recorded {gap} when this was pinned and now records {got}. If you FIXED it, delete "
            f"this row's `gap` field. ({why})"
        )
    else:
        assert got == expected, f"{case_id}: REGRESSION on {text!r} — {why}"


def test_coverage_is_reported_and_the_gap_set_is_exact(capsys: pytest.CaptureFixture[str]) -> None:
    """Print the coverage number, and assert the pinned gaps are EXACTLY the observed ones.

    The number is reported rather than asserted as a floor: a floor is a ratchet, and the first
    thing a ratchet buys is somebody deleting an awkward row. What IS asserted is the set — a gap
    that closes and a case that breaks both show up here, so the table cannot drift from reality
    in either direction even if someone edits rows in bulk.
    """
    pinned = {c[0] for c in CASES if c[3] is not None}
    observed = {c[0] for c in CASES if _attribute(c[1]) != c[2]}

    total = len(CASES)
    covered = total - len(observed)
    with capsys.disabled():
        print(
            f"\nsalary slot attribution: {covered}/{total} phrasings "
            f"({covered * 100 // total}%) land in the slot a human reads them as"
        )
        for case_id, text, want, gap, _why in CASES:
            if gap is not None:
                print(f"  GAP  {case_id:22} {text!r:46} want={want} got={gap}")

    assert observed == pinned, (
        "the pinned gap set no longer matches reality.\n"
        f"  fixed but still pinned: {sorted(pinned - observed)}  -> delete their `gap` field\n"
        f"  newly broken:           {sorted(observed - pinned)}  -> a regression, not a pin"
    )
