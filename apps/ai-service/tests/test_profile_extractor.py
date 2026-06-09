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
