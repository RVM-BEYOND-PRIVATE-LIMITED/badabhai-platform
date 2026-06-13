"""Onboarding CLI tests — drive the MODEL-driven loop with scripted stdin and a
stubbed router; NO network.

The interview is now driven by the model: the router is stubbed to return scripted
``{"message": ..., "ready_to_extract": ...}`` JSON for each ``profiling_chat_turn``
and a final profile for ``profile_extraction``. We assert:
- the loop ENDS when the stubbed model returns ``ready_to_extract=true`` (and on
  the worker typing ``done``);
- the worker's typed NAME appears in the resume JSON but in NO message ever handed
  to the router (the router records every message, even pseudonymized);
- a resume JSON + a ``=== COST & METADATA ===`` panel are produced;
- a pseudonymization-block turn is handled gracefully (re-prompt, and NO model call
  is made for that blocked text).
"""

import asyncio
import json

from app.cli import onboarding_chat
from app.config import Settings
from app.contracts import AICallMetadata


def _meta(task_type: str, *, real_call: bool = False, provider: str = "google") -> AICallMetadata:
    return AICallMetadata(
        ai_call_id="test",
        task_type=task_type,
        model_name="gemini-2.5-flash" if provider == "google" else "claude-haiku-4-5",
        provider=provider,
        real_call=real_call,
        input_tokens=1,
        output_tokens=1,
        estimated_cost_inr=0.0,
        latency_ms=1,
        success=True,
        created_at="2026-06-13T00:00:00Z",
    )


def _chat_json(message: str, ready: bool) -> str:
    return json.dumps({"message": message, "ready_to_extract": ready}, ensure_ascii=False)


class _ScriptedRouter:
    """Stand-in for AIRouter. Records every message handed to it and returns
    scripted chat-turn JSON (in order), and a fixed mock for extraction.

    ``chat_scripts`` is an ordered list of ``(message, ready_to_extract)`` tuples
    consumed one per ``profiling_chat_turn`` call. When exhausted it falls back to
    the caller's ``mock_response`` (so over-running turns still parse)."""

    def __init__(self, chat_scripts=None, *, real_call=False, provider="google"):
        self.calls: list[dict] = []
        self._chat_scripts = list(chat_scripts or [])
        self._chat_idx = 0
        self._real_call = real_call
        self._provider = provider

    async def run(self, task_type, *, messages, mock_response, real_call_allowed=True):
        self.calls.append({"task_type": task_type, "messages": messages})
        if task_type == "profiling_chat_turn" and self._chat_idx < len(self._chat_scripts):
            message, ready = self._chat_scripts[self._chat_idx]
            self._chat_idx += 1
            content = _chat_json(message, ready)
        else:
            # Extraction (or chat overrun): return the caller's deterministic mock.
            content = mock_response
        return content, _meta(task_type, real_call=self._real_call, provider=self._provider)

    def all_message_text(self) -> str:
        """Concatenate every message content ever handed to the router."""
        parts: list[str] = []
        for call in self.calls:
            for msg in call["messages"]:
                parts.append(msg.get("content", ""))
        return "\n".join(parts)

    def chat_turn_count(self) -> int:
        return sum(1 for c in self.calls if c["task_type"] == "profiling_chat_turn")


def _scripted_input(answers):
    it = iter(answers)

    def _input(_prompt=""):
        return next(it)

    return _input


def _run(coro):
    return asyncio.run(coro)


def test_loop_ends_when_model_signals_ready_to_extract():
    """The MODEL drives the loop: when it returns ready_to_extract=true we stop and
    extract, even though more stdin answers remain available."""
    router = _ScriptedRouter(
        chat_scripts=[
            ("Achha! Kaunsi machine pe kaam kiya hai?", False),
            ("Badhiya bhai, itni jaankari kaafi hai.", True),  # model ends the loop
        ]
    )
    answers = [
        "Ramesh Kumar",          # NAME (must never reach the model)
        "VMC operator hoon",     # turn 1 answer
        "Haas aur Mazak",        # turn 2 answer -> model says ready
        "extra never read",      # should NOT be consumed (loop ended)
        "done",
    ]
    resume, calls = _run(
        onboarding_chat._run_chat(
            router, input_fn=_scripted_input(answers), print_fn=lambda *_a, **_k: None
        )
    )

    # The loop ended after exactly 2 chat turns (the second set ready_to_extract).
    assert router.chat_turn_count() == 2
    # Resume produced with extracted fields + the locally-typed name.
    assert resume["name"] == "Ramesh Kumar"
    assert resume["primary_role"] is not None
    assert "availability" in resume
    # The final extraction call's meta is collected for the cost panel.
    assert any(c.task_type == "profile_extraction" for c in calls)


def test_loop_ends_on_done():
    """Typing 'done' ends the loop even if the model never sets ready_to_extract."""
    router = _ScriptedRouter(
        chat_scripts=[("Aur batao bhai, kitne saal ka experience hai?", False)]
    )
    answers = [
        "Suresh",                # NAME
        "CNC turning operator",  # one real answer
        "done",                  # ends the loop
    ]
    resume, calls = _run(
        onboarding_chat._run_chat(
            router, input_fn=_scripted_input(answers), print_fn=lambda *_a, **_k: None
        )
    )

    assert router.chat_turn_count() == 1
    assert resume["name"] == "Suresh"
    assert any(c.task_type == "profile_extraction" for c in calls)


def test_name_never_passed_into_any_router_call():
    router = _ScriptedRouter(
        chat_scripts=[
            ("Achha! Fanuc ya Siemens controller chalaya hai?", False),
            ("Theek hai bhai, profile bana dete hain.", True),
        ]
    )
    answers = [
        "Suresh",                # NAME
        "CNC turning operator",  # role
        "Fanuc machine, 5 saal",  # machines / controller / experience
        "done",
    ]
    resume, _calls = _run(
        onboarding_chat._run_chat(
            router, input_fn=_scripted_input(answers), print_fn=lambda *_a, **_k: None
        )
    )

    assert resume["name"] == "Suresh"
    # The name string must appear in NO message ever sent to the router/model,
    # not even pseudonymized. The router recorded every message it received.
    assert router.calls, "expected the router to have been called"
    assert "Suresh" not in router.all_message_text()


def test_pseudonymization_block_turn_is_handled_gracefully(monkeypatch):
    """A turn whose answer pseudonymization BLOCKS must NOT reach the model: we
    re-prompt and consume no chat turn against the model for that blocked text. A
    following clean answer proceeds normally."""
    router = _ScriptedRouter(
        chat_scripts=[("Badhiya! Profile ready hai.", True)]
    )

    real_pseudonymize = onboarding_chat.pseudonymize

    class _Blocked:
        text = ""
        blocked = True
        blocked_reason = "residual numeric sequence detected"

    def _selective(text, *args, **kwargs):
        # Block ONLY the answer that contains a phone-like run; everything else
        # (including the final transcript) pseudonymizes normally.
        if "99999" in text:
            return _Blocked()
        return real_pseudonymize(text, *args, **kwargs)

    monkeypatch.setattr(onboarding_chat, "pseudonymize", _selective)

    answers = [
        "Mahesh",                          # NAME
        "call me on 9999900000",           # BLOCKED -> re-prompt, no model call
        "VMC operator, Pune, 4 saal",      # clean -> model call, then ready
        "done",
    ]
    resume, calls = _run(
        onboarding_chat._run_chat(
            router, input_fn=_scripted_input(answers), print_fn=lambda *_a, **_k: None
        )
    )

    # Only ONE chat turn reached the model (the blocked answer did not).
    assert router.chat_turn_count() == 1
    # The blocked phone string never reached the router in any form.
    assert "9999900000" not in router.all_message_text()
    # Graceful: resume still returned with the name preserved.
    assert resume["name"] == "Mahesh"
    assert any(c.task_type == "profile_extraction" for c in calls)


def test_full_block_returns_resume_without_extraction(monkeypatch):
    """If the accumulated transcript pseudonymization blocks, NO profile_extraction
    call is made and we still return a resume with the name (fail-closed)."""
    router = _ScriptedRouter()

    class _Blocked:
        text = ""
        blocked = True
        blocked_reason = "residual numeric sequence detected"

    monkeypatch.setattr(onboarding_chat, "pseudonymize", lambda *_a, **_k: _Blocked())

    answers = ["Mahesh", "operator", "done"]
    resume, calls = _run(
        onboarding_chat._run_chat(
            router, input_fn=_scripted_input(answers), print_fn=lambda *_a, **_k: None
        )
    )

    # Every per-turn answer blocked too, so NO model call (chat or extraction) ran.
    assert resume["name"] == "Mahesh"
    assert all(c["task_type"] != "profile_extraction" for c in router.calls)
    assert all(c.task_type != "profile_extraction" for c in calls)


def test_main_uses_real_router_in_mock_mode_without_network(monkeypatch, capsys):
    """Smoke test of main(): scripted stdin, default mock settings -> prints a
    resume JSON banner + the cost panel. Uses the REAL AIRouter but stays mock."""
    answers = ["Geeta", "vmc operator", "haas, 3 saal, pune", "done"]
    monkeypatch.setattr("builtins.input", _scripted_input(answers))
    monkeypatch.setattr(
        onboarding_chat, "get_settings", lambda: Settings(ai_enable_real_calls=False)
    )

    onboarding_chat.main()
    out = capsys.readouterr().out
    assert "=== RESUME (JSON) ===" in out
    assert "Geeta" in out
    assert "=== COST & METADATA ===" in out


def test_offline_fallback_note_printed_when_not_real():
    """VISIBILITY: when a chat turn is served by the offline mock (real_call False),
    the worker is told via an inline note. The panel stays authoritative."""
    printed: list[str] = []

    router = _ScriptedRouter(
        chat_scripts=[("Theek hai bhai, ready.", True)], real_call=False
    )
    answers = ["Geeta", "vmc operator, pune, 3 saal", "done"]
    _run(
        onboarding_chat._run_chat(
            router,
            input_fn=_scripted_input(answers),
            print_fn=lambda *a, **_k: printed.append(" ".join(str(x) for x in a)),
        )
    )
    joined = "\n".join(printed)
    assert "model unavailable" in joined


def test_haiku_fallback_note_printed_when_anthropic():
    """VISIBILITY: a turn served by the Claude Haiku fallback (provider anthropic)
    surfaces a clear note to the worker."""
    printed: list[str] = []

    router = _ScriptedRouter(
        chat_scripts=[("Theek hai bhai, ready.", True)],
        real_call=True,
        provider="anthropic",
    )
    answers = ["Geeta", "vmc operator, pune, 3 saal", "done"]
    _run(
        onboarding_chat._run_chat(
            router,
            input_fn=_scripted_input(answers),
            print_fn=lambda *a, **_k: printed.append(" ".join(str(x) for x in a)),
        )
    )
    joined = "\n".join(printed)
    assert "Claude Haiku fallback" in joined


def test_cost_panel_renders_summary_and_per_call_rows_without_pii():
    """The panel shows a cost line and at least one per-call row, and contains
    NONE of the worker name or transcript text (it sees only AICallMetadata)."""
    router = _ScriptedRouter(
        chat_scripts=[("Achha! Aur batao.", False), ("Ready bhai.", True)]
    )
    name = "Lakshmi"
    transcript_token = "Mazak"  # a distinctive word from an answer below
    answers = [
        name,                                  # NAME (must never reach the panel)
        "VMC operator hoon",                   # role
        f"Haas aur {transcript_token}, 6 saal, Pune",  # machines (transcript token)
        "done",
    ]
    resume, calls = _run(
        onboarding_chat._run_chat(
            router, input_fn=_scripted_input(answers), print_fn=lambda *_a, **_k: None
        )
    )

    assert resume["name"] == name
    assert calls, "expected at least one collected router call"

    panel = onboarding_chat.render_cost_metadata(calls)

    assert panel.splitlines()[0] == "=== COST & METADATA ==="
    assert "Rs " in panel
    assert "PER-CALL" in panel
    assert "1. " in panel

    # PRIVACY: neither the name nor any transcript token leaks into the panel.
    assert name not in panel
    assert transcript_token not in panel


def test_cost_panel_empty_calls_shows_no_model_calls_note():
    panel = onboarding_chat.render_cost_metadata([])
    assert panel.splitlines()[0] == "=== COST & METADATA ==="
    assert "(no model calls were made)" in panel
    assert "PER-CALL" not in panel


def test_lenient_json_parse_tolerates_wrapping_prose():
    """The chat-turn parser extracts the JSON object even with stray text/fences
    around it (some models wrap their output)."""
    wrapped = 'Sure! ```json\n{"message": "Aur batao bhai?", "ready_to_extract": false}\n``` ok'
    data = onboarding_chat._parse_chat_json(wrapped)
    assert data["message"] == "Aur batao bhai?"
    assert data["ready_to_extract"] is False

    # Garbage in -> safe, non-crashing default (never fail-open).
    fallback = onboarding_chat._parse_chat_json("not json at all")
    assert fallback["ready_to_extract"] is False
