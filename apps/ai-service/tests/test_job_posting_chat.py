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
    asked, _ = _drive(None, ["x"] * 13)
    assert asked == [
        # 1. Every unanswered ESSENTIAL, each with its ONE bounded re-ask.
        "role_title",
        "role_title",
        "location_label",
        "location_label",
        "vacancy",
        "vacancy",
        # 2. Unanswered CORE topics, asked once.
        "skills",
        "pay_range",
        # 3. Unanswered OPTIONAL topics, asked once.
        "shift",
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
    """`skills` sits SECOND in the bank but is not essential, so it must wait for all
    three essentials — the priority is the engine's, not the bank's reading order."""
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
    # 3 essentials x MAX_ASKS_PER_TOPIC + 6 ask-once topics.
    assert served == 12
    assert ready is True
    # The ceiling must keep REAL headroom over the worst-case blind run, so a bank
    # that grows by a topic or two cannot silently start truncating the interview
    # (the exact zero-margin coupling the worker engine shipped and had to fix).
    assert interview_engine.MAX_ENGINE_ASKS >= served + 4


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
    """"8 hours" / "2 years" must not become a salary. Below the floor and with no
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
        answered_topics=["role_title", "location_label", "vacancy"],
        collected={
            "role_title": "CNC Operator",
            "skills": ["Fanuc", "tool offset"],
            "location_label": "Pune",
            "vacancy": "6-10",
            "pay_range": {"pay_min": 18000, "pay_max": 22000},
            "shift": "rotational",
            "benefits": ["PF", "ESI"],
            "requirements": ["2 years experience"],
            "description": "Machine shop, 6 days a week.",
        },
    )
    draft = interview_engine.build_draft(state)
    assert draft.role_title == "CNC Operator"
    assert draft.vacancy_band == "6-10"
    assert draft.pay_min == 18000 and draft.pay_max == 22000
    assert draft.shift == "rotational"
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
    assert draft.missing_fields[:3] == ["role_title", "skills", "location_label"]
    assert len(draft.clarification_questions) == 3


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
        assert topic_id in state.answered_topics or topic_id in state.asked_question_ids


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
        answered_topics=["role_title", "location_label"],
        asked_question_ids=["role_title", "location_label"],
        ask_counts={"role_title": 1, "location_label": 1},
        collected={"role_title": "Welder", "location_label": "Pune"},
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
