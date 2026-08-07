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
import re
from pathlib import Path
from typing import get_args

import pytest
from pydantic import ValidationError

from app.contracts import (
    AnswerRecord,
    AnswerRecordHistoryEntry,
    AnswerStatus,
    AnswerType,
    ConversationMessage,
    ConversationState,
    EvidenceSpan,
    JobDomainMatch,
    JobPostingChatOpeningInput,
    JobPostingChatOpeningOutput,
    JobPostingChatState,
    JobPostingChatTurnInput,
    JobPostingChatTurnOutput,
    JobPostingDraft,
    OccupationPin,
    ParsedField,
    Predicate,
    PredicateOperand,
    ProfileExtractionInput,
    ProfileExtractionOutput,
    ProfileParseInput,
    ProfileParseOutput,
    ProfilingOpeningInput,
    ProfilingOpeningOutput,
    ProfilingPhase,
    ProfilingTurnInput,
    ProfilingTurnOutput,
    QuestionPack,
    QuestionPackItem,
    QuestionPackOption,
    QuestionPackStatus,
    TargetField,
    TranscriptLine,
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
    """The PAYER interview is deterministic and stateless per turn, so its contract
    simply does not accept a transcript — the engine keys off the message plus the
    stored state and has nothing to do with a history.

    Deliberately NOT true of the worker-side ProfilingTurnInput any more: that one
    threads history on purpose, because a model conducting the interview cannot ask a
    follow-up to a conversation it cannot see. The asymmetry is the point, so this
    assertion is scoped to the payer model and must not be "made consistent"."""
    assert "history" not in JobPostingChatTurnInput.model_fields


# --- Generalized profiling (the LLM-driven chat + the RAG domain match) -----
_PROFILING_FIXTURE = _FIXTURE_DIR / "profiling.keys.json"

_PROFILING_MODELS = {
    "ConversationMessage": ConversationMessage,
    "ConversationState": ConversationState,
    "ProfilingTurnInput": ProfilingTurnInput,
    "ProfilingTurnOutput": ProfilingTurnOutput,
    "ProfileExtractionInput": ProfileExtractionInput,
    "ProfileExtractionOutput": ProfileExtractionOutput,
    "JobDomainMatch": JobDomainMatch,
}


@pytest.mark.parametrize("name", sorted(_PROFILING_MODELS))
def test_profiling_models_match_the_zod_shape(name: str):
    golden = _read_golden(_PROFILING_FIXTURE)
    assert name in golden, f"fixture is missing {name}"
    assert sorted(_PROFILING_MODELS[name].model_fields) == sorted(golden[name])


def test_the_profiling_fixture_declares_no_model_the_python_side_lacks():
    golden = _read_golden(_PROFILING_FIXTURE)
    declared = {k for k in golden if not k.startswith("_")}
    assert declared == set(_PROFILING_MODELS)


def test_captured_is_present_so_the_rfs_is_not_stripped_in_flight():
    """THE regression this fixture exists for.

    `captured` is the Resume Field Set the whole LLM-driven interview accumulates, and
    it lived only here during the rewrite. A Zod object STRIPS keys it does not declare,
    so `ProfilingTurnOutputSchema.parse` on the api side was discarding every answer the
    model collected — with no error, no failing test on either side, and an interview
    that re-asks the same seven questions until the turn cap fires.

    Asserted as BEHAVIOUR as well as a key list: the key check above would pass if the
    field were renamed on both sides at once, this one pins what it must actually do.
    """
    state = ConversationState(captured={"trade": "VMC operator", "experience_years": "5 saal"})
    assert state.captured["trade"] == "VMC operator"
    # And an OLD state (a session mid-flight at deploy time) must degrade, never throw.
    assert ConversationState().captured == {}
    assert ConversationState().completion_reason is None


def test_force_complete_defaults_false_so_the_api_owns_the_turn_cap():
    """The cap is API-authoritative: this service holds no per-session state to count
    turns with, so it can only enforce what it is told. Defaulting TRUE would end every
    interview from a caller that predates the field."""
    assert ProfilingTurnInput(session_id="s", message_text="hi").force_complete is False


def test_the_profiling_contracts_carry_no_identity_pii_field():
    """Mechanical, so the rule survives an edit that does not read the comment. There is
    nowhere in these contracts to put a name, phone, address or employer — which is why
    `captured` cannot hold one even if a worker volunteers it (§2 #2)."""
    banned = {"worker_name", "name", "phone", "phone_number", "address", "employer"}
    for model_name, model in _PROFILING_MODELS.items():
        assert banned.isdisjoint(set(model.model_fields)), model_name


def test_job_domain_match_defaults_to_unmatched():
    """Fail-safe direction: a match object that arrives empty must mean "no domain",
    never a silently-matched one. A wrong domain is worse than no domain."""
    m = JobDomainMatch()
    assert m.status == "unmatched_degraded"
    assert m.job_domain_id is None
    assert m.score is None


# --- Occupation Intelligence Engine (the Phase 0 contract freeze) -----------
_OIE_FIXTURE = _FIXTURE_DIR / "oie.keys.json"

_OIE_MODELS = {
    "EvidenceSpan": EvidenceSpan,
    "AnswerRecordHistoryEntry": AnswerRecordHistoryEntry,
    "AnswerRecord": AnswerRecord,
    "OccupationPin": OccupationPin,
    "PredicateOperand": PredicateOperand,
    "Predicate": Predicate,
    "QuestionPackOption": QuestionPackOption,
    "QuestionPackItem": QuestionPackItem,
    "QuestionPack": QuestionPack,
    "TranscriptLine": TranscriptLine,
    "TargetField": TargetField,
    "ProfileParseInput": ProfileParseInput,
    "ParsedField": ParsedField,
    "ProfileParseOutput": ProfileParseOutput,
}


@pytest.mark.parametrize("name", sorted(_OIE_MODELS))
def test_oie_models_match_the_zod_shape(name: str):
    golden = _read_golden(_OIE_FIXTURE)
    assert name in golden, f"fixture is missing {name}"
    assert sorted(_OIE_MODELS[name].model_fields) == sorted(golden[name])


def test_the_oie_fixture_declares_no_model_the_python_side_lacks():
    """This surface has ALREADY shipped incomplete once: the Phase 0 "contract freeze"
    merged without these models existing at all, and every suite stayed green because a
    parity test can only compare what exists on both sides. The closure check is what
    makes that impossible to repeat quietly — a model added to the fixture without a
    Pydantic twin fails HERE, not in production."""
    golden = _read_golden(_OIE_FIXTURE)
    declared = {k for k in golden if not k.startswith("_")}
    assert declared == set(_OIE_MODELS)


def test_conversation_state_carries_the_seven_oie_fields():
    """Belt to the fixture's braces, pinned BY NAME because their absence is precisely
    the Phase 0 gap that shipped once already. All seven default, so a state persisted
    before this change still parses (invariant #8 for sessions mid-flight at deploy)."""
    state = ConversationState()
    assert state.phase == "identify"
    assert state.occupation is None
    assert state.answer_map == []
    assert state.engine_asks == 0
    assert state.pack_id is None
    assert state.pack_version is None
    assert state.catalog_version is None


def test_predicate_arity_is_enforced_per_op():
    """The evaluator is pure code that trusts its input shape; this validator is what
    lets it. Wrong-operand predicates must fail at the contract, not at evaluation time
    inside a live interview. Mirrors the Zod superRefine table byte for byte."""
    # A predicate exercising every operator parses...
    Predicate.model_validate(
        {
            "op": "all",
            "predicates": [
                {"op": "not", "predicate": {"op": "answered", "field": "trade"}},
                {"op": "declined", "field": "salary_expected"},
                {
                    "op": "eq",
                    "left": {"field": "experience_years"},
                    "right": {"const": 5},
                },
                {"op": "occupation_is", "job_domain_id": "jd_nco_7212_0100"},
                {"op": "occupation_under", "isco_code": "72"},
                {"op": "phase_is", "phase": "occupation_specific"},
                {"op": "turn_gte", "turn": 3},
            ],
        }
    )
    # ...while a missing or foreign operand is rejected.
    with pytest.raises(ValidationError):
        Predicate.model_validate({"op": "all"})
    with pytest.raises(ValidationError):
        Predicate.model_validate({"op": "answered"})
    with pytest.raises(ValidationError):
        Predicate.model_validate({"op": "answered", "field": "trade", "turn": 3})
    with pytest.raises(ValidationError):
        Predicate.model_validate({"op": "eq", "left": {"field": "x"}})


def test_predicate_operand_is_exactly_one_of_field_or_const():
    PredicateOperand.model_validate({"field": "experience_years"})
    # `{"const": null}` is a valid literal null — key PRESENCE decides, not truthiness.
    PredicateOperand.model_validate({"const": None})
    with pytest.raises(ValidationError):
        PredicateOperand.model_validate({})
    with pytest.raises(ValidationError):
        PredicateOperand.model_validate({"field": "x", "const": 1})


def test_parsed_field_requires_evidence():
    """The provenance gate's contract half: a value with no span cannot even be
    REPRESENTED. A hallucinated value has no quote to point at (§gate 1)."""
    with pytest.raises(ValidationError):
        ParsedField.model_validate(
            {"value": 15000, "source": "answer_map", "normalization": "numeric", "confidence": 0.9}
        )
    ParsedField.model_validate(
        {
            "value": 15000,
            "evidence": {"message_index": 4, "quote": "pandrah hazaar"},
            "source": "answer_map",
            "normalization": "numeric",
            "confidence": 0.9,
        }
    )


def test_occupation_pin_defaults_to_unmatched():
    """Same fail-safe direction as JobDomainMatch: an empty pin means "not identified",
    never a silently-matched occupation. A wrong family makes every subsequent question
    wrong, which is far worse than one extra clarifying turn."""
    pin = OccupationPin(job_domain_id="jd_nco_7212_0100", label="Welder, Gas")
    assert pin.match_status == "unmatched_degraded"
    assert pin.match_score is None
    assert pin.match_layer is None


def test_the_oie_contracts_carry_no_identity_pii_field():
    """Mechanical, same as the profiling models: there is nowhere in these contracts to
    put a name, phone, address or employer (§2 #2)."""
    banned = {"worker_name", "name", "phone", "phone_number", "address", "employer"}
    for model_name, model in _OIE_MODELS.items():
        assert banned.isdisjoint(set(model.model_fields)), model_name


# ---------------------------------------------------------------------------
# ENUM VALUES, not just key names — the gap the freeze header did not have
# ---------------------------------------------------------------------------


_REPO = Path(__file__).resolve().parents[3]


def _zod_string_union(const_name: str) -> list[str]:
    """Read a `export const X = [...] as const;` literal out of oie.ts.

    Reading the SOURCE keeps this a plain pytest with no Node runtime, the same way
    test_lexicon_parity reads the shared JSON rather than importing TypeScript.
    """
    source = (_REPO / "packages" / "ai-contracts" / "src" / "oie.ts").read_text(encoding="utf-8")
    match = re.search(rf"export const {const_name} = \[(.*?)\] as const;", source, re.S)
    assert match, f"{const_name} not found in oie.ts — the mirror has moved"
    # COMMENTS FIRST. These arrays carry per-member doc comments that quote worker phrases
    # ("nahi pata"), and a bare string scan happily returns those as members.
    body = re.sub(r"/\*.*?\*/", "", match.group(1), flags=re.S)
    body = re.sub(r"//[^\n]*", "", body)
    return re.findall(r'"([^"]+)"', body)


def test_oie_enum_values_match_not_just_their_key_names():
    """The freeze header promises `test_contract_parity.py` turns red if one side moves alone.

    For enum VALUES that was not true. `oie.keys.json` carries the bare string
    ``"answer_type"`` and never its members, and both parity tests compare
    ``sorted(model_fields)`` — key names only. Widening ANSWER_TYPES on one side, or adding
    a phase to one and not the other, would have been invisible to every existing check.
    """
    assert _zod_string_union("ANSWER_TYPES") == list(get_args(AnswerType))
    assert _zod_string_union("PROFILING_PHASES") == list(get_args(ProfilingPhase))
    assert _zod_string_union("QUESTION_PACK_STATUSES") == list(get_args(QuestionPackStatus))
    assert _zod_string_union("ANSWER_STATUSES") == list(get_args(AnswerStatus))


def test_the_enum_parity_check_is_capable_of_failing():
    """Guards against a regex that quietly matches nothing and makes the above vacuous."""
    assert len(_zod_string_union("ANSWER_TYPES")) >= 5
    assert "multi_select" in _zod_string_union("ANSWER_TYPES")
