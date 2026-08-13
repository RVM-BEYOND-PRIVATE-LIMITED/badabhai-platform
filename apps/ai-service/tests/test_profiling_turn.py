"""`_parse_turn` — the boundary where model output stops being trusted.

WHY THIS FILE EXISTS. The turn route shipped with no unit test over its parser, and the first
live interview found the cost immediately: a real Claude call came back with 102 tokens of
perfectly good content, `_parse_turn` used a bare ``json.loads``, the fenced object failed to
parse, and the route returned its silent fallback. The API read that as "the model is
unavailable" and fell the entire interview back to the question packs — a correct, invisible
degradation to the one failure the fallback exists for, caused by a parser and not by an outage.

`coerce_json_text` already existed and its own docstring says every place that parses model JSON
for a profile MUST go through it. These cases are what makes that true here rather than
remembered.
"""

from __future__ import annotations

import json

from app.contracts import LlmTurnInput
from app.routers.profiling import _parse_turn

BODY = LlmTurnInput(worker_ref="w1", stage="domain", message_text="cook hu")

TURN = {
    "reply_text": "Aap kaunsi cuisine banate hain?",
    "stage": "skills",
    "input_mode": "text",
    "suggested_answers": [],
    "domain_label": "cooking",
    "role_label": None,
    "skills": [],
    "experience_entry": None,
    "phase_a_done": False,
}


def test_parses_bare_json() -> None:
    out = _parse_turn(json.dumps(TURN), BODY)
    assert out is not None
    assert out.reply_text == TURN["reply_text"]


def test_parses_a_MARKDOWN_FENCED_object() -> None:
    """THE LIVE DEFECT. Claude has no strict JSON mode and fences by default."""
    fenced = f"```json\n{json.dumps(TURN)}\n```"
    out = _parse_turn(fenced, BODY)
    assert out is not None, "a fenced turn must not read as an outage"
    assert out.reply_text == TURN["reply_text"]


def test_parses_an_object_with_prose_around_it() -> None:
    noisy = f"Here is the next question:\n{json.dumps(TURN)}\nLet me know if you need more."
    out = _parse_turn(noisy, BODY)
    assert out is not None
    assert out.reply_text == TURN["reply_text"]


def test_returns_none_for_content_with_no_object_at_all() -> None:
    assert _parse_turn("I could not answer that.", BODY) is None


def test_refuses_a_turn_carrying_an_employer_name() -> None:
    """`.strict()` on ExperienceEntry is the enforcement, not the prompt rule (CLAUDE.md §2).

    The WHOLE turn is refused rather than the field stripped: a model that tried to hand us an
    employer once will try again, and a silent strip hides that it happened.
    """
    smuggled = {
        **TURN,
        "experience_entry": {
            "role_label": "tandoor cook",
            "duration_text": "3 saal",
            "duration_months": 36,
            "work_done": "naan",
            "employer_name": "Sharma Dhaba",
        },
    }
    assert _parse_turn(json.dumps(smuggled), BODY) is None


def test_refuses_a_stage_the_model_invented() -> None:
    """`LlmInterviewStage` is a `Literal`, so the contract refuses the whole turn.

    Written as a REFUSAL rather than a normalization on purpose. The router used to re-check the
    stage and fall back to `body.stage`, which could never run — validation had already rejected
    it — so the code read as a safety net that was really dead. Failing the turn is the same
    direction every other branch here takes, and the API owns progression either way: the caps in
    `LlmTurnService` decide when Phase A is done, never this field.
    """
    assert _parse_turn(json.dumps({**TURN, "stage": "victory_lap"}), BODY) is None


def test_the_turn_prompt_names_every_field_the_contract_expects() -> None:
    """THE DEFECT THIS PINS: the prompt said "return the JSON object described by the schema"
    and never described one. A live Claude call answered with `next_question` and
    `experiences_recorded` — names it had inferred from the state block in the user message —
    so the contract rejected a perfectly good turn and the interview fell back to the packs.

    Asserted against the MODEL's own field names so the prompt cannot drift from the contract
    it is telling the model to satisfy.
    """
    from app.contracts import LlmTurnOutput
    from app.profiling.interview_prompts import interview_system_prompt

    prompt = interview_system_prompt()
    # The fields the MODEL is responsible for. `blocked`/`is_mock`/`ai_metadata` are ours.
    ours = {"blocked", "blocked_reason", "is_mock", "ai_metadata"}
    for name in LlmTurnOutput.model_fields:
        if name in ours:
            continue
        assert f'"{name}"' in prompt, f"the turn prompt never names `{name}`"


def test_the_extract_prompt_names_every_field_the_contract_expects() -> None:
    from app.contracts import InterviewExtractOutput
    from app.profiling.interview_prompts import extract_system_prompt

    prompt = extract_system_prompt()
    ours = {"blocked", "is_mock", "ai_metadata"}
    for name in InterviewExtractOutput.model_fields:
        if name in ours:
            continue
        assert f'"{name}"' in prompt, f"the extract prompt never names `{name}`"


# ===========================================================================
# BL-2: HTTP-level coverage for POST /profiling/turn. Everything above tests
# only `_parse_turn` in isolation; this is the route itself — pseudonymize
# order, the mock/timeout/real-call branches, and the response shape.
# ===========================================================================

from fastapi.testclient import TestClient  # noqa: E402

import app.main as _main_module  # noqa: E402
from app.contracts import AICallMetadata  # noqa: E402

client = TestClient(_main_module.app)


def _meta(real_call: bool) -> AICallMetadata:
    return AICallMetadata(
        ai_call_id="call-1",
        task_type="profiling_chat_turn",
        model_name="test-model",
        provider="test-provider",
        real_call=real_call,
        created_at="2026-08-13T00:00:00Z",
    )


def _no_router_call(monkeypatch) -> None:
    async def _boom(*_a, **_k):  # pragma: no cover - assertion is that it never runs
        raise AssertionError("the turn route must not call the AI router")

    monkeypatch.setattr(_main_module.router, "run", _boom)


def test_turn_route_blocks_before_the_router_on_pii(monkeypatch) -> None:
    # A clean 10-digit phone number is MASKED, not blocked (pseudonymize replaces it
    # with [PHONE_1] and proceeds). A residual digit run the masker cannot place --
    # the fail-closed case -- is what actually returns blocked=True.
    _no_router_call(monkeypatch)
    resp = client.post(
        "/profiling/turn",
        json={"worker_ref": "w1", "message_text": "reference number 12345678"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["blocked"] is True
    assert body["reply_text"] == ""
    assert body["is_mock"] is True


def test_turn_route_mock_posture_returns_the_silent_fallback(monkeypatch) -> None:
    async def _mock_run(*_a, **_k):
        return "{}", _meta(real_call=False)

    monkeypatch.setattr(_main_module.router, "run", _mock_run)
    resp = client.post("/profiling/turn", json={"worker_ref": "w1", "message_text": "cook hu"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_mock"] is True
    assert body["reply_text"] == ""


def test_turn_route_real_call_returns_the_parsed_turn(monkeypatch) -> None:
    async def _mock_run(*_a, **_k):
        return json.dumps(TURN), _meta(real_call=True)

    monkeypatch.setattr(_main_module.router, "run", _mock_run)
    resp = client.post("/profiling/turn", json={"worker_ref": "w1", "message_text": "cook hu"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_mock"] is False
    assert body["reply_text"] == TURN["reply_text"]
    assert body["ai_metadata"]["ai_call_id"] == "call-1"


def test_turn_route_unparseable_real_response_falls_back_silently(monkeypatch) -> None:
    async def _mock_run(*_a, **_k):
        return "not json at all", _meta(real_call=True)

    monkeypatch.setattr(_main_module.router, "run", _mock_run)
    resp = client.post("/profiling/turn", json={"worker_ref": "w1", "message_text": "cook hu"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["reply_text"] == ""


def test_turn_route_timeout_returns_the_silent_fallback(monkeypatch) -> None:
    async def _mock_run(*_a, **_k):
        raise TimeoutError

    monkeypatch.setattr(_main_module.router, "run", _mock_run)
    resp = client.post("/profiling/turn", json={"worker_ref": "w1", "message_text": "cook hu"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["reply_text"] == ""
    assert body["is_mock"] is True
