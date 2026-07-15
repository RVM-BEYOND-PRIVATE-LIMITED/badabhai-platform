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

from ..ai.model_config import provider_for_model
from ..ai.router import AIRouter
from ..config import get_settings
from ..contracts import AICallMetadata, WorkerProfileDraft
from ..profiling import profile_extractor
from ..profiling.canonical_roles import (
    ROLE_TRADE,
    canonicalization_instruction,
    extract_canonical_role_id,
    normalize_role_id,
)
from ..profiling.prompts import EXTRACTION_SYSTEM_PROMPT
from ..pseudonymize import pseudonymize

# Backstop so a wandering chat can't loop forever (the model usually finishes
# sooner by setting ``ready_to_extract``).
_MAX_TURNS = 10

_INTRO = (
    "\nNamaste. Main Bada Bhai hoon. Chaliye 2 minute mein "
    "aapka kaam ka profile bana lete hain.\n"
    "(Tip: jab aapko lage baat poori ho gayi, 'done' likh dein. Apna phone number "
    "ya company ka naam likhne ki zaroorat nahi hai.)\n"
)

# The model is "Bada Bhai" and DRIVES the interview: it picks each question,
# reacts to the answer, and decides readiness. It must reply with STRICT JSON so
# the loop can read both the line to show AND the readiness flag. Every worker
# turn in the history is pseudonymized; the name is never present here.
_CHAT_SYSTEM_PROMPT = (
    "You are 'Bada Bhai', a senior who has worked the CNC/VMC shop floor and is "
    "interviewing a worker in India to build their job profile. On their side — "
    "not an examiner, not a salesman.\n"
    "Style:\n"
    "- Ask EXACTLY ONE question at a time, under 20 words. Acknowledge the "
    "previous answer in MAX 2 words (\"Theek hai.\" / \"Achha.\"), never praise "
    "or gush (no \"waah\", \"zabardast\", \"bahut acha\", \"bilkul\"), never "
    "restate their answer.\n"
    "- NEVER use bhai, bhaiya, beta, behen, yaar. Never assume gender. Always use "
    "\"aap\". Prefer present tense.\n"
    "- MATCH THE WORKER'S LANGUAGE: if they write in Hindi, reply in Hindi; in "
    "English, reply English; in Hinglish, reply Hinglish. Mirror their words.\n"
    "- Never sound like an exam. Never reject, judge, or rank the worker.\n"
    "Coverage — over the chat, try to learn: role / trade, machines worked on, "
    "controllers (Fanuc, Siemens, etc.), years of experience, skills (setting, "
    "programming, drawing reading), current + preferred location, current + "
    "expected salary, and joining availability.\n"
    "STOP CONDITION — set ready_to_extract=true (and send a short closing "
    "line in the worker's language, telling them their resume is being made) as "
    "soon as EITHER:\n"
    "  (a) you have reasonable coverage of the areas above, OR\n"
    "  (b) the worker signals they are done / disengaging / want a job now (e.g. "
    "'bas', 'itna hi', 'ho gaya', 'done', 'aur nahi', 'naukri laga do'). Do NOT "
    "keep asking after that — respect it and wrap up.\n"
    "NEVER REPEAT a question you already asked. If an answer is vague, ask ONE "
    "different clarifying question; if it is STILL vague, move on to another area "
    "or wrap up — never ask the same thing again.\n"
    "ROLE — the worker may only say a generic 'CNC'. Probe ONCE to disambiguate "
    "(VMC? CNC lathe/turning? grinding? setter? programmer?). If they still can't "
    "say, leave it — do not push.\n"
    "HARD RULES — you must NEVER ask for or repeat: phone number, full name, home "
    "address, or company/employer name. The worker's answers may contain "
    "placeholder tokens like [CITY_1] or [PHONE_1]; treat them as already-masked "
    "and never ask for the real value.\n"
    "OUTPUT FORMAT — reply with STRICT JSON ONLY, no prose around it, exactly:\n"
    '{"message": "<one line to show the worker, in their language>", '
    '"ready_to_extract": <true|false>}'
)

# Deterministic offline fallback handed to the router as ``mock_response`` for a
# chat turn. Safe (no PII, asks a generic coverage question) and valid JSON so
# the lenient parser always succeeds even with no model available.
_CHAT_MOCK_JSON = json.dumps(
    {
        "message": "Theek hai. Kaunsi machine par kaam karte hain?",
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
        # Taxonomy ids (stay on the DB schema of 7 roles + skill ids); null when
        # the worker was too vague to pin one of the 7 roles.
        "role": legacy.canonical_role_id,
        "trade": legacy.canonical_trade_id,
        "skill_ids": legacy.skills,
        # Human-readable enrichment (for display).
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


# Strong, fairly-unambiguous closing phrases (Hindi / Hinglish / English). The
# MODEL is the primary closer (via its STOP CONDITION); this CLI-side check is a
# SAFETY NET so an obvious "I'm done" always ends the interview even if the model
# misses it. Kept to multi-word / unambiguous cues to avoid false positives on
# words like a bare "bas" inside a substantive answer (e.g. "bas 2 saal kiya").
_CLOSING_CUES: tuple[str, ...] = (
    "itna hi", "itni hi", "bas itna", "bas ab", "ab bas", "ho gaya", "ho gya",
    "hogaya", "khatam", "khatm", "aur nahi", "aur nai", "ab nahi", "kuch aur nahi",
    "naukri laga", "naukri dila", "job laga", "job dila", "thats all", "that's all",
    "i am done", "im done", "nothing else", "no more",
)


def _wants_to_close(answer: str) -> bool:
    """True if the worker's answer is a clear request to finish. Conservative on
    purpose (see ``_CLOSING_CUES``). The literal 'done' is handled separately."""
    low = answer.lower()
    return any(cue in low for cue in _CLOSING_CUES)


def _fallback_message(content: str) -> str:
    """Message to show when ``_parse_chat_json`` finds no ``message`` in the model
    reply. Prefer the model's OWN words (a conversational model often replies in
    prose instead of JSON — that prose is a fine thing to show) over a canned line;
    only when nothing usable is left do we nudge the worker toward finishing. This
    is what stops the old behaviour of repeating one static question forever."""
    text = (content or "").strip()
    if text.startswith("```"):  # strip a ```json ... ``` fence
        text = text.strip("`").strip()
        if text[:4].lower() == "json":
            text = text[4:].strip()
    # Bare JSON we already failed to read, or nothing -> a closing-oriented nudge.
    if not text or text.startswith("{") or text.startswith("["):
        return "Theek hai. Aur kuch batana ho to batayein, warna 'done' likh dein."
    return text


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


_PROVIDER_LABELS = {"google": "Gemini", "anthropic": "Claude Haiku"}


def _provider_note(meta: AICallMetadata) -> str | None:
    """Per-turn visibility note: which provider actually served this turn (or that
    it fell back to the offline mock). Named neutrally — NOT "primary"/"fallback" —
    because the primary/fallback order is configurable (e.g. Haiku can be primary),
    so the chain position is not assumed. The COST & METADATA panel remains the
    authoritative breakdown; this is a friendly inline heads-up. PII-free (reads
    only ``AICallMetadata`` fields)."""
    if not meta.real_call:
        return "[note: model unavailable — used offline fallback (mock) for this turn]"
    label = _PROVIDER_LABELS.get(meta.provider, meta.provider)
    # Reconcile per-attempt vs per-call: a turn may have taken several failed
    # attempts (across providers) before this one served. attempt_count counts
    # every dispatch; the last was the success, so N-1 failed.
    failed = max(meta.attempt_count - 1, 0)
    if failed > 0:
        return f"[note: this turn served by {label} after {failed} failed attempt(s)]"
    return f"[note: this turn served by {label}]"


def _startup_status(settings) -> str:
    """Up-front readiness banner: is the REAL flow on, and which providers serve?

    A silent all-mock run is the single most confusing failure mode — it happens
    when ``AI_ENABLE_REAL_CALLS``/``GEMINI_FLASH_API_KEY`` resolve empty, OR (the
    sneaky one) when a SHELL env var of the same name overrides ``.env`` (pydantic
    reads ``os.environ`` ahead of the file). Printing the resolved state — and the
    blocking reason when off — turns that mystery into a one-line diagnosis.
    PII-free (reads only config flags/model ids)."""
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
    return "\n".join(lines)


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

    print_fn("\nBada Bhai: Sabse pehle — aap kaunsa kaam karte hain?")

    last_message: str | None = None  # for the no-repeat guard
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
                "\nBada Bhai: Ismein kuch personal detail (jaise phone ya "
                "company ka naam) lag rahi hai — usse hata ke, sirf kaam ke baare "
                "mein dobara likhein. "
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

        # Prefer the model's parsed message; on a parse miss, show its OWN words
        # (a conversational model often replies in prose) — NOT a canned line that
        # would repeat forever.
        data = _parse_chat_json(content)
        message = (data.get("message") or "").strip() or _fallback_message(content)
        history.append({"role": "assistant", "text": message})
        print_fn(f"\nBada Bhai: {message}")

        # VISIBILITY ("no mock"): the worker must always know the provider.
        note = _provider_note(meta)
        if note is not None:
            print_fn(note)

        # END the interview when: the model says it's ready; OR the worker clearly
        # asked to finish (safety net independent of the model); OR the bot just
        # repeated its previous line (a stall — don't loop on it).
        if (
            data.get("ready_to_extract") is True
            or _wants_to_close(answer)
            or message == last_message
        ):
            break
        last_message = message

    # 3. Extraction (REUSE existing). Pseudonymize the accumulated worker answers
    #    FIRST (fail-closed). The name is injected post-AI in _build_resume_json.
    transcript = "\n".join(transcript_lines)
    safe = pseudonymize(transcript)
    if safe.blocked:
        print_fn(
            "\nBada Bhai: Kuch personal detail (jaise phone ya company "
            "ka naam) aa gayi — usse hata ke dobara likhein. "
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
    # never the name. The canonicalization rubric makes the model emit a
    # `canonical_role_id` from the CLOSED 7-role set (parity with /profile/extract).
    messages = [
        {
            "role": "system",
            "content": EXTRACTION_SYSTEM_PROMPT + canonicalization_instruction() + _schema_hint(),
        },
        {"role": "user", "content": safe.text},
    ]
    content, meta = await router.run(
        "profile_extraction", messages=messages, mock_response=rich.model_dump_json(),
        real_call_allowed=True,
    )
    calls.append(meta)
    if meta.real_call and meta.success:
        # Canonicalization FIRST, leniently: trust the model's role id only if it is
        # one of the 7 (reject hallucinations); a valid id overrides the heuristic on
        # `legacy` (role + derived trade). Independent of the full-draft validation
        # below, so a good role id survives even when enrichment fields are loose.
        role_id = normalize_role_id(extract_canonical_role_id(content))
        if role_id is not None:
            legacy.canonical_role_id = role_id
            legacy.canonical_trade_id = ROLE_TRADE.get(role_id, legacy.canonical_trade_id)
        # Overlay the model's well-formed enrichment fields onto the heuristic draft
        # (keeps experience_years/machines/etc. even when other fields are malformed;
        # location/salary stay local — the model only saw masked text).
        rich = profile_extractor.merge_model_draft(rich, content)
        # TODO(WS4 recall backfill, owner review): mirror the endpoint — once the
        # staging --real NEGATIVE tier is verified unaffected, enable
        #   legacy = profile_extractor.map_rich_to_legacy(rich, legacy)
        # to fill in-scope machine/skill/role ids the raw-text detector missed.

    # Honest-adjacency flag (advisory ONLY): mark the draft adjacent when it
    # canonicalized to nothing matchable in the CNC/VMC taxonomy, so it is not
    # silently half-empty. Additive; no matchable field is written here.
    if profile_extractor.is_outside_cnc_vmc_scope(legacy):
        rich.unmatchable_reason = profile_extractor.UNMATCHABLE_OUTSIDE_SCOPE

    return _build_resume_json(name, rich, legacy), calls


def _rupees(amount: float) -> str:
    """Format an INR amount with a PLAIN ``Rs `` prefix (never a unicode symbol),
    so it encodes cleanly on legacy Windows code pages (cp1252)."""
    return f"Rs {amount:.4f}"


def _per_call_status(c: AICallMetadata) -> str:
    """Truthful one-line outcome for a call, reconciling per-attempt vs per-call.

    Success after retries reads ``ok via <model> after N failed attempt(s)``;
    a terminal failure keeps the coarse ``error_code`` AND adds the specific
    closed-set ``failure_reason`` plus the attempt count. PII-free (reads only
    AICallMetadata: model ids, ints, closed-set reason codes)."""
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


def main() -> None:
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

    settings = get_settings()
    router = AIRouter(settings)
    # Print readiness FIRST so a silent all-mock run can never be a mystery.
    print(_startup_status(settings))
    resume, calls = asyncio.run(_run_chat(router))
    print("\n=== RESUME (JSON) ===")
    print(json.dumps(resume, indent=2, ensure_ascii=False))
    # Ops panel — PII-free metadata only (never the name/transcript).
    print("\n" + render_cost_metadata(calls))


if __name__ == "__main__":
    main()
