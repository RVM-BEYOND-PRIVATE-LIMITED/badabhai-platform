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
        ("Experience: 3-5 yrs", "description", (3, 5)),
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
        ("6 days a week", "description"),
        ("3 years", "description"),  # a unit, but no experience word
        ("experienced candidates only, 1 year contract", "description"),  # other clause
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

    asked, state = _drive(None, ["CNC Operator", "Chakan MIDC", "Chakan"])
    assert asked == ["location_label", "city", "vacancy"]
    assert state.collected["city"] == "Chakan"
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
