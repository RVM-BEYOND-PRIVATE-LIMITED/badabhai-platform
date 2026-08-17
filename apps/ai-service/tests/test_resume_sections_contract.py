"""`/resume/generate` returns the deterministic template as `resume_text` on EVERY path (#909).

WHAT BROKE, and why it took a device to find. The worker app renders its résumé as icon-led
sections by parsing the `Label: value` template `build_resume` produces (ADR-0013), and falls back
to rendering one raw paragraph when no labels parse. The real LLM path returned the model's output
as `resume_text`, and `RESUME_SYSTEM_PROMPT` asks for "2-4 sentences, factual" — prose, with no
labels in it. So with `AI_ENABLE_REAL_CALLS=true` every generated résumé silently collapsed to a
paragraph, while the mock and pseudonymize-blocked paths (which return the template) kept looking
perfect in CI and on every laptop.

THE ASYMMETRY IS THE BUG, so these tests assert the three paths AGREE about the shape of
`resume_text` rather than asserting any particular sentence. A future prompt change cannot
reintroduce this: the model's words are only ever allowed into `summary`.
"""

from datetime import UTC, datetime

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

#: Prose of exactly the shape RESUME_SYSTEM_PROMPT asks for — no `Label:` anywhere.
LLM_PROSE = (
    "Ramesh is a VMC operator with eight years of experience. "
    "He is skilled in Fanuc controls and works in Pune."
)


def _body(**profile_overrides) -> dict:
    profile = {
        "canonical_role_id": "role_vmc_operator",
        "skills": ["skill_fanuc"],
        "machines": ["mach_vmc"],
        "skill_labels": ["VMC Operation"],
    }
    profile.update(profile_overrides)
    return {"worker_ref": "opaque-worker-uuid", "profile": profile}


def _meta(*, real_call: bool):
    from app.contracts import AICallMetadata

    return AICallMetadata(
        ai_call_id="00000000-0000-4000-8000-000000000000",
        task_type="resume_generation",
        model_name="mock",
        provider="mock",
        real_call=real_call,
        input_tokens=0,
        output_tokens=0,
        estimated_cost_inr=0.0,
        latency_ms=0,
        success=True,
        error_code=None,
        created_at=datetime.now(UTC).isoformat(),
    )


def _stub_router(monkeypatch, returns: str, *, real_call: bool) -> None:
    """Make the provider return `returns`, as a REAL call unless told otherwise."""
    from app import main as main_module

    async def _fake_run(task, *, messages, mock_response, real_call_allowed, user_ref=None, **kw):
        return returns, _meta(real_call=real_call)

    monkeypatch.setattr(main_module.router, "run", _fake_run)


def _is_sectioned(resume_text: str) -> bool:
    """The property the worker app's `parseResumeText` actually needs: `Label: value` lines."""
    return any(":" in line and line.split(":", 1)[0].strip() for line in resume_text.splitlines())


def test_real_llm_path_returns_the_template_not_the_prose(monkeypatch):
    """THE REGRESSION. A real call returning prose must not become `resume_text`."""
    _stub_router(monkeypatch, LLM_PROSE, real_call=True)

    res = client.post("/resume/generate", json=_body())
    assert res.status_code == 200
    body = res.json()

    assert body["resume_text"] != LLM_PROSE
    assert _is_sectioned(body["resume_text"]), body["resume_text"]
    # The prose is carried, not discarded — it simply is not the résumé body.
    assert body["summary"] == LLM_PROSE


def test_the_mock_path_returns_the_same_shape(monkeypatch):
    """The path that always worked, asserted so the three cannot drift apart again."""
    # `mock_response` IS the template, which is what a mocked router echoes back.
    _stub_router(monkeypatch, "IGNORED", real_call=False)

    res = client.post("/resume/generate", json=_body())
    assert res.status_code == 200
    body = res.json()

    assert _is_sectioned(body["resume_text"])
    # No provider was called, so there is no blurb to carry. None, never the echoed mock text.
    assert body["summary"] is None


def test_a_blocked_gate_returns_the_same_shape_and_calls_nobody(monkeypatch):
    """Fail-closed path: the worker still gets a full sectioned résumé, minus the polish."""
    from app import main as main_module

    calls: list = []

    async def _fake_run(task, *, messages, mock_response, real_call_allowed, user_ref=None, **kw):
        calls.append(messages)
        return mock_response, _meta(real_call=True)

    monkeypatch.setattr(main_module.router, "run", _fake_run)

    # The carrier `test_egress_gates.py` uses for this class: a 9-digit zero-led run is neither
    # phone-shaped nor an in-range amount, so it survives to the residual-digit net -> blocked.
    res = client.post("/resume/generate", json=_body(education_field="batch 01234567"))
    assert res.status_code == 200
    assert calls == [], "the provider was called on a BLOCKED gate"

    body = res.json()
    assert _is_sectioned(body["resume_text"])
    assert "WORKER PROFILE (DRAFT)" in body["resume_text"]
    # No provider ran, so there is no blurb — and the résumé is whole regardless.
    assert body["summary"] is None


def test_the_three_paths_agree_about_resume_text(monkeypatch):
    """The invariant, stated once: whatever the provider says, `resume_text` is the template."""
    _stub_router(monkeypatch, LLM_PROSE, real_call=True)
    real = client.post("/resume/generate", json=_body()).json()

    _stub_router(monkeypatch, "IGNORED", real_call=False)
    mock = client.post("/resume/generate", json=_body()).json()

    assert real["resume_text"] == mock["resume_text"]
