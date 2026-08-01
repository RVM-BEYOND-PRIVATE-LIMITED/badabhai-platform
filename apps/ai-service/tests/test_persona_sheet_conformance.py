"""Conformance against the RATIFIED persona sheet — docs/specs/persona-system-v3.2.md.

WHY THIS FILE EXISTS, and it is not "more persona tests". `test_persona_neutrality.py`
checks the strings we SAY. §5 of the sheet ("What he does when it gets awkward") is a
table of BEHAVIOURS, and several of its rows have no counterpart in code at all. A rule
that lives only in a document drifts silently; a rule that is measured — even when the
measurement records an ABSENCE — cannot.

Every §5 row is EXECUTED here. As of the 2026-07-31 owner ruling all ten rows are
either implemented or explained:

* Law 8 ("nahi pata" is a complete answer) is now UNIVERSAL — an explicit don't-know
  closes any topic, essentials included, and the INTERVIEW-1 bounded re-ask keeps its
  real job (a reply the detector could not key at all).
* The four §5 rows that were measured absent are BUILT: "Koi baat nahi.",
  "Samajh sakta hoon.", the "job milegi?" guarantee line, and the neutral line after
  abuse. Each is a deterministic string on a detected condition — no LLM, no cost, and
  no extra turn (§4: "character is a REWRITE of a line, never an ADDITION to it").

THE FALSE-POSITIVE TESTS ARE THE HARD PART, and they are the reason this file is long.
A softener that fires on the wrong turn is worse than no softener — the sheet's own
"faked fluency is worse than plainness" — so every trigger carries an adversarial
negative set, and three exclusions are recorded with the measurement that produced
them: "yaad nahi" (a worker who HAS a certificate but forgot its name), "bastard"
(a bastard file is a real hand tool), and "mc"/"bc" ("m/c" is shop-floor shorthand for
machine). Where detection could not be made safe, the line is NOT emitted.

The two rows that remain PARTIAL (unmarked contradictions; "clarify once if trade or
location") are still pinned as measured absences at the bottom, and implementing them
will turn those tests red on purpose.
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
# §2 Law 8 — "'Nahi pata' is a complete answer", now UNIVERSAL
# ---------------------------------------------------------------------------
# Owner ruling 2026-07-31. Before it, only {skills, education, certifications} could be
# closed by a denial, so a worker who said "nahi pata" to the MACHINES question was
# re-asked it (measured: ask_counts == 2) — "never re-ask" broken on exactly the topics
# where being asked twice stings most. The ruling separates the two cases that were
# conflated: an EXPLICIT don't-know is an ANSWER, an UNKEYABLE reply is not.


def test_law_8_an_explicit_dont_know_closes_ANY_topic_including_an_essential():
    _r, asked1, st1, _rd = interview_engine.next_turn(None, "cnc turner hoon", "cnc_vmc")
    assert asked1 == "machines"  # an ESSENTIAL, and previously re-askable
    _r, asked2, st2, _rd = interview_engine.next_turn(st1, "nahi pata", "cnc_vmc")
    assert "machines" in st2.answered_topics, "the sheet says accept it and move on"
    assert asked2 != "machines", "the sheet says NEVER re-ask"
    assert st2.ask_counts["machines"] == 1  # ...and no re-ask budget was spent
    assert "machines" not in st2.collected  # answered, but nothing invented
    assert "machines" not in st2.unanswered_essentials  # it was answered, not skipped


def test_law_8_holds_for_every_topic_in_every_family():
    """"Absolute, no exceptions" — swept over every bank rather than spot-checked."""
    from app.profiling.question_bank import _TOPICS_BY_FAMILY

    for family, topics in _TOPICS_BY_FAMILY.items():
        for topic in topics:
            detected = signals.detect_answered_topics("nahi pata", topic.id)
            assert detected == {topic.id: None}, f"{family}:{topic.id} -> {detected}"


def test_law_8_covers_the_real_spoken_variants():
    for phrase in (
        "nahi pata",
        "nahin pata",
        "pata nahi",
        "pata nahin",
        "pta nahi",
        "nahi pta",
        "maloom nahi",
        "nahi maloom",
        "malum nahi",
        "maalum nahi",
        "nahi jaanta",
        "nahi janta",
        "idk",
        "dunno",
        "I don't know",
        "i do not know",
        "no idea",
        "controller ka naam nahi pata",
        "pata nahi konsa hai",
    ):
        assert signals.is_dont_know(phrase), phrase
        assert signals.detect_answered_topics(phrase, "machines") == {"machines": None}, phrase


def test_law_8_does_NOT_fire_on_the_forms_that_were_measured_unsafe():
    """THE HARD PART. The cost is asymmetric — a missed close is recoverable, a
    wrongly-closed essential is not — so every ambiguous form was left out, each on a
    measurement rather than on taste.

    "yaad nahi" is the one that matters. It reads as a don't-know in isolation, but the
    repo's own answer corpus carries `certifications: "certificate hai par naam yaad
    nahi"` — a worker who HAS a certificate and cannot recall its name — and that
    string keys NOTHING (asserted below), so the not-already-answered guard would not
    have saved it. Including "yaad nahi" would have closed the certifications topic for
    a worker who just said they hold one.

    Bare "nahi" is excluded for a different reason: to an open question it is not a
    don't-know at all, and to a yes/no question it is a DENIAL, which the existing
    `_NEGATABLE_TOPIC_CUES` path already handles where a denial is a complete answer.
    """
    ambiguous = "certificate hai par naam yaad nahi"
    assert signals.is_dont_know(ambiguous) is False
    # The precondition that makes the exclusion load-bearing: nothing else keys it, so
    # firing here would have closed the topic outright.
    assert signals.detect_answered_topics(ambiguous, "certifications") == {}

    for not_a_dont_know in (
        "nahi",
        "nahi kiya",
        "ITI nahi kiya",
        "VMC nahi chalaya",
        "setting nahi aati",
        "abhi kaam nahi hai",
        "yaad nahi",
        "5 saal ka experience hai",
        "sab pata hai",
        "machine ka naam Fanuc hai",
    ):
        assert signals.is_dont_know(not_a_dont_know) is False, not_a_dont_know


def test_law_8_never_overwrites_a_real_value_in_the_same_message():
    """The guard that keeps the close from eating an answer: a message carrying BOTH a
    don't-know and a real value for the topic on screen keeps the VALUE."""
    detected = signals.detect_answered_topics("controller pata nahi, VMC chalata hu", "machines")
    assert detected["machines"] == ["VMC"], detected
    # ...and an incidental don't-know can never close a topic that was NOT being asked.
    assert "controllers" not in signals.detect_answered_topics("pata nahi", "machines")
    assert signals.detect_answered_topics("pata nahi", None) == {}


def test_law_8_leaves_the_bounded_re_ask_intact_for_an_UNKEYABLE_reply():
    """The other half of the ruling. INTERVIEW-1's re-ask keeps its real purpose — a
    reply the finite gazetteer could not key at all still earns the topic's
    `retry_question`, because that is a different situation from a don't-know."""
    _r, asked1, st1, _rd = interview_engine.next_turn(None, "cnc turner hoon", "cnc_vmc")
    assert asked1 == "machines"
    _r, asked2, st2, _rd = interview_engine.next_turn(st1, "haan ji theek hai", "cnc_vmc")
    assert asked2 == "machines"  # unkeyable, NOT a don't-know -> re-asked
    assert st2.ask_counts["machines"] == 2
    assert "machines" not in st2.answered_topics


# ---------------------------------------------------------------------------
# §5 rows now BUILT — each a deterministic string on a detected condition
# ---------------------------------------------------------------------------
# No LLM, no cost, no extra turn. Each occupies the acknowledgement slot the turn
# already had, so §4's "character is a REWRITE of a line, never an ADDITION to it"
# holds and the served turn is still [ack] + [ONE question].
#
# THE FALSE-POSITIVE TESTS ARE THE POINT. A softener that fires on the wrong turn is
# worse than no softener ("faked fluency is worse than plainness"), so every trigger
# below is tested against an adversarial negative set as well as its positives.


def _second_turn_reply(first: str, second: str) -> str:
    """Serve two turns and return the SECOND reply. Turn 1 is the vocative/greeting
    slot (no acknowledgement), so every §5 ack variant is a turn-2-onwards behaviour —
    stated here once rather than repeated in each test."""
    _r1, _a1, state, _rd1 = interview_engine.next_turn(None, first, "cnc_vmc")
    reply, _a2, _st2, _rd2 = interview_engine.next_turn(state, second, "cnc_vmc")
    return reply


def test_row_nahi_pata_is_met_with_koi_baat_nahi():
    """§5 row 1: "'Koi baat nahi.' → next question. No teaching, no re-ask, no
    disappointment. **No appreciation on this turn.**" """
    reply = _second_turn_reply("cnc turner hoon", "nahi pata")
    assert reply.startswith(_SOFTENER_NAHI_PATA), reply
    assert reply.count("?") == 1  # ...still exactly one question, no extra sentence
    assert "Theek hai." not in reply  # it REPLACED the ack, it did not add to it
    # No appreciation on this turn (the engine emits none at all).
    for appreciation in ("Bahut khoob", "Bahut bhadiya", "Solid", "badhiya"):
        assert appreciation not in reply


def test_row_hardship_is_met_with_samajh_sakta_hoon_and_NEVER_with_achievement():
    """§5 / conversation 06: "One line, ≤8 words, no advice", **fires on hardship,
    never on achievement**. Both arms are asserted, and the achievement arm is the one
    that matters — consoling someone who just described a promotion is the tonal
    failure the sheet is guarding against."""
    assert len(_SOFTENER_HARDSHIP.split()) <= 8

    hardship = _second_turn_reply(
        "cnc turner hoon", "5 saal. 6 mahine se kaam nahi mila, ghar chalana mushkil hai"
    )
    assert hardship.startswith(_SOFTENER_HARDSHIP), hardship
    assert hardship.count("?") == 1
    # ...and NO advice was added — the line is followed straight by the next question.
    for advice in ("koshish", "try kar", "aap ko chahiye", "seekh l", "sabar"):
        assert advice not in hardship.lower(), hardship

    for achievement in (
        "8 saal ho gaye, ab main pura setup khud karta hoon",
        "promotion mil gaya tha",
        "supervisor ban gaya hu",
        "salary badh gayi thi",
        "ab main pura program khud likhta hu",
    ):
        reply = _second_turn_reply("cnc turner hoon", achievement)
        assert _SOFTENER_HARDSHIP not in reply, f"consoled an achievement: {achievement!r}"


def test_hardship_detection_never_fires_on_DIFFICULT_WORK():
    """The subtler false positive, and the reason `is_hardship` is a phrase list rather
    than a keyword list: "mushkil" on its own is a worker describing HARD WORK, which is
    closer to a capability claim than to hardship."""
    for difficult_work in (
        "setting mushkil hoti hai par kar leta hu",
        "yeh kaam mushkil hai lekin aata hai",
        "machine chalana mushkil nahi hai",
        "mushkil job bhi kar leta hu",
        "6 mahine se VMC chala raha hu",
        "3 saal se yahi kaam kar raha hu",
        "abhi kaam kar raha hu",
        "job change karna hai",
    ):
        assert signals.is_hardship(difficult_work) is False, difficult_work


def test_hardship_detection_fires_on_the_real_forms():
    for hardship in (
        "6 mahine se kaam nahi mila, ghar chalana mushkil hai",
        "ghar chalana mushkil ho raha hai",
        "kaam nahi mil raha hai",
        "bahut pareshan hu",
        "naukri chali gayi thi",
        "8 mahine se job nahi mili",
        "paise ki tang hai",
        "nikal diya gaya tha",
    ):
        assert signals.is_hardship(hardship) is True, hardship


def test_row_job_milegi_gets_the_guarantee_line_then_the_OPEN_question_back():
    """§5 / conversations 02 and 06 — **the row that replaced silence**.

    Before this, a worker asking a direct, anxious question was detected as nothing,
    the engine advanced, and the question went unanswered. The sheet's answer is
    honesty, and it must come with the OPEN question back — not the next one."""
    from app.contracts import ConversationState

    state = ConversationState(
        role_family="cnc_vmc", turn_count=1, asked_question_ids=["machines"],
        ask_counts={"machines": 1}, answered_topics=["role"],
    )
    out = interview_engine.clarify_turn(state, "sir job mil jayegi na?", "cnc_vmc")
    assert out is not None, "the job question must not fall through to next_turn"
    reply, asked_id, updated, _ready = out
    assert reply.startswith(_GUARANTEE_LINE), reply
    # ...back to the OPEN question, verbatim, not the next topic.
    assert asked_id == "machines"
    assert reply.endswith(topics_for("cnc_vmc")[1].question)
    assert reply.count("?") == 1  # the guarantee line itself asks nothing
    # "back to the open question" is explicitly NOT counted as re-asking.
    assert updated.ask_counts["machines"] == 1
    assert updated.asked_question_ids == ["machines"]
    # Law 9: it refuses the guarantee rather than making one.
    assert "nahi de sakta" in reply
    for promise in ("pakka job", "job pakki", "guarantee hai", "mil jayegi"):
        assert promise not in reply.lower()


def test_the_job_question_trigger_needs_a_QUESTION_shape_not_just_the_words():
    """THE FALSE POSITIVE THIS AVOIDS, measured on the repo's own answer corpus: the
    word cue alone fires on `availability: "abhi job kar raha hu, 1 mahina lagega"` —
    a worker ANSWERING the notice-period question. Requiring an interrogative shape as
    well drops corpus hits to zero without losing the sheet's own two phrasings."""
    for asking in (
        "sir job mil jayegi na?",
        "job milegi kya?",
        "kaam mil jayega?",
        "naukri lagegi?",
        "kab tak kaam milega?",
        "Sir kuch bhi mil jaye. Job mil jayegi na?",
    ):
        assert signals.asks_about_job_prospects(asking) is True, asking

    for not_asking in (
        "abhi job kar raha hu, 1 mahina lagega",  # the measured corpus fixture
        "job change karna hai",
        "naukri chhod di thi",
        "kaam milta hai regular",
        "5 saal se job kar raha hu",
        "job nahi hai abhi",
    ):
        assert signals.asks_about_job_prospects(not_asking) is False, not_asking


def test_an_answer_always_beats_the_guarantee_line():
    """The guard that stops the new row eating data: `clarify_turn`'s
    answer-trumps-clarify still runs first, so a message that carries an extractable
    answer advances the engine even if it also reads as a job question."""
    from app.contracts import ConversationState

    state = ConversationState(
        role_family="cnc_vmc", turn_count=1, asked_question_ids=["availability"],
        ask_counts={"availability": 1},
    )
    message = "15 din lagenge, job milegi kya?"
    assert interview_engine.clarify_turn(state, message, "cnc_vmc") is None


def test_row_abusive_gets_one_neutral_line_and_the_interview_continues():
    """§5: "One neutral line, continues. Never mirrors tone, never moralises."

    The neutral line is "Chalo." — a member of §3's CLOSED acknowledgement set whose
    meaning is *moving on*. The sheet supplies no string for this row, and inventing a
    sentence is how a bot ends up moralising."""
    reply = _second_turn_reply("cnc turner hoon", "tum chutiya ho")
    assert reply.startswith("Chalo. "), reply
    assert reply.count("?") == 1  # it CONTINUED — the next question was served
    lowered = reply.lower()
    for moralising in ("aisa mat", "tameez", "please be", "polite", "galat baat", "gaali"):
        assert moralising not in lowered, reply
    # Never mirrors: nothing from the worker's message comes back.
    assert "chutiya" not in lowered


def test_abuse_detection_excludes_the_shop_floor_words_that_were_measured_unsafe():
    """THE HARD PART for this row, and the reason the gazetteer is short.

    Two measured exclusions:
      * "bastard" — A BASTARD FILE IS A REAL TOOL, the coarse-cut hand file every
        fitter owns. It matched "bastard file" and was removed outright.
      * "mc" / "bc" — "m/c" is the standard shop-floor shorthand for MACHINE. No
        abbreviation is safe here.
    Plus the mild/ambiguous family (kutta, saale, harami, kamine), where "saal" = years
    appears in almost every experience answer.
    """
    for innocent in (
        "bastard file se finish karta hu",
        "m/c chalata hu",
        "mc operator hu",
        "MC pe kaam kiya",
        "bc",
        "kutta nahi",
        "5 saal ka experience",
        "saal bhar kaam kiya",
        "harmonic drive",
        "gandhi nagar me rehta hu",
        "randomly kaam milta hai",
    ):
        assert signals.is_abusive(innocent) is False, innocent

    for abusive in ("tum chutiya ho", "bhosdike", "fuck you", "madarchod", "gaandu"):
        assert signals.is_abusive(abusive) is True, abusive


# ---------------------------------------------------------------------------
# End to end, through the ROUTE — the sheet's own worked conversation 06
# ---------------------------------------------------------------------------


def test_worked_conversation_06_reproduces_through_the_real_endpoint():
    """§6 conversation 06 — "the hard one": a "nahi pata", hardship, and "job milegi?"
    in one exchange. Three of the four new rows fire in sequence.

    Asserted through ``POST /profiling/respond`` rather than the engine, because the
    guarantee line only reaches a worker if the ENDPOINT routes a job question to the
    re-serve path — a wiring step the engine tests cannot see. The sheet's own lines:

        W:  Nahi pata, bas rod se welding karta hoon
        BB: Koi baat nahi. Kitne saal ...
        W:  5 saal. 6 mahine se kaam nahi mila, ghar chalana mushkil hai
        BB: Samajh sakta hoon. Abhi kahan ...
        W:  Sir kuch bhi mil jaye. Job mil jayegi na?
        BB: Guarantee nahi de sakta — profile poora hoga toh companies dekhengi.
    """
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)

    def post(message: str, state: dict | None) -> dict:
        body: dict = {
            "session_id": "11111111-1111-4111-8111-111111111111",
            "worker_ref": "w-conv06",
            "message_text": message,
            "role_family": "cnc_vmc",
        }
        if state is not None:
            body["conversation_state"] = state
        response = client.post("/profiling/respond", json=body)
        assert response.status_code == 200, response.text
        return response.json()

    turn = post("welder hoon", None)
    state = turn["updated_state"]
    assert state["role_family"] == "welding"
    assert turn["asked_question_id"] == "equipment"  # welding's ESSENTIAL equipment slot

    # 1. "Nahi pata" -> "Koi baat nahi.", and the ESSENTIAL is CLOSED, not re-asked.
    turn = post("Nahi pata, bas rod se welding karta hoon", state)
    state = turn["updated_state"]
    assert turn["reply_text"].startswith("Koi baat nahi. ")
    assert "equipment" in state["answered_topics"]
    assert turn["asked_question_id"] != "equipment"
    assert state["ask_counts"]["equipment"] == 1  # no re-ask budget spent
    # The worker's "wrong" word is accepted as said — role/skills came from it.
    assert "role" in state["answered_topics"]

    # 2. Hardship -> "Samajh sakta hoon.", then straight on.
    turn = post("5 saal. 6 mahine se kaam nahi mila, ghar chalana mushkil hai", state)
    state = turn["updated_state"]
    assert turn["reply_text"].startswith("Samajh sakta hoon. ")
    assert turn["reply_text"].count("?") == 1
    open_question_id = turn["asked_question_id"]
    open_counts = dict(state["ask_counts"])

    # 3. "Job milegi?" -> honesty, then BACK to the open question. Not silence, and
    #    not an advance.
    turn = post("Sir kuch bhi mil jaye. Job mil jayegi na?", state)
    state = turn["updated_state"]
    assert turn["reply_text"].startswith(_GUARANTEE_LINE)
    assert turn["asked_question_id"] == open_question_id, "it advanced instead of returning"
    assert state["ask_counts"] == open_counts, "returning to the open question counted as an ask"
    assert turn["reply_text"].count("?") == 1
    assert turn["is_mock"] is True  # deterministic — no LLM call was spent on any of it


def test_the_guarantee_line_can_never_be_handed_to_the_LLM_to_reword(monkeypatch):
    """§2 Law 9. The guarantee line is a verbatim COMMITMENT, not phrasing — a model
    asked to make it friendlier produces the promise the sheet forbids.

    THE OVERLAP THAT MAKES THIS NECESSARY, measured: `needs_rephrase("job milegi kya?")`
    is True (3 words, ends in "?"), so a job question is ALSO a clarify by the short-
    question rule. Without the explicit exclusion in the endpoint, turning on
    AI_PROFILING_REPHRASE_ENABLED would send the guarantee line to the provider as the
    text to rephrase. Inert today (the flag is off), which is exactly why it needed a
    test rather than a reader noticing."""
    from app import main as main_module
    from app.config import Settings

    assert interview_engine.needs_rephrase("job milegi kya?") is True  # the overlap
    assert signals.asks_about_job_prospects("job milegi kya?") is True

    from datetime import UTC, datetime

    from app.contracts import AICallMetadata

    calls: list[dict] = []

    async def _spy_run(task, *, messages, mock_response, real_call_allowed, user_ref=None, **kw):
        calls.append({"real_call_allowed": real_call_allowed, "mock_response": mock_response})
        return mock_response, AICallMetadata(
            ai_call_id="00000000-0000-4000-8000-000000000000",
            task_type="profiling_chat_turn",
            model_name="mock",
            provider="mock",
            real_call=False,
            input_tokens=0,
            output_tokens=0,
            estimated_cost_inr=0.0,
            latency_ms=0,
            success=True,
            error_code=None,
            created_at=datetime.now(UTC).isoformat(),
        )

    monkeypatch.setattr(main_module.router, "run", _spy_run)
    # The rephrase flag ON — the only configuration in which this could ever fire.
    monkeypatch.setattr(
        main_module,
        "settings",
        Settings(_env_file=None, ai_profiling_rephrase_enabled=True),
    )

    from fastapi.testclient import TestClient

    client = TestClient(main_module.app)
    state = {
        "role_family": "cnc_vmc",
        "turn_count": 1,
        "answered_topics": ["role"],
        "asked_question_ids": ["machines"],
        "collected": {},
        "ask_counts": {"machines": 1},
    }
    client.post(
        "/profiling/respond",
        json={
            "session_id": "11111111-1111-4111-8111-111111111111",
            "worker_ref": "w-guarantee",
            "message_text": "job milegi kya?",
            "conversation_state": state,
        },
    )
    assert calls, "the router was never reached"
    assert calls[-1]["mock_response"].startswith(_GUARANTEE_LINE)  # it IS the line...
    assert calls[-1]["real_call_allowed"] is False, "the guarantee line was sent to be reworded"

    # ...while an ORDINARY clarify still gets its rephrase call, so the exclusion is
    # narrow rather than a blanket disable.
    calls.clear()
    client.post(
        "/profiling/respond",
        json={
            "session_id": "11111111-1111-4111-8111-111111111111",
            "worker_ref": "w-guarantee",
            "message_text": "matlab kya?",
            "conversation_state": state,
        },
    )
    assert calls[-1]["real_call_allowed"] is True


def test_none_of_the_new_triggers_fires_on_an_ordinary_answer():
    """The sweep that keeps the four new rows out of the straight-line path: over the
    whole 314-fixture answer corpus, an ordinary reply gets the neutral ack."""
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from profiling_answer_corpus import CORPUS

    for fixture in CORPUS:
        assert signals.is_hardship(fixture.text) is False, fixture.text
        assert signals.is_abusive(fixture.text) is False, fixture.text
        assert signals.asks_about_job_prospects(fixture.text) is False, fixture.text


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
