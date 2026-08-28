"""One bad employment must not cost the worker his whole profile (R7).

MEASURED, NOT IMAGINED. Five synthetic CNC-turner personas were run through the real Phase C
extraction against a live Gemini call. Two of the five came back with ``"work_done": null`` on one
employment, and both lost EVERYTHING — role, skills, city, salary, availability and every other
employment — because ``experiences`` is the one list-of-objects in the contract and a nested
failure fails the whole ``model_validate``.

The loss was silent in the worst way: the handler returns ``InterviewExtractOutput(is_mock=True)``,
which every downstream reader treats as "no interview happened" rather than as "the interview
happened and was thrown away". `p3` produced 22 skills and 2 employments and rendered a sheet with
none of them.

Two independent fixes, and this file pins both:
  1. ``ExperienceEntry`` coerces a null ``duration_text`` / ``work_done`` to "" — the honest
     reading, since "" is already how that schema says "nothing recorded here";
  2. the extract handler retries once with individually-invalid entries dropped, so the NEXT
     model quirk in this position costs one job rather than the profile.

Either alone would have saved those two personas. Both are here because (1) fixes the instance
and (2) fixes the class.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.contracts import ExperienceEntry, InterviewExtractOutput
from app.routers.profiling import _without_bad_experiences


# ---------------------------------------------------------------------------
# (1) the coercion
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("field", ["work_done", "duration_text"])
def test_a_null_text_field_is_read_as_nothing_recorded(field: str):
    entry = ExperienceEntry.model_validate({"role_label": "CNC Turner", field: None})
    assert getattr(entry, field) == ""


def test_the_whole_profile_survives_a_null_work_done():
    # THE EXACT SHAPE THE MODEL PRODUCED for persona 3. Before the coercion this raised and the
    # handler returned an empty is_mock output, discarding all four other fields.
    out = InterviewExtractOutput.model_validate(
        {
            "role_label": "CNC Turner",
            "skills": ["turning", "boring"],
            "current_city": "Pune",
            "expected_salary": 22000,
            "experiences": [
                {"role_label": "CNC Operator", "duration_text": "Feb 2023 se", "work_done": None}
            ],
        }
    )
    assert out.role_label == "CNC Turner"
    assert out.skills == ["turning", "boring"]
    assert out.current_city == "Pune"
    assert out.experiences[0].work_done == ""


def test_an_ABSENT_field_still_defaults_the_same_way():
    # The coercion must not have changed the pre-existing behaviour it sits beside.
    assert ExperienceEntry.model_validate({"role_label": "Turner"}).work_done == ""


def test_a_non_string_that_is_not_null_is_STILL_refused():
    # The widening is exactly one value wide. A number here is a model that misunderstood the
    # field, not a model saying "nothing recorded", and it must still fail.
    with pytest.raises(ValidationError):
        ExperienceEntry.model_validate({"role_label": "Turner", "work_done": 42})


def test_an_employer_name_is_still_forbidden_outright():
    # §2's rule, re-asserted beside a leniency change — the one place a widening here could do
    # real damage is if it softened `extra="forbid"`.
    with pytest.raises(ValidationError):
        ExperienceEntry.model_validate({"role_label": "Turner", "employer_name": "Tata Steel"})


# ---------------------------------------------------------------------------
# (2) the entry-tolerant retry
# ---------------------------------------------------------------------------


def test_only_the_invalid_entry_is_dropped():
    raw = {
        "role_label": "CNC Turner",
        "experiences": [
            {"role_label": "Good One", "work_done": "turning"},
            {"role_label": "", "work_done": "this one has an empty required role"},
            {"role_label": "Also Good", "work_done": "boring"},
        ],
    }
    cleaned = _without_bad_experiences(raw)
    assert [e["role_label"] for e in cleaned["experiences"]] == ["Good One", "Also Good"]
    # And everything outside the list is untouched — the point is to keep the rest of the profile.
    assert cleaned["role_label"] == "CNC Turner"
    assert InterviewExtractOutput.model_validate(cleaned).role_label == "CNC Turner"


def test_it_leaves_a_body_with_no_experiences_alone():
    raw = {"role_label": "Turner", "skills": ["turning"]}
    assert _without_bad_experiences(raw) == raw


def test_it_does_NOT_rescue_a_malformed_scalar():
    # The retry is the narrowest possible widening of an all-or-nothing gate: it drops bad list
    # ENTRIES and re-validates the outer object unchanged. A bad scalar must still fail the
    # parse, or "the model's body could not be read" would stop meaning anything.
    raw = {"role_label": "Turner", "expected_salary": "not a number", "experiences": []}
    with pytest.raises(ValidationError):
        InterviewExtractOutput.model_validate(_without_bad_experiences(raw))


def test_it_refuses_a_body_that_is_not_an_object():
    # Deliberately raises rather than returning {}: the caller's except branch is the honest
    # "unreadable body" path, and this is that case.
    with pytest.raises(TypeError):
        _without_bad_experiences([{"role_label": "Turner"}])
