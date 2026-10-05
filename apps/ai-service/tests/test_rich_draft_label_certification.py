"""#1788: the stored rich draft's model-written labels go through the SAME clean-or-withhold
certification as the legacy profile's, through the real `/profile/extract` route.

`/profile/extract` returns the rich draft as `worker_profile_draft`, and apps/api stores it whole as
`worker_profiles.rich_profile_draft`. #1739 certified its education level and field. Its label
lists and `primary_role` were still stored as the model wrote them, beside a legacy `profile`
whose lists go through `certified_clean_skill_labels`, so a value the profile withheld was stored
anyway.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

import app.certified_values as certified_values_module
import app.main as main_module
from app.config import get_settings
from app.contracts import AICallMetadata
from app.profiling import canonicalization_gold as gold
from app.profiling import profile_extractor

client = TestClient(main_module.app)

# Withheld by the certifier: a name behind a leading trade word, and a company name.
_SUSPECT = ("Welding, Anil Kumar", "Ramesh Steel Industries")
_SUSPECT_FRAGMENTS = ("Anil", "Ramesh")
# Certified clean, so it must come back byte-identical.
_CLEAN = {
    "machines": "VMC",
    "controllers": "Fanuc",
    "skills": "Tool offset setting",
    "education": "ITI Fitter",
    "inspection_tools": "Vernier caliper",
    "materials_handled": "Stainless Steel",
    "secondary_roles": "CNC Setter-Operator",
    "certifications": "NCVT Certificate",
}
# The legacy profile field carrying each list's certified labels, where it carries one.
_PROFILE_FIELD = {
    "skills": "skill_labels",
    "education": "education",
    "certifications": "certifications",
}


def _meta(*, real_call: bool) -> AICallMetadata:
    return AICallMetadata(
        ai_call_id="00000000-0000-4000-8000-000000000000",
        task_type="profile_extraction",
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


@pytest.fixture(params=[False, True], ids=["raw_pii_off", "raw_pii_on"])
def raw_pii(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> bool:
    """Every test here runs under BOTH `AI_RAW_PII_ENABLED` settings: the certification reads no
    flag, so the stored draft must not depend on it."""
    monkeypatch.setattr(get_settings(), "ai_raw_pii_enabled", request.param)
    return request.param


def _extract(
    monkeypatch: pytest.MonkeyPatch, model_payload: dict | None, transcript: str = "vmc chalata hu"
) -> dict:
    """The whole /profile/extract response. ``model_payload`` is what the model answers on a REAL
    call (the overlay runs only on that branch); None answers the route's own mock response."""

    async def _fake_run(*_a, **kwargs):
        if model_payload is None:
            return kwargs["mock_response"], _meta(real_call=False)
        return json.dumps(model_payload), _meta(real_call=True)

    monkeypatch.setattr(main_module.router, "run", _fake_run)
    res = client.post("/profile/extract", json={"transcript": transcript})
    assert res.status_code == 200
    return res.json()


def _assert_absent(body: dict, *values: str) -> None:
    stored = json.dumps(body, ensure_ascii=False)
    for value in values:
        assert value not in stored


# --- a value withheld from the profile is absent from the stored draft, per list field ----------


@pytest.mark.parametrize("field", profile_extractor.MODEL_LABEL_LIST_FIELDS)
def test_a_suspect_list_entry_is_withheld_from_the_draft_and_the_profile(
    monkeypatch: pytest.MonkeyPatch, raw_pii: bool, field: str
):
    body = _extract(monkeypatch, {field: [*_SUSPECT, _CLEAN[field]]})
    draft, profile = body["worker_profile_draft"], body["profile"]
    # The clean entry survives, unchanged; only the failing entries are dropped.
    assert draft[field] == [_CLEAN[field]]
    if field in _PROFILE_FIELD:
        assert _CLEAN[field] in profile[_PROFILE_FIELD[field]]
    for value in _SUSPECT:
        assert value not in profile.get(_PROFILE_FIELD.get(field, ""), [])
        assert value not in draft[field]
    _assert_absent(body, *_SUSPECT_FRAGMENTS)


def test_a_suspect_primary_role_is_withheld(monkeypatch: pytest.MonkeyPatch, raw_pii: bool):
    body = _extract(monkeypatch, {"primary_role": "Welding, Anil Kumar"})
    assert body["worker_profile_draft"]["primary_role"] is None
    _assert_absent(body, "Anil")


@pytest.mark.parametrize("role", ["VMC Operator", "CNC Setter-Operator", "mig_tig_welder"])
def test_a_certified_primary_role_passes_through_unchanged(
    monkeypatch: pytest.MonkeyPatch, raw_pii: bool, role: str
):
    body = _extract(monkeypatch, {"primary_role": role})
    assert body["worker_profile_draft"]["primary_role"] == role


def test_the_g1_hard_identifier_floor_still_holds(monkeypatch: pytest.MonkeyPatch, raw_pii: bool):
    body = _extract(
        monkeypatch,
        {"skills": ["Tool offset setting", "call 9876543210"], "primary_role": "9876543210"},
    )
    assert body["worker_profile_draft"]["skills"] == ["Tool offset setting"]
    _assert_absent(body, "9876543210")


# --- fail closed ---------------------------------------------------------------------------------


def test_a_certifier_error_withholds_every_draft_label(
    monkeypatch: pytest.MonkeyPatch, raw_pii: bool
):
    def _boom(_labels: list[str]) -> list[str]:
        raise RuntimeError("gateway down")

    monkeypatch.setattr(certified_values_module, "certified_clean_skill_labels", _boom)
    body = _extract(
        monkeypatch,
        {field: [value] for field, value in _CLEAN.items()} | {"primary_role": "Welder"},
    )
    draft = body["worker_profile_draft"]
    assert draft["primary_role"] is None
    for field in profile_extractor.MODEL_LABEL_LIST_FIELDS:
        assert draft[field] == []


def test_the_log_carries_a_count_never_the_value(
    monkeypatch: pytest.MonkeyPatch, raw_pii: bool, caplog: pytest.LogCaptureFixture
):
    with caplog.at_level(logging.DEBUG):
        _extract(monkeypatch, {"skills": list(_SUSPECT), "primary_role": "Welding, Anil Kumar"})
    records = [r for r in caplog.records if "rich draft labels withheld" in r.getMessage()]
    assert len(records) == 1
    assert records[0].extra == {"withheld": 3}  # type: ignore[attr-defined]
    for record in caplog.records:
        rendered = record.getMessage() + json.dumps(getattr(record, "extra", {}), default=str)
        for fragment in _SUSPECT_FRAGMENTS:
            assert fragment not in rendered


# --- differential: clean inputs come back byte-identical ----------------------------------------


@pytest.mark.parametrize("model_answers", ["mock", "real_echo"])
def test_clean_extractions_are_unchanged_over_the_gold_set(
    monkeypatch: pytest.MonkeyPatch, raw_pii: bool, model_answers: str
):
    """Every fabricated transcript in the canonicalization gold set, through the route with the
    certification and without it: 0 differences. `real_echo` makes the model answer the heuristic
    draft on a REAL call, so the overlay path runs too."""

    def _payload(transcript: str) -> dict | None:
        if model_answers == "mock":
            return None
        rich, _legacy = profile_extractor.extract(transcript)
        return rich.model_dump()

    certified = [_extract(monkeypatch, _payload(c.text), c.text) for c in gold.GOLD_CASES]
    monkeypatch.setattr(profile_extractor, "certify_model_labels", lambda draft: (draft, 0))
    uncertified = [_extract(monkeypatch, _payload(c.text), c.text) for c in gold.GOLD_CASES]

    for case, with_gate, without_gate in zip(gold.GOLD_CASES, certified, uncertified, strict=True):
        with_gate.pop("ai_metadata", None)
        without_gate.pop("ai_metadata", None)
        assert with_gate == without_gate, case.text
    # Not vacuous: the gold set carries labels and roles for the certifier to pass through.
    drafts = [body["worker_profile_draft"] for body in certified]
    assert sum(len(d["machines"]) + len(d["skills"]) for d in drafts) > len(drafts)
    assert sum(d["primary_role"] is not None for d in drafts) > len(drafts) // 2
