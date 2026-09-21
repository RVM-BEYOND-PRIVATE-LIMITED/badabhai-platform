"""RI-autofill — POST /resume/map-options, the third call after the parse.

THE ONE THING THIS FILE EXISTS FOR is the mapping contract: document lines onto
pack option ids, cited and verbatim, under owner override B (which applies to the
CONSUMER, never to these gates). The tests below assert the four properties that
make the override safe to consume:

  1. Option ids are copied VERBATIM from the asked question — an invented id, an
     id from another question, or a label in place of an id degrades to dropped.
  2. single_select takes at most one id; one mapping per question at most.
  3. Every mapping is cited (provenance) and its quote passes the SAME
     hard-identifier wall as the parse.
  4. Every degraded path returns a valid body with a closed `failure_reason` —
     ruling D9, never a dead end.
"""

from __future__ import annotations

import asyncio

from app.config import Settings
from app.contracts import AICallMetadata, ResumeMapQuestion, ResumeOptionMapInput
from app.resume_import.extract import ExtractionResult, Line
from app.resume_import.option_map_prompt import (
    RESUME_OPTION_MAP_SYSTEM_PROMPT,
    build_resume_option_map_messages,
    empty_resume_option_map,
)
from app.resume_import.resume_option_map import RESUME_OPTION_MAP_TASK_TYPE, map_resume_options


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


def question(**overrides) -> ResumeMapQuestion:
    base = {
        "question_key": "turning_machine",
        "answer_type": "multi_select",
        "options": [
            {"option_key": "cnc_lathe", "label_text": "CNC lathe"},
            {"option_key": "surface_grinder", "label_text": "Surface grinder"},
        ],
    }
    base.update(overrides)
    return ResumeMapQuestion.model_validate(base)


class RecordingRouter:
    def __init__(self, reply: str = "{}", *, real_call: bool = True, success: bool = True):
        self.reply = reply
        self.messages: list[dict[str, str]] = []
        self.calls = 0
        self.task_types: list[str] = []
        self._meta = AICallMetadata(
            ai_call_id="00000000-0000-4000-8000-000000000000",
            task_type=RESUME_OPTION_MAP_TASK_TYPE,
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


def _body(**overrides):
    base = {
        "worker_ref": "w1",
        "storage_key": "resume-uploads/w1/abc.pdf",
        "mime": "application/pdf",
        "questions": [question()],
    }
    base.update(overrides)
    return ResumeOptionMapInput(**base)


def _pipeline(monkeypatch, router, body):
    import app.resume_import.resume_option_map as mod

    async def _fake_download(*a, **k):
        return b"%PDF-1.4 fake"

    monkeypatch.setattr(mod, "download_object", _fake_download)
    return _run(
        map_resume_options(body, settings=settings(), router=router)  # type: ignore[arg-type]
    )


def test_system_prompt_demands_verbatim_cited_ids():
    assert "COPIED VERBATIM" in RESUME_OPTION_MAP_SYSTEM_PROMPT
    assert "CITE OR OMIT" in RESUME_OPTION_MAP_SYSTEM_PROMPT
    assert "strict JSON" in RESUME_OPTION_MAP_SYSTEM_PROMPT


def test_prompt_renders_questions_and_document():
    from app.resume_import.parse_policy import MaskedLines

    masked = MaskedLines(lines=(Line(index=0, page=1, text="CNC lathe par kaam"),), dropped=0)
    msgs = build_resume_option_map_messages(masked, [question()])
    user = msgs[1]["content"]
    assert "QUESTION `turning_machine` (multi_select):" in user
    assert "- cnc_lathe: CNC lathe" in user
    assert "[0] CNC lathe par kaam" in user


def test_empty_mapping_contributes_nothing_but_stays_valid():
    out = empty_resume_option_map()
    assert out.mappings == []
    assert out.failure_reason is None


def test_verbatim_cited_mapping_survives(monkeypatch):
    import app.resume_import.resume_option_map as mod

    monkeypatch.setattr(
        mod, "extract", lambda data, mime=None: extraction("CNC lathe par 5 saal kaam")
    )
    router = RecordingRouter(
        reply='{"mappings": [{"question_key": "turning_machine", '
        '"option_keys": ["cnc_lathe"], '
        '"evidence": {"message_index": 0, "quote": "CNC lathe"}}]}'
    )
    out = _pipeline(monkeypatch, router, _body())
    assert router.task_types == [RESUME_OPTION_MAP_TASK_TYPE]
    assert len(out.mappings) == 1
    assert out.mappings[0].option_keys == ["cnc_lathe"]
    assert out.failure_reason is None


def test_invented_option_id_is_dropped_not_stored(monkeypatch):
    import app.resume_import.resume_option_map as mod

    monkeypatch.setattr(
        mod, "extract", lambda data, mime=None: extraction("CNC lathe par kaam")
    )
    router = RecordingRouter(
        reply='{"mappings": [{"question_key": "turning_machine", '
        '"option_keys": ["vmc_mill"], '
        '"evidence": {"message_index": 0, "quote": "CNC lathe"}}]}'
    )
    out = _pipeline(monkeypatch, router, _body())
    assert out.mappings == []
    assert "mappings_rejected" in out.notes


def test_single_select_with_two_ids_is_dropped_whole(monkeypatch):
    import app.resume_import.resume_option_map as mod

    monkeypatch.setattr(
        mod, "extract", lambda data, mime=None: extraction("CNC lathe aur grinder")
    )
    body = _body(
        questions=[
            question(question_key="one_machine", answer_type="single_select"),
        ]
    )
    # The mapping names the asked question but carries two ids for a single_select.
    router2 = RecordingRouter(
        reply='{"mappings": [{"question_key": "one_machine", '
        '"option_keys": ["cnc_lathe", "surface_grinder"], '
        '"evidence": {"message_index": 0, "quote": "CNC lathe"}}]}'
    )
    out = _pipeline(monkeypatch, router2, body)
    assert out.mappings == []
    assert "mappings_rejected" in out.notes


def test_uncited_mapping_is_dropped(monkeypatch):
    import app.resume_import.resume_option_map as mod

    monkeypatch.setattr(
        mod, "extract", lambda data, mime=None: extraction("CNC lathe par kaam")
    )
    router = RecordingRouter(
        reply='{"mappings": [{"question_key": "turning_machine", '
        '"option_keys": ["cnc_lathe"], '
        '"evidence": {"message_index": 0, "quote": "VMC milling centre"}}]}'
    )
    out = _pipeline(monkeypatch, router, _body())
    assert out.mappings == []
    assert "mappings_rejected" in out.notes


def test_identifier_carrying_quote_is_dropped_whole(monkeypatch):
    import app.resume_import.resume_option_map as mod

    monkeypatch.setattr(
        mod, "extract", lambda data, mime=None: extraction("Rahul 9876543210 CNC lathe")
    )
    router = RecordingRouter(
        reply='{"mappings": [{"question_key": "turning_machine", '
        '"option_keys": ["cnc_lathe"], '
        '"evidence": {"message_index": 0, "quote": "9876543210"}}]}'
    )
    out = _pipeline(monkeypatch, router, _body())
    assert out.mappings == []
    assert "mappings_rejected" in out.notes


def test_duplicate_question_keeps_first_drops_second(monkeypatch):
    import app.resume_import.resume_option_map as mod

    monkeypatch.setattr(
        mod, "extract", lambda data, mime=None: extraction("CNC lathe par kaam")
    )
    router = RecordingRouter(
        reply='{"mappings": ['
        '{"question_key": "turning_machine", "option_keys": ["cnc_lathe"], '
        '"evidence": {"message_index": 0, "quote": "CNC lathe"}}, '
        '{"question_key": "turning_machine", "option_keys": ["surface_grinder"], '
        '"evidence": {"message_index": 0, "quote": "CNC lathe"}}]}'
    )
    out = _pipeline(monkeypatch, router, _body())
    assert [m.option_keys for m in out.mappings] == [["cnc_lathe"]]
    assert "mappings_rejected" in out.notes


def test_unreadable_model_output_degrades_closed(monkeypatch):
    import app.resume_import.resume_option_map as mod

    monkeypatch.setattr(
        mod, "extract", lambda data, mime=None: extraction("CNC lathe par kaam")
    )
    router = RecordingRouter(reply="not json at all")
    out = _pipeline(monkeypatch, router, _body())
    assert out.mappings == []
    assert out.failure_reason == "parse_output_invalid"


def test_no_questions_spends_no_call(monkeypatch):
    import app.resume_import.resume_option_map as mod

    monkeypatch.setattr(
        mod, "extract", lambda data, mime=None: extraction("CNC lathe par kaam")
    )
    router = RecordingRouter(reply="{}")
    out = _pipeline(monkeypatch, router, _body(questions=[]))
    assert router.calls == 0
    assert out.mappings == []
    assert out.failure_reason is None
