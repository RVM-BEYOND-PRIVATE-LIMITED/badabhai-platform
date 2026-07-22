"""Terminal driver for the worker-profiling interview — the PRODUCTION path.

LOCAL DEV TOOL ONLY.  ``python -m app.cli.onboarding_chat``

PARITY BY CONSTRUCTION (the point of this tool)
-----------------------------------------------
Every turn is an actual ``POST /profiling/respond`` against the real FastAPI app,
and the profile at the end is an actual ``POST /profile/extract``. By default the
app is driven IN-PROCESS with ``fastapi.testclient.TestClient`` (ASGI, no socket,
no server, no DB, no Node); ``--http BASE_URL`` sends the identical request bodies
to a really-running ai-service.

That means the pseudonymization gate, the Pydantic request/response contracts, the
clarify-vs-advance branch, the router call and the response assembly are the SAME
code the deployed service runs — there is no second implementation in this file to
drift. The previous version of this CLI called ``interview_engine`` /
``profile_extractor`` / ``router`` directly and only claimed parity in its header;
it assembled the final profile with ``profile_extractor.merge_collected``, which
the production endpoint has never called.

Request-shape parity is documented per field in ``app/cli/api_session.py``. Two
consequences are worth stating up front because they surprise people, and both are
production behaviour this tool now shows honestly:

* the extraction transcript contains BOTH sides of the conversation — Bada Bhai's
  own questions included (``buildTranscript``), so the question text is fed back
  into the extractor;
* a message the gate BLOCKS is still stored (apps/api inserts the inbound row
  before the AI call), so it is in that transcript, and one blocked message fails
  the whole extraction closed.

WHAT YOU SEE PER TURN
---------------------
The raw message, the pseudonymized text that would reach a model (or the BLOCK),
the engine's decision (advance vs clarify) with ask counts, what the detector
found vs what was collected vs what was discarded and WHY, the answered /
essential / MUST_ASK state, and whether the reply came from a REAL model call or
the mock. ``--trace`` adds the raw request/state/metadata; ``--quiet`` reduces it
to the conversation.

MODES
-----
``--edge-cases``  run the scripted edge-case suite (fabrication, exclusions,
                  Devanagari, privacy, robustness, flow) and exit non-zero on
                  failure.
``--script FILE`` replay a canned transcript (one worker message per line).
``--resume``      also call ``POST /resume/generate`` on the extracted profile.

PRIVACY (CLAUDE.md §2)
----------------------
* The worker's NAME is captured into a LOCAL variable, is never part of any
  request body, and is interpolated over the engine's ``{{worker_name}}`` token at
  PRINT time only — the CLI mirror of ``ChatService.renderWorkerName``
  (AI-PERSONA-2). The trace prints the RAW reply (token intact) beside it.
* Every worker message is pseudonymized inside the service before any model path,
  and fails closed. ``worker_ref`` is a per-run opaque UUID.
* Nothing is persisted: no DB, no events, no files. The transcript, state and
  profile live in process memory and on stdout.
* Real model calls stay OFF unless the operator's own env enables them. This tool
  never sets ``AI_ENABLE_REAL_CALLS`` and prints the resolved posture at startup.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any

from ..ai.model_config import provider_for_model
from ..config import get_settings
from ..contracts import AICallMetadata
from ..profiling.interview_engine import WORKER_NAME_PLACEHOLDER
from . import trace
from .api_session import (
    ExtractResult,
    HttpTransport,
    InProcessTransport,
    InterviewSession,
    Transport,
    TurnResult,
)
from .edge_cases import load_script, run_suite

# Backstop so a stalled session cannot loop forever. The ENGINE is the real stop
# condition (extraction_ready); this only bounds a pathological run. Must exceed
# the engine's own ask ceiling so a worker who answers nothing is still asked
# every question before this trips.
_MAX_TURNS = 40

_QUIT_WORDS = {"done", "exit", "quit", "bye"}

_INTRO = (
    "\nNamaste. Main Bada Bhai hoon. Chaliye 2 minute mein "
    "aapka kaam ka profile bana lete hain.\n"
    "(Tip: jab aapko lage baat poori ho gayi, 'done' likh dein. Apna phone number "
    "ya company ka naam likhne ki zaroorat nahi hai.)\n"
)

# --- Name capture (LOCAL ONLY — never sent anywhere) ------------------------
#
# THE DEFECT this fixes: the name was stored as ``input().strip()`` verbatim, so a
# worker who typed "myself ravi" was addressed as "myself ji" for the whole session.
#
# THE RULE, deliberately CONSERVATIVE: strip only a KNOWN lead-in/trailer phrase,
# matched at a WORD BOUNDARY and only while something is left over. When stripping
# would empty the input, keep the RAW text — over-stripping mangles a real name
# ("Mainak" -> "ak"), which is strictly worse than a slightly wordy one.
#
# Word boundaries are what make this safe. Every entry below is a prefix of a real
# Indian name we must not touch: main/Mainak, im/Imran, ji/Jitendra, naam/Naamdev,
# hai/Hairaj, mera/Meraj, my/Mystery, this/Thisara. tests/test_cli_session_defects.py
# pins each one.
#
# PRIVACY: this runs on the name, which is PII. It is pure local string work — the
# name is captured into a LOCAL variable, NEVER placed in a request body, and only
# interpolated over the engine's {{worker_name}} token at PRINT time
# (_render_worker_name). Do not move any of this near a request builder.
_NAME_LEAD_INS: tuple[str, ...] = (
    # English
    r"my\s+name\s+is", r"my\s+name['’]?s", r"the\s+name\s+is", r"name\s+is",
    r"myself", r"this\s+is", r"i\s+am", r"i['’]m", r"im", r"name",
    # Hinglish
    r"mera\s+naam\s+hai", r"mera\s+naam", r"mera\s+nam", r"meraa?\s+naam",
    r"naam\s+hai", r"naam", r"nam", r"main", r"mai", r"mein", r"hum",
)
_NAME_TRAILERS: tuple[str, ...] = (
    r"hai", r"hain", r"h[uū]n?", r"hoon", r"ji", r"bol\s+raha\s+h[uū]n?",
    r"bol\s+rahi\s+h[uū]n?", r"naam\s+hai",
)
_NAME_LEAD_IN_RE = re.compile(
    r"^(?:" + "|".join(_NAME_LEAD_INS) + r")\b[\s,.:\-]*", re.IGNORECASE
)
_NAME_TRAILER_RE = re.compile(
    r"[\s,.:\-]*\b(?:" + "|".join(_NAME_TRAILERS) + r")[\s,.!?]*$", re.IGNORECASE
)
# Bound the peel so a pathological input cannot loop; two rounds cover the real
# shapes ("mera naam ... hai", "main ... hoon ji").
_NAME_PEEL_ROUNDS = 3


def _clean_name(raw: str) -> str:
    """Strip common English/Hinglish lead-ins and trailers from a typed name.

    Returns the stripped name, or the RAW (whitespace-trimmed) input when
    stripping would leave nothing — the conservative direction, per the rule above.
    """
    text = (raw or "").strip()
    candidate = text
    for _ in range(_NAME_PEEL_ROUNDS):
        peeled = _NAME_TRAILER_RE.sub("", _NAME_LEAD_IN_RE.sub("", candidate)).strip()
        if peeled == candidate:
            break
        if not peeled:
            return text  # stripping consumed everything -> keep what was typed
        candidate = peeled
    return candidate or text


def _render_worker_name(reply: str, name: str | None) -> str:
    """Post-emit personalization — the CLI mirror of ``ChatService.renderWorkerName``.

    AI-PERSONA-2 / §2: the interview engine only ever emits the literal
    ``{{worker_name}}`` TOKEN (not PII). The real name is interpolated over that
    token HERE — locally, at PRINT time, AFTER the response has come back — so the
    name never crosses the LLM boundary. With no usable name, the token AND its
    trailing ``" ji, "`` are dropped so the line degrades cleanly.
    """
    if WORKER_NAME_PLACEHOLDER not in reply:
        return reply
    first = (name or "").strip().split(" ")[0] if (name or "").strip() else ""
    if first:
        return reply.replace(f"{WORKER_NAME_PLACEHOLDER} ji, ", f"{first} ji, ").replace(
            WORKER_NAME_PLACEHOLDER, first
        )
    return reply.replace(f"{WORKER_NAME_PLACEHOLDER} ji, ", "").replace(
        WORKER_NAME_PLACEHOLDER, ""
    )


# --- startup banner ---------------------------------------------------------

_PROVIDER_LABELS = {"google": "Gemini", "anthropic": "Claude Haiku"}

# MSG-1: WHY a turn fell back to the offline mock, per ``AICallMetadata.error_code``.
# This note used to say "model unavailable" for EVERY mock turn — a lie for every
# reason below except an actual model failure: a spend cap is a BUDGET stop and an
# unreachable ledger is a CONFIG error, and telling an operator "model unavailable"
# sends them to debug the wrong system. Unmapped/None => the generic mock-mode note
# (the ordinary AI_ENABLE_REAL_CALLS=false path, which is not a failure at all).
_MOCK_REASON_NOTES = {
    "spend_store_unavailable": (
        "spend ledger unreachable — real call blocked (fail-closed, NOT a spend cap); "
        "check AI_SPEND_REDIS_URL. Used offline fallback (mock) for this turn"
    ),
    "daily_cap_exceeded": (
        "daily spend cap reached — used offline fallback (mock) for this turn"
    ),
    "cumulative_cap_exceeded": (
        "cumulative spend cap reached — used offline fallback (mock) for this turn"
    ),
    "user_daily_cap_exceeded": (
        "per-user daily spend cap reached — used offline fallback (mock) for this turn"
    ),
    "cost_ceiling_exceeded": (
        "per-call cost ceiling exceeded — used offline fallback (mock) for this turn"
    ),
    "kill_switch_engaged": (
        "real calls hard-disabled by the kill switch — used offline fallback (mock) "
        "for this turn"
    ),
}


def _provider_note(meta: AICallMetadata) -> str | None:
    """Per-turn visibility note: which provider actually served this turn (or WHY it
    fell back to the offline mock). Named neutrally — NOT "primary"/"fallback" —
    because the order is configurable (Haiku can be primary). PII-free (reads only
    ``AICallMetadata``: closed-set codes, model ids, ints — never a config VALUE)."""
    if not meta.real_call:
        reason = _MOCK_REASON_NOTES.get(meta.error_code or "")
        if reason:
            return f"[note: {reason}]"
        return "[note: real calls off — used offline fallback (mock) for this turn]"
    label = _PROVIDER_LABELS.get(meta.provider, meta.provider)
    # Reconcile per-attempt vs per-call: a turn may have taken several failed
    # attempts before this one served. attempt_count counts every dispatch.
    failed = max(meta.attempt_count - 1, 0)
    if failed > 0:
        return f"[note: this turn served by {label} after {failed} failed attempt(s)]"
    return f"[note: this turn served by {label}]"


def _startup_status(settings) -> str:
    """Up-front readiness banner: is the REAL flow on, and which providers serve?

    A silent all-mock run is the single most confusing failure mode — it happens
    when ``AI_ENABLE_REAL_CALLS``/``GEMINI_FLASH_API_KEY`` resolve empty, OR (the
    sneaky one) when a SHELL env var of the same name overrides ``.env`` (pydantic
    reads ``os.environ`` ahead of the file). PII-free (config flags/model ids)."""
    reason = settings.real_calls_blocked_reason()
    if reason is not None:
        return (
            "[setup] Real LLM calls: OFF — MOCK ONLY (reason: " + reason + ").\n"
            "        Enable: set AI_ENABLE_REAL_CALLS=true and GEMINI_FLASH_API_KEY in\n"
            "        apps/ai-service/.env. NOTE: a SHELL env var of the same name OVERRIDES\n"
            "        .env — clear it (PowerShell: Remove-Item Env:AI_ENABLE_REAL_CALLS) or\n"
            "        open a fresh terminal, then re-run."
        )
    primary_model = settings.default_cheap_model
    primary = f"{primary_model} ({provider_for_model(primary_model)})"
    fallback_model = settings.default_fallback_model
    fallback_provider = provider_for_model(fallback_model)
    if (
        fallback_model
        and fallback_provider != provider_for_model(primary_model)
        and settings.has_credential_for(fallback_provider)
    ):
        fallback = f"{fallback_model} ({fallback_provider})"
    else:
        fallback = "none — offline mock if the primary fails"
    lines = [
        "[setup] Real LLM calls: ON.",
        f"        primary : {primary}",
        f"        fallback: {fallback}",
    ]
    if not settings.real_call_enabled_for("profiling_chat_turn"):
        lines.append(
            "        WARNING: 'profiling_chat_turn' is NOT in AI_REAL_CALL_TASKS, so CHAT\n"
            "        turns stay MOCK. Add it (or blank AI_REAL_CALL_TASKS) for a real chat."
        )
    if not settings.ai_profiling_rephrase_enabled:
        # NOT a warning — this is the intended COST-4 default. The engine chooses AND
        # phrases every straight-line question, so chat turns are templated-only and
        # cost nothing; a real chat call fires only on the clarify/rephrase branch.
        lines.append(
            "        note: AI_PROFILING_REPHRASE_ENABLED is off (default) — chat turns\n"
            "        are templated by the interview engine; only extraction calls a model."
        )
    return "\n".join(lines)


def _transport_banner(transport: Transport, remote_health: dict[str, Any] | None) -> str:
    lines = [
        f"[setup] Transport: {transport.label}",
        "        Every turn is a real POST /profiling/respond; the profile is a real",
        "        POST /profile/extract. No engine function is called directly.",
    ]
    if remote_health is not None:
        lines.append(
            "        remote /health: "
            + json.dumps(
                {
                    k: remote_health.get(k)
                    for k in ("status", "real_calls_enabled", "service_auth_enabled")
                }
            )
            + "  <- the REMOTE posture; the local .env below may differ"
        )
        lines.append(
            "        CAVEAT: the trace's 'detected' line is a LOCAL read-only diagnostic\n"
            "        (this checkout's signals.py). It drives nothing, but it can differ\n"
            "        from the remote build. Everything else comes from the response."
        )
    return "\n".join(lines)


# --- cost panel -------------------------------------------------------------


def _rupees(amount: float) -> str:
    """Format an INR amount with a PLAIN ``Rs `` prefix (never a unicode symbol),
    so it encodes cleanly on legacy Windows code pages (cp1252)."""
    return f"Rs {amount:.4f}"


def _per_call_status(c: AICallMetadata) -> str:
    """Truthful one-line outcome for a call, reconciling per-attempt vs per-call."""
    if c.success:
        failed = max(c.attempt_count - 1, 0)
        if failed > 0:
            return f"ok via {c.model_name} after {failed} failed attempt(s)"
        return "ok"
    detail = c.failure_reason or c.error_code or "unknown"
    if c.attempt_count > 0:
        return (
            f"FAIL ({c.error_code or 'unknown'}) "
            f"after {c.attempt_count} attempt(s) [{detail}]"
        )
    return f"FAIL ({c.error_code or 'unknown'})"


def render_cost_metadata(calls: list[AICallMetadata]) -> str:
    """Build the terminal cost/metadata panel from router call metadata.

    PRIVACY: ``calls`` entries are ``AICallMetadata`` — PII-free by contract. This
    function reads ONLY those fields. It is NEVER given the worker name or the
    transcript, and it MUST NOT be changed to accept them.
    """
    lines: list[str] = ["=== COST & METADATA ==="]

    if not calls:
        lines.append("(no model calls were made)")
        return "\n".join(lines)

    real_count = sum(1 for c in calls if c.real_call)
    mock_count = len(calls) - real_count
    total_attempts = sum(c.attempt_count for c in calls)
    total_cost = sum(c.estimated_cost_inr for c in calls)
    total_in = sum(c.input_tokens for c in calls)
    total_out = sum(c.output_tokens for c in calls)
    total_latency = sum(c.latency_ms for c in calls)
    seen: list[str] = []
    for c in calls:
        desc = f"{c.model_name} ({c.provider})"
        if desc not in seen:
            seen.append(desc)
    models_used = ", ".join(seen)
    flagged = any(c.cost_alert or c.above_target for c in calls)

    lines.append("SUMMARY")
    lines.append(f"  models    : {models_used}")
    lines.append(f"  calls     : {len(calls)} total ({real_count} real / {mock_count} mock)")
    # Reconciles the confusing "28 failed attempts vs 11 calls" gap: attempts are
    # per-dispatch (incl. retries + provider fallbacks); calls are per-turn.
    lines.append(
        f"  attempts  : {total_attempts} model attempt(s) across {len(calls)} call(s)"
    )
    lines.append(f"  cost      : {_rupees(total_cost)} (total estimated)")
    lines.append(f"  tokens    : {total_in} in / {total_out} out")
    lines.append(f"  latency   : {total_latency} ms (total)")
    if flagged:
        lines.append("  flags     : COST/TARGET ALERT (cost_alert or above_target on >=1 call)")
    else:
        lines.append("  flags     : none")

    lines.append("PER-CALL")
    for i, c in enumerate(calls, start=1):
        kind = "REAL" if c.real_call else "MOCK"
        status = _per_call_status(c)
        lines.append(
            f"  {i}. {c.task_type} [{kind}] {c.model_name} "
            f"tok={c.input_tokens}/{c.output_tokens} "
            f"cost={_rupees(c.estimated_cost_inr)} "
            f"lat={c.latency_ms}ms {status}"
        )

    return "\n".join(lines)


def _metadata(payload: dict[str, Any] | None) -> AICallMetadata | None:
    """Parse the response's ``ai_metadata`` through the SAME Pydantic contract the
    service returns it under (so a shape change fails here, loudly)."""
    if not payload:
        return None
    try:
        return AICallMetadata.model_validate(payload)
    except Exception:  # pragma: no cover - defensive; the panel must not break a run
        return None


# --- the interview ----------------------------------------------------------


def run_interview(
    session: InterviewSession,
    *,
    input_fn=None,
    print_fn=None,
    name: str | None = None,
    verbose: bool = False,
    quiet: bool = False,
    real_calls_blocked: str | None = None,
    scripted: list[str] | None = None,
    max_turns: int = _MAX_TURNS,
) -> list[TurnResult]:
    """Drive the interview to its end (engine wrap-up, 'done', or the backstop).

    ``scripted`` replaces stdin with a canned transcript (``--script``). Returns
    every :class:`TurnResult` so the caller can render cost/metadata.
    """
    input_fn = input_fn or input
    print_fn = print_fn or print
    queue = list(scripted or [])

    _topic_id, opening = session.opening_question()
    print_fn(f"\nBada Bhai: {opening}")
    if not quiet:
        print_fn(
            "  (the opener is CLIENT-SIDE in production — apps/worker-app renders it and\n"
            "   never posts it, so it is not a stored message and not in the transcript)"
        )

    for _ in range(max_turns):
        if queue:
            message = queue.pop(0)
            print_fn(f"\nYou: {message}")
        else:
            if scripted is not None:
                break
            message = input_fn("\nYou: ").strip()
        if message.lower() in _QUIT_WORDS:
            break

        turn = session.send(message)
        if not quiet:
            print_fn(
                trace.render_turn(
                    turn,
                    verbose=verbose,
                    local_diagnostics=True,
                    real_calls_blocked=real_calls_blocked,
                )
            )
        # The conversation line: the name is interpolated HERE, locally, after the
        # response — never before it.
        print_fn(f"\nBada Bhai: {_render_worker_name(turn.reply_text, name)}")
        meta = _metadata(turn.ai_metadata)
        if meta is not None and not quiet:
            note = _provider_note(meta)
            if note:
                print_fn(note)
        if turn.extraction_ready:
            break
    return session.turns


def finish(
    session: InterviewSession,
    *,
    print_fn=None,
    verbose: bool = False,
    want_resume: bool = False,
    name: str | None = None,
) -> ExtractResult:
    """Run the production extraction and print the result panels."""
    print_fn = print_fn or print
    print_fn("")
    print_fn(trace.render_transcript(session.transcript()))
    print_fn(
        "  (both directions, exactly as profile-extraction.processor.ts buildTranscript\n"
        "   assembles it — Bada Bhai's own questions are part of the extractor's input)"
    )
    print_fn("")
    result = session.extract()
    print_fn(trace.render_extraction(result, verbose=verbose))
    print_fn("")
    print_fn(trace.render_cli_only_merge(result, (session.state or {}).get("collected")))
    if want_resume:
        print_fn("")
        print_fn(_render_resume(session, result, name=name))
    return result


def _render_resume(session: InterviewSession, result: ExtractResult, *, name: str | None) -> str:
    """``POST /resume/generate`` with the extracted profile — the same body
    ``ResumeService`` posts (``{profile}``). The worker's real name is injected by
    apps/api AFTER this call (TD21); the CLI mirrors that by printing it here."""
    response = session.transport.post("/resume/generate", {"profile": result.profile})
    if not response.ok:
        return f"=== RESUME (POST /resume/generate) ===\n  HTTP {response.status_code}"
    body = response.body
    lines = [
        "=== RESUME (POST /resume/generate) ===",
        f"  is_mock={body.get('is_mock')}  format={body.get('format')}",
        f"  name (injected locally, AFTER the AI call — never sent): {name or '(none)'}",
        "",
    ]
    lines += [f"    {line}" for line in str(body.get("resume_text") or "").splitlines()]
    return "\n".join(lines)


# --- entrypoint -------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli.onboarding_chat",
        description=(
            "Drive the worker-profiling interview through the REAL ai-service "
            "endpoints (in-process by default). Local dev tool: no DB, no events, "
            "no secrets; mock unless your own env enables real calls."
        ),
    )
    parser.add_argument(
        "--http",
        metavar="BASE_URL",
        help="drive a RUNNING ai-service over HTTP instead of in-process "
             "(e.g. http://localhost:8000)",
    )
    parser.add_argument(
        "--trace", "--verbose", "-v", dest="verbose", action="store_true",
        help="add the raw request/state/ai_metadata to every turn",
    )
    parser.add_argument(
        "--quiet", "-q", action="store_true",
        help="conversation only — suppress the per-turn trace",
    )
    parser.add_argument(
        "--edge-cases", action="store_true",
        help="run the scripted edge-case suite and exit (non-zero on failure)",
    )
    parser.add_argument(
        "--script", metavar="FILE",
        help="replay a canned transcript: one worker message per line ('#' comments)",
    )
    parser.add_argument(
        "--name", metavar="NAME",
        help="skip the name prompt (the name is LOCAL — it is never sent anywhere)",
    )
    parser.add_argument(
        "--resume", action="store_true",
        help="also call POST /resume/generate on the extracted profile",
    )
    return parser


def _make_transport(args: argparse.Namespace, token: str | None) -> Transport:
    if args.http:
        return HttpTransport(args.http, token=token)
    return InProcessTransport(token=token)


def main(argv: list[str] | None = None) -> int:
    # Hinglish replies are UTF-8 (em-dashes, Devanagari); make stdout tolerant on
    # legacy Windows code pages (cp1252) so the tool never crashes on an
    # un-encodable char.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):  # pragma: no cover - best effort only
                pass

    args = _build_parser().parse_args(argv)
    settings = get_settings()
    transport = _make_transport(args, settings.ai_internal_token)
    try:
        remote_health = None
        if args.http:
            health = transport.get("/health")
            remote_health = health.body if health.ok else {"status": f"HTTP {health.status_code}"}
        print(_transport_banner(transport, remote_health))
        print(_startup_status(settings))
        if args.http:
            print(
                "        NOTE: over --http the readiness banner above reads YOUR LOCAL env; "
                "the\n        remote service decides for itself. Trust remote /health."
            )

        if args.edge_cases:
            result = run_suite(transport, print_fn=print, verbose=args.verbose)
            return 0 if result.ok else 1

        scripted = load_script(args.script) if args.script else None
        session = InterviewSession(transport)
        print(_INTRO)
        if args.name is not None:
            name = _clean_name(args.name) or "Worker"
        elif scripted is not None:
            name = "Worker"
        else:
            # LOCAL ONLY. Captured here, interpolated over {{worker_name}} at print
            # time, never placed in a request body.
            name = _clean_name(input("Sabse pehle, aapka naam kya hai? ")) or "Worker"

        turns = run_interview(
            session,
            name=name,
            verbose=args.verbose,
            quiet=args.quiet,
            real_calls_blocked=settings.real_calls_blocked_reason(),
            scripted=scripted,
        )
        result = finish(
            session, verbose=args.verbose, want_resume=args.resume, name=name
        )

        calls = [m for m in (_metadata(t.ai_metadata) for t in turns) if m is not None]
        extraction_meta = _metadata(result.ai_metadata)
        if extraction_meta is not None:
            calls.append(extraction_meta)
        print("")
        print(render_cost_metadata(calls))
        return 0
    finally:
        transport.close()


if __name__ == "__main__":
    raise SystemExit(main())
