"""RI-summary — POST /resume/summary, the second call after the parse.

THE ONE THING THIS FILE EXISTS FOR is the backend-only contract: one Hinglish
line ({role} + {tajurba} + {summary}) for Langfuse verification, never shown in
chat in this slice. The tests below assert the three properties that make that
safe:

  1. The role is a classification among caller-supplied ENABLED kinds (9), never
     an invented id — anything off-list degrades to null, never to a stored row.
  2. Both Hinglish strings pass the SAME hard-identifier wall as the parse — a
     summary carrying a phone/PAN/employer degrades to null whole.
  3. Every degraded path returns a valid body with a closed `failure_reason` —
     ruling D9, never a dead end.
"""

from __future__ import annotations

import asyncio

from app.config import Settings
from app.contracts import AICallMetadata, ResumeSummaryInput
from app.resume_import.extract import ExtractionResult, Line
from app.resume_import.resume_summary import (
    RESUME_SUMMARY_TASK_TYPE,
    gate_summary_for_test,
    summarize_resume,
)
from app.resume_import.summary_prompt import (
    RESUME_SUMMARY_SYSTEM_PROMPT,
    build_resume_summary_messages,
    empty_resume_summary,
)


def _run(coro):
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
    def __init__(self, reply: str = "{}", *, real_call: bool = True, success: bool = True):
        self.reply = reply
        self.messages: list[dict[str, str]] = []
        self.calls = 0
        self.task_types: list[str] = []
        self._meta = AICallMetadata(
            ai_call_id="00000000-0000-4000-8000-000000000000",
            task_type=RESUME_SUMMARY_TASK_TYPE,
            model_name="test-model",
            provider="test",
            real_call=real_call,
            success=success,
            created_at="2026-09-11T00:00:00+00:00",
        )

    async def run(self, task_type, *, messages, **kwargs):  # noqa: ARG002
        self.calls += 1
        self.task_types.append(task_type)
        self.messages = messages
        return self.reply, self._meta


def test_system_prompt_is_hinglish_roman_and_closed_list():
    assert "HINGLISH ONLY" in RESUME_SUMMARY_SYSTEM_PROMPT
    assert "ROMAN SCRIPT ONLY" in RESUME_SUMMARY_SYSTEM_PROMPT
    assert "ROLE KINDS" in RESUME_SUMMARY_SYSTEM_PROMPT
    assert "strict JSON" in RESUME_SUMMARY_SYSTEM_PROMPT


def test_prompt_renders_the_enabled_kinds_verbatim():
    from app.resume_import.extract import Line
    from app.resume_import.parse_policy import MaskedLines

    masked = MaskedLines(
        lines=(Line(index=0, page=1, text="CNC Turner, 5 saal"),),
        dropped=0,
    )
    msgs = build_resume_summary_messages(masked, ["cnc_turner", "welder"])
    user = msgs[1]["content"]
    assert "- cnc_turner" in user
    assert "- welder" in user
    assert "[0] CNC Turner, 5 saal" in user


def test_empty_summary_contributes_nothing_but_stays_valid():
    out = empty_resume_summary()
    assert out.role_kind is None
    assert out.experience_text is None
    assert out.summary_text is None
    assert out.failure_reason is None


def test_off_list_role_degrades_to_null_not_to_a_row():
    role, exp, summ = gate_summary_for_test(
        "bus_driver", "5 saal ka tajurba", "CNC lathe par kaam", ["cnc_turner", "welder"]
    )
    assert role is None
    assert exp == "5 saal ka tajurba"
    assert summ == "CNC lathe par kaam"


def test_on_list_role_survives():
    role, _, _ = gate_summary_for_test(
        "welder", "2 saal ka tajurba", "Welding ka kaam", ["cnc_turner", "welder"]
    )
    assert role == "welder"


def test_identifier_carrying_strings_degrade_whole():
    _, exp, summ = gate_summary_for_test(
        "cnc_turner", "Call 9876543210", "CNC lathe par kaam", ["cnc_turner"]
    )
    assert exp is None
    assert summ == "CNC lathe par kaam"


def test_overlong_strings_degrade_not_truncate():
    long_exp = "x" * 121
    long_summ = "y" * 501
    _, exp, summ = gate_summary_for_test("cnc_turner", long_exp, long_summ, ["cnc_turner"])
    assert exp is None
    assert summ is None


def test_pipeline_calls_the_summary_task_not_the_parse_task(monkeypatch):
    import app.resume_import.resume_summary as mod

    monkeypatch.setattr(
        mod, "extract", lambda data, mime=None: extraction("CNC Turner, 5 saal")
    )
    monkeypatch.setattr(
        mod, "download_object", lambda *a, **k: _run(_noop_bytes())
    )

    async def _noop_bytes():
        return b"%PDF-1.4 fake"

    # download_object is async in the pipeline; patch with an async stub instead.
    async def _fake_download(*a, **k):
        return b"%PDF-1.4 fake"

    monkeypatch.setattr(mod, "download_object", _fake_download)

    router = RecordingRouter(
        reply='{"role_kind": "cnc_turner", "experience_text": "5 saal ka tajurba", '
        '"summary_text": "CNC lathe par kaam"}'
    )
    body = ResumeSummaryInput(
        worker_ref="w1",
        storage_key="resume-uploads/w1/abc.pdf",
        mime="application/pdf",
        role_kinds=["cnc_turner", "welder"],
    )
    out = _run(
        summarize_resume(body, settings=settings(), router=router)  # type: ignore[arg-type]
    )
    assert router.task_types == [RESUME_SUMMARY_TASK_TYPE]
    assert out.role_kind == "cnc_turner"
    assert out.experience_text == "5 saal ka tajurba"
    assert out.failure_reason is None


def test_pipeline_degrades_on_unreadable_model_output(monkeypatch):
    import app.resume_import.resume_summary as mod

    async def _fake_download(*a, **k):
        return b"%PDF-1.4 fake"

    monkeypatch.setattr(mod, "download_object", _fake_download)
    monkeypatch.setattr(
        mod, "extract", lambda data, mime=None: extraction("CNC Turner, 5 saal")
    )
    router = RecordingRouter(reply="not json at all")
    body = ResumeSummaryInput(
        worker_ref="w1",
        storage_key="resume-uploads/w1/abc.pdf",
        mime="application/pdf",
        role_kinds=["cnc_turner"],
    )
    out = _run(
        summarize_resume(body, settings=settings(), router=router)  # type: ignore[arg-type]
    )
    assert out.role_kind is None
    assert out.failure_reason == "parse_output_invalid"
