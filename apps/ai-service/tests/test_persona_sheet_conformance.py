"""Conformance against the RATIFIED persona sheet — docs/specs/persona-system-v3.2.md.

WHY THIS FILE EXISTS, and it is not "more persona tests". `test_persona_neutrality.py`
checks the strings we SAY. §5 of the sheet ("What he does when it gets awkward") is a
table of BEHAVIOURS, and several of its rows have no counterpart in code at all. A rule
that lives only in a document drifts silently; a rule that is measured — even when the
measurement records an ABSENCE — cannot.

So every §5 row is executed here and lands in one of two groups:

* **IMPLEMENTED** — pinned as a behavioural regression test.
* **NOT IMPLEMENTED** — pinned as a MEASURED ABSENCE, named so, with the reason. These
  tests are deliberately written so that IMPLEMENTING the row turns them RED. That is
  the point: the sheet's behaviours are product decisions (a softener that fires on the
  wrong trigger is worse than none), so building one must be a deliberate act that
  updates this file, not a silent addition.

Nothing here builds a missing row. Every gap is reported, not closed.
"""

from __future__ import annotations

from app.profiling import interview_engine, signals
from app.profiling.question_bank import GENERIC_ROLE_FAMILY, topics_for

# §3's two softeners and the guarantee line from §5 / conversation 06, quoted exactly.
_SOFTENER_NAHI_PATA = "Koi baat nahi."
_SOFTENER_HARDSHIP = "Samajh sakta hoon."
_GUARANTEE_LINE = "Guarantee nahi de sakta"


def _drive(messages: list[str], family: str = "cnc_vmc") -> list[str]:
    """Run the engine over ``messages`` and return every line the worker was SERVED."""
    state, served = None, []
    for message in messages:
        reply, asked_id, state, _ready = interview_engine.next_turn(state, message, family)
        served.append(reply)
        if asked_id is None:
            break
    return served


# ---------------------------------------------------------------------------
# §5 rows that ARE implemented
# ---------------------------------------------------------------------------


def test_row_answers_three_things_at_once_takes_all_three_and_never_re_asks():
    """§5: "Answers three things at once → Takes all three. **Never asks what has
    already been answered.**" — and §2 Law 2, since taking them silently is what makes
    "never repeat back" possible.

    MEASURED: one message resolves role + machines + experience, and the next question
    skips straight past all three to current_location."""
    message = "vmc operator hoon, vmc chalata hu, 5 saal ho gaye"
    detected = signals.detect_answered_topics(message, "role")
    assert {"role", "machines", "experience"} <= set(detected)

    _reply, asked_id, state, _ready = interview_engine.next_turn(None, message, "cnc_vmc")
    assert {"role", "machines", "experience"} <= set(state.answered_topics)
    assert asked_id == "current_location", asked_id

    # ...and none of the three is ever served, however long the interview runs.
    served_ids: list[str] = []
    for _ in range(interview_engine.MAX_ENGINE_ASKS + 1):
        if asked_id is None:
            break
        served_ids.append(asked_id)
        _reply, asked_id, state, _ready = interview_engine.next_turn(
            state, "theek hai ji", "cnc_vmc"
        )
    for already_answered in ("role", "machines", "experience"):
        assert already_answered not in served_ids, served_ids


def test_row_uses_the_wrong_word_is_accepted_as_said_and_never_corrected():
    """§5: "Uses the 'wrong' word → Accepts it as said. Never corrects, never teaches
    the 'proper' term — the phrase resolves downstream, not in the chat."

    Conversation 06's example, executed: "rod se welding" IS arc welding. The detector
    records the worker as a welder and moves on; nothing anywhere serves a correction.
    """
    detected = signals.detect_answered_topics("bas rod se welding karta hoon", "role")
    assert detected.get("role") == "Welder"

    served = _drive(["bas rod se welding karta hoon"])
    lowered = " ".join(served).lower()
    for teaching in ("actually", "sahi shabd", "matlab hota", "iska naam", "arc kehte"):
        assert teaching not in lowered, f"the bot corrected the worker: {served}"


def test_row_never_repeats_or_restates_what_the_worker_just_said():
    """§2 Law 2 / §7 Memory: "Never repeat, restate or summarise what the worker just
    said. Not once." Nothing the worker types may come back in the reply."""
    probe = "zzqqprobe"
    served = _drive([f"vmc operator hoon {probe}", "5 saal", "pune me hu"])
    assert all(probe not in line for line in served), served


def test_row_is_in_a_trade_we_dont_cover_gets_the_generic_voice():
    """§5's last row and worked conversation 04, covered in depth by
    tests/test_generic_role_family.py. Asserted here too so the §5 table is complete
    in one place."""
    assert GENERIC_ROLE_FAMILY in {f for f in ("generic",)}
    generic_ids = [t.id for t in topics_for(GENERIC_ROLE_FAMILY)]
    assert "daily_tasks" in generic_ids and "machines" not in generic_ids


def test_row_a_marked_correction_takes_the_latest_answer():
    """§5: "Contradicts himself → Takes the latest answer." — the half that IS built.
    `signals.is_correction` + `_may_commit` rule 2. See the gap test below for the
    unmarked half."""
    _r, _a, first, _rd = interview_engine.next_turn(None, "5 saal ka experience hai", "cnc_vmc")
    assert first.collected["experience"] == 5.0
    assert signals.is_correction("nahi nahi, 10 saal") is True
    _r, _a, corrected, _rd = interview_engine.next_turn(first, "nahi nahi, 10 saal", "cnc_vmc")
    assert corrected.collected["experience"] == 10.0


# ---------------------------------------------------------------------------
# §5 rows that are NOT implemented — measured absences, not claims
# ---------------------------------------------------------------------------
# Each test below asserts the CURRENT behaviour. Implementing the row will turn it RED,
# which is intended: these are product decisions and must not arrive silently.


def test_GAP_the_nahi_pata_softener_is_never_emitted():
    """§5 row 1 / §3 Softening: a "nahi pata" should be met with "Koi baat nahi."
    before the next question. NOT BUILT — `interview_engine._ACK` is the only
    acknowledgement and it is unconditional ("Theek hai. "), so the worker who does not
    know gets the same two words as the worker who does.

    Law 8's *substance* ("nahi pata is a complete answer") is partially built — see the
    negation test below — but the softener itself does not exist."""
    served = _drive(["cnc turner hoon", "nahi pata", "nahi pata"])
    assert all(_SOFTENER_NAHI_PATA not in line for line in served), served


def test_GAP_the_hardship_softener_is_never_emitted_and_therefore_never_MIS_fires():
    """§5 / conversation 06: work has been hard → one line, ≤8 words, no advice
    ("Samajh sakta hoon."), **fires on hardship, never on achievement**. NOT BUILT.

    The absence is asserted on BOTH triggers on purpose. The specific risk with this
    row is not that it is missing — it is that a naive implementation fires it on the
    wrong turn, and consoling a worker who just told you something they are proud of is
    the exact tonal failure the sheet is guarding against. Today it cannot fire at all,
    so it cannot fire wrongly; when it is built, this test must be replaced by one that
    proves the TRIGGER, not the absence."""
    hardship = _drive(["6 mahine se kaam nahi mila, ghar chalana mushkil hai"])
    achievement = _drive(["8 saal ho gaye, ab main pura setup khud karta hoon"])
    for served in (hardship, achievement):
        assert all(_SOFTENER_HARDSHIP not in line for line in served), served
    # ...and the sheet's line, if it is ever built, has a hard shape budget.
    assert len(_SOFTENER_HARDSHIP.split()) <= 8


def test_GAP_the_job_milegi_guarantee_line_is_never_emitted():
    """§5 / conversations 02 and 06: "Asks 'job milegi?'" → "Guarantee nahi de sakta —
    profile poora hoga toh companies dekhengi." → back to the open question. NOT BUILT.

    Measured: `needs_rephrase("sir job mil jayegi na?")` is False, so the message is not
    even routed as a question back at us — the engine simply advances the interview and
    the worker's question goes unanswered. That is silence rather than a promise, so
    §2 Law 9 (never promise) is not violated; the row is unimplemented, not broken."""
    message = "sir job mil jayegi na?"
    assert interview_engine.needs_rephrase(message) is False
    served = _drive(["cnc turner hoon", message])
    assert all(_GUARANTEE_LINE not in line for line in served), served
    # Law 9 holds by absence: nothing promises anything either.
    lowered = " ".join(served).lower()
    for promise in ("guarantee", "pakka", "milegi hi", "job mil jayegi"):
        assert promise not in lowered, served


def test_GAP_an_abusive_message_gets_no_special_neutral_line():
    """§5: "Is abusive → One neutral line, continues. Never mirrors tone, never
    moralises." NOT BUILT as a special case — the engine treats it as any other
    non-answer. The two NEVERs are satisfied by construction (there is no tone-matching
    and no moralising path anywhere), but the "one neutral line" is absent: the worker
    just gets the next question."""
    served = _drive(["tum log bekaar ho"])
    lowered = " ".join(served).lower()
    for moralising in ("aisa mat", "tameez", "please be", "polite", "galat baat"):
        assert moralising not in lowered, served
    assert served[0].endswith("?")  # it simply continued with the next question


def test_GAP_law_8_only_holds_for_three_topics_and_an_essential_is_still_re_asked():
    """§2 Law 8: "'Nahi pata' is a complete answer. Accept it, move on, **never
    re-ask**." §5 row 2 says the same of a refusal: "Never asks twice."

    PARTIALLY BUILT, and the gap is precise. `signals._NEGATION_ANSWERS_TOPICS` is
    {skills, education, certifications} — for those, a denial closes the topic with a
    None value and it is never served again. For an ESSENTIAL the engine spends its ONE
    bounded re-ask instead: MEASURED, "nahi pata" to the machines question produces
    ask_counts["machines"] == 2.

    THIS IS A REAL DISAGREEMENT WITH THE SHEET, not an oversight, and it is recorded
    rather than fixed because the two rules protect different people: INTERVIEW-1's
    bounded re-ask exists because the finite gazetteer reads a PERFECTLY GOOD answer as
    no answer, and closing an essential on the first unparsed reply ships an incomplete
    profile. Reconciling them (e.g. adding "nahi pata"/"pata nahi" to the negation set
    for essentials too, so an EXPLICIT don't-know closes the topic while an unparseable
    ANSWER still earns the re-ask) is a product call for the owner.
    """
    from app.profiling.signals import _NEGATION_ANSWERS_TOPICS

    assert set(_NEGATION_ANSWERS_TOPICS) == {"skills", "education", "certifications"}
    # For those three, a denial IS a complete answer.
    assert signals.detect_answered_topics("ITI nahi kiya", "education") == {"education": None}
    assert signals.detect_answered_topics("setting nahi aati", "skills") == {"skills": None}
    # For an essential it is not read at all, so the bounded re-ask fires.
    assert signals.detect_answered_topics("nahi pata", "machines") == {}
    _r, asked1, st1, _rd = interview_engine.next_turn(None, "cnc turner hoon", "cnc_vmc")
    assert asked1 == "machines"
    _r, asked2, st2, _rd = interview_engine.next_turn(st1, "nahi pata", "cnc_vmc")
    assert asked2 == "machines", "the sheet says never re-ask; the engine re-asks once"
    assert st2.ask_counts["machines"] == 2
    # ...but the bound still holds: never a third time.
    _r, asked3, _st3, _rd = interview_engine.next_turn(st2, "nahi pata", "cnc_vmc")
    assert asked3 != "machines"


def test_GAP_an_unmarked_contradiction_is_ignored_rather_than_taken_as_latest():
    """§5: "Contradicts himself → **Takes the latest answer.** Clarifies once only if
    it is trade or location."

    PARTIALLY BUILT, INVERTED for the unmarked case. `_may_commit` rule 3 is
    FIRST-WRITE-WINS: an unmarked later mention of a topic that is NOT the one being
    asked is IGNORED. MEASURED: "5 saal" then "waise 12 saal ho gaye" keeps 5.

    The `_may_commit` docstring already names this as a KNOWN LIMIT and argues for it
    (a stale but worker-STATED value beats a silently rewritten one, and the confirm
    step is where a worker fixes it). Recorded here as a sheet disagreement so the two
    positions are visible together.

    The second half of the row — "clarifies once only if it is trade or location" — has
    NO implementation at all: there is no contradiction-clarify path anywhere.
    """
    _r, _a, first, _rd = interview_engine.next_turn(None, "5 saal ka experience hai", "cnc_vmc")
    assert first.collected["experience"] == 5.0
    _r, _a, later, _rd = interview_engine.next_turn(first, "waise 12 saal ho gaye", "cnc_vmc")
    assert later.collected["experience"] == 5.0, "first-write-wins no longer holds"
    assert signals.is_correction("waise 12 saal ho gaye") is False


# ---------------------------------------------------------------------------
# §4 phrasing law — which canonical questions the bank now matches
# ---------------------------------------------------------------------------


def test_the_three_canonical_questions_adopted_verbatim_from_the_sheet():
    """§4 gives seven canonical phrasings. THREE were adopted byte-for-byte after each
    was MEASURED inert against `detect_answered_topics` (a question's text enters the
    extraction transcript, so a self-keying question fabricates fields — the defect the
    ONE_SHOT_OPENER note documents at length)."""
    from app.profiling.question_bank import topic_by_id

    adopted = {
        "preferred_locations": "Kaam kahan karna chahte hain?",
        "salary_expected": "Kitni salary chahiye?",
        "availability": "Kab se join kar sakte hain?",
    }
    for topic_id, sheet_wording in adopted.items():
        assert topic_by_id("cnc_vmc", topic_id).question == sheet_wording, topic_id
        # The inertness that made adoption safe, re-measured on every run.
        assert signals.detect_answered_topics(sheet_wording, None) == {}, topic_id


def test_GAP_four_canonical_questions_deliberately_keep_the_banks_wording():
    """The other four §4 rows, each kept for a MEASURED reason rather than by omission.
    Escalated to the owner rather than changed unilaterally.

    * **trade** — sheet "Aap kya kaam karte hain?" vs bank "Aap kaunsa kaam karte
      hain?". The bank's stem is embedded VERBATIM in `ONE_SHOT_OPENER`, which must
      stay byte-identical to the Flutter `kChatOpeningText`; the opener's own note
      records that mirroring the bank's stem is what makes the reply parse (measured:
      a non-mirroring stem lost `salary_current` from the reply). Changing one without
      the other breaks the mirroring; changing both breaks Flutter parity. Needs a
      coordinated change.
    * **controllers** — sheet "Fanuc ya Siemens?" is NOT inert: measured, it self-keys
      `{'controllers': ['Fanuc', 'Siemens']}`, so adopting it puts two controllers into
      the transcript that the worker never named. It also drops Mitsubishi/Haas/
      Heidenhain from the question, which is a coverage decision, not a persona rewrite.
    * **experience** — sheet "Kitne saal se machine chala rahe hain?" names a MACHINE,
      and `experience` is a SHARED topic served by every family including `generic`
      (a tailor, a cook) and the two design families. It is the machining pack's
      phrasing, and the sheet's own Core × Pack architecture says pack vocabulary does
      not belong in a Core question.
    * **current_location** — sheet "Abhi kahan rehte hain?" vs bank "Abhi kis sheher
      mein hain?". The bank asks for the CITY on purpose: `detect_answered_topics` keys
      `current_location` on `current_city` ONLY, and a state-only answer deliberately
      does NOT close it (there is a dedicated test for that). "Kahan rehte hain"
      invites a state or a locality.
    """
    from app.profiling.question_bank import topic_by_id

    assert topic_by_id("cnc_vmc", "role").question == "Aap kaunsa kaam karte hain?"
    assert topic_by_id("cnc_vmc", "experience").question == "Kitne saal ka experience hai?"
    assert topic_by_id("cnc_vmc", "current_location").question == "Abhi kis sheher mein hain?"
    assert "Mitsubishi" in topic_by_id("cnc_vmc", "controllers").question
    # The measured reason the controllers row was not adopted.
    assert signals.detect_answered_topics("Fanuc ya Siemens?", None) == {
        "controllers": ["Fanuc", "Siemens"]
    }
    # The measured reason the trade row was not adopted alone.
    from app.profiling.question_bank import ONE_SHOT_OPENER

    assert topic_by_id("cnc_vmc", "role").question.lower() in ONE_SHOT_OPENER.lower()
