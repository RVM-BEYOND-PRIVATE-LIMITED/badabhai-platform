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
    # THE ONE FAILURE MODE, IN FIVE COSTUMES — CLOSED BY R13 §1.1. `expectedWindowAfter` is 10
    # characters measured from the end of the number, so any period word between the amount and
    # `chahiye` pushed the cue out of the window and the asking price was filed as current pay.
    #
    # WHAT THE FIX IS NOT. I argued to the reviewer that anchoring the window past the period
    # phrase "is not widening — it is the same width, anchored differently". True narrowly and
    # false consequentially: a 7,150-utterance sweep measured 1,776 utterances where the naked
    # anchor moves a today-CORRECT reading to a wrong one, `abhi 25000 mahina, 30k chahiye` ->
    # (None, 25000) among them, which is the documented regression verbatim. Three guards take
    # that to zero and each one's measured contribution is in data/salary.json. The five rows
    # below are covered now; the five ADVERSARIAL rows at the bottom of this table are what stop
    # a future edit from buying them back at that price.
    (
        "cue_after_mahina",
        "35000 mahina chahiye",
        (None, 35000),
        None,
        "R13 §1.1: the period-anchored window reaches the cue",
    ),
    (
        "cue_after_permonth",
        "35000 per month chahiye",
        (None, 35000),
        None,
        "same, English period",
    ),
    (
        "cue_after_mahine_ki",
        "salary 35000 mahine ki chahiye",
        (None, 35000),
        None,
        "same, two words",
    ),
    (
        "cue_after_annual",
        "2.5 lakh saal ka chahiye",
        (None, 20833),
        None,
        "same; the 12x division is CORRECT",
    ),
    (
        "cue_after_pa",
        "3 lakh per annum chahiye",
        (None, 25000),
        None,
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
        (30000, 35000),
        "MEASURED R13 §1.1, AND THE PIN MOVED: under the old ten-character window the whole band "
        "collapsed to current pay and 35000 was lost outright; the period-anchored window now "
        "reaches the cue, so it reads exactly like band_se — floor as current pay, ceiling as "
        "the ask. Guard (a), the next-number clamp, is what stops 30000 taking the cue for "
        "itself. A clause-clamp-only variant happens to land this row on `want` and regresses "
        "four other probes, so the right answer is a range rule, not a looser clamp.",
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
    # ── THE ANCHOR'S ADVERSARIAL SET — now the SHIPPED guards' regression suite ────────────────
    #
    # These are not gaps and never were. They are the cases the ai-engineer review of R12 §1.2
    # built to refute the proposed fix, and they refuted it: anchoring the window past the period
    # phrase with no guards regresses 1,776 of 7,150 swept utterances, because a second amount's
    # cue falls inside the first amount's re-anchored reach and first-writer-wins then drops the
    # real asking price AND the real current pay. R13 §1.1 shipped the guarded version, so these
    # rows stop being a warning to a future implementer and start being the thing that keeps the
    # guards in place.
    #
    # EACH ROW NAMES THE GUARD IT MEASURES, and the naming is MEASURED, not reasoned: every row
    # was run against all eight on/off combinations of the three guards, and the `why` records
    # which combinations get it wrong. Two rows below (`adv_clause_stop`, `adv_clause_semicolon`)
    # exist because that measurement corrected me — see the note above them.
    (
        "adv_comma_30k",
        "abhi 25000 mahina, 30k chahiye",
        (25000, 30000),
        None,
        "wrong with no guards and with (c) alone: either clamp saves it",
    ),
    (
        "adv_bare_30k",
        "abhi 25000 mahina 30k chahiye",
        (25000, 30000),
        None,
        "GUARD (a) ONLY. Wrong under every combination without the next-number clamp",
    ),
    (
        "adv_cue_first",
        "abhi 25000 mahina, chahiye 30k",
        (25000, 30000),
        None,
        "wrong with no guards and with (a) alone: (b) or (c) saves it",
    ),
    (
        "adv_no_sep",
        "abhi 25000 milta hai mahine chahiye 30k",
        (25000, 30000),
        None,
        "GUARD (c) ONLY. No comma and no intervening number, so only cue ownership can decide",
    ),
    # THE MEASUREMENT CORRECTED THE MEASUREMENT. Over the 7,150-utterance sweep, (a)+(c) scores
    # zero regressions — identical to all three — and no row above uniquely needs (b). Read
    # literally that says the clause clamp is redundant and should not ship.
    #
    # It is not, and the sweep simply could not see it. Every utterance the sweep generates ends
    # in `<amount> <cue>` or `<cue> <amount>`, so a cue with NO number behind it never occurs —
    # and that is the only shape guard (b) is for. "abhi 25000 mahina hai. chahiye zyada" is an
    # ordinary sentence (I get 25,000 a month. I want more), and without the clause clamp the
    # current pay is filed as the asking price. A generator's grid is a fixture like any other:
    # it can only refute what it contains.
    (
        "adv_clause_stop",
        "abhi 25000 mahina hai. chahiye zyada",
        (25000, None),
        None,
        "GUARD (b) ONLY — a cue in the NEXT sentence, with no number of its own",
    ),
    (
        "adv_clause_semicolon",
        "25000 mahina hai; want more",
        (25000, None),
        None,
        "GUARD (b) ONLY — same shape, English, semicolon",
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
    # ══ R13 §1.3 — SHAPES THE TABLE DID NOT COVER ════════════════════════════════════════════
    #
    # Added AFTER the nine failures were classified, deliberately: §1.2's split is what told us
    # five of the nine were one algorithm change, and adding phrasings first would only have
    # made a bigger number with the same three causes hidden inside it. These rows go looking
    # for causes the table did not yet have — and found two.
    #
    # ── the shipped anchor, in the forms a real worker actually types ──────────────────────
    (
        "sym_comma",
        "₹28,000 mahina chahiye",
        (None, 28000),
        None,
        "rupee symbol + thousands separator + the period-anchored cue, all at once",
    ),
    (
        "rs_comma_permonth",
        "rs 28,000 per month chahiye",
        (None, 28000),
        None,
        "the same in English, 'rs' prefix",
    ),
    (
        "deva_mixed",
        "३०००० mahina chahiye",
        (None, 30000),
        None,
        "Devanagari DIGITS with Latin words — the ordinary phone-keyboard mixture",
    ),
    (
        "en_demand",
        "mera demand 30000 hai",
        (None, 30000),
        None,
        "'demand' is an expectation cue and sits BEFORE the amount",
    ),
    (
        "fresher_no_current",
        "abhi kuch nahi milta, 20000 chahiye",
        (None, 20000),
        None,
        "no current pay at all: the ask must not leak into the current slot",
    ),
    (
        "past_then_ask",
        "salary 22k thi, ab 28k chahiye",
        (22000, 28000),
        None,
        "past-tense current pay and an ask, one sentence, both slots correct",
    ),
    (
        "neg_then_ask",
        "25000 nahi, 30000 chahiye",
        (25000, 30000),
        None,
        "SLOTS ONLY. The negation over 25000 is real and is applied by the NORMALIZER "
        "(`negationVetoed`, corpus row sal_017), not by _detect_salary — so the slot table's "
        "job here is to record that the attribution itself is right, and to stop anyone "
        "'fixing' the veto by moving it into the wrong layer",
    ),
    # ── two causes this table did not have, found by looking, CLOSED IN R14 §2 ────────────
    #
    # Both rows announced their own closure: they went RED the moment the fix landed, which is
    # what a pin carrying its measured-wrong value is for.
    (
        "reversed_order",
        "35000 chahiye, abhi 25000 milta hai",
        (25000, 35000),
        None,
        "CLOSED R14 §2.2 — the window's START is now guarded the way §1.1 guarded its END. "
        "(a') never reach back across the previous NUMBER, (b') never across a clause end. "
        "Measured on a second 7,150-utterance sweep that states the ASK FIRST — the shape R13's "
        "grid structurally could not generate — at +2,096 current-pay values recovered and zero "
        "regressions on either sweep",
    ),
    (
        "reversed_no_separator",
        "30k chahiye abhi 25000 mahina milta hai",
        (25000, 30000),
        (None, 30000),
        "MEASURED R14 §2.2 — THE RESIDUAL OF THE FIX ABOVE, and the only shape left in its class: "
        "992 of the reversed sweep's 4,400 monthly rows. Neither clamp can fire — there is no "
        "punctuation between the two clauses and no number between the cue and this amount — so "
        "the ask's 'chahiye' still reaches back and marks the current pay as expected. Closing it "
        "needs an ADJACENCY rule (a cue belongs to the number it touches), which is a different "
        "mechanism from a clamp and a wider change than §2.2 asked for",
    ),
    (
        "cue_at_position_zero",
        "chah raha hu 30000 mahina",
        (None, 30000),
        (30000, None),
        "MEASURED R14 §2.2, AND IT PREDATES EVERY GUARD IN THIS FILE. `expectedCues` carries "
        "' chah' with a LEADING SPACE so the stem cannot fire inside an unrelated word — and a "
        "cue at offset 0 has no space before it, so an utterance that OPENS with the ask has no "
        "expectation cue at all and the asking price is filed as current pay. 440 rows of the "
        "reversed sweep. The fix is a boundary rather than a space, and `expectedCues` is a "
        "substring list rather than a pattern list, so it is a shape change to the field",
    ),
    (
        "daily_wage",
        "1200 daily milta hai",
        (None, None),
        None,
        "CLOSED R14 §2.1 — `subMonthlyCues` suppresses the amount rather than defaulting its "
        "period to monthly. SUPPRESSED, NOT CONVERTED: 26, 30 and 24 days a month are all "
        "defensible and differ by a quarter, so any multiplier prints a number the worker never "
        "stated. This is the same degrade the annual/monthly CONFLICT already took, and it is "
        "what this row's `want` has said since it was written",
    ),
    (
        "weekly_wage",
        "8000 hafte ka milta hai",
        (None, None),
        None,
        "R14 §2.1 — the same rule one period up. A weekly wage read as monthly under-states by a "
        "factor of four; here it records nothing",
    ),
    (
        "daily_cue_does_not_eat_an_explicit_month",
        "25000 mahina milta hai, din bhar kaam",
        (25000, None),
        None,
        "R14 §2.1's FALSE-POSITIVE GUARD, and the reason the sub-monthly test runs LAST. 'din' is "
        "in the daily set and sits inside this amount's period window; an explicit 'mahina' is "
        "also there. The rule only fires when NEITHER an annual nor a monthly cue was found, so "
        "the stated period still wins and the wage is recorded",
    ),
    (
        "rozgar_is_not_a_daily_wage",
        "rozgar nahi mil raha, 25000 mahina chahiye",
        (None, 25000),
        None,
        "R14 §2.1 — 'rozgar' is EMPLOYMENT and it genuinely appears in these transcripts. The "
        "trailing word boundary on `ro[zj](?:ana|aana)?` is the whole reason this records the ask "
        "instead of nothing at all",
    ),
    (
        "band_se_hazaar",
        "30 se 35 hazaar chahiye",
        (None, 30000),
        (None, 35000),
        "the band shape in its most common spoken form: both ends are the ASK, and only the "
        "upper one survives, so the floor the worker named is lost",
    ),
    (
        "deva_cue",
        "२५००० महीना चाहिए",
        (None, 25000),
        (25000, None),
        "MEASURED: an asking price entirely in Devanagari lands in CURRENT PAY. The digits and "
        "the period are handled — 'चाहिए' simply is not in expectedCues, which is Latin-only. "
        "Same shape as the pinned dev_015 blindness one layer up",
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
            f"\nsalary slot attribution: {covered}/{total} phrasings land in the slot a human "
            f"reads them as"
        )
        # BY CAUSE, never as a bare percentage (R13 §1.3). One number over four causes is not
        # a number anyone can act on: "82%" hides that three of the eight need a range rule,
        # three need one word each, one needs a ruling, and one is an algorithm change.
        by_class: dict[str, list[str]] = {}
        for case_id, _text, _want, gap, _why in CASES:
            if gap is not None:
                by_class.setdefault(GAP_CLASS.get(case_id, "unclassified"), []).append(case_id)
        for cause in sorted(by_class):
            print(f"  {cause:12} {len(by_class[cause])}  {', '.join(sorted(by_class[cause]))}")
        for case_id, text, want, gap, _why in CASES:
            if gap is not None:
                cause = GAP_CLASS.get(case_id, "unclassified")
                print(f"  GAP  [{cause:9}] {case_id:18} {text!r:40} want={want} got={gap}")

    assert observed == pinned, (
        "the pinned gap set no longer matches reality.\n"
        f"  fixed but still pinned: {sorted(pinned - observed)}  -> delete their `gap` field\n"
        f"  newly broken:           {sorted(observed - pinned)}  -> a regression, not a pin"
    )


# ─────────────────────────────────────────────────────────────────────────────────────────
# The gaps, CLASSIFIED — because a coverage number that mixes causes says nothing (R13 §1.2)
# ─────────────────────────────────────────────────────────────────────────────────────────

#: Case id -> the CAUSE of its gap. Three causes, three different fixes and three different
#: owners, and mixing them is what makes "25 of 34" unactionable:
#:
#:   gazetteer  a spelling absent from a unit or cue list. One word, in data/salary.json,
#:              no algorithm change, no cross-engine risk. R12 §1.1 closed `hazaar` this way.
#:   window     the cue is present and unambiguous but falls outside the attribution window.
#:              An ALGORITHM change, mirrored in two engines, and the one that needed a
#:              7,150-utterance sweep before it could ship.
#:   band       the worker states a RANGE. The detector has no notion of one, so it reads two
#:              independent amounts. Not a bug in any rule below it — a missing concept, and
#:              a product call on which end of a band is the asking price.
#:   period     the stated period has no rule at all. A DAILY wage is read as a monthly one,
#:              which is a 26x error in the direction this file exists to prevent. Needs a
#:              ruling (days per month) before it can be a code change, and until then the
#:              correct behaviour is to record NOTHING.
#:
#: THE WINDOW CLASS IS EMPTY AS OF R13 §1.1 — all five of its rows closed together, because they
#: were one defect in five costumes. That is the useful thing about classifying before fixing:
#: the split said "five of these nine are one algorithm change" before a line was written.
GAP_CLASS: dict[str, str] = {
    "band_se": "band",
    "band_dash": "band",
    "band_se_hazaar": "band",
    "sp_hajar": "gazetteer",
    "sp_hazzar": "gazetteer",
    "deva_cue": "gazetteer",
    "reversed_no_separator": "window",
    "cue_at_position_zero": "gazetteer",
}


def test_every_pinned_gap_has_a_stated_cause() -> None:
    """A pin with no cause is a pin nobody can schedule.

    Both directions, like the table itself: a new gap with no class fails here, and a class
    left behind after its gap closes fails here too. Without the second half this dict would
    quietly accumulate the names of solved problems.
    """
    pinned = {c[0] for c in CASES if c[3] is not None}
    assert set(GAP_CLASS) == pinned, (
        f"unclassified gaps: {sorted(pinned - set(GAP_CLASS))}; "
        f"classified but no longer a gap: {sorted(set(GAP_CLASS) - pinned)}"
    )


def pinned_gaps() -> list[dict[str, object]]:
    """The open pins in this table, for `scripts/list-open-pins.mjs` (R13 §4).

    THE CONVENTION, not a registration: the lister greps the test tree for `def pinned_gaps(`
    and imports whatever defines it. A registry of gap suites would be one more list somebody
    has to remember to update, which is the failure this whole mechanism exists to answer.

    `gates` is what a packet has to be editing for this pin to be worth reading — the shared
    lexicon data and BOTH engine implementations, because a salary gap is never one-sided.
    """
    return [
        {
            "id": case_id,
            "title": text,
            "why": (
                f"[{GAP_CLASS.get(case_id, 'unclassified')}] a human reads this as {want}; "
                f"the detector records {gap}. {why}"
            ),
            "gates": [
                "packages/profiling-lexicon/data/salary.json",
                "packages/profiling-lexicon/src/values/salary.ts",
                "apps/ai-service/app/profiling/signals.py",
                "apps/ai-service/tests/test_salary_attribution.py",
            ],
        }
        for case_id, text, want, gap, why in CASES
        if gap is not None
    ]
