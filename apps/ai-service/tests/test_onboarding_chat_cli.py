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


# --- _startup_status banner: the up-front readiness diagnosis ----------------
# Explicit Settings(...) kwargs override conftest's os.environ blanks (pydantic
# precedence: init kwargs > env > .env), so these pin the exact gate state.

def test_startup_status_off_when_master_flag_false():
    banner = onboarding_chat._startup_status(Settings(ai_enable_real_calls=False))
    assert "OFF" in banner
    assert "AI_ENABLE_REAL_CALLS" in banner


def test_startup_status_off_when_no_gemini_key_warns_about_shell_override():
    # Master flag on but no key -> OFF; the banner must call out the sneaky
    # shell-env-overrides-.env failure mode that caused the silent all-mock run.
    banner = onboarding_chat._startup_status(
        Settings(ai_enable_real_calls=True, gemini_flash_api_key="")
    )
    assert "OFF" in banner
    assert "GEMINI_FLASH_API_KEY" in banner
    assert "OVERRIDES" in banner  # the shell-env-precedence warning


def test_startup_status_on_with_anthropic_fallback():
    banner = onboarding_chat._startup_status(
        Settings(
            ai_enable_real_calls=True,
            gemini_flash_api_key="k",
            anthropic_api_key="a",
            ai_real_call_tasks="profiling_chat_turn,profile_extraction",
        )
    )
    assert "ON" in banner
    assert "(google)" in banner
    assert "claude-haiku-4-5 (anthropic)" in banner
    assert "WARNING" not in banner


def test_startup_status_on_without_anthropic_key_shows_no_fallback():
    banner = onboarding_chat._startup_status(
        Settings(
            ai_enable_real_calls=True,
            gemini_flash_api_key="k",
            anthropic_api_key="",
            ai_real_call_tasks="",
        )
    )
    assert "ON" in banner
    assert "fallback: none" in banner


def test_startup_status_haiku_primary_gemini_fallback_labels():
    # Provider labels are DERIVED from the model ids, so a swapped config (Haiku
    # primary, Gemini fallback) is labelled correctly — not hardcoded.
    banner = onboarding_chat._startup_status(
        Settings(
            ai_enable_real_calls=True,
            gemini_flash_api_key="k",
            anthropic_api_key="a",
            default_cheap_model="claude-haiku-4-5",
            default_capable_model="claude-haiku-4-5",
            default_fallback_model="gemini-2.5-flash-lite",
            ai_real_call_tasks="profiling_chat_turn,profile_extraction",
        )
    )
    assert "primary : claude-haiku-4-5 (anthropic)" in banner
    assert "fallback: gemini-2.5-flash-lite (google)" in banner


def test_startup_status_on_but_chat_not_allowlisted_warns():
    banner = onboarding_chat._startup_status(
        Settings(
            ai_enable_real_calls=True,
            gemini_flash_api_key="k",
            ai_real_call_tasks="profile_extraction",  # chat NOT allowlisted
        )
    )
    assert "ON" in banner
    assert "WARNING" in banner
    assert "profiling_chat_turn" in banner


class _ScriptedRouter:
    """Stand-in for AIRouter. Records every message handed to it and returns
    scripted chat-turn JSON (in order), and a fixed mock for extraction.

    ``chat_scripts`` is an ordered list of ``(message, ready_to_extract)`` tuples
    consumed one per ``profiling_chat_turn`` call. When exhausted it falls back to
    the caller's ``mock_response`` (so over-running turns still parse)."""

    def __init__(
        self, chat_scripts=None, *, real_call=False, provider="google",
        extraction_content=None,
    ):
        self.calls: list[dict] = []
        self._chat_scripts = list(chat_scripts or [])
        self._chat_idx = 0
        self._real_call = real_call
        self._provider = provider
        # Optional: a custom profile_extraction payload (e.g. one carrying a
        # canonical_role_id) returned instead of the caller's mock_response.
        self._extraction_content = extraction_content

    async def run(self, task_type, *, messages, mock_response, real_call_allowed=True):
        self.calls.append({"task_type": task_type, "messages": messages})
        if task_type == "profiling_chat_turn" and self._chat_idx < len(self._chat_scripts):
            message, ready = self._chat_scripts[self._chat_idx]
            self._chat_idx += 1
            content = _chat_json(message, ready)
        elif task_type == "profile_extraction" and self._extraction_content is not None:
            content = self._extraction_content
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


def _silent(*_a, **_k):
    return None


def test_wants_to_close_detects_closing_and_ignores_ambiguous():
    # Clear closing intents -> True.
    for ans in ["bas itna hi", "ho gaya bhai", "naukri laga do ab", "that's all",
                "ab aur nahi batana", "I am done"]:
        assert onboarding_chat._wants_to_close(ans) is True, ans
    # Ambiguous / substantive answers must NOT trip it (no premature close).
    for ans in ["abhi kuch nahi karta", "bas 2 saal kiya hai VMC pe",
                "VMC operator hoon Pune me"]:
        assert onboarding_chat._wants_to_close(ans) is False, ans


def test_fallback_message_uses_model_prose_not_canned():
    # Prose reply (model ignored JSON) -> show its OWN words, not a canned line.
    assert onboarding_chat._fallback_message("Aur batao bhai, kaunsi machine?") == (
        "Aur batao bhai, kaunsi machine?"
    )
    # A ```json fenced object with no usable message -> the closing-oriented nudge.
    nudge = onboarding_chat._fallback_message('```json\n{"foo": 1}\n```')
    assert "done" in nudge
    # Empty -> nudge (never an empty line).
    assert onboarding_chat._fallback_message("") .strip() != ""


def test_loop_breaks_when_worker_signals_close():
    # The MODEL never sets ready, but the worker says "bas itna hi" -> the CLI's
    # safety net ends the interview (no endless re-asking).
    router = _ScriptedRouter(
        chat_scripts=[("Achha, aur kya kaam?", False), ("Theek hai, aur batao?", False)]
    )
    answers = ["Suresh", "vmc operator hu", "bas itna hi", "NEVER READ", "done"]
    _run(onboarding_chat._run_chat(router, input_fn=_scripted_input(answers), print_fn=_silent))
    assert router.chat_turn_count() == 2  # closed right after the closing answer


def test_loop_breaks_on_repeated_question():
    # If the bot repeats its previous line (a stall), the loop stops instead of
    # looping on the same question forever.
    router = _ScriptedRouter(
        chat_scripts=[("Aur batao bhai.", False), ("Aur batao bhai.", False),
                      ("Aur batao bhai.", False)]
    )
    answers = ["Suresh", "machine chalata hu", "haan", "theek hai", "done"]
    _run(onboarding_chat._run_chat(router, input_fn=_scripted_input(answers), print_fn=_silent))
    assert router.chat_turn_count() == 2  # second identical line ends it


def test_cli_extraction_canonicalizes_role_to_closed_set():
    # Parity with the production endpoint: a valid canonical_role_id from the model
    # maps the resume role/trade onto the closed 7-role taxonomy, even when the
    # keyword heuristic found nothing (bare "cnc").
    # Wrapped in a ```json fence on purpose — Claude often does this, and the CLI
    # must still parse it (regression guard for the silent-empty-resume bug).
    extraction = "```json\n" + json.dumps({
        "canonical_role_id": "role_vmc_operator",
        "primary_role": "VMC Operator",
        "experience_years": 1.5,
        "machines": ["VMC"],
    }) + "\n```"
    router = _ScriptedRouter(
        chat_scripts=[("Achha, samajh gaya.", True)],
        real_call=True, provider="anthropic",
        extraction_content=extraction,
    )
    answers = ["Suresh", "cnc machine chalayi dedh saal", "done"]
    resume, _calls = _run(
        onboarding_chat._run_chat(router, input_fn=_scripted_input(answers), print_fn=_silent)
    )
    assert resume["role"] == "role_vmc_operator"
    assert resume["trade"] == "dom_vmc_machining"  # derived from ROLE_TRADE
    assert resume["experience_years"] == 1.5
    assert "VMC" in resume["machines"]
    assert "skill_ids" in resume  # taxonomy skill ids surfaced


def test_invalid_canonical_role_id_is_rejected_keeps_heuristic():
    # A hallucinated role id must NOT reach the resume (trust boundary).
    extraction = json.dumps({"canonical_role_id": "role_made_up", "primary_role": "X"})
    router = _ScriptedRouter(
        chat_scripts=[("ok", True)], real_call=True, provider="anthropic",
        extraction_content=extraction,
    )
    answers = ["Suresh", "kuch khaas nahi", "done"]
    resume, _calls = _run(
        onboarding_chat._run_chat(router, input_fn=_scripted_input(answers), print_fn=_silent)
    )
    assert resume["role"] != "role_made_up"  # rejected; heuristic (likely null) stands


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


def test_provider_note_names_claude_haiku_when_anthropic_serves():
    """VISIBILITY: a turn served by Claude Haiku (provider anthropic) surfaces a
    clear note. Worded neutrally (not 'fallback'), since Haiku may be the primary."""
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
    assert "served by Claude Haiku" in joined
    assert "fallback" not in joined  # Haiku is not labelled a fallback anymore


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
