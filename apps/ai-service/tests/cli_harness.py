"""Shared harness for the onboarding-CLI tests.

The CLI now drives the REAL FastAPI app (``POST /profiling/respond`` /
``/profile/extract``), so the tests must too — otherwise they would assert against
a path the tool no longer takes. The injection point therefore MOVED: instead of
handing the CLI a fake router, we replace ``app.main.router`` (the module-level
``AIRouter`` the endpoints call) with :class:`ScriptedRouter`.

That is strictly stronger than before. Every "what crossed the LLM boundary"
assertion is now made about what the PRODUCTION ENDPOINT handed the router, not
about what a parallel CLI loop handed a fake.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.cli.api_session import ExtractResult, InProcessTransport, InterviewSession, TurnResult
from app.cli.onboarding_chat import run_interview
from app.config import Settings
from app.contracts import AICallMetadata

_TRANSPORT: InProcessTransport | None = None


def transport() -> InProcessTransport:
    """One in-process ASGI client for the whole test session (cheap to reuse; the
    lifespan is entered once)."""
    global _TRANSPORT
    if _TRANSPORT is None:
        _TRANSPORT = InProcessTransport()
    return _TRANSPORT


def meta(
    task_type: str,
    *,
    real_call: bool = False,
    provider: str = "google",
    error_code: str | None = None,
) -> AICallMetadata:
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
        error_code=error_code,
        created_at="2026-06-13T00:00:00Z",
    )


class ScriptedRouter:
    """Stand-in for ``AIRouter`` mirroring its MOCK path: it returns the caller's
    ``mock_response`` verbatim (which, on the engine-driven path, IS the engine's
    chosen question) and records every message it was handed.

    Installed over ``app.main.router``, so it sees exactly what the ENDPOINT sends.
    ``user_ref`` is accepted because the endpoints pass it (per-user spend
    attribution) — a signature drift here should fail loudly, not silently.
    """

    def __init__(self, *, real_call=False, provider="google", extraction_content=None):
        self.calls: list[dict] = []
        self._real_call = real_call
        self._provider = provider
        self._extraction_content = extraction_content

    async def run(
        self, task_type, *, messages, mock_response, real_call_allowed=True, user_ref=None
    ):
        self.calls.append(
            {
                "task_type": task_type,
                "messages": messages,
                "mock_response": mock_response,
                "real_call_allowed": real_call_allowed,
                "user_ref": user_ref,
            }
        )
        content = mock_response
        if task_type == "profile_extraction" and self._extraction_content is not None:
            content = self._extraction_content
        return content, meta(task_type, real_call=self._real_call, provider=self._provider)

    # --- inspection helpers ---
    def all_message_text(self) -> str:
        parts: list[str] = []
        for call in self.calls:
            for msg in call["messages"]:
                parts.append(msg.get("content", ""))
        return "\n".join(parts)

    def chat_calls(self) -> list[dict]:
        return [c for c in self.calls if c["task_type"] == "profiling_chat_turn"]

    def chat_turn_count(self) -> int:
        return len(self.chat_calls())


@dataclass
class Run:
    session: InterviewSession
    turns: list[TurnResult]
    printed_lines: list[str] = field(default_factory=list)
    router: ScriptedRouter | None = None
    extraction: ExtractResult | None = None

    @property
    def printed(self) -> str:
        return "\n".join(self.printed_lines)

    @property
    def state(self) -> dict[str, Any]:
        return self.session.state or {}

    @property
    def collected(self) -> dict[str, Any]:
        return self.state.get("collected") or {}


def install_router(monkeypatch, router: ScriptedRouter) -> ScriptedRouter:
    import app.main as main_module

    monkeypatch.setattr(main_module, "router", router)
    return router


def install_settings(monkeypatch, settings: Settings) -> None:
    """Replace the endpoint's module-level settings (e.g. to turn the COST-4
    rephrase flag on)."""
    import app.main as main_module

    monkeypatch.setattr(main_module, "settings", settings)


def drive(
    monkeypatch,
    answers: list[str],
    *,
    name: str | None = "Suresh",
    router: ScriptedRouter | None = None,
    settings: Settings | None = None,
    extract: bool = False,
    quiet: bool = False,
    verbose: bool = False,
) -> Run:
    """Run a scripted interview through the real endpoints."""
    router = install_router(monkeypatch, router or ScriptedRouter())
    if settings is not None:
        install_settings(monkeypatch, settings)
    session = InterviewSession(transport())
    printed: list[str] = []

    def _print(*args, **_kwargs):
        printed.append(" ".join(str(a) for a in args))

    it = iter(answers)

    def _input(_prompt=""):
        return next(it)

    turns = run_interview(
        session,
        input_fn=_input,
        print_fn=_print,
        name=name,
        quiet=quiet,
        verbose=verbose,
    )
    run = Run(session=session, turns=turns, printed_lines=printed, router=router)
    if extract:
        run.extraction = session.extract()
    return run


def adaptive_drive(
    monkeypatch,
    answer_for,
    *,
    name: str = "Suresh",
    default: str = "haan",
    max_turns: int = 40,
    router: ScriptedRouter | None = None,
    extract: bool = False,
) -> Run:
    """Drive the interview answering whatever the ENGINE just asked.

    The topic in play is read off the ENDPOINT's ``asked_question_id`` (the
    authoritative signal), seeded with the engine's opening topic — the CLI opens
    with ``first_question`` exactly as apps/worker-app does, so the first worker
    message answers a real question.
    """
    from app.profiling import interview_engine

    router = install_router(monkeypatch, router or ScriptedRouter())
    session = InterviewSession(transport())
    printed: list[str] = []
    opening_topic = interview_engine.first_question("cnc_vmc")[0]

    def _print(*args, **_kwargs):
        printed.append(" ".join(str(a) for a in args))

    def _topic() -> str | None:
        if not session.turns:
            return opening_topic
        return session.turns[-1].asked_question_id

    def _input(_prompt=""):
        answer = answer_for(_topic())
        return answer if answer is not None else default

    turns = run_interview(
        session, input_fn=_input, print_fn=_print, name=name, max_turns=max_turns
    )
    run = Run(session=session, turns=turns, printed_lines=printed, router=router)
    if extract:
        run.extraction = session.extract()
    return run


def asked_order(run: Run) -> list[str]:
    """The topic ids the ENGINE actually served, in order (wrap-up excluded)."""
    return [t.asked_question_id for t in run.turns if t.asked_question_id]
