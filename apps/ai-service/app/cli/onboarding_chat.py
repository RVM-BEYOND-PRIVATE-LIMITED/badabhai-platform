"""In-process terminal onboarding CLI: a Hinglish chat -> a resume JSON.

LOCAL DEV TOOL ONLY. Run with:  python -m app.cli.onboarding_chat

What it is / is NOT:
- The interview is now MODEL-DRIVEN: "Bada Bhai" (the model behind
  ``router.run("profiling_chat_turn", ...)``) decides each question, reacts to
  the worker's answer, and signals when it has enough to extract. The router's
  Gemini-primary / Haiku-fallback chain is handled internally; this CLI only
  supplies pseudonymized messages and a deterministic mock fallback.
- It reuses the PRODUCTION building blocks unchanged: the pseudonymization gate
  (``app.pseudonymize.pseudonymize``), the profile extractor
  (``app.profiling.profile_extractor``), and the router (``app.ai.router.AIRouter``).
- It uses NO database, NO event emission, and starts NO HTTP server.
- Real LLM calls happen ONLY if the same env gate is on (AI_ENABLE_REAL_CALLS +
  GEMINI_FLASH_API_KEY, with the task allowlist). By default everything is mock.

PRIVACY INVARIANT (mirrors production):
- The worker's NAME is captured ONCE into a LOCAL variable and is NEVER placed in
  any text sent to the model — not to ``router.run`` and not into the
  pseudonymized conversation history. The name is injected into the resume
  LOCALLY, after the AI step. Every worker message that COULD reach the model is
  pseudonymized FIRST and fails closed: if pseudonymization blocks, we do not
  call the model and ask the worker to rephrase WITHOUT personal details.
- Nothing is persisted; the transcript and resume (and the pseudonymized chat
  history) live only in process memory and on stdout.

The resume JSON schema (simple, documented):
    {
      "name": str,                     # captured locally, never sent to the LLM
      "role": str | None,              # canonical_role_id from extraction
      "trade": str | None,             # canonical_trade_id
      "primary_role": str | None,      # human-readable role label
      "experience_years": float | None,
      "experience_level": str,
      "machines": [str],               # human-readable machine labels
      "controllers": [str],
      "skills": [str],
      "education": [str],
      "current_city": str | None,
      "preferred_locations": [str],
      "current_salary": int | None,
      "expected_salary": int | None,
      "availability": str,
    }
"""

from __future__ import annotations

import asyncio
import json
import sys

from ..ai.router import AIRouter
from ..config import get_settings
from ..contracts import AICallMetadata, WorkerProfileDraft
from ..profiling import profile_extractor
from ..profiling.prompts import EXTRACTION_SYSTEM_PROMPT
from ..pseudonymize import pseudonymize

# Backstop so a wandering chat can't loop forever (the model usually finishes
# sooner by setting ``ready_to_extract``).
_MAX_TURNS = 10

_INTRO = (
    "\nNamaste bhai! Main aapka Bada Bhai hoon. Chaliye 2 minute me "
    "aapka kaam ka profile bana lete hain.\n"
    "(Tip: jab aapko lage baat poori ho gayi, 'done' likh dena. Apna phone number "
    "ya company ka naam likhne ki zaroorat nahi hai.)\n"
)

# The model is "Bada Bhai" and DRIVES the interview: it picks each question,
# reacts to the answer, and decides readiness. It must reply with STRICT JSON so
# the loop can read both the line to show AND the readiness flag. Every worker
# turn in the history is pseudonymized; the name is never present here.
_CHAT_SYSTEM_PROMPT = (
    "You are 'Bada Bhai', a warm, friendly big brother interviewing a blue/grey-"
    "collar CNC/VMC manufacturing worker in India to build their job profile.\n"
    "Style:\n"
    "- Speak simple, encouraging Hinglish (Hindi + English). Keep it short.\n"
    "- Ask EXACTLY ONE question at a time and REACT to the previous answer first.\n"
    "- Never sound like an exam. Never reject, judge, or rank the worker.\n"
    "Coverage (ask, across the chat, until you have a good picture): role / trade, "
    "machines worked on, controllers (Fanuc, Siemens, etc.), years of experience, "
    "skills (setting, programming, drawing reading), current + preferred location, "
    "current + expected salary, and joining availability.\n"
    "HARD RULES — you must NEVER ask for or repeat: phone number, full name, home "
    "address, or company/employer name. The worker's answers may contain "
    "placeholder tokens like [CITY_1] or [PHONE_1]; treat them as already-masked "
    "and never ask for the real value.\n"
    "When you have enough across the coverage areas, set ready_to_extract true and "
    "send a short warm wrap-up line.\n"
    "OUTPUT FORMAT — reply with STRICT JSON ONLY, no prose around it, exactly:\n"
    '{"message": "<one Hinglish line to show the worker>", '
    '"ready_to_extract": <true|false>}'
)

# Deterministic offline fallback handed to the router as ``mock_response`` for a
# chat turn. Safe (no PII, asks a generic coverage question) and valid JSON so
# the lenient parser always succeeds even with no model available.
_CHAT_MOCK_JSON = json.dumps(
    {
        "message": (
            "Badhiya bhai. Thoda aur batao — kaunsi machine pe kaam kiya hai, "
            "kitne saal ka experience hai, aur abhi kis city me ho?"
        ),
        "ready_to_extract": False,
    },
    ensure_ascii=False,
)


def _schema_hint() -> str:
    keys = ", ".join(WorkerProfileDraft.model_fields.keys())
    return f"Schema keys: {keys}."


def _build_resume_json(name: str, rich: WorkerProfileDraft, legacy) -> dict:
    """Assemble the resume dict = LOCAL name + extracted profile fields.

    ``name`` is added here, AFTER the AI step, and is never part of any model
    input. ``legacy`` is the taxonomy-id ``DraftProfile``; ``rich`` is the
    human-readable ``WorkerProfileDraft``.
    """
    return {
        "name": name,
        "role": legacy.canonical_role_id,
        "trade": legacy.canonical_trade_id,
        "primary_role": rich.primary_role,
        "experience_years": rich.experience_years,
        "experience_level": rich.experience_level,
        "machines": rich.machines,
        "controllers": rich.controllers,
        "skills": rich.skills,
        "education": rich.education,
        "current_city": rich.current_city,
        "preferred_locations": rich.preferred_locations,
        "current_salary": rich.current_salary,
        "expected_salary": rich.expected_salary,
        "availability": rich.availability,
    }


def _parse_chat_json(content: str) -> dict:
    """Leniently parse a chat turn's STRICT-JSON reply.

    Tolerates stray text around the object (some models wrap JSON in prose or a
    ```json fence): try a direct ``json.loads`` first, then fall back to the first
    balanced ``{...}`` span. On any failure return a safe deterministic dict so
    the loop never crashes on malformed model output (fail-safe, never fail-open:
    the worst case is one extra generic question, never a privacy leak)."""
    text = (content or "").strip()
    for candidate in (text, _first_json_object(text)):
        if not candidate:
            continue
        try:
            data = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(data, dict):
            return data
    return {"message": "", "ready_to_extract": False}


def _first_json_object(text: str) -> str | None:
    """Return the first balanced ``{...}`` substring, or None."""
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    for i in range(start, len(text)):
        ch = text[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def _provider_note(meta: AICallMetadata) -> str | None:
    """Per-turn visibility note so the worker always knows the provider.

    The COST & METADATA panel remains the authoritative breakdown; this is just a
    friendly inline heads-up. PII-free (reads only ``AICallMetadata`` fields)."""
    if not meta.real_call:
        return "[note: model unavailable — used offline fallback for this turn]"
    if meta.provider == "anthropic":
        return "[note: served by the Claude Haiku fallback this turn]"
    return None


async def _run_chat(
    router: AIRouter,
    *,
    input_fn=None,
    print_fn=None,
    role_family: str = "cnc_vmc",
) -> tuple[dict, list[AICallMetadata]]:
    """Drive the MODEL-driven interview loop and return ``(resume_json, calls)``.

    The model ("Bada Bhai", behind ``router.run("profiling_chat_turn", ...)``)
    decides each question and when it has enough; this CLI only pseudonymizes the
    worker's answers, maintains the pseudonymized history, and shows the model's
    line. ``calls`` is the ordered list of every ``AICallMetadata`` returned by
    the router this run: each chat turn's meta, then the final extraction meta.
    Each entry is PII-free by contract (see ``AICallMetadata``), so the caller can
    render an ops cost/metadata panel WITHOUT touching the name or transcript.

    ``input_fn``/``print_fn`` are injectable so tests can script stdin/stdout
    without a real terminal. They default to the builtins, resolved at call time
    (so a test's monkeypatch of ``builtins.input`` is honored).
    """
    input_fn = input_fn or input
    print_fn = print_fn or print
    print_fn(_INTRO)

    # Ordered ledger of every router.run meta this run (chat turns + final
    # extraction). PII-free by contract; powers the cost/metadata panel.
    calls: list[AICallMetadata] = []

    # 1. Capture the NAME once into a LOCAL variable. It NEVER enters model input
    #    or the pseudonymized history below.
    name = input_fn("Sabse pehle, aapka naam kya hai? ").strip() or "Worker"

    # 2. MODEL-DRIVEN interview loop. We keep a PSEUDONYMIZED conversation history
    #    (only safe, masked text ever reaches the model) and the RAW worker answers
    #    locally for the trusted heuristic extraction. The model picks each
    #    question and decides readiness via ``ready_to_extract``.
    history: list[dict[str, str]] = []  # [{role: user/assistant, text: <pseudonymized>}]
    transcript_lines: list[str] = []  # RAW answers, local-only (never sent anywhere)

    print_fn("\nBada Bhai: Bhai, sabse pehle batao — aap kya kaam karte ho?")

    for _turn in range(_MAX_TURNS):
        answer = input_fn("You: ").strip()
        if answer.lower() == "done":
            break

        # Pseudonymize FIRST (fail-closed). A blocked answer is NEVER sent to the
        # model and NEVER added to history; we re-prompt without consuming a turn
        # against the model.
        safe = pseudonymize(answer)
        if safe.blocked:
            print_fn(
                "\nBada Bhai: Bhai, ismein kuch personal detail (jaise phone ya "
                "company ka naam) lag rahi hai — usse hata ke, sirf kaam ke baare "
                "me dobara likho. "
                f"(reason: {safe.blocked_reason})"
            )
            continue

        # Safe to use this answer: keep the RAW copy locally and the MASKED copy
        # for the model.
        transcript_lines.append(answer)
        history.append({"role": "user", "text": safe.text})

        # Build messages: system persona + pseudonymized prior turns + the latest
        # pseudonymized answer (already appended as the final user turn). The name
        # is never present in any of these.
        messages = [{"role": "system", "content": _CHAT_SYSTEM_PROMPT}]
        for item in history:
            messages.append({"role": item["role"], "content": item["text"]})

        content, meta = await router.run(
            "profiling_chat_turn",
            messages=messages,
            mock_response=_CHAT_MOCK_JSON,
            real_call_allowed=True,
        )
        calls.append(meta)

        data = _parse_chat_json(content)
        message = (data.get("message") or "").strip() or (
            "Badhiya bhai. Thoda aur batao apne kaam ke baare me."
        )
        history.append({"role": "assistant", "text": message})
        print_fn(f"\nBada Bhai: {message}")

        # VISIBILITY ("no mock"): the worker must always know the provider.
        note = _provider_note(meta)
        if note is not None:
            print_fn(note)

        if data.get("ready_to_extract") is True:
            break

    # 3. Extraction (REUSE existing). Pseudonymize the accumulated worker answers
    #    FIRST (fail-closed). The name is injected post-AI in _build_resume_json.
    transcript = "\n".join(transcript_lines)
    safe = pseudonymize(transcript)
    if safe.blocked:
        print_fn(
            "\nBada Bhai: Sorry bhai, kuch personal detail (jaise phone ya company "
            "ka naam) aa gayi — please usse hata ke dobara batao. "
            f"(reason: {safe.blocked_reason})"
        )
        # Return a minimal resume with just the name; nothing was sent to the
        # model for extraction. ``calls`` holds only the prior chat-turn metas.
        rich, legacy = profile_extractor.extract("", role_family)
        return _build_resume_json(name, rich, legacy), calls

    # Heuristic extraction over RAW text (trusted, local, no network).
    rich, legacy = profile_extractor.extract(transcript, role_family)

    # Route for cost/tracing + optional real-model extraction. The model only ever
    # sees the PSEUDONYMIZED transcript (``safe.text``) — never the raw text, and
    # never the name.
    messages = [
        {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT + _schema_hint()},
        {"role": "user", "content": safe.text},
    ]
    content, meta = await router.run(
        "profile_extraction", messages=messages, mock_response=rich.model_dump_json(),
        real_call_allowed=True,
    )
    calls.append(meta)
    if meta.real_call and meta.success:
        try:
            parsed = WorkerProfileDraft.model_validate_json(content)
        except Exception:  # noqa: BLE001 - tolerate malformed LLM output
            parsed = None
        if parsed is not None:
            # Keep locally-read fields (city/salary): the model only saw masked text.
            parsed.current_city = rich.current_city
            parsed.preferred_locations = rich.preferred_locations
            parsed.relocation_willingness = rich.relocation_willingness
            parsed.current_salary = rich.current_salary
            parsed.expected_salary = rich.expected_salary
            rich = parsed

    return _build_resume_json(name, rich, legacy), calls


def _rupees(amount: float) -> str:
    """Format an INR amount with a PLAIN ``Rs `` prefix (never a unicode symbol),
    so it encodes cleanly on legacy Windows code pages (cp1252)."""
    return f"Rs {amount:.4f}"


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
    total_cost = sum(c.estimated_cost_inr for c in calls)
    total_in = sum(c.input_tokens for c in calls)
    total_out = sum(c.output_tokens for c in calls)
    total_latency = sum(c.latency_ms for c in calls)
    # Stable, de-duplicated "model (provider)" descriptors, preserving order.
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
        status = "ok" if c.success else f"FAIL ({c.error_code or 'unknown'})"
        lines.append(
            f"  {i}. {c.task_type} [{kind}] {c.model_name} "
            f"tok={c.input_tokens}/{c.output_tokens} "
            f"cost={_rupees(c.estimated_cost_inr)} "
            f"lat={c.latency_ms}ms {status}"
        )

    return "\n".join(lines)


def main() -> None:
    # Hinglish replies (and the engine's wrap-up emoji) are UTF-8; make stdout
    # tolerant on legacy Windows code pages (cp1252) so the tool never crashes
    # on an un-encodable char.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):  # pragma: no cover - best effort only
                pass

    settings = get_settings()
    router = AIRouter(settings)
    resume, calls = asyncio.run(_run_chat(router))
    print("\n=== RESUME (JSON) ===")
    print(json.dumps(resume, indent=2, ensure_ascii=False))
    # Ops panel — PII-free metadata only (never the name/transcript).
    print("\n" + render_cost_metadata(calls))


if __name__ == "__main__":
    main()
