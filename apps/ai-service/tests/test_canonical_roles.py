"""Tests for LLM role canonicalization wiring (no network, no LLM).

Covers the closed-set validation (``canonical_roles``) and the endpoint's lenient
role-id extraction — a correct ``canonical_role_id`` MUST survive even when the
model nulls/loosely-types other enrichment fields (the real-run bug we fixed).
"""

from __future__ import annotations

from app.profiling import canonical_roles as cr


def test_role_trade_covers_the_launch_roles_plus_welder():
    # TAX-WELD-1: role_welder joins the CLOSED set (a wider enumerated whitelist —
    # ADR-0028 §(d) — never free text). The 7 machining ids are unchanged.
    # TD94 (owner ruling 2026-07-21, #460): role_cnc_operator joins it the same way,
    # for the product's own core persona — a worker who says "CNC operator" and names
    # no machine family. The 8 ids above it are unchanged, and APPENDED is the whole
    # point: ADR-0028 keeps the id space closed and immutable, so it only ever grows.
    assert set(cr.ROLE_IDS) == {
        "role_vmc_operator",
        "role_hmc_operator",
        "role_cnc_turner_operator",
        "role_cnc_setter_operator",
        "role_cnc_grinding_operator",
        "role_cnc_programmer",
        "role_cam_programmer",
        "role_welder",
        "role_cnc_operator",
    }
    # ORDER, not just membership: `ROLE_IDS` is `tuple(ROLE_TRADE)`, so a row inserted
    # rather than appended would silently renumber the list the model is shown.
    assert cr.ROLE_IDS[-1] == "role_cnc_operator"
    # Every id maps to a trade id.
    assert all(cr.ROLE_TRADE[r] for r in cr.ROLE_IDS)
    assert cr.ROLE_TRADE["role_welder"] == "dom_welding"
    # The generic sits in the EXISTING CNC machining domain — no domain was minted.
    assert cr.ROLE_TRADE["role_cnc_operator"] == "dom_cnc_machining"
    # Every advertised id carries a description (the model is never shown a bare id).
    assert set(cr.ROLE_DESCRIPTIONS) == set(cr.ROLE_IDS)


def test_the_generic_cnc_role_is_described_to_the_model_as_a_fallback():
    """TD94: the id is only safe if the model is told it is a LAST resort.

    A model shown a bare "generic CNC operator" line next to six specialisations will
    happily choose it for "vmc chalata hu" — which would DOWNGRADE a worker who named
    their machine family, the one outcome the mint must never cause. So the closed-set
    listing and the rules block both say so, and both are asserted rather than trusted.
    """
    text = cr.canonicalization_instruction()
    assert "role_cnc_operator" in text
    assert "FALLBACK" in cr.ROLE_DESCRIPTIONS["role_cnc_operator"]
    # The rule names the specialisations that must win, so the instruction cannot be
    # trimmed to a bare id line without this failing.
    assert "never a replacement for a stated specialisation" in text
    for specific in ("vmc operator", "cnc turner", "cnc setter", "cnc programmer"):
        assert specific in text


def test_normalize_role_id_accepts_only_known_ids():
    assert cr.normalize_role_id("role_vmc_operator") == "role_vmc_operator"
    assert cr.normalize_role_id("role_made_up") is None
    assert cr.normalize_role_id(None) is None
    assert cr.normalize_role_id(123) is None
    assert cr.normalize_role_id("") is None


def test_canonicalization_instruction_lists_the_closed_set():
    text = cr.canonicalization_instruction()
    for rid in cr.ROLE_IDS:
        assert rid in text
    assert "null" in text  # the model is told it may answer null


def test_extract_canonical_role_id_survives_malformed_siblings():
    # The model returns a correct role id but nulls strict enrichment fields; the
    # role id must still be recoverable (independent of full-draft validation).
    # Lives in canonical_roles now, shared by the endpoint AND the onboarding CLI.
    from app.profiling.canonical_roles import extract_canonical_role_id

    messy = (
        '{"canonical_role_id": "role_cnc_programmer", "experience_level": null, '
        '"programming_knowledge": true, "primary_role": "CNC Programmer"}'
    )
    assert extract_canonical_role_id(messy) == "role_cnc_programmer"
    # Non-JSON / missing key / non-string -> None (then the heuristic stands).
    assert extract_canonical_role_id("not json") is None
    assert extract_canonical_role_id('{"foo": 1}') is None
    assert extract_canonical_role_id('{"canonical_role_id": 5}') is None
    # A ```json markdown fence (Claude often adds one) must still parse.
    fenced = '```json\n{"canonical_role_id": "role_vmc_operator"}\n```'
    assert extract_canonical_role_id(fenced) == "role_vmc_operator"


def test_coerce_json_text_strips_fence_and_prose():
    from app.profiling.canonical_roles import coerce_json_text

    assert coerce_json_text('```json\n{"a": 1}\n```') == '{"a": 1}'
    assert coerce_json_text('Here you go:\n{"a": 1} thanks') == '{"a": 1}'
    assert coerce_json_text('{"a": {"b": 2}}') == '{"a": {"b": 2}}'  # balanced/nested
    assert coerce_json_text("no object here") == "no object here"  # unchanged fallback
