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
import io
import json
import logging
import os
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
from app.resume_import.extract import ExtractionResult, Line, extract
from app.resume_import.parse_policy import (
    input_masker,
    mask_resume_lines,
    resume_value_certifier,
)
from app.resume_import.resume_parse import RESUME_PARSE_NOTES, gate_employments, parse_resume

REPO_ROOT = Path(__file__).resolve().parents[3]

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

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
    trade_kinds: list[str] | None = None,
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
        trade_kinds=trade_kinds or [],
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


def test_gate_6_ITSELF_still_refuses_a_PAN_when_the_span_is_clean(monkeypatch):
    """THE ISOLATING VERSION, and it exists because the test above stopped isolating.

    Fixing H1 added a span check that runs AFTER the gates. In the test above the quote also
    carries the PAN, so that check catches it — which means the test kept passing even with
    gate 6 pointed at the input policy. Measured by mutation, not guessed: a test that passes
    for a second reason is a test that has stopped guarding the first one.

    Here the QUOTE is clean and only the VALUE carries the PAN, so nothing but gate 6 can
    refuse it. If someone wires `certify=` to the raw-text policy, this goes red.
    """
    out, router = run_parse(
        texts=[f"CNC Turner Pune PAN {PAN}"],
        reply=model_reply({"current_city": field_at(0, "CNC Turner", f"PAN {PAN}")}),
        monkeypatch=monkeypatch,
        resume_parse_raw_text_enabled=True,
    )

    assert PAN in router.prompt_text, "vacuity: the raw flag must have sent the PAN"
    assert out.fields == {}, "gate 6 must refuse a PAN in the VALUE, span or no span"


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
    """Widening this set is a privacy decision, so it should require touching a test that
    says so. `long_digit_run` and `gstin` were added after the RI-3 security review measured
    the 14+ digit band uncovered — a bank account and an ESIC number had nothing looking at
    them, while the docstring said "no identifier escapes"."""
    assert set(HARD_IDENTIFIER_CLASSES) == {
        "pan",
        "aadhaar",
        "phone",
        "email",
        "credential_id",
        "long_digit_run",
        "gstin",
    }


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


EN_DASH = chr(0x2013)


def docx_bytes(paragraphs: list[str]) -> bytes:
    """A real .docx, built here rather than imported from `test_resume_extract`.

    Deliberately local: two test modules importing each other is a coupling that outlives
    whatever it saved. It is a .docx and not a PDF because `build_pdf` over there encodes
    latin-1, which cannot carry an en dash at all — itself a reminder that this whole
    class of character only ever arrives from a real authoring tool.
    """
    from docx import Document

    document = Document()
    for text in paragraphs:
        document.add_paragraph(text)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def test_an_ascii_hyphen_quote_matches_a_line_the_document_wrote_with_an_en_dash(monkeypatch):
    """THE END OF THE CHAIN (#1657), asserted AT THE GATE and not at the normalizer.

    A test that the fold happened is a test about the middle. This one runs the real
    extractor over a real document and then asks the question that actually cost us
    fields: does gate 1 accept the quote a model really returns?

    `_quote_appears_in` is untouched and still character-literal apart from whitespace.
    What changed is the corpus: before #1657 this line reached the model carrying U+2013,
    the model quoted it with an ASCII hyphen — an HONEST citation of a real line — and
    provenance dropped it. Every employment header and every education row on a
    Word-authored CV died that way, one field at a time.
    """
    document_line = f"CNC Turner / CNC Setter | 2017 {EN_DASH} 2021"
    extracted = extract(docx_bytes([document_line]), mime=DOCX_MIME)
    assert extracted.degraded_reason is None, extracted.degraded_reason
    assert EN_DASH in document_line, "vacuity: the fixture must actually hold an en dash"

    # What a model returns when asked to quote that line "character for character".
    quote = "CNC Turner / CNC Setter | 2017 - 2021"
    out, _ = run_parse(
        texts=[],
        extraction_result=extracted,
        reply=model_reply({"role_label": field_at(0, quote, "CNC Turner")}),
        monkeypatch=monkeypatch,
    )
    assert out.fields["role_label"].value == "CNC Turner"
    assert "role_label" not in out.unparsed_field_ids


def test_that_same_quote_is_still_refused_when_the_line_never_said_it(monkeypatch):
    """The vacuity guard for the test above, and the thing a fold could have broken.

    The fix widened the CORPUS, not the COMPARISON. A quote that no line contains must
    still fail provenance — otherwise #1657 would have bought back a few year ranges at
    the price of the gate.
    """
    extracted = extract(
        docx_bytes([f"CNC Turner / CNC Setter | 2017 {EN_DASH} 2021"]), mime=DOCX_MIME
    )
    out, _ = run_parse(
        texts=[],
        extraction_result=extracted,
        reply=model_reply({"role_label": field_at(0, "Shift Supervisor | 2017 - 2021", "CNC")}),
        monkeypatch=monkeypatch,
    )
    assert out.fields == {}
    assert "role_label" in out.unparsed_field_ids


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


def test_the_raw_text_flag_defaults_to_off():
    """Renamed, because the first version of this test was called
    `test_the_raw_text_flag_is_off_in_every_committed_file` and read no committed file at all —
    its whole body was this one assertion about the pydantic default. Adding
    `RESUME_PARSE_RAW_TEXT_ENABLED: "true"` to a compose file would have left it green while
    the name promised otherwise. The scan it promised is the test below."""
    assert Settings(_env_file=None).resume_parse_raw_text_enabled is False


RAW_FLAG = "RESUME_PARSE_RAW_TEXT_ENABLED"

#: THE ONE COMMITTED LINE THE NAME MAY OCCUPY OUTSIDE A COMMENT (owner ruling 2026-09-15).
#: Exact text, exact file, exact service, exact section — each of the four is checked, so a
#: copy that differs in any one of them is a hit rather than a second allowance.
RAW_FLAG_ALLOWED_FILE = "docker-compose.staging.yml"
RAW_FLAG_ALLOWED_SERVICE = "ai-service"
RAW_FLAG_ALLOWED_LINE = f"{RAW_FLAG}: ${{{RAW_FLAG}:-false}}"


def _is_config_file(filename: str) -> bool:
    """Every committed file shape that can put a value into a process environment.

    WIDER THAN THE FIRST VERSION OF THIS SCAN, deliberately. It matched suffixes only, so a
    `.env.staging` (suffix `.staging`) or a `Dockerfile` (no suffix) could have set the flag
    unseen — and the moment the name became declarable, an `env_file:` pointing at exactly
    such a file became the obvious way to route around the one allowed line.
    """
    lowered = filename.lower()
    return (
        lowered.endswith((".yml", ".yaml", ".env", ".example", ".sh", ".toml", ".dockerfile"))
        or lowered.startswith((".env", "dockerfile"))
        or ".env." in lowered
    )


def _compose_position(lines: list[str], index: int) -> tuple[str | None, str | None, str | None]:
    """(top-level key, service, service section) that `lines[index]` sits under.

    Indentation-anchored, the same way `apps/api/src/common/testing/compose-env.ts` reads
    this file: 0-space top-level keys, 2-space service keys, 4-space sections. A shape change
    loud enough to break this would break the deploy too.
    """
    top = service = section = None
    for line in lines[:index]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        key = re.match(r"^\s*([A-Za-z0-9_.-]+):", line)
        if key is None:
            continue
        if indent == 0:
            top, service, section = key.group(1), None, None
        elif indent == 2:
            service, section = key.group(1), None
        elif indent == 4:
            section = key.group(1)
    return top, service, section


def _scan_raw_flag(root: Path) -> tuple[list[str], list[str]]:
    """Every committed occurrence of the flag under `root`, split into (hits, allowed).

    A HIT is any occurrence that is not a comment, except the single allowed compose line.
    Everything that could ARM the flag is a hit: a truthy or empty default, a literal, a bare
    substitution, a declaration on another service or in another file, an env-file assignment.

    `.github/` IS STRICTER: a comment there is a hit too. A workflow is where the forbidden
    second arming path — a `secrets.` bridge — would live, and a commented-out bridge line is
    one keystroke from live. The prose belongs beside the declaration in the compose file.

    `allowed` holds at most the one line. A SECOND byte-identical copy in the same block is a
    hit, not a second allowance: YAML's last-key-wins would make the later copy the real one.

    DETECTION IS CASE-INSENSITIVE; THE ALLOWANCE IS NOT. `Settings` never sets
    `case_sensitive`, so pydantic-settings reads `resume_parse_raw_text_enabled` and
    `Resume_Parse_Raw_Text_Enabled` as the same field as the canonical-case name — a
    case-sensitive scan would let either spelling ride in beside the real declaration and
    arm the flag while reporting zero hits. `is_allowed_line` still compares the line
    byte-for-byte, so only the one canonical-case declaration is ever permitted.

    Parameterised by `root` so the forbidden forms can each be proven red against a synthetic
    tree below, rather than only by someone remembering to mutate the real files.
    """
    # `os.walk` WITH IN-PLACE PRUNING, not `rglob`. `rglob` enumerates every path and only
    # then lets the caller skip it, so a filter on `node_modules` still WALKS the pnpm store —
    # hundreds of thousands of entries, per glob. Pruning `dirnames` stops the descent.
    skip = {"node_modules", ".git", ".venv", "dist", ".next", "build", ".turbo", "__pycache__"}

    hits: list[str] = []
    allowed: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in skip]
        for filename in filenames:
            if not _is_config_file(filename):
                continue
            path = Path(dirpath) / filename
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            # CASE-INSENSITIVE ON PURPOSE (security review, 2026-09-16): pydantic-settings
            # reads env vars case-insensitively by default (`Settings` never sets
            # `case_sensitive`), so `resume_parse_raw_text_enabled` arms the SAME field as
            # `RESUME_PARSE_RAW_TEXT_ENABLED`. A case-sensitive `in` here let exactly that
            # spelling sit alongside the real declaration, compose forwarded both names to the
            # container, and pydantic read the lowercase one as true — measured true positive,
            # zero committed-line change needed to arm it. Detection is case-insensitive;
            # `is_allowed_line` below stays byte-exact so only the one canonical-case line
            # is ever permitted.
            if RAW_FLAG not in text.upper():
                continue
            relative = path.relative_to(root).as_posix()
            in_github = relative.startswith(".github/")
            lines = text.splitlines()
            for index, line in enumerate(lines):
                stripped = line.strip()
                if RAW_FLAG not in stripped.upper():
                    continue
                # A comment may NAME it; only an assignment can ARM it. Not in `.github/`.
                if stripped.startswith("#") and not in_github:
                    continue
                is_allowed_line = (
                    relative == RAW_FLAG_ALLOWED_FILE
                    and line == f"      {RAW_FLAG_ALLOWED_LINE}"
                    and _compose_position(lines, index)
                    == ("services", RAW_FLAG_ALLOWED_SERVICE, "environment")
                    and not allowed
                )
                if is_allowed_line:
                    allowed.append(
                        f"{relative} [{RAW_FLAG_ALLOWED_SERVICE}]: {RAW_FLAG_ALLOWED_LINE}"
                    )
                else:
                    hits.append(f"{relative}:{index + 1}: {stripped}")
    return hits, allowed


def test_the_flag_is_armed_in_no_committed_file():
    """THE GUARD ADR-0041 §3.3 ACTUALLY ASKED FOR, NARROWED TO ONE ALLOWED LINE (2026-09-15).

    D5 permits an unmasked résumé to reach the model. Arming that is a decision a person takes
    once, visibly, on a box — never a line that rides in on a deploy. Until 2026-09-15 that was
    enforced as "the name appears in no committed file", which also made the flag UNREACHABLE:
    compose forwards only declared names, so the box had no way to set it. The owner ruled to
    declare it default-off; this scan now permits that one declaration and nothing else.

    Scans rather than trusting a default, because the default is not what would arm it.
    """
    hits, _allowed = _scan_raw_flag(REPO_ROOT)
    assert not hits, (
        f"{RAW_FLAG} occurs outside its one allowed declaration:\n  "
        + "\n  ".join(hits)
        + "\nADR-0041 section 3.2 (amended 2026-09-15): the only committed line is "
        f"`{RAW_FLAG_ALLOWED_LINE}` on the {RAW_FLAG_ALLOWED_SERVICE} service in "
        f"{RAW_FLAG_ALLOWED_FILE}; arming is the box .env plus a deploy re-run."
    )


def test_the_raw_flag_is_declared_default_off_on_the_ai_service():
    """THE OTHER DIRECTION: the declaration must EXIST, exactly once, exactly here.

    Without this, deleting the compose line would leave every scan green while the flag went
    back to being unreachable — the defect the 2026-09-15 ruling fixed.
    """
    _hits, allowed = _scan_raw_flag(REPO_ROOT)
    expected = f"{RAW_FLAG_ALLOWED_FILE} [{RAW_FLAG_ALLOWED_SERVICE}]: {RAW_FLAG_ALLOWED_LINE}"
    assert allowed == [expected]


def test_empty_string_is_not_a_legal_flag_value(monkeypatch: pytest.MonkeyPatch):
    """WHY THE COMPOSE LINE CARRIES `:-false` AND NOT `:-`.

    Measured through the process environment, because that is how compose delivers it: a bare
    or empty substitution hands the container `""`, and pydantic refuses it — the ai-service
    would not boot. If a validator ever maps "" to False, the reasoning in the compose comment
    goes stale, and this is what says so.
    """
    from pydantic import ValidationError

    monkeypatch.setenv(RAW_FLAG, "")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)

    monkeypatch.setenv(RAW_FLAG, "false")
    assert Settings(_env_file=None).resume_parse_raw_text_enabled is False


_SYNTHETIC_STAGING = """\
services:
  api:
    image: api
    environment:
      NODE_ENV: production
{api_extra}
  ai-service:
    image: ai
    environment:
      # {flag} is explained here, in prose.
      GEMINI_FLASH_API_KEY: ${{GEMINI_FLASH_API_KEY:-}}
{ai_line}
volumes:
  pgdata:
"""


def _synthetic_repo(
    tmp_path: Path,
    ai_line: str = f"      {RAW_FLAG_ALLOWED_LINE}",
    api_extra: str = "",
    extra_files: dict[str, str] | None = None,
) -> Path:
    (tmp_path / RAW_FLAG_ALLOWED_FILE).write_text(
        _SYNTHETIC_STAGING.format(flag=RAW_FLAG, ai_line=ai_line, api_extra=api_extra),
        encoding="utf-8",
    )
    for relative, content in (extra_files or {}).items():
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return tmp_path


def test_the_scan_permits_the_allowed_line_and_prose(tmp_path: Path):
    """WHAT THE GUARD PERMITS, tested first — an over-broad scan passes every red case below
    and gets deleted the first time it blocks the one legitimate declaration."""
    root = _synthetic_repo(
        tmp_path,
        extra_files={
            "docker-compose.yml": f"services:\n  ai-service:\n    # {RAW_FLAG} is off here.\n",
            ".env.example": f"# {RAW_FLAG}=true  (never uncomment; see ADR-0041)\n",
        },
    )
    hits, allowed = _scan_raw_flag(root)
    assert hits == []
    assert len(allowed) == 1


@pytest.mark.parametrize(
    "value",
    [
        f"${{{RAW_FLAG}:-true}}",
        f"${{{RAW_FLAG}:-TRUE}}",
        f"${{{RAW_FLAG}:-1}}",
        f"${{{RAW_FLAG}:-yes}}",
        f"${{{RAW_FLAG}:-On}}",
        f"${{{RAW_FLAG}:-}}",
        f"${{{RAW_FLAG}}}",
        f"${{{RAW_FLAG}-false}}",
        f'"${{{RAW_FLAG}:-false}}"',
        '"true"',
        "true",
        "1",
    ],
)
def test_the_scan_is_red_for_every_other_value_on_the_ai_service(tmp_path: Path, value: str):
    hits, allowed = _scan_raw_flag(_synthetic_repo(tmp_path, ai_line=f"      {RAW_FLAG}: {value}"))
    assert hits, f"a declaration of {value!r} passed the scan"
    assert allowed == []


@pytest.mark.parametrize(
    ("label", "kwargs"),
    [
        (
            "declared on the api service",
            {"ai_line": "", "api_extra": f"      {RAW_FLAG_ALLOWED_LINE}"},
        ),
        (
            "declared on BOTH services",
            {"api_extra": f"      {RAW_FLAG_ALLOWED_LINE}"},
        ),
        (
            "duplicated inside the ai-service block",
            {"ai_line": f"      {RAW_FLAG_ALLOWED_LINE}\n      {RAW_FLAG_ALLOWED_LINE}"},
        ),
        (
            "YAML list form",
            {"ai_line": f"      - {RAW_FLAG}=false"},
        ),
        (
            "wrong indentation (not an environment entry)",
            {"ai_line": f"    {RAW_FLAG_ALLOWED_LINE}"},
        ),
        (
            "a trailing comment on the allowed line",
            {"ai_line": f"      {RAW_FLAG_ALLOWED_LINE}  # armed later"},
        ),
        (
            "duplicated in docker-compose.yml",
            {
                "extra_files": {
                    "docker-compose.yml": "services:\n  ai-service:\n    environment:\n"
                    f"      {RAW_FLAG_ALLOWED_LINE}\n"
                }
            },
        ),
        (
            "declared in another compose file",
            {
                "extra_files": {
                    "docker-compose.e2e.yml": "services:\n  ai-service:\n    environment:\n"
                    f"      {RAW_FLAG_ALLOWED_LINE}\n"
                }
            },
        ),
        (
            "an uncommented assignment in .env.example",
            {"extra_files": {".env.example": f"{RAW_FLAG}=false\n"}},
        ),
        (
            "an env file without a matched suffix",
            {"extra_files": {"apps/ai-service/.env.staging": f"{RAW_FLAG}=true\n"}},
        ),
        (
            "a Dockerfile ENV",
            {"extra_files": {"apps/ai-service/Dockerfile": f"ENV {RAW_FLAG}=true\n"}},
        ),
        (
            "a ci.yml secrets bridge",
            {
                "extra_files": {
                    ".github/workflows/ci.yml": "jobs:\n  deploy:\n    env:\n"
                    f"      {RAW_FLAG}: ${{{{ secrets.{RAW_FLAG} }}}}\n"
                }
            },
        ),
        (
            "a ci.yml envs: token",
            {"extra_files": {".github/workflows/ci.yml": f"        envs: REDIS_URL,{RAW_FLAG}\n"}},
        ),
        (
            "a commented-out bridge in a workflow",
            {
                "extra_files": {
                    ".github/workflows/ci.yml": "jobs:\n"
                    f"      # {RAW_FLAG}: ${{{{ secrets.{RAW_FLAG} }}}}\n"
                }
            },
        ),
        (
            # THE BLOCKER (security review, 2026-09-16): pydantic-settings is
            # case-INSENSITIVE by default, so this lowercase key arms the identical field as
            # the canonical-case one. Sitting ALONGSIDE the correct line — exactly this shape
            # — passed the case-sensitive version of this scan (hits == []) while compose
            # forwarded both names to the container and pydantic resolved the flag true.
            "lowercase key alongside the correct line (pydantic-settings case-insensitivity)",
            {
                "ai_line": (
                    f"      {RAW_FLAG_ALLOWED_LINE}\n" f'      {RAW_FLAG.lower()}: "true"'
                )
            },
        ),
        (
            "MixedCase key alongside the correct line (same case-insensitivity bug)",
            {
                "ai_line": (
                    f"      {RAW_FLAG_ALLOWED_LINE}\n"
                    f'      {"_".join(w.capitalize() for w in RAW_FLAG.split("_"))}: "true"'
                )
            },
        ),
        (
            # Isolates the OTHER half of the same bug: the per-FILE short-circuit
            # (`if RAW_FLAG not in text`) is also case-sensitive, so a file whose only
            # mention of the name is lowercase never even reached the per-line check.
            "a lowercase-only declaration in another compose file (no uppercase mention "
            "anywhere in that file — exercises the per-file pre-check, not just the line)",
            {
                "extra_files": {
                    "docker-compose.e2e.yml": "services:\n  ai-service:\n    environment:\n"
                    f'      {RAW_FLAG.lower()}: "true"\n'
                }
            },
        ),
    ],
)
def test_the_scan_is_red_for_every_second_arming_path(tmp_path: Path, label: str, kwargs: dict):
    hits, _allowed = _scan_raw_flag(_synthetic_repo(tmp_path, **kwargs))
    assert hits, f"{label}: passed the scan"


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


# ===========================================================================
# 9. The cited SPAN — found by the RI-3 security review, not by the tests above
# ===========================================================================


def test_a_clean_value_with_a_dirty_SPAN_is_dropped(monkeypatch):
    """H1. THE CASE THIS FILE ORIGINALLY MISSED.

    `apply_parse_gates` certifies a field's VALUE. On the interview route that is complete by
    construction — the transcript was pseudonymized before the model saw it, so a quote cannot
    carry what the value cannot. This route breaks that assumption: with the raw-text policy
    on, a quote is a literal substring of an unmasked résumé line.

    And the line most likely to be cited for `current_city` is the header, which on a real
    résumé carries the name, the phone and sometimes the PAN. The value ("Pune") is clean and
    passes gate 6; the span beside it was riding out uncertified.
    """
    header = f"Ramesh Kumar | CNC Turner | Pune | {PHONE} | PAN {PAN}"
    out, router = run_parse(
        texts=[header],
        reply=model_reply({"current_city": field_at(0, header, "Pune")}),
        monkeypatch=monkeypatch,
        resume_parse_raw_text_enabled=True,
    )

    assert PHONE in router.prompt_text, "vacuity: the raw flag must have sent the line"
    assert out.fields == {}, "a field whose cited span carries a phone must not survive"


def test_a_clean_value_with_a_clean_span_still_survives(monkeypatch):
    """The other half. A span check that refuses everything is not a span check."""
    out, _ = run_parse(
        texts=["CNC Turner, Pune, 5 years"],
        reply=model_reply({"current_city": field_at(0, "CNC Turner, Pune, 5 years", "Pune")}),
        monkeypatch=monkeypatch,
        resume_parse_raw_text_enabled=True,
    )
    assert out.fields["current_city"].value == "Pune"


def test_an_employment_row_whose_SPAN_carries_a_phone_is_dropped(monkeypatch):
    """Same omission, same fix, on the other path. An employment row's quote is the résumé
    line it was read from — and on a real résumé that line carries the employer AND the
    contact details printed beside it."""
    line = f"Tata Motors Ltd | CNC Turner | 2019-2023 | {PHONE}"
    out, _ = run_parse(
        texts=[line],
        reply=model_reply(
            employments=[
                {
                    "employer_name": "Tata Motors Ltd",
                    "role_title": "CNC Turner",
                    "start_year": 2019,
                    "end_year": 2023,
                    "evidence": {"message_index": 0, "quote": line},
                }
            ]
        ),
        monkeypatch=monkeypatch,
        resume_parse_raw_text_enabled=True,
    )
    assert out.employments == []


def test_the_hard_identifier_wall_covers_the_14_digit_band(monkeypatch):
    """M1. `_PHONE_RE` is bounded ABOVE at 13 digits and the residual-digit net is excluded,
    so a bank account (9-18 digits) and an ESIC number (17) had nothing looking at them."""
    from app.pseudonymize import contains_hard_identifier

    assert contains_hard_identifier("50100123456789") == "long_digit_run"
    assert contains_hard_identifier("123456789012345678") == "long_digit_run"
    # …and a salary, which is what the exclusion exists to protect, is untouched.
    assert contains_hard_identifier("1200000") is None
    assert contains_hard_identifier("500000") is None


# ===========================================================================
# TRADE ASSOCIATION (Task 1 B2) — the model classifies, the gate decides
# ===========================================================================

KINDS = ["cnc_turner", "welder", "tailor"]


def assoc_reply(kind) -> str:
    return json.dumps({"fields": {}, "trade_association": {"kind": kind}})


def test_kinds_reach_the_prompt_as_a_closed_list(monkeypatch):
    _, router = run_parse(
        texts=["CNC Turner, 5 saal tajurba"],
        reply=model_reply(),
        trade_kinds=KINDS,
        monkeypatch=monkeypatch,
    )
    for kind in KINDS:
        assert kind in router.prompt_text
    assert "trade_association" in router.prompt_text


def test_no_kinds_means_no_option_list_and_no_judgment(monkeypatch):
    # The RULES live in the system prompt unconditionally; the OPTION LIST is
    # what invites a judgment, and it is only rendered when kinds are supplied.
    out, router = run_parse(
        texts=["CNC Turner, 5 saal tajurba"],
        reply=model_reply(),
        monkeypatch=monkeypatch,
    )
    assert "TRADE KINDS (the only ids you may return)" not in router.prompt_text
    assert out.trade_association is None


def test_a_listed_kind_survives_the_gate(monkeypatch):
    out, _ = run_parse(
        texts=["CNC Turner, 5 saal tajurba"],
        reply=assoc_reply("cnc_turner"),
        trade_kinds=KINDS,
        monkeypatch=monkeypatch,
    )
    assert out.trade_association is not None
    assert out.trade_association.kind == "cnc_turner"


def test_an_unlisted_kind_is_dropped_to_none_and_fields_survive(monkeypatch):
    # THE LENIENCY PROPERTY. The key is additive: a model that invents an id
    # costs the classification, never the cited fields beside it.
    line = "CNC Turner, Pune"
    out, _ = run_parse(
        texts=[line],
        reply=json.dumps(
            {
                "fields": {"role_label": field_at(0, line, "CNC Turner")},
                "trade_association": {"kind": "astronaut"},
            }
        ),
        trade_kinds=KINDS,
        monkeypatch=monkeypatch,
    )
    assert out.trade_association is None
    assert out.fields["role_label"].value == "CNC Turner"


def test_a_bare_string_naming_a_listed_kind_is_kept_on_membership(monkeypatch):
    # LENIENT SHAPE, STRICT MEMBERSHIP. The wall is "is it one of our ids", not
    # "did it use the object wrapper" — a bare string naming a listed kind is
    # still just membership, so it is kept and the fields beside it are intact.
    line = "CNC Turner, Pune"
    out, _ = run_parse(
        texts=[line],
        reply=json.dumps(
            {
                "fields": {"role_label": field_at(0, line, "CNC Turner")},
                "trade_association": "cnc_turner",
            }
        ),
        trade_kinds=KINDS,
        monkeypatch=monkeypatch,
    )
    assert out.trade_association is not None
    assert out.trade_association.kind == "cnc_turner"
    assert out.fields["role_label"].value == "CNC Turner"


def test_an_omitted_key_is_no_judgment_not_a_failure(monkeypatch):
    out, _ = run_parse(
        texts=["CNC Turner, Pune"],
        reply=model_reply(),
        trade_kinds=KINDS,
        monkeypatch=monkeypatch,
    )
    assert out.failure_reason is None
    assert out.trade_association is None


# ===========================================================================
# 10. SHAPE DAMAGE IS PER-ENTRY — the reply that used to be all-or-nothing
# ===========================================================================
#
# `_read_resume_output` validated `fields` and `employments` as ONE strict tree, so a
# single malformed entry returned `parse_output_invalid` and discarded every good entry
# beside it. Downstream: the import row is marked `failed`, the processor skips the
# summary, and the worker never gets the "Kya ye aap hi hain?" turn — for one bad row.
#
# A real 2-page English CV produced such rows on every run. Extraction and masking were
# fine (86 lines, `pdf_text`); it was the reply that could not survive contact with its
# own contract. The measured cases are below, and every one of them used to be fatal:
#
#   end_year "Present" · confidence 95 · an omitted `evidence` · message_index "4"
#   against a strict int · normalization "none" · source "resume"
#
# `gate_employments`, `apply_parse_gates` and `mask_resume_lines` already had the right
# posture — drop the ENTRY, count it, keep going. This section pins that the SHAPE check
# upstream of them now has it too, and that it did not buy resilience by weakening a gate.

DAMAGED_LINE = "CNC Turner | Tata Motors Ltd | Pune | 2021 - Present"

#: Sentinel for "the model omitted this key entirely", which is not the same damage as
#: sending null for it — the most common of the six real failures was an absent `evidence`.
OMITTED = object()


def employment_row(**over) -> dict:
    """A shape-valid, gate-passing employment row with whatever is named here changed."""
    row = {
        "employer_name": "Tata Motors Ltd",
        "role_title": "CNC Turner",
        "start_year": 2019,
        "end_year": 2021,
        "evidence": {"message_index": 0, "quote": "Tata Motors Ltd"},
    }
    return _apply(row, over)


def city_field(**over) -> dict:
    """A shape-valid, gate-passing `current_city` with whatever is named here changed."""
    return _apply(field_at(0, "Pune", "Pune"), over)


def _apply(entry: dict, over: dict) -> dict:
    for key, value in over.items():
        if value is OMITTED:
            entry.pop(key, None)
        else:
            entry[key] = value
    return entry


def run_damaged(reply: str, monkeypatch) -> object:
    """One damaged reply through the WHOLE pipeline, raw-text on.

    RAW-TEXT ON so the employer name survives the INPUT masker and provenance can
    resolve its quote — the same reason `test_an_employer_name_survives_to_the_response`
    turns it on. It does not move the output wall by one inch; that is section 1's
    whole subject.
    """
    out, _ = run_parse(
        texts=[DAMAGED_LINE],
        reply=reply,
        monkeypatch=monkeypatch,
        resume_parse_raw_text_enabled=True,
    )
    return out


def test_the_undamaged_reply_arrives_whole(monkeypatch):
    """VACUITY GUARD, and it comes first on purpose. Every test below asserts that the
    GOOD entries survived alongside a bad one; if the harness could not get them through
    in the first place, all of them would pass while proving nothing."""
    out = run_damaged(
        model_reply(fields={"current_city": city_field()}, employments=[employment_row()]),
        monkeypatch,
    )
    assert out.failure_reason is None
    assert out.fields["current_city"].value == "Pune"
    assert len(out.employments) == 1
    # `raw_text_policy_active` is the posture this harness runs under, not a rejection.
    assert out.notes == ["raw_text_policy_active"]


@pytest.mark.parametrize(
    ("label", "damage"),
    [
        ("end_year 'Present' for an open-ended stint", {"end_year": "Present"}),
        ("message_index as the string '0'", {"evidence": {"message_index": "0", "quote": "x"}}),
        ("a year outside the contract bounds", {"start_year": 1899}),
        ("no evidence at all", {"evidence": OMITTED}),
        ("the row is not an object", None),
    ],
)
def test_a_malformed_employment_row_costs_only_that_row(label, damage, monkeypatch):
    """B and E, plus the two neighbours the same reply produces.

    The test CV had three stints, all with en-dash year ranges and one open-ended —
    "2021 – Present". `end_year: "Present"` is not an int, and that one row used to take
    the other two employments AND every cited field with it.
    """
    bad = "Tata Motors Ltd" if damage is None else employment_row(**damage)
    out = run_damaged(
        model_reply(
            fields={"current_city": city_field()},
            employments=[employment_row(), bad],
        ),
        monkeypatch,
    )
    assert out.failure_reason is None, f"{label} must not fail the whole parse"
    assert len(out.employments) == 1, label
    assert out.employments[0].employer_name == "Tata Motors Ltd"
    assert out.fields["current_city"].value == "Pune", "the cited field must survive it"
    assert "employments_rejected" in out.notes


@pytest.mark.parametrize(
    ("label", "damage"),
    [
        ("confidence as a percentage", {"confidence": 95}),
        ("no evidence at all", {"evidence": OMITTED}),
        ("message_index as the string '0'", {"evidence": {"message_index": "0", "quote": "Pune"}}),
        ("normalization outside the literal", {"normalization": "none"}),
        ("source outside the literal", {"source": "resume"}),
        ("the entry is not an object", None),
    ],
)
def test_a_malformed_field_costs_only_that_field(label, damage, monkeypatch):
    """C, D, E, F and G. Each one used to return `parse_output_invalid` for the reply.

    The damaged field is `current_city` and it cites a quote that IS in the line, so if
    the shape check ever let one of these through, the gates would ACCEPT it and this
    would go red rather than silently agree.
    """
    bad = "Pune" if damage is None else city_field(**damage)
    out = run_damaged(
        model_reply(
            fields={"role_label": field_at(0, "CNC Turner", "CNC Turner"), "current_city": bad},
            employments=[employment_row()],
        ),
        monkeypatch,
    )
    assert out.failure_reason is None, f"{label} must not fail the whole parse"
    assert out.fields["role_label"].value == "CNC Turner", label
    assert "current_city" not in out.fields
    assert "current_city" in out.unparsed_field_ids
    assert len(out.employments) == 1, "the employment beside it must survive too"
    assert "fields_rejected" in out.notes


def test_a_null_field_is_still_no_judgment_and_not_a_rejection(monkeypatch):
    """The contract declares `ParsedField | None` and `apply_parse_gates` reads a null as
    "I looked and found nothing citable" — an honest answer. Counting it as shape damage
    would put a `fields_rejected` note on a clean parse and make the counter useless."""
    out = run_damaged(
        model_reply(
            fields={"role_label": field_at(0, "CNC Turner", "CNC Turner"), "current_city": None},
            employments=[],
        ),
        monkeypatch,
    )
    assert out.failure_reason is None
    assert out.fields["role_label"].value == "CNC Turner"
    assert "fields_rejected" not in out.notes


def test_the_gates_still_run_on_every_entry_that_survives_the_shape_check(monkeypatch):
    """THE LOAD-BEARING ONE. Resilience bought by relaxing a gate would be a privacy
    regression wearing a bug fix's clothes.

    Three employment rows in one reply: an honest one, one the shape check must drop
    (`end_year: "Present"`), and one that is perfectly shaped and must be refused by gate
    6 — a PAN in the employer name. Exactly one may come out. The same for the fields: a
    damaged one and a shape-valid one whose value carries a PAN.
    """
    out = run_damaged(
        model_reply(
            fields={
                "role_label": field_at(0, "CNC Turner", "CNC Turner"),
                "current_city": city_field(confidence=95),
                "experience_years": field_at(0, "CNC Turner", f"PAN {PAN}"),
            },
            employments=[
                employment_row(),
                employment_row(end_year="Present"),
                employment_row(employer_name=f"Tata Motors Ltd PAN {PAN}"),
            ],
        ),
        monkeypatch,
    )
    assert [e.employer_name for e in out.employments] == ["Tata Motors Ltd"]
    assert set(out.fields) == {"role_label"}
    assert PAN not in json.dumps(out.model_dump(), default=str)


def test_shape_damage_adds_no_new_note_code(monkeypatch):
    """The note vocabulary is closed because a note is counted on an event. A drop that
    happens before the gates is reported under the gates' own two codes: from outside
    this service "unreadable row" and "rejected row" are one outcome — it is not there."""
    out = run_damaged(
        model_reply(
            fields={"current_city": city_field(source="resume")},
            employments=[employment_row(end_year="Present")],
        ),
        monkeypatch,
    )
    assert set(out.notes) == {"fields_rejected", "employments_rejected", "raw_text_policy_active"}
    assert all(note in RESUME_PARSE_NOTES for note in out.notes)


@pytest.mark.parametrize(
    ("label", "reply"),
    [
        ("prose instead of JSON", "I'm afraid I can't do that"),
        ("a JSON array at the top level", "[1, 2, 3]"),
        ("a bare JSON string", '"ok"'),
        ("fields is a list, not an object", '{"fields": [], "employments": []}'),
        ("employments is a string, not an array", '{"fields": {}, "employments": "none"}'),
        ("fields is null", '{"fields": null, "employments": []}'),
        ("unparsed_field_ids is an object", '{"fields": {}, "unparsed_field_ids": {}}'),
    ],
)
def test_an_unreadable_body_is_still_parse_output_invalid(label, reply, monkeypatch):
    """WHAT MUST STAY FATAL. Only per-ENTRY damage became survivable.

    A container that is not a container is the model having ignored the response schema
    outright, and a reply whose shape this service cannot recognise is one it has no way
    to gate. The fail-closed reading of an ungateable overlay is "there was no overlay".
    """
    out = run_damaged(reply, monkeypatch)
    assert out.failure_reason == "parse_output_invalid", label
    assert out.fields == {}
    assert out.employments == []


def test_a_dropped_entry_puts_nothing_of_the_model_or_the_document_in_a_log(monkeypatch, caplog):
    """THE NEW LEAK SURFACE, closed where it opened.

    A pydantic `ValidationError` message quotes the input it rejected, and for a résumé
    that input is an employer name, a phone number and the line they were printed on.
    `_narrow_fields` / `_narrow_employments` therefore log NOTHING — they count, and the
    pipeline logs the total. `resume_import.fields_rejected` has always worked this way;
    the new drop path must not be the exception.
    """
    with caplog.at_level(logging.DEBUG):
        out = run_damaged(
            model_reply(
                fields={"current_city": city_field(value=f"Ramesh Kumar {PHONE}", confidence=95)},
                employments=[employment_row(employer_name=f"Bharat Forge {PAN}", end_year="Now")],
            ),
            monkeypatch,
        )

    assert out.failure_reason is None
    emitted = "\n".join(r.getMessage() + repr(getattr(r, "extra", "")) for r in caplog.records)
    for fragment in ("Ramesh", PHONE, PAN, "Bharat Forge", "Tata Motors", "Now", "confidence"):
        assert fragment not in emitted, f"{fragment} reached a log line"
