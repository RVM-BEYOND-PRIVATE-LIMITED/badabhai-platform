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

import pytest

from app.contracts import (
    JobPostingChatOpeningInput,
    JobPostingChatOpeningOutput,
    JobPostingChatState,
    JobPostingChatTurnInput,
    JobPostingChatTurnOutput,
    JobPostingDraft,
    ProfilingOpeningInput,
    ProfilingOpeningOutput,
)

_FIXTURE_DIR = (
    Path(__file__).resolve().parents[3] / "packages" / "ai-contracts" / "src" / "__fixtures__"
)
_FIXTURE = _FIXTURE_DIR / "profiling-opening.keys.json"
_JOB_POSTING_FIXTURE = _FIXTURE_DIR / "job-posting-chat.keys.json"


def _read_golden(path: Path) -> dict[str, list[str]]:
    assert path.exists(), (
        f"golden contract fixture missing at {path} — the TypeScript suite asserts "
        "against this same file, so losing it silently removes the only parity guard"
    )
    return json.loads(path.read_text(encoding="utf-8"))


def _golden() -> dict[str, list[str]]:
    return _read_golden(_FIXTURE)


def test_profiling_opening_input_matches_the_zod_shape():
    assert sorted(ProfilingOpeningInput.model_fields) == sorted(_golden()["ProfilingOpeningInput"])


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


# --- ADR-0035 job-posting chat ---------------------------------------------
_JOB_POSTING_MODELS = {
    "JobPostingChatState": JobPostingChatState,
    "JobPostingDraft": JobPostingDraft,
    "JobPostingChatOpeningInput": JobPostingChatOpeningInput,
    "JobPostingChatOpeningOutput": JobPostingChatOpeningOutput,
    "JobPostingChatTurnInput": JobPostingChatTurnInput,
    "JobPostingChatTurnOutput": JobPostingChatTurnOutput,
}


@pytest.mark.parametrize("name", sorted(_JOB_POSTING_MODELS))
def test_job_posting_chat_models_match_the_zod_shape(name: str):
    golden = _read_golden(_JOB_POSTING_FIXTURE)
    assert name in golden, f"fixture is missing {name}"
    assert sorted(_JOB_POSTING_MODELS[name].model_fields) == sorted(golden[name])


def test_the_fixture_declares_no_model_the_python_side_lacks():
    """A model added on the TypeScript side only would otherwise never be noticed."""
    golden = _read_golden(_JOB_POSTING_FIXTURE)
    declared = {k for k in golden if not k.startswith("_")}
    assert declared == set(_JOB_POSTING_MODELS)


def test_the_draft_has_no_org_label_field():
    """ADR-0035 §Decision 3 — the payer's organisation name is NEVER asked in the
    chat and never reaches this service. It is already on `payers.orgNameEnc` and is
    stamped server-side at publish (the AI-PERSONA-2 post-hoc pattern). A field here
    would mean asking for it in free text, which duplicates data we hold AND invites
    the payer to type personal contact details next to it. Mechanical, so the rule
    survives an edit that does not read the comment."""
    banned = {"org_label", "org_name", "company", "company_name", "employer_name"}
    assert banned.isdisjoint(set(JobPostingDraft.model_fields))


def test_opening_endpoint_contract_is_pii_free_by_construction():
    banned = {"payer_name", "org_label", "name", "phone", "payer_id", "session_id"}
    assert banned.isdisjoint(set(JobPostingChatOpeningInput.model_fields))
    assert banned.isdisjoint(set(JobPostingChatOpeningOutput.model_fields))


def test_turn_input_carries_no_history_so_a_transcript_cannot_be_re_sent():
    """COST-3: the profiling input keeps a vestigial `history` it must never thread
    into a model call. A new contract simply does not accept one."""
    assert "history" not in JobPostingChatTurnInput.model_fields
