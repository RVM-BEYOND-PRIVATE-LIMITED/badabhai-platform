"""Tests for LLM role canonicalization wiring (no network, no LLM).

Covers the closed-set validation (``canonical_roles``) and the endpoint's lenient
role-id extraction — a correct ``canonical_role_id`` MUST survive even when the
model nulls/loosely-types other enrichment fields (the real-run bug we fixed).
"""

from __future__ import annotations

from app.profiling import canonical_roles as cr


def test_role_trade_covers_the_seven_launch_roles():
    assert set(cr.ROLE_IDS) == {
        "role_vmc_operator",
        "role_hmc_operator",
        "role_cnc_turner_operator",
        "role_cnc_setter_operator",
        "role_cnc_grinding_operator",
        "role_cnc_programmer",
        "role_cam_programmer",
    }
    # Every id maps to a trade id.
    assert all(cr.ROLE_TRADE[r] for r in cr.ROLE_IDS)


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
    from app import main

    messy = (
        '{"canonical_role_id": "role_cnc_programmer", "experience_level": null, '
        '"programming_knowledge": true, "primary_role": "CNC Programmer"}'
    )
    assert main._extract_canonical_role_id(messy) == "role_cnc_programmer"
    # Non-JSON / missing key / non-string -> None (then the heuristic stands).
    assert main._extract_canonical_role_id("not json") is None
    assert main._extract_canonical_role_id('{"foo": 1}') is None
    assert main._extract_canonical_role_id('{"canonical_role_id": 5}') is None
