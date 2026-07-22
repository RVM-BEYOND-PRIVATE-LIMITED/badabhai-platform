"""PARITY tests: the CLI must exercise the production path, not a copy of it.

These are the tests that make "parity by construction" a property instead of a
claim in a docstring. They pin:

* the REQUEST BODIES against the production callers (chat.service.ts step 3 and
  profile-extraction.processor.ts);
* the TRANSCRIPT assembly against ``buildTranscript`` — both directions, the
  ``Worker:``/``Bada Bhai:`` prefixes, the blocked message still included, the
  client-side opener excluded;
* that the interview state the CLI carries is the ENDPOINT's ``updated_state``
  verbatim (the CLI computes no state of its own);
* that a 422 body is never echoed back with the worker's text in it.
"""

from __future__ import annotations

import json
from typing import Any

from cli_harness import ScriptedRouter, drive, install_router, transport

from app.cli import trace
from app.cli.api_session import (
    ASSISTANT_PREFIX,
    EMPTY_TRANSCRIPT,
    PROFILE_EXTRACT_PATH,
    PROFILING_RESPOND_PATH,
    PSEUDONYMIZE_PATH,
    WORKER_PREFIX,
    ApiResponse,
    InterviewSession,
)
from app.cli.edge_cases import load_script


class RecordingTransport:
    """A transport that records every call and replays canned responses, so the
    request SHAPE can be asserted independently of the app."""

    label = "recording"

    def __init__(self, responses: dict[str, list[dict[str, Any]]] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self._responses = responses or {}

    def post(self, path: str, payload: dict[str, Any]) -> ApiResponse:
        self.calls.append((path, payload))
        queue = self._responses.get(path)
        body = queue.pop(0) if queue else {}
        return ApiResponse(path, 200, body)

    def get(self, path: str) -> ApiResponse:
        self.calls.append((path, {}))
        return ApiResponse(path, 200, {"status": "ok"})

    def close(self) -> None:
        return None

    def paths(self) -> list[str]:
        return [p for p, _ in self.calls]


def _turn_body(reply: str = "next question?", **overrides: Any) -> dict[str, Any]:
    body = {
        "reply_text": reply,
        "blocked": False,
        "is_mock": True,
        "asked_question_id": "machines",
        "extraction_ready": False,
        "updated_state": {
            "role_family": "cnc_vmc",
            "turn_count": 1,
            "answered_topics": ["role"],
            "asked_question_ids": ["machines"],
            "collected": {"role": "VMC Operator"},
            "clarify_count": 0,
            "ask_counts": {"machines": 1},
            "unanswered_essentials": ["machines", "experience", "current_location"],
        },
        "ai_metadata": None,
        "pseudonymization_metadata": {"blocked": False, "replaced_entities": 0},
    }
    body.update(overrides)
    return body


# --- request shape ----------------------------------------------------------


def test_turn_posts_the_production_request_body():
    """chat.service.ts step 3, field for field."""
    recorder = RecordingTransport({PROFILING_RESPOND_PATH: [_turn_body()]})
    session = InterviewSession(recorder, probe_gate=False)
    session.send("vmc operator hu")

    assert recorder.paths() == [PROFILING_RESPOND_PATH]
    _path, payload = recorder.calls[0]
    assert set(payload) == {
        "session_id",
        "worker_ref",
        "message_text",
        "history",
        "conversation_state",
        "role_family",
    }
    assert payload["message_text"] == "vmc operator hu"  # RAW: the service masks it
    assert payload["history"] == []
    assert payload["role_family"] == "cnc_vmc"


def test_gate_probe_hits_the_real_pseudonymize_endpoint():
    """The 'what would reach the LLM' line is the production ``/pseudonymize``
    route, not a local re-implementation."""
    recorder = RecordingTransport(
        {
            PSEUDONYMIZE_PATH: [
                {
                    "pseudonymized_text": "masked",
                    "blocked": False,
                    "replaced_entities": 1,
                    "placeholder_tokens": ["[CITY_1]"],
                }
            ],
            PROFILING_RESPOND_PATH: [_turn_body()],
        }
    )
    session = InterviewSession(recorder)
    turn = session.send("Pune me hu")
    assert recorder.paths() == [PSEUDONYMIZE_PATH, PROFILING_RESPOND_PATH]
    assert recorder.calls[0][1] == {"text": "Pune me hu"}
    assert turn.gate is not None and turn.gate.placeholder_tokens == ["[CITY_1]"]


def test_extraction_posts_the_processor_request_body():
    """profile-extraction.processor.ts: ``{worker_ref, transcript}`` — nothing else."""
    recorder = RecordingTransport({PROFILING_RESPOND_PATH: [_turn_body()]})
    session = InterviewSession(recorder, probe_gate=False)
    session.send("vmc operator hu")
    session.extract()

    path, payload = recorder.calls[-1]
    assert path == PROFILE_EXTRACT_PATH
    assert set(payload) == {"worker_ref", "transcript"}


def test_state_carried_forward_is_the_endpoints_own_state():
    """The CLI must not compute or repair state — it threads back exactly what the
    endpoint returned (which is what apps/api persists)."""
    body = _turn_body()
    recorder = RecordingTransport({PROFILING_RESPOND_PATH: [body, _turn_body()]})
    session = InterviewSession(recorder, probe_gate=False)
    session.send("vmc operator hu")
    assert session.state == body["updated_state"]
    session.send("5 saal")
    assert recorder.calls[1][1]["conversation_state"] == body["updated_state"]


# --- transcript assembly ----------------------------------------------------


def test_transcript_matches_build_transcript_shape(monkeypatch):
    """Both directions, in order, ``Worker:``/``Bada Bhai:`` prefixed — and the RAW
    reply (with the {{worker_name}} token), which is what apps/api stores."""
    run = drive(monkeypatch, ["vmc operator hu", "5 saal", "done"])
    lines = run.session.transcript().splitlines()

    assert lines[0].startswith(f"{WORKER_PREFIX}: ")
    assert lines[1].startswith(f"{ASSISTANT_PREFIX}: ")
    assert len(lines) == 2 * len([t for t in run.turns if t.ok])
    worker_lines = [ln for ln in lines if ln.startswith(WORKER_PREFIX)]
    assert worker_lines == ["Worker: vmc operator hu", "Worker: 5 saal"]
    # The assistant lines really are the endpoint's replies, verbatim.
    assistant = [ln.split(": ", 1)[1] for ln in lines if ln.startswith(ASSISTANT_PREFIX)]
    assert assistant == [t.reply_text for t in run.turns]


def test_the_client_side_opener_is_not_in_the_transcript(monkeypatch):
    """apps/worker-app renders ``kChatOpeningText`` locally and never posts it, so
    it is not a stored message. The CLI prints the same opener and likewise keeps it
    out of the extraction input."""
    run = drive(monkeypatch, ["vmc operator hu", "done"])
    _topic, opening = run.session.opening_question()
    assert opening in run.printed  # the worker SAW it
    assert opening not in run.session.transcript()  # ...but it was never posted


def test_a_blocked_message_is_still_in_the_transcript(monkeypatch):
    """The consequence of chat.service.ts storing the inbound row BEFORE the AI
    call: a message the gate blocks is still extraction input — and it then fails
    the whole extraction closed. Pinned because it is the most surprising piece of
    production behaviour this tool surfaces."""
    run = drive(
        monkeypatch, ["VMC operator hu", "mera ref number 12345678 hai", "done"], extract=True
    )
    assert run.turns[1].blocked
    assert "12345678" in run.session.transcript()
    assert run.extraction.blocked is True
    assert run.extraction.status == "blocked"


def test_empty_transcript_uses_the_production_placeholder():
    session = InterviewSession(RecordingTransport(), probe_gate=False)
    assert session.transcript() == EMPTY_TRANSCRIPT


# --- failure surfaces -------------------------------------------------------


def test_validation_errors_never_echo_the_workers_text():
    """§2 hygiene: a FastAPI 422 body carries ``input`` (the offending value = the
    worker's message) and ``ctx``. The CLI reduces it to loc/msg/type."""
    response = ApiResponse(
        PROFILING_RESPOND_PATH,
        422,
        {
            "detail": [
                {
                    "type": "string_too_short",
                    "loc": ["body", "message_text"],
                    "msg": "String should have at least 1 character",
                    "input": "mera number 9876543210",
                    "ctx": {"min_length": 1},
                }
            ]
        },
    )
    errors = response.validation_errors()
    assert errors == [
        {
            "loc": ["body", "message_text"],
            "msg": "String should have at least 1 character",
            "type": "string_too_short",
        }
    ]
    assert "9876543210" not in json.dumps(errors)


def test_a_rejected_request_stores_nothing_and_does_not_advance(monkeypatch):
    """A 422 turn: no transcript rows, no state change. (In production apps/api
    rejects an empty message at its own boundary with 400, so nothing is stored
    there either.)"""
    install_router(monkeypatch, ScriptedRouter())
    session = InterviewSession(transport())
    turn = session.send("")
    assert turn.response.status_code == 422
    assert session.rows == []
    assert session.state is None
    rendered = trace.render_turn(turn)
    assert "HTTP" in rendered and "422" in rendered
    assert "mera" not in rendered


def test_trace_shows_the_gate_and_the_engine_decision(monkeypatch):
    """The trace must show the §2 gate working and WHY a topic closed — that is the
    whole point of the tool."""
    run = drive(monkeypatch, ["abhi Pune mein hu", "matlab kya?", "done"])
    rendered = "\n".join(
        trace.render_turn(t, real_calls_blocked="AI_ENABLE_REAL_CALLS is false")
        for t in run.turns
    )
    assert "[CITY_1]" in rendered  # what would reach the model
    assert "ADVANCE" in rendered and "CLARIFY" in rendered
    assert "detected" in rendered and "collected" in rendered
    assert "must-ask" in rendered and "essentials" in rendered
    assert "MOCK" in rendered  # never let mock output read as model output
    assert "Pune" not in rendered.split("-> to LLM")[1].split("\n")[0]


def test_trace_labels_the_cli_only_merge_view(monkeypatch):
    """The merged view must be printed SEPARATELY and labelled — production never
    produces it (``merge_collected`` has no caller in app/ outside this CLI)."""
    run = drive(monkeypatch, ["vmc operator hu", "5 saal", "done"], extract=True)
    rendered = trace.render_cli_only_merge(run.extraction, run.collected)
    assert "PRODUCTION DOES NOT PRODUCE THIS" in rendered


# --- script loading ---------------------------------------------------------


def test_load_script_reads_lines_and_skips_comments(tmp_path):
    path = tmp_path / "s.txt"
    path.write_text("# a comment\n\nvmc operator hu\n5 saal\n", encoding="utf-8")
    assert load_script(str(path)) == ["vmc operator hu", "5 saal"]


def test_load_script_accepts_json(tmp_path):
    path = tmp_path / "s.json"
    path.write_text('["vmc operator hu", "5 saal"]', encoding="utf-8")
    assert load_script(str(path)) == ["vmc operator hu", "5 saal"]
