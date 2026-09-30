"""#1739: the résumé's single-value fields go through the SAME clean-or-withhold certification as
its label lists, through the real routes.

Before this, `certified_clean_skill_labels` certified `skill_labels`, `education` and
`certifications` at the résumé boundary, while the location preference and the education
level/field reached `build_resume` (the résumé text), `resume_json` and the LLM payload
uncertified. The payload gate masks only what the MODEL sees, and it leaves a name behind a
leading city or trade word ("Pune, Ramesh Kumar", "Welding, Anil Kumar") untouched, so those
reached the model verbatim as well.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.contracts import AICallMetadata
from app.pseudonymize import is_certified_clean, pseudonymize

client = TestClient(main_module.app)


def _meta(*, real_call: bool, task_type: str) -> AICallMetadata:
    return AICallMetadata(
        ai_call_id="00000000-0000-4000-8000-000000000000",
        task_type=task_type,
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


def _generate(monkeypatch: pytest.MonkeyPatch, profile: dict) -> tuple[list[str], dict, str]:
    """(résumé text lines, resume_json, the user message the route hands the model)."""
    seen: dict = {}

    async def _capture(*_a, **kwargs):
        seen["messages"] = kwargs["messages"]
        return kwargs["mock_response"], _meta(real_call=False, task_type="resume_generation")

    monkeypatch.setattr(main_module.router, "run", _capture)
    res = client.post("/resume/generate", json={"worker_ref": "w1", "profile": profile})
    assert res.status_code == 200
    body = res.json()
    return body["resume_text"].splitlines(), body["resume_json"], seen["messages"][-1]["content"]


def _assert_absent_everywhere(
    fragments: tuple[str, ...], lines: list[str], data: dict, sent: str
) -> None:
    text, stored = "\n".join(lines), json.dumps(data, ensure_ascii=False)
    for fragment in fragments:
        assert fragment not in text, "printed on the résumé"
        assert fragment not in stored, "carried in resume_json"
        assert fragment not in sent, "sent to the model"


def _no_line(lines: list[str], label: str) -> bool:
    return not any(line.startswith(label) for line in lines)


# --- a certified value passes through unchanged -------------------------------------------------


@pytest.mark.parametrize("city", ["Pune", "Pune, Maharashtra", "Faridabad, Haryana", "Navi Mumbai"])
def test_a_certified_current_city_passes_through_unchanged(
    monkeypatch: pytest.MonkeyPatch, city: str
):
    lines, data, sent = _generate(monkeypatch, {"location_preference": {"current_city": city}})
    assert f"Current location: {city}" in lines
    assert data["location_preference"]["current_city"] == city
    assert city in sent


@pytest.mark.parametrize("level", ["ITI", "10th pass", "Diploma", "12th", "B.Tech"])
def test_a_certified_education_level_passes_through_unchanged(
    monkeypatch: pytest.MonkeyPatch, level: str
):
    lines, data, sent = _generate(monkeypatch, {"education_level": level})
    assert f"Education level: {level}" in lines
    assert data["education_level"] == level
    assert level in sent


@pytest.mark.parametrize("field", ["Mechanical", "Electronics", "Fitter"])
def test_a_certified_education_field_passes_through_unchanged(
    monkeypatch: pytest.MonkeyPatch, field: str
):
    lines, data, sent = _generate(monkeypatch, {"education_field": field})
    assert f"Field of study: {field}" in lines
    assert data["education_field"] == field
    assert field in sent


def test_the_employer_rescue_applies_to_a_single_value_exactly_as_to_the_list(
    monkeypatch: pytest.MonkeyPatch,
):
    """ONE certifier. The employer pattern over-fires on this real qualification, and the FIX-5
    rescue keeps it in the `education` LIST; the scalar must be kept identically, not withheld
    by a stricter predicate the list does not use."""
    value = "Diploma Mechanical Engineering"
    assert pseudonymize(value).text == "[EMPLOYER_1]"  # the over-fire the rescue exists for
    assert is_certified_clean(value) is False  # so a bare predicate would withhold it
    lines, data, _sent = _generate(monkeypatch, {"education_field": value, "education": [value]})
    assert f"Field of study: {value}" in lines
    assert f"Education: {value}" in lines
    assert data["education_field"] == value


# --- a failing value is withheld from the text, resume_json and the payload ---------------------


@pytest.mark.parametrize(
    ("field", "value", "fragments", "line"),
    [
        # The gateway masks the leading name: altered, so withheld.
        ("current_city", "Ramesh, Pune", ("Ramesh",), "Current location:"),
        # The gateway leaves this untouched; a leading city does not vouch for the name after it.
        ("current_city", "Pune, Ramesh Kumar", ("Ramesh", "Kumar"), "Current location:"),
        # Same, behind a leading trade/education word (#1728 / #1729).
        ("education_level", "Diploma, Anil Sharma", ("Anil", "Sharma"), "Education level:"),
        ("education_field", "Welding, Anil Kumar", ("Anil", "Kumar"), "Field of study:"),
        # An identity class the gateway masks.
        ("education_level", "12th, call 9876543210", ("9876543210",), "Education level:"),
    ],
)
def test_a_value_that_fails_certification_is_withheld_everywhere(
    monkeypatch: pytest.MonkeyPatch, field: str, value: str, fragments: tuple[str, ...], line: str
):
    assert is_certified_clean(value) is False  # precondition: the certifier rejects it
    if field == "current_city":
        profile: dict = {"location_preference": {"current_city": value}}
    else:
        profile = {field: value}
    lines, data, sent = _generate(monkeypatch, profile)
    assert _no_line(lines, line)
    stored = data["location_preference"]["current_city"] if field == "current_city" else data[field]
    assert stored is None
    _assert_absent_everywhere(fragments, lines, data, sent)


def test_preferred_cities_drop_only_the_entry_that_fails(monkeypatch: pytest.MonkeyPatch):
    cities = ["Mumbai", "Pune, Ramesh Kumar", "Pune, Maharashtra"]
    lines, data, sent = _generate(
        monkeypatch, {"location_preference": {"preferred_cities": cities}}
    )
    assert "Preferred locations: Mumbai, Pune, Maharashtra" in lines
    assert data["location_preference"]["preferred_cities"] == ["Mumbai", "Pune, Maharashtra"]
    _assert_absent_everywhere(("Ramesh", "Kumar"), lines, data, sent)


def test_the_container_location_the_resume_prints_first_is_certified_too(
    monkeypatch: pytest.MonkeyPatch,
):
    """`build_resume` prints the Phase C container's location AHEAD of `location_preference`, and
    every interview-led profile carries both, so certifying only the legacy pair would leave the
    line the résumé actually prints uncertified. A withheld container value leaves the certified
    legacy value to fill the line."""
    lines, data, sent = _generate(
        monkeypatch,
        {
            "location_preference": {"current_city": "Pune", "preferred_cities": ["Mumbai"]},
            "resume_profile": {
                "current_city": "Pune, Ramesh Kumar",
                "preferred_locations": ["Welding, Anil Kumar", "Chennai"],
            },
        },
    )
    assert "Current location: Pune" in lines
    assert "Preferred locations: Chennai" in lines
    assert data["resume_profile"]["current_city"] is None
    assert data["resume_profile"]["preferred_locations"] == ["Chennai"]
    _assert_absent_everywhere(("Ramesh", "Anil", "Kumar"), lines, data, sent)


def test_a_certifier_error_withholds_every_single_value_and_the_resume_still_completes(
    monkeypatch: pytest.MonkeyPatch,
):
    """FAIL CLOSED: an error while certifying withholds the value, never passes it through, and
    never costs the worker the résumé."""
    import app.certified_values as certified_values

    def broken(_labels: list[str]) -> list[str]:
        raise RuntimeError("certifier unavailable")

    monkeypatch.setattr(certified_values, "certified_clean_skill_labels", broken)
    lines, data, _sent = _generate(
        monkeypatch,
        {
            "canonical_role_id": "role_vmc_operator",
            "education_level": "ITI",
            "education_field": "Mechanical",
            "location_preference": {"current_city": "Pune", "preferred_cities": ["Mumbai"]},
            "resume_profile": {"current_city": "Pune", "preferred_locations": ["Mumbai"]},
        },
    )
    assert "WORKER PROFILE (DRAFT)" in lines
    for label in (
        "Education level:",
        "Field of study:",
        "Current location:",
        "Preferred locations:",
    ):
        assert _no_line(lines, label)
    assert data["education_level"] is None
    assert data["education_field"] is None
    assert data["location_preference"]["current_city"] is None
    assert data["location_preference"]["preferred_cities"] == []
    assert data["resume_profile"]["current_city"] is None
    assert data["resume_profile"]["preferred_locations"] == []


def test_the_withheld_log_carries_a_count_and_never_the_value(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    with caplog.at_level(logging.DEBUG, logger="ai-service"):
        _generate(
            monkeypatch,
            {
                "education_field": "Welding, Anil Kumar",
                "location_preference": {"preferred_cities": ["Pune, Ramesh Kumar", "Mumbai"]},
            },
        )
    records = [r for r in caplog.records if "single-value fields withheld" in r.getMessage()]
    assert len(records) == 1
    assert records[0].extra == {"withheld": 2}  # type: ignore[attr-defined]
    for record in caplog.records:
        rendered = record.getMessage() + json.dumps(getattr(record, "extra", {}))
        for fragment in ("Anil", "Ramesh", "Kumar"):
            assert fragment not in rendered


# --- /profile/extract: the model-authored education values are certified at rest ----------------


def _extract(monkeypatch: pytest.MonkeyPatch, model_payload: dict) -> dict:
    """The persisted (legacy) profile /profile/extract returns when the model answers
    ``model_payload`` on a REAL call (the model overlay runs only on that branch)."""

    async def _fake_run(*_a, **_kwargs):
        return json.dumps(model_payload), _meta(real_call=True, task_type="profile_extraction")

    monkeypatch.setattr(main_module.router, "run", _fake_run)
    return _extract_body(monkeypatch, model_payload)["profile"]


def _extract_body(monkeypatch: pytest.MonkeyPatch, model_payload: dict) -> dict:
    """The whole /profile/extract response for a REAL call answering ``model_payload``."""

    async def _fake_run(*_a, **_kwargs):
        return json.dumps(model_payload), _meta(real_call=True, task_type="profile_extraction")

    monkeypatch.setattr(main_module.router, "run", _fake_run)
    res = client.post("/profile/extract", json={"transcript": "vmc chalata hu"})
    assert res.status_code == 200
    return res.json()


def test_extract_withholds_a_model_authored_education_value_that_fails_certification(
    monkeypatch: pytest.MonkeyPatch,
):
    profile = _extract(
        monkeypatch,
        {"education_level": "Diploma, Anil Sharma", "education_field": "Welding, Anil Kumar"},
    )
    assert profile["education_level"] is None
    assert profile["education_field"] is None
    assert "Anil" not in json.dumps(profile, ensure_ascii=False)


def test_extract_keeps_a_certified_education_value_unchanged(monkeypatch: pytest.MonkeyPatch):
    profile = _extract(
        monkeypatch, {"education_level": "ITI", "education_field": "Diploma Mechanical Engineering"}
    )
    assert profile["education_level"] == "ITI"
    assert profile["education_field"] == "Diploma Mechanical Engineering"


def test_extract_withholds_the_education_value_from_the_stored_rich_draft_too(
    monkeypatch: pytest.MonkeyPatch,
):
    """`worker_profile_draft` is stored as `rich_profile_draft`: a value withheld from the profile
    must not be stored beside it (security review of #1739)."""
    body = _extract_body(
        monkeypatch,
        {"education_level": "Diploma, Anil Sharma", "education_field": "Welding, Anil Kumar"},
    )
    assert body["worker_profile_draft"]["education_level"] is None
    assert body["worker_profile_draft"]["education_field"] is None
    assert "Anil" not in json.dumps(body, ensure_ascii=False)


def _profiling_extract(monkeypatch: pytest.MonkeyPatch, extracted: dict) -> dict:
    """/profiling/extract (the interview's Phase C container) with the model answering
    ``extracted`` on a real call."""

    async def _fake_run(*_a, **_kwargs):
        return json.dumps(extracted), _meta(real_call=True, task_type="profiling_extract")

    monkeypatch.setattr(main_module.router, "run", _fake_run)
    res = client.post(
        "/profiling/extract",
        json={
            "worker_ref": "w1",
            "transcript": [{"i": 0, "role": "worker", "text": "welder hu"}],
        },
    )
    assert res.status_code == 200
    return res.json()


def test_profiling_extract_withholds_a_name_bearing_location(monkeypatch: pytest.MonkeyPatch):
    """THE ROUTE WHERE THE MODEL WRITES THE LOCATION. apps/api stores this container and prints its
    `current_city` on the worker's and the employer's PDF. A blocked-only check passed a name
    behind a leading city (security review of #1739)."""
    body = _profiling_extract(
        monkeypatch,
        {
            "current_city": "Pune, Ramesh Kumar",
            "preferred_locations": ["Ramesh, Pune", "Pune, Ramesh Kumar", "Chennai"],
        },
    )
    assert body["current_city"] is None
    assert body["preferred_locations"] == ["Chennai"]
    assert "Ramesh" not in json.dumps(body, ensure_ascii=False)


def test_profiling_extract_keeps_a_certified_location_unchanged(monkeypatch: pytest.MonkeyPatch):
    body = _profiling_extract(
        monkeypatch,
        {"current_city": "Pune, Maharashtra", "preferred_locations": ["Pune", "Navi Mumbai"]},
    )
    assert body["current_city"] == "Pune, Maharashtra"
    assert body["preferred_locations"] == ["Pune", "Navi Mumbai"]
