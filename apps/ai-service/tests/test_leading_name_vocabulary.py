"""#1728 at the ROUTE level: a leading trade word is not a person's name, on both sides.

`tests/test_pseudonymize.py` pins the gateway rule itself. This file pins what the rule was
for, through the two routes that paid for its absence (measured on main before the fix):

- PAYER, POST /job-posting-chat/respond. "Welding, grinding" masked to "[PERSON_1], grinding";
  `safe_draft_text` then stored the MASKED text because a PERSON token is identity-class, and
  the skills list became ["PERSON_1", "grinding"] — the payer's trade replaced by a token
  remnant (the phrase cleaner trims the brackets) on the draft that gets published.
- WORKER, POST /profiling/turn. The model was sent "[PERSON_1], 5 saal" for "Welding, 5 saal",
  i.e. it never saw the trade the worker named.

Each permit is paired with a refusal through the same route, so a capture that could not see a
PERSON token would fail the control instead of passing the permit vacuously.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.contracts import AICallMetadata, JobPostingChatState

client = TestClient(main_module.app)

_RETYPE_MARKER = "without personal contact details"


def _no_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _boom(*_a, **_k):  # pragma: no cover - the assertion is that it never runs
        raise AssertionError("the job-posting chat route must not call the AI router")

    monkeypatch.setattr(main_module.router, "run", _boom)


def _answer_skills(message: str) -> dict:
    state = JobPostingChatState(asked_question_ids=["skills"], ask_counts={"skills": 1})
    res = client.post(
        "/job-posting-chat/respond",
        json={
            "session_id": "s1",
            "message_text": message,
            "conversation_state": state.model_dump(),
        },
    )
    assert res.status_code == 200
    return res.json()


def test_a_payer_skills_answer_opening_with_a_trade_word_is_recorded_verbatim(
    monkeypatch: pytest.MonkeyPatch,
):
    _no_llm(monkeypatch)
    body = _answer_skills("Welding, grinding")
    assert body["blocked"] is False
    assert body["draft"]["skills"] == ["Welding", "grinding"]
    assert not any(
        tok.startswith("[PERSON_")
        for tok in body["pseudonymization_metadata"]["placeholder_tokens"]
    )
    assert not any(_RETYPE_MARKER in q for q in body["draft"]["clarification_questions"])


def test_a_payer_answer_opening_with_a_NAME_is_still_masked(monkeypatch: pytest.MonkeyPatch):
    # The control: the same route, the same topic, a person's name in the same position.
    #
    # Deliberately NOT asserting the retype prompt here. MEASURED on main: the phrase cleaner
    # in job_posting_chat/answers.py trims wrapping punctuation, so a token at a phrase edge is
    # stored as "PERSON_1" (brackets gone), the placeholder scan no longer matches it, and no
    # retype prompt is raised. That is the job-posting chat's own behaviour, owned elsewhere;
    # this control pins only what the GATEWAY decides — the name never reaches the draft.
    _no_llm(monkeypatch)
    body = _answer_skills("Ramesh, grinding")
    assert body["pseudonymization_metadata"]["placeholder_tokens"] == ["[PERSON_1]"]
    skills = body["draft"]["skills"]
    assert len(skills) == 2 and "PERSON_1" in skills[0] and skills[1] == "grinding"
    assert "Ramesh" not in json.dumps(body)


def _meta() -> AICallMetadata:
    return AICallMetadata(
        ai_call_id="call-1",
        task_type="profiling_chat_turn",
        model_name="test-model",
        provider="test-provider",
        real_call=False,
        created_at="2026-09-25T00:00:00Z",
    )


def _worker_turn_sent(monkeypatch: pytest.MonkeyPatch, message: str) -> str:
    """The user message the /profiling/turn route hands the router for ``message``."""
    captured: dict[str, list[dict[str, str]]] = {}

    async def _capture(*_a, **kwargs):
        captured["messages"] = kwargs["messages"]
        return "{}", _meta()

    monkeypatch.setattr(main_module.router, "run", _capture)
    res = client.post("/profiling/turn", json={"worker_ref": "w1", "message_text": message})
    assert res.status_code == 200
    assert res.json()["blocked"] is False
    return captured["messages"][-1]["content"]


def test_the_worker_turn_route_sends_a_leading_trade_word_to_the_model_unmasked(
    monkeypatch: pytest.MonkeyPatch,
):
    sent = _worker_turn_sent(monkeypatch, "Welding, 5 saal")
    assert "The worker just said: Welding, 5 saal" in sent
    assert "[PERSON_" not in sent


def test_the_worker_turn_route_still_masks_a_leading_NAME(monkeypatch: pytest.MonkeyPatch):
    sent = _worker_turn_sent(monkeypatch, "Ramesh, 5 saal")
    assert "The worker just said: [PERSON_1], 5 saal" in sent
    assert "Ramesh" not in sent
