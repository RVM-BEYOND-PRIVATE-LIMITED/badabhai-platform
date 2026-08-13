"""POST /profiling/extract — BL-2: this Class-A route had no dedicated test file at all
(only incidental coverage from the generic auth-sweep test), unlike every other Class-A
ai-service route. Covers the route's own branches: empty-transcript short-circuit, mock
posture, a real call's parse + re-certification pass, and the timeout fallback.

Re-certification (`_certified` in app/routers/profiling.py) is the one behavior unique to
this route worth locking here: the model reads a MASKED transcript but composes NEW prose
(`work_done`, skill phrases), and composed text is not covered by the input-side gate — so
every surviving string is re-checked against the pseudonymizer before the response leaves
the service.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

import app.main as main_module
from app.contracts import AICallMetadata

client = TestClient(main_module.app)


def _meta(real_call: bool) -> AICallMetadata:
    return AICallMetadata(
        ai_call_id="call-1",
        task_type="profile_extraction",
        model_name="test-model",
        provider="test-provider",
        real_call=real_call,
        created_at="2026-08-13T00:00:00Z",
    )


def _no_router_call(monkeypatch) -> None:
    async def _boom(*_a, **_k):  # pragma: no cover - assertion is that it never runs
        raise AssertionError("the extract route must not call the AI router")

    monkeypatch.setattr(main_module.router, "run", _boom)


def _line(i: int, role: str, text: str) -> dict:
    return {"i": i, "role": role, "text": text}


def test_empty_transcript_short_circuits_without_calling_the_router(monkeypatch) -> None:
    _no_router_call(monkeypatch)
    resp = client.post("/profiling/extract", json={"worker_ref": "w1", "transcript": []})
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_mock"] is True
    assert body["skills"] == []
    assert body["experiences"] == []


def test_a_transcript_that_masks_to_nothing_short_circuits_too(monkeypatch) -> None:
    """Every line blocked by the privacy gate -> masked list is empty -> same fallback
    as a literally-empty transcript. No line survives to send to the router.

    A residual digit run the masker cannot place is what blocks -- a clean phone
    number is masked in place and the line survives."""
    _no_router_call(monkeypatch)
    resp = client.post(
        "/profiling/extract",
        json={
            "worker_ref": "w1",
            "transcript": [_line(0, "worker", "reference number 12345678")],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["is_mock"] is True


def test_mock_posture_returns_is_mock_true(monkeypatch) -> None:
    async def _mock_run(*_a, **_k):
        return "{}", _meta(real_call=False)

    monkeypatch.setattr(main_module.router, "run", _mock_run)
    resp = client.post(
        "/profiling/extract",
        json={"worker_ref": "w1", "transcript": [_line(0, "worker", "cook hu")]},
    )
    assert resp.status_code == 200
    assert resp.json()["is_mock"] is True


def test_real_call_returns_the_extracted_profile(monkeypatch) -> None:
    extracted = {
        "domain_label": "cooking",
        "role_label": "tandoor cook",
        "skills": ["tandoor", "naan"],
        "experiences": [
            {"role_label": "cook", "duration_text": "3 saal", "work_done": "naan banaya"}
        ],
        "shift": "day",
        "current_city": "Delhi",
        "preferred_locations": ["Delhi", "Noida"],
        "availability": "immediate",
        "expected_salary": 18000,
    }

    async def _mock_run(*_a, **_k):
        return json.dumps(extracted), _meta(real_call=True)

    monkeypatch.setattr(main_module.router, "run", _mock_run)
    resp = client.post(
        "/profiling/extract",
        json={"worker_ref": "w1", "transcript": [_line(0, "worker", "cook hu")]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_mock"] is False
    assert body["role_label"] == "tandoor cook"
    assert body["skills"] == ["tandoor", "naan"]
    assert len(body["experiences"]) == 1
    assert body["ai_metadata"]["ai_call_id"] == "call-1"


def test_unparseable_real_response_returns_mock_output_with_metadata(monkeypatch) -> None:
    async def _mock_run(*_a, **_k):
        return "not json at all", _meta(real_call=True)

    monkeypatch.setattr(main_module.router, "run", _mock_run)
    resp = client.post(
        "/profiling/extract",
        json={"worker_ref": "w1", "transcript": [_line(0, "worker", "cook hu")]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_mock"] is True
    assert body["ai_metadata"]["ai_call_id"] == "call-1"


def test_timeout_returns_mock_output(monkeypatch) -> None:
    async def _mock_run(*_a, **_k):
        raise TimeoutError

    monkeypatch.setattr(main_module.router, "run", _mock_run)
    resp = client.post(
        "/profiling/extract",
        json={"worker_ref": "w1", "transcript": [_line(0, "worker", "cook hu")]},
    )
    assert resp.status_code == 200
    assert resp.json()["is_mock"] is True


def test_an_experience_carrying_blocked_content_is_dropped(monkeypatch) -> None:
    """The model composed NEW prose (work_done) containing something the gateway
    refuses -- the whole experience entry is dropped, not just the offending field.
    A residual digit run the masker cannot place is what blocks (a clean phone
    number is masked in place, not refused)."""
    extracted = {
        "skills": ["welding"],
        "experiences": [
            {
                "role_label": "welder",
                "duration_text": "2 saal",
                "work_done": "reference number 12345678 for more details",
            },
            {"role_label": "fitter", "duration_text": "1 saal", "work_done": "clean work"},
        ],
    }

    async def _mock_run(*_a, **_k):
        return json.dumps(extracted), _meta(real_call=True)

    monkeypatch.setattr(main_module.router, "run", _mock_run)
    resp = client.post(
        "/profiling/extract",
        json={"worker_ref": "w1", "transcript": [_line(0, "worker", "welder hu")]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["experiences"]) == 1
    assert body["experiences"][0]["role_label"] == "fitter"


def test_a_skill_carrying_blocked_content_is_dropped(monkeypatch) -> None:
    extracted = {"skills": ["welding", "reference number 12345678"], "experiences": []}

    async def _mock_run(*_a, **_k):
        return json.dumps(extracted), _meta(real_call=True)

    monkeypatch.setattr(main_module.router, "run", _mock_run)
    resp = client.post(
        "/profiling/extract",
        json={"worker_ref": "w1", "transcript": [_line(0, "worker", "welder hu")]},
    )
    assert resp.status_code == 200
    assert resp.json()["skills"] == ["welding"]
