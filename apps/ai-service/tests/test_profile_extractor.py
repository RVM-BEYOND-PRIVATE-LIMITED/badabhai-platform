"""Messy-text → clean-profile extractor tests."""

from app.profiling import profile_extractor

# The spec's worked example.
_MESSY = (
    "bhai vmc chalata hu 4 sal se fanuc pe, setting thoda aata hai, "
    "drawing pad leta hu, salary 22k, faridabad me hu, pune bhi chalega"
)


def test_messy_text_becomes_clean_profile():
    rich = profile_extractor.extract_worker_profile_draft(_MESSY, "cnc_vmc")
    assert rich.role_family == "cnc_vmc"
    assert rich.primary_role == "VMC Operator"
    assert "VMC" in rich.machines
    assert "Fanuc" in rich.controllers
    assert rich.experience_years == 4
    assert rich.experience_level == "experienced"
    assert rich.setting_knowledge == "basic"
    assert rich.operation_knowledge == "strong"
    assert rich.drawing_reading is True
    assert rich.current_city == "Faridabad"
    assert "Pune" in rich.preferred_locations
    assert rich.relocation_willingness is True
    assert rich.current_salary == 22000


def test_missing_fields_and_clarifications_are_detected():
    rich = profile_extractor.extract_worker_profile_draft(_MESSY, "cnc_vmc")
    assert "expected_salary" in rich.missing_fields
    assert "availability" in rich.missing_fields
    # Clarification questions are generated for missing fields.
    assert len(rich.clarification_questions) >= 1
    assert any("salary" in q.lower() for q in rich.clarification_questions)


def test_secondary_role_inferred_for_operator_who_sets():
    rich = profile_extractor.extract_worker_profile_draft(_MESSY, "cnc_vmc")
    assert "CNC Setter-Operator" in rich.secondary_roles


def test_legacy_draft_profile_uses_taxonomy_ids():
    _rich, legacy = profile_extractor.extract(_MESSY, "cnc_vmc")
    assert legacy.canonical_role_id == "role_vmc_operator"
    assert legacy.canonical_trade_id == "dom_vmc_machining"
    assert "mach_vmc" in legacy.machines
    assert "skill_fanuc" in legacy.skills
    assert legacy.experience.total_years == 4
    assert legacy.salary_expectation.amount_min == 22000


def test_confidence_in_unit_range():
    rich = profile_extractor.extract_worker_profile_draft(_MESSY, "cnc_vmc")
    assert 0.0 <= rich.confidence_score <= 1.0


def test_empty_text_is_low_confidence_with_missing_fields():
    rich = profile_extractor.extract_worker_profile_draft("hello bhai", "cnc_vmc")
    assert rich.primary_role is None
    assert rich.confidence_score < 0.5
    assert "primary_role" in rich.missing_fields


def test_merge_model_draft_keeps_good_fields_despite_malformed_siblings():
    """The real-world failure: the model returns experience_years + machines
    correctly but nulls/loose-types other fields (and fences the JSON). Strict
    validation would discard everything; merge_model_draft keeps the good fields."""
    base = profile_extractor.extract_worker_profile_draft("", "cnc_vmc")  # all-empty
    content = (
        "```json\n"
        '{"role_family": null, "primary_role": null, "experience_years": 1.5, '
        '"experience_level": "basic", "machines": ["CNC"], '
        '"programming_knowledge": null, "operation_knowledge": "basic", '
        '"availability": null, "education": null}\n'
        "```"
    )
    out = profile_extractor.merge_model_draft(base, content)
    assert out.experience_years == 1.5              # captured (was lost before)
    assert out.machines == ["CNC"]                  # captured
    assert out.operation_knowledge == "basic"       # valid enum kept
    assert out.experience_level == "junior"         # recomputed from 1.5 (not "basic")
    assert out.availability == "unknown"            # null ignored -> default kept
    assert out.education == []                       # null ignored -> default kept
    assert out.role_family == "cnc_vmc"             # null ignored -> default kept


def test_merge_model_draft_ignores_unparseable_content():
    base = profile_extractor.extract_worker_profile_draft("vmc 4 saal", "cnc_vmc")
    # Garbage / non-object content -> base returned unchanged.
    assert profile_extractor.merge_model_draft(base, "not json").machines == base.machines
    assert profile_extractor.merge_model_draft(base, "[1,2,3]").primary_role == base.primary_role


def test_merge_model_draft_does_not_overlay_location_or_salary():
    # The model only sees masked text; location/salary must stay from the local base.
    base = profile_extractor.extract_worker_profile_draft(
        "vmc 4 saal faridabad me 22k", "cnc_vmc"
    )
    content = '{"current_city": "[CITY_1]", "current_salary": 99999, "machines": ["VMC"]}'
    out = profile_extractor.merge_model_draft(base, content)
    assert out.current_city == base.current_city      # NOT overwritten by the model
    assert out.current_salary == base.current_salary  # NOT overwritten
    assert "VMC" in out.machines                       # non-local field still overlaid


def test_issue_423_current_city_is_not_emitted_as_a_preferred_location():
    """The legacy shape must keep "where I am" separate from "where I'll work".

    _MESSY says "faridabad me hu, pune bhi chalega" — I am IN Faridabad, Pune ALSO
    works. Before the split, _build_legacy prepended the current city to
    preferred_cities, so Faridabad was recorded as somewhere the worker had asked
    to be placed. The engine never conflated them (question_bank: "current AND
    preferred location, never conflated"); only the legacy projection did.
    """
    _rich, legacy = profile_extractor.extract(_MESSY, "cnc_vmc")
    loc = legacy.location_preference

    assert loc.current_city == "Faridabad"
    assert "Faridabad" not in loc.preferred_cities
    assert "Pune" in loc.preferred_cities


def test_issue_423_no_stated_preference_leaves_preferred_empty_not_the_current_city():
    """The path that made an ai-service-only fix unsafe.

    current_location is ESSENTIAL (must be answered); preferred_locations is only
    MUST_ASK (may go unanswered), so "city known, no preference stated" is a
    designed-for outcome — and it is precisely the case where the old code invented
    a preference. preferred_cities must stay EMPTY here, which is why every
    consumer reads current_city first and falls back to the array.
    """
    _rich, legacy = profile_extractor.extract("vmc 4 saal faridabad me hu", "cnc_vmc")
    loc = legacy.location_preference

    assert loc.current_city == "Faridabad"
    assert loc.preferred_cities == []
