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
import json
import logging

from app.config import Settings
from app.contracts import AICallMetadata, ResumeSummaryInput, ResumeSummaryOutput
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


def run_summary(
    *,
    reply: str,
    monkeypatch,
    texts: list[str] | None = None,
    role_kinds: list[str] | None = None,
    **settings_overrides,
):
    """Drive the WHOLE pipeline with storage and extraction stubbed, the router recording.

    THROUGH `summarize_resume`, NEVER THROUGH `gate_summary_for_test` — and this helper
    exists so that is the cheap option rather than the expensive one. That asymmetry is
    exactly how the bounds defect shipped green: `test_overlong_strings_degrade_not_truncate`
    called the gate directly and passed, while the pipeline beside it did the opposite —
    the contract validated the two Hinglish strings BEFORE the gate could drop them, so an
    over-long summary returned `parse_output_invalid` and took the role with it. A gate
    test proves what the gate does. Only a pipeline test proves the gate is reached.
    """
    import app.resume_import.resume_summary as mod

    async def fake_download(*args, **kwargs):  # noqa: ARG001
        return b"%PDF-1.4 stub"

    monkeypatch.setattr(mod, "download_object", fake_download)
    monkeypatch.setattr(
        mod, "extract", lambda data, mime=None: extraction(*(texts or ["CNC Turner, 5 saal"]))
    )
    router = RecordingRouter(reply)
    body = ResumeSummaryInput(
        worker_ref="w1",
        storage_key="resume-uploads/w1/abc.pdf",
        mime="application/pdf",
        role_kinds=role_kinds if role_kinds is not None else ["cnc_turner", "welder"],
    )
    out = _run(
        summarize_resume(
            body,
            settings=settings(**settings_overrides),
            router=router,  # type: ignore[arg-type]
        )
    )
    return out, router


def summary_reply(**over) -> str:
    """A well-formed reply with one thing changed. `None` here means the model sent null."""
    body = {
        "role_kind": "cnc_turner",
        "experience_text": "10+ saal ka tajurba",
        "summary_text": "CNC lathe par kaam, Pune mein",
    }
    body.update(over)
    return json.dumps(body)


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
    out, router = run_summary(
        reply=summary_reply(experience_text="5 saal ka tajurba"), monkeypatch=monkeypatch
    )
    assert router.task_types == [RESUME_SUMMARY_TASK_TYPE]
    assert out.role_kind == "cnc_turner"
    assert out.experience_text == "5 saal ka tajurba"
    assert out.failure_reason is None


def test_pipeline_degrades_on_unreadable_model_output(monkeypatch):
    out, _ = run_summary(reply="not json at all", monkeypatch=monkeypatch)
    assert out.role_kind is None
    assert out.failure_reason == "parse_output_invalid"


# ===========================================================================
# THE BOUNDS, THROUGH THE PIPELINE — where the gate test could not see them
# ===========================================================================
#
# `_MAX_EXPERIENCE_CHARS` / `_MAX_SUMMARY_CHARS` are mirrored from the contract so the
# gate can drop an over-long string to null. The contract carried the SAME bounds and was
# validated first, so it failed the whole reply before the gate ran: `role_kind` and the
# other, perfectly good, Hinglish string were discarded with it and the response said
# `parse_output_invalid`. Downstream that is an import row marked `failed`, no summary,
# and no "Kya ye aap hi hain?" turn for the worker.
#
# It never showed up because a dense English CV invites a 500+ character Hinglish summary
# and the short app-generated documents the feature was built on do not.


def test_an_overlong_summary_costs_only_the_summary(monkeypatch):
    out, _ = run_summary(reply=summary_reply(summary_text="y" * 501), monkeypatch=monkeypatch)
    assert out.failure_reason is None, "one over-long string must not fail the whole reply"
    assert out.role_kind == "cnc_turner"
    assert out.experience_text == "10+ saal ka tajurba"
    assert out.summary_text is None
    assert "fields_rejected" in out.notes


def test_an_overlong_experience_costs_only_the_experience(monkeypatch):
    out, _ = run_summary(reply=summary_reply(experience_text="x" * 121), monkeypatch=monkeypatch)
    assert out.failure_reason is None
    assert out.role_kind == "cnc_turner"
    assert out.experience_text is None
    assert out.summary_text == "CNC lathe par kaam, Pune mein"
    assert "fields_rejected" in out.notes


def test_an_overlong_string_is_dropped_whole_and_never_truncated(monkeypatch):
    """The rule the bounds exist to serve, asserted where it now actually runs.

    A truncation can cut a word and read as a different claim — "10 saal ka tajurba
    supervisor ke roop mein" clipped mid-word is a sentence the résumé never made. So the
    field is null, and it is not a 500-character prefix of anything.
    """
    out, _ = run_summary(reply=summary_reply(summary_text="y" * 900), monkeypatch=monkeypatch)
    assert out.summary_text is None


def test_a_string_exactly_on_the_bound_still_survives(monkeypatch):
    """VACUITY GUARD. Dropping everything would satisfy the two tests above and would be
    a worse bug than the one they cover — so the boundary case must arrive intact."""
    out, _ = run_summary(
        reply=summary_reply(experience_text="x" * 120, summary_text="y" * 500),
        monkeypatch=monkeypatch,
    )
    assert out.experience_text == "x" * 120
    assert out.summary_text == "y" * 500
    assert "fields_rejected" not in out.notes


def test_a_non_string_hinglish_field_costs_only_itself(monkeypatch):
    """The two strings reach the gate as `object`, so a shape the contract would have
    refused outright is now one field's loss. `_gate_hinglish` refuses a non-string
    whole; it has always said so, and now it is the code that decides it."""
    out, _ = run_summary(reply=summary_reply(experience_text=12), monkeypatch=monkeypatch)
    assert out.failure_reason is None
    assert out.role_kind == "cnc_turner"
    assert out.experience_text is None
    assert out.summary_text == "CNC lathe par kaam, Pune mein"


def test_the_pipeline_and_the_gate_now_answer_the_same_thing(monkeypatch):
    """THE DEFECT CLASS ITSELF, pinned: the helper and the pipeline disagreed.

    `gate_summary_for_test` said ('cnc_turner', '10+ saal ka tajurba', None) while
    `summarize_resume` said (None, None, None) with `parse_output_invalid`. Whichever
    way a future edit moves the bounds, these two must move together or this goes red.
    """
    long_summary = "y" * 501
    out, _ = run_summary(reply=summary_reply(summary_text=long_summary), monkeypatch=monkeypatch)
    assert (out.role_kind, out.experience_text, out.summary_text) == gate_summary_for_test(
        "cnc_turner", "10+ saal ka tajurba", long_summary, ["cnc_turner", "welder"]
    )


def test_an_identifier_in_one_string_still_costs_only_that_string(monkeypatch):
    """The PII wall is the other half of the gate and it was never unreachable — but it
    now runs on the same raw value the bounds do, so this pins that the reorder did not
    move it. A phone number in the summary is refused whole; the role survives."""
    out, _ = run_summary(
        reply=summary_reply(summary_text="CNC lathe par kaam, call 9876543210"),
        monkeypatch=monkeypatch,
    )
    assert out.summary_text is None
    assert out.role_kind == "cnc_turner"
    assert "fields_rejected" in out.notes


def test_the_gate_bounds_still_match_the_contract_exactly():
    """THE COUPLING THE FIX CREATED, pinned before it can bite.

    The gate now decides the bounds and `_response` builds the contract object afterwards
    — so a gate bound RAISED above the contract's would let an over-long string reach
    `ResumeSummaryOutput(...)` and turn "never raises" into a 500. Lowered, it would be a
    silent quality cut nobody asked for. `app/contracts.py` is the wire contract and is
    mirrored in `packages/ai-contracts` (Zod); this service's copy may not drift from it
    in either direction, and moving one means moving all three.
    """
    from app.resume_import.resume_summary import _MAX_EXPERIENCE_CHARS, _MAX_SUMMARY_CHARS

    def contract_max(name: str) -> int:
        (constraint,) = ResumeSummaryOutput.model_fields[name].metadata
        return constraint.max_length

    assert _MAX_EXPERIENCE_CHARS == contract_max("experience_text")
    assert _MAX_SUMMARY_CHARS == contract_max("summary_text")


def test_the_overlong_string_does_not_reach_a_log(monkeypatch, caplog):
    """A pydantic error quotes the input it rejected. Moving the bounds out of the
    contract removed that risk here rather than relocating it — nothing about the refused
    string may reach a log line, and least of all the string."""
    secret = "Ramesh Kumar 9876543210 " + "y" * 501
    with caplog.at_level(logging.DEBUG):
        out, _ = run_summary(reply=summary_reply(summary_text=secret), monkeypatch=monkeypatch)
    assert out.summary_text is None
    emitted = "\n".join(r.getMessage() + repr(getattr(r, "extra", "")) for r in caplog.records)
    for fragment in ("Ramesh", "9876543210", "yyyy"):
        assert fragment not in emitted
