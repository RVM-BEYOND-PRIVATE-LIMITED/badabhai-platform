"""`AI_RAW_PII_ENABLED` — the platform-wide lift of the PII-to-prompt rule (owner decision
2026-09-30, docs/decisions/0047-lift-pii-restriction.md).

WHAT THIS FILE PINS, in the order a regression would hurt:

1. OFF IS TODAY. The default is false and an empty value refuses to boot. Every existing masking
   suite still runs against the default and is untouched; the OFF half of each pair below proves
   the SAME probe is masked on the SAME route, so the ON half is not passing on a route that never
   masked in the first place.
2. ON MEANS UNMASKED, AND ONLY AT THE PROMPT. Each switched route hands the router the raw text,
   the size caps and the non-string refusal survive, and nothing else about the request moves.
3. THE WALLS DO NOT MOVE. With the flag on, a phone or a PAN the model hands back is still refused
   by the wall that stores it — and each such test has a MUTATION TWIN that points the wall at a
   pass-all certifier and watches the value survive, so the wall, not something beside it, is what
   was proven to refuse.
4. THE TRACE SINKS MOVE WITH THE PROMPT, and only with this flag — and the posture is RECORDED:
   a WARNING at boot and a closed boolean on every routed call's task span.
5. THE BLAST RADIUS IS ENUMERABLE. Exactly the listed modules read the flag, every direct
   `pseudonymize()` call left in the service is a classified wall, sink or at-rest copy, and no
   call outside the policy module hard-codes a posture — so a new prompt path that masks by hand
   (ignoring the flag) or unmasks by hand (ignoring it the other way) fails here until it is
   routed through `app/llm_input_policy.py`.

AND THE FOUR MEASURED GAPS, CLOSED (section 6). Four outputs on switched routes were guarded only
by "would the gateway BLOCK this", or by nothing, which held while the model read masked text and
did not once it read raw text — Phase C's certifiers, the polish rewrite, the classic turn's output
and the /profile/parse evidence quote. They were pinned here as strict xfails first; ADR-0047 G1
closed them with a hard-identifier floor that reads no flag (`app/output_floor.py`), so each is now
a plain test with an OFF leg and a mutation twin — as are three more outputs found by probing every
switched route armed: /profile/extract's stored rich draft, companion v2's edit rows and the
/resume/generate summary. The floor does touch the OFF posture, only ever toward over-masking
(measured: `contains_hard_identifier("2010-2015, 2016-2020")` is "phone"), which is why it runs
PER FIELD inside an experience: an honest dashed year range costs its `duration_text`, not the job.
"""

from __future__ import annotations

import ast
import asyncio
import contextlib
import inspect
import json
import logging
import sys
import types
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.main as main_module
from app import certified_values, output_floor
from app.ai import cost_tracker, langfuse_tracing
from app.ai import router as router_module
from app.ai.langfuse_tracing import REDACTED, LangfuseTracer, masked_trace_text, trace_mask
from app.ai.provider_cooldown import reset_cooldown
from app.ai.router import AIRouter
from app.companion import edit_parse as edit_parse_logic
from app.config import Settings, get_settings
from app.contracts import AICallMetadata, ResumeParseInput, TargetField
from app.llm_input_policy import (
    llm_input_gate,
    llm_input_masker,
    log_input_posture,
    raw_line_masker,
    resume_input_raw,
)
from app.output_floor import carries_hard_identifier, floored_items, floored_scalar
from app.profiling import parse_gates, profile_extractor
from app.profiling.parse_masking import (
    PARSE_MESSAGE_MAX_CHARS,
    default_masker,
    passthrough_masker,
)
from app.pseudonymize import (
    DEFAULT_MAX_LENGTH,
    certified_clean_skill_labels,
    certify_value,
    contains_hard_identifier,
    is_certified_clean,
    pseudonymize,
)
from app.resume_import import parse_policy
from app.resume_import import resume_parse as parse_mod
from app.resume_import.extract import ExtractionResult, Line
from app.routers import profile as profile_router
from app.routers import profiling as profiling_router

client = TestClient(main_module.app)

APP_ROOT = Path(__file__).resolve().parents[1] / "app"

#: One sentence carrying three identity classes the gateway masks. Its masked form is
#: "mera naam [PERSON_1] hai, phone [PHONE_1], [EMPLOYER_1] mein welder tha" — asserted below
#: rather than assumed, because a probe the gateway never masked would make every ON test vacuous.
PROBE = "mera naam Ramesh Kumar hai, phone 9876543210, Tata Motors mein welder tha"
RAW_PIECES = ("Ramesh Kumar", "9876543210", "Tata Motors")

PHONE = "9876543210"
PAN = "ABCDE1234F"


def _run(coro):
    return asyncio.run(coro)


def _meta(task_type: str = "profiling_chat_turn", *, real_call: bool = True) -> AICallMetadata:
    return AICallMetadata(
        ai_call_id="call-raw-pii",
        task_type=task_type,
        model_name="test-model",
        provider="test-provider",
        real_call=real_call,
        created_at="2026-09-30T00:00:00Z",
    )


class RecordingRouter:
    """Stands in for `AIRouter.run` and records what would have crossed the boundary.

    Recording the ACTUAL messages is the only honest way to test a privacy switch: a double that
    answers whatever it is asked proves the route ran, not what it sent.
    """

    def __init__(self, reply: str = "{}", *, real_call: bool = False) -> None:
        self.reply = reply
        self.real_call = real_call
        self.calls: list[list[dict[str, str]]] = []

    async def run(self, task_type: str, *, messages: list[dict[str, str]], **_kwargs: Any):
        self.calls.append(messages)
        return self.reply, _meta(task_type, real_call=self.real_call)

    async def run_with_result(
        self, task_type: str, *, messages: list[dict[str, str]], **_kwargs: Any
    ):
        """`AIRouter.run_with_result` (ADR-0054's news route): the same record, no result."""
        content, meta = await self.run(task_type, messages=messages)
        return content, meta, None

    @property
    def prompt(self) -> str:
        assert self.calls, "the router was never called — this test would prove nothing"
        return "\n".join(m["content"] for call in self.calls for m in call)

    @property
    def worker_side(self) -> str:
        """Everything but the system prompts, several of which quote placeholder tokens as
        examples ("Worked at [EMPLOYER_1] on lathe") and would read as a masked input."""
        assert self.calls, "the router was never called — this test would prove nothing"
        return "\n".join(m["content"] for call in self.calls for m in call if m["role"] != "system")


def _record(monkeypatch: pytest.MonkeyPatch, reply: str = "{}", **kwargs: Any) -> RecordingRouter:
    recorder = RecordingRouter(reply, **kwargs)
    # The ONE router object every route module imported from `_shared`, at BOTH entry points:
    # a route that calls `run_with_result` must be recorded, not served by the real router.
    monkeypatch.setattr(main_module.router, "run", recorder.run)
    monkeypatch.setattr(main_module.router, "run_with_result", recorder.run_with_result)
    return recorder


def _arm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Flip the flag on the process singleton every route reads at request time."""
    monkeypatch.setattr(get_settings(), "ai_raw_pii_enabled", True)


# ===========================================================================
# 1. The setting
# ===========================================================================


def test_the_flag_defaults_to_off() -> None:
    assert Settings(_env_file=None).ai_raw_pii_enabled is False


def test_empty_string_is_not_a_legal_flag_value(monkeypatch: pytest.MonkeyPatch) -> None:
    """WHY COMPOSE MUST CARRY `${AI_RAW_PII_ENABLED:-false}` AND NOT `:-`.

    Measured through the process environment, the way compose and the deploy bridge deliver it:
    an unset GitHub secret arrives as "", and "" must not boot this service. `:-false` is what
    turns both unset and empty into the committed default.
    """
    monkeypatch.setenv("AI_RAW_PII_ENABLED", "")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)

    monkeypatch.setenv("AI_RAW_PII_ENABLED", "false")
    assert Settings(_env_file=None).ai_raw_pii_enabled is False
    monkeypatch.setenv("AI_RAW_PII_ENABLED", "true")
    assert Settings(_env_file=None).ai_raw_pii_enabled is True


@pytest.mark.parametrize("value", ["True", "TRUE", "yes", "on", "t", "y", "False", "no", " true"])
def test_a_value_the_api_refuses_does_not_boot_this_service_either(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    """ONE VARIABLE, TWO PARSERS, ONE GRAMMAR (ADR-0047 §5).

    pydantic's own bool reads every one of these; apps/api's `booleanFromString` throws on every
    one at boot. Accepting them here would let the deploy recreate this service ARMED and then
    crash-loop the api it recreates next. packages/config/src/config.test.ts pins the api half.
    """
    monkeypatch.setenv("AI_RAW_PII_ENABLED", value)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


@pytest.mark.parametrize(("value", "armed"), [("1", True), ("0", False)])
def test_the_numeric_forms_the_api_accepts_are_accepted_here(
    monkeypatch: pytest.MonkeyPatch, value: str, armed: bool
) -> None:
    monkeypatch.setenv("AI_RAW_PII_ENABLED", value)
    assert Settings(_env_file=None).ai_raw_pii_enabled is armed


def test_the_probe_is_masked_by_the_gateway_so_the_on_tests_mean_something() -> None:
    masked = pseudonymize(PROBE)
    assert masked.blocked is False
    assert masked.text == "mera naam [PERSON_1] hai, phone [PHONE_1], [EMPLOYER_1] mein welder tha"


# ===========================================================================
# 2. The gate itself
# ===========================================================================


@pytest.mark.parametrize(
    "text",
    [PROBE, "Ramesh Kumar", "reference number 12345678", "x" * (DEFAULT_MAX_LENGTH + 1), ""],
)
def test_off_the_gate_IS_pseudonymize(text: str) -> None:
    """Byte-identical to the call it replaced, blocked verdicts and reasons included."""
    assert llm_input_gate(text, raw=False) == pseudonymize(text)
    assert llm_input_gate(text, raw=False, max_length=50) == pseudonymize(text, max_length=50)


def test_on_the_text_passes_through_untouched() -> None:
    result = llm_input_gate(PROBE, raw=True)
    assert result.text == PROBE
    assert result.blocked is False
    assert result.blocked_reason is None
    assert result.replaced_entities == 0
    assert result.placeholder_tokens == []


def test_on_the_residual_digit_net_no_longer_blocks() -> None:
    """The one behavioural change in what "blocked" means: a residual digit run is a PII verdict,
    so it lifts with the flag. Off, this exact text is the suite's canonical blocking input."""
    assert pseudonymize("reference number 12345678").blocked is True
    assert llm_input_gate("reference number 12345678", raw=True).blocked is False


@pytest.mark.parametrize("max_length", [DEFAULT_MAX_LENGTH, PARSE_MESSAGE_MAX_CHARS, 10])
def test_on_the_size_cap_survives_with_the_gateways_own_verdict(max_length: int) -> None:
    oversize = "a" * (max_length + 1)
    on = llm_input_gate(oversize, raw=True, max_length=max_length)
    off = pseudonymize(oversize, max_length=max_length)
    assert on.blocked is True
    assert on == off, "a refusal must read identically under either posture"
    # The boundary itself is still admitted.
    assert llm_input_gate("a" * max_length, raw=True, max_length=max_length).blocked is False


def test_on_a_non_string_is_still_refused() -> None:
    on = llm_input_gate(12345, raw=True)  # type: ignore[arg-type]
    assert on.blocked is True
    assert on == pseudonymize(12345)  # type: ignore[arg-type]


def test_the_per_line_masker_is_a_switch() -> None:
    assert llm_input_masker(raw=False) is default_masker
    assert llm_input_masker(raw=True) is raw_line_masker
    # NOT the synthetic-persona / D5 masker, which drops the cap as well as the masking.
    assert llm_input_masker(raw=True) is not passthrough_masker


def test_the_raw_line_masker_keeps_the_one_utterance_cap() -> None:
    assert raw_line_masker(PROBE) == (False, PROBE)
    assert raw_line_masker("a" * PARSE_MESSAGE_MAX_CHARS) == (False, "a" * PARSE_MESSAGE_MAX_CHARS)
    assert raw_line_masker("a" * (PARSE_MESSAGE_MAX_CHARS + 1)) == (True, "")


@pytest.mark.parametrize(
    ("resume_flag", "platform_flag", "expected"),
    [(False, False, False), (True, False, True), (False, True, True), (True, True, True)],
)
def test_the_resume_posture_is_either_flag(
    resume_flag: bool, platform_flag: bool, expected: bool
) -> None:
    settings = Settings(
        _env_file=None,
        resume_parse_raw_text_enabled=resume_flag,
        ai_raw_pii_enabled=platform_flag,
    )
    assert resume_input_raw(settings) is expected


# ===========================================================================
# 3. Every switched route: masked OFF, raw ON
# ===========================================================================

_CAREER_CONTEXT = {"trade_label": "Welder", "experience_bucket": "3-7"}
_PARSE_TARGETS = [{"field_id": "experience_years", "type": "number", "unit": "years"}]


def _line(i: int, role: str, text: str) -> dict[str, Any]:
    return {"i": i, "role": role, "text": text}


#: (case id, path, body, the raw substrings that must reach the model ON and must not OFF).
ROUTE_CASES: list[tuple[str, str, dict[str, Any], tuple[str, ...]]] = [
    (
        "profiling-turn-message",
        "/profiling/turn",
        {"worker_ref": "w1", "stage": "domain", "message_text": PROBE},
        RAW_PIECES,
    ),
    (
        "profiling-turn-history",
        "/profiling/turn",
        {
            "worker_ref": "w1",
            "stage": "domain",
            "message_text": "haan",
            "history": [_line(0, "worker", PROBE)],
        },
        RAW_PIECES,
    ),
    (
        "profiling-extract",
        "/profiling/extract",
        {"worker_ref": "w1", "transcript": [_line(0, "worker", PROBE)]},
        RAW_PIECES,
    ),
    (
        "polish-work-done",
        "/profiling/work-history/polish",
        {"schema_version": "oie.v1", "worker_ref": "w1", "work_done": PROBE},
        RAW_PIECES,
    ),
    (
        # Off, a role that is not certified-clean is replaced by the literal "worker".
        "polish-role",
        "/profiling/work-history/polish",
        {
            "schema_version": "oie.v1",
            "worker_ref": "w1",
            "work_done": "lathe pe shaft banata tha",
            "role_label": "Operator, Ramesh sir ke under",
        },
        ("Ramesh sir",),
    ),
    ("profile-extract", "/profile/extract", {"transcript": PROBE}, RAW_PIECES),
    (
        "profile-parse",
        "/profile/parse",
        {
            "worker_ref": "w1",
            "language": "hi-IN",
            "answer_map": [],
            "transcript": [_line(0, "assistant", "Kitne saal?"), _line(1, "worker", PROBE)],
            "target_fields": _PARSE_TARGETS,
        },
        RAW_PIECES,
    ),
    ("companion-classify", "/companion/classify", {"text": PROBE}, RAW_PIECES),
    (
        "companion-classify-memory",
        "/companion/classify",
        {"text": "aur yeh bhi", "recent_turns": [{"role": "worker", "text": PROBE}]},
        RAW_PIECES,
    ),
    (
        "companion-edit-parse",
        "/companion/edit-parse",
        {
            "text": PROBE,
            "catalogue": [{"section": "employment", "field": "employer_name", "ops": ["edit"]}],
            "snapshot": [
                {"ref": "e1", "section": "employment", "fields": {"employer_name": "Tata Motors"}}
            ],
            "max_rows": 3,
        },
        RAW_PIECES,
    ),
    (
        "companion-edit-parse-snapshot",
        "/companion/edit-parse",
        {
            "text": "isko badlo",
            "catalogue": [{"section": "employment", "field": "employer_name", "ops": ["edit"]}],
            "snapshot": [
                {"ref": "e1", "section": "employment", "fields": {"employer_name": "Tata Motors"}}
            ],
            "max_rows": 3,
        },
        ("Tata Motors",),
    ),
    (
        "companion-career",
        "/companion/career",
        {
            "text": PROBE,
            "recent_turns": [{"role": "worker", "text": PROBE}],
            "worker_context": _CAREER_CONTEXT,
        },
        RAW_PIECES,
    ),
    # ADR-0051 — the profiling-stage free chat: every model input of every route.
    ("free-chat-classify", "/free-chat/classify", {"text": PROBE, "mode": "free"}, RAW_PIECES),
    (
        "free-chat-classify-question",
        "/free-chat/classify",
        {"text": "5 saal", "mode": "resume", "pending_question": PROBE},
        RAW_PIECES,
    ),
    (
        "free-chat-classify-memory",
        "/free-chat/classify",
        {
            "text": "aur yeh bhi",
            "mode": "free",
            "recent_turns": [{"role": "worker", "text": PROBE}],
        },
        RAW_PIECES,
    ),
    (
        "free-chat-reply-career",
        "/free-chat/reply",
        {
            "category": "career",
            "text": PROBE,
            "recent_turns": [{"role": "worker", "text": PROBE}],
            "worker_context": _CAREER_CONTEXT,
        },
        RAW_PIECES,
    ),
    (
        "free-chat-reply-casual",
        "/free-chat/reply",
        {"category": "casual", "text": PROBE},
        RAW_PIECES,
    ),
    (
        # The trade label is gated here (the companion trusts it): in the profiling stage it is
        # whatever the interview captured so far. 64 characters at most, hence a shorter carrier.
        "free-chat-reply-trade-label",
        "/free-chat/reply",
        {
            "category": "casual",
            "text": "namaste",
            "worker_context": {"trade_label": "Welder at Tata Motors, phone 9876543210"},
        },
        ("Tata Motors", "9876543210"),
    ),
    # ADR-0051 Release 2 (§8): the rolling summary, as the reply reads it and as the fold
    # writes it. Model-written and API-validated at rest, and still gated like every other input.
    (
        "free-chat-reply-summary",
        "/free-chat/reply",
        {"category": "career", "text": "aur kya seekhun", "summary": PROBE},
        RAW_PIECES,
    ),
    (
        "free-chat-summarize-turns",
        "/free-chat/summarize",
        {"turns": [{"role": "worker", "text": PROBE}, {"role": "bada_bhai", "text": "Achha."}]},
        RAW_PIECES,
    ),
    (
        "free-chat-summarize-previous",
        "/free-chat/summarize",
        {"previous_summary": PROBE, "turns": [{"role": "worker", "text": "theek hai"}]},
        RAW_PIECES,
    ),
    # ADR-0054: the news answer — the question, the recent turns and the trade label, each gated
    # like the reply's, because this call also carries the web search tool. The QUESTION's
    # carrier has no phone: owner ruling R9 refuses a question with a hard identifier before any
    # call under either posture (pinned in tests/free_chat/test_free_chat_news.py), so the
    # masking switch is proven here on the name and the employer.
    (
        "free-chat-news",
        "/free-chat/news",
        {"text": "mera naam Ramesh Kumar hai, Tata Motors mein welder tha"},
        ("Ramesh Kumar", "Tata Motors"),
    ),
    (
        # The turn's carrier has no phone either: R9 in depth DROPS a turn carrying a hard
        # identifier under both postures (pinned in tests/free_chat/test_free_chat_news.py).
        "free-chat-news-memory",
        "/free-chat/news",
        {
            "text": "aur batao",
            "recent_turns": [
                {"role": "worker", "text": "mera naam Ramesh Kumar hai, Tata Motors mein tha"}
            ],
        },
        ("Ramesh Kumar", "Tata Motors"),
    ),
    (
        "free-chat-news-trade-label",
        "/free-chat/news",
        {
            "text": "aaj ki khabar",
            "worker_context": {"trade_label": "Welder at Tata Motors, phone 9876543210"},
        },
        ("Tata Motors", "9876543210"),
    ),
    (
        # `shift` is a free-text field the résumé boundary does not certify, so the payload
        # gate is its only mask — the honest carrier (see test_egress_gates.py).
        "resume-generate",
        "/resume/generate",
        {
            "worker_ref": "w1",
            "profile": {"canonical_role_id": "role_vmc_operator", "shift": PROBE},
        },
        RAW_PIECES,
    ),
]


@pytest.mark.parametrize(
    ("path", "body", "raw_pieces"),
    [case[1:] for case in ROUTE_CASES],
    ids=[case[0] for case in ROUTE_CASES],
)
def test_off_the_route_sends_the_model_masked_text(
    monkeypatch: pytest.MonkeyPatch, path: str, body: dict[str, Any], raw_pieces: tuple[str, ...]
) -> None:
    recorder = _record(monkeypatch)
    assert client.post(path, json=body).status_code == 200
    for piece in raw_pieces:
        assert piece not in recorder.prompt, f"{piece!r} reached the model with the flag OFF"


@pytest.mark.parametrize(
    ("path", "body", "raw_pieces"),
    [case[1:] for case in ROUTE_CASES],
    ids=[case[0] for case in ROUTE_CASES],
)
def test_on_the_route_sends_the_model_the_raw_text(
    monkeypatch: pytest.MonkeyPatch, path: str, body: dict[str, Any], raw_pieces: tuple[str, ...]
) -> None:
    _arm(monkeypatch)
    recorder = _record(monkeypatch)
    assert client.post(path, json=body).status_code == 200
    for piece in raw_pieces:
        assert piece in recorder.prompt, f"{piece!r} did not reach the model with the flag ON"
    for token in ("[PERSON_1]", "[PHONE_1]", "[EMPLOYER_1]"):
        assert token not in recorder.worker_side, f"{token} minted with the flag ON"


def test_on_the_voice_translate_leg_gets_the_raw_transcript(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.stt import SttResult
    from app.translate import TranslateResult

    sent: list[str] = []

    async def _fake_transcribe(**_kwargs: Any) -> SttResult:
        return SttResult(PROBE, 0.9, "hi", True)

    async def _fake_translate(*, text: str, source_language_code: str, real_call_allowed: bool):
        sent.append(text)
        return TranslateResult(english_text="translated", detected_source="hi-IN", is_mock=True)

    monkeypatch.setattr(main_module.stt_adapter, "transcribe", _fake_transcribe)
    monkeypatch.setattr(main_module.translate_adapter, "translate", _fake_translate)
    body = {"voice_note_id": "vn1", "storage_path": "x", "translate_to_english": True}

    assert client.post("/voice/transcribe", json=body).status_code == 200
    assert PHONE not in sent[-1] and "[PHONE_1]" in sent[-1]

    _arm(monkeypatch)
    assert client.post("/voice/transcribe", json=body).status_code == 200
    assert sent[-1] == PROBE


def _resume_settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "_env_file": None,
        "resume_uploads_bucket": "worker-resume-uploads",
        "supabase_url": "https://example.invalid",
        "supabase_service_role_key": "srk",
    }
    return Settings(**{**base, **overrides})


def _parse_resume(
    monkeypatch: pytest.MonkeyPatch, texts: list[str], reply: str, **settings_overrides: Any
):
    """The résumé parse with storage and extraction stubbed and the router recording."""
    extraction = ExtractionResult(
        method="pdf_text",
        lines=tuple(Line(index=i, page=1, text=t) for i, t in enumerate(texts)),
        page_count=1,
        ocr_confidence=None,
        degraded_reason=None,
        truncated=False,
    )

    async def _fake_download(*_args: Any, **_kwargs: Any) -> bytes:
        return b"%PDF-1.4 stub"

    monkeypatch.setattr(parse_mod, "download_object", _fake_download)
    monkeypatch.setattr(parse_mod, "extract", lambda data, mime: extraction)
    recorder = RecordingRouter(reply, real_call=True)
    body = ResumeParseInput(
        worker_ref="wr_1",
        storage_key="resume-uploads/w/x.pdf",
        mime="application/pdf",
        target_fields=[TargetField(field_id="current_city", type="string")],
    )
    settings = _resume_settings(**settings_overrides)
    return _run(parse_mod.parse_resume(body, settings=settings, router=recorder)), recorder


def _resume_reply(value: str, quote: str) -> str:
    field = {
        "value": value,
        "evidence": {"message_index": 0, "quote": quote},
        "source": "transcript",
        "normalization": "verbatim",
        "confidence": 0.9,
    }
    return json.dumps({"fields": {"current_city": field}, "employments": []})


def test_on_the_platform_flag_alone_sends_the_resume_raw(monkeypatch: pytest.MonkeyPatch) -> None:
    """D5's own flag stays OFF here: the platform flag is enough, and the import says so."""
    out, recorder = _parse_resume(
        monkeypatch,
        [f"Ramesh Kumar {PHONE} CNC Turner at Tata Motors Ltd"],
        json.dumps({"fields": {}, "employments": []}),
        resume_parse_raw_text_enabled=False,
        ai_raw_pii_enabled=True,
    )
    assert PHONE in recorder.prompt
    assert "Tata Motors Ltd" in recorder.prompt
    assert "raw_text_policy_active" in out.notes


def test_off_both_flags_the_resume_is_still_masked(monkeypatch: pytest.MonkeyPatch) -> None:
    out, recorder = _parse_resume(
        monkeypatch,
        [f"Ramesh Kumar {PHONE} CNC Turner"],
        json.dumps({"fields": {}, "employments": []}),
    )
    assert PHONE not in recorder.prompt
    assert "raw_text_policy_active" not in out.notes


def test_on_the_size_cap_still_refuses_before_the_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    _arm(monkeypatch)
    recorder = _record(monkeypatch)
    body = {"worker_ref": "w1", "stage": "domain", "message_text": "x" * (DEFAULT_MAX_LENGTH + 1)}
    out = client.post("/profiling/turn", json=body).json()
    assert out["blocked"] is True
    assert recorder.calls == []


def test_on_an_oversize_transcript_line_is_still_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    _arm(monkeypatch)
    recorder = _record(monkeypatch)
    body = {
        "worker_ref": "w1",
        "transcript": [_line(0, "worker", "a" * (PARSE_MESSAGE_MAX_CHARS + 1))],
    }
    assert client.post("/profiling/extract", json=body).json()["is_mock"] is True
    assert recorder.calls == [], "the only line was over the cap, so nothing may be sent"


# ===========================================================================
# 4. The walls on what is STORED do not move — each with its mutation twin
# ===========================================================================


def _pass_all(text: str) -> tuple[bool, str]:
    return False, text


def test_no_wall_takes_a_policy_argument() -> None:
    """STRUCTURAL, as `parse_policy.resume_value_certifier` already is: a wall with a `raw=` or a
    masker parameter is one edit away from being handed the input policy."""
    walls: list[Callable[..., Any]] = [
        certify_value,
        is_certified_clean,
        certified_clean_skill_labels,
        contains_hard_identifier,
        parse_policy.resume_value_certifier,
        parse_policy.contains_mask_placeholder,
        certified_values.certified_scalar,
        certified_values.certified_items,
        certified_values.certify_resume_single_values,
        profile_router._certify,
        profiling_router._certified_skills,
        profiling_router._certified,
        profiling_router._certified_list,
        profiling_router._certified_scalar,
        # The G1 floor and the walls built on it (section 6).
        carries_hard_identifier,
        floored_scalar,
        floored_items,
        profiling_router._refused,
        profiling_router._floored_experience,
        profiling_router._floored_turn,
        profile_router._floor_quotes,
        profile_extractor.merge_model_draft,
        edit_parse_logic.parse_edit_rows,
    ]
    for wall in walls:
        params = set(inspect.signature(wall).parameters)
        assert not params & {"raw", "raw_text_enabled", "mask", "masker", "policy"}, wall.__name__
    assert set(inspect.signature(parse_gates.apply_parse_gates).parameters).isdisjoint({"raw"})


_SKILLS_BODY = {
    "worker_ref": "w1",
    "stage": "skills",
    "interview_mode": "skills_only",
    "message_text": PROBE,
    "draft": {"domain_label": "Metal", "role_label": "Welder", "skills": []},
}
_SKILLS_REPLY = {
    "reply_text": "Achha. Kaunsi welding?",
    "stage": "skills",
    "input_mode": "text",
    "suggested_answers": [],
    "skills": ["Welding", PHONE, PAN],
    "phase_a_done": False,
}


def test_on_the_skills_turn_still_refuses_a_phone_and_a_pan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _arm(monkeypatch)
    recorder = _record(monkeypatch, json.dumps(_SKILLS_REPLY), real_call=True)
    out = client.post("/profiling/turn", json=_SKILLS_BODY).json()
    assert PHONE in recorder.prompt, "vacuity: the raw message must have reached the model"
    assert out["skills"] == ["Welding"]


def test_mutation_twin_the_skills_certifier_is_what_refused_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """TWO WALLS refuse these now: the skills certifier, and the G1 floor every turn passes first
    (section 6 pins the floor on its own). So both are pointed at pass-all here, and the certifier
    alone is shown to hold with only the floor off."""
    _arm(monkeypatch)
    _record(monkeypatch, json.dumps(_SKILLS_REPLY), real_call=True)
    _floor_off(monkeypatch)
    assert client.post("/profiling/turn", json=_SKILLS_BODY).json()["skills"] == ["Welding"]

    monkeypatch.setattr(profiling_router, "certified_clean_skill_labels", lambda labels: labels)
    out = client.post("/profiling/turn", json=_SKILLS_BODY).json()
    assert PHONE in out["skills"] and PAN in out["skills"]


_EXTRACT_BODY = {"worker_ref": "w1", "transcript": [_line(0, "worker", PROBE)]}
_EXTRACT_REPLY = {
    "role_label": "welder",
    "skills": ["welding"],
    "current_city": f"Pune, call {PHONE}",
    "preferred_locations": ["Pune", PHONE],
}


def test_on_phase_c_still_withholds_a_phone_from_the_location(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _arm(monkeypatch)
    recorder = _record(monkeypatch, json.dumps(_EXTRACT_REPLY), real_call=True)
    out = client.post("/profiling/extract", json=_EXTRACT_BODY).json()
    assert PHONE in recorder.prompt, "vacuity: the raw transcript must have reached the model"
    assert out["current_city"] is None
    assert out["preferred_locations"] == ["Pune"]


def test_mutation_twin_the_location_certifier_is_what_withheld_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _arm(monkeypatch)
    _record(monkeypatch, json.dumps(_EXTRACT_REPLY), real_call=True)
    monkeypatch.setattr(profiling_router, "certified_scalar", lambda value: value)
    monkeypatch.setattr(profiling_router, "certified_items", lambda values: list(values))
    out = client.post("/profiling/extract", json=_EXTRACT_BODY).json()
    assert out["current_city"] == f"Pune, call {PHONE}"


_PARSE_LINE = f"mera number {PHONE} hai"
_PARSE_BODY = {
    "worker_ref": "w1",
    "language": "hi-IN",
    "answer_map": [],
    "transcript": [_line(0, "assistant", "Kuch aur?"), _line(1, "worker", _PARSE_LINE)],
    "target_fields": [{"field_id": "contact", "type": "string"}],
}
# THE ISOLATING SHAPE, as the résumé pair below uses: the quote is a clean span of the line and
# only the VALUE carries the phone. A quote that carried it would now be refused by the G1 quote
# floor as well (section 6), and gate 6 would no longer be the one wall proven to refuse it.
_PARSE_REPLY = json.dumps(
    {
        "fields": {
            "contact": {
                "value": PHONE,
                "evidence": {"message_index": 1, "quote": "mera number"},
                "source": "transcript",
                "normalization": "verbatim",
                "confidence": 0.9,
            }
        }
    }
)


def test_on_gate_6_of_profile_parse_still_refuses_a_phone(monkeypatch: pytest.MonkeyPatch) -> None:
    """ON is exactly when this matters: the model read the phone, the clean quote passes
    provenance, and gate 6 is the only thing between the phone and the stored overlay."""
    _arm(monkeypatch)
    recorder = _record(monkeypatch, _PARSE_REPLY, real_call=True)
    out = client.post("/profile/parse", json=_PARSE_BODY).json()
    assert PHONE in recorder.prompt
    assert out["fields"] == {}
    assert "fields_rejected" in out["notes"]


def test_mutation_twin_gate_6_is_what_refused_it(monkeypatch: pytest.MonkeyPatch) -> None:
    _arm(monkeypatch)
    _record(monkeypatch, _PARSE_REPLY, real_call=True)
    monkeypatch.setattr(profile_router, "_certify", _pass_all)
    out = client.post("/profile/parse", json=_PARSE_BODY).json()
    assert out["fields"]["contact"]["value"] == PHONE


def test_on_the_resume_gate_6_still_refuses_a_pan(monkeypatch: pytest.MonkeyPatch) -> None:
    """The ISOLATING shape from test_resume_parse.py: the quote is clean and only the VALUE
    carries the PAN, so nothing but gate 6 can refuse it — here armed by the platform flag."""
    out, recorder = _parse_resume(
        monkeypatch,
        [f"CNC Turner Pune PAN {PAN}"],
        _resume_reply(f"PAN {PAN}", "CNC Turner"),
        ai_raw_pii_enabled=True,
    )
    assert PAN in recorder.prompt
    assert out.fields == {}


def test_mutation_twin_the_resume_certifier_is_what_refused_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parse_mod, "resume_value_certifier", _pass_all)
    out, _recorder = _parse_resume(
        monkeypatch,
        [f"CNC Turner Pune PAN {PAN}"],
        _resume_reply(f"PAN {PAN}", "CNC Turner"),
        ai_raw_pii_enabled=True,
    )
    assert out.fields["current_city"].value == f"PAN {PAN}"


def test_pseudonymize_itself_does_not_move_with_the_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    probes = [PROBE, f"PAN {PAN}", "reference number 12345678", "x" * (DEFAULT_MAX_LENGTH + 1)]

    def verdicts() -> list[tuple[Any, ...]]:
        return [
            (
                pseudonymize(p),
                contains_hard_identifier(p),
                certify_value(p),
                carries_hard_identifier(p),
                profiling_router._refused(p),
            )
            for p in probes
        ]

    before = verdicts()
    _arm(monkeypatch)
    assert verdicts() == before


# ===========================================================================
# 5. The trace sinks move with the prompt, and only with this flag
# ===========================================================================


def test_off_the_trace_mask_is_the_masking_hook() -> None:
    assert trace_mask(raw=False) is langfuse_tracing._mask
    assert trace_mask(raw=False)(data=PROBE) == pseudonymize(PROBE).text
    assert trace_mask(raw=False)(data="x" * (DEFAULT_MAX_LENGTH + 1)) == REDACTED


def test_on_the_trace_mask_passes_every_shape_through() -> None:
    passthrough = trace_mask(raw=True)
    payload = [{"role": "user", "content": PROBE}, {"n": 3}]
    assert passthrough(data=payload) is payload
    assert passthrough(data=PROBE) == PROBE
    oversize = "x" * (DEFAULT_MAX_LENGTH + 1)
    assert passthrough(data=oversize) == oversize


def test_masked_trace_text_follows_the_same_switch() -> None:
    messages = [{"role": "user", "content": PROBE}]
    assert masked_trace_text(messages) == pseudonymize(PROBE).text
    assert masked_trace_text(messages, raw=True) == PROBE


class _FakeLangfuse:
    """The SDK class, stubbed: a real client starts a network exporter the suite refuses."""

    built: list[dict[str, Any]] = []

    def __init__(self, **kwargs: Any) -> None:
        _FakeLangfuse.built.append(kwargs)


def _tracer_mask(monkeypatch: pytest.MonkeyPatch, *, raw: bool) -> Any:
    sdk = types.ModuleType("langfuse")
    sdk.Langfuse = _FakeLangfuse  # type: ignore[attr-defined]
    sdk.propagate_attributes = lambda **_kw: contextlib.nullcontext()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "langfuse", sdk)
    _FakeLangfuse.built.clear()
    settings = Settings(
        _env_file=None,
        langfuse_public_key="pk-test",
        langfuse_secret_key="sk-test",
        ai_raw_pii_enabled=raw,
    )
    tracer = LangfuseTracer(settings)
    assert tracer.enabled
    return _FakeLangfuse.built[-1]["mask"]


def test_the_sdk_is_handed_the_masking_hook_when_off(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _tracer_mask(monkeypatch, raw=False) is langfuse_tracing._mask


def test_the_sdk_is_handed_the_pass_through_hook_when_on(monkeypatch: pytest.MonkeyPatch) -> None:
    mask = _tracer_mask(monkeypatch, raw=True)
    assert mask is trace_mask(raw=True)
    assert mask(data=PROBE) == PROBE


def test_the_resume_flag_alone_never_unmasks_a_trace(monkeypatch: pytest.MonkeyPatch) -> None:
    """D5 moved one route's PROMPT; its traces stayed masked, and still do."""
    sdk = types.ModuleType("langfuse")
    sdk.Langfuse = _FakeLangfuse  # type: ignore[attr-defined]
    sdk.propagate_attributes = lambda **_kw: contextlib.nullcontext()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "langfuse", sdk)
    settings = Settings(
        _env_file=None,
        langfuse_public_key="pk-test",
        langfuse_secret_key="sk-test",
        resume_parse_raw_text_enabled=True,
    )
    LangfuseTracer(settings)
    assert _FakeLangfuse.built[-1]["mask"] is langfuse_tracing._mask


@pytest.fixture
def _isolated_router(monkeypatch: pytest.MonkeyPatch):
    """The two process-wide singletons the router reads, reset (see test_ai_call_trace_text.py),
    and a provider dispatcher that refuses to run, so nothing here can reach a network."""

    async def _boom(**_kwargs: Any):
        raise RuntimeError("forced failure (no network in tests)")

    monkeypatch.setattr(router_module.providers, "complete", _boom)
    reset_cooldown()
    cost_tracker._ledger = cost_tracker.SpendLedger(
        Settings(_env_file=None, ai_spend_redis_url=None)
    )
    yield
    reset_cooldown()
    cost_tracker._ledger = None


def _trace_text(**settings_overrides: Any) -> AICallMetadata:
    router = AIRouter(Settings(_env_file=None, **settings_overrides))
    _content, meta = _run(
        router.run(
            "profile_extraction",
            messages=[{"role": "user", "content": PROBE}],
            mock_response=f'{{"note": "call {PHONE}"}}',
        )
    )
    return meta


@pytest.mark.usefixtures("_isolated_router")
def test_the_trace_store_holds_masked_text_when_off() -> None:
    meta = _trace_text(ai_call_trace_text_enabled=True)
    assert "Ramesh Kumar" not in (meta.prompt_text or "")
    assert PHONE not in (meta.response_text or "")


@pytest.mark.usefixtures("_isolated_router")
def test_the_trace_store_holds_what_was_sent_when_on() -> None:
    meta = _trace_text(ai_call_trace_text_enabled=True, ai_raw_pii_enabled=True)
    assert meta.prompt_text == PROBE
    assert PHONE in (meta.response_text or "")


@pytest.mark.usefixtures("_isolated_router")
def test_on_does_not_arm_the_trace_store_by_itself() -> None:
    meta = _trace_text(ai_raw_pii_enabled=True)
    assert meta.prompt_text is None
    assert meta.response_text is None


# --- the posture is recorded, so "was this call unmasked?" has an answer after the fact -------


def _privacy_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == "ai.privacy"]


def test_boot_announces_the_raw_posture(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.DEBUG, logger="ai.privacy"):
        log_input_posture(Settings(_env_file=None, ai_raw_pii_enabled=True))
    records = _privacy_records(caplog)
    assert [r.levelno for r in records] == [logging.WARNING]
    assert "AI_RAW_PII_ENABLED is ON" in records[0].getMessage()


def test_boot_is_silent_on_the_default_posture(caplog: pytest.LogCaptureFixture) -> None:
    """Including under D5's résumé flag alone, which moves one route and announces nothing new."""
    with caplog.at_level(logging.DEBUG, logger="ai.privacy"):
        log_input_posture(Settings(_env_file=None))
        log_input_posture(Settings(_env_file=None, resume_parse_raw_text_enabled=True))
    assert _privacy_records(caplog) == []


def test_the_lifespan_is_what_announces_it(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Pinned through the real boot hook, not the helper: a helper nobody calls says nothing."""
    _arm(monkeypatch)
    monkeypatch.setattr(cost_tracker, "_ledger", None)
    with caplog.at_level(logging.WARNING, logger="ai.privacy"):
        with TestClient(main_module.app):  # __enter__ runs the lifespan startup
            pass
    monkeypatch.setattr(cost_tracker, "_ledger", None)
    assert len(_privacy_records(caplog)) == 1


class _SpanRecorder:
    """The SDK client, stubbed to keep what each span was OPENED with."""

    def __init__(self) -> None:
        self.opened: list[dict[str, Any]] = []

    def start_as_current_observation(self, **kwargs: Any) -> Any:
        self.opened.append(kwargs)
        return contextlib.nullcontext(types.SimpleNamespace(update=lambda **_fields: None))


def _task_span_metadata(**settings_overrides: Any) -> dict[str, Any]:
    settings = Settings(_env_file=None, **settings_overrides)
    tracer = LangfuseTracer(settings)
    client = _SpanRecorder()
    tracer._enabled, tracer._client = True, client
    tracer._propagate = lambda **_kw: contextlib.nullcontext()
    tracer._probe_capabilities(type(client))
    messages = [{"role": "user", "content": "haan"}]
    _run(
        AIRouter(settings, tracer=tracer).run(
            "profile_extraction", messages=messages, mock_response="{}"
        )
    )
    return client.opened[0]["metadata"]


@pytest.mark.usefixtures("_isolated_router")
@pytest.mark.parametrize("armed", [False, True])
def test_every_routed_call_records_its_posture(armed: bool) -> None:
    """ON THE TASK SPAN, which every `router.run` opens — and every `router.run` caller is a
    switched route (pinned below), so the boolean is the per-call answer rather than a
    process-wide guess."""
    assert _task_span_metadata(ai_raw_pii_enabled=armed)["ai_raw_pii_enabled"] is armed


#: Every module that hands `AIRouter.run` a prompt. Each builds that prompt through
#: `llm_input_policy`, which is what makes the router's posture stamp true of the call; a new
#: caller must be added here in review, after someone checks that it does too.
ROUTER_CALLERS = frozenset(
    {
        "routers/profiling.py",
        "routers/profile.py",
        "routers/companion.py",
        "routers/free_chat.py",
        "routers/resume.py",
        "resume_import/resume_parse.py",
        "resume_import/resume_summary.py",
        "resume_import/resume_option_map.py",
    }
)


def test_the_router_posture_stamp_covers_exactly_the_switched_callers() -> None:
    callers = {
        module
        for module, tree in _python_modules()
        if module != "ai/router.py"
        and any(
            isinstance(node, ast.Call)
            # Both entry points: `run_with_result` (ADR-0054) opens the same task span, and a
            # caller using only it must not escape this review list.
            and _referenced_name(node.func) in {"run", "run_with_result"}
            and any(kw.arg == "messages" for kw in node.keywords)
            for node in ast.walk(tree)
        )
    }
    assert callers == ROUTER_CALLERS


# ===========================================================================
# 6. The measured gaps, closed by the hard-identifier floor (ADR-0047 G1)
# ===========================================================================
#
# Each gap was pinned here first as a strict xfail: an output on a switched route guarded only by
# "would the gateway BLOCK this", or by nothing, so a model that read the raw text could echo the
# worker's phone or PAN into it — and the gateway masks those rather than blocking them. Each is
# now a plain test with three legs: ON, the echo is dropped; OFF, the floor holds just the same
# (it reads no flag — there the identifier is one the model composed itself) while clean values
# pass untouched; and a MUTATION TWIN with the floor pointed at pass-all watches the identifier
# survive, so the floor, not a wall beside it, is what was proven to refuse.


def _floor_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """The mutation: the floor refuses nothing. Patched at its one seam — the predicate inside
    `app/output_floor.py` — so every wall built on it goes blind at once, while the walls beside
    it (the gateway, gate 6, the certifiers) keep their own detector."""
    monkeypatch.setattr(output_floor, "contains_hard_identifier", lambda _text: None)


@pytest.mark.parametrize(
    ("text", "identifier_class"),
    [
        (f"call {PHONE}", "phone"),
        (f"PAN {PAN}", "pan"),
        ("Aadhaar 1234 5678 9012", "aadhaar"),
        ("ramesh.k@example.com", "email"),
        ("reg no 20114567", "credential_id"),
        ("PF 12345678901234567", "long_digit_run"),
        ("27ABCDE1234F1Z5", "gstin"),
        # Shapes a model's echo can take that a naive digit regex would miss.
        ("call ९८७६५४३२१०", "phone"),
        ("call 98765​43210", "phone"),
        ("call +91-98765-43210", "phone"),
    ],
)
def test_the_floor_refuses_every_hard_identifier_class(text: str, identifier_class: str) -> None:
    assert contains_hard_identifier(text) == identifier_class, "premise: the class is detected"
    assert carries_hard_identifier(text) is True
    assert floored_scalar(text) is None
    assert floored_items(["welding", text]) == ["welding"]


def test_the_floor_passes_clean_values_untouched() -> None:
    for clean in ["Welder", "CNC Turner, Pune", "3 saal", "Night shift", "", None]:
        assert not carries_hard_identifier(clean), clean
        assert floored_scalar(clean) == clean
    assert floored_items(["welding", PHONE, "grinding", PAN]) == ["welding", "grinding"]
    assert floored_items([]) == []


def test_the_floor_fails_closed_on_a_scanner_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """`contains_hard_identifier` reports its own error as a class, never as None; the floor
    must read that as "carries one" and drop the value."""
    monkeypatch.setattr(output_floor, "contains_hard_identifier", lambda _text: "scanner_error")
    assert output_floor.carries_hard_identifier("Welder") is True
    assert output_floor.floored_scalar("Welder") is None
    assert output_floor.floored_items(["Welder"]) == []


def test_the_floor_module_reads_no_setting() -> None:
    """STRUCTURAL, beside `test_exactly_the_listed_modules_read_the_flag`: the floor may not
    even import the settings, so no edit inside it can make it read a flag."""
    tree = ast.parse((APP_ROOT / "output_floor.py").read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
        elif isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
    assert imported <= {"__future__", "pseudonymize"}, imported


# --- gap 1: Phase C's `_certified*` walls ---------------------------------------------------

#: Every model-written string Phase C stores through `_certified*`, each carrying an identifier
#: the gateway MASKS (not blocks) — so blocked-only lets every one of them through — plus one
#: clean value per shape, which must survive.
_PHASE_C_ECHO = {
    "domain_label": f"Metal {PAN}",
    "role_label": f"Welder {PHONE}",
    "skills": ["welding", PHONE, "ramesh.k@example.com"],
    "experiences": [
        {"role_label": "Welder", "duration_text": "3 saal", "work_done": f"call {PHONE}"},
        {"role_label": f"Grinder {PAN}", "duration_text": "1 saal", "work_done": "grinding"},
        {"role_label": "Fitter", "duration_text": "2 saal", "work_done": "pipe fitting"},
    ],
    "shift": f"Night {PHONE}",
    "availability": "Aadhaar 1234 5678 9012",
}


def _phase_c(monkeypatch: pytest.MonkeyPatch) -> tuple[dict[str, Any], RecordingRouter]:
    recorder = _record(monkeypatch, json.dumps(_PHASE_C_ECHO), real_call=True)
    return client.post("/profiling/extract", json=_EXTRACT_BODY).json(), recorder


def _assert_phase_c_floored(out: dict[str, Any]) -> None:
    assert out["is_mock"] is False
    assert out["domain_label"] is None
    assert out["role_label"] is None
    assert out["skills"] == ["welding"]
    # PER FIELD: the echoed work line is blanked and the job kept; only an echoed ROLE drops one.
    assert [(e["role_label"], e["duration_text"], e["work_done"]) for e in out["experiences"]] == [
        ("Welder", "3 saal", ""),
        ("Fitter", "2 saal", "pipe fitting"),
    ]
    assert out["shift"] is None  # the value that reaches the EMPLOYER PDF
    assert out["availability"] is None


def test_gap_on_phase_c_skills_would_store_an_echoed_phone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _arm(monkeypatch)
    reply = json.dumps({**_EXTRACT_REPLY, "skills": ["welding", PHONE]})
    _record(monkeypatch, reply, real_call=True)
    out = client.post("/profiling/extract", json=_EXTRACT_BODY).json()
    assert PHONE not in out["skills"]


def test_on_phase_c_drops_an_echoed_identifier_from_every_certified_field(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _arm(monkeypatch)
    out, recorder = _phase_c(monkeypatch)
    assert PHONE in recorder.prompt, "vacuity: the raw transcript must have reached the model"
    _assert_phase_c_floored(out)


def test_off_phase_c_drops_a_composed_identifier_just_the_same(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out, recorder = _phase_c(monkeypatch)
    assert PHONE not in recorder.prompt, "OFF: the model never saw the number it wrote"
    _assert_phase_c_floored(out)


def test_mutation_twin_the_floor_is_what_dropped_them_in_phase_c(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _arm(monkeypatch)
    _floor_off(monkeypatch)
    out, _recorder = _phase_c(monkeypatch)
    assert out["role_label"] == f"Welder {PHONE}"
    assert PHONE in out["skills"]
    assert len(out["experiences"]) == 3
    assert out["experiences"][0]["work_done"] == f"call {PHONE}"
    assert out["shift"] == f"Night {PHONE}"


#: Honest year ranges the floor's phone class reads as a phone — measured, each is "phone" to
#: `contains_hard_identifier` — and which the extract prompt has the model copy verbatim.
_DASHED_RANGES = ["2018-2021 (3 years)", "2010-2012, 2013-2016", "2015-2020, 5 saal"]


@pytest.mark.parametrize("duration_text", _DASHED_RANGES)
def test_an_honest_dashed_year_range_costs_the_duration_text_not_the_job(
    monkeypatch: pytest.MonkeyPatch, duration_text: str
) -> None:
    """Armed, the model copies "2018-2021 (3 years)" as the worker typed it, and dropping the
    entry for it would erase the job from the résumé. The floor blanks the one field instead;
    the role, the work and `duration_months` stand. Phase C and the classic turn alike."""
    assert contains_hard_identifier(duration_text) == "phone", "premise: a false positive"
    _arm(monkeypatch)
    entry = {
        "role_label": "Fitter",
        "duration_text": duration_text,
        "duration_months": 36,
        "work_done": "pipe fitting",
    }
    kept = {**entry, "duration_text": ""}

    _record(monkeypatch, json.dumps({**_EXTRACT_REPLY, "experiences": [entry]}), real_call=True)
    out = client.post("/profiling/extract", json=_EXTRACT_BODY).json()
    assert out["experiences"] == [kept]

    turn_reply = {**_CLASSIC_TURN_REPLY, "experience_entry": entry}
    assert _turn(monkeypatch, turn_reply, _CLASSIC_TURN_BODY)["experience_entry"] == kept


# --- gap 2: the work-history polish rewrite -------------------------------------------------

_POLISH_ECHO = json.dumps({"work_done": f"Turned shafts. Call {PHONE}."})
_POLISH_ECHO_BODY = {
    "schema_version": "oie.v1",
    "worker_ref": "w1",
    "work_done": f"lathe pe shaft banata tha, call {PHONE}",
}


def _polish(monkeypatch: pytest.MonkeyPatch, reply: str, body: dict[str, Any]) -> dict[str, Any]:
    _record(monkeypatch, reply, real_call=True)
    return client.post("/profiling/work-history/polish", json=body).json()


def test_gap_on_the_polish_rewrite_would_print_an_echoed_phone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _arm(monkeypatch)
    assert _polish(monkeypatch, _POLISH_ECHO, _POLISH_ECHO_BODY)["work_done"] is None


def test_off_the_polish_floor_catches_a_phone_the_worker_split_and_the_model_rejoined(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE OFF CASE IS NOT HYPOTHETICAL. A phone split by a word ("98765 aur 43210") passes the
    gateway untouched (R30), so the masked sentence carries both halves and the digit wall finds
    a rewrite that rejoins them grounded. Before the floor, that rewrite printed a phone."""
    body = {**_POLISH_ECHO_BODY, "work_done": "lathe pe shaft banata tha, number 98765 aur 43210"}
    rejoined = json.dumps({"work_done": "Turned shafts on a lathe, number 98765 43210."})
    assert pseudonymize(body["work_done"]).text == body["work_done"], "premise: R30 is unmasked"
    assert _polish(monkeypatch, rejoined, body)["work_done"] is None
    clean = json.dumps({"work_done": "Turned shafts on a lathe."})
    assert _polish(monkeypatch, clean, body)["work_done"] == "Turned shafts on a lathe."


def test_mutation_twin_the_floor_is_what_refused_the_polish_rewrite(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _arm(monkeypatch)
    _floor_off(monkeypatch)
    out = _polish(monkeypatch, _POLISH_ECHO, _POLISH_ECHO_BODY)
    assert out["work_done"] == f"Turned shafts. Call {PHONE}."


# --- gap 3: the /profiling/turn output ------------------------------------------------------

_CLASSIC_TURN_REPLY = {
    "reply_text": "Achha. Kitne saal?",
    "stage": "role",
    "input_mode": "text",
    "suggested_answers": [],
    "role_label": f"Welder {PHONE}",
    "skills": ["welding", PAN],
    "experience_entry": {"role_label": "Welder", "work_done": f"Tata Motors mein, call {PHONE}"},
    "phase_a_done": False,
}
_CLASSIC_TURN_BODY = {"worker_ref": "w1", "stage": "role", "message_text": PROBE}


def _turn(
    monkeypatch: pytest.MonkeyPatch, reply: dict[str, Any], body: dict[str, Any]
) -> dict[str, Any]:
    _record(monkeypatch, json.dumps(reply), real_call=True)
    return client.post("/profiling/turn", json=body).json()


def test_gap_on_the_classic_turn_would_return_an_echoed_identifier(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _arm(monkeypatch)
    out = _turn(monkeypatch, _CLASSIC_TURN_REPLY, _CLASSIC_TURN_BODY)
    returned = json.dumps([out["role_label"], out["skills"], out["experience_entry"]])
    assert PHONE not in returned and PAN not in returned


@pytest.mark.parametrize("armed", [True, False], ids=["on", "off"])
def test_the_classic_turn_floors_every_string_and_keeps_the_clean_ones(
    monkeypatch: pytest.MonkeyPatch, armed: bool
) -> None:
    """Per value, not per turn: the clean reply is still served, the clean skill kept. OFF the
    model read "[PHONE_1]", so the identifiers here are ones it composed — dropped the same."""
    if armed:
        _arm(monkeypatch)
    reply = {
        **_CLASSIC_TURN_REPLY,
        "domain_label": f"Metal {PAN}",
        "suggested_answers": ["3 saal", f"call {PHONE}"],
        "blocked_reason": f"call {PHONE}",
    }
    out = _turn(monkeypatch, reply, _CLASSIC_TURN_BODY)
    assert out["is_mock"] is False
    assert out["reply_text"] == "Achha. Kitne saal?"
    assert out["role_label"] is None
    assert out["domain_label"] is None
    assert out["skills"] == ["welding"]
    assert out["suggested_answers"] == ["3 saal"]
    # Floored per field, as Phase C's are: the echoed work line goes, the job stays.
    assert out["experience_entry"] == {
        "role_label": "Welder",
        "duration_text": "",
        "duration_months": None,
        "work_done": "",
    }
    assert out["blocked_reason"] is None
    assert PHONE not in json.dumps(out) and PAN not in json.dumps(out)


@pytest.mark.parametrize("mode", ["classic", profiling_router.SKILLS_ONLY_MODE])
@pytest.mark.parametrize("armed", [True, False], ids=["on", "off"])
def test_a_reply_that_carries_an_identifier_serves_the_fallback(
    monkeypatch: pytest.MonkeyPatch, armed: bool, mode: str
) -> None:
    """The reply is served on the worker's screen and kept in the transcript; one with a hole cut
    out of it is not a reply. The API's deterministic question takes the turn instead — the same
    outcome as every other refusal on this route, and on the skills stage the one reply wall
    `_skills_only_output` did not have (it refuses placeholders, not identifiers)."""
    if armed:
        _arm(monkeypatch)
    body = _CLASSIC_TURN_BODY if mode == "classic" else _SKILLS_BODY
    base = _CLASSIC_TURN_REPLY if mode == "classic" else _SKILLS_REPLY
    reply = {**base, "reply_text": f"Achha. {PHONE} pe call karun?"}
    out = _turn(monkeypatch, reply, body)
    assert out["reply_text"] == ""
    assert out["is_mock"] is True


def test_an_echoed_role_drops_the_classic_turn_entry(monkeypatch: pytest.MonkeyPatch) -> None:
    """The one field an entry cannot lose and still be an entry."""
    _arm(monkeypatch)
    entry = {"role_label": f"Welder {PHONE}", "work_done": "welding"}
    reply = {**_CLASSIC_TURN_REPLY, "experience_entry": entry}
    assert _turn(monkeypatch, reply, _CLASSIC_TURN_BODY)["experience_entry"] is None


def test_mutation_twin_the_floor_is_what_refused_the_classic_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _arm(monkeypatch)
    _floor_off(monkeypatch)
    out = _turn(monkeypatch, _CLASSIC_TURN_REPLY, _CLASSIC_TURN_BODY)
    assert out["role_label"] == f"Welder {PHONE}"
    assert PAN in out["skills"]
    assert PHONE in out["experience_entry"]["work_done"]
    echoed = {**_CLASSIC_TURN_REPLY, "reply_text": f"Achha. {PHONE} pe call karun?"}
    assert PHONE in _turn(monkeypatch, echoed, _CLASSIC_TURN_BODY)["reply_text"]


def test_the_skills_stage_floor_holds_with_its_own_certifier_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other half of section 4's skills twin: the floor alone refuses the phone and the PAN."""
    _arm(monkeypatch)
    monkeypatch.setattr(profiling_router, "certified_clean_skill_labels", lambda labels: labels)
    assert _turn(monkeypatch, _SKILLS_REPLY, _SKILLS_BODY)["skills"] == ["Welding"]


# --- gap 4: the /profile/parse `evidence.quote` ---------------------------------------------

_QUOTE_LINE = f"Pune mein rehta hoon, mera number {PHONE} hai"


def _parse_city(
    monkeypatch: pytest.MonkeyPatch, line: str, quote: str
) -> tuple[dict[str, Any], RecordingRouter]:
    reply = {
        "fields": {
            "current_city": {
                "value": "Pune",
                "evidence": {"message_index": 1, "quote": quote},
                "source": "transcript",
                "normalization": "verbatim",
                "confidence": 0.9,
            }
        }
    }
    recorder = _record(monkeypatch, json.dumps(reply), real_call=True)
    body = {
        "worker_ref": "w1",
        "language": "hi-IN",
        "answer_map": [],
        "transcript": [_line(0, "assistant", "Kahan rehte ho?"), _line(1, "worker", line)],
        "target_fields": [{"field_id": "current_city", "type": "string"}],
    }
    return client.post("/profile/parse", json=body).json(), recorder


def test_gap_on_the_profile_parse_quote_would_carry_the_raw_line(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _arm(monkeypatch)
    out, recorder = _parse_city(monkeypatch, _QUOTE_LINE, _QUOTE_LINE)
    assert PHONE in recorder.prompt, "vacuity: the raw line must have reached the model"
    assert PHONE not in json.dumps(out["fields"])
    # Rejected like any gate-6 refusal, so the note and the counters see it.
    assert out["fields"] == {}
    assert out["unparsed_field_ids"] == ["current_city"]
    assert "fields_rejected" in out["notes"]


def test_on_a_clean_span_of_the_same_raw_line_is_still_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The floor refuses the QUOTE, not the field: cite the clean part and the value stands."""
    _arm(monkeypatch)
    out, _recorder = _parse_city(monkeypatch, _QUOTE_LINE, "Pune mein rehta hoon")
    assert out["fields"]["current_city"]["value"] == "Pune"


def test_off_a_masked_quote_passes_and_a_cued_identifier_does_not(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """OFF, a quote is a span of masked text: "[PHONE_1]" is no identifier, and the field stands
    — the near no-op. But the floor still reads no flag, so an identifier the gateway does NOT
    mask (a cued date of birth: no seven-digit run, no phone shape) is refused OFF as well."""
    masked_line = pseudonymize(_QUOTE_LINE).text
    assert "[PHONE_1]" in masked_line, "premise: OFF, the model reads the placeholder"
    out, _recorder = _parse_city(monkeypatch, _QUOTE_LINE, masked_line)
    assert out["fields"]["current_city"]["value"] == "Pune"

    dob_line = "Pune se hoon, DOB 12/05/1988"
    assert pseudonymize(dob_line).text == dob_line, "premise: the gateway leaves it unmasked"
    out, _recorder = _parse_city(monkeypatch, dob_line, dob_line)
    assert out["fields"] == {}


def test_mutation_twin_the_floor_is_what_refused_the_quote(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _arm(monkeypatch)
    _floor_off(monkeypatch)
    out, _recorder = _parse_city(monkeypatch, _QUOTE_LINE, _QUOTE_LINE)
    assert out["fields"]["current_city"]["evidence"]["quote"] == _QUOTE_LINE


# --- three more outputs, found by probing the switched routes armed. /profile/extract's rich draft

_RICH_TEXT_FIELDS = (
    "secondary_roles",
    "machines",
    "controllers",
    "skills",
    "education",
    "inspection_tools",
    "materials_handled",
    "certifications",
)
_RICH_ECHO = {
    "primary_role": f"Welder {PHONE}",
    "education_level": f"ITI {PAN}",
    **{field: ["Welding", f"call {PHONE}"] for field in _RICH_TEXT_FIELDS},
}


def _rich_draft(monkeypatch: pytest.MonkeyPatch) -> tuple[dict[str, Any], RecordingRouter]:
    recorder = _record(monkeypatch, json.dumps(_RICH_ECHO), real_call=True)
    out = client.post("/profile/extract", json={"transcript": PROBE, "worker_ref": "w1"}).json()
    return out, recorder


@pytest.mark.parametrize("armed", [True, False], ids=["on", "off"])
def test_the_stored_rich_draft_drops_an_echoed_identifier(
    monkeypatch: pytest.MonkeyPatch, armed: bool
) -> None:
    """`worker_profile_draft` is stored whole as `rich_profile_draft`, and nothing certified it:
    the probe that found this put a phone into all nine of its free-text fields and got all nine
    back. Floored per value, the clean entry beside each one kept — and an echoed scalar is not
    overlaid, so the heuristic's own reading of the worker's text stands."""
    if armed:
        _arm(monkeypatch)
    heuristic, _legacy = profile_extractor.extract(PROBE)
    assert heuristic.primary_role == "Welder", "premise: the detector read a role of its own"
    out, recorder = _rich_draft(monkeypatch)
    assert (PHONE in recorder.prompt) is armed, "vacuity: ON the model read the phone, OFF not"
    draft = out["worker_profile_draft"]
    assert draft["primary_role"] == heuristic.primary_role
    assert draft["education_level"] == heuristic.education_level
    for field in _RICH_TEXT_FIELDS:
        assert draft[field] == ["Welding"], field
    assert PHONE not in json.dumps(out) and PAN not in json.dumps(out)


def test_an_echo_never_deletes_what_the_heuristic_read(monkeypatch: pytest.MonkeyPatch) -> None:
    """The floor runs INSIDE `merge_model_draft`, before the overlay, and a list it empties is
    malformed like an all-id list: the base stands. Flooring after the merge instead would let
    one echoed phone replace `["VMC"]` and then be dropped, leaving the worker no machine."""
    _arm(monkeypatch)
    text = "VMC machine chalata hoon, 5 saal"
    heuristic, _legacy = profile_extractor.extract(text)
    assert heuristic.machines == ["VMC"], "premise: the detector read the machine"
    reply = {"machines": [f"call {PHONE}"], "primary_role": f"call {PHONE}"}
    _record(monkeypatch, json.dumps(reply), real_call=True)
    out = client.post("/profile/extract", json={"transcript": text, "worker_ref": "w1"}).json()
    draft = out["worker_profile_draft"]
    assert draft["machines"] == ["VMC"]
    assert draft["primary_role"] == heuristic.primary_role


def test_mutation_twin_the_floor_is_what_refused_the_rich_draft(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _arm(monkeypatch)
    _floor_off(monkeypatch)
    # #1788 certifies the stored draft's labels as well, and that certifier withholds a phone on
    # its own; switched off here so this twin still isolates the floor.
    monkeypatch.setattr(profile_extractor, "certify_model_labels", lambda draft: (draft, 0))
    out, _recorder = _rich_draft(monkeypatch)
    draft = out["worker_profile_draft"]
    assert draft["primary_role"] == f"Welder {PHONE}"
    assert f"call {PHONE}" in draft["machines"]


# --- companion v2's edit rows: stored and printed once the worker confirms the card ----------

_EDIT_PARSE_BODY = {
    "text": PROBE,
    "catalogue": [
        {"section": "employment", "field": field, "ops": ["edit"]}
        for field in ("employer_name", "work_done", "role_label")
    ],
    "snapshot": [{"ref": "e1", "section": "employment", "fields": {"employer_name": "Tata"}}],
    "max_rows": 1,
}


def _edit_row(field: str, value: str) -> dict[str, Any]:
    return {"op": "edit", "section": "employment", "ref": "e1", "field": field, "value": value}


#: Two echoes ahead of the clean row, under a cap of ONE: a dropped row must not use up the cap.
_EDIT_PARSE_ECHO = {
    "rows": [
        _edit_row("employer_name", f"Tata Motors, call {PHONE}"),
        _edit_row("work_done", f"PAN {PAN}"),
        _edit_row("role_label", "Welder"),
    ],
    "unsupported": [],
}


def _edit_parse(monkeypatch: pytest.MonkeyPatch) -> tuple[dict[str, Any], RecordingRouter]:
    recorder = _record(monkeypatch, json.dumps(_EDIT_PARSE_ECHO), real_call=True)
    return client.post("/companion/edit-parse", json=_EDIT_PARSE_BODY).json(), recorder


@pytest.mark.parametrize("armed", [True, False], ids=["on", "off"])
def test_an_edit_row_that_carries_an_identifier_is_dropped(
    monkeypatch: pytest.MonkeyPatch, armed: bool
) -> None:
    """A confirmed employer name or `work_done` prints on both résumé PDFs. OFF the model read
    "[PHONE_1]" and the API's placeholder drop (O17) was the catch; armed no placeholder is
    minted, so the floor is — and the API drops the same row again on its side."""
    if armed:
        _arm(monkeypatch)
    out, recorder = _edit_parse(monkeypatch)
    assert (PHONE in recorder.prompt) is armed, "vacuity: ON the model read the phone, OFF not"
    assert [row["field"] for row in out["rows"]] == ["role_label"]
    assert PHONE not in json.dumps(out) and PAN not in json.dumps(out)


def test_mutation_twin_the_floor_is_what_refused_the_edit_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _arm(monkeypatch)
    _floor_off(monkeypatch)
    out, _recorder = _edit_parse(monkeypatch)
    assert [row["value"] for row in out["rows"]] == [f"Tata Motors, call {PHONE}"]


# --- the /resume/generate summary: rendered nowhere yet, floored before anything does ---------

_GENERATE_BODY = {"worker_ref": "w1", "profile": {"canonical_role_id": "role_vmc_operator"}}


def _summary(monkeypatch: pytest.MonkeyPatch, reply: str) -> str | None:
    _record(monkeypatch, reply, real_call=True)
    return client.post("/resume/generate", json=_GENERATE_BODY).json()["summary"]


@pytest.mark.parametrize("armed", [True, False], ids=["on", "off"])
def test_a_summary_that_carries_an_identifier_is_dropped(
    monkeypatch: pytest.MonkeyPatch, armed: bool
) -> None:
    if armed:
        _arm(monkeypatch)
    assert _summary(monkeypatch, f"Experienced VMC operator. Call {PHONE}.") is None
    assert _summary(monkeypatch, "Experienced VMC operator.") == "Experienced VMC operator."


def test_mutation_twin_the_floor_is_what_refused_the_summary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _arm(monkeypatch)
    _floor_off(monkeypatch)
    echoed = f"Experienced VMC operator. Call {PHONE}."
    assert _summary(monkeypatch, echoed) == echoed


# ===========================================================================
# 7. The blast radius
# ===========================================================================


def _python_modules() -> list[tuple[str, ast.Module]]:
    return [
        (path.relative_to(APP_ROOT).as_posix(), ast.parse(path.read_text(encoding="utf-8")))
        for path in sorted(APP_ROOT.rglob("*.py"))
    ]


#: Every module allowed to READ the flag. A new one is a new place masking can be turned off,
#: and must be added here — deliberately, in review — rather than arrive unnoticed.
FLAG_READERS = frozenset(
    {
        "llm_input_policy.py",  # resume_input_raw (D5's flag OR this one) + the boot WARNING
        "routers/profiling.py",
        "routers/profile.py",
        "routers/companion.py",
        "routers/free_chat.py",
        "routers/voice.py",
        "routers/resume.py",
        "ai/langfuse_tracing.py",  # the tracer's constructor picks the SDK hook
        "ai/router.py",  # the ai_call_traces writer
    }
)


def test_exactly_the_listed_modules_read_the_flag() -> None:
    readers = {
        module
        for module, tree in _python_modules()
        if any(
            isinstance(node, ast.Attribute) and node.attr == "ai_raw_pii_enabled"
            for node in ast.walk(tree)
        )
    }
    assert readers == FLAG_READERS


#: Every DIRECT `pseudonymize()` call in the service, classified. None of these builds a prompt:
#: a prompt path goes through `llm_input_policy`, so that the flag reaches it. A new direct call
#: fails this test until someone decides which of these it is.
PSEUDONYMIZE_CALLS = {
    # The two input gates themselves.
    ("llm_input_policy.py", "llm_input_gate", "text"): "input gate",
    ("profiling/parse_masking.py", "default_masker", "text"): "input gate (OFF posture)",
    # Walls on what is stored or printed — model output stays untrusted under both postures.
    ("pseudonymize.py", "is_certified_clean", "label"): "output wall",
    ("pseudonymize.py", "certify_value", "text"): "output wall",
    ("pseudonymize.py", "certified_clean_skill_labels", "label"): "output wall",
    # Phase C: the predicate under `_certified_list` and `_certified_scalar`, and the experience
    # wall, whose floor half runs per field in `_floored_experience` instead.
    ("routers/profiling.py", "_refused", "text"): "output wall",
    ("routers/profiling.py", "_certified", "text"): "output wall",
    ("routers/profiling.py", "work_history_polish", "polished"): "output wall",
    ("extraction.py", "_availability_line", "cleaned"): "output wall (point of print)",
    # Copies kept at rest, masked before they are kept.
    ("routers/job_posting.py", "job_posting_chat_respond", "body.message_text"): (
        "at rest: the payer draft (the route makes no model call)"
    ),
    ("ai/embeddings.py", "embed_text", "text"): "at rest: the embedded text IS unresolved_phrase",
    ("ai/embeddings.py", "embed_texts", "text"): "at rest: the embedded text IS unresolved_phrase",
    ("corpus/deidentify.py", "deidentify_for_corpus", "text"): "at rest: the training corpus",
    ("profiling/miss_attribution.py", "_default_pseudonymize", "text"): "offline eval tooling",
    # The trace sink's OFF hook, and the gateway endpoint apps/api calls.
    ("ai/langfuse_tracing.py", "_mask_value", "value"): "trace sink (OFF posture)",
    ("routers/privacy.py", "pseudonymize_endpoint", "body.text"): "the /pseudonymize endpoint",
}


def _referenced_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    return node.attr if isinstance(node, ast.Attribute) else None


def _text_argument(call: ast.Call) -> str:
    """What is being masked: the first positional argument, else the `text=` keyword."""
    if call.args:
        return ast.unparse(call.args[0])
    text = next((kw.value for kw in call.keywords if kw.arg == "text"), None)
    return ast.unparse(text) if text is not None else "<no text>"


def _direct_pseudonymize_calls() -> set[tuple[str, str, str]]:
    found: set[tuple[str, str, str]] = set()
    for module, tree in _python_modules():
        for scope in ast.walk(tree):
            if not isinstance(scope, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            for node in ast.walk(scope):
                if isinstance(node, ast.Call) and _referenced_name(node.func) == "pseudonymize":
                    found.add((module, scope.name, _text_argument(node)))
    return found


def test_every_direct_pseudonymize_call_is_a_classified_wall_sink_or_copy() -> None:
    assert _direct_pseudonymize_calls() == set(PSEUDONYMIZE_CALLS)


def test_pseudonymize_is_only_ever_called_by_its_own_name() -> None:
    """The inventory above matches the NAME. An import alias, or the function handed around as a
    value, would put a masking call beyond its reach — so neither may exist."""
    offenders: list[str] = []
    for module, tree in _python_modules():
        called = {id(node.func) for node in ast.walk(tree) if isinstance(node, ast.Call)}
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                offenders += [
                    f"{module}: imports pseudonymize as {alias.asname}"
                    for alias in node.names
                    if alias.name == "pseudonymize" and alias.asname not in (None, "pseudonymize")
                ]
            elif _referenced_name(node) == "pseudonymize" and id(node) not in called:
                offenders.append(f"{module}: {ast.unparse(node)} used as a value")
    assert offenders == []


#: The keyword arguments that select an input posture: the gate's and the maskers' `raw`, D5's
#: `raw_text_enabled`. Outside the policy module each must be a value the caller READ — a literal
#: is a posture the flag cannot reach, and a literal True is masking off on every deploy.
POSTURE_KEYWORDS = frozenset({"raw", "raw_text_enabled"})


def test_no_call_hard_codes_an_input_posture() -> None:
    offenders = [
        f"{module}: {ast.unparse(node)}"
        for module, tree in _python_modules()
        if module != "llm_input_policy.py"
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and any(
            kw.arg in POSTURE_KEYWORDS and isinstance(kw.value, ast.Constant)
            for kw in node.keywords
        )
    ]
    assert offenders == []


#: Where each per-line masker may be NAMED. A route that names `default_masker` itself has
#: hard-wired masking the flag cannot reach; one that names `raw_line_masker` has hard-wired the
#: OPPOSITE — raw on every deploy, flag or no flag; one that names `passthrough_masker` has
#: dropped the size cap as well.
MASKER_NAMERS = {
    "default_masker": {
        "profiling/parse_masking.py",
        "llm_input_policy.py",
        "resume_import/parse_policy.py",
    },
    # Referenced, that is: `llm_input_policy.py` DEFINES it and names it only in the switch.
    "raw_line_masker": {"llm_input_policy.py"},
    # Referenced, that is: `parse_masking.py` DEFINES it and never names it again.
    "passthrough_masker": {"resume_import/parse_policy.py", "routers/synthetic.py"},
}


@pytest.mark.parametrize("masker", sorted(MASKER_NAMERS))
def test_the_maskers_are_named_only_where_the_policy_lives(masker: str) -> None:
    namers = {
        module
        for module, tree in _python_modules()
        if any(isinstance(node, ast.Name) and node.id == masker for node in ast.walk(tree))
    }
    assert namers == MASKER_NAMERS[masker]


def test_every_route_passes_its_masker_explicitly() -> None:
    """`mask_transcript_lines` and `mask_parse_input` DEFAULT to `default_masker`, so a route that
    omits the argument would stay masked with the flag on — a silent no-op, not a leak, but a
    prompt the flag was supposed to reach and did not."""
    for module, tree in _python_modules():
        if not module.startswith("routers/"):
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                continue
            if node.func.id in {"mask_transcript_lines", "mask_parse_input"}:
                explicit = len(node.args) >= 2 or any(kw.arg == "mask" for kw in node.keywords)
                assert explicit, f"{module}: {ast.unparse(node)} omits its masker"
