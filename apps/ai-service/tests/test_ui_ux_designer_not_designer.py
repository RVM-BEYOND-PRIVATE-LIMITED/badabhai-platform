"""A UI/UX designer is not the taxonomy's Designer (#2389).

`role_designer` and `skill_designer_occupation` both bridge to `mskill_designer`, the CAD /
mechanical design seat (`packages/taxonomy/src/match-skills.ts`). We model no UI/UX trade, so
the owner ruled (2026-10-21) that a UI/UX designer is treated like any other trade we do not
have: no design role, and the phrase's own "designer" claims no design skill.

Scoped to UI/UX on purpose. Plain, graphic, fashion, product and mechanical design keep the
role they had, and are pinned here so the blocker cannot quietly widen.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.contracts import AICallMetadata
from app.main import app
from app.profiling import signals

client = TestClient(app)

UI_UX_PHRASES = [
    "main UI/UX designer hu",
    "ui ux designer hoon",
    "UX/UI designer ka kaam karta hu",
    "uiux designer",
    "ui-ux designer hu",
    "UI & UX designer",
    "UI designer hu",
    "UX designer",
    "ui/ux design ka kaam karta hu",
    "UI/UX designing karta hu",
]


@pytest.mark.parametrize("text", UI_UX_PHRASES)
def test_a_ui_ux_designer_gets_no_design_role_and_no_designer_skill(text):
    sig = signals.detect(text)
    assert signals.design_role_blocked(text)
    assert sig.role_id is None
    assert "skill_designer_occupation" not in sig.skill_ids


def test_a_design_tool_does_not_bring_the_role_back():
    """Photoshop is a design keyword, and the role step used to take ANY design keyword as
    proof. The veto is whole-role, like the welding blockers, so the tool cannot override it.
    The tool itself stays a skill: it maps to no match skill."""
    sig = signals.detect("UI/UX designer hu, Figma aur Photoshop chalata hu")
    assert sig.role_id is None
    assert "skill_designer_occupation" not in sig.skill_ids
    assert "skill_rendering_visualization" in sig.skill_ids


@pytest.mark.parametrize(
    "text",
    [
        "main designer hu",
        "graphic designer hu",
        "fashion design karta hu",
        "product design ka kaam",
        "mechanical design karta hu",
    ],
)
def test_other_designers_keep_the_design_role(text):
    sig = signals.detect(text)
    assert not signals.design_role_blocked(text)
    assert sig.role_id == "role_designer"
    assert "skill_designer_occupation" in sig.skill_ids


def test_other_design_evidence_in_the_same_text_is_still_read():
    """Only the UI/UX phrase is blanked: a design skill named elsewhere is still recorded,
    while the role stays vetoed for the text as a whole."""
    sig = signals.detect("UI/UX designer hu, mechanical design bhi kiya hai")
    assert sig.role_id is None
    assert "skill_designer_occupation" in sig.skill_ids


@pytest.mark.parametrize("text", ["ui test kiya", "design", "guide designer", ""])
def test_the_blocker_needs_ui_or_ux_as_its_own_word_before_a_design_word(text):
    assert not signals.design_role_blocked(text)


def _real_meta() -> AICallMetadata:
    return AICallMetadata(
        ai_call_id="t-2389",
        task_type="profile_extraction",
        model_name="mock",
        provider="mock",
        real_call=True,  # the canonical-role overlay only runs on the real branch
        success=True,
        created_at="1970-01-01T00:00:00Z",
    )


def _patch_router(monkeypatch, payload: dict) -> None:
    async def _fake_run(task_type, *, messages, mock_response, **_kwargs):
        return json.dumps(payload), _real_meta()

    from app import main

    monkeypatch.setattr(main.router, "run", _fake_run)


def test_extract_refuses_the_models_designer_role_for_a_ui_ux_designer(monkeypatch):
    """The rubric reads every "designer" as `role_designer`, and a first-person claim lets
    the model's id through TD101. The deterministic veto still has the last word."""
    text = "main UI/UX designer hu"
    # TD101 alone would let the id through, so the veto is what this test exercises.
    assert signals.has_first_person_claim(text)
    _patch_router(monkeypatch, {"canonical_role_id": "role_designer"})
    res = client.post("/profile/extract", json={"transcript": text})
    assert res.status_code == 200
    profile = res.json()["profile"]
    assert profile["canonical_role_id"] is None
    assert "skill_designer_occupation" not in profile["skills"]


def test_extract_still_honours_the_models_designer_role_for_a_graphic_designer(monkeypatch):
    _patch_router(monkeypatch, {"canonical_role_id": "role_designer"})
    res = client.post("/profile/extract", json={"transcript": "main graphic designer hu"})
    assert res.status_code == 200
    assert res.json()["profile"]["canonical_role_id"] == "role_designer"
