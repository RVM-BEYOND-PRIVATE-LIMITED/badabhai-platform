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
        lambda _m, last_asked: (
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
        ("Chakan, near Pune", "Pune"),  # a gazetteer hit beats the bare label
        ("Chakan", "Chakan"),  # a small town: accepted as a short label
        ("Sri City", "Sri City"),
        ("It is in Chakan", "Chakan"),
        ("Chakan?", "Chakan"),
    ],
)
def test_the_city_question_accepts_a_gazetteer_city_or_a_short_label(text: str, city: str):
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
        ("5-3 years", (3, 5)),  # a reversed range is ordered
        ("5+ years", (5, None)),
        ("at least 2 years", (2, None)),
        ("minimum 3", (3, None)),
        ("min 3 years", (3, None)),
        ("3 or more years", (3, None)),
        ("3 years or more", (3, None)),
        ("up to 3 years", (None, 3)),
        ("max 4", (None, 4)),
        ("minimum 2 maximum 5 years", (2, 5)),
        ("3 years", (3, None)),
        ("3 saal", (3, None)),
        ("3", (3, None)),
        ("freshers or up to 2 years", (0, 2)),
        ("No freshers, 3+ years only", (3, None)),
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
        ("3 saal ka experience", "requirements", (3, None)),
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
        ("not urgent", "flexible"),  # FLEXIBLE is checked first
        ("Not immediately, within a month", "soon"),  # a negated immediate is dropped
        ("abhi nahi, next month", "soon"),
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
    assert state.collected["experience"] == {"min": 3, "max": None}
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
    # Deliberate: a correction replaces it WHOLE — no merge of halves.
    _, _, state, _ = interview_engine.next_turn(state, "actually 1 year experience")
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
        # F0 — an age range, an age cap or a course length is not the experience figure.
        ("age 25-40, 5 years experience", (5, None)),
        ("2 years, age up to 35", (2, None)),
        ("ITI 2 year course + 1 year experience", (1, None)),
        ("Age 20-35, 2-5 years", (2, 5)),
        ("age 18 to 35, minimum 2 years", (2, None)),
        ("age limit 35, 3 years", (3, None)),
        ("umar 20 se 30, 2 saal", (2, None)),
        ("25 years old, 3 years experience", (3, None)),
        ("Welder with 3 years experience", (3, None)),
        # Two clauses, one window: each side from the clause that states it.
        ("minimum 2 years, maximum 5 years", (2, 5)),
        # F1 / F12 — an upper bound is a MAX, whichever side of the number it sits on.
        ("2 years max", (None, 2)),
        ("2 years maximum", (None, 2)),
        ("max. 3 years", (None, 3)),  # the abbreviation's dot is not a clause break
        ("below 5 years", (None, 5)),
        ("not more than 3 years", (None, 3)),
        ("no more than 3 years", (None, 3)),
        ("at most 4 years", (None, 4)),
        ("upto 3 years", (None, 3)),
        ("within 2 years", (None, 2)),
        ("2 years or less", (None, 2)),
        ("2 years and below", (None, 2)),
        ("5 saal tak", (None, 5)),
        ("3 saal tak", (None, 3)),
        ("2 saal se kam", (None, 2)),
        ("3 saal se kam", (None, 3)),
        ("zyada se zyada 3 saal", (None, 3)),
        ("Fresher or less than 1 year", (0, 1)),
        # A lower bound is a MIN.
        ("more than 3 years", (3, None)),
        ("above 5 years", (5, None)),
        ("over 5 years", (5, None)),
        ("atleast 2 years", (2, None)),
        ("kam se kam 2 saal", (2, None)),
        ("5 years plus", (5, None)),
        ("5 years and above", (5, None)),
        ("3 years or above", (3, None)),
        ("5 saal se zyada", (5, None)),
        ("5 saal se upar", (5, None)),
        # F12 — the Hinglish span separator the pay parser already accepts.
        ("2 se 5 saal", (2, 5)),
        ("between 2 and 5 years", (2, 5)),
        # F2 — a NEGATED fresher never overwrites a stated minimum.
        ("minimum 3 years, freshers are not allowed", (3, None)),
        ("Freshers will not be considered, minimum 2 years", (2, None)),
        # ...while an un-negated one still reads as 0.
        ("Freshers with no experience", (0, None)),
        ("freshers can apply", (0, None)),
        # A thousands comma is not a clause break ("22,000" is not a window of 22).
        ("3 years, salary Rs 22,000", (3, None)),
    ],
)
def test_experience_reads_only_the_figure_tied_to_experience(text: str, window: tuple):
    detected = answers.detect_answers(text, "experience")["experience"]
    assert (detected["min"], detected["max"]) == window


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
        ("Age 18-35 years with 3 years experience", "requirements", (3, None)),
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
    assert (draft.min_experience_years, draft.max_experience_years) == (5, None)


# Needed by (F3, F13) ---------------------------------------------------------------
@pytest.mark.parametrize(
    ("text", "needed_by"),
    [
        # F3 — a negated hurry is flexible, wherever the negation sits.
        ("Not very urgent", "flexible"),
        ("not that urgent", "flexible"),
        ("not so urgent", "flexible"),
        ("not required urgently", "flexible"),
        ("urgent nahi hai", "flexible"),
        ("bilkul urgent nahi", "flexible"),
        ("koi jaldi nahi", "flexible"),
        ("jaldi nahi hai", "flexible"),
        ("not in a hurry", "flexible"),
        ("no rush", "flexible"),
        ("joining time is flexible", "flexible"),
        # F3 — a "flexible" that belongs to another noun is not the joining timeline.
        ("Immediate joining, timings flexible", "immediate"),
        ("ASAP, salary flexible", "immediate"),
        ("Immediately, shift timings are flexible", "immediate"),
        ("today", "immediate"),
        # F13 — counted timelines.
        ("Within a week", "soon"),
        ("in a week", "soon"),
        ("7 days", "soon"),
        ("2 weeks", "soon"),
        ("1 week", "soon"),
        ("one week", "soon"),
        ("1 month", "soon"),
        ("a month", "soon"),
        ("next 10 days", "soon"),
        ("1-2 weeks", "soon"),
        ("2-3 days", "soon"),
        ("ek hafte me", "soon"),
        ("ek mahine me", "soon"),
        ("10 din me", "soon"),
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
        # Unchanged: one city, or two names for the same city.
        ("Pune, Chakan", "Pune"),
        ("Navi Mumbai, Vashi", "Navi Mumbai"),
        ("Gurgaon (Gurugram)", "Gurugram"),
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
        ("Pune, India", "Pune"),  # "india" is a non-answer only when it is ALL there is
        ("[Chakan]", "Chakan"),
        ("Vapi", "Vapi"),
    ],
)
def test_the_city_question_still_accepts_a_real_answer(text: str, city: str):
    assert answers.detect_answers(text, "city") == {"city": city}


def test_the_city_question_is_a_follow_up_not_a_repeat_of_the_location_question():
    """F11: the city question used to be "Which city is the workplace in?" served right
    after "Which city is this job in?" — the same question twice in a row."""
    location = question_bank.topic_by_id("location_label")
    city = question_bank.topic_by_id("city")
    assert location.question == (
        "Which city and area is the workplace in — for example Pune, Chakan?"
    )
    assert city.question == "Which city or district is that area in?"
    served = {location.question, location.retry_question, city.question, city.retry_question}
    assert len(served) == 4  # no wording is ever served twice
    # The retry is copied VERBATIM into clarification_questions, so it must stand
    # alone: nothing for "that" to refer to.
    assert city.retry_question == (
        "Which city or district is the workplace in — for example Pune, Chennai or Ludhiana?"
    )
    assert " that " not in f" {city.retry_question.lower()} "


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


def test_the_city_cap_counts_utf16_even_if_the_charset_is_ever_widened(
    monkeypatch: pytest.MonkeyPatch,
):
    """Defence in depth. Today the letters-only charset admits only BMP characters, for
    which code points and UTF-16 units agree — so the city cap is only OBSERVABLY in
    UTF-16 units once that charset admits more. Widen it here and the cap must hold."""
    import re

    monkeypatch.setattr(answers, "_CITY_LABEL_CHARSET_RE", re.compile(r".+"))
    city = answers.detect_answers("Pimpri" + "\U0001f3ed" * 41, "city")["city"]
    assert _utf16_units(city) <= answers.CITY_MAX
    assert city.startswith("Pimpri")


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
    ],
)
def test_pay_type_records_nothing_rather_than_a_guess_1727(text: str, last_asked: str | None):
    assert "pay_type" not in answers.detect_answers(text, last_asked)


@pytest.mark.parametrize(
    ("text", "last_asked", "pay_type"),
    [
        ("not CTC, in hand", "pay_type", "in_hand"),
        ("CTC nahi, in hand", "pay_type", "in_hand"),
        ("not in hand, it is CTC", "pay_type", "ctc"),
        ("not net, gross", "pay_type", "gross"),
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
        # A bare "company" / "we are" states a REQUIREMENT, not the employer's tenure.
        ("we are looking for 3 years experience", {"min": 3, "max": None}),
        ("3 years experience in a reputed company", {"min": 3, "max": None}),
        # "plus" / "under" as a connective or preposition is not a bound.
        ("ITI plus 2 years experience", {"min": 2, "max": None}),
        ("2 years, will work under supervisor", {"min": 2, "max": None}),
        # A fresher welcome lowers the floor to 0 and keeps the stated ceiling.
        ("1 to 3 years in CNC, freshers can also apply", {"min": 0, "max": 3}),
        ("freshers or 1-2 years experience", {"min": 0, "max": 2}),
        # "Fresher or 2 years" welcomes freshers: the floor is 0, and no ceiling was stated.
        ("Fresher or 2 years", {"min": 0, "max": None}),
        # ...and the hardened cases still hold.
        ("We are a 25 years experienced company, need 2 years", {"min": 2, "max": None}),
        ("minimum 3 years, freshers are not allowed", {"min": 3, "max": None}),
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
    ],
)
def test_the_experience_hardening_still_refuses_to_guess(text: str):
    assert "experience" not in answers.detect_answers(text, "experience")


def test_flexible_timings_is_not_a_joining_timeline():
    """An adjective-first "flexible timings" belongs to the timings, exactly like
    "timings flexible": the immediate cue beside it is the answer."""
    assert answers.detect_answers("flexible timings, join immediately", "needed_by") == {
        "needed_by": "immediate"
    }


@pytest.mark.parametrize(("text", "city"), [("Chakan only", "Chakan"), ("only Bhiwadi", "Bhiwadi")])
def test_only_is_emphasis_not_part_of_the_city(text: str, city: str):
    assert answers.detect_answers(text, "city")["city"] == city
