"""Zod <-> Pydantic parity, asserted against a shared golden fixture.

CLAUDE.md invariant #7 says the AI I/O contracts must stay mirrored between
`packages/ai-contracts` (Zod) and `app/contracts.py` (Pydantic). Nothing enforced
that for a NEW model: CI runs the node job and the ai-service job independently,
and neither compares the two. Worse, Pydantic silently DROPS unknown request keys
(measured: a request carrying `want_opening` had it dropped with no error), so a
field added on the TypeScript side only would look fine from both ends.

So both suites assert against the same JSON file. Adding, renaming or removing a
field on either side turns the other side red.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.contracts import ProfilingOpeningInput, ProfilingOpeningOutput

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "ai-contracts"
    / "src"
    / "__fixtures__"
    / "profiling-opening.keys.json"
)


def _golden() -> dict[str, list[str]]:
    assert _FIXTURE.exists(), (
        f"golden contract fixture missing at {_FIXTURE} — the TypeScript suite asserts "
        "against this same file, so losing it silently removes the only parity guard"
    )
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


def test_profiling_opening_input_matches_the_zod_shape():
    assert sorted(ProfilingOpeningInput.model_fields) == sorted(
        _golden()["ProfilingOpeningInput"]
    )


def test_profiling_opening_output_matches_the_zod_shape():
    assert sorted(ProfilingOpeningOutput.model_fields) == sorted(
        _golden()["ProfilingOpeningOutput"]
    )


def test_opening_output_carries_no_pii_capable_field():
    """The endpoint is PII-free BY CONSTRUCTION, not by convention.

    The opener carries no vocative, so there is no worker name to render and no
    reason for this response to grow a name/phone/id field. If one is ever added,
    this fails and forces the privacy question to be asked out loud (§2 #2).
    """
    banned = {"worker_name", "name", "phone", "worker_id", "worker_ref", "session_id"}
    assert banned.isdisjoint(set(ProfilingOpeningOutput.model_fields))
    assert banned.isdisjoint(set(ProfilingOpeningInput.model_fields))


def test_role_family_defaults_so_an_empty_body_is_valid():
    """apps/api sends `{}` when it has no family to declare; that must not 422."""
    assert ProfilingOpeningInput().role_family == "cnc_vmc"
