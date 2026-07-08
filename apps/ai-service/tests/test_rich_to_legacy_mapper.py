"""Rich->legacy canonical mapper + adjacency flag (WS4).

``map_rich_to_legacy`` canonicalizes the MODEL-emitted rich LABELS into the legacy
DraftProfile's closed-set ids, backfilling only what the raw-text detector missed
and writing ONLY real gazetteer ids (never free text into matchable fields). When
nothing canonicalizes (welding), the ids stay null and the profile is flagged
adjacent via ``unmatchable_reason`` — advisory only, never a rank/reject.
"""

from app.contracts import DraftProfile, WorkerProfileDraft
from app.profiling import profile_extractor
from app.profiling.canonical_roles import ROLE_TRADE


def test_in_scope_labels_map_to_canonical_ids():
    rich = WorkerProfileDraft(
        primary_role="VMC Operator",
        machines=["VMC"],
        controllers=["Fanuc"],
        skills=["tool offset setting"],
    )
    legacy = profile_extractor.map_rich_to_legacy(rich)
    assert legacy.canonical_role_id == "role_vmc_operator"
    assert legacy.canonical_trade_id == "dom_vmc_machining"
    assert "mach_vmc" in legacy.machines
    assert "skill_fanuc" in legacy.skills
    assert "skill_tool_offset_setting" in legacy.skills
    assert profile_extractor.is_outside_cnc_vmc_scope(legacy) is False


def test_only_closed_set_ids_are_ever_written():
    # Whatever the label soup, canonical_role_id is either a real id or None.
    rich = WorkerProfileDraft(primary_role="CNC Turner/Operator", machines=["CNC Lathe"])
    legacy = profile_extractor.map_rich_to_legacy(rich)
    assert legacy.canonical_role_id in ROLE_TRADE
    assert all(m.startswith("mach_") for m in legacy.machines)


def test_welding_yields_null_and_is_flagged_adjacent():
    rich = WorkerProfileDraft(
        primary_role="mig_tig_welder",
        skills=["mig welding", "tig welding"],
        machines=[],
    )
    legacy = profile_extractor.map_rich_to_legacy(rich)
    assert legacy.canonical_role_id is None
    assert legacy.canonical_trade_id is None
    assert legacy.machines == []
    assert legacy.skills == []
    assert profile_extractor.is_outside_cnc_vmc_scope(legacy) is True


def test_backfill_only_fills_missing_role_never_overrides():
    base = DraftProfile(
        canonical_role_id="role_cnc_programmer", canonical_trade_id="dom_programming"
    )
    rich = WorkerProfileDraft(primary_role="VMC Operator")  # would map to vmc
    legacy = profile_extractor.map_rich_to_legacy(rich, base)
    # The already-set (authoritative) role wins; the label does NOT override it.
    assert legacy.canonical_role_id == "role_cnc_programmer"


def test_machines_and_skills_union_with_base():
    base = DraftProfile(machines=["mach_vmc"], skills=["skill_fanuc"])
    rich = WorkerProfileDraft(machines=["HMC"], controllers=["Siemens"])
    legacy = profile_extractor.map_rich_to_legacy(rich, base)
    assert set(legacy.machines) == {"mach_vmc", "mach_hmc"}
    assert set(legacy.skills) == {"skill_fanuc", "skill_siemens"}


def test_mapper_does_not_mutate_base():
    base = DraftProfile()
    profile_extractor.map_rich_to_legacy(WorkerProfileDraft(machines=["VMC"]), base)
    assert base.machines == []
    assert base.canonical_role_id is None


def test_adjacency_matches_heuristic_extract_for_cnc_vs_welding():
    # An in-scope CNC profile is NOT adjacent; a welder IS.
    _rich_cnc, legacy_cnc = profile_extractor.extract("vmc operator, fanuc, 4 saal, pune")
    assert profile_extractor.is_outside_cnc_vmc_scope(legacy_cnc) is False

    _rich_weld, legacy_weld = profile_extractor.extract("mig tig welding karta hu")
    assert profile_extractor.is_outside_cnc_vmc_scope(legacy_weld) is True
