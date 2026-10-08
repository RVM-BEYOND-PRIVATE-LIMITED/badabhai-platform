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
from pydantic import TypeAdapter, ValidationError

from app.contracts import (
    AnswerRecord,
    AnswerRecordHistoryEntry,
    AnswerStatus,
    AnswerType,
    CompanionCareerAnswer,
    CompanionCareerInput,
    CompanionCareerRefusalTopic,
    CompanionCareerRefuse,
    CompanionCareerWorkerContext,
    CompanionClassifyInput,
    CompanionClassifyOutput,
    CompanionEditParseInput,
    CompanionEditParseOutput,
    CompanionEditRow,
    CompanionEditSnapshotRow,
    CompanionMemoryRole,
    CompanionRecentTurn,
    CompanionV2Intent,
    ConversationMessage,
    ConversationState,
    EditableField,
    EditOp,
    EditSection,
    EvidenceSpan,
    ExperienceEntry,
    FreeChatAnswer,
    FreeChatCategory,
    FreeChatClassifyInput,
    FreeChatClassifyMode,
    FreeChatClassifyOutput,
    FreeChatNewsAnswer,
    FreeChatNewsInput,
    FreeChatNewsKind,
    FreeChatNewsNoResults,
    FreeChatNewsOutput,
    FreeChatNewsRefuse,
    FreeChatNewsSource,
    FreeChatRefusalTopic,
    FreeChatRefuse,
    FreeChatReplyCategory,
    FreeChatReplyInput,
    FreeChatReplyOutput,
    FreeChatSummarizeInput,
    FreeChatSummarizeOutput,
    InterviewExtractInput,
    InterviewExtractOutput,
    JobDomainMatch,
    JobNeededBy,
    JobPayType,
    JobPostingChatOpeningInput,
    JobPostingChatOpeningOutput,
    JobPostingChatState,
    JobPostingChatTurnInput,
    JobPostingChatTurnOutput,
    JobPostingDraft,
    LlmInterviewDraft,
    LlmInterviewMode,
    LlmTurnInput,
    LlmTurnOutput,
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
    UnsupportedEditTarget,
    WorkHistoryPolishInput,
    WorkHistoryPolishOutput,
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
    # Phase A (LLM-led interview) + Phase C (whole-chat extraction).
    "ExperienceEntry": ExperienceEntry,
    "LlmInterviewDraft": LlmInterviewDraft,
    "LlmTurnInput": LlmTurnInput,
    "LlmTurnOutput": LlmTurnOutput,
    "InterviewExtractInput": InterviewExtractInput,
    "InterviewExtractOutput": InterviewExtractOutput,
    # #1350 — the one field the model may compose. Parity matters MORE here, not less: a field
    # dropped in flight means a sheet printing raw text while the trace says it was polished.
    "WorkHistoryPolishInput": WorkHistoryPolishInput,
    "WorkHistoryPolishOutput": WorkHistoryPolishOutput,
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


def _string_union_in(source_path: Path, const_name: str) -> list[str]:
    """Read a `export const X = [...] as const;` literal out of a TypeScript source file.

    Reading the SOURCE keeps this a plain pytest with no Node runtime, the same way
    test_lexicon_parity reads the shared JSON rather than importing TypeScript.
    """
    source = source_path.read_text(encoding="utf-8")
    match = re.search(rf"export const {const_name} = \[(.*?)\] as const;", source, re.S)
    assert match, f"{const_name} not found in {source_path.name} — the mirror has moved"
    # COMMENTS FIRST. These arrays carry per-member doc comments that quote worker phrases
    # ("nahi pata"), and a bare string scan happily returns those as members.
    body = re.sub(r"/\*.*?\*/", "", match.group(1), flags=re.S)
    body = re.sub(r"//[^\n]*", "", body)
    return re.findall(r'"([^"]+)"', body)


def _zod_string_union(const_name: str) -> list[str]:
    """Read a `export const X = [...] as const;` literal out of oie.ts."""
    return _string_union_in(_REPO / "packages" / "ai-contracts" / "src" / "oie.ts", const_name)


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
    # ADR-0045 — the interview mode the API selects (classic Phase A vs the skills stage).
    assert _zod_string_union("LLM_INTERVIEW_MODES") == list(get_args(LlmInterviewMode))


def test_the_enum_parity_check_is_capable_of_failing():
    """Guards against a regex that quietly matches nothing and makes the above vacuous."""
    assert len(_zod_string_union("ANSWER_TYPES")) >= 5
    assert "multi_select" in _zod_string_union("ANSWER_TYPES")


# --- AICallMetadata: the one contract that carries TEXT ----------------------
#
# ADDED AFTER A MEASURED, SHIPPED DIVERGENCE. `apps/ai-service` populated
# `AICallMetadata.prompt_text` / `response_text` with post-pseudonymization text while
# `packages/ai-contracts`'s `AICallMetadataSchema` had no such fields — and a bare `z.object`
# STRIPS unknown keys. So the masked text was produced, sent, and silently discarded at
# `AiService`'s `schema.parse(...)`, and the trace writer stored the API-side REQUEST instead:
# the worker's raw name, phone and address. Every suite on both sides was green.
#
# This model was in NEITHER existing fixture, and `test_the_fixture_declares_no_model_the_
# python_side_lacks` is scoped to `_JOB_POSTING_MODELS`, so nothing could have caught it.
_AI_CALL_METADATA_FIXTURE = _FIXTURE_DIR / "ai-call-metadata.keys.json"


def test_ai_call_metadata_matches_the_zod_shape():
    from app.contracts import AICallMetadata

    golden = _read_golden(_AI_CALL_METADATA_FIXTURE)
    assert sorted(AICallMetadata.model_fields) == sorted(golden["AICallMetadata"])


def test_the_two_text_fields_are_named_in_the_fixture_and_on_the_model():
    """The text pair is called out SEPARATELY from the key list, because it is the half with a
    privacy contract attached: these are the only fields on this model that carry free text, and
    `TRACE_TEXT_FIELDS` (which excludes them from the span metadata and the cost log) is derived
    from that fact. A third text field added without updating both is what this catches."""
    from app.contracts import TRACE_TEXT_FIELDS, AICallMetadata

    golden = _read_golden(_AI_CALL_METADATA_FIXTURE)
    declared = set(golden["_text_fields"])
    assert declared == set(TRACE_TEXT_FIELDS)
    assert declared <= set(AICallMetadata.model_fields)


def test_the_text_fields_default_to_none_so_an_older_service_still_parses():
    """Additive and defaulted, on BOTH sides. A deploy in which the api leads the ai-service (or
    a surface that never routes through `AIRouter`) sends no such field, and that must be an
    ordinary absent value rather than a 500 on every AI call."""
    from app.contracts import AICallMetadata

    meta = AICallMetadata(
        ai_call_id="x",
        task_type="profile_extraction",
        model_name="m",
        provider="google",
        real_call=False,
        created_at="2026-08-20T00:00:00+00:00",
    )
    assert meta.prompt_text is None
    assert meta.response_text is None


# --- #1726: the job-posting draft's enum VALUES and bounds ---------------------
#
# `job-posting-chat.keys.json` pins key NAMES only — the same gap the OIE section above
# closes for its enums. A member added to `pay_type` on one side, or a city cap moved on
# one side, would be green on both suites without this.
_JOB_POSTING_TS = _REPO / "packages" / "ai-contracts" / "src" / "job-posting.ts"


def _job_posting_ts() -> str:
    return _JOB_POSTING_TS.read_text(encoding="utf-8")


def _zod_enum(const_name: str) -> list[str]:
    match = re.search(rf"const {const_name} = z\.enum\(\[(.*?)\]\)", _job_posting_ts(), re.S)
    assert match, f"{const_name} not found in job-posting.ts — the mirror has moved"
    return re.findall(r'"([^"]+)"', match.group(1))


def _ts_int(const_name: str) -> int:
    match = re.search(rf"const {const_name} = (\d+);", _job_posting_ts())
    assert match, f"{const_name} not found in job-posting.ts — the mirror has moved"
    return int(match.group(1))


def test_job_posting_draft_enums_match_the_zod_source():
    assert _zod_enum("jobPayType") == list(get_args(JobPayType))
    assert _zod_enum("jobNeededBy") == list(get_args(JobNeededBy))
    # Non-vacuous: the regex found the real members, not an empty list on both sides.
    assert "in_hand" in _zod_enum("jobPayType")


def test_job_posting_draft_bounds_match_the_zod_source():
    """Asserted as BEHAVIOUR at the boundary, so the Pydantic constraint itself is what is
    compared — not a Python constant that could drift from the Field it names."""
    city_max = _ts_int("JP_CITY_MAX")
    years_max = _ts_int("JP_EXPERIENCE_MAX_YEARS")
    JobPostingDraft(city="x" * city_max, min_experience_years=years_max, max_experience_years=0)
    with pytest.raises(ValidationError):
        JobPostingDraft(city="x" * (city_max + 1))
    for field in ("min_experience_years", "max_experience_years"):
        with pytest.raises(ValidationError):
            JobPostingDraft(**{field: years_max + 1})
        with pytest.raises(ValidationError):
            JobPostingDraft(**{field: -1})


# --- Chat companion v2 (ADR-0046 Phase 1) -------------------------------------
#
# Mirrors `packages/ai-contracts/src/companion.ts`. The classifier's output set and the edit
# catalogue's vocabularies live in `packages/types` (read from source below — the frontier the
# API's catalogue and the event spine share), and every model is pinned to the same golden
# fixture the TypeScript suite reads.
_COMPANION_FIXTURE = _FIXTURE_DIR / "companion.keys.json"
_COMPANION_TS = _REPO / "packages" / "ai-contracts" / "src" / "companion.ts"
_TYPES_TS = _REPO / "packages" / "types" / "src" / "index.ts"

_COMPANION_MODELS = {
    "CompanionRecentTurn": CompanionRecentTurn,
    "EditableField": EditableField,
    "CompanionEditSnapshotRow": CompanionEditSnapshotRow,
    "CompanionEditRow": CompanionEditRow,
    "CompanionClassifyInput": CompanionClassifyInput,
    "CompanionClassifyOutput": CompanionClassifyOutput,
    "CompanionEditParseInput": CompanionEditParseInput,
    "CompanionEditParseOutput": CompanionEditParseOutput,
    # ADR-0046 P3 — career talk. The two output members are a discriminated union on `status`; the
    # golden fixture pins each member's keys, and the enum-values test below pins the topic set.
    "CompanionCareerWorkerContext": CompanionCareerWorkerContext,
    "CompanionCareerInput": CompanionCareerInput,
    "CompanionCareerAnswer": CompanionCareerAnswer,
    "CompanionCareerRefuse": CompanionCareerRefuse,
}


@pytest.mark.parametrize("name", sorted(_COMPANION_MODELS))
def test_companion_models_match_the_zod_shape(name: str):
    golden = _read_golden(_COMPANION_FIXTURE)
    assert name in golden, f"fixture is missing {name}"
    assert sorted(_COMPANION_MODELS[name].model_fields) == sorted(golden[name])


def test_the_companion_fixture_declares_no_model_the_python_side_lacks():
    golden = _read_golden(_COMPANION_FIXTURE)
    declared = {k for k in golden if not k.startswith("_")}
    assert declared == set(_COMPANION_MODELS)


def test_companion_enum_values_match_the_shared_types_source():
    """The sets live in `packages/types/src/index.ts`; the API's catalogue and the event spine
    read them too. A member added on one side only would otherwise be invisible — the key-name
    parity above cannot see values."""
    assert _string_union_in(_TYPES_TS, "COMPANION_V2_INTENTS") == list(get_args(CompanionV2Intent))
    assert _string_union_in(_TYPES_TS, "COMPANION_V2_EDIT_SECTIONS") == list(get_args(EditSection))
    assert _string_union_in(_TYPES_TS, "COMPANION_V2_EDIT_OPS") == list(get_args(EditOp))
    assert _string_union_in(_TYPES_TS, "COMPANION_V2_UNSUPPORTED_EDIT_TARGETS") == list(
        get_args(UnsupportedEditTarget)
    )
    assert list(get_args(CompanionMemoryRole)) == ["worker", "bada_bhai"]
    # Non-vacuous: the regex found real members, not an empty list on both sides.
    assert "edit_resume" in _string_union_in(_TYPES_TS, "COMPANION_V2_INTENTS")


def _companion_ts_int(const_name: str) -> int:
    source = _COMPANION_TS.read_text(encoding="utf-8")
    match = re.search(rf"const {const_name} = (\d+);", source)
    assert match, f"{const_name} not found in companion.ts — the mirror has moved"
    return int(match.group(1))


def test_companion_bounds_match_the_zod_source_at_the_boundary():
    """BEHAVIOUR at the boundary, like the job-posting bounds above: the Pydantic constraint is
    what is compared, not a Python constant that could drift from the Field it names."""
    text_max = _companion_ts_int("TEXT_MAX_CLASSIFY")
    message_max = _companion_ts_int("TEXT_MAX_MESSAGE")
    field_max = _companion_ts_int("FIELD_MAX")
    ref_max = _companion_ts_int("REF_MAX")
    max_rows_max = _companion_ts_int("MAX_ROWS_MAX")

    CompanionClassifyInput(text="x" * text_max)
    with pytest.raises(ValidationError):
        CompanionClassifyInput(text="x" * (text_max + 1))
    CompanionEditParseInput(text="x" * message_max, max_rows=1)
    with pytest.raises(ValidationError):
        CompanionEditParseInput(text="x" * (message_max + 1), max_rows=1)

    EditableField(section="skills", field="x" * field_max, ops=["add"])
    with pytest.raises(ValidationError):
        EditableField(section="skills", field="x" * (field_max + 1), ops=["add"])
    CompanionEditSnapshotRow(ref="x" * ref_max, section="skills", fields={})
    with pytest.raises(ValidationError):
        CompanionEditSnapshotRow(ref="x" * (ref_max + 1), section="skills", fields={})
    with pytest.raises(ValidationError):
        EditableField(section="skills", field="skill", ops=[])

    for bad_rows in (0, max_rows_max + 1):
        with pytest.raises(ValidationError):
            CompanionEditParseInput(text="kuch", max_rows=bad_rows)


def test_companion_confidences_and_memory_turns_are_bounded():
    CompanionClassifyOutput(intent="unclear", confidence=0.0)
    CompanionClassifyOutput(intent="unclear", confidence=1.0)
    for bad in (-0.1, 1.1):
        with pytest.raises(ValidationError):
            CompanionClassifyOutput(intent="unclear", confidence=bad)

    turn = {"role": "worker", "text": "kuch"}
    assert len(CompanionClassifyInput(text="hi", recent_turns=[turn, turn]).recent_turns) == 2
    with pytest.raises(ValidationError):
        CompanionClassifyInput(text="hi", recent_turns=[turn, turn, turn])


def test_companion_outputs_default_fail_soft():
    """`blocked` defaults False and the row/unsupported/catalogue/snapshot lists default empty,
    so a far side that omits them still parses; the API treats a missing row as no card."""
    out = CompanionClassifyOutput(intent="faltu", confidence=0.9)
    assert out.blocked is False
    assert CompanionClassifyInput(text="hi").recent_turns == []
    parsed = CompanionEditParseOutput()
    assert parsed.rows == []
    assert parsed.unsupported == []
    assert CompanionEditParseInput(text="kuch", max_rows=3).catalogue == []
    assert CompanionEditParseInput(text="kuch", max_rows=3).snapshot == []


# --- ADR-0046 P3 — career talk --------------------------------------------------


def test_companion_career_refusal_topics_match_the_shared_types_source():
    """The topics live in `packages/types` beside the other companion vocabularies: the API's
    `V2_CAREER_REFUSE_<topic>` map, the Zod enum and this Literal read the same list."""
    assert _string_union_in(_TYPES_TS, "COMPANION_V2_CAREER_REFUSAL_TOPICS") == list(
        get_args(CompanionCareerRefusalTopic)
    )
    # Non-vacuous: the regex found real members, not an empty list on both sides.
    assert "salary_promise" in _string_union_in(_TYPES_TS, "COMPANION_V2_CAREER_REFUSAL_TOPICS")


def test_companion_career_bounds_match_the_zod_source_at_the_boundary():
    """BEHAVIOUR at the boundary, like the Phase 1 bounds above: the caps the Zod mirror carries
    are read from companion.ts and asserted on the Pydantic constraints themselves."""
    line_max = _companion_ts_int("CAREER_LINE_MAX")
    chip_max = _companion_ts_int("CAREER_CHIP_MAX")
    label_max = _companion_ts_int("CAREER_TRADE_LABEL_MAX")

    CompanionCareerAnswer(status="answer", lines=["x" * line_max])
    with pytest.raises(ValidationError):
        CompanionCareerAnswer(status="answer", lines=["x" * (line_max + 1)])
    with pytest.raises(ValidationError):
        CompanionCareerAnswer(status="answer", lines=[])
    with pytest.raises(ValidationError):
        CompanionCareerAnswer(status="answer", lines=["a", "b", "c", "d", "e"])
    CompanionCareerAnswer(status="answer", lines=["ok"], followup_chips=["x" * chip_max] * 3)
    with pytest.raises(ValidationError):
        CompanionCareerAnswer(status="answer", lines=["ok"], followup_chips=["x"] * 4)

    CompanionCareerWorkerContext(trade_label="x" * label_max)
    with pytest.raises(ValidationError):
        CompanionCareerWorkerContext(trade_label="x" * (label_max + 1))
    CompanionCareerWorkerContext(experience_bucket="3-7")
    with pytest.raises(ValidationError):
        CompanionCareerWorkerContext(experience_bucket="10+")

    turn = {"role": "worker", "text": "kuch"}
    CompanionCareerInput(text="kuch", recent_turns=[turn] * 6)
    with pytest.raises(ValidationError):
        CompanionCareerInput(text="kuch", recent_turns=[turn] * 7)


def test_companion_career_output_is_a_status_discriminated_union():
    """`status` is REQUIRED on both members: a missing or unknown discriminant must fail the
    contract (the route turns that into `refuse/unsafe_other`), never be defaulted into an
    answer shape the model did not mean."""
    answer = CompanionCareerAnswer(status="answer", lines=["line"])
    assert answer.status == "answer"
    assert answer.followup_chips == []
    assert answer.ai_metadata is None
    refused = CompanionCareerRefuse(status="refuse", topic="salary_promise")
    assert refused.topic == "salary_promise"

    with pytest.raises(ValidationError):
        CompanionCareerRefuse(status="refuse", topic="money")
    with pytest.raises(ValidationError):
        CompanionCareerAnswer(lines=["line"])  # status is required
    with pytest.raises(ValidationError):
        CompanionCareerAnswer(status="answer")  # lines are required


def test_the_companion_contracts_carry_no_identity_pii_field():
    """Mechanical, same as every other family here: there is nowhere in these contracts to put
    a name, a phone or an address (§2 #2)."""
    banned = {"worker_id", "worker_ref", "worker_name", "name", "phone", "address"}
    for model_name, model in _COMPANION_MODELS.items():
        assert banned.isdisjoint(set(model.model_fields)), model_name


# --- The profiling-stage free chat (ADR-0051, #2027) ------------------------------------------
#
# Mirrors `packages/ai-contracts/src/free-chat.ts`. The three closed sets live in `packages/types`
# (read from source below, the frontier the API's handlers and the event spine share); the
# classify modes live in the Zod file itself. Every model is pinned to the golden fixture the
# TypeScript suite reads, and the bounds are asserted as BEHAVIOUR on the Pydantic constraints.
_FREE_CHAT_FIXTURE = _FIXTURE_DIR / "free-chat.keys.json"
_FREE_CHAT_TS = _REPO / "packages" / "ai-contracts" / "src" / "free-chat.ts"

_FREE_CHAT_MODELS = {
    "FreeChatClassifyInput": FreeChatClassifyInput,
    "FreeChatClassifyOutput": FreeChatClassifyOutput,
    "FreeChatReplyInput": FreeChatReplyInput,
    # The two reply members are a discriminated union on `status`; the fixture pins each
    # member's keys and the union test below pins the discriminant.
    "FreeChatAnswer": FreeChatAnswer,
    "FreeChatRefuse": FreeChatRefuse,
    # Release 2 (§8): the rolling summary's fold.
    "FreeChatSummarizeInput": FreeChatSummarizeInput,
    "FreeChatSummarizeOutput": FreeChatSummarizeOutput,
    # ADR-0054: live news — the input, one source and the three members of the output union.
    "FreeChatNewsInput": FreeChatNewsInput,
    "FreeChatNewsSource": FreeChatNewsSource,
    "FreeChatNewsAnswer": FreeChatNewsAnswer,
    "FreeChatNewsNoResults": FreeChatNewsNoResults,
    "FreeChatNewsRefuse": FreeChatNewsRefuse,
}


@pytest.mark.parametrize("name", sorted(_FREE_CHAT_MODELS))
def test_free_chat_models_match_the_zod_shape(name: str):
    golden = _read_golden(_FREE_CHAT_FIXTURE)
    assert name in golden, f"fixture is missing {name}"
    assert sorted(_FREE_CHAT_MODELS[name].model_fields) == sorted(golden[name])


def test_the_free_chat_fixture_declares_no_model_the_python_side_lacks():
    golden = _read_golden(_FREE_CHAT_FIXTURE)
    declared = {k for k in golden if not k.startswith("_")}
    assert declared == set(_FREE_CHAT_MODELS)


def test_free_chat_closed_sets_match_the_shared_types_source():
    """The sets live in `packages/types/src/index.ts`; the API's handlers, its refusal-line map and
    the `chat.free_chat_turn_served` event read them too. Key-name parity cannot see values."""
    assert _string_union_in(_TYPES_TS, "FREE_CHAT_CATEGORIES") == list(get_args(FreeChatCategory))
    assert _string_union_in(_TYPES_TS, "FREE_CHAT_REPLY_CATEGORIES") == list(
        get_args(FreeChatReplyCategory)
    )
    assert _string_union_in(_TYPES_TS, "FREE_CHAT_REFUSAL_TOPICS") == list(
        get_args(FreeChatRefusalTopic)
    )
    assert _string_union_in(_FREE_CHAT_TS, "FREE_CHAT_CLASSIFY_MODES") == list(
        get_args(FreeChatClassifyMode)
    )
    # ADR-0054: the news kinds, read from the same shared source.
    assert _string_union_in(_TYPES_TS, "FREE_CHAT_NEWS_KINDS") == list(get_args(FreeChatNewsKind))
    # Non-vacuous: the regex found real members, not an empty list on both sides.
    assert "off_limits" in _string_union_in(_TYPES_TS, "FREE_CHAT_CATEGORIES")
    assert "news" in _string_union_in(_TYPES_TS, "FREE_CHAT_REFUSAL_TOPICS")
    # The reply categories are a subset of the categories: the model only ever answers for a
    # category the classifier can return.
    assert set(get_args(FreeChatReplyCategory)) <= set(get_args(FreeChatCategory))


def _free_chat_ts_int(const_name: str) -> int:
    source = _FREE_CHAT_TS.read_text(encoding="utf-8")
    match = re.search(rf"const {const_name} = (\d+);", source)
    assert match, f"{const_name} not found in free-chat.ts — the mirror has moved"
    return int(match.group(1))


def test_free_chat_bounds_match_the_zod_source_at_the_boundary():
    classify_max = _free_chat_ts_int("TEXT_MAX_CLASSIFY")
    message_max = _free_chat_ts_int("TEXT_MAX_MESSAGE")
    question_max = _free_chat_ts_int("PENDING_QUESTION_MAX")
    classify_turns = _free_chat_ts_int("CLASSIFY_TURNS_MAX")
    reply_turns = _free_chat_ts_int("REPLY_TURNS_MAX")
    line_max = _free_chat_ts_int("REPLY_LINE_MAX")
    chip_max = _free_chat_ts_int("REPLY_CHIP_MAX")
    turn = {"role": "worker", "text": "kuch"}

    FreeChatClassifyInput(text="x" * classify_max, mode="free")
    with pytest.raises(ValidationError):
        FreeChatClassifyInput(text="x" * (classify_max + 1), mode="free")
    with pytest.raises(ValidationError):
        FreeChatClassifyInput(text="", mode="free")
    FreeChatClassifyInput(text="x", mode="resume", pending_question="q" * question_max)
    with pytest.raises(ValidationError):
        FreeChatClassifyInput(text="x", mode="resume", pending_question="q" * (question_max + 1))
    with pytest.raises(ValidationError):
        FreeChatClassifyInput(text="x", mode="resume", pending_question="")  # Zod .min(1)
    FreeChatClassifyInput(text="x", mode="free", recent_turns=[turn] * classify_turns)
    with pytest.raises(ValidationError):
        FreeChatClassifyInput(text="x", mode="free", recent_turns=[turn] * (classify_turns + 1))
    with pytest.raises(ValidationError):
        FreeChatClassifyInput(text="x", mode="greeting")  # never sent: read deterministically

    FreeChatReplyInput(category="casual", text="x" * message_max)
    with pytest.raises(ValidationError):
        FreeChatReplyInput(category="casual", text="x" * (message_max + 1))
    FreeChatReplyInput(category="career", text="x", recent_turns=[turn] * reply_turns)
    with pytest.raises(ValidationError):
        FreeChatReplyInput(category="career", text="x", recent_turns=[turn] * (reply_turns + 1))
    with pytest.raises(ValidationError):
        FreeChatReplyInput(category="jobs", text="x")  # fixed copy, never a model reply

    FreeChatAnswer(status="answer", lines=["x" * line_max] * 4, followup_chips=["c" * chip_max] * 3)
    with pytest.raises(ValidationError):
        FreeChatAnswer(status="answer", lines=["x" * (line_max + 1)])
    with pytest.raises(ValidationError):
        FreeChatAnswer(status="answer", lines=["ok"], followup_chips=["c" * (chip_max + 1)])
    with pytest.raises(ValidationError):
        FreeChatAnswer(status="answer", lines=[])
    with pytest.raises(ValidationError):
        FreeChatAnswer(status="answer", lines=["a"] * 5)
    with pytest.raises(ValidationError):
        FreeChatAnswer(status="answer", lines=["ok"], followup_chips=["c"] * 4)

    FreeChatClassifyOutput(category="unclear", confidence=0.0)
    FreeChatClassifyOutput(category="unclear", confidence=1.0)
    for bad in (-0.1, 1.1):
        with pytest.raises(ValidationError):
            FreeChatClassifyOutput(category="unclear", confidence=bad)


def test_free_chat_summary_bounds_match_the_zod_source_at_the_boundary():
    """Release 2 (§8). The input cap is the API's storage cap; the output cap is looser so an
    over-long summary reaches the API's validator (outcome `rejected`) instead of failing here."""
    summary_max = _free_chat_ts_int("SUMMARY_MAX")
    output_max = _free_chat_ts_int("SUMMARY_OUTPUT_MAX")
    turns_max = _free_chat_ts_int("SUMMARY_TURNS_MAX")
    assert (summary_max, output_max, turns_max) == (1200, 2000, 24)  # non-vacuous
    turn = {"role": "worker", "text": "kuch"}

    FreeChatReplyInput(category="casual", text="x", summary="s" * summary_max)
    FreeChatReplyInput(category="casual", text="x", summary=None)
    for bad in ("", "s" * (summary_max + 1)):
        with pytest.raises(ValidationError):
            FreeChatReplyInput(category="casual", text="x", summary=bad)

    FreeChatSummarizeInput(turns=[turn])
    FreeChatSummarizeInput(turns=[turn] * turns_max, previous_summary="s" * summary_max)
    with pytest.raises(ValidationError):
        FreeChatSummarizeInput(turns=[])  # Zod .min(1): a fold of nothing is never sent
    with pytest.raises(ValidationError):
        FreeChatSummarizeInput(turns=[turn] * (turns_max + 1))
    with pytest.raises(ValidationError):
        FreeChatSummarizeInput()  # `turns` is required, with no default
    for bad in ("", "s" * (summary_max + 1)):
        with pytest.raises(ValidationError):
            FreeChatSummarizeInput(turns=[turn], previous_summary=bad)

    FreeChatSummarizeOutput(summary="s" * output_max)
    FreeChatSummarizeOutput(summary="s" * (summary_max + 1))  # past storage, still on the wire
    for bad in ("", "s" * (output_max + 1)):
        with pytest.raises(ValidationError):
            FreeChatSummarizeOutput(summary=bad)


def test_free_chat_defaults_match_the_zod_source():
    """Each Zod `.default(...)` has the same Pydantic default, so a far side that omits the field
    parses to the same value on both sides."""
    classify = FreeChatClassifyInput(text="x", mode="free")
    assert classify.recent_turns == []
    assert classify.pending_question is None
    out = FreeChatClassifyOutput(category="career", confidence=0.9)
    assert out.blocked is False
    assert out.ai_metadata is None
    reply = FreeChatReplyInput(category="casual", text="x")
    assert reply.recent_turns == []
    assert reply.worker_context.model_dump() == {"trade_label": None, "experience_bucket": None}
    assert reply.summary is None  # Release 2: additive, so a Release 1 caller parses unchanged
    answer = FreeChatAnswer(status="answer", lines=["x"])
    assert answer.followup_chips == []
    assert answer.ai_metadata is None
    assert FreeChatRefuse(status="refuse", topic="news").ai_metadata is None
    fold = FreeChatSummarizeInput(turns=[{"role": "worker", "text": "kuch"}])
    assert fold.previous_summary is None
    folded = FreeChatSummarizeOutput()
    assert (folded.summary, folded.ai_metadata) == (None, None)


def test_free_chat_reply_output_is_a_status_discriminated_union():
    """`status` is REQUIRED and picks the member, like the Zod `discriminatedUnion`: a missing or
    unknown discriminant fails the contract (the route turns that into `refuse/unsafe_other`)."""
    union = TypeAdapter(FreeChatReplyOutput)
    assert isinstance(union.validate_python({"status": "answer", "lines": ["x"]}), FreeChatAnswer)
    refused = union.validate_python({"status": "refuse", "topic": "distress"})
    assert isinstance(refused, FreeChatRefuse)
    for bad in (
        {"lines": ["x"]},  # no discriminant
        {"status": "maybe", "lines": ["x"]},  # unknown discriminant
        {"status": "refuse", "topic": "salary_promise"},  # the COMPANION's topic, not ours
        {"status": "answer", "topic": "news"},  # a refusal body under the answer tag
    ):
        with pytest.raises(ValidationError):
            union.validate_python(bad)


def test_the_free_chat_contracts_reuse_the_companion_shapes():
    """One recent-turn shape and one worker-context shape, as the Zod file imports them."""
    turns = list[CompanionRecentTurn]
    assert FreeChatClassifyInput.model_fields["recent_turns"].annotation == turns
    assert FreeChatReplyInput.model_fields["recent_turns"].annotation == turns
    assert FreeChatSummarizeInput.model_fields["turns"].annotation == turns
    context = FreeChatReplyInput.model_fields["worker_context"].annotation
    assert context is CompanionCareerWorkerContext


def test_only_the_reply_reads_the_summary():
    """R24: the casual/career reply gets the summary; the classifier never does. A `summary` on
    the classify contract would be the first step to sending it there."""
    assert "summary" in FreeChatReplyInput.model_fields
    assert "summary" not in FreeChatClassifyInput.model_fields


def test_the_free_chat_contracts_carry_no_identity_pii_field():
    banned = {"worker_id", "worker_ref", "worker_name", "name", "phone", "address", "city"}
    for model_name, model in _FREE_CHAT_MODELS.items():
        assert banned.isdisjoint(set(model.model_fields)), model_name


def test_free_chat_news_output_is_a_three_way_union_on_status():
    """ADR-0054: answer | no_results | refuse, discriminated like the Zod union; a news answer
    carries 1-3 sources and at most 3 charged searches."""
    adapter = TypeAdapter(FreeChatNewsOutput)
    source = {"url": "https://www.thehindu.com/a", "title": "Headline", "site": "thehindu.com"}
    answer = {
        "status": "answer",
        "kind": "work",
        "lines": ["Ek line"],
        "sources": [source],
        "search_count": 1,
    }
    assert isinstance(adapter.validate_python(answer), FreeChatNewsAnswer)
    assert isinstance(
        adapter.validate_python({"status": "no_results", "search_count": 0}), FreeChatNewsNoResults
    )
    assert isinstance(
        adapter.validate_python({"status": "refuse", "topic": "off_limits"}), FreeChatNewsRefuse
    )
    for bad in (
        {**answer, "sources": []},
        {**answer, "sources": [source] * 4},
        {**answer, "search_count": 4},
        {**answer, "kind": "politics"},
        {"status": "gossip"},
    ):
        with pytest.raises(ValidationError):
            adapter.validate_python(bad)
    assert FreeChatNewsInput(text="aaj ka mausam").recent_turns == []
    assert FreeChatNewsSource.model_fields.keys() == {"url", "title", "site"}
