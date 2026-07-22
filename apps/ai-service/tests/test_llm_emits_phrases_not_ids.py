"""ADR-0030 SG-3 — the LLM emits PHRASES; it never emits a canonical id.

THE DEFECT THESE LOCK. ADR-0030 §SG-3
(docs/decisions/0030-embedding-skill-canonicalization.md:140) states "The LLM emits
phrases; the vector layer assigns the `skill_id`; the model NEVER invents a `skill_id`",
and §(d):65 "There is no path from a model string to a matchable `skill_id` except
through the embed→match→floor→validate pipeline." The occupation arm has enforced its
half since ADR-0028 (`normalize_role_id`). The SKILLS arm enforced nothing:
`merge_model_draft` copied the model's `skills`/`machines`/`controllers` verbatim
through `_as_str_list` (str + strip, no shape check) and REPLACED the heuristic lists,
so `"skills": ["skill_mig_welding"]` was set on the draft, carried onto
`DraftProfile.skill_labels` by /profile/extract, persisted by apps/api as
`profiles.raw_profile` / `generated_resumes.sourceProfileSnapshot`, and rendered to the
worker and the payer as if the worker had said it. No prompt forbade it and no counter
noticed it.

THE BOUNDARY THESE ALSO LOCK. The ROLE arm deliberately DOES ask the model for one
`canonical_role_id` from a closed set (canonical_roles.canonicalization_instruction,
ADR-0028, validated by normalize_role_id). That design is untouched — several tests
below exist specifically to fail if a future "cleanup" extends the prohibition to it.

Fail direction throughout: DROP the id and keep going. Canonicalization must never block
extraction (the TAX-8 guarantee, ADR-0030 addendum "canonicalization never blocks
extraction").
"""

from __future__ import annotations

import json
import logging

import pytest
from fastapi.testclient import TestClient

from app.contracts import AICallMetadata, DraftProfile, WorkerProfileDraft
from app.main import app
from app.profiling import profile_extractor, prompts

client = TestClient(app)


# --- (a) THE PROMPT carries the prohibition ---------------------------------


def test_extraction_prompt_forbids_ids_in_the_skill_arms():
    text = prompts.EXTRACTION_SYSTEM_PROMPT
    # It must name the arms the rule governs…
    assert "`skills`" in text and "`machines`" in text and "`controllers`" in text
    # …state the prohibition in words the model cannot read as advisory…
    assert "NEVER write a taxonomy or database id" in text
    # …and NAME the shapes, so "no ids" is not left to the model's imagination.
    for shape in ("skill_mig_welding", "mach_vmc", "dom_welding", "role_welder"):
        assert shape in text, f"prompt must name the {shape} shape as forbidden"
    assert "lower_snake_case" in text


def test_extraction_prompt_keeps_the_canonical_role_id_carve_out_explicit():
    """The ROLE arm's closed-set id request (ADR-0028) is appended IMMEDIATELY after
    this prompt by main.py. Without an explicit carve-out the two blocks read as
    contradictory and the model has to guess which one wins."""
    text = prompts.EXTRACTION_SYSTEM_PROMPT
    assert "canonical_role_id" in text
    assert "The ONE exception" in text
    assert "it does not apply to canonical_role_id" in text


def test_extraction_prompt_keeps_its_hinglish_awareness():
    """The prohibition must not push the model toward inventing English terms — an
    unknown skill stays in the worker's own words (the RVM wedge vocabulary)."""
    text = prompts.EXTRACTION_SYSTEM_PROMPT
    assert "KEEP THE WORKER'S OWN HINGLISH WORD" in text
    for wedge_word in ("kharad", "chhilai", "ghisai"):
        assert wedge_word in text


def test_composed_extraction_prompt_states_both_rules_without_contradiction():
    """End-to-end on the ACTUAL composed system block main.py sends: the phrase rule
    and the closed-set role rule coexist, and the carve-out sits between them."""
    from app.profiling.canonical_roles import canonicalization_instruction

    composed = prompts.EXTRACTION_SYSTEM_PROMPT + canonicalization_instruction()
    assert "NEVER write a taxonomy or database id" in composed  # skills arm: no ids
    assert "choosing EXACTLY ONE id from this closed set" in composed  # role arm: one id
    assert composed.index("The ONE exception") < composed.index("CANONICAL ROLE")


# --- (b) THE FILTER: id-shaped in, dropped; phrases in, untouched -----------


@pytest.mark.parametrize(
    "id_shaped",
    [
        "skill_mig_welding",
        "mach_vmc",
        "dom_welding",
        "role_welder",
        "SKILL_MIG_WELDING",  # case-insensitive prefix match
        "  skill_fanuc  ",  # surrounding whitespace does not smuggle it through
        "proc_heat_treatment",  # a prefix nobody enumerated -> general snake shape
        "gd_t_reading",
    ],
)
def test_id_shaped_strings_are_recognised(id_shaped: str):
    assert profile_extractor._is_taxonomy_id_shaped(id_shaped) is True


@pytest.mark.parametrize(
    "phrase",
    [
        "tool offset setting",  # legitimate multi-word phrase
        "drawing reading",
        "MIG welding",
        "welding",  # legitimate single words
        "turning",
        "Fanuc",
        "VMC",
        "CNC Lathe",
        "5-axis setup",
        "kharad",  # RVM wedge Hinglish
        "chhilai",
        "ghisai ka kaam",
        "skill setting",  # "skill" as a WORD, not a prefix
        "machine operation",
    ],
)
def test_real_worker_phrases_are_never_treated_as_ids(phrase: str):
    """The filter must be narrow enough that it cannot eat real language — a false
    positive here silently deletes a skill the worker really has."""
    assert profile_extractor._is_taxonomy_id_shaped(phrase) is False


def test_drop_keeps_the_rest_of_the_list_and_preserves_order():
    labels = ["MIG welding", "skill_tig_welding", "tool offset setting", "mach_vmc"]
    assert profile_extractor.drop_model_taxonomy_ids(labels, field="skills") == [
        "MIG welding",
        "tool offset setting",
    ]


def test_drop_is_observable_with_counts_and_never_logs_the_text(caplog):
    """SG-1 treats worker-derived skill text as HOSTILE (a worker can type an employer
    name into a skills answer), so the warning carries COUNTS and the field name only —
    the same discipline sanitize_skill_labels and main.py's ledger skip already keep."""
    with caplog.at_level(logging.WARNING):
        profile_extractor.drop_model_taxonomy_ids(
            ["skill_mig_welding", "welding"], field="skills"
        )
    records = [r for r in caplog.records if "taxonomy-id-shaped" in r.getMessage()]
    assert len(records) == 1, "the drop must not be silent"
    assert records[0].extra == {"field": "skills", "dropped": 1, "kept": 1}
    # The dropped string itself never appears anywhere in the log record.
    assert "skill_mig_welding" not in str(records[0].__dict__)


def test_a_clean_list_logs_nothing(caplog):
    with caplog.at_level(logging.WARNING):
        out = profile_extractor.drop_model_taxonomy_ids(
            ["MIG welding", "tool offset setting"], field="skills"
        )
    assert out == ["MIG welding", "tool offset setting"]
    assert not [r for r in caplog.records if "taxonomy-id-shaped" in r.getMessage()]


# --- merge_model_draft: the arm where the defect actually lived -------------


def test_merge_model_draft_drops_ids_from_skills_machines_and_controllers():
    base = profile_extractor.extract_worker_profile_draft("", "cnc_vmc")  # all-empty
    content = json.dumps(
        {
            "skills": ["skill_mig_welding", "tool offset setting"],
            "machines": ["mach_vmc", "VMC"],
            "controllers": ["skill_fanuc", "Fanuc"],
        }
    )
    out = profile_extractor.merge_model_draft(base, content)
    assert out.skills == ["tool offset setting"]
    assert out.machines == ["VMC"]
    assert out.controllers == ["Fanuc"]


def test_merge_model_draft_leaves_legitimate_phrases_byte_for_byte_unchanged():
    base = profile_extractor.extract_worker_profile_draft("", "cnc_vmc")
    phrases = {
        "skills": ["tool offset setting", "drawing reading", "MIG welding"],
        "machines": ["VMC", "CNC Lathe"],
        "controllers": ["Fanuc", "Siemens"],
        "education": ["ITI", "Diploma"],
        "certifications": ["NSQF Level 4"],
        "inspection_tools": ["vernier caliper", "micrometer"],
        "materials_handled": ["mild steel", "SS304"],
        "secondary_roles": ["CNC Setter-Operator"],
    }
    out = profile_extractor.merge_model_draft(base, json.dumps(phrases))
    for field, values in phrases.items():
        assert getattr(out, field) == values, f"{field} must survive untouched"


def test_a_wholly_id_list_falls_back_to_the_heuristic_rather_than_emptying_it():
    """An all-id emission is MALFORMED, not "the worker mentioned nothing" — so it takes
    merge_model_draft's documented skip-and-keep-base posture. Writing [] instead would
    let a model answering purely in ids DELETE what the deterministic detector really
    read off the worker's own text."""
    base = profile_extractor.extract_worker_profile_draft(
        "vmc chalata hu fanuc pe, tool offset setting aata hai", "cnc_vmc"
    )
    assert base.machines and base.controllers and base.skills  # honest precondition
    content = json.dumps(
        {
            "skills": ["skill_mig_welding", "skill_tig_welding"],
            "machines": ["mach_vmc"],
            "controllers": ["skill_fanuc"],
        }
    )
    out = profile_extractor.merge_model_draft(base, content)
    assert out.skills == base.skills
    assert out.machines == base.machines
    assert out.controllers == base.controllers


def test_a_genuinely_empty_model_list_still_replaces_as_before():
    """Back-compat guard on the change above: only an ALL-ID list is treated as
    malformed. A real empty array from the model keeps its shipped meaning."""
    base = profile_extractor.extract_worker_profile_draft("vmc chalata hu", "cnc_vmc")
    assert base.machines  # honest precondition
    out = profile_extractor.merge_model_draft(base, json.dumps({"machines": []}))
    assert out.machines == []


def test_merge_model_draft_never_raises_on_an_all_id_payload():
    """TAX-8: canonicalization must never BLOCK extraction. Every other good field in
    the same payload still lands."""
    base = profile_extractor.extract_worker_profile_draft("", "cnc_vmc")
    content = json.dumps(
        {
            "skills": ["skill_a"],
            "machines": ["mach_b"],
            "controllers": ["dom_c"],
            "education": ["role_d"],
            "experience_years": 4.0,
            "operation_knowledge": "strong",
        }
    )
    out = profile_extractor.merge_model_draft(base, content)
    assert out.experience_years == 4.0  # extraction proceeded normally
    assert out.experience_level == "experienced"
    assert out.operation_knowledge == "strong"


def test_the_role_arm_is_deliberately_untouched_by_the_prohibition():
    """ADR-0028's ratified design: `primary_role` is a free-text LABEL the gazetteer
    reverse-lookup reads, and a real observed session emitted the id-shaped
    "mig_tig_welder" there. The skills prohibition must not start eating it."""
    base = profile_extractor.extract_worker_profile_draft("", "cnc_vmc")
    out = profile_extractor.merge_model_draft(
        base, json.dumps({"primary_role": "mig_tig_welder"})
    )
    assert out.primary_role == "mig_tig_welder"
    legacy = profile_extractor.map_rich_to_legacy(out)
    assert legacy.canonical_role_id == "role_welder"  # still canonicalizes


# --- (b) defense in depth: the certify-at-rest pipeline ----------------------


def test_sanitize_skill_labels_drops_ids_before_they_can_persist():
    out = profile_extractor.sanitize_skill_labels(
        ["MIG welding", "skill_mig_welding", "mach_vmc", "tool offset setting"]
    )
    assert out == ["MIG welding", "tool offset setting"]


def test_map_rich_to_legacy_never_persists_an_id_as_a_skill_label():
    """`skill_labels` is documented "NEVER canonical ids" on the contract. Prove the
    mapper honours that even when the rich draft arrives already poisoned — while the
    MATCHABLE `skills` ids it assigns itself (from the gazetteer) are unaffected."""
    rich = WorkerProfileDraft(
        machines=["VMC"], controllers=["Fanuc"], skills=["skill_mig_welding", "MIG welding"]
    )
    legacy = profile_extractor.map_rich_to_legacy(rich)
    assert legacy.skill_labels == ["MIG welding"]
    assert all(not label.startswith("skill_") for label in legacy.skill_labels)
    # The gazetteer-assigned matchable ids are the layer that IS allowed to hold ids.
    assert "skill_fanuc" in legacy.skills
    assert "mach_vmc" in legacy.machines


# --- (c) endpoint level: nothing id-shaped survives to the persisted profile -


def _real_meta() -> AICallMetadata:
    return AICallMetadata(
        ai_call_id="t-adr36",
        task_type="profile_extraction",
        model_name="mock",
        provider="mock",
        real_call=True,  # the merge_model_draft overlay only runs on the real branch
        success=True,
        created_at="1970-01-01T00:00:00Z",
    )


def _patch_router(monkeypatch, payload: dict) -> None:
    async def _fake_run(task_type, *, messages, mock_response, **_kwargs):
        return json.dumps(payload), _real_meta()

    from app import main

    monkeypatch.setattr(main.router, "run", _fake_run)


def test_extract_endpoint_never_persists_a_model_emitted_id_as_a_label(monkeypatch):
    """The whole point, end to end. This response IS what apps/api stores as
    profiles.raw_profile and later renders on the résumé + payer disclosure."""
    _patch_router(
        monkeypatch,
        {
            "skills": ["skill_mig_welding", "MIG welding"],
            "machines": ["mach_vmc", "VMC"],
            "controllers": ["skill_fanuc", "Fanuc"],
        },
    )
    res = client.post("/profile/extract", json={"transcript": "welding ka kaam karta hu"})
    assert res.status_code == 200
    body = res.json()

    labels = body["profile"]["skill_labels"]
    assert "MIG welding" in labels
    assert not any(profile_extractor._is_taxonomy_id_shaped(label) for label in labels)

    draft = body["worker_profile_draft"]
    assert draft["skills"] == ["MIG welding"]
    assert draft["machines"] == ["VMC"]
    assert draft["controllers"] == ["Fanuc"]


def test_extract_endpoint_completes_when_the_model_answers_only_in_ids(monkeypatch):
    """TAX-8 at the boundary: an all-id model answer degrades to the heuristic profile.
    It must NOT block, error, or return extraction_status != completed."""
    _patch_router(
        monkeypatch,
        {
            "skills": ["skill_tool_offset_setting"],
            "machines": ["mach_vmc"],
            "controllers": ["skill_fanuc"],
            "experience_years": 4.0,
        },
    )
    res = client.post(
        "/profile/extract",
        json={"transcript": "vmc chalata hu fanuc pe, tool offset setting aata hai"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["blocked"] is False
    assert body["extraction_status"] == "completed"
    assert body["worker_profile_draft"]["experience_years"] == 4.0  # model field kept

    # The heuristic's own labels survived instead of being emptied by the poisoned lists.
    assert body["worker_profile_draft"]["machines"] == ["VMC"]
    assert "tool offset setting" in body["profile"]["skill_labels"]
    # And no id leaked into any human-visible label field.
    assert not any(
        profile_extractor._is_taxonomy_id_shaped(label)
        for label in body["profile"]["skill_labels"]
    )


def test_extract_endpoint_still_honours_a_model_canonical_role_id(monkeypatch):
    """The ADR-0028 arm must keep working through all of this: the model's closed-set
    `canonical_role_id` is still read and still trusted after validation."""
    _patch_router(
        monkeypatch,
        {"canonical_role_id": "role_cnc_programmer", "skills": ["program editing"]},
    )
    res = client.post("/profile/extract", json={"transcript": "cnc program banata hu"})
    assert res.status_code == 200
    profile = res.json()["profile"]
    assert profile["canonical_role_id"] == "role_cnc_programmer"
    assert profile["canonical_trade_id"] == "dom_programming"


def test_extract_endpoint_rejects_a_hallucinated_role_id_unchanged(monkeypatch):
    """The other half of the ADR-0028 boundary, re-asserted here so a future change to
    the skills filter cannot quietly weaken it: an id outside the closed set is refused
    and the heuristic role stands."""
    _patch_router(monkeypatch, {"canonical_role_id": "role_astronaut"})
    res = client.post("/profile/extract", json={"transcript": "vmc chalata hu"})
    assert res.status_code == 200
    assert res.json()["profile"]["canonical_role_id"] == "role_vmc_operator"


def test_old_persisted_profiles_with_id_labels_are_not_rejected_on_parse():
    """Backward compatibility (§2 #8): the filter is a POPULATION-time drop, not a
    contract constraint. A DraftProfile persisted before this change — id-shaped labels
    and all — must still parse; nothing about the shipped shape changed."""
    old = DraftProfile.model_validate({"skill_labels": ["skill_mig_welding"], "skills": []})
    assert old.skill_labels == ["skill_mig_welding"]
