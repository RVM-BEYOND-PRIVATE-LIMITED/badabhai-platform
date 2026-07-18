"""Measurement of the deterministic profiling parser — no runtime change.

This suite does NOT assert a quality bar on ``signals.detect_answered_topics``.
It exists to (a) keep the synthetic corpus honest, (b) prove the measurement
harness runs deterministically with zero network, and (c) LOCK the specific
findings written up in ``docs/ai/profiling-parser-coverage.md`` so that report
cannot silently go stale.

**These expectations are POST-#426.** The first revision measured the parser at
commit ``6d23419``; PR #426 (``fea207d``, P1 profiling correctness) then fixed four
defect classes and PR #412 (``41d0cb7``, TAX-WELD-1) added welding to the gazetteer.
Every assertion below was RE-RUN against the current parser, not edited to taste.
Where a defect is fixed the lock now pins the FIXED behaviour, so the fix cannot
silently regress; where a gap is still open the lock pins the gap, so it cannot
silently be declared closed.

If a test here fails because someone IMPROVED the parser, that is a good failure:
regenerate the report (``python tests/analysis_parser_coverage.py --write``) and
update the expectation. It is a baseline lock, not a requirement that gaps stay open.
"""

from __future__ import annotations

import re

import pytest
from analysis_parser_coverage import (
    NEGATION_PROBE,
    POST_426_DELTA,
    SCRIPT_GAZETTEER_FRIENDLY,
    SCRIPT_LATE_CORRECTION,
    SCRIPT_LATE_OVERWRITE,
    SCRIPT_PLAUSIBLE,
    UNEXPRESSIBLE,
    VALUE_WATCH,
    _negation_is_open,
    build_report,
    measure_all,
    measure_one,
    recorded_value,
    simulate,
)
from profiling_answer_corpus import CORPUS, TOPIC_ORDER, fixtures_for

from app.profiling import interview_engine, question_bank, signals

# --- corpus hygiene --------------------------------------------------------

_DIGIT_RUN = re.compile(r"\d{7,}")
_PHONE_SHAPE = re.compile(r"(?:\+?91[\s-]?)?[6-9]\d{9}")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
_PAN = re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")
_AADHAAR = re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b")
_COMPANY_SUFFIX = re.compile(
    r"\b(?:Pvt|Ltd|Limited|Industries|Enterprises|Engineering|Engineers|Forgings|"
    r"Castings|Fabrication)\b",
    re.IGNORECASE,
)


def test_corpus_carries_no_pii_shaped_text() -> None:
    """The corpus is synthetic; nothing in it may look like real identity PII.

    Belt-and-braces for CLAUDE.md §2 #2 — this text never reaches an LLM (the
    harness makes no network call at all), but a fixture file that LOOKS like it
    holds worker data is a liability in a PUBLIC repo.
    """
    for fixture in CORPUS:
        text = fixture.text
        assert not _DIGIT_RUN.search(text), f"digit run in {text!r}"
        assert not _PHONE_SHAPE.search(text), f"phone shape in {text!r}"
        assert not _EMAIL.search(text), f"email in {text!r}"
        assert not _PAN.search(text), f"PAN shape in {text!r}"
        assert not _AADHAAR.search(text), f"Aadhaar shape in {text!r}"
        assert not _COMPANY_SUFFIX.search(text), f"employer-shaped token in {text!r}"


def test_corpus_covers_every_askable_topic_at_the_required_depth() -> None:
    """15-25 answers for each of the 11 topics the CNC/VMC bank can ask."""
    bank_ids = [t.id for t in question_bank.topics_for("cnc_vmc")]
    assert list(TOPIC_ORDER) == bank_ids, "corpus topic list drifted from the question bank"
    for topic in TOPIC_ORDER:
        n = len(fixtures_for(topic))
        assert 15 <= n <= 25, f"{topic} has {n} fixtures (want 15-25)"


def test_corpus_labels_are_well_formed() -> None:
    for fixture in CORPUS:
        assert fixture.expected in ("accept", "reject")
        assert fixture.text.strip(), "empty fixture text"
        assert fixture.topic in TOPIC_ORDER


# --- harness properties ----------------------------------------------------


def test_measurement_is_deterministic() -> None:
    """The path under measurement is pure regex + gazetteer: same in, same out."""
    first = {(m.fixture.text, m.fixture.topic): sorted(m.detected) for m in measure_all()}
    second = {(m.fixture.text, m.fixture.topic): sorted(m.detected) for m in measure_all()}
    assert first == second


def test_report_builds_and_is_non_trivial() -> None:
    report = build_report(measure_all())
    assert "## Per-topic acceptance" in report
    assert "## Topics ranked by gap size" in report
    assert "## Fabrications" in report
    assert "## Denials absorbed" in report
    assert "## What #426 changed" in report
    assert "## Negation — fixed on CAPABILITY cues, STILL OPEN on VALUE cues" in report
    assert len(report.splitlines()) > 200


def test_report_keeps_the_historical_record_of_the_fixed_defects() -> None:
    """The pre-#426 values must survive in the report, not be edited out.

    Half the value of a measurement PR is showing what WAS wrong. The delta table
    carries the old value beside the new one; this pins that the old values are still
    printed rather than quietly dropped once they stopped being true.
    """
    report = build_report(measure_all())
    for pre_426_value in ("`5.0`", "`150000`", "`2012`", "`['ITI']`", "`['Diploma']`"):
        assert pre_426_value in report, f"lost the historical record of {pre_426_value}"
    assert "pre-#426" in report


@pytest.mark.parametrize("fixture", CORPUS, ids=lambda f: f"{f.topic}:{f.text}"[:60])
def test_every_fixture_is_measurable(fixture) -> None:
    """No fixture may crash the detector, and the result is always topic-id keyed."""
    measurement = measure_one(fixture)
    for key in measurement.detected:
        assert key in TOPIC_ORDER, f"detector emitted unknown topic id {key!r}"


# --- baseline lock on the findings written into the report -----------------


def test_documented_findings_still_hold() -> None:
    """Locks the headline claims of docs/ai/profiling-parser-coverage.md.

    A failure here means the parser CHANGED. Re-run the analysis, update the doc,
    then update these expectations — do not weaken the assertions to make it pass.

    POST-#426: every line below was re-run against the current parser. The coverage
    findings (1-5, 8) are unchanged by #426, which fixed what the parser RECORDS, not
    what it RECOGNISES.
    """
    d = signals.detect_answered_topics

    # 1. "CNC" — the FIRST option the role question offers — answers nothing at all.
    assert d("CNC", "role") == {}
    # 2. "CNC operator" — the canonical shop-floor answer — does not answer `role`;
    #    it silently closes `skills` instead.
    assert d("CNC operator", "role") == {"skills": ["machine operation"]}
    # 3. "operator", also offered verbatim by the question, behaves the same way.
    assert d("operator", "role") == {"skills": ["machine operation"]}
    # 4. VMC/HMC (machine TYPES) DO resolve `role`, so the gazetteer treats two of
    #    the three machine types in the question as roles and the third (CNC) not.
    assert d("VMC operator", "role").get("role") == "VMC Operator"
    assert d("HMC operator", "role").get("role") == "HMC Operator"
    # 5. Spelled-out numerals are not experience.
    assert d("char saal", "experience") == {}
    # 6. FIXED by #426 (P1-3). Was {"experience": 5.0} — the years regex had no left
    #    boundary, so it matched the decimal's SECOND digit. Now the fraction is kept.
    assert d("2.5 saal", "experience") == {"experience": 2.5}
    # 7. FIXED by #426 (P1-2). Was {"education": ["ITI"]} — the denial asserted its
    #    own opposite. Now the denial ANSWERS the education ask (so it is not
    #    re-asked) while recording nothing.
    assert d("iti nahi kiya, kaam se hi seekha", "education") == {"education": None}
    # 8. "hazaar" (the commoner spelling) is not a money unit; "hazar" is.
    assert d("15 hazaar", "salary_current") == {}
    assert d("15 hazar", "salary_current") == {"salary_current": 15000}


def test_post_426_delta_is_measured_not_asserted() -> None:
    """Every row of POST_426_DELTA re-measures as FIXED against the live parser.

    The report renders this same comparison. Locking it here means the report's
    "FIXED" verdicts cannot rot into a claim: a regression in any of the four #426
    defect classes fails this test AND flips the report column back to OPEN.
    """
    still_open = [
        (topic, text, recorded_value(text, topic), want)
        for topic, text, _before, want, _note in POST_426_DELTA
        if recorded_value(text, topic) != want
    ]
    assert not still_open, f"a #426 fix regressed: {still_open}"


def test_the_four_426_fixes_individually() -> None:
    """The same four defect classes, spelled out, so a failure names itself."""
    d = signals.detect_answered_topics

    # P1-3a: decimal years.
    assert d("2.5 saal", "experience") == {"experience": 2.5}
    # P1-3b: an ANNUAL figure is converted, not stored as a monthly one.
    assert d("1.5 lakh saal ka", "salary_current") == {"salary_current": 12500}
    #        ...and the conversion is asymmetric: with no period cue, 1.5 lakh is
    #        still read as the monthly figure the worker literally said.
    assert d("1.5 lakh", "salary_current") == {"salary_current": 150000}
    # P1-3c: a bare 1900-2099 year is not money.
    assert d("2012 se kaam kar raha hu", "salary_current") == {}
    # P1-3d: "sal" no longer matches inside "salary", so a salary answer records no
    #        experience. (It still records salary_current on the experience ask —
    #        a cross-topic mark, not the defect this fixed.)
    assert "experience" not in d("22000 salary milti hai", "experience")
    # P1-2: negation on CAPABILITY cues.
    assert d("diploma nahi hai", "education") == {"education": None}
    assert d("setting nahi aati, sirf chalata hu", "skills") == {
        "skills": ["machine operation"]
    }
    assert d("setter nahi hu", "role") == {}
    #       ...and the backward-only window keeps the contrastive assertion, which is
    #       the whole reason it is backward-only.
    assert d("CNC nahi, VMC karta hu", "role").get("role") == "VMC Operator"
    # P1-1: the overwrite rule — covered end-to-end in the scripted-interview tests.
    assert signals.is_correction("nahi nahi, 10 saal") is True
    assert signals.is_correction("10 saal") is False


def test_negation_is_still_open_on_location_availability_salary_experience() -> None:
    """THE headline remaining gap. #426 scoped negation to CAPABILITY cues only.

    ``signals.detect`` states the exclusion in code: location, availability, salary
    and experience deliberately keep reading the ORIGINAL text. So for those topics a
    denial STILL records the denied value. This test pins the gap OPEN so nobody can
    report it as closed without the measurement moving — and it will fail loudly, in a
    good way, the day someone closes it.
    """
    d = signals.detect_answered_topics

    # Records the city the worker just said they are NOT in — and files the city they
    # ARE in as a mere preference.
    assert d("Pune nahi, Delhi mein hu", "current_location") == {
        "current_location": "Pune",
        "preferred_locations": ["Delhi"],
    }
    assert d("Pune mein nahi rehta", "current_location") == {"current_location": "Pune"}
    # Records a refusal to go somewhere as a preference to go there.
    assert d("Pune nahi jaunga", "preferred_locations") == {
        "preferred_locations": ["Pune"]
    }
    # Records the OPPOSITE of the stated availability.
    assert d("abhi turant nahi, 1 mahina lagega", "availability") == {
        "availability": "immediate"
    }
    # Records the salary the worker said they do NOT get.
    assert d("22000 nahi milta", "salary_current") == {"salary_current": 22000}
    # Worst of the set: records the figure the worker REFUSED and ignores the one
    # they asked for (first-number-wins composed with negation-blindness).
    assert d("25000 nahi chahiye, 30000 chahiye", "salary_expected") == {
        "salary_expected": 25000
    }
    assert d("2 saal nahi hua abhi", "experience")["experience"] == 2.0

    # And the split is exactly the one the report claims: every CAPABILITY probe is
    # honoured, every VALUE probe is open. Measured via the harness's own predicate.
    families = {"CAPABILITY": set(), "VALUE": set()}
    for row in NEGATION_PROBE:
        families[row[3]].add(_negation_is_open(row))
    assert families["CAPABILITY"] == {False}, "a capability-cue negation regressed"
    assert families["VALUE"] == {True}, (
        "a value-cue negation now works — good news: re-run the harness, update the "
        "report's OPEN gap list, and narrow this assertion instead of deleting it"
    )


def test_value_watch_statuses_are_what_the_report_renders() -> None:
    """The 'is the recorded VALUE right?' table, locked.

    Three of these were WRONG pre-#426 and are ok now; the rest are the open value
    defects. Locking the whole table keeps the report's status column measured.
    """
    ok, wrong, unexpressible = set(), set(), set()
    for text, topic, _human, want in VALUE_WATCH:
        if want is UNEXPRESSIBLE:
            unexpressible.add(text)
        elif recorded_value(text, topic) == want:
            ok.add(text)
        else:
            wrong.add(text)

    assert ok == {
        "2.5 saal",  # FIXED by #426 (was 5.0)
        "1.5 lakh saal ka",  # FIXED by #426 (was 150000, an annual read as monthly)
        "setting nahi aati, sirf chalata hu",  # FIXED by #426 (dropped 'basic setting')
        "ITI + 3 saal apprenticeship",
        "Noida sector 63",
    }
    assert wrong == {
        "2 saal 6 mahine",  # STILL 2.0; the trailing "6 mahine" is dropped
        "Peenya, Bangalore",  # STILL records the AREA, not the city
    }
    assert unexpressible == {
        "18 se 20 hazar",
        "abhi se 5000 zyada",
        "30-35k",
        "Pune, Chakan, Ranjangaon",
    }


def test_findings_this_rerun_exposed() -> None:
    """New findings, locked so they are not lost — see report section 6.

    None of these is caused by #426. The welding read arrives with #412 (TAX-WELD-1);
    the `kabhi`/`abhi` collision is pre-existing and was surfaced by probing for the
    negation gap.
    """
    d = signals.detect_answered_topics

    # 1. Asked "which machine", "welding machine" leaves `machines` UNANSWERED while
    #    closing `role` and `skills`. A machine answer setting a ROLE.
    assert d("welding machine", "machines") == {
        "role": "Welder",
        "skills": ["welding"],
    }
    # 2. The availability cue is a plain substring test, so "abhi" matches inside
    #    "kabhi": "ever"/"occasionally"/"whenever" all read as "immediately".
    assert d("kabhi", "machines") == {"availability": "immediate"}
    assert d("kabhi kabhi", "machines") == {"availability": "immediate"}
    # 3. ...which is why a correctly-negated `machines` answer still marks
    #    availability: negation suppressed VMC, "kabhi" supplied the false cue.
    assert d("vmc nahi chalaya kabhi", "machines") == {
        "skills": ["machine operation"],
        "availability": "immediate",
    }


def test_denials_are_absorbed_not_fabricated() -> None:
    """The corpus's `reject` fixtures, post-#426: ZERO fabrications.

    Pre-#426 two of them recorded a VALUE the worker had denied. Now the only
    `reject` fixtures the parser marks answered are the two education denials, and
    both record nothing — which is #426's designed behaviour for the topics where a
    "no" is itself a complete answer.
    """
    rows = measure_all()
    assert [m.fixture.text for m in rows if m.is_fabrication] == []
    assert sorted(m.fixture.text for m in rows if m.is_denial_absorbed) == [
        "diploma nahi hai",
        "iti nahi kiya, kaam se hi seekha",
    ]
    for m in rows:
        if m.is_denial_absorbed:
            assert m.detected[m.fixture.topic] is None
            assert m.fixture.topic in signals._NEGATION_ANSWERS_TOPICS


def test_overall_acceptance_did_not_move() -> None:
    """#426 fixed what the parser RECORDS, not what it RECOGNISES.

    Coverage is the headline number in the report and it is UNCHANGED at 150/252.
    Pinned so a coverage change cannot slip in unmeasured behind a value fix.
    """
    rows = measure_all()
    should_accept = [m for m in rows if m.fixture.expected == "accept"]
    accepted = [m for m in should_accept if m.accepted]
    assert (len(accepted), len(should_accept)) == (150, 252)


def test_role_gazetteer_has_no_cnc_or_operator_keyword() -> None:
    """Code-path evidence for the `CNC`/`operator` finding (report section 1).

    ``signals._ROLES`` is the ONLY thing that can set ``role_id``, and
    ``detect_answered_topics`` keys the `role` topic on ``role_id`` alone
    (signals.py: ``if sig.role_id: answered["role"] = sig.primary_role``).
    """
    role_keywords = [kw for kw, _label, _rid, _tid in signals._ROLES]
    assert "cnc" not in role_keywords
    assert "operator" not in role_keywords
    # ...while the machine table has no bare "cnc" either, which is why "CNC" alone
    # falls through BOTH tables and returns {}.
    machine_keywords = [kw for kw, _label, _mid in signals._MACHINES]
    assert "cnc" not in machine_keywords
    assert "cnc lathe" in machine_keywords


def test_role_question_offers_options_the_parser_cannot_resolve() -> None:
    """The conflation hypothesis, measured against the shipped question string."""
    role_topic = question_bank.topic_by_id("cnc_vmc", "role")
    assert role_topic is not None
    assert role_topic.question == (
        "Aap kaunsa kaam karte hain — CNC, VMC, HMC operator, setter ya programmer?"
    )
    resolvable = {
        option: "role" in signals.detect_answered_topics(option, "role")
        for option in ("CNC", "VMC", "HMC", "operator", "setter", "programmer")
    }
    assert resolvable == {
        "CNC": False,  # machine type, no role keyword
        "VMC": True,  # machine type that IS a role keyword
        "HMC": True,  # machine type that IS a role keyword
        "operator": False,  # job function, no role keyword
        "setter": True,
        "programmer": True,
    }

    # The RETRY wording is where the parseable options live — it drops "CNC" and bare
    # "operator" entirely, so a worker only gets a prompt the parser can handle on
    # their SECOND attempt. #412 (TAX-WELD-1) widened this string rather than fixing
    # the first ask; pinned here because the report quotes it.
    assert role_topic.retry_question == (
        "Machine ya kaam ke naam se bataiye — "
        "VMC operator, CNC turner, setter, programmer ya welder?"
    )
    for option in ("VMC operator", "CNC turner", "setter", "programmer", "welder"):
        assert "role" in signals.detect_answered_topics(option, "role"), option


def test_no_topic_is_structurally_dead() -> None:
    """Every askable topic is satisfiable by at least one plausible answer."""
    rows = measure_all()
    for topic in TOPIC_ORDER:
        accepted = [m for m in rows if m.fixture.topic == topic and m.accepted]
        assert accepted, f"{topic} was never satisfied by any fixture — dead topic"


def test_scripted_interview_shows_the_engine_level_consequence() -> None:
    """End-to-end, mock mode, no network.

    A worker who answers every question plausibly — but in registers the gazetteer
    does not cover — reaches the wrap-up with all four ESSENTIAL_TOPICS unanswered,
    ``extraction_ready`` True (its frozen v1 meaning: "the interview is over"), and
    one collected field: `skills`, a topic that was NEVER ASKED.
    """
    plausible = simulate(SCRIPT_PLAUSIBLE)
    assert plausible.unanswered_essentials == list(interview_engine.ESSENTIAL_TOPICS)
    assert plausible.extraction_ready is True
    assert plausible.collected == {"skills": ["machine operation"]}
    assert "skills" in plausible.never_asked

    # The bounded re-ask still holds: each essential is asked at most twice.
    asked_counts: dict[str, int] = {}
    for asked, _reply in plausible.transcript:
        asked_counts[asked] = asked_counts.get(asked, 0) + 1
    for topic in interview_engine.ESSENTIAL_TOPICS:
        assert asked_counts.get(topic, 0) <= interview_engine.MAX_ASKS_PER_TOPIC

    # The contrast case: gazetteer-friendly phrasing fills every essential — and the
    # interview then wraps up so early that seven topics are never asked at all.
    friendly = simulate(SCRIPT_GAZETTEER_FRIENDLY)
    assert friendly.unanswered_essentials == []
    assert "salary_current" in friendly.never_asked
    assert "education" in friendly.never_asked


def test_a_later_answer_no_longer_overwrites_an_already_collected_value() -> None:
    """Report finding 4 — the ORIGINAL defect, now a regression guard.

    Pre-#426 ``next_turn`` guarded ``answered_topics`` against duplicates but assigned
    ``collected[topic_id]`` unconditionally, so the LAST message that tripped a
    detector won: a worker stated 10 years of experience and their answer to the final
    (education) question silently reset it to 3.0.

    ``interview_engine._may_commit`` now applies first-write-wins to any topic that is
    not the one being asked, so the incidental "3 saal" inside the education answer
    cannot displace it. Same script, same transcript, different outcome.
    """
    sim = simulate(SCRIPT_LATE_OVERWRITE)
    assert ("experience", "10 saal") in sim.transcript
    assert ("education", "ITI + 3 saal apprenticeship") in sim.transcript
    assert sim.collected["experience"] == 10.0, (
        "the P1-1 overwrite defect regressed: an incidental cross-topic value "
        "replaced one the worker established"
    )
    assert sim.collected["education"] == ["ITI"]


def test_an_explicit_correction_still_commits_and_is_message_scoped() -> None:
    """The other half of the overwrite rule, and its measured residual.

    ``signals.is_correction`` marks the WHOLE message, not a span. So prefixing the
    education answer with "nahi nahi," — a correction plainly aimed at education —
    also unlocks the incidental `experience` value riding along in the same sentence,
    and the established 10.0 drops to 3.0.

    Reported as an OPEN residual (report finding 4), not implemented here.
    """
    sim = simulate(SCRIPT_LATE_CORRECTION)
    assert ("experience", "10 saal") in sim.transcript
    assert ("education", "nahi nahi, ITI + 3 saal apprenticeship") in sim.transcript
    assert sim.collected["experience"] == 3.0, (
        "correction scoping changed — re-measure and update report finding 4"
    )
    # ...and the only difference between the two scripts is that one prefix.
    plain = simulate(SCRIPT_LATE_OVERWRITE)
    assert plain.collected["experience"] == 10.0
    assert plain.collected["education"] == sim.collected["education"]
