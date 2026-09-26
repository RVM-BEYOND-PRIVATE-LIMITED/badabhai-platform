"""ADR-0035 job-posting chat: bank, deterministic engine, and the two routes.

The five properties this file exists to LOCK (everything else is supporting cover):

1. ``_next_topic`` priority — unanswered essential -> core -> optional.
2. Pseudonymization fails CLOSED, and a blocked turn reaches neither the engine nor
   any model.
3. The interview TERMINATES: MAX_ASKS_PER_TOPIC and MAX_ENGINE_ASKS hold even when
   answer detection is totally blind.
4. count -> vacancy_band matches the TypeScript ``bandForCount`` boundary table
   EXACTLY, including the 25/26 edge.
5. NO question in the bank ever asks for the payer's company/organisation name.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.contracts import JobPostingChatState
from app.job_posting_chat import answers, interview_engine, prompts, question_bank
from app.main import app

client = TestClient(app)


# --- 5. The org-name rule (ADR-0035 §Decision 3) ----------------------------
# Mechanical, not a comment: the payer's organisation name is already on
# `payers.orgNameEnc` and is stamped server-side at publish. Asking for it in free
# text would duplicate data we hold AND invite the payer to type a personal name or
# phone next to it.
_ORG_ASK_MARKERS = (
    "company",
    "organisation",
    "organization",
    "firm",
    "business name",
    "employer name",
    "your org",
)


def _bank_strings() -> list[str]:
    out: list[str] = [question_bank.OPENING_MESSAGE]
    for topic in question_bank.topics_for():
        out.extend([topic.label, topic.question, topic.why or "", topic.retry_question or ""])
        out.extend(topic.options)
    return [s for s in out if s]


@pytest.mark.parametrize("text", _bank_strings())
def test_no_bank_string_ever_asks_for_the_company_or_org_name(text: str):
    lowered = text.lower()
    for marker in _ORG_ASK_MARKERS:
        assert marker not in lowered, (
            f"{text!r} mentions {marker!r} — the payer's organisation name is NEVER "
            "asked in the chat (ADR-0035 §Decision 3); it is auto-filled server-side "
            "from payers.orgNameEnc at publish and never reaches this service."
        )


def test_the_system_prompt_explicitly_forbids_asking_for_the_org_name():
    """Defense in depth for the day the rephrase seam is wired: the bank cannot ask
    for it, and the model is told not to either."""
    lowered = prompts.JOB_POSTING_SYSTEM_PROMPT.lower()
    assert "never ask for the company" in lowered
    assert "phone number" in lowered  # and no contact person / phone / email either


def test_the_draft_the_engine_builds_has_no_org_field():
    draft = interview_engine.build_draft(None)
    assert "org_label" not in draft.model_dump()


# --- 4. count -> band, mirrored from packages/validators --------------------
# The boundary table is copied VERBATIM from packages/validators/src/validators.test.ts
# so the two implementations cannot drift. Note 25 -> "11-25" (25+ is strictly > 25).
@pytest.mark.parametrize(
    ("count", "band"),
    [
        (1, "1"),
        (2, "2-5"),
        (5, "2-5"),
        (6, "6-10"),
        (7, "6-10"),
        (10, "6-10"),
        (11, "11-25"),
        (25, "11-25"),
        (26, "25+"),
        (100, "25+"),
    ],
)
def test_band_for_count_matches_the_typescript_boundaries(count: int, band: str):
    assert answers.band_for_count(count) == band


@pytest.mark.parametrize("bad", [0, -1, 1.5, float("nan"), "5", True, None])
def test_band_for_count_fails_closed_on_a_non_positive_integer(bad: object):
    """The TS helper raises RangeError on the same inputs. Failing closed matters:
    silently banding a bad value to "1" would understate a posting's demand."""
    with pytest.raises(ValueError):
        answers.band_for_count(bad)  # type: ignore[arg-type]


def test_the_band_set_matches_the_contract_literal():
    """`answers.VACANCY_BANDS` and the Pydantic/Zod `vacancy_band` literal are two
    copies of one closed set — pin them together."""
    from typing import get_args

    from app.contracts import VacancyBand

    assert tuple(get_args(VacancyBand)) == answers.VACANCY_BANDS


def test_a_vacancy_answer_is_recorded_as_a_band_never_as_an_integer():
    state = None
    _, _, state, _ = interview_engine.next_turn(state, "CNC Operator")
    _, _, state, _ = interview_engine.next_turn(state, "Pune")
    _, _, state, _ = interview_engine.next_turn(state, "7")
    assert state.collected["vacancy"] == "6-10"
    assert interview_engine.build_draft(state).vacancy_band == "6-10"
    # ADR-0012: the raw count is intake-only and is never carried anywhere.
    assert 7 not in state.collected.values()


# --- 1. Topic priority ------------------------------------------------------
def _blind(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make answer detection TOTALLY blind — every safety bound below must hold on a
    payer whose every answer we fail to parse, which is the case the bounds exist
    for."""
    monkeypatch.setattr(answers, "detect_answers", lambda *_a, **_k: {})


def _drive(state, messages: list[str]):
    asked: list[str | None] = []
    for message in messages:
        _, asked_id, state, _ = interview_engine.next_turn(state, message)
        asked.append(asked_id)
    return asked, state


def test_next_topic_serves_essentials_first_then_core_then_optional(
    monkeypatch: pytest.MonkeyPatch,
):
    _blind(monkeypatch)
    asked, _ = _drive(None, ["x"] * 17)
    assert asked == [
        # 1. Every unanswered ESSENTIAL, each with its ONE bounded re-ask.
        "role_title",
        "role_title",
        "location_label",
        "location_label",
        "city",
        "city",
        "vacancy",
        "vacancy",
        # 2. Unanswered CORE topics, asked once. No pay_type: the pay question yielded
        #    no figure, so "is that pay in-hand?" would ask about nothing (moot).
        "skills",
        "pay_range",
        "experience",
        # 3. Unanswered OPTIONAL topics, asked once.
        "shift",
        "needed_by",
        "benefits",
        "requirements",
        "description",
        # Bank drained -> wrap-up asks nothing.
        None,
    ]


def test_the_re_ask_serves_the_retry_wording_not_the_original(
    monkeypatch: pytest.MonkeyPatch,
):
    """Re-serving an identical string reads as broken. The retry wording is a UX
    rewording, NOT a detection fix — it cannot make an unparseable answer parse."""
    _blind(monkeypatch)
    first, _, state, _ = interview_engine.next_turn(None, "x")
    second, _, _, _ = interview_engine.next_turn(state, "x")
    role = question_bank.topic_by_id("role_title")
    assert first == role.question
    assert second.endswith(role.retry_question)


def test_an_answered_topic_is_never_served_again():
    state = None
    _, _, state, _ = interview_engine.next_turn(state, "MIG Welder")
    assert "role_title" in state.answered_topics
    asked, _ = _drive(state, ["x"] * 12)
    assert "role_title" not in asked


def test_essentials_are_served_before_a_core_topic_even_when_core_comes_first():
    """`skills` sits SECOND in the bank but is not essential, so it must wait for every
    essential — the priority is the engine's, not the bank's reading order. ("Pune"
    closes location_label AND city, so city is never served here.)"""
    asked, _ = _drive(None, ["MIG Welder", "Pune"])
    assert asked == ["location_label", "vacancy"]


# --- 3. Termination bounds --------------------------------------------------
def test_a_blind_interview_still_terminates_well_inside_the_ask_budget(
    monkeypatch: pytest.MonkeyPatch,
):
    _blind(monkeypatch)
    state = None
    served = 0
    for _ in range(200):
        _, asked_id, state, ready = interview_engine.next_turn(state, "x")
        if asked_id is None:
            break
        served += 1
    else:  # pragma: no cover - only reached if the engine never wraps
        pytest.fail("the interview never wrapped up")
    # 4 essentials x MAX_ASKS_PER_TOPIC + 8 ask-once topics (pay_type is moot: the
    # blind pay answer yielded no figure) — a literal AND the arithmetic, so a bank
    # edit that changes either is noticed here.
    assert served == 16
    essentials = len(interview_engine.ESSENTIAL_TOPICS)
    ask_once = len(question_bank.topic_ids()) - essentials - 1
    assert served == essentials * interview_engine.MAX_ASKS_PER_TOPIC + ask_once
    assert ready is True


def test_the_worst_case_run_still_fits_the_ask_budget(monkeypatch: pytest.MonkeyPatch):
    """The TRUE worst case is blind everywhere EXCEPT the pay figure: then pay_type is
    owed too, so every topic is served — 4 essentials x 2 + 9 ask-once = 17."""
    monkeypatch.setattr(
        answers,
        "detect_answers",
        lambda _m, last_asked, **_k: (
            {"pay_range": {"pay_min": 20000, "pay_max": 25000}} if last_asked == "pay_range" else {}
        ),
    )
    state = None
    served: list[str] = []
    for _ in range(200):
        _, asked_id, state, ready = interview_engine.next_turn(state, "x")
        if asked_id is None:
            break
        served.append(asked_id)
    else:  # pragma: no cover - only reached if the engine never wraps
        pytest.fail("the interview never wrapped up")
    assert "pay_type" in served
    essentials = len(interview_engine.ESSENTIAL_TOPICS)
    ask_once = len(question_bank.topic_ids()) - essentials
    assert len(served) == 17 == essentials * interview_engine.MAX_ASKS_PER_TOPIC + ask_once
    assert ready is True
    # The ceiling must keep REAL headroom over the worst-case run, so a bank that
    # grows by a topic or two cannot silently start truncating the interview (the
    # exact zero-margin coupling the worker engine shipped and had to fix).
    assert interview_engine.MAX_ENGINE_ASKS >= len(served) + 4


def test_no_topic_is_ever_asked_more_than_max_asks_per_topic(
    monkeypatch: pytest.MonkeyPatch,
):
    _blind(monkeypatch)
    asked, state = _drive(None, ["x"] * 20)
    for topic_id in question_bank.topic_ids():
        assert asked.count(topic_id) <= interview_engine.MAX_ASKS_PER_TOPIC
        assert state.ask_counts.get(topic_id, 0) <= interview_engine.MAX_ASKS_PER_TOPIC


def test_the_engine_ask_ceiling_wraps_the_interview_whatever_is_still_open():
    """MAX_ENGINE_ASKS is the final backstop: past it we wrap up even with every
    essential unanswered. The gap is then DECLARED, never silently dropped."""
    spent = JobPostingChatState(
        turn_count=5,  # past turn 1, so the opener's attribution does not apply
        ask_counts={"role_title": interview_engine.MAX_ENGINE_ASKS},
    )
    reply, asked_id, state, ready = interview_engine.next_turn(spent, "x")
    assert asked_id is None
    assert ready is True
    assert state.unanswered_essentials == list(interview_engine.ESSENTIAL_TOPICS)
    assert "ready" in reply.lower()


def test_a_negative_stored_ask_count_cannot_buy_extra_asks():
    """`collected`/`ask_counts` round-trip through a jsonb column and a model_copy
    does not re-validate, so the bound must hold for values Pydantic never saw."""
    tampered = JobPostingChatState(
        asked_question_ids=["role_title"],
        ask_counts={},
    )
    tampered.ask_counts["role_title"] = -5
    tampered.ask_counts["skills"] = interview_engine.MAX_ENGINE_ASKS
    _, asked_id, _, _ = interview_engine.next_turn(tampered, "x")
    # The huge positive still trips the ceiling; the negative does not drag it down.
    assert asked_id is None


def test_a_clarify_streak_can_never_loop_the_interview():
    _, asked_id, state, _ = interview_engine.next_turn(None, "CNC Operator")
    seen = []
    for _ in range(5):
        turn = interview_engine.clarify_turn(state, "what do you mean?")
        if turn is None:
            break
        reply, _, state, _ = turn
        seen.append(reply)
    assert len(seen) == 2  # _MAX_CONSECUTIVE_CLARIFIES
    # A clarify is not an ask: the budget stays clarify-immune, so a confused payer
    # can never silently delete topics from the TAIL of the interview.
    assert state.ask_counts[asked_id] == 1
    assert state.asked_question_ids == [asked_id]


def test_an_extractable_answer_is_never_eaten_by_the_clarify_path():
    """`needs_rephrase` has false positives (a short "?"-suffixed answer). Answer
    trumps clarify — the engine must advance, not re-serve."""
    _, _, state, _ = interview_engine.next_turn(None, "CNC Operator")  # asks location
    assert interview_engine.needs_rephrase("Pune?") is True
    assert interview_engine.clarify_turn(state, "Pune?") is None


def test_clarify_re_serves_the_wording_the_payer_actually_saw(
    monkeypatch: pytest.MonkeyPatch,
):
    _blind(monkeypatch)
    _, _, state, _ = interview_engine.next_turn(None, "x")
    _, _, state, _ = interview_engine.next_turn(state, "x")  # role_title, 2nd ask
    reply, topic_id, _, _ = interview_engine.clarify_turn(state, "what do you mean?")
    assert topic_id == "role_title"
    assert reply == question_bank.topic_by_id("role_title").retry_question


# --- Answer detection -------------------------------------------------------
def test_every_chip_resolves_its_own_topic():
    """A tapped chip is sent VERBATIM as the payer's message, so an option that does
    not resolve its own topic is worse than no chip at all: the payer taps, sees
    their words in the transcript, and the field stays empty."""
    for topic in question_bank.topics_for():
        for option in topic.options:
            detected = answers.detect_answers(option, topic.id)
            assert topic.id in detected, f"{option!r} does not resolve {topic.id}"
            assert detected[topic.id] is not None


def test_attribution_reads_the_answer_to_the_question_on_screen():
    assert answers.detect_answers("Pune", "location_label")["location_label"] == "Pune"
    assert answers.detect_answers("Night", "shift")["shift"] == "night"
    assert answers.detect_answers("2-5", "vacancy")["vacancy"] == "2-5"


def test_the_three_cue_gated_cross_topic_extractors_let_a_payer_front_load():
    detected = answers.detect_answers(
        "we need 5 welders, night shift, Rs 20,000 to 25,000", "role_title"
    )
    assert detected["role_title"] == "welders"
    assert detected["vacancy"] == "2-5"
    assert detected["shift"] == "night"
    assert detected["pay_range"] == {"pay_min": 20000, "pay_max": 25000}


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("20-25k", {"pay_min": 20000, "pay_max": 25000}),
        ("Rs 18,000 - Rs 22,000", {"pay_min": 18000, "pay_max": 22000}),
        ("18000 to 22000", {"pay_min": 18000, "pay_max": 22000}),
        ("between 18000 and 22000", {"pay_min": 18000, "pay_max": 22000}),
        ("around 20k per month", {"pay_min": 20000, "pay_max": None}),
        ("2 lakh monthly", {"pay_min": 200000, "pay_max": None}),
        ("1.5 lakh to 2 lakh", {"pay_min": 150000, "pay_max": 200000}),
        ("25,000/- per month", {"pay_min": 25000, "pay_max": None}),
    ],
)
def test_pay_parsing(text: str, expected: dict):
    assert answers.detect_answers(text, "pay_range")["pay_range"] == expected


def test_a_multiplier_never_travels_beyond_its_own_range():
    """REGRESSION. Propagating the trailing "k" across the whole message turned
    "we need 5 MIG welders ... 20-25k" into pay_min 5000 — the VACANCY COUNT, under
    the 1000 floor, inherited the multiplier and became a wage. A multiplier now
    travels exactly one hop: between the two halves of an actual range."""
    detected = answers.detect_answers(
        "we need 5 MIG welders in Pune, night shift, 20-25k", "role_title"
    )
    assert detected["pay_range"] == {"pay_min": 20000, "pay_max": 25000}
    assert detected["vacancy"] == "2-5"


def test_a_bare_small_number_is_not_read_as_pay():
    """ "8 hours" / "2 years" must not become a salary. Below the floor and with no
    multiplier we record NOTHING and ask again — a blank the payer can see beats a
    wrong number they do not."""
    assert "pay_range" not in answers.detect_answers("8 hours a day", "shift")


def test_a_cue_less_sentence_never_sets_a_shift_or_a_vacancy():
    detected = answers.detect_answers(
        "candidates need general knowledge and 3 years experience", "requirements"
    )
    assert "shift" not in detected
    assert "vacancy" not in detected


def test_chatter_is_not_recorded_as_a_role_title():
    """Without this, "I want to post a job" is stamped into role_title and the payer
    is never asked again."""
    assert answers.detect_answers("I want to post a job", "role_title") == {}


def test_a_refusal_closes_an_optional_topic_but_never_an_essential():
    assert answers.detect_answers("none", "benefits") == {"benefits": None}
    # An essential answered "no" stays OPEN: closing it would ship a draft the
    # publish DTO rejects, with nothing telling the payer why.
    assert answers.detect_answers("none", "vacancy") == {}


def test_a_correction_may_overwrite_but_an_incidental_mention_may_not():
    state = None
    _, _, state, _ = interview_engine.next_turn(state, "CNC Operator")
    _, _, state, _ = interview_engine.next_turn(state, "Pune")
    _, _, state, _ = interview_engine.next_turn(state, "3")
    assert state.collected["vacancy"] == "2-5"
    # Incidental: answering the SKILLS question with a number must not re-band.
    _, _, state, _ = interview_engine.next_turn(state, "Fanuc, 12 openings later maybe")
    assert state.collected["vacancy"] == "2-5"
    # Deliberate: an explicit correction does.
    _, _, state, _ = interview_engine.next_turn(state, "actually make that 12 openings")
    assert state.collected["vacancy"] == "11-25"


def test_list_answers_accumulate_across_turns():
    state = JobPostingChatState(asked_question_ids=["benefits"], ask_counts={"benefits": 1})
    _, _, state, _ = interview_engine.next_turn(state, "PF + ESI")
    state.asked_question_ids.append("benefits")
    state.answered_topics.remove("benefits")
    _, _, state, _ = interview_engine.next_turn(state, "canteen")
    assert state.collected["benefits"] == ["PF", "ESI", "canteen"]


# --- Draft assembly ---------------------------------------------------------
def test_build_draft_projects_the_collected_answers_onto_the_publishable_shape():
    state = JobPostingChatState(
        answered_topics=["role_title", "location_label", "city", "vacancy"],
        collected={
            "role_title": "CNC Operator",
            "skills": ["Fanuc", "tool offset"],
            "location_label": "Pune, Chakan",
            "city": "Pune",
            "vacancy": "6-10",
            "pay_range": {"pay_min": 18000, "pay_max": 22000},
            "pay_type": "in_hand",
            "experience": {"min": 1, "max": 2},
            "shift": "rotational",
            "needed_by": "soon",
            "benefits": ["PF", "ESI"],
            "requirements": ["ITI"],
            "description": "Machine shop, 6 days a week.",
        },
    )
    draft = interview_engine.build_draft(state)
    assert draft.role_title == "CNC Operator"
    assert draft.vacancy_band == "6-10"
    assert draft.pay_min == 18000 and draft.pay_max == 22000
    assert draft.shift == "rotational"
    assert draft.city == "Pune"
    assert draft.pay_type == "in_hand"
    assert (draft.min_experience_years, draft.max_experience_years) == (1, 2)
    assert draft.needed_by == "soon"
    assert draft.missing_fields == []
    assert draft.confidence == 1.0
    assert draft.clarification_questions == []


def test_build_draft_is_defensive_about_a_malformed_stored_state():
    """`collected` round-trips through a jsonb column, so every value is untrusted. A
    malformed state must yield an emptier draft, never a 500 that strands the payer's
    whole session."""
    state = JobPostingChatState(
        collected={
            "role_title": 42,
            "skills": "not a list",
            "vacancy": "seven",
            "pay_range": {"pay_min": "18000", "pay_max": -3},
            "shift": "evening",
        }
    )
    draft = interview_engine.build_draft(state)
    assert draft.role_title is None
    assert draft.skills == []
    assert draft.vacancy_band is None
    assert draft.pay_min is None and draft.pay_max is None
    assert draft.shift is None
    assert draft.confidence == 0.0


def test_build_draft_clamps_skills_to_the_publish_dto_cap():
    state = JobPostingChatState(collected={"skills": [f"skill {i}" for i in range(25)]})
    assert len(interview_engine.build_draft(state).skills) == 10


def test_an_inverted_pay_range_is_ordered_not_rejected():
    state = JobPostingChatState(collected={"pay_range": {"pay_min": 25000, "pay_max": 18000}})
    draft = interview_engine.build_draft(state)
    assert (draft.pay_min, draft.pay_max) == (18000, 25000)


def test_missing_essentials_become_clarification_questions():
    draft = interview_engine.build_draft(JobPostingChatState())
    assert draft.missing_fields[:4] == ["role_title", "skills", "location_label", "city"]
    assert len(draft.clarification_questions) == len(interview_engine.ESSENTIAL_TOPICS)
    assert question_bank.topic_by_id("city").retry_question in draft.clarification_questions


def test_the_retype_ask_survives_even_when_every_essential_is_missing():
    """REGRESSION. The cap was a literal 4; the fourth essential (city) filled it, so the
    privacy affordance — "rewrite this field without contact details" — was the one
    question silently truncated off the end."""
    state = JobPostingChatState(collected={"description": "Call [PHONE_1] to apply"})
    questions = interview_engine.build_draft(state).clarification_questions
    assert len(questions) == len(interview_engine.ESSENTIAL_TOPICS) + 1
    assert "contact details" in questions[-1]


def test_a_field_holding_a_placeholder_token_asks_the_payer_to_retype_it():
    """The privacy affordance: when a turn carried identity-shaped content the MASKED
    text is stored, so the payer must be told which field to rewrite. Derived by
    scanning the draft, so it cannot drift out of sync with what was recorded — and
    it names the FIELD, never the content."""
    state = JobPostingChatState(collected={"description": "Call [PHONE_1] to apply"})
    questions = interview_engine.build_draft(state).clarification_questions
    assert any("job description" in q and "contact details" in q for q in questions)


def test_draft_ready_needs_every_essential_answered_and_every_must_ask_raised():
    state = None
    for message in ["CNC Operator", "Pune", "5"]:
        _, _, state, ready = interview_engine.next_turn(state, message)
        assert ready is False  # essentials done, but the must-asks are unraised
    for _ in range(10):
        _, asked_id, state, ready = interview_engine.next_turn(state, "no")
        if asked_id is None:
            break
    assert ready is True
    assert state.unanswered_essentials == []
    for topic_id in interview_engine.MUST_ASK_TOPICS:
        # pay_type is the one excused topic: "no" to the pay question left no figure
        # for it to describe, so it is moot rather than raised.
        assert (
            topic_id in state.answered_topics
            or topic_id in state.asked_question_ids
            or (topic_id == "pay_type" and "pay_range" not in state.collected)
        )
    assert "pay_type" not in state.asked_question_ids


# --- 2. Routes: pseudonymize first, fail closed, zero LLM calls -------------
def _no_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Any router call at all is a failure on this route — the engine's question is
    already the reply, so there is nothing for a model to phrase (COST-3/COST-4)."""
    import app.main as main_module

    async def _boom(*_a, **_k):  # pragma: no cover - the assertion is that it never runs
        raise AssertionError("the job-posting chat route must not call the AI router")

    monkeypatch.setattr(main_module.router, "run", _boom)


def test_opening_route_serves_the_deterministic_opener():
    res = client.post("/job-posting-chat/opening", json={})
    assert res.status_code == 200
    body = res.json()
    assert body == {"opening_text": question_bank.OPENING_MESSAGE}


def test_respond_route_returns_the_engine_question_without_calling_a_model(
    monkeypatch: pytest.MonkeyPatch,
):
    _no_llm(monkeypatch)
    res = client.post(
        "/job-posting-chat/respond",
        json={"session_id": "s1", "message_text": "CNC Operator"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["blocked"] is False
    assert body["is_mock"] is True
    assert body["ai_metadata"] is None
    assert body["asked_question_id"] == "location_label"
    assert body["draft"]["role_title"] == "CNC Operator"
    assert body["updated_state"]["answered_topics"] == ["role_title"]


def test_respond_route_fails_closed_and_the_engine_never_runs_on_a_blocked_turn(
    monkeypatch: pytest.MonkeyPatch,
):
    """§2 #3. Pseudonymization runs FIRST and fails closed — and it runs even though
    the payer is describing a job rather than themselves, because a payer can type
    their own phone, a manager's name or an applicant's name into free text. The
    gateway does not get an exemption based on who the principal is."""
    _no_llm(monkeypatch)
    import app.main as main_module

    def _never(*_a, **_k):  # pragma: no cover - the assertion is that it never runs
        raise AssertionError("a blocked turn must never reach the interview engine")

    monkeypatch.setattr(main_module.job_posting_engine, "next_turn", _never)
    monkeypatch.setattr(main_module.job_posting_engine, "clarify_turn", _never)

    res = client.post(
        "/job-posting-chat/respond",
        # An 8-digit run the gateway can neither attribute nor mask as an in-range
        # amount -> the residual-digit net fires and the whole turn fails closed.
        json={"session_id": "s1", "message_text": "job code 87654321 applies"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["blocked"] is True
    assert body["blocked_reason"]
    # A blocked turn is a NO-OP: the caller keeps the state and draft it had.
    assert body["draft"] is None
    assert body["updated_state"] is None
    assert body["draft_ready"] is False
    assert "rephrase" in body["reply_text"].lower()


def test_a_phone_number_typed_into_a_field_never_reaches_the_draft(
    monkeypatch: pytest.MonkeyPatch,
):
    """The draft is persisted at rest and becomes a published posting, so an identity
    -class entity must not survive onto it. The MASKED text is stored instead and the
    payer is asked to retype the field."""
    _no_llm(monkeypatch)
    state = JobPostingChatState(asked_question_ids=["description"], ask_counts={"description": 1})
    res = client.post(
        "/job-posting-chat/respond",
        json={
            "session_id": "s1",
            "message_text": "Call 9876543210 to apply",
            "conversation_state": state.model_dump(),
        },
    )
    body = res.json()
    description = body["draft"]["description"]
    assert "9876543210" not in description
    assert "[PHONE_1]" in description
    assert any("contact details" in q for q in body["draft"]["clarification_questions"])


def test_a_city_survives_onto_the_draft_even_though_it_is_masked_for_the_llm():
    """CITY/STATE/AMOUNT are deliberately NOT identity classes here: a job's city and
    its pay are the whole point of the posting, and masking them onto the draft would
    publish "[CITY_1]" as the location."""
    state = JobPostingChatState(
        asked_question_ids=["location_label"], ask_counts={"location_label": 1}
    )
    res = client.post(
        "/job-posting-chat/respond",
        json={
            "session_id": "s1",
            "message_text": "Pune",
            "conversation_state": state.model_dump(),
        },
    )
    assert res.json()["draft"]["location_label"] == "Pune"
    assert res.json()["draft"]["city"] == "Pune"


def test_the_respond_route_never_echoes_an_organisation_name_back():
    res = client.post(
        "/job-posting-chat/respond",
        json={"session_id": "s1", "message_text": "CNC Operator"},
    )
    body = res.json()
    assert "org_label" not in body["draft"]
    assert "company" not in body["reply_text"].lower()


def test_chips_are_served_for_the_topic_being_asked_and_none_on_the_wrap_up():
    state = JobPostingChatState(
        answered_topics=["role_title", "location_label", "city"],
        asked_question_ids=["role_title", "location_label"],
        ask_counts={"role_title": 1, "location_label": 1},
        collected={"role_title": "Welder", "location_label": "Pune", "city": "Pune"},
    )
    res = client.post(
        "/job-posting-chat/respond",
        json={
            "session_id": "s1",
            "message_text": "yes",
            "conversation_state": state.model_dump(),
        },
    )
    body = res.json()
    assert body["asked_question_id"] == "vacancy"
    assert body["suggested_answers"] == list(answers.VACANCY_BANDS)


# --- #1726: the worker-card topics (city, pay_type, experience, needed_by) --------
# The worker's job card renders these; before #1726 a chat-published posting wrote
# NULL into every one. The negatives matter more than the positives: each parser must
# record NOTHING rather than guess (the answers.py "fail toward asking again" rule).
def test_the_bank_order_is_the_agreed_contract():
    assert question_bank.topic_ids() == (
        "role_title",
        "skills",
        "location_label",
        "city",
        "vacancy",
        "pay_range",
        "pay_type",
        "experience",
        "shift",
        "needed_by",
        "benefits",
        "requirements",
        "description",
    )


@pytest.mark.parametrize(
    "text",
    [
        s
        for t in question_bank.topics_for()
        for s in (t.question, t.retry_question)
        if s is not None
    ],
)
def test_every_served_question_is_one_short_question(text: str):
    """The bank's tone rule, executed: ONE question, under 20 words."""
    assert text.count("?") == 1, text
    assert len(text.split()) < 20, text


def test_the_new_enums_match_the_contract_literals():
    """`answers.PAY_TYPES` / `NEEDED_BY` and the Pydantic literals are two copies of one
    closed set — pinned together like the vacancy bands above."""
    from typing import get_args

    from app.contracts import JobNeededBy, JobPayType

    assert tuple(get_args(JobPayType)) == answers.PAY_TYPES
    assert tuple(get_args(JobNeededBy)) == answers.NEEDED_BY


# City -------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("text", "city"),
    [
        ("Pune", "Pune"),
        ("pune", "Pune"),  # title-cased like the TS gazetteer's titleCase
        ("Bombay", "Mumbai"),  # alias -> canonical
        ("gurgaon", "Gurugram"),
        ("Navi Mumbai", "Navi Mumbai"),  # the multi-word city, not the "Mumbai" in it
        ("greater  noida", "Greater Noida"),  # multi-word, whitespace-tolerant
        ("Chakan, near Pune", "Pune"),  # a comma list: the one part that IS a city
        ("It is in Pune", "Pune"),  # the question's own lead-in is stripped
        ("Pune?", "Pune"),
    ],
)
def test_the_city_question_accepts_a_gazetteer_city(text: str, city: str):
    assert answers.detect_answers(text, "city") == {"city": city}


@pytest.mark.parametrize(
    "text",
    [
        "[PERSON_1]",  # a placeholder token never becomes a city
        "[PERSON_1] Nagar",
        "Sector 5",  # digits
        "Plot 12 MIDC",
        "Pimpri Chinchwad industrial area",  # more than three words
        "same",
        "don't know",
        "anywhere",
        "ok",
        "no",  # a refusal leaves the essential OPEN
        "our plant",
        # #1727 round 3 — no free-text fallback: a place outside the gazetteer is not a
        # card city (these four were accepted as a short label before).
        "Chakan",
        "Sri City",
        "It is in Chakan",
        "Chakan?",
    ],
)
def test_the_city_question_records_nothing_rather_than_a_guess(text: str):
    assert "city" not in answers.detect_answers(text, "city")


def test_a_placeholder_beside_a_real_city_keeps_only_the_city():
    assert answers.detect_answers("[PERSON_1], Pune", "city") == {"city": "Pune"}


def test_the_city_gazetteer_matches_whole_words_only():
    # "Kota" is a gazetteer city; "Kotak" is not it. Nor is "Punekar" Pune.
    assert "city" not in answers.detect_answers("Kotak Mahindra building", "location_label")
    assert "city" not in answers.detect_answers("Punekar Road", "location_label")


def test_the_location_answer_closes_the_city_too_with_no_extra_question():
    assert answers.detect_answers("Pune, Chakan", "location_label") == {
        "location_label": "Pune, Chakan",
        "city": "Pune",
    }
    assert answers.detect_answers("Navi Mumbai, Vashi", "location_label")["city"] == "Navi Mumbai"


def test_a_location_with_no_gazetteer_city_leaves_city_for_its_own_question():
    """Gazetteer only on this path — the bare fallback would stamp "Chakan MIDC", a
    locality, into the card's city bucket without the payer being asked."""
    assert answers.detect_answers("Chakan MIDC", "location_label") == {
        "location_label": "Chakan MIDC"
    }


def test_a_location_that_does_not_record_never_records_a_city():
    """The city rides on a RECORDED location answer only. A masked name at the edge of
    the answer used to be trimmed to "PERSON_1], Pune" and recorded; now the token is
    seen, the location stays open, and so does the city."""
    assert answers.detect_answers("[PERSON_1], Pune", "location_label") == {}


def test_city_is_never_read_cross_topic():
    detected = answers.detect_answers("CNC operator in Pune", "role_title")
    assert "city" not in detected
    assert "city" not in answers.detect_answers("Pune", "description")


# Placeholder tokens at the EDGE of a label (the _TRIM_PUNCT fix) -------------------
@pytest.mark.parametrize(
    ("text", "topic_id"),
    [
        ("[PERSON_1], Chakan", "location_label"),
        ("[EMPLOYER_1] Pimpri", "location_label"),
        ("[EMPLOYER_1] Pimpri", "role_title"),
        ("mera naam [PERSON_1]", "role_title"),
    ],
)
def test_an_edge_token_can_no_longer_close_an_essential(text: str, topic_id: str):
    """MEASURED BEFORE THE FIX: each of these recorded a bracket-trimmed token
    ("PERSON_1], Chakan") that PLACEHOLDER_TOKEN_RE could not see, so the essential
    closed on it and no retype ask was raised."""
    assert topic_id not in answers.detect_answers(text, topic_id)


def test_a_phone_at_the_end_of_a_description_still_raises_the_retype_ask(
    monkeypatch: pytest.MonkeyPatch,
):
    _no_llm(monkeypatch)
    state = JobPostingChatState(asked_question_ids=["description"], ask_counts={"description": 1})
    body = client.post(
        "/job-posting-chat/respond",
        json={
            "session_id": "s1",
            "message_text": "Call 9876543210",
            "conversation_state": state.model_dump(),
        },
    ).json()
    assert "9876543210" not in body["draft"]["description"]
    assert any("contact details" in q for q in body["draft"]["clarification_questions"])


# Pay type ---------------------------------------------------------------------
@pytest.mark.parametrize(
    ("text", "pay_type"),
    [
        ("In-hand", "in_hand"),
        ("in hand", "in_hand"),
        ("inhand", "in_hand"),
        ("take-home", "in_hand"),
        ("net salary", "in_hand"),
        ("net", "in_hand"),  # bare "net" — ONLY as the answer to this question
        ("haath mein", "in_hand"),
        ("Gross", "gross"),
        ("CTC", "ctc"),
        ("c.t.c", "ctc"),
        ("cost to company", "ctc"),
    ],
)
def test_pay_type_parsing(text: str, pay_type: str):
    assert answers.detect_answers(text, "pay_type")["pay_type"] == pay_type


def test_two_different_pay_types_record_nothing():
    assert "pay_type" not in answers.detect_answers("gross 30k, in hand 25k", "pay_type")
    assert "pay_type" not in answers.detect_answers("CTC 3 lakh, take home 22k", "pay_range")


def test_the_pay_answer_closes_pay_type_cross_topic():
    detected = answers.detect_answers("20-25k in hand", "pay_range")
    assert detected["pay_range"] == {"pay_min": 20000, "pay_max": 25000}
    assert detected["pay_type"] == "in_hand"


@pytest.mark.parametrize(
    ("text", "last_asked"),
    [
        ("20k gross", "pay_range"),  # bare "gross" is attributed-only
        ("net 20k", "pay_range"),  # so is bare "net"
        ("skilled in hand grinding", "requirements"),  # the cue with no money in sight
    ],
)
def test_pay_type_is_not_guessed_cross_topic(text: str, last_asked: str):
    assert "pay_type" not in answers.detect_answers(text, last_asked)


# Experience -------------------------------------------------------------------
@pytest.mark.parametrize(
    ("text", "window"),
    [
        ("Fresher", (0, None)),
        ("freshers", (0, None)),
        ("no experience needed", (0, None)),
        ("experience not required", (0, None)),
        ("1-2 years", (1, 2)),
        ("3-5 years", (3, 5)),
        ("2 to 4 yrs", (2, 4)),
        ("5+ years", (5, None)),
        ("at least 2 years", (2, None)),
        ("min 3 years", (3, None)),
        ("3 years or more", (3, None)),
        ("up to 3 years", (None, 3)),
        ("3 years", (3, None)),
        ("3 saal", (3, None)),
        ("3", (3, None)),
        ("freshers or up to 2 years", (0, 2)),
    ],
)
def test_experience_parsing(text: str, window: tuple):
    detected = answers.detect_answers(text, "experience")["experience"]
    assert (detected["min"], detected["max"]) == window


@pytest.mark.parametrize(
    "text",
    [
        "6 months",  # not years
        "6 days a week",
        "20-25k",
        "70 years",  # outside 0..60
        "2-80 years",
        "1.5 years",  # not a whole number of years
        "no freshers",  # names the word, means the opposite
        # #1727 round 3 — not one of the allowlisted shapes (each recorded a value before).
        "5-3 years",  # a reversed span: the payer's window is unclear
        "minimum 3",  # a floor needs its unit
        "3 or more years",
        "max 4",
        "minimum 2 maximum 5 years",
        "No freshers, 3+ years only",
    ],
)
def test_the_experience_question_records_nothing_rather_than_a_guess(text: str):
    assert "experience" not in answers.detect_answers(text, "experience")


@pytest.mark.parametrize(
    ("text", "last_asked", "window"),
    [
        ("3 years experience, ITI", "requirements", (3, None)),
        # Was last_asked="description" — never read for experience since #1727 (F0).
        ("Experience: 3-5 yrs", "skills", (3, 5)),
        ("freshers welcome", "requirements", (0, None)),
    ],
)
def test_experience_is_read_cross_topic_only_with_a_year_unit_and_a_cue(
    text: str, last_asked: str, window: tuple
):
    detected = answers.detect_answers(text, last_asked)["experience"]
    assert (detected["min"], detected["max"]) == window


@pytest.mark.parametrize(
    ("text", "last_asked"),
    [
        ("we need 3", "role_title"),
        ("need 2 exp welders", "role_title"),  # a cue beside a unit-LESS number
        # These three were last_asked="description", which #1727 stopped reading for
        # experience at all — moved so they still exercise the CUE gate, not the skip.
        ("6 days a week", "benefits"),
        ("3 years", "requirements"),  # a unit, but no experience word
        ("experienced candidates only, 1 year contract", "requirements"),  # other clause
        ("no freshers", "requirements"),
        # #1727 round 3 — "ka experience" is not one of the allowlisted shapes.
        ("3 saal ka experience", "requirements"),
    ],
)
def test_experience_is_never_guessed_cross_topic(text: str, last_asked: str):
    assert "experience" not in answers.detect_answers(text, last_asked)


def test_an_experience_window_is_never_read_as_a_vacancy_band():
    """REGRESSION. The embedded-band search ignored units, so "2-5 years" in the ROLE
    answer closed the vacancy essential as "2-5" — a head count nobody gave."""
    detected = answers.detect_answers("Welder, 2-5 years experience", "role_title")
    assert "vacancy" not in detected
    assert detected["experience"] == {"min": 2, "max": 5}
    # The band itself still reads — the guard is on the unit, not the band.
    assert answers.detect_answers("we need 2-5 welders", "role_title")["vacancy"] == "2-5"


# Needed by --------------------------------------------------------------------
@pytest.mark.parametrize(
    ("text", "needed_by"),
    [
        ("Immediately", "immediate"),
        ("asap", "immediate"),
        ("as soon as possible", "immediate"),
        ("urgently", "immediate"),
        ("tomorrow", "immediate"),
        ("this week", "immediate"),
        ("abhi", "immediate"),
        ("Within a month", "soon"),
        ("next month", "soon"),
        ("in 10 days", "soon"),
        ("within 2 weeks", "soon"),
        ("15 days", "soon"),
        ("jaldi", "soon"),
        ("Flexible", "flexible"),
        ("no hurry", "flexible"),
        ("anytime", "flexible"),
        ("whenever", "flexible"),
        ("not urgent", "flexible"),
    ],
)
def test_needed_by_parsing(text: str, needed_by: str):
    assert answers.detect_answers(text, "needed_by")["needed_by"] == needed_by


@pytest.mark.parametrize(
    ("text", "last_asked"),
    [
        ("in 115 days", "needed_by"),  # "15 days" is not inside "115 days"
        ("not immediately", "needed_by"),  # a negation with nothing else is no answer
        ("urgent requirement", "description"),  # attributed only, never cross-topic
        # #1727 round 3 — a whole-answer allowlist: two statements are not one shape
        # (both recorded "soon" before).
        ("Not immediately, within a month", "needed_by"),
        ("abhi nahi, next month", "needed_by"),
    ],
)
def test_needed_by_records_nothing_rather_than_a_guess(text: str, last_asked: str):
    assert "needed_by" not in answers.detect_answers(text, last_asked)


# Engine -----------------------------------------------------------------------
def test_city_is_asked_only_when_the_location_answer_named_none():
    asked, state = _drive(None, ["CNC Operator", "Pune, Chakan"])
    assert asked == ["location_label", "vacancy"]
    assert state.collected["city"] == "Pune"

    # F11: the city question is now a FOLLOW-UP ("Which city or district is that area
    # in?"), so the expected answer is the containing city — not the locality repeated.
    asked, state = _drive(None, ["CNC Operator", "Chakan MIDC", "Pune district"])
    assert asked == ["location_label", "city", "vacancy"]
    assert state.collected["city"] == "Pune"
    assert state.collected["location_label"] == "Chakan MIDC"


def test_the_pay_answer_can_close_pay_type_without_asking_it():
    state = JobPostingChatState(
        answered_topics=["role_title", "location_label", "city", "vacancy", "skills"],
        asked_question_ids=["role_title", "location_label", "vacancy", "skills", "pay_range"],
        ask_counts={
            "role_title": 1,
            "location_label": 1,
            "vacancy": 1,
            "skills": 1,
            "pay_range": 1,
        },
        turn_count=5,
    )
    _, asked_id, state, _ = interview_engine.next_turn(state, "20-25k in hand")
    assert state.collected["pay_type"] == "in_hand"
    assert asked_id == "experience"


def _at_the_pay_question() -> JobPostingChatState:
    return JobPostingChatState(
        answered_topics=["role_title", "location_label", "city", "vacancy", "skills"],
        asked_question_ids=["role_title", "location_label", "vacancy", "skills", "pay_range"],
        ask_counts={
            "role_title": 1,
            "location_label": 1,
            "vacancy": 1,
            "skills": 1,
            "pay_range": 1,
        },
        turn_count=5,
    )


@pytest.mark.parametrize(
    "declined",
    [
        "no",  # an explicit refusal: pay_range ANSWERED with nothing
        "depends on the interview",  # unparsed: pay_range ASKED, never answered
    ],
)
def test_pay_type_is_never_asked_about_a_pay_the_payer_did_not_give(declined: str):
    """Asking "Is that pay in-hand, gross or CTC?" after the payer gave no figure asks
    about nothing. pay_type is MOOT then: never served, and it does not hold the draft
    open."""
    _, asked_id, state, _ = interview_engine.next_turn(_at_the_pay_question(), declined)
    assert "pay_range" not in state.collected
    assert asked_id == "experience"
    asked, state = _drive(state, ["x"] * 12)
    assert "pay_type" not in asked
    assert "pay_type" not in state.asked_question_ids
    assert asked[-1] is None  # the interview still wraps up without it
    draft = interview_engine.build_draft(state)
    assert draft.pay_type is None
    assert "pay_type" in draft.missing_fields


def test_a_moot_pay_type_does_not_hold_the_draft_open_on_a_clarify():
    """The gate and the topic picker excuse a moot topic by the SAME test. Seen through
    clarify_turn, which reports readiness while re-serving the last question."""
    asked = [t for t in question_bank.topic_ids() if t != "pay_type"]
    state = JobPostingChatState(
        answered_topics=["role_title", "location_label", "city", "vacancy", "pay_range"],
        asked_question_ids=asked,
        ask_counts={t: 1 for t in asked},
        turn_count=len(asked),
    )
    result = interview_engine.clarify_turn(state, "what do you mean?")
    assert result is not None
    _, last_id, _, ready = result
    assert last_id == "description"
    assert ready is True


def test_a_pay_figure_given_later_revives_the_pay_type_question():
    """Mootness is re-derived every turn, never recorded: once a figure arrives the
    type question is owed again — and served before the later topics."""
    _, asked_id, state, _ = interview_engine.next_turn(_at_the_pay_question(), "no")
    assert asked_id == "experience"
    _, asked_id, state, ready = interview_engine.next_turn(state, "3 years, salary Rs 22,000")
    assert state.collected["pay_range"]["pay_min"] == 22000
    # #1727 round 3: two statements are not ONE experience shape, so the answer to the
    # experience question records no window (it recorded min 3 before).
    assert "experience" not in state.collected
    assert asked_id == "pay_type"
    assert ready is False


def test_an_experience_window_commits_whole_and_follows_the_overwrite_rule():
    state = JobPostingChatState(
        asked_question_ids=["experience"], ask_counts={"experience": 1}, turn_count=3
    )
    _, _, state, _ = interview_engine.next_turn(state, "3-5 years")
    assert state.collected["experience"] == {"min": 3, "max": 5}
    # Incidental: a later cross-topic mention does not rewrite the established window.
    state.asked_question_ids.append("requirements")
    _, _, state, _ = interview_engine.next_turn(state, "2 years experience, ITI")
    assert state.collected["experience"] == {"min": 3, "max": 5}
    # Deliberate: a correction replaces it WHOLE — no merge of halves. (#1727 round 3:
    # the comma makes "1 year experience" its own clause — "actually 1 year experience"
    # as one clause is not an allowlisted shape.)
    _, _, state, _ = interview_engine.next_turn(state, "actually, 1 year experience")
    assert state.collected["experience"] == {"min": 1, "max": None}


def test_the_engine_ask_budget_covers_the_new_worst_case():
    """4 essentials x 2 + 9 ask-once = 17; the ceiling keeps >= 4 asks of headroom."""
    assert interview_engine.MAX_ENGINE_ASKS == 22
    assert interview_engine.MAX_INTERVIEW_TURNS == 22 * 3
    for topic_id in ("pay_type", "experience", "needed_by"):
        assert topic_id in interview_engine.MUST_ASK_TOPICS
    assert interview_engine.ESSENTIAL_TOPICS == ("role_title", "location_label", "city", "vacancy")


# Draft assembly ---------------------------------------------------------------
def test_build_draft_swaps_an_inverted_experience_window():
    """The create DTO refines max >= min, so an inverted window is ordered, never
    dropped (the same rule as an inverted pay range)."""
    state = JobPostingChatState(collected={"experience": {"min": 5, "max": 2}})
    draft = interview_engine.build_draft(state)
    assert (draft.min_experience_years, draft.max_experience_years) == (2, 5)


@pytest.mark.parametrize(
    "collected",
    [
        {"city": 42, "pay_type": "monthly", "experience": "3 years", "needed_by": "later"},
        {"city": "   ", "pay_type": ["in_hand"], "experience": {"min": True}, "needed_by": 1},
        {"city": None, "pay_type": {"x": 1}, "experience": {"min": -1, "max": 61}},
        {"experience": {"min": "3", "max": 2.5}, "needed_by": ["soon"]},
    ],
)
def test_build_draft_is_defensive_about_malformed_new_fields(collected: dict):
    draft = interview_engine.build_draft(JobPostingChatState(collected=collected))
    assert draft.city is None
    assert draft.pay_type is None
    assert draft.min_experience_years is None and draft.max_experience_years is None
    assert draft.needed_by is None
    for topic_id in ("city", "pay_type", "experience", "needed_by"):
        assert topic_id in draft.missing_fields


def test_build_draft_caps_a_stored_city_at_the_dto_limit():
    draft = interview_engine.build_draft(JobPostingChatState(collected={"city": "x" * 500}))
    assert draft.city == "x" * answers.CITY_MAX


def test_missing_fields_and_confidence_count_the_new_topics():
    state = JobPostingChatState(
        collected={
            "city": "Pune",
            "pay_type": "ctc",
            "experience": {"min": None, "max": 3},  # a max alone still fills the topic
            "needed_by": "flexible",
        }
    )
    draft = interview_engine.build_draft(state)
    for topic_id in ("city", "pay_type", "experience", "needed_by"):
        assert topic_id not in draft.missing_fields
    assert len(draft.missing_fields) == len(question_bank.topic_ids()) - 4
    assert draft.confidence == round(4 / len(question_bank.topic_ids()), 2)


# End to end -------------------------------------------------------------------
def test_an_interview_through_the_route_fills_all_thirteen_topics(
    monkeypatch: pytest.MonkeyPatch,
):
    """The whole #1726 claim in one transcript: every topic the worker card renders is
    asked, answered, and on the draft — through the real route, gateway included."""
    _no_llm(monkeypatch)
    transcript = [
        ("CNC Operator", "location_label"),
        ("Pune, Chakan", "vacancy"),  # location + city in one answer
        ("5", "skills"),
        ("CNC turning and Fanuc control", "pay_range"),
        ("20-25k", "pay_type"),
        ("In-hand", "experience"),
        ("3-5 years", "shift"),
        ("Rotational", "needed_by"),
        ("Within a month", "benefits"),
        ("PF + ESI, canteen", "requirements"),
        ("ITI fitter certificate", "description"),
        ("Machine shop, 6 days a week.", None),
    ]
    state = None
    body: dict = {}
    for message, expected_next in transcript:
        body = client.post(
            "/job-posting-chat/respond",
            json={"session_id": "s1", "message_text": message, "conversation_state": state},
        ).json()
        assert body["blocked"] is False, message
        assert body["asked_question_id"] == expected_next, message
        state = body["updated_state"]
    draft = body["draft"]
    assert body["draft_ready"] is True
    assert state["unanswered_essentials"] == []
    assert draft["missing_fields"] == []
    assert draft["confidence"] == 1.0
    assert draft["city"] == "Pune"
    assert draft["location_label"] == "Pune, Chakan"
    assert draft["vacancy_band"] == "2-5"
    assert (draft["pay_min"], draft["pay_max"], draft["pay_type"]) == (20000, 25000, "in_hand")
    assert (draft["min_experience_years"], draft["max_experience_years"]) == (3, 5)
    assert draft["shift"] == "rotational"
    assert draft["needed_by"] == "soon"
    assert draft["clarification_questions"] == []


# --- #1727: the PR #1727 review findings (F0..F15) ----------------------------------
# Every input below was MEASURED giving a wrong value before this fix (the review's
# verifier reproduced each on 1c53715e). The rule they all enforce is answers.py's:
# FAIL TOWARD ASKING AGAIN — record nothing rather than a guess.


# Experience (F0, F1, F2, F12) ------------------------------------------------------
@pytest.mark.parametrize(
    ("text", "window"),
    [
        # F1 / F12 — an upper bound is a MAX, whichever side of the number it sits on.
        ("2 years max", (None, 2)),
        ("2 years maximum", (None, 2)),
        ("below 5 years", (None, 5)),
        ("at most 4 years", (None, 4)),
        ("upto 3 years", (None, 3)),
        ("5 saal tak", (None, 5)),
        ("3 saal tak", (None, 3)),
        # A lower bound is a MIN.
        ("atleast 2 years", (2, None)),
        ("kam se kam 2 saal", (2, None)),
        ("5 years plus", (5, None)),
        ("5 years and above", (5, None)),
        # F12 — the Hinglish span separator the pay parser already accepts.
        ("2 se 5 saal", (2, 5)),
        # An un-negated fresher welcome still reads as 0.
        ("freshers can apply", (0, None)),
    ],
)
def test_experience_reads_only_the_figure_tied_to_experience(text: str, window: tuple):
    detected = answers.detect_answers(text, "experience")["experience"]
    assert (detected["min"], detected["max"]) == window


@pytest.mark.parametrize(
    "text",
    [
        # #1727 round 3 CONVERSIONS — each recorded the value in the comment before; none
        # is one of the allowlisted shapes, so the experience question records nothing.
        "age 25-40, 5 years experience",  # was (5, None)
        "2 years, age up to 35",  # was (2, None)
        "ITI 2 year course + 1 year experience",  # was (1, None)
        "Age 20-35, 2-5 years",  # was (2, 5)
        "age 18 to 35, minimum 2 years",  # was (2, None)
        "age limit 35, 3 years",  # was (3, None)
        "umar 20 se 30, 2 saal",  # was (2, None)
        "25 years old, 3 years experience",  # was (3, None)
        "Welder with 3 years experience",  # was (3, None)
        "minimum 2 years, maximum 5 years",  # was (2, 5)
        "max. 3 years",  # was (None, 3)
        "not more than 3 years",  # was (None, 3)
        "no more than 3 years",  # was (None, 3)
        "within 2 years",  # was (None, 2)
        "2 years or less",  # was (None, 2)
        "2 years and below",  # was (None, 2)
        "2 saal se kam",  # was (None, 2)
        "3 saal se kam",  # was (None, 3)
        "zyada se zyada 3 saal",  # was (None, 3)
        "Fresher or less than 1 year",  # was (0, 1)
        "more than 3 years",  # was (3, None)
        "above 5 years",  # was (5, None)
        "over 5 years",  # was (5, None)
        "3 years or above",  # was (3, None)
        "5 saal se zyada",  # was (5, None)
        "5 saal se upar",  # was (5, None)
        "between 2 and 5 years",  # was (2, 5)
        "minimum 3 years, freshers are not allowed",  # was (3, None)
        "Freshers will not be considered, minimum 2 years",  # was (2, None)
        "Freshers with no experience",  # was (0, None)
        "3 years, salary Rs 22,000",  # was (3, None)
    ],
)
def test_a_phrasing_outside_the_experience_allowlist_records_nothing(text: str):
    assert "experience" not in answers.detect_answers(text, "experience")


@pytest.mark.parametrize(
    ("text", "ceiling"),
    [
        ("less than 2 years", 2),
        ("less than 3 years", 3),
        ("under 2 years", 2),
        ("under 3 years", 3),
    ],
)
def test_a_strict_comparative_records_the_payer_s_ceiling_inclusively(text: str, ceiling: int):
    """A DELIBERATE, PINNED CHOICE (F1 asked for one): "less than 3 years" records max 3,
    not max 2. It is the payer's own number, a worker with 3 years is the boundary
    case either reading disputes, and inventing "2" would put a figure on the card
    that the payer never typed. What it must NEVER do is record min 3 — the reversal
    the review measured."""
    detected = answers.detect_answers(text, "experience")["experience"]
    assert detected == {"min": None, "max": ceiling}


@pytest.mark.parametrize(
    "text",
    [
        # F2 — every measured way of saying "no freshers".
        "Freshers will not be considered",
        "we don't want freshers",
        "Freshers are not allowed",
        "fresher mat bhejna",
        "freshers ko nahi lenge",
        "freshers are not considered",
        "we do not hire freshers",
        "don't send freshers",
        "freshers nahi chahiye",
        "freshers not allowed",
        "not for freshers",
        "non-freshers only",
        "freshers won't do",
        "never freshers",
        # F0 — screened: an age, and the company's OWN tenure.
        "age 25-40",
        "25 years old",
        "We have 30 years experience in forging",
        "our company has 20 years experience",
        "We are a 25 years experienced company",
        "established 20 years ago",
        "in the business for 20 years",
        "20 years experience since 2004",
        # F1 / F12 — fail closed: a bound word that no shape consumed.
        "3 years at most",
        "up to 2-5 years",
        "2-5 years max",
        "3 years. Not more than that",
        # Contradictions are not merged into a guess.
        "minimum 5 years, maximum 2 years",
        "1-2 years, 3-5 years",
    ],
)
def test_the_experience_question_records_nothing_rather_than_a_guess_1727(text: str):
    assert "experience" not in answers.detect_answers(text, "experience")


@pytest.mark.parametrize(
    ("text", "last_asked", "window"),
    [
        ("ITI, less than 3 years experience", "requirements", (None, 3)),
        ("ITI, less than 3 years experience", None, (None, 3)),
        ("ITI pass, experience below 2 years", "requirements", (None, 2)),
        ("CNC turning, less than 3 years experience", "skills", (None, 3)),
        ("Welder, 3 saal tak experience", "role_title", (None, 3)),
    ],
)
def test_experience_cross_topic_reads_a_bound_the_right_way_round(
    text: str, last_asked: str | None, window: tuple
):
    detected = answers.detect_answers(text, last_asked)["experience"]
    assert (detected["min"], detected["max"]) == window


@pytest.mark.parametrize(
    ("text", "last_asked"),
    [
        ("We are a 25 years experienced company making auto parts", "description"),
        ("We are a 25 years experienced company making auto parts", "requirements"),
        ("20 years experience in the industry, we make gears", "description"),
        ("We have 30 years experience in forging, need 5 forging operators", "role_title"),
        ("Age 18-35 years", "requirements"),
        # #1727 round 3: one clause that is not one shape (was (3, None)).
        ("Age 18-35 years with 3 years experience", "requirements"),
        ("ITI fitter, freshers will not be considered", "requirements"),
        ("20000 in hand, we don't hire freshers", "pay_range"),
        # The description is never read for experience at all (see answers.py).
        ("Experience: 3-5 yrs", "description"),
    ],
)
def test_experience_is_not_read_cross_topic_from_tenure_age_or_a_refusal(
    text: str, last_asked: str
):
    assert "experience" not in answers.detect_answers(text, last_asked)


def test_a_negated_fresher_beside_a_pay_answer_still_records_the_pay():
    detected = answers.detect_answers("20000 in hand, we don't hire freshers", "pay_range")
    assert detected["pay_range"] == {"pay_min": 20000, "pay_max": None}
    assert "experience" not in detected


def test_a_company_s_tenure_in_the_opener_never_closes_the_experience_question():
    """F0 end to end: the opener used to close `experience` at 30 years, so the question
    was never served and the draft published min_experience_years=30."""
    opener = "We have 30 years experience in forging, need 5 forging operators"
    asked, state = _drive(None, [opener, "Pune, Chakan", "x", "x", "x", "x"])
    assert "experience" in asked
    draft = interview_engine.build_draft(state)
    assert draft.min_experience_years is None and draft.max_experience_years is None


def test_an_age_range_on_the_experience_question_never_reaches_the_draft():
    state = JobPostingChatState(
        asked_question_ids=["experience"], ask_counts={"experience": 1}, turn_count=3
    )
    _, _, state, _ = interview_engine.next_turn(state, "age 25-40, 5 years experience")
    draft = interview_engine.build_draft(state)
    # #1727 round 3: the answer is not one allowlisted shape, so NOTHING is recorded
    # (was (5, None)) — never the age range.
    assert (draft.min_experience_years, draft.max_experience_years) == (None, None)


# Needed by (F3, F13) ---------------------------------------------------------------
@pytest.mark.parametrize(
    ("text", "needed_by"),
    [
        # F3 — the negated hurries that ARE allowlisted flexible shapes.
        ("koi jaldi nahi", "flexible"),
        ("jaldi nahi", "flexible"),
        ("urgent nahi", "flexible"),
        ("not in a hurry", "flexible"),
        ("no rush", "flexible"),
        ("today", "immediate"),
        # F13 — counted timelines.
        ("Within a week", "soon"),
        ("7 days", "soon"),
        ("2 weeks", "soon"),
        ("1 week", "soon"),
        ("1 month", "soon"),
        ("a month", "soon"),
        ("next 10 days", "soon"),
        ("1-2 weeks", "soon"),
        ("2-3 days", "soon"),
        ("15 din", "soon"),
        ("2 hafte", "soon"),
        ("few weeks", "soon"),
        ("this month", "soon"),
        ("next week", "soon"),
    ],
)
def test_needed_by_reads_negation_scope_and_counted_timelines(text: str, needed_by: str):
    assert answers.detect_answers(text, "needed_by")["needed_by"] == needed_by


@pytest.mark.parametrize(
    "text",
    [
        # #1727 round 3 CONVERSIONS — each recorded the value in the comment before; none
        # is one allowlisted shape, so the needed_by question records nothing.
        "Not very urgent",  # was flexible
        "not that urgent",  # was flexible
        "not so urgent",  # was flexible
        "not required urgently",  # was flexible
        "urgent nahi hai",  # was flexible
        "bilkul urgent nahi",  # was flexible
        "jaldi nahi hai",  # was flexible
        "joining time is flexible",  # was flexible
        "Immediate joining, timings flexible",  # was immediate
        "ASAP, salary flexible",  # was immediate
        "Immediately, shift timings are flexible",  # was immediate
        "in a week",  # was soon
        "one week",  # was soon
        "ek hafte me",  # was soon
        "ek mahine me",  # was soon
        "10 din me",  # was soon
    ],
)
def test_a_phrasing_outside_the_needed_by_allowlist_records_nothing(text: str):
    assert "needed_by" not in answers.detect_answers(text, "needed_by")


@pytest.mark.parametrize(
    "text",
    [
        # F3 — a negated immediacy alone is no answer.
        "not required immediately",
        "Not needed today",
        "turant nahi",
        "abhi nahi",
        # F3 — "don't know yet" is not "abhi" (immediate).
        "abhi pata nahi",
        "abhi decide nahi kiya",
        "pata nahi",
        "not sure yet",
        "not decided",
        "not fixed",
        "don't know",
        "no idea",
        "tbd",
        "will tell later",
        "will decide after interview",
        "will confirm",
        "baad me batayenge",
        # F13 — two months or more: no enum value fits, so no guess.
        "within 2 months",
        "2 months",
        "1-2 months",
        "3 mahine",
        "few months",
        "in 90 days",
        "10 weeks",
        # ...even beside a "soon" cue: the counted horizon is what the payer measured.
        "soon, within 2-3 months",
        "jaldi, 2 mahine me",
        # Contradictions.
        "Immediately, but flexible",
        "no hurry, but asap",
        "flexible, within a month",
    ],
)
def test_needed_by_records_nothing_when_unsure_negated_or_contradictory(text: str):
    assert "needed_by" not in answers.detect_answers(text, "needed_by")


# City (F4, F5, F10, F11, F14, F15) ---------------------------------------------------
@pytest.mark.parametrize(
    ("text", "city"),
    [
        # A city inside a ROUTE name is not where the job is.
        ("Delhi-Jaipur highway, Neemrana", "Neemrana"),
        ("Old Delhi Road, Gurgaon", "Gurugram"),
        ("Bommasandra, Hosur Road, Bangalore", "Bangalore"),
        ("Hosur Road, Bangalore", "Bangalore"),
        ("Attibele, Hosur Road, Bengaluru", "Bangalore"),
        ("Bangalore Road, Hosur", "Hosur"),
        ("Bangalore-Hosur road, Hosur", "Hosur"),
        ("Nashik Road, Pune", "Pune"),
        ("Nashik Road, Nashik", "Nashik"),
        ("Old Mumbai Road, Pune", "Pune"),
        ("Ahmedabad Highway, Sanand", "Sanand"),
        ("Ahmedabad Highway, Vadodara", "Vadodara"),
        ("Chennai Bypass, Sriperumbudur", "Sriperumbudur"),
        ("Thane Belapur Road, Navi Mumbai", "Navi Mumbai"),
        # Unchanged: one city.
        ("Pune, Chakan", "Pune"),
        ("Navi Mumbai, Vashi", "Navi Mumbai"),
    ],
)
def test_the_location_answer_closes_city_only_on_one_unambiguous_city(text: str, city: str):
    assert answers.detect_answers(text, "location_label")["city"] == city


@pytest.mark.parametrize(
    "text",
    [
        "Mumbai-Agra highway, Bhiwandi",
        "Mumbai-Pune, Lonavala",  # hyphen-joined on BOTH sides, no road word
        "Mumbai-Pune expressway, Talegaon",
        "Mumbai-Pune expressway, Lonavala",
        "Mumbai Pune Highway, Lonavala",
        "Pimpri, Old Mumbai-Pune Highway",
        "Bhiwadi, Delhi Jaipur Highway",
        "Delhi Road, Meerut",
        "Jaipur Road, Ajmer",
        "Electronic City, Hosur Road",
        "Pune Nagar Road, Ranjangaon",
        "Office in Delhi, factory in Manesar",
        "Not Mumbai, Thane",
        "Pune nahi, Nashik",
        "Delhi NCR, Noida sector 63",
        # F14 — the city comes from the span the location was parsed from ("Satara").
        "Pune office, but site is in Satara",
        "Pune side, but the job is in Satara",  # one site noun: ONLY the label read holds
        # #1727 round 3: no comma part IS a gazetteer city (was Gurugram).
        "Gurgaon (Gurugram)",
    ],
)
def test_the_location_answer_leaves_city_open_on_a_route_two_cities_or_a_negation(text: str):
    detected = answers.detect_answers(text, "location_label")
    assert "location_label" in detected  # the location itself still records
    assert "city" not in detected


def test_a_route_named_location_asks_the_city_question_end_to_end():
    """F4/F10 end to end: the engine used to close `city` as Delhi and skip straight to
    vacancy."""
    asked, state = _drive(None, ["CNC operator", "Delhi-Jaipur highway, Neemrana"])
    assert state.collected["city"] == "Neemrana"
    asked, state = _drive(None, ["CNC operator", "Mumbai-Agra highway, Bhiwandi"])
    assert asked == ["location_label", "city"]
    assert "city" not in state.collected


@pytest.mark.parametrize(
    "text",
    [
        # F4 — two places, or a negated one.
        "Chakan (not Pune)",
        "Not Pune, Nashik",
        "Plant in Talegaon, office in Mumbai",
        # ...and the same with a letters-only bare label, which the charset would pass:
        # only "ambiguous -> no bare fallback" stops these becoming the city verbatim.
        "Pune or Mumbai",
        "Pune nahi Nashik",
        "Chakan not Talegaon",
        # F5 — the qualifier sits BEFORE the cue, so it must be read on the raw message.
        "Anywhere in India",
        "anywhere in Maharashtra",
        "Not sure, somewhere in Gujarat",
        "somewhere near Satara",
        # F5 — "don't know yet" in its ordinary forms.
        "no idea",
        "not decided yet",
        "will tell later",
        "tbd",
        "TBD",
        "tba",
        "later",
        "depends",
        "abhi decide nahi",
        "not fixed yet",
        "not final",
        "multiple locations",
        "many sites",
        "various cities",
        "different places",
        "maybe",
        "will let you know",
        "will confirm",
        "batayenge",
        "baad me",
        # F11 — a frustrated reply to a repeated question is not a city.
        "already told",
        "I already said, Vapi",
        "told you",
        "India",
        "pan india",
        # F15 — a bare label is letters only.
        "Chakan (MIDC)",
        "Pimpri \U0001f3ed",
        "Chakan & Talegaon",
    ],
)
def test_the_city_question_leaves_city_open_on_a_non_answer_or_an_ambiguous_one(text: str):
    assert "city" not in answers.detect_answers(text, "city")


@pytest.mark.parametrize(
    ("text", "city"),
    [
        ("Pune district", "Pune"),
        ("Pune, India", "Pune"),  # "india" is not a city, and not a qualifier either
        ("[Pune]", "Pune"),
        ("Pune", "Pune"),
    ],
)
def test_the_city_question_still_accepts_a_real_answer(text: str, city: str):
    assert answers.detect_answers(text, "city") == {"city": city}


@pytest.mark.parametrize("text", ["[Chakan]", "Vapi"])  # #1727 round 3: were Chakan / Vapi
def test_a_town_outside_the_gazetteer_is_not_a_card_city(text: str):
    assert "city" not in answers.detect_answers(text, "city")


def test_the_city_question_is_a_follow_up_not_a_repeat_of_the_location_question():
    """F11: the city question used to be "Which city is the workplace in?" served right
    after "Which city is this job in?" — the same question twice in a row. #1727 round 3:
    only a GAZETTEER city is recorded, so the re-ask asks for the nearest big city, and
    neither wording refers back to "that area" (R27: the first ask is also served when
    no area was ever recorded)."""
    location = question_bank.topic_by_id("location_label")
    city = question_bank.topic_by_id("city")
    assert location.question == (
        "Which city and area is the workplace in — for example Pune, Chakan?"
    )
    assert city.question == "Which city or district is the workplace in?"
    served = {location.question, location.retry_question, city.question, city.retry_question}
    assert len(served) == 4  # no wording is ever served twice
    # The retry is copied VERBATIM into clarification_questions, so it must stand
    # alone: nothing for "that" to refer to.
    assert city.retry_question == (
        "Which is the nearest big city — for example Pune, Chennai or Ludhiana?"
    )
    for wording in (city.question, city.retry_question):
        assert " that " not in f" {wording.lower()} "


def test_the_location_example_puts_the_city_first_because_the_gateway_masks_it_last():
    """MEASURED, not assumed: the gateway exempts a KNOWN CITY from its leading-name
    rule, so the example order the question teaches decides whether one answer records
    both fields."""
    from app.pseudonymize import pseudonymize

    assert pseudonymize("Pune, Chakan").text == "Pune, Chakan"
    assert pseudonymize("Chakan, Pune").text.startswith("[PERSON_")
    location = question_bank.topic_by_id("location_label")
    for wording in (location.question, location.retry_question):
        assert "Pune, Chakan" in wording


def _utf16_units(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


@pytest.mark.parametrize(
    ("value", "cap"),
    [
        ("Pimpri" + "\U0001f3ed" * 41, 80),
        ("\U0001f3ed" * 79 + "a", 80),
        ("x" * 81, 80),
        ("a" + "\U0001f3ed", 2),
        ("", 5),
    ],
)
def test_cap_utf16_counts_what_zod_counts(value: str, cap: int):
    capped = answers.cap_utf16(value, cap)
    assert _utf16_units(capped) <= cap
    assert value.startswith(capped)
    # The LONGEST prefix that fits — never cut shorter than the TS schema requires.
    if capped != value:
        assert _utf16_units(value[: len(capped) + 1]) > cap


def test_every_draft_string_fits_the_zod_cap_in_utf16_units():
    """F15: Python counted code points, zod counts UTF-16 units, so an emoji-padded value
    passed Python and failed the TS parse — a 503 on every retry of that turn."""
    from app.contracts import JobPostingDraft

    emoji = "\U0001f3ed"
    state = JobPostingChatState(
        collected={
            "role_title": emoji * 150,
            "location_label": "Pimpri" + emoji * 120,
            "city": "Pimpri" + emoji * 41,
            "description": emoji * 1500,
            "skills": [emoji * 50, "Fanuc"],
            "benefits": [emoji * 50],
            "requirements": [emoji * 50],
        }
    )
    draft = interview_engine.build_draft(state)
    assert _utf16_units(draft.city) <= answers.CITY_MAX
    assert _utf16_units(draft.role_title) <= answers.LABEL_MAX
    assert _utf16_units(draft.location_label) <= answers.LABEL_MAX
    assert _utf16_units(draft.description) <= answers.DESCRIPTION_MAX
    for phrase in [*draft.skills, *draft.benefits, *draft.requirements]:
        assert _utf16_units(phrase) <= answers.PHRASE_MAX
    assert draft.city.startswith("Pimpri")  # capped, not dropped
    JobPostingDraft.model_validate(draft.model_dump())


def test_an_emoji_padded_city_answer_is_never_recorded():
    assert "city" not in answers.detect_answers("Pimpri" + "\U0001f3ed" * 41, "city")


def test_every_city_the_detector_can_record_fits_the_zod_cap():
    """#1727 round 3 CONVERSION. This test used to widen the bare-label charset and check
    the cap held; the bare-label fallback (and its charset) is gone, so a recorded city
    can only ever be a canonical gazetteer name. Every one of them — as the city
    question returns it — fits the cap in UTF-16 units and is plain Latin."""
    import re

    for token in answers._CITY_TOKENS:
        city = answers.detect_answers(token, "city")["city"]
        assert _utf16_units(city) <= answers.CITY_MAX
        assert re.fullmatch(r"[A-Z][a-z]*(?: [A-Z][a-z]*)*", city), city


# Pay type (F6, F9) -------------------------------------------------------------------
@pytest.mark.parametrize(
    ("text", "last_asked"),
    [
        # F9 — a negated type is not that type.
        ("Not CTC", "pay_type"),
        ("No CTC, straight salary", "pay_type"),
        ("non-CTC", "pay_type"),
        ("without CTC", "pay_type"),
        ("CTC nahi", "pay_type"),
        ("18k, not CTC", "pay_range"),
        # F9 — "in hand" the SKILL is not "in hand" the pay.
        ("in hand tools", "pay_type"),
        ("Need fitters good in hand tools at 18k", "role_title"),
        ("Need 2 fitters good in hand tools, salary 18k, Pune", "role_title"),
        ("Need 2 fitters good in hand tools, salary 18k, Pune", None),
        ("should know hand grinding, in hand work, salary 15k", "skills"),
        ("fitter with in-hand tools skill, 20k pm", "role_title"),
        # F6 — two figures: the cue could describe either, so neither.
        ("gross 30k, in hand 25k", "pay_range"),
        ("Salary 20-25k, in hand around 18k after PF", "pay_range"),
        ("25k per month, 21k in hand", "pay_range"),
        ("30k, in hand 25k", "pay_range"),
        ("in hand 25k, gross 30k", "pay_range"),
        # F6 — bare "gross" is a CONFLICT detector cross-topic, never a value.
        ("20-25k in hand, gross", "pay_range"),
        # F9 — the cue must share a clause with the money it describes.
        ("salary 20k, good in hand fabrication", "skills"),
        # #1727 round 3 CONVERSIONS — a negation plus a type is not one allowlisted
        # answer (were in_hand, in_hand, ctc and gross).
        ("not CTC, in hand", "pay_type"),
        ("CTC nahi, in hand", "pay_type"),
        ("not in hand, it is CTC", "pay_type"),
        ("not net, gross", "pay_type"),
    ],
)
def test_pay_type_records_nothing_rather_than_a_guess_1727(text: str, last_asked: str | None):
    assert "pay_type" not in answers.detect_answers(text, last_asked)


@pytest.mark.parametrize(
    ("text", "last_asked", "pay_type"),
    [
        ("Rs 22,000 in hand", "pay_range", "in_hand"),
        ("in hand 25000", "pay_range", "in_hand"),
        ("20-25k in hand, 8 hours duty", "pay_range", "in_hand"),
        ("we need 5 welders, 20-25k in hand", "role_title", "in_hand"),
    ],
)
def test_pay_type_still_reads_a_clear_answer(text: str, last_asked: str, pay_type: str):
    assert answers.detect_answers(text, last_asked)["pay_type"] == pay_type


def test_two_figures_at_the_pay_question_leave_pay_type_to_be_asked():
    """F6 end to end, in the REAL order (pay_range is asked before pay_type)."""
    _, asked_id, state, _ = interview_engine.next_turn(
        _at_the_pay_question(), "Salary 20-25k, in hand around 18k after PF"
    )
    assert "pay_type" not in state.collected
    assert asked_id == "pay_type"


# Vacancy (F7) ------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("text", "last_asked"),
    [
        ("Welder, need 2-5 years experience", "role_title"),
        ("Welder (need 6-10 years exp)", "role_title"),
        ("require 3-4 years experience", "requirements"),
        ("ITI pass, require 2 to 5 years experience", "requirements"),
        ("hiring 2-5 yrs experienced fitters", "role_title"),
        ("looking for 2-5 years experience", "requirements"),
        ("CNC operator need 1-2 years exp", "role_title"),
        ("need 6-10 years", "role_title"),
        ("need 2 se 5 saal experience", "role_title"),
    ],
)
def test_a_cue_verb_before_an_experience_window_is_not_a_head_count(text: str, last_asked: str):
    assert "vacancy" not in answers.detect_answers(text, last_asked)


@pytest.mark.parametrize("text", ["we need 2-5 welders", "need 2 to 5 welders"])
def test_a_real_head_count_range_still_bands(text: str):
    assert answers.detect_answers(text, "role_title")["vacancy"] == "2-5"


def test_the_verb_form_leaves_vacancy_to_be_asked_end_to_end():
    _, asked_id, state, _ = interview_engine.next_turn(None, "Welder, need 2-5 years experience")
    assert "vacancy" not in state.collected
    assert state.collected["experience"] == {"min": 2, "max": 5}
    asked, _ = _drive(state, ["Pune"])
    assert asked == ["vacancy"]


# Brackets (F8) -----------------------------------------------------------------------
@pytest.mark.parametrize(
    ("text", "topic_id", "value"),
    [
        ("[PF, ESI]", "benefits", ["PF", "ESI"]),
        ("[TIG, MIG]", "skills", ["TIG", "MIG"]),
        ("[ITI], [10th pass]", "requirements", ["ITI", "10th pass"]),
        ("[Pune]", "location_label", "Pune"),
        ("[CNC Operator]", "role_title", "CNC Operator"),
    ],
)
def test_ordinary_square_brackets_are_trimmed_again(text: str, topic_id: str, value: object):
    assert answers.detect_answers(text, topic_id)[topic_id] == value


def test_every_placeholder_token_at_an_edge_stays_whole():
    """The bracket trim may never break a token: with a token at BOTH edges the
    bracket-trimmed text still holds none of them intact, so the bracket-less strip is
    used and both stay visible to the retype ask."""
    detected = answers.detect_answers("[PERSON_1] will call [PHONE_1]", "description")
    assert detected["description"] == "[PERSON_1] will call [PHONE_1]"
    two = answers.detect_answers("[PERSON_1] met [PHONE_1] today", "description")
    assert two["description"] == "[PERSON_1] met [PHONE_1] today"


# --- #1727 round 2: the hardening must not blank real requirements ---------------
# Experience is asked ONCE, so a screen that blanks a genuine requirement loses the card
# field for good. Each case below was blanked or truncated by the first hardening pass.
@pytest.mark.parametrize(
    ("text", "window"),
    [
        # #1727 round 3: "fresher or N years" is the allowlisted fresher+ceiling shape,
        # 0..N (it recorded 0..None before).
        ("Fresher or 2 years", {"min": 0, "max": 2}),
        ("under 3 years", {"min": None, "max": 3}),
        ("2 years max", {"min": None, "max": 2}),
    ],
)
def test_the_experience_hardening_keeps_real_requirements(text: str, window: dict):
    assert answers.detect_answers(text, "experience")["experience"] == window


@pytest.mark.parametrize(
    "text",
    [
        "We have 30 years experience in forging",  # the employer's own tenure
        "3 years. Not more than that",  # an unread ceiling never becomes a floor
        "Freshers will not be considered",
        # #1727 round 3 CONVERSIONS — none is one allowlisted shape (was the window after).
        "we are looking for 3 years experience",  # was {3, None}
        "3 years experience in a reputed company",  # was {3, None}
        "ITI plus 2 years experience",  # was {2, None}
        "2 years, will work under supervisor",  # was {2, None}
        "1 to 3 years in CNC, freshers can also apply",  # was {0, 3}
        "freshers or 1-2 years experience",  # was {0, 2}
        "We are a 25 years experienced company, need 2 years",  # was {2, None}
        "minimum 3 years, freshers are not allowed",  # was {3, None}
    ],
)
def test_the_experience_hardening_still_refuses_to_guess(text: str):
    assert "experience" not in answers.detect_answers(text, "experience")


def test_flexible_timings_is_not_a_joining_timeline():
    """#1727 round 3 CONVERSION (was "immediate"): two statements are not one
    allowlisted answer, so a "flexible" that belongs to the timings can no longer
    decide — or be decided by — the joining timeline."""
    assert answers.detect_answers("flexible timings, join immediately", "needed_by") == {}


@pytest.mark.parametrize("text", ["Chakan only", "only Bhiwadi"])
def test_only_is_emphasis_not_part_of_the_city(text: str):
    """#1727 round 3 CONVERSION (were "Chakan" / "Bhiwadi"): neither town is in the
    gazetteer, so neither is a card city. "only" is still stripped as emphasis — see
    the gazetteer twins below."""
    assert "city" not in answers.detect_answers(text, "city")


@pytest.mark.parametrize(("text", "city"), [("Pune only", "Pune"), ("only Nashik", "Nashik")])
def test_only_around_a_gazetteer_city_is_emphasis(text: str, city: str):
    assert answers.detect_answers(text, "city") == {"city": city}


# --- #1727 round 3: STRICT, allowlist answer detection ------------------------------
# PRECISION IS ABSOLUTE, RECALL IS BEST-EFFORT. Every scenario input in both review
# rounds (iss1727-review-findings.md F0-F15, iss1727-round2-findings.md STILL OPEN +
# R0-R34) is pinned below against the value the payer MEANT, or None = nothing recorded
# (topic absent, or answered with nothing). None is always acceptable; a different value
# never is.
def _exp(low: int | None, high: int | None) -> dict:
    return {"min": low, "max": high}


def _pay(low: int, high: int | None = None) -> dict:
    return {"pay_min": low, "pay_max": high}


_EMOJI = "\U0001f3ed"

# (finding, message, last_asked, topic read, expected value | None)
REVIEW_INPUTS: list[tuple[str, str, str | None, str, object]] = [
    # --- F0: age / course / tenure is not experience ---------------------------------
    ("F0", "age 25-40, 5 years experience", "experience", "experience", None),
    ("F0", "2 years, age up to 35", "experience", "experience", None),
    ("F0", "ITI 2 year course + 1 year experience", "experience", "experience", None),
    ("F0", "Age 20-35, 2-5 years", "experience", "experience", None),
    ("F0", "age 18 to 35, minimum 2 years", "experience", "experience", None),
    ("F0", "age limit 35, 3 years", "experience", "experience", None),
    ("F0", "Age 18-35 years with 3 years experience", "requirements", "experience", None),
    (
        "F0",
        "We are a 25 years experienced company making auto parts",
        "description",
        "experience",
        None,
    ),
    ("F0", "20 years experience in the industry, we make gears", "description", "experience", None),
    (
        "F0",
        "We have 30 years experience in forging, need 5 forging operators",
        "role_title",
        "experience",
        None,
    ),
    # --- F1 / F12: a ceiling is never a floor ------------------------------------------
    ("F1", "2 years max", "experience", "experience", _exp(None, 2)),
    ("F1", "2 years maximum", "experience", "experience", _exp(None, 2)),
    ("F1", "less than 2 years", "experience", "experience", _exp(None, 2)),
    ("F1", "below 5 years", "experience", "experience", _exp(None, 5)),
    ("F1", "under 3 years", "experience", "experience", _exp(None, 3)),
    ("F1", "not more than 3 years", "experience", "experience", None),
    ("F1", "5 saal tak", "experience", "experience", _exp(None, 5)),
    ("F1", "2 saal se kam", "experience", "experience", None),
    ("F1", "zyada se zyada 3 saal", "experience", "experience", None),
    ("F1", "within 2 years", "experience", "experience", None),
    ("F1", "2 years or less", "experience", "experience", None),
    ("F1", "max 2 years", "experience", "experience", _exp(None, 2)),
    ("F1", "maximum 2 years", "experience", "experience", _exp(None, 2)),
    ("F1", "up to 2 years", "experience", "experience", _exp(None, 2)),
    ("F1", "ITI, less than 3 years experience", "requirements", "experience", _exp(None, 3)),
    ("F1", "Fresher or less than 1 year", "experience", "experience", None),
    ("F12", "less than 3 years", "experience", "experience", _exp(None, 3)),
    ("F12", "under 2 years", "experience", "experience", _exp(None, 2)),
    ("F12", "2 se 5 saal", "experience", "experience", _exp(2, 5)),
    ("F12", "3 saal tak", "experience", "experience", _exp(None, 3)),
    ("F12", "3 saal se kam", "experience", "experience", None),
    ("F12", "maximum 3 years", "experience", "experience", _exp(None, 3)),
    ("F12", "2-5 years", "experience", "experience", _exp(2, 5)),
    ("F12", "2 to 5 saal", "experience", "experience", _exp(2, 5)),
    ("F12", "ITI pass, experience below 2 years", "requirements", "experience", _exp(None, 2)),
    (
        "F12",
        "CNC turning, less than 3 years experience",
        "skills",
        "experience",
        _exp(None, 3),
    ),
    # --- F2 / R3: a refused fresher is never min 0 --------------------------------------
    ("F2", "Freshers will not be considered", "experience", "experience", None),
    ("F2", "we don't want freshers", "experience", "experience", None),
    ("F2", "Freshers are not allowed", "experience", "experience", None),
    ("F2", "fresher mat bhejna", "experience", "experience", None),
    ("F2", "freshers ko nahi lenge", "experience", "experience", None),
    ("F2", "freshers are not considered", "experience", "experience", None),
    ("F2", "we do not hire freshers", "experience", "experience", None),
    ("F2", "don't send freshers", "experience", "experience", None),
    ("F2", "no freshers", "experience", "experience", None),
    ("F2", "freshers nahi chahiye", "experience", "experience", None),
    ("F2", "freshers not allowed", "experience", "experience", None),
    ("F2", "not for freshers", "experience", "experience", None),
    ("F2", "minimum 3 years, freshers are not allowed", "experience", "experience", None),
    ("F2", "Freshers will not be considered, minimum 2 years", "experience", "experience", None),
    ("F2", "ITI fitter, freshers will not be considered", "requirements", "experience", None),
    ("F2", "20000 in hand, we don't hire freshers", "pay_range", "experience", None),
    ("F2", "20000 in hand, we don't hire freshers", "pay_range", "pay_range", _pay(20000)),
    ("R3", "fresher nhi chahiye", "experience", "experience", None),
    ("R3", "freshers nai chahiye", "experience", "experience", None),
    ("R3", "freshers nhi", "experience", "experience", None),
    ("R3", "fresher na ho", "experience", "experience", None),
    ("R3", "fresher na bheje", "experience", "experience", None),
    ("R3", "Fresher na bheje", "experience", "experience", None),
    ("R3", "donot want freshers", "experience", "experience", None),
    ("R3", "company doesn't take freshers", "experience", "experience", None),
    ("R3", "candidate shouldn't be fresher", "experience", "experience", None),
    ("R3", "avoid freshers", "experience", "experience", None),
    ("R3", "except freshers", "experience", "experience", None),
    ("R3", "freshers excluded", "experience", "experience", None),
    ("R3", "freshers please excuse", "experience", "experience", None),
    ("R3", "Freshers excuse", "experience", "experience", None),
    ("R3", "fresher nai", "experience", "experience", None),
    ("R3", "fresher bilkul nhi", "experience", "experience", None),
    ("R3", "sirf experienced, fresher nhi", "experience", "experience", None),
    ("R3", "freshers cannot apply", "experience", "experience", None),
    ("R3", "freshers need not apply", "experience", "experience", None),
    ("R3", "Fresher", "experience", "experience", _exp(0, None)),
    ("R3", "fresher chalega", "experience", "experience", _exp(0, None)),
    ("R3", "freshers can apply", "experience", "experience", _exp(0, None)),
    ("R3", "fresher nhi chahiye, 2 saal experience", "experience", "experience", None),
    ("R3", "fresher nhi chahiye 2 saal experience", "experience", "experience", None),
    ("R3", "freshers nhi chalenge, 2 saal experience", "experience", "experience", None),
    ("R3", "Freshers excuse, minimum 2 years", "experience", "experience", None),
    ("R3", "Helper, fresher nhi chahiye", "role_title", "experience", None),
    ("R3", "Helper, freshers excuse", "role_title", "experience", None),
    ("R3", "ITI fitter, fresher nhi chahiye", "requirements", "experience", None),
    ("R3", "ITI fitter, freshers please excuse", "requirements", "experience", None),
    ("R3", "18k in hand, fresher nhi chahiye", "pay_range", "experience", None),
    ("R3", "freshers nhi chalenge, 2 saal experience", "requirements", "experience", None),
    (
        "R3",
        "ITI fitter, freshers nahi chalenge, 2 saal experience",
        "requirements",
        "experience",
        None,
    ),
    ("R3", "freshers welcome", "requirements", "experience", _exp(0, None)),
    ("R3", "Fresher or 1-2 years", "experience", "experience", None),
    ("R3", "freshers can also apply, 1 to 3 years", "experience", "experience", None),
    ("R3", "fresher bhi chalega na", "experience", "experience", None),
    # --- F3 / STILL-OPEN F3 / R9-R15: needed_by --------------------------------------
    ("F3", "Not very urgent", "needed_by", "needed_by", None),
    ("F3", "not that urgent", "needed_by", "needed_by", None),
    ("F3", "urgent nahi hai", "needed_by", "needed_by", None),
    ("F3", "bilkul urgent nahi", "needed_by", "needed_by", None),
    ("F3", "not required immediately", "needed_by", "needed_by", None),
    ("F3", "Not needed today", "needed_by", "needed_by", None),
    ("F3", "abhi pata nahi", "needed_by", "needed_by", None),
    ("F3", "abhi decide nahi kiya", "needed_by", "needed_by", None),
    ("F3", "koi jaldi nahi", "needed_by", "needed_by", "flexible"),
    ("F3", "jaldi nahi hai", "needed_by", "needed_by", None),
    ("F3", "Immediate joining, timings flexible", "needed_by", "needed_by", None),
    ("F3", "ASAP, salary flexible", "needed_by", "needed_by", None),
    ("F3", "not urgent", "needed_by", "needed_by", "flexible"),
    ("F3", "not immediately", "needed_by", "needed_by", None),
    ("F3", "abhi nahi", "needed_by", "needed_by", None),
    ("F3+", "no urgent requirement", "needed_by", "needed_by", None),
    ("F3+", "no urgent need", "needed_by", "needed_by", None),
    ("F3+", "no urgent hiring", "needed_by", "needed_by", None),
    ("F3+", "no urgent", "needed_by", "needed_by", None),
    ("F3+", "abhi nhi", "needed_by", "needed_by", None),
    ("F3+", "abhi nhi, next month", "needed_by", "needed_by", None),
    ("F3+", "turant nhi", "needed_by", "needed_by", None),
    ("F3+", "urgent nhi hai", "needed_by", "needed_by", None),
    ("F3+", "urgent nai hai", "needed_by", "needed_by", None),
    ("F3+", "jaldi nhi hai", "needed_by", "needed_by", None),
    ("F3+", "abhi pata nhi", "needed_by", "needed_by", None),
    ("F3+", "not at all urgent", "needed_by", "needed_by", None),
    ("F3+", "isn't urgent", "needed_by", "needed_by", None),
    ("F3+", "don't need immediately", "needed_by", "needed_by", None),
    ("F3+", "no need to join immediately", "needed_by", "needed_by", None),
    ("F3+", "cannot start immediately", "needed_by", "needed_by", None),
    ("F3+", "immediately not required", "needed_by", "needed_by", None),
    ("F3+", "not much urgent", "needed_by", "needed_by", None),
    ("R9", "No urgent joining", "needed_by", "needed_by", None),
    ("R9", "No urgent", "needed_by", "needed_by", None),
    ("R9", "there is no urgent requirement", "needed_by", "needed_by", None),
    ("R9", "no urgent requirement sir", "needed_by", "needed_by", None),
    ("R9", "no urgently needed", "needed_by", "needed_by", None),
    ("R9", "no so urgent", "needed_by", "needed_by", None),
    ("R9", "no urgent requirement, next month", "needed_by", "needed_by", None),
    ("R9", "no urgent requirement, can join in 15 days", "needed_by", "needed_by", None),
    ("R9", "No urgent need, 2-3 weeks", "needed_by", "needed_by", None),
    ("R9", "no urgency", "needed_by", "needed_by", "flexible"),
    ("R9", "urgent", "needed_by", "needed_by", "immediate"),
    ("R9", "no its urgent", "needed_by", "needed_by", None),
    ("R9", "no sir urgent requirement", "needed_by", "needed_by", None),
    ("R9", "no we need urgently", "needed_by", "needed_by", None),
    ("R9", "no need urgently", "needed_by", "needed_by", None),
    ("R9", "nothing urgent", "needed_by", "needed_by", None),
    ("R9", "not an urgent requirement", "needed_by", "needed_by", None),
    ("R10", "urgent nai hai", "needed_by", "needed_by", None),
    ("R10", "jaldi nai", "needed_by", "needed_by", None),
    ("R10", "abhi pata nai", "needed_by", "needed_by", None),
    ("R10", "abhi decide nai kiya", "needed_by", "needed_by", None),
    ("R10", "urgent to nahi hai", "needed_by", "needed_by", None),
    ("R10", "urgent toh nahi", "needed_by", "needed_by", None),
    ("R10", "jaldi bhi nahi", "needed_by", "needed_by", None),
    ("R10", "abhi confirm nahi", "needed_by", "needed_by", None),
    ("R10", "abhi fix nahi hai", "needed_by", "needed_by", None),
    ("R10", "abhi tay nahi", "needed_by", "needed_by", None),
    ("R10", "abhi soch rahe hain", "needed_by", "needed_by", None),
    ("R10", "abhi kuch nahi keh sakte", "needed_by", "needed_by", None),
    ("R10", "abhi se 15 din", "needed_by", "needed_by", None),
    ("R10", "abhi 10 din baad", "needed_by", "needed_by", None),
    ("R10", "abhi 1 mahine me", "needed_by", "needed_by", None),
    ("R10", "abhi nai", "needed_by", "needed_by", None),
    ("R10", "abhi ni", "needed_by", "needed_by", None),
    ("R10", "urgent ni hai", "needed_by", "needed_by", None),
    ("R10", "abhi nhi chahiye", "needed_by", "needed_by", None),
    ("R10", "Abhi Nhi", "needed_by", "needed_by", None),
    ("R10", "abhi to nahi", "needed_by", "needed_by", None),
    ("R10", "abhi nhi, 15 din baad", "needed_by", "needed_by", None),
    ("R10", "immediately nahi", "needed_by", "needed_by", None),
    ("R10", "immediate nahi chahiye", "needed_by", "needed_by", None),
    ("R10", "urgent nahin", "needed_by", "needed_by", None),
    ("R10", "urgent nahi h", "needed_by", "needed_by", None),
    ("R10", "abhi nahin", "needed_by", "needed_by", None),
    ("R10", "abhi nahi chahiye", "needed_by", "needed_by", None),
    ("R10", "pata nhi", "needed_by", "needed_by", None),
    ("R10", "urgent hai na", "needed_by", "needed_by", None),
    ("R10", "abhi chahiye na", "needed_by", "needed_by", None),
    ("R10", "jaldi chahiye na", "needed_by", "needed_by", None),
    ("R11", "not an urgent requirement", "needed_by", "needed_by", None),
    ("R11", "dont need immediately", "needed_by", "needed_by", None),
    ("R11", "we don't need them urgently", "needed_by", "needed_by", None),
    ("R11", "not required to join immediately", "needed_by", "needed_by", None),
    ("R11", "urgent not required", "needed_by", "needed_by", None),
    ("R11", "never urgent", "needed_by", "needed_by", None),
    ("R11", "not so much urgent", "needed_by", "needed_by", None),
    ("R11", "not in urgent need", "needed_by", "needed_by", None),
    ("R11", "don't need urgently", "needed_by", "needed_by", None),
    ("R11", "don't need them today", "needed_by", "needed_by", None),
    ("R11", "urgently nahi chahiye", "needed_by", "needed_by", None),
    ("R11", "urgent requirement nahi hai", "needed_by", "needed_by", None),
    ("R11", "immediate not possible", "needed_by", "needed_by", None),
    ("R11", "abhi zarurat nahi", "needed_by", "needed_by", None),
    ("R11", "jaldi ki koi baat nahi", "needed_by", "needed_by", None),
    ("R11", "not immediate, within a month", "needed_by", "needed_by", None),
    ("R11", "Immediately", "needed_by", "needed_by", "immediate"),
    ("R11", "ASAP", "needed_by", "needed_by", "immediate"),
    ("R11", "No urgency, anytime", "needed_by", "needed_by", None),
    ("R12", "not flexible", "needed_by", "needed_by", None),
    ("R12", "Not flexible", "needed_by", "needed_by", None),
    ("R12", "flexible nahi hai", "needed_by", "needed_by", None),
    ("R12", "date is not flexible", "needed_by", "needed_by", None),
    ("R12", "not flexible, need by 1st", "needed_by", "needed_by", None),
    ("R12", "no, not flexible", "needed_by", "needed_by", None),
    ("R12", "joining date not flexible", "needed_by", "needed_by", None),
    ("R12", "not flexible at all", "needed_by", "needed_by", None),
    ("R12", "not soon", "needed_by", "needed_by", None),
    ("R12", "not this month", "needed_by", "needed_by", None),
    ("R12", "not within a month", "needed_by", "needed_by", None),
    ("R12", "not in 15 days", "needed_by", "needed_by", None),
    ("R12", "not next week", "needed_by", "needed_by", None),
    ("R12", "next week nahi", "needed_by", "needed_by", None),
    ("R12", "not this week", "needed_by", "needed_by", None),
    ("R12", "this week nahi", "needed_by", "needed_by", None),
    ("R12", "not this week, next week", "needed_by", "needed_by", None),
    ("R12", "this week nahi, next week", "needed_by", "needed_by", None),
    ("R12", "this week not possible, next week", "needed_by", "needed_by", None),
    ("R12", "not today or tomorrow", "needed_by", "needed_by", None),
    ("R12", "not today or tomorrow, next week", "needed_by", "needed_by", None),
    ("R12", "today not possible, next week", "needed_by", "needed_by", None),
    ("R12", "today not possible", "needed_by", "needed_by", None),
    ("R12", "immediate nahi, next week", "needed_by", "needed_by", None),
    ("R12", "immediately not possible, next week", "needed_by", "needed_by", None),
    ("R12", "not today", "needed_by", "needed_by", None),
    ("R12", "not immediately, next week", "needed_by", "needed_by", None),
    ("R12", "is week nahi, next week", "needed_by", "needed_by", None),
    ("R12", "aaj nahi, next week", "needed_by", "needed_by", None),
    ("R12", "not flexible, need immediately", "needed_by", "needed_by", None),
    ("R12", "ASAP, within 15 days", "needed_by", "needed_by", None),
    ("R12", "immediately or within a week", "needed_by", "needed_by", None),
    ("R12", "urgent, within 2 weeks", "needed_by", "needed_by", None),
    ("R12", "not flexible, urgent", "needed_by", "needed_by", None),
    ("R12", "flexible nahi, turant chahiye", "needed_by", "needed_by", None),
    ("R13", "5 days a week", "needed_by", "needed_by", None),
    ("R13", "Flexible, 12 hours a day", "needed_by", "needed_by", None),
    ("R13", "whenever, 6 days a week", "needed_by", "needed_by", None),
    ("R13", "anytime, 8 hours a day duty", "needed_by", "needed_by", None),
    ("R13", "6 days a week, flexible joining", "needed_by", "needed_by", None),
    ("R13", "flexible, 26 days a month", "needed_by", "needed_by", None),
    ("R13", "Joining flexible, 26 din ka mahina", "needed_by", "needed_by", None),
    ("R13", "Flexible, 6 days per week", "needed_by", "needed_by", None),
    ("R13", "flexible, 1 day off a week", "needed_by", "needed_by", None),
    ("R13", "Flexible, duty 6 days a week", "needed_by", "needed_by", None),
    ("R13", "Kabhi bhi, hafte me 6 din", "needed_by", "needed_by", None),
    ("R13", "Flexible, 8 hours per day", "needed_by", "needed_by", None),
    ("R13", "Immediately, 6 days a week", "needed_by", "needed_by", None),
    ("R14", "time is flexible", "needed_by", "needed_by", None),
    ("R14", "timing flexible hai", "needed_by", "needed_by", None),
    ("R14", "timing is flexible", "needed_by", "needed_by", None),
    ("R14", "start time is flexible", "needed_by", "needed_by", None),
    ("R14", "joining-time flexible", "needed_by", "needed_by", None),
    ("R14", "no problem immediately join", "needed_by", "needed_by", None),
    ("R14", "no we need immediately", "needed_by", "needed_by", None),
    ("R14", "not later than tomorrow", "needed_by", "needed_by", None),
    ("R14", "no later than today", "needed_by", "needed_by", None),
    ("R14", "joining ka time flexible hai", "needed_by", "needed_by", None),
    ("R14", "join karne ka time flexible hai", "needed_by", "needed_by", None),
    ("R14", "time flexible", "needed_by", "needed_by", None),
    ("R14", "no problem join today itself", "needed_by", "needed_by", None),
    ("R14", "ok no problem immediately", "needed_by", "needed_by", None),
    ("R14", "no issue immediately", "needed_by", "needed_by", None),
    ("R14", "no we want today only", "needed_by", "needed_by", None),
    ("R14", "no problem sir immediately join", "needed_by", "needed_by", None),
    ("R14", "joining not later than tomorrow", "needed_by", "needed_by", None),
    ("R14", "no problem, immediately", "needed_by", "needed_by", None),
    ("R14", "no sir, immediately", "needed_by", "needed_by", None),
    ("R14", "time is flexible, within a month", "needed_by", "needed_by", None),
    ("R14", "flexible, within a month", "needed_by", "needed_by", None),
    ("R15", "ek hafta", "needed_by", "needed_by", "soon"),
    ("R15", "1 hafta", "needed_by", "needed_by", "soon"),
    ("R15", "2 hafton me", "needed_by", "needed_by", None),
    ("R15", "10 dino me", "needed_by", "needed_by", None),
    ("R15", "15 dinon me", "needed_by", "needed_by", None),
    ("R15", "do hafte", "needed_by", "needed_by", None),
    ("R15", "do hafte me", "needed_by", "needed_by", None),
    ("R15", "teen din", "needed_by", "needed_by", None),
    ("R15", "char din me", "needed_by", "needed_by", None),
    ("R15", "a fortnight", "needed_by", "needed_by", None),
    ("R15", "fortnight", "needed_by", "needed_by", None),
    ("R15", "2 hafte baad me", "needed_by", "needed_by", None),
    ("R15", "10 din baad mein join", "needed_by", "needed_by", None),
    ("R15", "15 din ke baad mein", "needed_by", "needed_by", None),
    ("R15", "15 din baad", "needed_by", "needed_by", None),
    ("R15", "10 din ke baad", "needed_by", "needed_by", None),
    ("R15", "jaldi se jaldi", "needed_by", "needed_by", "immediate"),
    ("R15", "as soon as possible", "needed_by", "needed_by", "immediate"),
    ("R15", "15 dino mein", "needed_by", "needed_by", None),
    ("R15", "paanch din", "needed_by", "needed_by", None),
    ("R15", "saat din me", "needed_by", "needed_by", None),
    ("R15", "das din me", "needed_by", "needed_by", None),
    ("R15", "kal se join", "needed_by", "needed_by", None),
    ("R15", "kal se chahiye", "needed_by", "needed_by", None),
    ("R15", "agle hafte se", "needed_by", "needed_by", None),
    ("R15", "agle mahine se", "needed_by", "needed_by", None),
    ("R15", "is hafte", "needed_by", "needed_by", None),
    ("R15", "is mahine", "needed_by", "needed_by", None),
    ("R15", "15 days baad mein", "needed_by", "needed_by", None),
    ("R15", "15 days baad mein join karna hai", "needed_by", "needed_by", None),
    ("R15", "next week ke baad mein", "needed_by", "needed_by", None),
    ("R15", "within 15 days, baaki baad me", "needed_by", "needed_by", None),
    (
        "R15",
        "turant chahiye, salary baad me discuss karenge",
        "needed_by",
        "needed_by",
        None,
    ),
    ("R15", "urgent hai, baaki details baad me", "needed_by", "needed_by", None),
    ("R15", "abhi chahiye, documents baad mein de dena", "needed_by", "needed_by", None),
    ("R15", "immediately, interview baad me", "needed_by", "needed_by", None),
    ("R15", "asap. baad me call karna", "needed_by", "needed_by", None),
    ("R15", "baad me batayenge", "needed_by", "needed_by", None),
    ("R15", "baad me", "needed_by", "needed_by", None),
    ("R15", "jitna jaldi ho sake", "needed_by", "needed_by", None),
    # --- F13: counted timelines ---------------------------------------------------------
    ("F13", "Within a week", "needed_by", "needed_by", "soon"),
    ("F13", "in a week", "needed_by", "needed_by", None),
    ("F13", "7 days", "needed_by", "needed_by", "soon"),
    ("F13", "2 weeks", "needed_by", "needed_by", "soon"),
    ("F13", "1 week", "needed_by", "needed_by", "soon"),
    ("F13", "one week", "needed_by", "needed_by", None),
    ("F13", "1 month", "needed_by", "needed_by", "soon"),
    ("F13", "a month", "needed_by", "needed_by", "soon"),
    ("F13", "within 2 months", "needed_by", "needed_by", None),
    ("F13", "next 10 days", "needed_by", "needed_by", "soon"),
    ("F13", "1-2 weeks", "needed_by", "needed_by", "soon"),
    ("F13", "2-3 days", "needed_by", "needed_by", "soon"),
    ("F13", "ek hafte me", "needed_by", "needed_by", None),
    ("F13", "ek mahine me", "needed_by", "needed_by", None),
    ("F13", "10 din me", "needed_by", "needed_by", None),
    ("F13", "15 din", "needed_by", "needed_by", "soon"),
    ("F13", "2 hafte", "needed_by", "needed_by", "soon"),
    ("F13", "in 2 weeks", "needed_by", "needed_by", "soon"),
    ("F13", "within 2 weeks", "needed_by", "needed_by", "soon"),
    ("F13", "within 7 days", "needed_by", "needed_by", "soon"),
    ("F13", "within 15 days", "needed_by", "needed_by", "soon"),
    ("F13", "15 days", "needed_by", "needed_by", "soon"),
    ("F13", "Within a month", "needed_by", "needed_by", "soon"),
    ("F13", "next week", "needed_by", "needed_by", "soon"),
    ("F13", "by next month", "needed_by", "needed_by", None),
    ("F13", "joining in 10 days", "needed_by", "needed_by", "soon"),
    ("F13", "in 115 days", "needed_by", "needed_by", None),
    # --- F4 / F10 / F14 / R21 / R22 / R26 / R28: the city from the location answer -----
    ("F4", "Delhi-Jaipur highway, Neemrana", "location_label", "city", "Neemrana"),
    ("F4", "Mumbai-Pune expressway, Talegaon", "location_label", "city", None),
    ("F4", "Office in Delhi, factory in Manesar", "location_label", "city", None),
    ("F4", "Not Mumbai, Thane", "location_label", "city", None),
    ("F4", "Pune nahi, Nashik", "location_label", "city", None),
    ("F4", "Bangalore-Hosur road, Hosur", "location_label", "city", "Hosur"),
    ("F4", "Delhi NCR, Noida sector 63", "location_label", "city", None),
    ("F4", "Pune, Chakan", "location_label", "city", "Pune"),
    ("F4", "Chakan, near Pune", "location_label", "city", "Pune"),
    ("F4", "Gurgaon (Gurugram)", "location_label", "city", None),
    ("F10", "Bommasandra, Hosur Road, Bangalore", "location_label", "city", "Bangalore"),
    ("F10", "Electronic City, Hosur Road", "location_label", "city", None),
    ("F10", "Attibele, Hosur Road, Bengaluru", "location_label", "city", "Bangalore"),
    ("F10", "Hosur Road, Bengaluru", "location_label", "city", "Bangalore"),
    ("F10", "Bhiwadi, Delhi Jaipur Highway", "location_label", "city", None),
    ("F10", "Delhi Road, Meerut", "location_label", "city", None),
    ("F10", "Mumbai-Pune expressway, Lonavala", "location_label", "city", None),
    ("F10", "Old Mumbai Road, Pune", "location_label", "city", "Pune"),
    ("F10", "Pimpri, Old Mumbai-Pune Highway", "location_label", "city", None),
    ("F10", "Ahmedabad Highway, Sanand", "location_label", "city", "Sanand"),
    ("F10", "Chennai Bypass, Sriperumbudur", "location_label", "city", "Sriperumbudur"),
    ("F10", "Pune Nagar Road, Ranjangaon", "location_label", "city", None),
    ("F10", "Navi Mumbai, Vashi", "location_label", "city", "Navi Mumbai"),
    ("F10", "Nashik Road, Nashik", "location_label", "city", "Nashik"),
    ("F14", "Old Delhi Road, Gurgaon", "location_label", "city", "Gurugram"),
    ("F14", "Bangalore Road, Hosur", "location_label", "city", "Hosur"),
    ("F14", "Mumbai-Agra highway, Bhiwandi", "location_label", "city", None),
    ("F14", "Pune office, but site is in Satara", "location_label", "city", None),
    ("F14", "Hosur Road, Bangalore", "location_label", "city", "Bangalore"),
    ("F14", "Electronic City, Hosur Road, Bengaluru", "location_label", "city", "Bangalore"),
    ("F14", "Nashik Road, Pune", "location_label", "city", "Pune"),
    ("F14", "Jaipur Road, Ajmer", "location_label", "city", None),
    ("F14", "Ahmedabad Highway, Vadodara", "location_label", "city", "Vadodara"),
    ("F14", "Mumbai Pune Highway, Lonavala", "location_label", "city", None),
    ("F14", "Thane Belapur Road, Navi Mumbai", "location_label", "city", "Navi Mumbai"),
    ("R21", "Mumbai Agra National Highway, Bhiwandi", "location_label", "city", None),
    ("R21", "Mumbai Nashik Old Highway, Bhiwandi", "location_label", "city", None),
    ("R21", "Pune Bangalore National Highway, Satara", "location_label", "city", None),
    ("R21", "Pune Satara Old Road, Shirwal", "location_label", "city", None),
    ("R21", "Mumbai Pune Old Highway, Khopoli", "location_label", "city", None),
    ("R21", "Mumbai Goa NH 66, Panvel", "location_label", "city", None),
    ("R21", "Mumbai–Agra highway, Bhiwandi", "location_label", "city", None),
    ("R21", "Mumbai—Pune expressway, Talegaon", "location_label", "city", None),
    ("R21", "Mumbai‐Agra highway, Bhiwandi", "location_label", "city", None),
    ("R21", "Mumbai Ahmedabad National Highway, Vasai", "location_label", "city", None),
    ("R21", "Pune Nashik National Highway, Chakan", "location_label", "city", None),
    ("R21", "Pune Mumbai Old Highway, Talegaon", "location_label", "city", None),
    ("R21", "Mumbai–Pune expressway, Lonavala", "location_label", "city", None),
    ("R21", "Bangalore Hosur Main Road, Electronic City", "location_label", "city", None),
    ("R21", "Mumbai to Pune highway, Talegaon", "location_label", "city", None),
    ("R21", "Mumbai/Agra highway, Bhiwandi", "location_label", "city", None),
    ("R21", "Mumbai Agra Highway, Bhiwandi", "location_label", "city", None),
    ("R21", "Mumbai - Agra National Highway, Bhiwandi", "location_label", "city", None),
    ("R21", "Pune Satara Road, Shirwal", "location_label", "city", None),
    ("R21", "Delhi–Jaipur highway, Neemrana", "location_label", "city", "Neemrana"),
    (
        "R21",
        "Chennai Bangalore National Highway, Sriperumbudur",
        "location_label",
        "city",
        "Sriperumbudur",
    ),
    ("R21", "Delhi Mathura Road, Faridabad", "location_label", "city", "Faridabad"),
    ("R21", "Mumbai Andheri Link Road", "location_label", "city", None),
    ("R21", "Hyderabad Jeedimetla Main Road", "location_label", "city", None),
    ("R22", "Office in Pune, work at Satara", "location_label", "city", None),
    ("R22", "Interview in Pune, job at Satara", "location_label", "city", None),
    ("R22", "Company in Pune, job in Satara", "location_label", "city", None),
    (
        "R22",
        "Registered office in Mumbai, work location Bhiwandi",
        "location_label",
        "city",
        None,
    ),
    ("R22", "Head office Mumbai, kaam Bhiwandi mein", "location_label", "city", None),
    (
        "R22",
        "Our office is in Mumbai but the job is in Bhiwandi",
        "location_label",
        "city",
        None,
    ),
    ("R22", "Satara, interview in Pune", "location_label", "city", None),
    ("R22", "Interview Pune, joining Satara", "location_label", "city", None),
    ("R22", "Interview at Pune, duty at Satara", "location_label", "city", None),
    ("R22", "Company Pune ki hai, kaam Satara MIDC mein", "location_label", "city", None),
    (
        "R22",
        "Our company is in Pune but job location Ranjangaon MIDC",
        "location_label",
        "city",
        None,
    ),
    ("R22", "Registered in Mumbai, factory at Bhiwandi", "location_label", "city", None),
    ("R22", "Chakan, Pune", "location_label", "city", "Pune"),
    ("R22", "Job in Pune", "location_label", "city", "Pune"),
    ("R22", "Company in Pune", "location_label", "city", "Pune"),
    ("R22", "Plant in Chakan, Pune", "location_label", "city", None),
    ("R23", "Thane-West, Wagle Estate", "location_label", "city", None),
    ("R23", "Pune - Chakan", "location_label", "city", None),
    ("R23", "Chakan-Pune", "location_label", "city", None),
    ("R23", "Pune-Chakan", "location_label", "city", None),
    ("R23", "Pune - Chakan MIDC", "location_label", "city", None),
    ("R23", "Delhi-NCR", "location_label", "city", None),
    ("R23", "Mumbai airport road, Andheri", "location_label", "city", None),
    ("R26", "Bangalore, Peenya", "location_label", "city", None),
    ("R26", "Gurgaon, Manesar", "location_label", "city", None),
    ("R26", "Chennai, Sriperumbudur", "location_label", "city", None),
    ("R26", "Ahmedabad, Sanand GIDC", "location_label", "city", "Ahmedabad"),
    ("R26", "Indore, Pithampur", "location_label", "city", None),
    ("R26", "Solan, Baddi", "location_label", "city", None),
    ("R26", "Plant and office both in Pune", "location_label", "city", None),
    ("R26", "Gurugram, Manesar IMT", "location_label", "city", "Gurugram"),
    ("R26", "Bengaluru, Peenya 2nd stage", "location_label", "city", "Bangalore"),
    ("R26", "Delhi, Noida", "location_label", "city", None),
    ("R26", "Mumbai, Thane", "location_label", "city", None),
    ("R26", "Chennai, Hosur", "location_label", "city", None),
    ("R28", "Gurgaon (Gurugram)", "location_label", "city", None),
    ("R28", "Pune (Chakan)", "location_label", "city", None),
    ("R28", "Pune (multiple sites)", "location_label", "city", None),
    ("R28", "Pune, Chakan, near Talegaon", "location_label", "city", None),
    ("R28", "Office in Mumbai, work at Bhiwandi", "location_label", "city", None),
    ("R28", "HO in Mumbai, job in Bhiwandi", "location_label", "city", None),
    ("R28", "Head office in Mumbai, job at Vasai", "location_label", "city", None),
    ("R28", "Registered in Mumbai, work location Bhiwandi", "location_label", "city", None),
    ("R28", "Company is in Delhi but job is at Bawal", "location_label", "city", None),
    ("F11", "Vapi GIDC", "location_label", "city", None),
    ("F11", "Bhosari MIDC", "location_label", "city", None),
    ("F11", "Chakan MIDC", "location_label", "city", None),
    # --- F4 / F5 / F11 / F15 / R23-R26: the city question -------------------------------
    ("F4", "Chakan (not Pune)", "city", "city", None),
    ("F4", "Not Pune, Nashik", "city", "city", None),
    ("F4", "Plant in Talegaon, office in Mumbai", "city", "city", None),
    ("F5", "Anywhere in India", "city", "city", None),
    ("F5", "anywhere in Maharashtra", "city", "city", None),
    ("F5", "Not sure, somewhere in Gujarat", "city", "city", None),
    ("F5", "no idea", "city", "city", None),
    ("F5", "not decided yet", "city", "city", None),
    ("F5", "will tell later", "city", "city", None),
    ("F5", "tbd", "city", "city", None),
    ("F5", "TBD", "city", "city", None),
    ("F5", "later", "city", "city", None),
    ("F5", "depends", "city", "city", None),
    ("F5", "abhi decide nahi", "city", "city", None),
    ("F5", "not fixed yet", "city", "city", None),
    ("F5", "multiple locations", "city", "city", None),
    ("F5", "maybe", "city", "city", None),
    ("F5", "don't know", "city", "city", None),
    ("F5", "not sure", "city", "city", None),
    ("F5", "anywhere", "city", "city", None),
    ("F5", "all india", "city", "city", None),
    ("F5", "pata nahi", "city", "city", None),
    ("F5", "same as above", "city", "city", None),
    ("F5", "any city", "city", "city", None),
    ("F11", "Chakan", "city", "city", None),
    ("F11", "already told", "city", "city", None),
    ("F11", "Chakan only", "city", "city", None),
    ("F11", "I just told you, Chakan", "city", "city", None),
    ("F11", "I already said, Vapi", "city", "city", None),
    ("F11", "Pune district", "city", "city", "Pune"),
    ("F11", "Chakan, Pune district", "city", "city", "Pune"),
    ("F15", "Pimpri" + _EMOJI * 41, "city", "city", None),
    ("F15", "Pimpri " + _EMOJI * 41, "city", "city", None),
    ("F15", _EMOJI * 79 + "a", "city", "city", None),
    ("F15", "Pimpri" + _EMOJI * 74, "city", "city", None),
    ("R23", "Thane-West", "city", "city", None),
    ("R23", "Delhi-NCR", "city", "city", None),
    ("R23", "Pune-Nashik highway", "city", "city", None),
    ("R23", "Hosur Road", "city", "city", None),
    ("R23", "Hosur Road side", "city", "city", None),
    ("R23", "Bangalore Road", "city", "city", None),
    ("R23", "Delhi-Jaipur highway", "city", "city", None),
    ("R23", "Pune - Chakan", "city", "city", None),
    ("R23", "Chakan-Pune", "city", "city", None),
    ("R23", "Nashik Road", "city", "city", None),
    ("R23", "Mumbai-West", "city", "city", None),
    ("R23", "Greater-Noida", "city", "city", None),
    ("R23", "Navi-Mumbai", "city", "city", None),
    ("R23", "Thane West", "city", "city", None),
    ("R23", "Thane (W)", "city", "city", None),
    ("R23", "Delhi NCR", "city", "city", None),
    ("R23", "Sohna Road", "city", "city", None),
    ("R23", "Kalyan-West", "city", "city", None),
    ("R24", "mentioned above", "city", "city", None),
    ("R24", "as mentioned", "city", "city", None),
    ("R24", "see above", "city", "city", None),
    ("R24", "given above", "city", "city", None),
    ("R24", "upar diya hai", "city", "city", None),
    ("R24", "wahi", "city", "city", None),
    ("R24", "as mentioned above", "city", "city", None),
    ("R24", "upar bataya", "city", "city", None),
    ("R24", "bataya na", "city", "city", None),
    ("R24", "bola na", "city", "city", None),
    ("R24", "kahin bhi", "city", "city", None),
    ("R24", "kahi bhi", "city", "city", None),
    ("R24", "koi bhi", "city", "city", None),
    ("R24", "koi bhi city", "city", "city", None),
    ("R24", "kuch bhi", "city", "city", None),
    ("R24", "nhi pata", "city", "city", None),
    ("R24", "pta nhi", "city", "city", None),
    ("R24", "kahin bhi chalega", "city", "city", None),
    ("R24", "idk", "city", "city", None),
    ("R24", "dunno", "city", "city", None),
    ("R24", "unknown", "city", "city", None),
    ("R24", "yet to decide", "city", "city", None),
    ("R24", "will update", "city", "city", None),
    ("R24", "will inform", "city", "city", None),
    ("R24", "doesn't matter", "city", "city", None),
    ("R24", "no matter", "city", "city", None),
    ("R24", "no preference", "city", "city", None),
    ("R24", "all cities", "city", "city", None),
    ("R24", "various", "city", "city", None),
    ("R24", "multiple", "city", "city", None),
    ("R24", "पता नहीं", "city", "city", None),
    ("R24", "मालूम नहीं", "city", "city", None),
    ("R24", "कहीं भी", "city", "city", None),
    ("R24", "ऊपर बताया", "city", "city", None),
    ("R24", "वही", "city", "city", None),
    ("R24", "पुणे", "city", "city", None),
    ("R24", "Chakan and Talegaon", "city", "city", None),
    ("R24", "Chakan or Talegaon", "city", "city", None),
    ("R24", "Chakan ya Talegaon", "city", "city", None),
    ("R24", "Chakan aur Talegaon", "city", "city", None),
    ("R24", "Chakan hi hai", "city", "city", None),
    ("R24", "Chakan hi", "city", "city", None),
    ("R24", "Chakan hai", "city", "city", None),
    ("R24", "Chakan itself", "city", "city", None),
    ("R25", "Gujarat", "city", "city", None),
    ("R25", "Maharashtra", "city", "city", None),
    ("R25", "Tamil Nadu", "city", "city", None),
    ("R25", "UP", "city", "city", None),
    ("R25", "MH", "city", "city", None),
    ("R25", "Gujarat state", "city", "city", None),
    ("R25", "Tamil Nadu side", "city", "city", None),
    ("R25", "Karnataka", "city", "city", None),
    ("R25", "Haryana", "city", "city", None),
    ("R25", "Uttar Pradesh", "city", "city", None),
    ("R25", "West Bengal", "city", "city", None),
    ("R25", "Punjab", "city", "city", None),
    ("R25", "Goa", "city", "city", None),
    ("R25", "Kerala", "city", "city", None),
    ("R25", "only Gujarat", "city", "city", None),
    ("R25", "Maharashtra only", "city", "city", None),
    ("R25", "Vapi in Gujarat", "city", "city", None),
    ("R25", "Satara, in Maharashtra", "city", "city", None),
    ("R25", "Ankleshwar in Gujarat", "city", "city", None),
    ("R25", "Bhiwadi in Rajasthan", "city", "city", None),
    ("R25", "Hosur in Tamil Nadu", "city", "city", None),
    ("R25", "Sanand, Gujarat", "city", "city", "Sanand"),
    ("R25", "Noida UP", "city", "city", None),
    ("R25", "Vapi, Gujarat", "city", "city", None),
    ("R25", "Satara, Maharashtra", "city", "city", None),
    ("R25", "Bharuch, Gujarat", "city", "city", None),
    ("R25", "Bhiwadi, Rajasthan", "city", "city", None),
    ("R25", "It is in Vapi, Gujarat", "city", "city", None),
    ("R25", "Plant is in Vapi, Gujarat", "city", "city", None),
    ("R25", "near Vapi, Gujarat", "city", "city", None),
    ("R25", "Satara (Maharashtra)", "city", "city", None),
    ("R25", "Vapi Gujarat", "city", "city", None),
    ("R25", "Satara Maharashtra", "city", "city", None),
    ("R25", "Vapi - Gujarat", "city", "city", None),
    ("R25", "Gujarat me Vapi", "city", "city", None),
    ("R25", "Gujarat mein", "city", "city", None),
    ("R25", "UP side", "city", "city", None),
    ("R26", "Peenya is in Bangalore", "city", "city", None),
    ("R26", "Peenya Bangalore mein hai", "city", "city", None),
    ("R26", "Peenya, Bangalore", "city", "city", None),
    ("R26", "Manesar is in Gurgaon", "city", "city", None),
    ("R26", "Sriperumbudur comes under Chennai", "city", "city", None),
    ("R26", "Pune-Chakan", "city", "city", None),
    ("R26", "Bangalore-Peenya", "city", "city", None),
    ("R26", "Gurgaon-Manesar", "city", "city", None),
    ("R26", "Nashik-Satpur", "city", "city", None),
    ("R26", "Bangalore", "city", "city", "Bangalore"),
    # --- F6 / F9 / R30-R33 and the REJECTED note: pay_type -------------------------------
    ("F6", "gross 30k, in hand 25k", "pay_range", "pay_type", None),
    ("F6", "Salary 20-25k, in hand around 18k after PF", "pay_range", "pay_type", None),
    ("F6", "25k per month, 21k in hand", "pay_range", "pay_type", None),
    ("F6", "30k, in hand 25k", "pay_range", "pay_type", None),
    ("F6", "in hand 25k, gross 30k", "pay_range", "pay_type", None),
    ("F6", "gross salary 30k, in hand 25k", "pay_range", "pay_type", None),
    ("F6", "CTC 3 lakh, take home 22k", "pay_range", "pay_type", None),
    ("F6", "gross 30k, in hand 25k", "pay_type", "pay_type", None),
    (
        "F9",
        "Need 2 fitters good in hand tools, salary 18k, Pune",
        "role_title",
        "pay_type",
        None,
    ),
    ("F9", "Need 2 fitters good in hand tools, salary 18k, Pune", None, "pay_type", None),
    (
        "F9",
        "should know hand grinding, in hand work, salary 15k",
        "skills",
        "pay_type",
        None,
    ),
    ("F9", "fitter with in-hand tools skill, 20k pm", "role_title", "pay_type", None),
    ("F9", "18k, not CTC", "pay_range", "pay_type", None),
    ("F9", "Not CTC", "pay_type", "pay_type", None),
    ("F9", "No CTC, straight salary", "pay_type", "pay_type", None),
    ("F9", "not in hand, it is CTC", "pay_type", "pay_type", None),
    ("F9", "not net, gross", "pay_type", "pay_type", None),
    ("REJ", "20-25k gross", "pay_range", "pay_type", None),
    ("REJ", "25k net", "pay_range", "pay_type", None),
    ("REJ", "25000 gross", "pay_range", "pay_type", None),
    ("REJ", "20-25k gross pay", "pay_range", "pay_type", "gross"),
    ("REJ", "25k take home", "pay_range", "pay_type", "in_hand"),
    ("REJ", "25k net salary", "pay_range", "pay_type", "in_hand"),
    ("REJ", "20-25k CTC", "pay_range", "pay_type", "ctc"),
    ("REJ", "gross", "pay_type", "pay_type", "gross"),
    ("REJ", "net", "pay_type", "pay_type", "in_hand"),
    ("REJ", "25k, net banking se payment", "pay_range", "pay_type", None),
    ("REJ", "20k, payment net banking me", "pay_range", "pay_type", None),
    ("R30", "Need 5 welders, night allowance 2000 in hand", "role_title", "pay_type", None),
    ("R30", "5 welders, 2000 OT in hand", "role_title", "pay_type", None),
    ("R30", "CNC operator, attendance bonus 1500 in hand", "role_title", "pay_type", None),
    ("R30", "welding, grinding, 2000 incentive in hand", "skills", "pay_type", None),
    ("R30", "5, 2000 joining bonus in hand", "vacancy", "pay_type", None),
    ("R30", "Chakan, 1500 travel allowance in hand", "location_label", "pay_type", None),
    ("R30", "PF, ESI, Diwali bonus 5000 in hand", "benefits", "pay_type", None),
    ("R30", "night shift, 2000 extra in hand", "shift", "pay_type", None),
    ("R30", "orders in hand for 2025", "description", "pay_type", None),
    ("R30", "we have orders in hand worth 5000 units", "description", "pay_type", None),
    ("R30", "We have orders in hand till 2026", "description", "pay_type", None),
    ("R30", "orders in hand worth 50 lakh", "description", "pay_type", None),
    (
        "R30",
        "Auto parts maker, 200 workers, orders in hand for 2026",
        "description",
        "pay_type",
        None,
    ),
    ("R30", "PF ESI canteen, 2000 incentive in hand", "benefits", "pay_type", None),
    ("R30", "12 hours duty, OT 1500 in hand", "shift", "pay_type", None),
    ("R30", "in hand 25000", "pay_range", "pay_type", "in_hand"),
    ("R30", "Rs 22,000 in hand", "pay_range", "pay_type", "in_hand"),
    ("R30", "we need 5 welders, 20-25k in hand", "role_title", "pay_type", "in_hand"),
    ("R30", "20-25k in hand", "pay_range", "pay_type", "in_hand"),
    ("R30", "Welder, 18000 in hand", "role_title", "pay_type", None),
    ("R30", "Need 5 welders, night allowance Rs 2000 in hand", "role_title", "pay_range", None),
    ("R31", "in hand 18k", "pay_type", "pay_type", None),
    ("R31", "In hand, around 18k after PF", "pay_type", "pay_type", None),
    ("R31", "in hand 21k", "pay_type", "pay_type", None),
    ("R31", "21k in hand", "pay_type", "pay_type", None),
    ("R31", "in hand 20-25k", "pay_type", "pay_type", None),
    ("R31", "22k in hand", "pay_type", "pay_type", None),
    ("R31", "In-hand", "pay_type", "pay_type", "in_hand"),
    ("R31", "Gross", "pay_type", "pay_type", "gross"),
    ("R32", "take home nahi", "pay_type", "pay_type", None),
    ("R32", "take-home nahi hai", "pay_type", "pay_type", None),
    ("R32", "net nahi", "pay_type", "pay_type", None),
    ("R32", "haath mein nahi", "pay_type", "pay_type", None),
    ("R32", "haath me nahi milega", "pay_type", "pay_type", None),
    ("R32", "in hand nhi", "pay_type", "pay_type", None),
    ("R32", "not exactly in hand", "pay_type", "pay_type", None),
    ("R32", "CTC nhi", "pay_type", "pay_type", None),
    ("R32", "CTC nai", "pay_type", "pay_type", None),
    ("R32", "isn't CTC", "pay_type", "pay_type", None),
    ("R32", "not a CTC", "pay_type", "pay_type", None),
    ("R32", "not on CTC basis", "pay_type", "pay_type", None),
    ("R32", "not the CTC", "pay_type", "pay_type", None),
    ("R32", "never CTC", "pay_type", "pay_type", None),
    ("R32", "not cost to company", "pay_type", "pay_type", None),
    ("R32", "CTC wala nahi", "pay_type", "pay_type", None),
    ("R32", "gross nhi", "pay_type", "pay_type", None),
    ("R32", "20k take home nahi", "pay_range", "pay_type", None),
    ("R32", "20k, CTC nhi", "pay_range", "pay_type", None),
    ("R32", "20k isn't CTC", "pay_range", "pay_type", None),
    ("R32", "20k, not on CTC", "pay_range", "pay_type", None),
    ("R32", "ctc nahi", "pay_type", "pay_type", None),
    ("R32", "in hand nahi", "pay_type", "pay_type", None),
    ("R32", "gross nahi", "pay_type", "pay_type", None),
    ("R32", "no CTC, straight salary", "pay_type", "pay_type", None),
    ("R32", "ctc nhi, in hand", "pay_type", "pay_type", None),
    ("R32", "20k not CTC", "pay_range", "pay_type", None),
    ("R32", "20k ctc nahi", "pay_range", "pay_type", None),
    ("R32", "CTC nahi haath me", "pay_type", "pay_type", None),
    ("R32", "20k in hand no deductions", "pay_range", "pay_type", None),
    ("R33", "20k, in hand", "pay_range", "pay_type", "in_hand"),
    ("R33", "20-25k, in hand", "pay_range", "pay_type", "in_hand"),
    ("R33", "Rs 20,000 per month, in hand", "pay_range", "pay_type", "in_hand"),
    ("R33", "20k per month, take home", "pay_range", "pay_type", "in_hand"),
    ("R33", "25k. In hand.", "pay_range", "pay_type", None),
    ("R33", "20k, haath mein nahi", "pay_range", "pay_type", None),
    ("R33", "20000, in hand", "pay_range", "pay_type", "in_hand"),
    ("R33", "18k-20k, in hand", "pay_range", "pay_type", "in_hand"),
    ("R33", "salary 18000, in hand", "pay_range", "pay_type", "in_hand"),
    ("R33", "Salary 15k. In hand", "pay_range", "pay_type", None),
    ("R33", "15000, in hand, PF ESI extra", "pay_range", "pay_type", None),
    ("R33", "In hand, 20k", "pay_range", "pay_type", None),
    ("R33", "Takehome, 22k", "pay_range", "pay_type", None),
    ("R33", "20000, CTC", "pay_range", "pay_type", "ctc"),
    ("R33", "20k, gross salary", "pay_range", "pay_type", "gross"),
    ("R33", "20k, net salary", "pay_range", "pay_type", "in_hand"),
    ("R33", "20k, cost to company", "pay_range", "pay_type", "ctc"),
    ("R33", "20k, expert in hand fabrication", "pay_range", "pay_type", None),
    (
        "R33",
        "20k, candidate must be expert in hand fabrication",
        "pay_range",
        "pay_type",
        None,
    ),
    ("R33", "20k, should be good in hand welding", "pay_range", "pay_type", None),
    ("R33", "20k, work is in hand held grinder", "pay_range", "pay_type", None),
    ("R33", "20k, work in hand", "pay_range", "pay_type", None),
    ("R33", "haath mein nahi milega", "pay_type", "pay_type", None),
    ("R33", "net pay nahi", "pay_type", "pay_type", None),
    ("R33", "20k haath mein nahi", "pay_range", "pay_type", None),
    # --- F6 / R31 / R34 / spec F: the pay band itself ------------------------------------
    ("F6", "gross 30k, in hand 25k", "pay_range", "pay_range", None),
    (
        "F6",
        "Salary 20-25k, in hand around 18k after PF",
        "pay_range",
        "pay_range",
        _pay(20000, 25000),
    ),
    ("F6", "25k per month, 21k in hand", "pay_range", "pay_range", None),
    ("F6", "30k, in hand 25k", "pay_range", "pay_range", None),
    ("F6", "in hand 25k, gross 30k", "pay_range", "pay_range", None),
    ("F6", "CTC 3 lakh, take home 22k", "pay_range", "pay_range", None),
    ("R34", "in hand 20k, OT extra 2000", "pay_range", "pay_range", _pay(20000)),
    ("R34", "20k in hand plus 2000 attendance bonus", "pay_range", "pay_range", _pay(20000)),
    ("R34", "25k in hand. Also 5000 bonus", "pay_range", "pay_range", None),
    ("R34", "Established 1998, salary always in hand", "description", "pay_range", None),
    ("R34", "Established 1998, salary always in hand", "description", "pay_type", None),
    ("R34", "15000 + 2000 bonus", "pay_range", "pay_range", _pay(15000)),
    ("R34", "15k + 3k food allowance", "pay_range", "pay_range", _pay(15000)),
    ("R34", "12000 + 1500 HRA", "pay_range", "pay_range", _pay(12000)),
    ("R34", "16000 monthly, diwali bonus 5000", "pay_range", "pay_range", _pay(16000)),
    ("R34", "Salary 15000, since 2005 company", "pay_range", "pay_range", _pay(15000)),
    ("R34", "Company since 2010, salary always in hand", "description", "pay_range", None),
    ("R34", "Company since 2010, salary always in hand", "description", "pay_type", None),
    ("R34", "min 15000 max 20000", "pay_range", "pay_range", _pay(15000, 20000)),
    ("R34", "15000 minimum, up to 20000", "pay_range", "pay_range", _pay(15000, 20000)),
    ("R34", "fresher 12000, experienced 18000", "pay_range", "pay_range", _pay(12000, 18000)),
    (
        "R34",
        "15000 or 18000 depending on experience",
        "pay_range",
        "pay_range",
        _pay(15000, 18000),
    ),
    ("R29", "20000-25000", "pay_range", "pay_range", _pay(20000, 25000)),
    ("spec-F", "Salary 20k + 2k bonus", "pay_range", "pay_range", _pay(20000)),
    ("spec-F", "20-25k in hand, OT extra 3000", "pay_range", "pay_range", _pay(20000, 25000)),
    # --- F7 / STILL-OPEN F7 / R8 / R16-R18: a unit-bearing window is not a head count ---
    ("F7", "Welder, need 2-5 years experience", "role_title", "vacancy", None),
    ("F7", "Welder, need 2-5 years experience", "role_title", "experience", _exp(2, 5)),
    ("F7", "Welder (need 6-10 years exp)", "role_title", "vacancy", None),
    ("F7", "Welder (need 6-10 years exp)", "role_title", "experience", None),
    ("F7", "require 3-4 years experience", "requirements", "vacancy", None),
    ("F7", "require 3-4 years experience", "requirements", "experience", _exp(3, 4)),
    ("F7", "ITI pass, require 2 to 5 years experience", "requirements", "vacancy", None),
    (
        "F7",
        "ITI pass, require 2 to 5 years experience",
        "requirements",
        "experience",
        _exp(2, 5),
    ),
    ("F7", "looking for 2-5 years experience", "requirements", "vacancy", None),
    ("F7", "looking for 2-5 years experience", "requirements", "experience", _exp(2, 5)),
    ("F7", "hiring 2-5 yrs experienced fitters", "role_title", "vacancy", None),
    ("F7", "hiring 2-5 yrs experienced fitters", "role_title", "experience", None),
    ("F7", "CNC operator need 1-2 years exp", "role_title", "vacancy", None),
    ("F7", "need 6-10 years", "role_title", "vacancy", None),
    ("F7", "need 6-10 years", "role_title", "experience", None),
    ("F7+", "Welder, need 10-15 years experience", "role_title", "vacancy", None),
    ("F7+", "require 12-15 yrs experience", "requirements", "vacancy", None),
    ("F7+", "Senior fitter, need 15-20 years experience", "role_title", "vacancy", None),
    ("F7+", "Welder, need 5+ years experience", "role_title", "vacancy", None),
    ("F7+", "Welder, need 5+ years experience", "role_title", "experience", _exp(5, None)),
    ("F7+", "we need 2-5 welders", "role_title", "vacancy", "2-5"),
    ("F7+", "need 2 to 5 welders", "role_title", "vacancy", "2-5"),
    ("F7+", "need 6-10 fitters", "role_title", "vacancy", "6-10"),
    ("R8", "Supervisor, need 10-15 years experience", "role_title", "vacancy", None),
    ("R8", "Supervisor, need 12 to 15 years experience", "role_title", "vacancy", None),
    ("R8", "Manager, require 15-20 years experience", "role_title", "vacancy", None),
    ("R8", "need 10 se 15 saal experience", "requirements", "vacancy", None),
    ("R8", "need 10 se 15 saal experience", "role_title", "vacancy", None),
    ("R8", "need 10 to 12 years experience", "role_title", "vacancy", None),
    ("R8", "Experienced male candidates 25-35 yrs", "role_title", "vacancy", None),
    ("R8", "need 10 years experience", "role_title", "vacancy", None),
    ("R8", "need 12 years experienced supervisor", "role_title", "vacancy", None),
    ("R8", "require 15 yrs exp", "role_title", "vacancy", None),
    ("R8", "need 15 years exp in fabrication", "role_title", "vacancy", None),
    ("R8", "hiring 10 yrs experienced CNC setter", "role_title", "vacancy", None),
    ("R8", "need 10 months experience", "role_title", "vacancy", None),
    ("R8", "hiring 12 hour shift operators", "role_title", "vacancy", None),
    ("R8", "need 12 hrs duty helpers", "role_title", "vacancy", None),
    ("R8", "Salary 25k, need 12 hour shift", "pay_range", "vacancy", None),
    ("R8", "need 12 hours duty, 8am to 8pm", "shift", "vacancy", None),
    ("R8", "need 18 years age minimum", "role_title", "vacancy", None),
    ("R8", "Helper, need 15k salary", "role_title", "vacancy", None),
    ("R8", "need 18k in hand", "role_title", "vacancy", None),
    ("R8", "need 12k-15k salary", "role_title", "vacancy", None),
    ("R8", "need 3 years experience", "role_title", "vacancy", None),
    ("R8", "need 10-15 welders", "role_title", "vacancy", "6-10"),
    ("R8", "need 12 people", "role_title", "vacancy", "11-25"),
    ("R8", "need 25 welders", "role_title", "vacancy", "11-25"),
    ("R8", "hiring 20 helpers", "role_title", "vacancy", "11-25"),
    ("R8", "need 100 packers", "role_title", "vacancy", "25+"),
    ("R8", "openings: 12", "role_title", "vacancy", "11-25"),
    ("R8", "need 10 fitters with 2 years experience", "role_title", "vacancy", "6-10"),
    ("R8", "1", "vacancy", "vacancy", "1"),
    ("R8", "5", "vacancy", "vacancy", "2-5"),
    ("R8", "10", "vacancy", "vacancy", "6-10"),
    ("R8", "12", "vacancy", "vacancy", "11-25"),
    ("R8", "25", "vacancy", "vacancy", "11-25"),
    ("R8", "25+", "vacancy", "vacancy", "25+"),
    ("R8", "50", "vacancy", "vacancy", "25+"),
    ("R8", "100", "vacancy", "vacancy", "25+"),
    ("R8", "999", "vacancy", "vacancy", "25+"),
    ("R8", "1000", "vacancy", "vacancy", "25+"),
    ("R8", "5 se 10", "vacancy", "vacancy", "2-5"),
    ("R8", "10-15", "vacancy", "vacancy", "6-10"),
    ("R8", "10 to 15", "vacancy", "vacancy", "6-10"),
    ("R8", "12 log", "vacancy", "vacancy", "11-25"),
    ("R8", "15 welders", "vacancy", "vacancy", "11-25"),
    ("R8", "about 20", "vacancy", "vacancy", "11-25"),
    ("R8", "around 30 people", "vacancy", "vacancy", "25+"),
    ("R8", "ek", "vacancy", "vacancy", "1"),
    ("R8", "two", "vacancy", "vacancy", "2-5"),
    ("R8", "Helper, need 10th pass", "role_title", "vacancy", None),
    ("R8", "need 12th pass", "role_title", "vacancy", None),
    ("R8", "need 10+ years experience", "role_title", "vacancy", None),
    ("R8", "need 18+ age", "role_title", "vacancy", None),
    ("R8", "require 20 kg lifting", "role_title", "vacancy", None),
    ("R8", "Welder, need 25 to 35 age", "role_title", "vacancy", None),
    ("R8", "need 10-12 hour shift", "role_title", "vacancy", None),
    ("R8", "10,000", "vacancy", "vacancy", None),
    ("R16", "hiring 10 to 15 years experienced supervisors", "role_title", "vacancy", None),
    ("R16", "require 11-25 years", "requirements", "vacancy", None),
    ("R16", "need 20 years", "role_title", "vacancy", None),
    ("R16", "need 15 days", "needed_by", "vacancy", None),
    ("R16", "need 15 days", "needed_by", "needed_by", "soon"),
    ("R16", "10 years", "vacancy", "vacancy", None),
    ("R16", "10-15 years", "vacancy", "vacancy", None),
    ("R16", "need 12 hours shift", "shift", "vacancy", None),
    ("R16", "need 15k salary", "role_title", "vacancy", None),
    ("R16", "need 10 days", "needed_by", "vacancy", None),
    ("R16", "need 20 days", "needed_by", "vacancy", None),
    ("R16", "need 30 days", "needed_by", "vacancy", None),
    ("R16", "need 15 din me", "needed_by", "vacancy", None),
    ("R16", "need 10 din", "needed_by", "vacancy", None),
    ("R16", "need 10 din", "needed_by", "needed_by", "soon"),
    ("R16", "need 2 hafte me", "needed_by", "vacancy", None),
    ("R16", "Need 10-15 days", "needed_by", "vacancy", None),
    ("R16", "Need 10-15 days", "needed_by", "needed_by", "soon"),
    ("R16", "need 25 workers", "role_title", "vacancy", "11-25"),
    ("R16", "need 10 workers", "role_title", "vacancy", "6-10"),
    ("R16", "need 12 welders", "role_title", "vacancy", "11-25"),
    ("R17", "need 3+ years experience", "role_title", "vacancy", None),
    ("R17", "require 2+ yrs exp", "requirements", "vacancy", None),
    ("R17", "hiring 5+ yrs exp welders", "role_title", "vacancy", None),
    ("R17", "need 2 plus years experience", "role_title", "vacancy", None),
    ("R17", "need 2 or 3 years experience", "role_title", "vacancy", None),
    ("R17", "need 2 or 3 years experience", "role_title", "experience", None),
    ("R17", "need 25+ years exp", "role_title", "vacancy", None),
    ("R17", "CNC operator, need 3+ yrs experience", "role_title", "vacancy", None),
    ("R17", "MIG welding, need 3+ years exp", "skills", "vacancy", None),
    ("R17", "Pune, need 5+ years experience", "location_label", "vacancy", None),
    ("R17", "20k, need 5+ yrs exp", "pay_range", "vacancy", None),
    ("R17", "urgent, need 3+ years exp", "needed_by", "vacancy", None),
    ("R17", "urgent, need 3+ years exp", "needed_by", "needed_by", None),
    ("R17", "need 5+ saal experience", "role_title", "vacancy", None),
    ("R17", "need 2 or more years experience", "role_title", "vacancy", None),
    ("R17", "require 1 or 2 years exp", "role_title", "vacancy", None),
    ("R17", "Welder, need 12 years experience", "role_title", "vacancy", None),
    ("R17", "Supervisor, require 15 yrs exp", "role_title", "vacancy", None),
    ("R17", "Helper, need 12 hours duty", "role_title", "vacancy", None),
    ("R17", "Driver, need 12 hrs shift", "role_title", "vacancy", None),
    ("R17", "18000, need 15 days joining", "pay_range", "vacancy", None),
    ("R17", "need 25 years exp", "role_title", "vacancy", None),
    ("R17", "need 10+ years exp", "role_title", "vacancy", None),
    ("R17", "hiring 5+ welders", "role_title", "vacancy", "2-5"),
    ("R17", "need 10+ welders", "role_title", "vacancy", "6-10"),
    ("R17", "hiring 10 welders", "role_title", "vacancy", "6-10"),
    (
        "R17",
        "Welder, need 5 years experience",
        "role_title",
        "role_title",
        "Welder, need 5 years experience",
    ),
    ("R18", "need 2-5 hrs overtime", "shift", "vacancy", None),
    ("R18", "need 2-5 weeks training", "requirements", "vacancy", None),
    ("R18", "need 2-5 days", "needed_by", "vacancy", None),
    ("R18", "need 2-5 days", "needed_by", "needed_by", "soon"),
    ("R18", "need 2-5 km", "location_label", "vacancy", None),
    ("R18", "need 2-5 lakh", "pay_range", "vacancy", None),
    ("R18", "need 2-5 exp", "requirements", "vacancy", None),
    ("R18", "need 20-25k salary", "pay_range", "vacancy", None),
    ("R18", "need 20-25k salary", "pay_range", "pay_range", _pay(20000, 25000)),
    ("R18", "need 8-12 hours duty", "role_title", "vacancy", None),
    ("R18", "require 7-10 days joining", "role_title", "vacancy", None),
    ("R18", "need 1-2 weeks", "role_title", "vacancy", None),
    ("R18", "need 12-15 hazar", "role_title", "vacancy", None),
    ("R18", "need 8-12 ghante", "role_title", "vacancy", None),
    ("R18", "need 2-3 hafte me", "role_title", "vacancy", None),
    ("R18", "CNC Operator, need 10-12 hrs duty", "role_title", "vacancy", None),
    ("R18", "actually day shift, need 10-12 hrs duty", "shift", "vacancy", None),
    ("R18", "sorry, need 20-25k salary", "pay_range", "vacancy", None),
    ("R18", "Welder, need 10 years experience", "role_title", "vacancy", None),
    ("R18", "require 10 years experience", "role_title", "vacancy", None),
    ("R18", "need 12 hours duty", "role_title", "vacancy", None),
    ("R18", "need 15 days", "role_title", "vacancy", None),
    ("R18", "need 18,000 salary", "role_title", "vacancy", None),
    ("R18", "need 1.5 lakh ctc", "role_title", "vacancy", None),
    ("R18", "Security guard, need 12 hours duty", "role_title", "vacancy", None),
    ("R18", "require 15-18k per month", "role_title", "vacancy", None),
    ("R18", "general shift, need 10-12 hours", "role_title", "vacancy", None),
    ("R18", "hiring 15 helpers", "role_title", "vacancy", "11-25"),
    ("R18", "15 openings", "role_title", "vacancy", "11-25"),
    ("R18", "need 2-5 experienced welders", "role_title", "vacancy", "2-5"),
    # --- R0 / R1 / R2 / R4-R7: experience ----------------------------------------------
    ("R0", "not less than 2 years", "experience", "experience", None),
    ("R0", "Not less than 3 years experience", "experience", "experience", None),
    ("R0", "no less than 3 years", "experience", "experience", None),
    ("R0", "not below 2 years", "experience", "experience", None),
    ("R0", "not under 2 years", "experience", "experience", None),
    ("R0", "3 saal se kam nahi", "experience", "experience", None),
    ("R0", "3 saal se kam nahi chahiye", "experience", "experience", None),
    ("R0", "3 years se kam nahi", "experience", "experience", None),
    ("R0", "experience should not be less than 3 years", "experience", "experience", None),
    ("R0", "should not have less than 3 years", "experience", "experience", None),
    ("R0", "Not less than 3 yrs exp", "experience", "experience", None),
    ("R0", "CNC operator, not less than 3 years experience", "role_title", "experience", None),
    ("R0", "ITI, not less than 2 years experience", "requirements", "experience", None),
    ("R0", "ITI, experience not below 2 years", "requirements", "experience", None),
    (
        "R0",
        "ITI pass, experience should not be less than 2 years",
        "requirements",
        "experience",
        None,
    ),
    ("R0", "welding, not less than 2 years experience", "skills", "experience", None),
    ("R0", "20k, not less than 3 years experience", "pay_range", "experience", None),
    ("R0", "not above 3 years", "experience", "experience", None),
    ("R0", "not over 5 years", "experience", "experience", None),
    ("R0", "3 saal se zyada nahi", "experience", "experience", None),
    ("R0", "experience not exceeding 5 years", "experience", "experience", None),
    (
        "R0",
        "not less than 2 years and not more than 5 years",
        "experience",
        "experience",
        None,
    ),
    ("R1", "not over 2 years", "experience", "experience", None),
    ("R1", "not exceeding 3 years", "experience", "experience", None),
    ("R1", "should not exceed 3 years", "experience", "experience", None),
    ("R1", "experience should not be more than 3 years", "experience", "experience", None),
    ("R1", "not more then 3 years", "experience", "experience", None),
    ("R1", "2 saal se zyada nahi", "experience", "experience", None),
    ("R1", "3 years se upar nahi", "experience", "experience", None),
    ("R1", "less then 2 years", "experience", "experience", None),
    ("R1", "Up-to 2 years", "experience", "experience", None),
    ("R1", "3 years or below", "experience", "experience", None),
    ("R1", "3 yrs & below", "experience", "experience", None),
    ("R1", "2 years below", "experience", "experience", None),
    ("R1", "2 yrs or under", "experience", "experience", None),
    ("R1", "2 years or lesser", "experience", "experience", None),
    ("R1", "<2 yrs", "experience", "experience", None),
    ("R1", "< 2 years", "experience", "experience", None),
    ("R1", "2 saal ya usse kam", "experience", "experience", None),
    ("R1", "3 saal ke andar", "experience", "experience", None),
    ("R1", "3 saal se neeche", "experience", "experience", None),
    ("R1", "2 years se kum", "experience", "experience", None),
    ("R1", "ITI, experience 2 saal se zyada nahi", "requirements", "experience", None),
    ("R1", "ITI, experience up-to 2 years", "requirements", "experience", None),
    ("R1", "ITI, experience 3 years or below", "requirements", "experience", None),
    ("R1", "Welder with less then 2 years experience", "role_title", "experience", None),
    ("R1", "2 saal se kam nahi", "experience", "experience", None),
    ("R1", "experience not below 2 years", "experience", "experience", None),
    ("R1", "not under 3 years", "experience", "experience", None),
    ("R2", "6 months to 1 year", "experience", "experience", None),
    ("R2", "6 month to 1 year experience", "experience", "experience", None),
    ("R2", "6 mahine se 1 saal", "experience", "experience", None),
    ("R2", "3 months to 1 yr", "experience", "experience", None),
    ("R2", "6 months - 1 yr exp", "experience", "experience", None),
    ("R2", "6 months - 2 years", "experience", "experience", None),
    ("R2", "6 months to 2 years experience", "experience", "experience", None),
    ("R2", "6 months se 2 saal", "experience", "experience", None),
    ("R2", "1.5-3 years", "experience", "experience", None),
    ("R2", "1.5 to 3 years", "experience", "experience", None),
    ("R2", "1.5 years to 3 years", "experience", "experience", None),
    ("R2", "0.5 to 2 years", "experience", "experience", None),
    ("R2", "1-3 years", "experience", "experience", _exp(1, 3)),
    ("R2", "6 months", "experience", "experience", None),
    ("R2", "1.5 years", "experience", "experience", None),
    ("R2", "6-12 months", "experience", "experience", None),
    ("R2", "ITI, 6 months to 1 year experience", "requirements", "experience", None),
    ("R2", "ITI, 1.5-3 years experience", "requirements", "experience", None),
    ("R2", "welding, 6 months to 1 year experience", "skills", "experience", None),
    ("R2", "Helper with 6 months to 1 year experience", "role_title", "experience", None),
    ("R2", "fresher or 6 months to 1 year", "experience", "experience", None),
    ("R2", "1 year or 6 months", "experience", "experience", None),
    ("R2", "1 year 6 months", "experience", "experience", None),
    ("R2", "0-1 year", "experience", "experience", _exp(0, 1)),
    ("R2", "2 years", "experience", "experience", _exp(2, None)),
    ("R2", "3 to 5 years, 12.5k salary", "experience", "experience", None),
    (
        "R4",
        "We are a leading company with 25 years of experience, hiring CNC operators",
        "role_title",
        "experience",
        None,
    ),
    (
        "R4",
        "Leading forging company with 30 years experience, need 5 operators",
        "role_title",
        "experience",
        None,
    ),
    (
        "R4",
        "We are a leading auto parts manufacturer with 25+ years of experience, need 10 welders",
        "role_title",
        "experience",
        None,
    ),
    (
        "R4",
        "Auto component manufacturer having 30 years experience, need CNC operators",
        "role_title",
        "experience",
        None,
    ),
    (
        "R4",
        "ABC Forgings has 30 years of experience, need 5 operators",
        "role_title",
        "experience",
        None,
    ),
    (
        "R4",
        "The company has 25 years experience in forging, need fitters",
        "role_title",
        "experience",
        None,
    ),
    (
        "R4",
        "Humari company ko 25 saal ka experience hai, 5 operator chahiye",
        "role_title",
        "experience",
        None,
    ),
    (
        "R4",
        "Hamara 20 saal ka experience hai forging mein, 5 operator chahiye",
        "role_title",
        "experience",
        None,
    ),
    (
        "R4",
        "25+ years experience in manufacturing, hiring CNC operators",
        "role_title",
        "experience",
        None,
    ),
    ("R4", "Company having 30 years experience", "requirements", "experience", None),
    (
        "R4",
        "Established in 1995, 28 years experience, need welders",
        "role_title",
        "experience",
        None,
    ),
    (
        "R4",
        "20 years experience in the industry, need CNC operators",
        "role_title",
        "experience",
        None,
    ),
    (
        "R4",
        "Reputed firm with 30 yrs experience, hiring fitters",
        "role_title",
        "experience",
        None,
    ),
    (
        "R4",
        "Our 25 years experience in forging, need operators",
        "role_title",
        "experience",
        None,
    ),
    (
        "R4",
        "We are ISO certified with 25 years experience, need CNC operators",
        "role_title",
        "experience",
        None,
    ),
    ("R4", "forging, our team has 30 years experience", "skills", "experience", None),
    ("R4", "5 operators, company having 20 years experience", "vacancy", "experience", None),
    (
        "R4",
        "Chakan Pune, company with 25 years of experience",
        "location_label",
        "experience",
        None,
    ),
    ("R4", "Need CNC operator having 3 years experience", "role_title", "experience", None),
    ("R4", "candidates having 2-3 years experience", "experience", "experience", None),
    ("R4", "Hamare yahan 3 saal experience wale chahiye", "experience", "experience", None),
    (
        "R4",
        "We are a forging company, need CNC operators with 3 years experience",
        "role_title",
        "experience",
        None,
    ),
    (
        "R4",
        "Operators with 3 years experience in a reputed company",
        "role_title",
        "experience",
        None,
    ),
    ("R4", "Company with 25 years experience, need 2 years", "experience", "experience", None),
    (
        "R4",
        "Humari company ko 25 saal ka experience hai, 2 saal chahiye",
        "experience",
        "experience",
        None,
    ),
    ("R5", "Experienced male candidates 25-35 yrs", "role_title", "experience", None),
    ("R5", "Experienced male candidates 25-35 yrs", None, "experience", None),
    ("R5", "Experienced candidates between 25-35 years", "role_title", "experience", None),
    ("R5", "Experienced candidates between 20-30 years", "requirements", "experience", None),
    ("R5", "Male, 20-35 yrs, experienced", "experience", "experience", None),
    (
        "R5",
        "Need 5 CNC operators, experienced male candidates 22-35 yrs",
        "role_title",
        "experience",
        None,
    ),
    ("R5", "ITI, experienced male candidates 20-35 yrs", "requirements", "experience", None),
    (
        "R5",
        "ITI pass, experienced candidates 18-30 yrs only",
        "requirements",
        "experience",
        None,
    ),
    ("R5", "Male 20-35 yrs", "experience", "experience", None),
    ("R5", "2 years experience 20-35 yrs", "experience", "experience", None),
    ("R5", "2 years experience and below 35", "experience", "experience", None),
    ("R5", "2 years exp and below 35 yrs", "experience", "experience", None),
    ("R5", "2 years experience below 35", "experience", "experience", None),
    ("R5", "3 years, below 30", "experience", "experience", None),
    ("R5", "3 yrs, under 30", "experience", "experience", None),
    ("R5", "minimum 2 years, below 35", "experience", "experience", None),
    ("R5", "2 years experience, below 35", "experience", "experience", None),
    ("R5", "1 year, upto 35", "experience", "experience", None),
    ("R6", "Need experienced welders for 1 year contract", "role_title", "experience", None),
    (
        "R6",
        "Experienced welders required for 2 years project",
        "role_title",
        "experience",
        None,
    ),
    ("R6", "experienced fitter 2 year bond", "role_title", "experience", None),
    ("R6", "3 year diploma and experienced in CNC", "requirements", "experience", None),
    ("R6", "Diploma 3 years and experience in VMC", "requirements", "experience", None),
    ("R6", "PF, ESI, increment after 1 year of experience", "benefits", "experience", None),
    ("R6", "bonus after 2 years experience", "benefits", "experience", None),
    ("R6", "experienced, 1 year bond", "experience", "experience", None),
    ("R6", "experienced candidates only 1 year contract", "role_title", "experience", None),
    (
        "R6",
        "Need experienced helper on 1 year contract basis",
        "role_title",
        "experience",
        None,
    ),
    (
        "R6",
        "15000-18000, experienced person 2 year agreement",
        "pay_range",
        "experience",
        None,
    ),
    ("R6", "experienced chahiye, 2 saal ka bond", "experience", "experience", None),
    ("R6", "1 year contract", "experience", "experience", None),
    ("R6", "experienced candidates only, 1 year contract", "role_title", "experience", None),
    (
        "R6",
        "Experienced CNC operator needed, 11 month contract",
        "role_title",
        "experience",
        None,
    ),
    ("R6", "2 years experience after diploma", "experience", "experience", None),
    ("R6", "2 years experience after ITI", "requirements", "experience", None),
    ("R6", "3 years experience in project site", "experience", "experience", None),
    ("R7", "Minimum experience 2 years", "experience", "experience", _exp(2, None)),
    ("R7", "Min. Exp: 2 yrs", "experience", "experience", None),
    ("R7", "Min exp 2 yrs", "experience", "experience", None),
    ("R7", "Minimum Experience - 3 Years", "experience", "experience", _exp(3, None)),
    ("R7", "Minimum experience required 3 years", "experience", "experience", None),
    ("R7", "2 years minimum", "experience", "experience", _exp(2, None)),
    ("R7", "2 years min", "experience", "experience", _exp(2, None)),
    ("R7", "3 years at least", "experience", "experience", None),
    ("R7", "2 yrs - 5 yrs", "experience", "experience", None),
    ("R7", "2 years to 5 years", "experience", "experience", None),
    ("R7", "minimum 2-3 years", "experience", "experience", None),
    ("R7", "2-5 years max", "experience", "experience", None),
    ("R7", "Experience 3 yrs. Age below 35.", "experience", "experience", None),
    ("R7", "ITI+Diploma, 2 years experience", "experience", "experience", None),
    ("R7", "Fresher nahi, 2 saal minimum", "experience", "experience", None),
    ("R7", "we have requirement of 2 years experience", "experience", "experience", None),
    ("R7", "should be working since 2 years in CNC", "experience", "experience", None),
    ("R7", "2 years experience in the market", "experience", "experience", None),
    ("R7", "2 yrs to 5 yrs", "experience", "experience", None),
    ("R7", "2 years to 5 years experience", "experience", "experience", None),
    ("R7", "10th+ITI, 2 years", "experience", "experience", None),
    ("R7", "ITI + Diploma, 2 years experience", "experience", "experience", None),
    ("R7", "ITI, min exp 2 yrs", "requirements", "experience", None),
    (
        "R7",
        "ITI pass, minimum experience 2 years",
        "requirements",
        "experience",
        _exp(2, None),
    ),
    ("R7", "Experience 2 yrs. Age 20-35 yrs.", "requirements", "experience", None),
    ("R7", "minimum 2 years", "experience", "experience", _exp(2, None)),
    ("R7", "minimum 2 to 3 years", "experience", "experience", None),
    ("R7", "up to 2-5 years", "experience", "experience", None),
    ("R7", "3 years at most", "experience", "experience", None),
    # --- F8 / R19 / R20: brackets and caps (label topics) ------------------------------
    ("F8", "[PF, ESI]", "benefits", "benefits", ["PF", "ESI"]),
    ("F8", "[TIG, MIG]", "skills", "skills", ["TIG", "MIG"]),
    ("F8", "[ITI], [10th pass]", "requirements", "requirements", ["ITI", "10th pass"]),
    ("F8", "[Pune]", "location_label", "location_label", "Pune"),
    ("F8", "[Pune]", "location_label", "city", "Pune"),
    ("F8", "[CNC Operator]", "role_title", "role_title", "CNC Operator"),
    ("F8", "[Chakan]", "city", "city", None),
    ("R19", "Welder [TIG]", "role_title", "role_title", "Welder TIG"),
    ("R19", "PF, ESI [optional]", "benefits", "benefits", ["PF", "ESI optional"]),
    ("R19", "CNC Operator [Fanuc]", "role_title", "role_title", "CNC Operator Fanuc"),
    ("R19", "TIG welding [must], MIG", "skills", "skills", ["TIG welding must", "MIG"]),
    ("R19", "PF [12%], ESI", "benefits", "benefits", ["PF 12%", "ESI"]),
    ("R19", "Pune [Chakan MIDC]", "location_label", "location_label", "Pune Chakan MIDC"),
    ("R19", "Fitter (ITI)", "role_title", "role_title", "Fitter ITI"),
    (
        "R19",
        "Helper (loading unloading)",
        "role_title",
        "role_title",
        "Helper loading unloading",
    ),
    ("R19", "PF (12%), ESI", "benefits", "benefits", ["PF 12%", "ESI"]),
    ("R19", "PF, ESI, canteen (free)", "benefits", "benefits", ["PF", "ESI", "canteen free"]),
    ("R19", "Welding (TIG), grinding", "skills", "skills", ["Welding TIG", "grinding"]),
    ("R19", "Chakan (Pune)", "location_label", "location_label", "Chakan Pune"),
    ("R19", "{TIG}", "skills", "skills", ["TIG"]),
    ("R19", "[PERSON_1], Chakan", "location_label", "location_label", None),
    ("R19", "Helper [PERSON_1]", "role_title", "role_title", None),
    ("R20", "x" * 75 + " [PERSON_1] lorem", "benefits", "benefits", ["x" * 75]),
    # --- spec D: the required city rulings -----------------------------------------------
    ("spec-D", "Navi Mumbai", "location_label", "city", "Navi Mumbai"),
    ("spec-D", "Bombay", "location_label", "city", "Mumbai"),
    ("spec-D", "Hosur, Bangalore", "location_label", "city", None),
    ("spec-D", "Old Delhi Road", "city", "city", None),
    ("spec-D", "Maharashtra", "city", "city", None),
    # --- spec E: the required vacancy rulings --------------------------------------------
    ("spec-E", "need 10-15 years experience", "role_title", "vacancy", None),
    ("spec-E", "need 15-20 years experience", "role_title", "vacancy", None),
    ("spec-E", "need 5+ years experience", "role_title", "vacancy", None),
    ("spec-E", "need 5 plus years", "role_title", "vacancy", None),
    ("spec-E", "need 2-3 hours daily", "role_title", "vacancy", None),
    ("spec-E", "hiring 2 or 3 years exp", "role_title", "vacancy", None),
    ("spec-E", "need 12 fitters", "role_title", "vacancy", "11-25"),
    ("spec-E", "need 10-15 welders", "role_title", "vacancy", "6-10"),
]


def _review_input_id(case: tuple[str, str, str | None, str, object]) -> str:
    ref, text, last_asked, topic, _ = case
    return f"{ref}|{text[:40]}|{last_asked}->{topic}"


@pytest.mark.parametrize(
    ("ref", "text", "last_asked", "topic", "expected"),
    REVIEW_INPUTS,
    ids=[_review_input_id(case) for case in REVIEW_INPUTS],
)
def test_every_review_input_records_the_payer_s_meaning_or_nothing(
    ref: str, text: str, last_asked: str | None, topic: str, expected: object
):
    """The round-3 acceptance criterion, input by input: the value the payer MEANT, or
    nothing. ``.get`` reads an absent topic and an answered-with-nothing topic alike."""
    assert answers.detect_answers(text, last_asked).get(topic) == expected, ref


def test_the_review_table_is_not_vacuous():
    """The table above must actually exercise both sides of the criterion, every topic
    it claims to cover, and both review rounds."""
    values = [case[4] for case in REVIEW_INPUTS]
    assert len(REVIEW_INPUTS) >= 700
    assert sum(value is None for value in values) >= 500
    assert sum(value is not None for value in values) >= 100
    assert {case[3] for case in REVIEW_INPUTS} >= {
        "experience",
        "needed_by",
        "city",
        "pay_type",
        "pay_range",
        "vacancy",
    }
    refs = {case[0] for case in REVIEW_INPUTS}
    # R27 is a wording flow, pinned by its own engine test below.
    assert {f"F{n}" for n in range(16)} | {f"R{n}" for n in range(35) if n != 27} <= refs


# Canonical shapes: the chips and the plain forms MUST parse (spec A/B/C). -------------
@pytest.mark.parametrize(
    ("text", "window"),
    [
        # A — spans, floors, ceilings, bare, fresher, fresher+ceiling, fillers.
        ("2-5 years", (2, 5)),
        ("2 to 5 yrs", (2, 5)),
        ("2 se 5 saal", (2, 5)),
        ("2-5 years experience", (2, 5)),
        ("5+", (5, None)),
        ("5 plus", (5, None)),
        ("5+ years", (5, None)),
        ("5 years+", (5, None)),
        ("5 years or more", (5, None)),
        ("5 years and above", (5, None)),
        ("minimum 3 years", (3, None)),
        ("min 3 yrs", (3, None)),
        ("at least 3 years", (3, None)),
        ("atleast 3 years", (3, None)),
        ("kam se kam 3 saal", (3, None)),
        ("3 years minimum", (3, None)),
        ("up to 3 years", (None, 3)),
        ("upto 3 years", (None, 3)),
        ("max 3 years", (None, 3)),
        ("maximum 3 years", (None, 3)),
        ("at most 3 years", (None, 3)),
        ("less than 3 years", (None, 3)),
        ("under 3 years", (None, 3)),
        ("below 3 years", (None, 3)),
        ("3 years max", (None, 3)),
        ("3 saal tak", (None, 3)),
        ("3 years", (3, None)),
        ("3 sal", (3, None)),
        ("3", (3, None)),
        ("fresher", (0, None)),
        ("freshers ok", (0, None)),
        ("freshers welcome", (0, None)),
        ("fresher chalenge", (0, None)),
        ("no experience", (0, None)),
        ("no experience required", (0, None)),
        ("experience not required", (0, None)),
        ("fresher or up to 2 years", (0, 2)),
        ("freshers to 2 years", (0, 2)),
        ("need 3 years experience", (3, None)),
        ("we need 2-5 years experience", (2, 5)),
        ("required 3+ years", (3, None)),
        ("looking for 3 years experience", (3, None)),
        ("candidates with 3 years experience", (3, None)),
        ("should have 3 years", (3, None)),
        ("must have 3+ years", (3, None)),
        ("minimum experience 2 years", (2, None)),
        ("experience required: 2-5 years", (2, 5)),
        ("exp: 3 years", (3, None)),
        ("3 years of experience required", (3, None)),
        ("3 yrs exp preferred", (3, None)),
        ("3 saal experience chahiye", (3, None)),
        ("3 years experienced", (3, None)),
        ("0-2 years", (0, 2)),
        ("60 years", (60, None)),
    ],
)
def test_every_canonical_experience_shape_parses(text: str, window: tuple):
    detected = answers.detect_answers(text, "experience")["experience"]
    assert (detected["min"], detected["max"]) == window


@pytest.mark.parametrize(
    "text",
    [
        "61 years",  # outside 0..60
        "5-3 years",  # a > b
        "2-61 years",
        "minimum experience up to 3 years",  # a "minimum" lead never fronts a MAX
        "need 3",  # "only a number" means ONLY the number
        "3 years only",
        "not 3 years",
        "3 years not required",
        "about 3 years",
        "3 years in CNC",
        "3 years+ in CNC",
        ".5 years",  # a leading "." is half a number, never stripped as punctuation
        "~3 years",
    ],
)
def test_the_experience_allowlist_refuses_its_near_misses(text: str):
    assert "experience" not in answers.detect_answers(text, "experience")


@pytest.mark.parametrize(
    ("text", "last_asked", "window"),
    [
        ("3 years experience", "requirements", (3, None)),
        ("3+ yrs exp", "requirements", (3, None)),
        ("experience: 2-5 years", "requirements", (2, 5)),
        ("minimum 2 years experience", "requirements", (2, None)),
        ("Welder, 3 years experience, night shift", "role_title", (3, None)),
        ("ITI; 3 years experience", "requirements", (3, None)),
        ("ITI. 3 years experience", "requirements", (3, None)),
        ("3 years experience, 3 years experience", "requirements", (3, None)),  # duplicates
        ("Helper, freshers ok", "role_title", (0, None)),
        ("need 12 years experience", "role_title", (12, None)),
        ("need 10-15 years experience", "role_title", (10, 15)),
    ],
)
def test_experience_read_in_passing_needs_one_whole_shape_that_names_experience(
    text: str, last_asked: str, window: tuple
):
    detected = answers.detect_answers(text, last_asked)["experience"]
    assert (detected["min"], detected["max"]) == window


@pytest.mark.parametrize(
    ("text", "last_asked"),
    [
        ("3 years", "requirements"),  # a shape, but it does not name experience
        ("3 years experience, 5 years experience", "requirements"),  # two windows
        ("3 years experience, max", "requirements"),  # a sibling bound
        ("experience 3 yrs. max", "requirements"),
        ("3 years experience. Not more than that", "requirements"),
        ("3 years experience, not required", "requirements"),  # a sibling negation
        ("3 years experience, 2 years in CNC", "requirements"),  # a sibling figure
        ("ABC Forgings, 30 years experience, need operators", "role_title"),  # > 15
        ("need 15-20 years experience", "role_title"),  # > 15
        ("Established 2012, 12 years experience, need welders", "role_title"),  # tenure
        ("Welder for our plant, 3 years experience", "role_title"),  # tenure word
        ("Experience: 3-5 yrs", "description"),  # never from the description
    ],
)
def test_experience_read_in_passing_refuses_anything_that_could_change_its_meaning(
    text: str, last_asked: str
):
    assert "experience" not in answers.detect_answers(text, last_asked)


@pytest.mark.parametrize(
    ("text", "needed_by"),
    [
        ("Immediately", "immediate"),
        ("immediate joining", "immediate"),
        ("asap", "immediate"),
        ("as soon as possible", "immediate"),
        ("urgent", "immediate"),
        ("urgently", "immediate"),
        ("urgent requirement", "immediate"),
        ("right away", "immediate"),
        ("right now", "immediate"),
        ("today", "immediate"),
        ("tomorrow", "immediate"),
        ("this week", "immediate"),
        ("turant", "immediate"),
        ("abhi", "immediate"),
        ("jaldi se jaldi", "immediate"),
        ("joining immediately", "immediate"),
        ("we need them asap please", "immediate"),
        ("we need them tomorrow", "immediate"),
        ("can join today", "immediate"),
        ("start immediately", "immediate"),
        ("abhi se", "immediate"),
        ("soon", "soon"),
        ("Within a month", "soon"),
        ("within a week", "soon"),
        ("within one month", "soon"),
        ("within 1 week", "soon"),
        ("15 days", "soon"),
        ("in 10 days", "soon"),
        ("within 3 weeks", "soon"),
        ("next 7 days", "soon"),
        ("59 days", "soon"),
        ("7 weeks", "soon"),
        ("10 din", "soon"),
        ("2 hafte", "soon"),
        ("2 haftey", "soon"),
        ("2-3 weeks", "soon"),
        ("10-15 days", "soon"),
        ("next week", "soon"),
        ("next month", "soon"),
        ("this month", "soon"),
        ("a month", "soon"),
        ("one month", "soon"),
        ("ek mahina", "soon"),
        ("ek mahine", "soon"),
        ("ek hafta", "soon"),
        ("few days", "soon"),
        ("a few weeks", "soon"),
        ("jaldi", "soon"),
        ("joining date: 15 days", "soon"),
        ("starting next week", "soon"),
        ("next week se", "soon"),
        ("15 days only", "soon"),
        ("Flexible", "flexible"),
        ("no hurry", "flexible"),
        ("no rush", "flexible"),
        ("no urgency", "flexible"),
        ("anytime", "flexible"),
        ("any time", "flexible"),
        ("whenever", "flexible"),
        ("not urgent", "flexible"),
        ("not in a hurry", "flexible"),
        ("koi jaldi nahi", "flexible"),
        ("jaldi nahi", "flexible"),
        ("urgent nahi", "flexible"),
        ("joining flexible", "flexible"),
    ],
)
def test_every_canonical_needed_by_shape_parses(text: str, needed_by: str):
    assert answers.detect_answers(text, "needed_by") == {"needed_by": needed_by}


@pytest.mark.parametrize(
    "text",
    ["2 months", "60 days", "60+ days", "8 weeks", "8+ weeks", "0 days", "3-2 weeks", "1-60 days"],
)
def test_a_counted_timeline_outside_the_soon_bounds_records_nothing(text: str):
    assert "needed_by" not in answers.detect_answers(text, "needed_by")


@pytest.mark.parametrize(
    ("text", "pay_type"),
    [
        ("In-hand", "in_hand"),
        ("in hand", "in_hand"),
        ("inhand", "in_hand"),
        ("take home", "in_hand"),
        ("take-home", "in_hand"),
        ("net", "in_hand"),
        ("net salary", "in_hand"),
        ("haath me", "in_hand"),
        ("haath mein", "in_hand"),
        ("it is in hand", "in_hand"),
        ("it's in hand", "in_hand"),
        ("salary is in hand", "in_hand"),
        ("in hand salary", "in_hand"),
        ("Gross", "gross"),
        ("gross salary", "gross"),
        ("pay is gross", "gross"),
        ("CTC", "ctc"),
        ("c.t.c.", "ctc"),
        ("cost to company", "ctc"),
        ("its ctc", "ctc"),
    ],
)
def test_every_canonical_pay_type_answer_parses(text: str, pay_type: str):
    assert answers.detect_answers(text, "pay_type") == {"pay_type": pay_type}


@pytest.mark.parametrize(
    "text", ["in hand 20k", "20k", "2 in hand", "CTC 3 lakh", "gross 30000", "in hand only"]
)
def test_a_pay_type_answer_with_a_figure_or_an_extra_word_records_nothing(text: str):
    assert "pay_type" not in answers.detect_answers(text, "pay_type")


@pytest.mark.parametrize(
    "text",
    [
        "20-25k in hand, gross",  # a second basis named
        "20k CTC, net banking se",  # a second basis named
        "20k in hand before PF",  # a qualifier
        "20k in hand before deductions",  # "in hand before deductions" is not in hand
        "20k CTC after deductions",  # ...nor is "CTC after deductions" the CTC
        "20k gross salary before tax",
        "20k in hand, 5k bonus",  # an add-on
        "20k CTC nai",  # an SMS negator
        "20k in hand tools",  # "in hand" the skill
        "20k, good in hand",  # not attached
        "20k in hand, 25k",  # two figures
        # Spec C, verbatim: EXACTLY ONE pay-figure group, and NO extra-pay word anywhere —
        # even where the band itself survives ("PF 1800" is dropped from the pay band).
        "20k in hand, PF 1800",
        "20k in hand, plus bonus",
        "20k in hand, OT extra",
    ],
)
def test_pay_type_in_passing_refuses_a_second_basis_a_qualifier_or_a_loose_cue(text: str):
    assert "pay_type" not in answers.detect_answers(text, "pay_range")


# City: the closed gazetteer only (spec D). --------------------------------------------
@pytest.mark.parametrize(
    ("text", "city"),
    [
        ("Pune, Chakan", "Pune"),
        ("Chakan, Pune", "Pune"),
        ("Old Delhi Road, Gurgaon", "Gurugram"),
        ("Delhi-Jaipur highway, Neemrana", "Neemrana"),
        ("Bommasandra, Hosur Road, Bangalore", "Bangalore"),
        ("Navi Mumbai", "Navi Mumbai"),
        ("Bombay", "Mumbai"),
        ("in Pune city", "Pune"),
        ("Chakan, Pune district", "Pune"),
        ("Pune only", "Pune"),
    ],
)
def test_the_location_answer_records_only_a_comma_part_that_is_a_gazetteer_city(
    text: str, city: str
):
    assert answers.detect_answers(text, "location_label")["city"] == city


@pytest.mark.parametrize(
    "text",
    [
        "Office in Delhi, factory in Manesar",
        "Hosur, Bangalore",
        "Pune, or Mumbai",  # an alternative
        "Pune, not sure",  # uncertainty
        "Pune, maybe",
        "Pune, all areas",
        "Plant in Chakan, Pune",  # a role noun beside a second part
    ],
)
def test_the_location_answer_leaves_city_open_when_it_is_not_simply_the_workplace(text: str):
    assert "city" not in answers.detect_answers(text, "location_label")


def test_the_city_question_is_whole_answer_gazetteer_only():
    assert answers.detect_answers("Chakan", "city") == {}
    assert answers.detect_answers("no idea", "city") == {}
    assert answers.detect_answers("Maharashtra", "city") == {}
    assert answers.detect_answers("Old Delhi Road", "city") == {}
    assert answers.detect_answers("It's in Pune", "city") == {"city": "Pune"}
    assert answers.detect_answers("its in Nashik", "city") == {"city": "Nashik"}
    assert answers.detect_answers("the Pune dist", "city") == {"city": "Pune"}


# Brackets / caps (spec G). ---------------------------------------------------------------
def test_an_unbalanced_bracket_is_removed_but_a_token_is_never_touched():
    assert answers.detect_answers("Welder [TIG]", "role_title") == {"role_title": "Welder TIG"}
    assert answers.detect_answers("Welder (TIG", "role_title") == {"role_title": "Welder TIG"}
    assert answers.detect_answers("Welder TIG)", "role_title") == {"role_title": "Welder TIG"}
    assert answers.detect_answers("Welder (TIG) MIG", "role_title") == {
        "role_title": "Welder (TIG) MIG"
    }
    # The token keeps every bracket, so the retype ask still sees it.
    detected = answers.detect_answers("Call [PHONE_1] (after 6", "description")
    assert detected == {"description": "Call [PHONE_1] after 6"}


@pytest.mark.parametrize(
    ("text", "topic", "cap"),
    [
        ("x" * 75 + " [PERSON_1] lorem", "benefits", answers.PHRASE_MAX),
        (
            "Rehne ki vyavastha company ke hostel mein milegi baaki details supervisor "
            "[PERSON_1] ji se",
            "benefits",
            answers.PHRASE_MAX,
        ),
        ("W" * 195 + " [PERSON_1]", "role_title", answers.LABEL_MAX),
        ("d" * 1994 + " [PHONE_1] and more", "description", answers.DESCRIPTION_MAX),
    ],
)
def test_a_cap_never_cuts_a_placeholder_token_in_half(text: str, topic: str, cap: int):
    """#1727 R20: the cut used to leave "[PER" on the card, invisible to the retype ask."""
    import re

    value = answers.detect_answers(text, topic)[topic]
    for item in value if isinstance(value, list) else [value]:
        assert len(item) <= cap
        assert not re.search(r"\[[A-Z]*_?\d*$", item), item
        assert "[" not in item or answers.PLACEHOLDER_TOKEN_RE.search(item)


def test_the_bracket_sweep_never_breaks_a_token_beside_unbalanced_brackets():
    """A token's "[" and "]" enclose no bracket, so the sweep always pairs them."""
    for text in ("( [PERSON_1] ]", "] [PHONE_1] (", "[ [EMAIL_1] ) x"):
        value = answers.detect_answers(text, "description")["description"]
        assert answers.PLACEHOLDER_TOKEN_RE.search(value), (text, value)


def test_no_pay_type_answer_shape_can_contain_a_digit():
    """Spec C's "any digit records nothing" holds BY CONSTRUCTION: no allowlisted
    answer shape contains a digit or a digit class, so a restated figure never fits."""
    import re

    for shape in answers._PAY_TYPE_ANSWER_RES.values():
        assert not re.search(r"[0-9]|\\d", shape.pattern), shape.pattern
    for text in ("in hand 18k", "CTC 3", "gross 1", "net 20000 salary"):
        assert "pay_type" not in answers.detect_answers(text, "pay_type")


def test_cap_utf16_moves_a_cut_inside_a_token_to_before_it():
    assert answers.cap_utf16("ab [PERSON_1]", 6) == "ab "
    assert answers.cap_utf16("ab [PERSON_1]", 13) == "ab [PERSON_1]"
    assert answers.cap_utf16("ab [PERSON_1] c", 13) == "ab [PERSON_1]"


# Engine: the round-3 flows, end to end. -------------------------------------------------
@pytest.mark.parametrize(
    "messages",
    [
        ["CNC Operator", "no", "no"],  # the location refused twice
        ["CNC Operator", "skip", "skip"],
        ["CNC Operator", "Chakan MIDC"],  # an area outside the gazetteer
    ],
)
def test_the_city_question_never_points_at_an_area_that_was_never_recorded(messages: list):
    """#1727 R27: "Which city or district is that area in?" was served after the location
    was refused twice, when there was no area for "that" to mean."""
    state = None
    reply = ""
    for message in messages:
        reply, asked_id, state, _ = interview_engine.next_turn(state, message)
    assert asked_id == "city"
    assert reply.endswith(question_bank.topic_by_id("city").question)
    assert " that " not in f" {reply.lower()} "


def test_an_unlisted_town_is_re_asked_for_the_nearest_big_city_then_declared():
    asked, state = _drive(None, ["CNC Operator", "Chakan MIDC", "Chakan", "Chakan", "5"])
    assert asked[:3] == ["location_label", "city", "city"]
    assert "city" not in state.collected
    assert "city" in state.unanswered_essentials
    draft = interview_engine.build_draft(state)
    assert draft.city is None
    assert question_bank.topic_by_id("city").retry_question in draft.clarification_questions


@pytest.mark.parametrize(
    "opener",
    [
        "Senior fitter, need 15-20 years experience",
        "Welder, need 5+ years experience",
        "Supervisor, need 10 years experience",
        "Security guard, need 12 hours duty",
    ],
)
def test_a_unit_bearing_window_in_the_opener_never_closes_vacancy(opener: str):
    """#1727 R8/R16/R17/R18 end to end: the vacancy question is still served."""
    asked, state = _drive(None, [opener, "Pune, Chakan"])
    assert "vacancy" not in state.collected
    assert asked == ["location_label", "vacancy"]


def test_an_allowance_in_the_opener_never_labels_the_pay_band():
    """#1727 R30 end to end: the pay-type question is served and takes the answer."""
    state = None
    for message in ["Need 5 welders, night allowance 2000 in hand", "Pune, Chakan", "TIG"]:
        _, asked_id, state, _ = interview_engine.next_turn(state, message)
    assert asked_id == "pay_range"
    assert "pay_type" not in state.collected
    _, asked_id, state, _ = interview_engine.next_turn(state, "20-25k")
    assert asked_id == "pay_type"
    _, _, state, _ = interview_engine.next_turn(state, "Gross")
    draft = interview_engine.build_draft(state)
    assert (draft.pay_min, draft.pay_max, draft.pay_type) == (20000, 25000, "gross")


def test_a_pay_type_read_in_passing_never_labels_an_established_band_it_did_not_describe():
    """The detector ties the type to its own figure, but the overwrite rule keeps the
    ESTABLISHED band — so the type must be dropped with the figure it described."""
    state = _at_the_pay_question()
    _, asked_id, state, _ = interview_engine.next_turn(state, "20-25k")
    assert asked_id == "pay_type"
    state.asked_question_ids.append("shift")  # a later question is on screen
    _, _, state, _ = interview_engine.next_turn(state, "salary 18k in hand")
    assert state.collected["pay_range"] == {"pay_min": 20000, "pay_max": 25000}
    assert "pay_type" not in state.collected
    # A correction replaces the band, so its type rides with it.
    _, _, state, _ = interview_engine.next_turn(state, "actually 18k in hand salary")
    assert state.collected["pay_range"] == {"pay_min": 18000, "pay_max": None}
    assert state.collected["pay_type"] == "in_hand"


def test_a_restated_figure_on_the_pay_type_question_records_no_type():
    """#1727 R31: 'in hand 18k' after 'Salary 20-25k' drafted 20-25k IN-HAND."""
    _, asked_id, state, _ = interview_engine.next_turn(_at_the_pay_question(), "Salary 20-25k")
    assert asked_id == "pay_type"
    _, _, state, _ = interview_engine.next_turn(state, "in hand 18k")
    assert "pay_type" not in state.collected
    assert state.collected["pay_range"] == {"pay_min": 20000, "pay_max": 25000}


def test_a_year_in_the_description_never_becomes_pay():
    """#1727 R34 end to end: 'negotiable' then 'Established 1998, salary always in hand'
    drafted pay_min 1998 IN-HAND."""
    _, _, state, _ = interview_engine.next_turn(_at_the_pay_question(), "negotiable")
    state.asked_question_ids.append("description")
    _, _, state, _ = interview_engine.next_turn(state, "Established 1998, salary always in hand")
    draft = interview_engine.build_draft(state)
    assert (draft.pay_min, draft.pay_max, draft.pay_type) == (None, None, None)


def test_a_role_capture_that_starts_with_a_unit_is_not_a_role_title():
    """#1727 R17 side note: the cue skipped the number and captured "years experience"."""
    detected = answers.detect_answers("Welder, need 5 years experience", "role_title")
    assert detected["role_title"] == "Welder, need 5 years experience"
    assert answers.detect_answers("need 5 welders", "role_title")["role_title"] == "welders"
