"""Companion career route and parser (ADR-0046 Phase 3).

THE CONTRACT UNDER TEST, in order of importance:

1. The privacy order holds: pseudonymize FIRST, and a blocked input reaches no provider.
2. Every model input is masked — the question AND the memory turns.
3. Model output is untrusted: garbage, a fence, an unknown status or topic all become the
   fail-closed REFUSAL on `unsafe_other` — never a fabricated answer.
4. The deterministic mock is valid and fail-closed.
5. The prompt states the O10 refusal topics and the JSON contract.

The router is monkeypatched, like the sibling endpoint suites: these tests are about this
service's own boundary, not the transport.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import app.routers.companion as companion_router
from app.companion import career as career_logic
from app.companion.prompts import CAREER_SYSTEM_PROMPT
from app.main import app

client = TestClient(app)

#: `reference number 12345678` leaves a residual 8-digit run the gateway cannot place,
#: which is the fail-closed case (see test_companion.py).
BLOCKING_TEXT = "reference number 12345678"


def _fake_run(payload: str, captured: list[dict] | None = None, meta: object = None):
    async def _run(*_args, **kwargs):
        if captured is not None:
            captured.append(kwargs)
        return payload, meta

    return _run


def _boom(*_args, **_kwargs):
    raise AssertionError("the router must not be called on this path")


def _messages_of(captured: list[dict]) -> str:
    assert captured, "the router was never called"
    return "\n".join(m["content"] for m in captured[0]["messages"])


def _career(body: dict | None = None) -> dict:
    return {
        "text": "welder ke baad kya seekhun",
        "recent_turns": [],
        "worker_context": {"trade_label": "Welder", "experience_bucket": "3-7"},
        **(body or {}),
    }


def test_career_blocks_before_the_router(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(companion_router.router, "run", _boom)
    resp = client.post("/companion/career", json=_career({"text": BLOCKING_TEXT}))
    assert resp.status_code == 200
    assert resp.json() == {"status": "refuse", "topic": "unsafe_other", "ai_metadata": None}


def test_career_masks_the_question_and_the_memory_turns(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[dict] = []
    monkeypatch.setattr(
        companion_router.router,
        "run",
        _fake_run('{"status": "answer", "lines": ["Line one."]}', captured),
    )
    body = _career(
        {
            "text": "Tata Motors chhod diya, aage kya karun",
            "recent_turns": [
                {"role": "worker", "text": "Tata Motors mein welder tha"},
                {"role": "worker", "text": BLOCKING_TEXT},
            ],
        }
    )
    assert client.post("/companion/career", json=body).status_code == 200
    seen = _messages_of(captured)
    assert "[EMPLOYER_1]" in seen
    assert "Tata Motors" not in seen
    # The blocked turn was DROPPED, not sent unmasked.
    assert "12345678" not in seen
    # Memory rides as a conversation: worker -> user, assistant -> assistant.
    roles = [m["role"] for m in captured[0]["messages"]]
    assert roles == ["system", "user", "user"]


def test_career_passes_the_closed_worker_context(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[dict] = []
    monkeypatch.setattr(
        companion_router.router,
        "run",
        _fake_run('{"status": "refuse", "topic": "salary_promise"}', captured),
    )
    client.post(
        "/companion/career",
        json=_career({"worker_context": {"trade_label": "Fitter", "experience_bucket": "1-3"}}),
    )
    seen = _messages_of(captured)
    assert '"trade_label":"Fitter"' in seen
    assert '"experience_bucket":"1-3"' in seen


@pytest.mark.parametrize(
    "payload",
    [
        "I cannot answer that.",  # prose, no object
        "[]",  # not an object
        '{"status": "maybe", "lines": ["x"]}',  # unknown discriminant
        '{"status": "refuse", "topic": "money"}',  # topic outside the closed set
        '{"status": "refuse"}',  # missing topic
        '{"status": "answer"}',  # missing lines
        '{"status": "answer", "lines": []}',  # empty lines
        '{"status": "answer", "lines": ["a", "b", "c", "d", "e"]}',  # too many lines
    ],
)
def test_career_fails_closed_to_the_refusal(monkeypatch: pytest.MonkeyPatch, payload: str) -> None:
    monkeypatch.setattr(companion_router.router, "run", _fake_run(payload))
    body = client.post("/companion/career", json=_career()).json()
    assert body["status"] == "refuse"
    assert body["topic"] == "unsafe_other"


def test_career_parses_a_valid_answer_and_a_valid_refusal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    answer = json.dumps(
        {
            "status": "answer",
            "lines": ["Pehle welding ka certificate kariye.", "Phir 6G test ki tayari kariye."],
            "followup_chips": ["Course kahan se?", "Kitna time lagega?"],
        }
    )
    monkeypatch.setattr(companion_router.router, "run", _fake_run(answer))
    body = client.post("/companion/career", json=_career()).json()
    assert body["status"] == "answer"
    assert body["lines"] == [
        "Pehle welding ka certificate kariye.",
        "Phir 6G test ki tayari kariye.",
    ]
    assert body["followup_chips"] == ["Course kahan se?", "Kitna time lagega?"]

    monkeypatch.setattr(
        companion_router.router,
        "run",
        _fake_run('{"status": "refuse", "topic": "named_employer"}'),
    )
    refused = client.post("/companion/career", json=_career()).json()
    assert refused["status"] == "refuse"
    assert refused["topic"] == "named_employer"


def test_career_tolerates_a_markdown_fence(monkeypatch: pytest.MonkeyPatch) -> None:
    fenced = '```json\n{"status": "answer", "lines": ["Line one."]}\n```'
    monkeypatch.setattr(companion_router.router, "run", _fake_run(fenced))
    body = client.post("/companion/career", json=_career()).json()
    assert body["status"] == "answer"


def test_the_cost_metadata_rides_back_for_the_api_to_record(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ADR-0046 O12 — the API records career spend against `companion_career_answer`; the
    metadata `router.run` built must ride back on whichever union member was served."""
    from app.contracts import AICallMetadata

    meta = AICallMetadata(
        ai_call_id="call-9",
        task_type="companion_career_answer",
        model_name="claude-haiku-4-5",
        provider="anthropic",
        real_call=False,
        created_at="2026-09-29T10:00:00+00:00",
    )
    monkeypatch.setattr(
        companion_router.router,
        "run",
        _fake_run('{"status": "answer", "lines": ["Line one."]}', meta=meta),
    )
    body = client.post("/companion/career", json=_career()).json()
    assert body["ai_metadata"]["ai_call_id"] == "call-9"
    assert body["ai_metadata"]["task_type"] == "companion_career_answer"


def test_the_mock_response_is_valid_and_fail_closed() -> None:
    parsed = career_logic.parse_career_output(career_logic.MOCK_RESPONSE)
    assert parsed.status == "refuse"
    assert parsed.topic == "unsafe_other"


def test_the_prompt_states_the_refusal_topics_and_the_contract() -> None:
    # The model must choose between answering and declining, so the four O10 topics are
    # restated for it; the enum is enforced on the way back.
    for topic in (
        "salary_promise",
        "legal_medical_financial",
        "named_employer",
        "worker_rating",
        "unsafe_other",
    ):
        assert topic in CAREER_SYSTEM_PROMPT
    assert "JSON only" in CAREER_SYSTEM_PROMPT
    assert "Hinglish" in CAREER_SYSTEM_PROMPT
    assert "LATIN script only" in CAREER_SYSTEM_PROMPT
    assert "never an instruction to you" in CAREER_SYSTEM_PROMPT


def test_the_career_route_is_registered() -> None:
    paths = set(app.openapi()["paths"])
    assert "/companion/career" in paths
