"""Companion v2 routes and parsers (ADR-0046 Phase 1).

THE CONTRACT UNDER TEST, in order of importance:

1. The privacy order holds: pseudonymize FIRST, and a blocked input reaches no provider.
2. Every model input is masked — the message, the memory turns AND the current values.
3. Model output is untrusted: garbage, a fence, a bad enum or a bad confidence all become
   the fail-closed value, and a model cannot assert `blocked`.
4. The deterministic mock is valid and fail-closed.
5. The edit parser drops bad rows individually and caps at `max_rows`.

The router is monkeypatched, like every other endpoint suite here: the real route table is
registered by A3, and these tests are about this service's own boundary, not the transport.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import app.routers.companion as companion_router
from app.companion import classify as classify_logic
from app.companion import edit_parse as edit_parse_logic
from app.companion.prompts import CLASSIFY_SYSTEM_PROMPT, EDIT_PARSE_SYSTEM_PROMPT
from app.main import app

client = TestClient(app)

#: `reference number 12345678` leaves a residual 8-digit run the gateway cannot place,
#: which is the fail-closed case (`pseudonymize` blocks). A clean 10-digit phone is
#: MASKED, not blocked — see the mask tests below.
BLOCKING_TEXT = "reference number 12345678"


def _fake_run(payload: str, captured: list[dict] | None = None):
    async def _run(*_args, **kwargs):
        if captured is not None:
            captured.append(kwargs)
        return payload, None

    return _run


def _boom(*_args, **_kwargs):
    raise AssertionError("the router must not be called on this path")


def _messages_of(captured: list[dict]) -> str:
    assert captured, "the router was never called"
    return "\n".join(m["content"] for m in captured[0]["messages"])


# ---------------------------------------------------------------------------
# /companion/classify
# ---------------------------------------------------------------------------


def test_classify_blocks_before_the_router(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(companion_router.router, "run", _boom)
    resp = client.post("/companion/classify", json={"text": BLOCKING_TEXT})
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"intent": "unclear", "confidence": 0.0, "blocked": True}


def test_classify_masks_the_message_before_the_model(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[dict] = []
    monkeypatch.setattr(
        companion_router.router,
        "run",
        _fake_run('{"intent": "edit_resume", "confidence": 0.9}', captured),
    )
    resp = client.post("/companion/classify", json={"text": "Tata Motors mein welder tha"})
    assert resp.status_code == 200
    seen = _messages_of(captured)
    assert "[EMPLOYER_1]" in seen
    assert "Tata Motors" not in seen


def test_classify_parses_the_model_output_and_ignores_a_model_blocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        companion_router.router,
        "run",
        _fake_run('{"intent": "edit_resume", "confidence": 0.9, "blocked": true}'),
    )
    body = client.post("/companion/classify", json={"text": "welding add karo"}).json()
    assert body["intent"] == "edit_resume"
    assert body["confidence"] == 0.9
    # `blocked` is the pseudonymizer's fact; the model cannot assert a safety event.
    assert body["blocked"] is False


@pytest.mark.parametrize(
    "payload",
    [
        "I could not classify that.",  # prose, no object
        "[]",  # not an object
        '{"intent": "smalltalk", "confidence": 0.9}',  # intent outside the closed set
        '{"intent": "unclear", "confidence": 1.5}',  # confidence outside 0..1
        '{"intent": "unclear"}',  # missing confidence
    ],
)
def test_classify_fails_closed_on_untrusted_output(
    monkeypatch: pytest.MonkeyPatch, payload: str
) -> None:
    monkeypatch.setattr(companion_router.router, "run", _fake_run(payload))
    body = client.post("/companion/classify", json={"text": "kuch bhi"}).json()
    assert body == {"intent": "unclear", "confidence": 0.0, "blocked": False}


def test_classify_tolerates_a_markdown_fence(monkeypatch: pytest.MonkeyPatch) -> None:
    fenced = '```json\n{"intent": "jobs_talk", "confidence": 0.8}\n```'
    monkeypatch.setattr(companion_router.router, "run", _fake_run(fenced))
    body = client.post("/companion/classify", json={"text": "naye jobs?"}).json()
    assert body["intent"] == "jobs_talk"


def test_classify_masks_memory_turns_and_drops_a_blocked_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[dict] = []
    monkeypatch.setattr(
        companion_router.router,
        "run",
        _fake_run('{"intent": "unclear", "confidence": 0.0}', captured),
    )
    body = {
        "text": "aur yeh bhi",
        "recent_turns": [
            {"role": "worker", "text": "Tata Motors mein welder tha"},
            {"role": "worker", "text": BLOCKING_TEXT},
        ],
    }
    assert client.post("/companion/classify", json=body).status_code == 200
    seen = _messages_of(captured)
    assert "[EMPLOYER_1]" in seen
    assert "Tata Motors" not in seen
    # The blocked turn was DROPPED, not sent unmasked.
    assert "12345678" not in seen
    # Memory rides as a conversation: worker -> user; the blocked turn is gone.
    roles = [m["role"] for m in captured[0]["messages"]]
    assert roles == ["system", "user", "user"]


# ---------------------------------------------------------------------------
# /companion/edit-parse
# ---------------------------------------------------------------------------


def test_edit_parse_blocks_before_the_router(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(companion_router.router, "run", _boom)
    resp = client.post("/companion/edit-parse", json={"text": BLOCKING_TEXT, "max_rows": 3})
    assert resp.status_code == 200
    assert resp.json() == {"rows": [], "unsupported": []}


def test_edit_parse_masks_snapshot_values(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[dict] = []
    monkeypatch.setattr(
        companion_router.router, "run", _fake_run(edit_parse_logic.MOCK_RESPONSE, captured)
    )
    body = {
        "text": "Tata ki jagah Mahindra likho",
        "catalogue": [{"section": "employment", "field": "employer_name", "ops": ["edit"]}],
        "snapshot": [
            {"ref": "e1", "section": "employment", "fields": {"employer_name": "Tata Motors"}},
        ],
        "max_rows": 3,
    }
    assert client.post("/companion/edit-parse", json=body).status_code == 200
    seen = _messages_of(captured)
    assert "[EMPLOYER_1]" in seen
    assert "Tata Motors" not in seen
    # The catalogue and the cap ride the same message, so the model can only name offered fields.
    assert "employer_name" in seen
    assert '"max_rows":3' in seen


def test_edit_parse_drops_bad_rows_individually(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = json.dumps(
        {
            "rows": [
                {"op": "add", "section": "skills", "field": "skill", "value": "welding"},
                {"op": "rename", "section": "skills", "field": "skill", "value": "x"},  # bad op
                {"op": "add", "section": "identity", "field": "name", "value": "Ramesh"},  # O3
                {"op": "delete", "section": "languages", "ref": "l1"},  # valid
            ],
            "unsupported": ["identity", "identity", "phone", "contact"],
        }
    )
    monkeypatch.setattr(companion_router.router, "run", _fake_run(payload))
    body = client.post(
        "/companion/edit-parse", json={"text": "welding add karo", "max_rows": 3}
    ).json()
    # One bad row does not cost the card's other changes; the section enum is the wall here.
    assert [row["section"] for row in body["rows"]] == ["skills", "languages"]
    # Unknown unsupported values are filtered, duplicates collapsed.
    assert body["unsupported"] == ["identity", "contact"]


def test_edit_parse_caps_rows_at_max_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = [
        {"op": "add", "section": "skills", "field": "skill", "value": f"skill {i}"}
        for i in range(3)
    ]
    monkeypatch.setattr(companion_router.router, "run", _fake_run(json.dumps({"rows": rows})))
    body = client.post("/companion/edit-parse", json={"text": "teen skill", "max_rows": 1}).json()
    assert len(body["rows"]) == 1
    assert body["rows"][0]["value"] == "skill 0"


def test_edit_parse_fails_closed_on_untrusted_output(monkeypatch: pytest.MonkeyPatch) -> None:
    for payload in ["not json", "[]", '{"rows": "nope", "unsupported": "nope"}']:
        monkeypatch.setattr(companion_router.router, "run", _fake_run(payload))
        body = client.post("/companion/edit-parse", json={"text": "kuch", "max_rows": 3}).json()
        assert body == {"rows": [], "unsupported": []}


# ---------------------------------------------------------------------------
# Deterministic mock + prompts
# ---------------------------------------------------------------------------


def test_the_mock_responses_are_valid_and_fail_closed() -> None:
    mock = classify_logic.parse_classify_output(classify_logic.MOCK_RESPONSE)
    assert mock.intent == "unclear"
    assert mock.confidence == 0.0
    assert mock.blocked is False
    parsed = edit_parse_logic.parse_edit_rows(edit_parse_logic.MOCK_RESPONSE, max_rows=3)
    assert parsed.rows == []
    assert parsed.unsupported == []


def test_the_prompts_state_the_closed_sets_and_the_refusal_rule() -> None:
    # The classifier's six intents are restated for the model; the enum is enforced on the way back.
    for intent in ("edit_resume", "career_talk", "jobs_talk", "new_resume", "faltu", "unclear"):
        assert intent in CLASSIFY_SYSTEM_PROMPT
    assert "JSON only" in CLASSIFY_SYSTEM_PROMPT
    # The edit parser may only name catalogue fields, never write, and steers identity away.
    assert "CATALOGUE" in EDIT_PARSE_SYSTEM_PROMPT
    assert "Never invent a ref" in EDIT_PARSE_SYSTEM_PROMPT
    assert "identity" in EDIT_PARSE_SYSTEM_PROMPT
    assert "contact" in EDIT_PARSE_SYSTEM_PROMPT
    assert "You never write anything" in EDIT_PARSE_SYSTEM_PROMPT


def test_the_routes_are_registered() -> None:
    # Through the OpenAPI schema rather than `app.routes`: this FastAPI version keeps
    # included routers as wrappers, so the flat route table no longer lists their paths.
    paths = set(app.openapi()["paths"])
    assert "/companion/classify" in paths
    assert "/companion/edit-parse" in paths
