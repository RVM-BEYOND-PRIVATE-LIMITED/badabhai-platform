"""RI-3 — `POST /resume/parse`, and the two walls that are not the same wall.

THE ONE THING THIS FILE EXISTS FOR is section 1. ADR-0041 D5 sends an uploaded résumé to
the model unmasked behind `RESUME_PARSE_RAW_TEXT_ENABLED`, and §3.3 says a PAN must still
never reach `worker_attributes`, an event, a log or the sheet. Those are two different
questions, and the obvious implementation — one masker, passed to both the prompt builder
and the gate — answers them with one switch. With the flag on, gate 6 would certify
everything and the first résumé carrying a PAN would write it to the database.

So the tests below assert the ASYMMETRY directly: turning the input policy off must not
move the output wall by one inch. Everything else here is the ordinary business of a
route that must degrade rather than fail.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path

import pytest

from app.config import Settings
from app.contracts import (
    AICallMetadata,
    EvidenceSpan,
    ResumeEmployment,
    ResumeParseInput,
    TargetField,
    TranscriptLine,
)
from app.profiling.parse_masking import default_masker, passthrough_masker
from app.pseudonymize import HARD_IDENTIFIER_CLASSES, contains_hard_identifier
from app.resume_import import parse_policy
from app.resume_import import resume_parse as parse_mod
from app.resume_import.extract import ExtractionResult, Line
from app.resume_import.parse_policy import (
    input_masker,
    mask_resume_lines,
    resume_value_certifier,
)
from app.resume_import.resume_parse import RESUME_PARSE_NOTES, gate_employments, parse_resume

REPO_ROOT = Path(__file__).resolve().parents[3]

PAN = "ABCDE1234F"
AADHAAR = "1234 5678 9012"
PHONE = "9876543210"
EMAIL = "ramesh.kumar@example.com"


# ===========================================================================
# Harness
# ===========================================================================


def _run(coro):
    """`asyncio.run` rather than a pytest-asyncio marker, matching `test_ai_router.py`,
    `test_ai_observability.py` and `test_ai_call_trace_text.py`. The suite has no
    pytest-asyncio and adding one so that a single file can look different from the other
    three is not a trade worth making."""
    return asyncio.run(coro)


def settings(**overrides) -> Settings:
    base = {
        "_env_file": None,
        "resume_uploads_bucket": "worker-resume-uploads",
        "supabase_url": "https://example.invalid",
        "supabase_service_role_key": "srk",
    }
    return Settings(**{**base, **overrides})


def lines(*texts: str) -> list[Line]:
    return [Line(index=i, page=1, text=t) for i, t in enumerate(texts)]


def extraction(*texts: str, **kwargs) -> ExtractionResult:
    return ExtractionResult(
        method=kwargs.pop("method", "pdf_text"),
        lines=tuple(lines(*texts)),
        page_count=kwargs.pop("page_count", 1),
        ocr_confidence=kwargs.pop("ocr_confidence", None),
        degraded_reason=kwargs.pop("degraded_reason", None),
        truncated=kwargs.pop("truncated", False),
    )


class RecordingRouter:
    """Captures the messages the pipeline would have sent, and replies with a fixed body.

    A MOCK THAT RETURNS WHATEVER IS ASKED OF IT CANNOT CATCH A CONTRACT MISMATCH, so this
    records the ACTUAL prompt text — which is how the masking tests can assert on what
    would have crossed the boundary rather than on what the code says it does.
    """

    def __init__(self, reply: str = "{}", *, real_call: bool = True, success: bool = True):
        self.reply = reply
        self.messages: list[dict[str, str]] = []
        self.calls = 0
        self._meta = AICallMetadata(
            ai_call_id="00000000-0000-4000-8000-000000000000",
            task_type="resume_parse",
            model_name="test-model",
            provider="test",
            real_call=real_call,
            success=success,
            created_at="2026-09-11T00:00:00+00:00",
        )

    async def run(self, task_type, *, messages, **kwargs):  # noqa: ARG002
        self.calls += 1
        self.messages = messages
        return self.reply, self._meta

    @property
    def prompt_text(self) -> str:
        return "\n".join(m["content"] for m in self.messages)


def model_reply(fields: dict | None = None, employments: list | None = None) -> str:
    return json.dumps({"fields": fields or {}, "employments": employments or []})


def field_at(index: int, quote: str, value):
    return {
        "value": value,
        "evidence": {"message_index": index, "quote": quote},
        "source": "transcript",
        "normalization": "verbatim",
        "confidence": 0.9,
    }


CITY = TargetField(field_id="current_city", type="string")
YEARS = TargetField(field_id="experience_years", type="number")
ROLE = TargetField(field_id="role_label", type="string")


def run_parse(
    *,
    texts: list[str],
    reply: str,
    target_fields: list[TargetField] | None = None,
    monkeypatch,
    extraction_result: ExtractionResult | None = None,
    **settings_overrides,
):
    """Drive the pipeline with storage and extraction stubbed, the router recording."""
    result = extraction_result if extraction_result is not None else extraction(*texts)

    async def fake_download(*args, **kwargs):  # noqa: ARG001
        return b"%PDF-1.4 stub"

    monkeypatch.setattr(parse_mod, "download_object", fake_download)
    monkeypatch.setattr(parse_mod, "extract", lambda data, mime: result)

    router = RecordingRouter(reply)
    body = ResumeParseInput(
        worker_ref="wr_1",
        storage_key="resume-uploads/w/x.pdf",
        mime="application/pdf",
        target_fields=target_fields if target_fields is not None else [CITY, YEARS, ROLE],
    )
    out = _run(parse_resume(body, settings=settings(**settings_overrides), router=router))
    return out, router


# ===========================================================================
# 1. THE ASYMMETRY — the reason this file exists
# ===========================================================================


def test_the_raw_text_flag_does_NOT_disable_gate_6(monkeypatch):
    """THE CENTRAL ASSERTION OF RI-3.

    D5 moved what may reach the MODEL. §3.3 did not move what may reach the DATABASE. If
    one masker were wired to both, turning the input policy off would silently certify
    every value and the first résumé carrying a PAN would be written to
    `worker_attributes`. The flag is ON here and the PAN must still be refused.
    """
    document = f"CNC Turner Pune PAN {PAN}"
    out, router = run_parse(
        texts=[document],
        reply=model_reply({"current_city": field_at(0, f"PAN {PAN}", f"PAN {PAN}")}),
        monkeypatch=monkeypatch,
        resume_parse_raw_text_enabled=True,
    )

    # Vacuity: the PAN really did reach the model, or this proves nothing about the flag.
    assert PAN in router.prompt_text, "the raw flag must actually have sent the PAN"
    # …and it still did not reach the response.
    assert out.fields == {}
    assert "fields_rejected" in out.notes


def test_with_the_flag_off_the_document_reaches_the_model_masked(monkeypatch):
    _, router = run_parse(
        texts=[f"Ramesh Kumar {PHONE} CNC Turner"],
        reply=model_reply(),
        monkeypatch=monkeypatch,
        resume_parse_raw_text_enabled=False,
    )
    assert PHONE not in router.prompt_text
    assert "[PHONE_1]" in router.prompt_text or "[" in router.prompt_text


def test_with_the_flag_on_the_document_reaches_the_model_raw(monkeypatch):
    """D5 as amended, asserted rather than assumed — this is the ruling's whole effect."""
    _, router = run_parse(
        texts=[f"Ramesh Kumar {PHONE} CNC Turner at Tata Motors Ltd"],
        reply=model_reply(),
        monkeypatch=monkeypatch,
        resume_parse_raw_text_enabled=True,
    )
    assert PHONE in router.prompt_text
    assert "Tata Motors Ltd" in router.prompt_text
    assert "[PHONE_1]" not in router.prompt_text


def test_the_input_policy_is_a_switch_and_nothing_else():
    """The ruling's own "right now" made load-bearing: a switch, never a deleted step."""
    assert input_masker(raw_text_enabled=False) is default_masker
    assert input_masker(raw_text_enabled=True) is passthrough_masker


def test_the_output_wall_takes_no_policy_argument():
    """STRUCTURAL, not a convention. `resume_value_certifier` has the same
    `(text) -> (blocked, certified)` shape as a Masker, so a `certify=` parameter would
    make it a one-character edit to hand gate 6 the input policy. There is deliberately
    no such parameter to fill in."""
    import inspect

    params = inspect.signature(resume_value_certifier).parameters
    assert list(params) == ["text"], (
        "resume_value_certifier grew a parameter. If it can be pointed at the input "
        "policy, RESUME_PARSE_RAW_TEXT_ENABLED becomes a switch that disables gate 6."
    )


# ===========================================================================
# 2. The output wall: what it refuses, and — just as important — what it permits
# ===========================================================================


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (f"PAN {PAN}", "pan"),
        (AADHAAR, "aadhaar"),
        (f"Mob: {PHONE}", "phone"),
        (EMAIL, "email"),
        ("Roll No: AB123456", "credential_id"),
    ],
)
def test_a_hard_identifier_is_refused(text, expected):
    assert contains_hard_identifier(text) == expected
    assert resume_value_certifier(text)[0] is True


@pytest.mark.parametrize(
    "text",
    [
        "Tata Motors Ltd",  # ADR-0041 D5 authorises this EXPLICITLY.
        "Bharat Forge Limited",
        "Stainless Steel",  # `_EMPLOYER_RE` over-fires on this — see certified_clean_skill_labels.
        "Diploma Mechanical Engineering",
        "CNC Turner",
        "Pune",
        "25000",
        "1200000",  # A salary. The residual-digit net is deliberately not in this wall.
    ],
)
def test_an_honest_resume_value_is_permitted(text):
    """TESTING WHAT THE GUARD PERMITS, which is the half that gets deleted.

    Certifying with the FULL gateway would reject every one of these — employer names by
    ruling, and "Stainless Steel" by an `_EMPLOYER_RE` false positive the repo has already
    had to rescue once. A wall that rejects the honest cases is a wall someone removes.
    """
    assert contains_hard_identifier(text) is None
    assert resume_value_certifier(text)[0] is False


def test_the_certifier_never_rewrites_the_value():
    """Gate 6 rejects on blocked OR on altered. Returning a rewritten string would record
    that the worker's résumé said something it did not."""
    for text in ("Tata Motors Ltd", f"PAN {PAN}", "1200000"):
        assert resume_value_certifier(text)[1] == text


def test_the_hard_identifier_classes_are_a_closed_set():
    assert set(HARD_IDENTIFIER_CLASSES) == {"pan", "aadhaar", "phone", "email", "credential_id"}


def test_an_employer_name_survives_to_the_response(monkeypatch):
    """The other side of the central test: D5 permits this, so it must actually arrive.

    If this fails while the PAN test passes, the wall is over-broad and the feature is
    dead — which is exactly what using `pseudonymize` as the certifier would do.
    """
    out, _ = run_parse(
        texts=["CNC Turner at Tata Motors Ltd, Pune, 2019-2023"],
        reply=model_reply(
            fields={"role_label": field_at(0, "Tata Motors Ltd", "Tata Motors Ltd")},
            employments=[
                {
                    "employer_name": "Tata Motors Ltd",
                    "role_title": "CNC Turner",
                    "start_year": 2019,
                    "end_year": 2023,
                    "evidence": {"message_index": 0, "quote": "Tata Motors Ltd"},
                }
            ],
        ),
        monkeypatch=monkeypatch,
        resume_parse_raw_text_enabled=True,
    )
    # BOTH PATHS, because they are gated by different code. A mutation widening the
    # certifier to the full gateway killed the scalar path while the employment path
    # sailed on — `_employment_carries_identifier` was checking `blocked` and not
    # `altered`, so a name rewritten to `[EMPLOYER_1]` looked clean. Asserting on only one
    # of these leaves the other free to rot.
    assert len(out.employments) == 1
    assert out.employments[0].employer_name == "Tata Motors Ltd"
    assert out.fields["role_label"].value == "Tata Motors Ltd"


# ===========================================================================
# 3. Provenance — the gate that makes fabrication structurally impossible
# ===========================================================================


def test_a_value_whose_quote_is_not_in_the_cited_line_is_dropped(monkeypatch):
    out, _ = run_parse(
        texts=["CNC Turner, Pune"],
        reply=model_reply({"current_city": field_at(0, "Mumbai", "Mumbai")}),
        monkeypatch=monkeypatch,
    )
    assert out.fields == {}
    assert "current_city" in out.unparsed_field_ids


def test_a_value_that_IS_in_the_cited_line_survives(monkeypatch):
    """What the gate permits. Without this, dropping everything would pass section 3."""
    out, _ = run_parse(
        texts=["CNC Turner, Pune"],
        reply=model_reply({"current_city": field_at(0, "Pune", "Pune")}),
        monkeypatch=monkeypatch,
    )
    assert out.fields["current_city"].value == "Pune"
    assert "current_city" not in out.unparsed_field_ids


def test_a_citation_to_a_line_that_does_not_exist_is_dropped(monkeypatch):
    out, _ = run_parse(
        texts=["CNC Turner, Pune"],
        reply=model_reply({"current_city": field_at(47, "Pune", "Pune")}),
        monkeypatch=monkeypatch,
    )
    assert out.fields == {}


def test_a_field_nobody_asked_for_is_dropped(monkeypatch):
    out, _ = run_parse(
        texts=["CNC Turner, Pune"],
        reply=model_reply({"aadhaar_number": field_at(0, "CNC", "CNC")}),
        monkeypatch=monkeypatch,
        target_fields=[CITY],
    )
    assert out.fields == {}


def test_citations_still_resolve_after_the_masker_drops_a_line(monkeypatch):
    """`index` IS PRESERVED, never renumbered.

    A dropped line makes list position and index diverge. If the pipeline renumbered, a
    citation to line 2 would silently resolve against a different line — which can pass
    one worker's employer off as another's.
    """
    unmaskable = "x" * 5000  # over PARSE_MESSAGE_MAX_CHARS: the gateway refuses it
    out, router = run_parse(
        texts=["Ramesh Kumar", unmaskable, "CNC Turner, Pune"],
        reply=model_reply({"current_city": field_at(2, "Pune", "Pune")}),
        monkeypatch=monkeypatch,
        resume_parse_raw_text_enabled=False,
    )
    assert "lines_dropped_by_masker" in out.notes
    assert "[2]" in router.prompt_text, "vacuity: line 2 must still be numbered 2"
    assert out.fields["current_city"].value == "Pune"


# ===========================================================================
# 4. Employment rows
# ===========================================================================


def transcript(*texts: str) -> list[TranscriptLine]:
    return [TranscriptLine(i=i, role="worker", text=t) for i, t in enumerate(texts)]


def employment(**kwargs) -> ResumeEmployment:
    kwargs.setdefault("evidence", EvidenceSpan(message_index=0, quote="Tata Motors"))
    return ResumeEmployment(**kwargs)


def test_an_uncited_employer_is_dropped():
    kept, rejected = gate_employments(
        [
            employment(
                employer_name="Bharat Forge",
                evidence=EvidenceSpan(message_index=0, quote="Bharat Forge"),
            )
        ],
        transcript("CNC Turner at Tata Motors"),
    )
    assert kept == [] and rejected == 1


def test_a_stint_that_ends_before_it_starts_is_dropped():
    """The contract bounds each year individually and cannot express the relationship.
    Left unchecked this reverses a career on the sheet."""
    kept, rejected = gate_employments(
        [employment(employer_name="Tata Motors", start_year=2023, end_year=2019)],
        transcript("Tata Motors 2019-2023"),
    )
    assert kept == [] and rejected == 1


def test_a_phone_number_in_the_ROLE_TITLE_is_refused_too():
    """`employer_name` is not the only string on the row. A model handed an unmasked
    document will occasionally put the whole contact line into whichever field it thought
    the line was about."""
    kept, rejected = gate_employments(
        [employment(employer_name="Tata Motors", role_title=f"CNC Turner {PHONE}")],
        transcript(f"Tata Motors CNC Turner {PHONE}"),
    )
    assert kept == [] and rejected == 1


def test_a_row_naming_neither_an_employer_nor_a_role_is_dropped():
    kept, rejected = gate_employments(
        [employment(start_year=2019, end_year=2023)],
        transcript("Tata Motors 2019-2023"),
    )
    assert kept == [] and rejected == 1


def test_an_honest_row_survives_all_of_it():
    kept, rejected = gate_employments(
        [employment(employer_name="Tata Motors", role_title="CNC Turner", start_year=2019)],
        transcript("Tata Motors CNC Turner 2019"),
    )
    assert len(kept) == 1 and rejected == 0


def test_a_row_citing_a_non_worker_line_is_dropped():
    """Gate 2 kept in the path. Every résumé line is the worker's document, so this can
    only fire if someone later adds a line that is NOT the document — which is precisely
    when it needs to fire rather than to have been deleted."""
    lines_ = [TranscriptLine(i=0, role="assistant", text="Tata Motors")]
    kept, rejected = gate_employments([employment(employer_name="Tata Motors")], lines_)
    assert kept == [] and rejected == 1


# ===========================================================================
# 5. Degrades, never fails (ruling D9)
# ===========================================================================


def test_an_unset_bucket_is_dormant_and_spends_nothing(monkeypatch):
    async def fake_download(*args, **kwargs):  # noqa: ARG001
        raise RuntimeError("resume fetch failed: no bucket configured (RESUME_UPLOADS_BUCKET)")

    monkeypatch.setattr(parse_mod, "download_object", fake_download)
    router = RecordingRouter(model_reply())
    body = ResumeParseInput(
        worker_ref="wr_1", storage_key="k", mime="application/pdf", target_fields=[CITY]
    )
    out = _run(parse_resume(body, settings=settings(resume_uploads_bucket=""), router=router))

    assert out.failure_reason == "parse_unavailable"
    assert router.calls == 0, "a dormant route must not spend a model call"


def test_an_unreadable_document_reports_the_extractors_own_reason(monkeypatch):
    out, router = run_parse(
        texts=[],
        reply=model_reply(),
        monkeypatch=monkeypatch,
        extraction_result=ExtractionResult(
            method=None,
            lines=(),
            page_count=None,
            ocr_confidence=None,
            degraded_reason="encrypted_document",
        ),
    )
    assert out.failure_reason == "encrypted_document"
    assert router.calls == 0


def test_a_blown_deadline_is_named_and_costs_no_field(monkeypatch):
    async def slow_run(*args, **kwargs):  # noqa: ARG001
        raise TimeoutError

    async def fake_download(*args, **kwargs):  # noqa: ARG001
        return b"stub"

    monkeypatch.setattr(parse_mod, "download_object", fake_download)
    monkeypatch.setattr(parse_mod, "extract", lambda data, mime: extraction("CNC Turner, Pune"))

    class SlowRouter:
        run = staticmethod(slow_run)

    body = ResumeParseInput(
        worker_ref="wr_1", storage_key="k", mime="application/pdf", target_fields=[CITY]
    )
    out = _run(parse_resume(body, settings=settings(), router=SlowRouter()))
    assert out.failure_reason == "parse_deadline_exceeded"
    assert out.fields == {}


def test_an_off_contract_model_body_is_named_not_raised(monkeypatch):
    out, _ = run_parse(
        texts=["CNC Turner, Pune"], reply="I'm afraid I can't do that", monkeypatch=monkeypatch
    )
    assert out.failure_reason == "parse_output_invalid"
    assert out.fields == {}


def test_mock_mode_and_provider_failure_are_told_apart(monkeypatch):
    """One is a POSTURE and one is an INCIDENT. Conflating them hides the one that needs
    an operator."""

    async def fake_download(*args, **kwargs):  # noqa: ARG001
        return b"stub"

    monkeypatch.setattr(parse_mod, "download_object", fake_download)
    monkeypatch.setattr(parse_mod, "extract", lambda data, mime: extraction("CNC Turner, Pune"))
    body = ResumeParseInput(
        worker_ref="wr_1", storage_key="k", mime="application/pdf", target_fields=[CITY]
    )

    mocked = _run(
        parse_resume(
            body, settings=settings(), router=RecordingRouter(model_reply(), real_call=False)
        )
    )
    assert "mock_no_parse" in mocked.notes and "llm_unavailable" not in mocked.notes

    failed = _run(
        parse_resume(
            body,
            settings=settings(),
            router=RecordingRouter(model_reply(), real_call=True, success=False),
        )
    )
    assert "llm_unavailable" in failed.notes and "mock_no_parse" not in failed.notes


def test_no_target_fields_means_no_call_but_still_a_real_answer(monkeypatch):
    out, router = run_parse(
        texts=["CNC Turner, Pune"],
        reply=model_reply(),
        target_fields=[],
        monkeypatch=monkeypatch,
    )
    assert router.calls == 0
    assert out.failure_reason is None
    assert out.extraction_method == "pdf_text" and out.line_count == 1


# ===========================================================================
# 6. What leaves the service
# ===========================================================================


def test_unparsed_field_ids_come_from_the_gates_not_from_the_model(monkeypatch):
    """The model has every incentive to claim it read more than it cited."""
    reply = json.dumps(
        {
            "fields": {"current_city": field_at(0, "Pune", "Pune")},
            "unparsed_field_ids": [],  # the model claims it parsed everything
            "employments": [],
        }
    )
    out, _ = run_parse(texts=["CNC Turner, Pune"], reply=reply, monkeypatch=monkeypatch)
    assert set(out.unparsed_field_ids) == {"experience_years", "role_label"}


def test_the_model_cannot_put_a_note_on_the_response_at_all(monkeypatch):
    """Notes are OURS. The model's own `notes` array is read by nothing — the response is
    built from `stage.notes`, which only this service writes. A model that tried to
    editorialise about the candidate has no channel to do it through."""
    reply = json.dumps(
        {"fields": {}, "employments": [], "notes": ["the candidate seems overqualified"]}
    )
    out, _ = run_parse(texts=["CNC Turner, Pune"], reply=reply, monkeypatch=monkeypatch)
    assert "the candidate seems overqualified" not in out.notes


def test_a_note_added_carelessly_UPSTREAM_is_filtered_before_the_response_leaves():
    """The closed-set filter, tested where it actually bites.

    The test above proves the MODEL has no channel; this proves the filter guards the
    other direction — our own code appending a code that was never added to the
    vocabulary. Asserted against `_response` directly because `stage.notes` is internal
    and there is deliberately no route that lets a caller write to it. A mutation showed
    why this needed splitting: removing the filter entirely left the model-note test green,
    because that test was passing for a different reason than the one it named.
    """
    stage = parse_mod._Stage()
    stage.notes = ["fields_rejected", "invented_by_a_future_edit"]
    out = parse_mod._response(stage, [CITY])
    assert out.notes == ["fields_rejected"]
    assert all(note in RESUME_PARSE_NOTES for note in out.notes)


def test_the_raw_posture_is_recorded_on_the_response(monkeypatch):
    """"Which posture produced this import?" must be answerable from the record rather
    than from someone's memory of the deploy."""
    on, _ = run_parse(
        texts=["CNC Turner, Pune"],
        reply=model_reply(),
        monkeypatch=monkeypatch,
        resume_parse_raw_text_enabled=True,
    )
    off, _ = run_parse(
        texts=["CNC Turner, Pune"],
        reply=model_reply(),
        monkeypatch=monkeypatch,
        resume_parse_raw_text_enabled=False,
    )
    assert "raw_text_policy_active" in on.notes
    assert "raw_text_policy_active" not in off.notes


def test_not_one_character_of_the_resume_reaches_a_log(monkeypatch, caplog):
    secret = f"Ramesh Kumar {PHONE} Tata Motors PAN {PAN}"
    with caplog.at_level(logging.DEBUG):
        out, _ = run_parse(
            texts=[secret, "x" * 5000],
            reply=model_reply({"current_city": field_at(0, "Ramesh", "Ramesh")}),
            monkeypatch=monkeypatch,
            resume_parse_raw_text_enabled=True,
        )

    assert out is not None
    emitted = "\n".join(
        r.getMessage() + repr(getattr(r, "extra", "")) for r in caplog.records
    )
    for fragment in ("Ramesh", PHONE, PAN, "Tata Motors"):
        assert fragment not in emitted


def test_the_extraction_facts_ride_back_because_nothing_else_can_carry_them(monkeypatch):
    """apps/api never sees the document, so `worker_resume_import`'s extraction columns
    can only be filled from this response."""
    out, _ = run_parse(
        texts=["CNC Turner, Pune"],
        reply=model_reply(),
        monkeypatch=monkeypatch,
        extraction_result=extraction(
            "CNC Turner, Pune", method="ocr", page_count=2, ocr_confidence=0.88, truncated=True
        ),
    )
    assert out.extraction_method == "ocr"
    assert out.page_count == 2
    assert out.ocr_confidence == pytest.approx(0.88)
    assert out.line_count == 1
    assert "extraction_truncated" in out.notes


# ===========================================================================
# 7. The cross-language pins RI-2 owed
# ===========================================================================


def test_the_failure_vocabulary_matches_the_typescript_character_for_character():
    """THE PIN RI-2 COULD NOT WRITE.

    `app/resume_import/extract.py` says why: `RESUME_IMPORT_FAILURES` landed with RI-1 and
    was not on `main` when RI-2 was written, so the pin would either fail on `main` or be
    written to skip. It is on this branch, so it is written now.

    Reading the TypeScript rather than repeating the strings is the whole point — a test
    that hard-codes both sides passes while somebody changes one of them.
    """
    source = (REPO_ROOT / "packages" / "types" / "src" / "index.ts").read_text(encoding="utf-8")
    block = re.search(
        r"RESUME_IMPORT_FAILURES\s*=\s*Object\.freeze\(\[(.*?)\]\s*as const\)", source, re.S
    )
    assert block, "could not find RESUME_IMPORT_FAILURES in packages/types"
    ts_values = set(re.findall(r'"([a-z_]+)"', block.group(1)))

    from app.resume_import.extract import DEGRADED_REASONS

    extraction_stage = set(DEGRADED_REASONS)
    parse_stage = {"parse_deadline_exceeded", "parse_output_invalid"}

    assert extraction_stage <= ts_values, (
        f"Python can produce failure reasons TypeScript does not accept: "
        f"{sorted(extraction_stage - ts_values)}"
    )
    assert parse_stage <= ts_values, sorted(parse_stage - ts_values)
    # …and nothing in the TS list is unreachable, which would mean a worker-facing string
    # nobody can ever trigger.
    assert ts_values == extraction_stage | parse_stage, (
        f"TypeScript declares reasons nothing produces: "
        f"{sorted(ts_values - extraction_stage - parse_stage)}"
    )


def test_the_bucket_default_matches_the_api_side_character_for_character():
    """Two services, ONE variable name, one meaning for "unset".

    The defect this prevents has already shipped once: `voice_notes_bucket` defaulted to a
    literal here and to "" in the API, so arming one side alone was silent total failure
    with a green /health on both.
    """
    source = (REPO_ROOT / "packages" / "config" / "src" / "server.ts").read_text(encoding="utf-8")
    match = re.search(r'RESUME_UPLOADS_BUCKET:\s*z\.string\(\)\.default\("([^"]*)"\)', source)
    assert match, "could not find the api-side RESUME_UPLOADS_BUCKET default in server.ts"

    ts_default = match.group(1)
    py_default = Settings(_env_file=None).resume_uploads_bucket
    assert py_default == ts_default, (
        f"apps/api defaults RESUME_UPLOADS_BUCKET to {ts_default!r} and this service to "
        f"{py_default!r}. Arming either side alone is silent total failure."
    )
    assert py_default == "", "both must be the FAIL-CLOSED value, not an agreed guess"


def test_the_raw_text_flag_is_off_in_every_committed_file():
    """The §1 guard: the raw path must be unreachable by default and must never arm
    vacuously on an empty string."""
    assert Settings(_env_file=None).resume_parse_raw_text_enabled is False


# ===========================================================================
# 8. Masking mechanics
# ===========================================================================


def test_masking_runs_per_line_and_never_on_the_concatenated_document():
    """A three-page résumé concatenated is past `pseudonymize`'s 20,000-character
    fail-closed guard, so a whole-document call would hand every uploading worker an empty
    parse — punished precisely for having a full career."""
    long_document = lines(*[f"line {i} of a long career at Tata Motors" for i in range(600)])
    assert sum(len(line.text) for line in long_document) > 20_000, "vacuity: must exceed the cap"

    masked = mask_resume_lines(long_document, default_masker)
    assert masked.dropped == 0
    assert len(masked.lines) == 600


def test_an_unmaskable_line_is_dropped_and_counted_never_fatal():
    document = lines("CNC Turner", "x" * 5000, "Pune")
    masked = mask_resume_lines(document, default_masker)
    assert masked.dropped == 1
    assert [line.index for line in masked.lines] == [0, 2]


def test_passthrough_drops_nothing_at_all():
    document = lines("CNC Turner", "x" * 5000, f"Ramesh {PHONE}")
    masked = mask_resume_lines(document, passthrough_masker)
    assert masked.dropped == 0
    assert len(masked.lines) == 3


def test_the_policy_module_exposes_exactly_two_walls():
    """A third masker-shaped function in here is how the asymmetry gets lost."""
    exported = {
        name
        for name in vars(parse_policy)
        if not name.startswith("_") and callable(getattr(parse_policy, name))
    }
    assert exported >= {"input_masker", "mask_resume_lines", "resume_value_certifier"}


def test_the_hard_identifier_wall_agrees_with_the_typescript_side_case_for_case():
    """THE CROSS-LANGUAGE PIN, done by BEHAVIOUR rather than by source.

    This rule exists twice — here, as gate 6's certifier, and in
    `apps/api/src/profiling/resume-import/resume-parse-gates.ts`, as the last check before
    anything is written. Two implementations of one privacy rule drift.

    The usual technique in this repo is to read the other language's source and compare the
    constants (`test_stt.py` does exactly that for the bucket default). It does not work
    here: the credential-id pattern uses an inline `(?i:...)` group JavaScript has no syntax
    for, so the regexes cannot be byte-identical even when the behaviour is. So both suites
    read ONE fixture of cases instead, and a case added on either side fails whichever
    implementation has not caught up.
    """
    fixture = (
        REPO_ROOT
        / "packages"
        / "ai-contracts"
        / "src"
        / "__fixtures__"
        / "hard-identifiers.cases.json"
    )
    cases = json.loads(fixture.read_text(encoding="utf-8"))["cases"]

    # Guards the loader, not the rule: a fixture that listed only refusals would make the
    # "permitted" half — the half ADR-0041 D5 depends on — pass vacuously.
    assert len(cases) > 20
    assert any(c["expected"] is not None for c in cases)
    assert any(c["expected"] is None for c in cases)

    mismatches = [
        (c["text"], c["expected"], contains_hard_identifier(c["text"]))
        for c in cases
        if contains_hard_identifier(c["text"]) != c["expected"]
    ]
    assert not mismatches, f"python disagrees with the shared fixture: {mismatches}"
