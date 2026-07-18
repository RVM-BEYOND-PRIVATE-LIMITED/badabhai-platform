"""In-process terminal onboarding CLI: a Hinglish chat -> a resume JSON.

LOCAL DEV TOOL ONLY. Run with:  python -m app.cli.onboarding_chat

What it is / is NOT:
- CLI-1: the interview is DETERMINISTIC and ENGINE-DRIVEN, mirroring the
  production path ``chat.service.ts -> POST /profiling/respond`` turn for turn:
  pseudonymize -> ``interview_engine.clarify_turn`` (when ``needs_rephrase``) else
  ``interview_engine.next_turn`` -> ``build_chat_messages`` ->
  ``router.run("profiling_chat_turn", ...)`` -> thread the returned
  ``ConversationState`` into the next turn -> stop on ``extraction_ready``.
  This CLI previously ran its OWN model-driven loop that shipped nowhere; it
  validated nothing real. It now exercises the same engine the API does.
- The MODEL NEVER CHOOSES A QUESTION. The engine picks the topic; in real mode the
  LLM may only PHRASE that one question (COST-4 rephrase branch, off by default).
  The engine's ``topic_id`` is printed beside every turn so drift is visible.
- COST-3: the chat turn is STATELESS. ``build_chat_messages([], ...)`` is called
  with an EMPTY history on purpose (its docstring: history is intentionally
  unused), so per-turn input tokens stay FLAT instead of growing O(n^2).
- It reuses the PRODUCTION building blocks unchanged: the pseudonymization gate
  (``app.pseudonymize.pseudonymize``), the interview engine
  (``app.profiling.interview_engine``), the profile extractor
  (``app.profiling.profile_extractor``), and the router (``app.ai.router.AIRouter``).
- It uses NO database, NO event emission, and starts NO HTTP server.
- Real LLM calls happen ONLY if the same env gate is on (AI_ENABLE_REAL_CALLS +
  GEMINI_FLASH_API_KEY, with the task allowlist) AND, for a chat turn, only on the
  clarify/rephrase branch. By default everything is mock.

PRIVACY INVARIANT (mirrors production):
- The worker's NAME is captured ONCE into a LOCAL variable and is NEVER placed in
  any text sent to the model — not to ``router.run`` and not into anything the
  engine returns. The engine emits only the literal ``{{worker_name}}`` token
  (AI-PERSONA-2); this CLI interpolates the real name over that token LOCALLY at
  PRINT time only — the same post-emit seam ``ChatService.renderWorkerName``
  implements in NestJS. The name is injected into the resume LOCALLY, after the AI
  step. Every worker message that COULD reach the model is pseudonymized FIRST and
  fails closed: if pseudonymization blocks, we do not call the model and ask the
  worker to rephrase WITHOUT personal details.
- Nothing is persisted; the transcript, resume and ConversationState live only in
  process memory and on stdout.

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
from ..contracts import AICallMetadata, ConversationState, WorkerProfileDraft
from ..profiling import interview_engine, profile_extractor
from ..profiling.canonical_roles import (
    ROLE_TRADE,
    canonicalization_instruction,
    extract_canonical_role_id,
    normalize_role_id,
)
from ..profiling.interview_engine import WORKER_NAME_PLACEHOLDER
from ..profiling.prompts import EXTRACTION_SYSTEM_PROMPT, build_chat_messages
from ..profiling.question_bank import topics_for
from ..pseudonymize import pseudonymize

# Backstop so a stalled session can't loop forever. The ENGINE is the real stop
# condition (it returns extraction_ready once ESSENTIAL_TOPICS are answered and
# MUST_ASK_TOPICS asked); this only bounds a pathological run. Must be > the
# number of topics in the bank so a worker who answers nothing can still be asked
# every question before the backstop trips.
_MAX_TURNS = 30

_INTRO = (
    "\nNamaste. Main Bada Bhai hoon. Chaliye 2 minute mein "
    "aapka kaam ka profile bana lete hain.\n"
    "(Tip: jab aapko lage baat poori ho gayi, 'done' likh dein. Apna phone number "
    "ya company ka naam likhne ki zaroorat nahi hai.)\n"
)

# The worker has to say SOMETHING before the engine can run its first turn — that
# is exactly how production works (``POST /profiling/respond`` needs a
# ``message_text``). This is a harness affordance, NOT an interview question: the
# first real question comes from the engine's turn 1.
_KICKOFF = (
    "(Shuru karne ke liye kuch bhi likhein — jaise 'shuru' — ya seedha apna kaam "
    "bata dein.)"
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


def _render_worker_name(reply: str, name: str | None) -> str:
    """Post-emit personalization — the CLI mirror of ``ChatService.renderWorkerName``.

    AI-PERSONA-2 / §2: the interview engine only ever emits the literal
    ``{{worker_name}}`` TOKEN (not PII). The real name is interpolated over that
    token HERE — locally, at PRINT time, AFTER every model call — so the name never
    crosses the LLM boundary. With no usable name, the token AND its trailing
    ``" ji, "`` are dropped so the line degrades cleanly (no stray braces).
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


def _progress_line(state: ConversationState | None, role_family: str) -> str:
    """One-line coverage view: what the engine has ANSWERED, what it has ASKED, and
    what is still REMAINING in the question bank. PII-free (topic ids only)."""
    answered = list(state.answered_topics) if state else []
    asked = list(state.asked_question_ids) if state else []
    seen = set(answered) | set(asked)
    remaining = [t.id for t in topics_for(role_family) if t.id not in seen]
    return f"  answered={answered} asked={asked} remaining={remaining}"


def _turn_line(turn_no: int, topic_id: str | None, meta: AICallMetadata) -> str:
    """Per-turn engine/cost header. ``topic_id`` is the topic the ENGINE chose for
    this turn (``-`` on the wrap-up turn, which asks nothing) — printed so any drift
    between the engine's choice and the phrasing shown is immediately visible."""
    return (
        f"  [turn {turn_no}] topic_id={topic_id or '-'} "
        f"in_tokens={meta.input_tokens} out_tokens={meta.output_tokens} "
        f"real_call={meta.real_call}"
    )


_PROVIDER_LABELS = {"google": "Gemini", "anthropic": "Claude Haiku"}

# MSG-1: WHY this turn fell back to the offline mock, per ``AICallMetadata.error_code``.
# This note used to say "model unavailable" for EVERY mock turn — which is a lie for
# every reason below except an actual model failure: a spend cap is a BUDGET stop and an
# unreachable ledger is a CONFIG error, and telling an operator "model unavailable" sends
# them to debug the wrong system. The router sets error_code from the same closed set, so
# each cause gets its own honest phrasing. Unmapped/None => the generic mock-mode note
# (the ordinary AI_ENABLE_REAL_CALLS=false path, which is not a failure at all).
#
# Scoped to the codes the router can emit ALONGSIDE real_call=False (the only branch
# that reads this map). ``llm_call_failed`` / ``retry_budget_exhausted`` are deliberately
# ABSENT: the router reports those with real_call=TRUE (a candidate did reach the
# network), so they never reach here — see the note in _provider_note.
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
    because the primary/fallback order is configurable (e.g. Haiku can be primary),
    so the chain position is not assumed. The COST & METADATA panel remains the
    authoritative breakdown; this is a friendly inline heads-up. PII-free (reads
    only ``AICallMetadata`` fields — closed-set codes, never a config VALUE)."""
    if not meta.real_call:
        reason = _MOCK_REASON_NOTES.get(meta.error_code or "")
        if reason:
            return f"[note: {reason}]"
        return "[note: real calls off — used offline fallback (mock) for this turn]"
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
    if not settings.ai_profiling_rephrase_enabled:
        # NOT a warning — this is the intended COST-4 default. The engine chooses AND
        # phrases every straight-line question, so chat turns are templated-only and
        # cost nothing; a real chat call fires only on the clarify/rephrase branch.
        lines.append(
            "        note: AI_PROFILING_REPHRASE_ENABLED is off (default) — chat turns\n"
            "        are templated by the interview engine; only extraction calls a model."
        )
    return "\n".join(lines)


async def _run_chat(
    router: AIRouter,
    *,
    input_fn=None,
    print_fn=None,
    role_family: str = "cnc_vmc",
    settings=None,
) -> tuple[dict, list[AICallMetadata]]:
    """Drive the ENGINE-driven interview loop and return ``(resume_json, calls)``.

    CLI-1 — this mirrors ``chat.service.ts -> POST /profiling/respond`` turn for
    turn (see ``main.profiling_respond``), which is the ONLY sequence that ships:

      1. ``pseudonymize`` the raw answer FIRST (fail-closed gate).
      2. ``interview_engine.needs_rephrase`` -> ``clarify_turn`` (re-serve the last
         question) when it is a clarification, else ``interview_engine.next_turn``.
      3. ``build_chat_messages([], engine_question, pseudonymized_text)`` — EMPTY
         history (COST-3 stateless turn: flat input tokens, never O(n^2)).
      4. ``router.run("profiling_chat_turn", ...)`` with ``real_call_allowed`` only
         on the clarify+rephrase-flag branch, so the LLM may PHRASE the engine's
         question but NEVER choose one.
      5. Thread the returned ``ConversationState`` into the next turn; stop on
         ``extraction_ready``.

    ``calls`` is the ordered list of every ``AICallMetadata`` the router returned
    this run: each chat turn's meta, then the final extraction meta. Each entry is
    PII-free by contract (see ``AICallMetadata``), so the caller can render an ops
    cost/metadata panel WITHOUT touching the name or transcript.

    ``input_fn``/``print_fn`` are injectable so tests can script stdin/stdout
    without a real terminal. They default to the builtins, resolved at call time
    (so a test's monkeypatch of ``builtins.input`` is honored).
    """
    input_fn = input_fn or input
    print_fn = print_fn or print
    settings = settings if settings is not None else get_settings()
    print_fn(_INTRO)

    # Ordered ledger of every router.run meta this run (chat turns + final
    # extraction). PII-free by contract; powers the cost/metadata panel.
    calls: list[AICallMetadata] = []

    # 1. Capture the NAME once into a LOCAL variable. It NEVER enters model input;
    #    it is interpolated over the engine's {{worker_name}} token at PRINT time
    #    only (_render_worker_name), mirroring ChatService.renderWorkerName.
    name = input_fn("Sabse pehle, aapka naam kya hai? ").strip() or "Worker"

    # 2. ENGINE-DRIVEN interview loop. The ConversationState is the ONLY memory —
    #    exactly like production, where chat.service.ts persists it on the session
    #    and passes it back each turn. The RAW answers are kept locally for the
    #    trusted heuristic extraction; nothing but pseudonymized text is ever
    #    handed to the router.
    state: ConversationState | None = None
    transcript_lines: list[str] = []  # RAW answers, local-only (never sent anywhere)

    print_fn(f"\nBada Bhai: {_KICKOFF}")

    for _turn in range(_MAX_TURNS):
        answer = input_fn("You: ").strip()
        if answer.lower() == "done":
            break

        # Pseudonymize FIRST (fail-closed). A blocked answer is NEVER sent to the
        # model, never reaches the engine, and never enters the transcript; we
        # re-prompt without consuming a turn against the model. Mirrors the
        # endpoint's step 1, which returns _BLOCKED_REPLY before touching anything.
        safe = pseudonymize(answer)
        if safe.blocked:
            print_fn(
                "\nBada Bhai: Ismein kuch personal detail (jaise phone ya "
                "company ka naam) lag rahi hai — usse hata ke, sirf kaam ke baare "
                "mein dobara likhein. "
                f"(reason: {safe.blocked_reason})"
            )
            continue

        # Safe to use this answer: keep the RAW copy locally (the engine + the
        # heuristic extractor read raw text in-process, no network) and the MASKED
        # copy for anything that could leave the service.
        transcript_lines.append(answer)

        # COST-4 clarify branch BEFORE advancing (endpoint step 2): a clarifying
        # message is not an answer, so clarify_turn RE-SERVES the last question
        # instead of letting next_turn mis-advance past it. clarify_turn returns
        # None (-> next_turn) when there is nothing re-servable, when the message
        # actually carries an answer, or when the consecutive clarify budget
        # (_MAX_CONSECUTIVE_CLARIFIES = 2) is spent.
        is_clarify = interview_engine.needs_rephrase(answer)
        turn = (
            interview_engine.clarify_turn(state, answer, role_family)
            if is_clarify
            else None
        )
        if turn is None:
            turn = interview_engine.next_turn(state, answer, role_family)
        engine_question, asked_id, state, extraction_ready = turn

        # Endpoint step 3: the straight-line path is TEMPLATED-ONLY — the engine
        # already chose an on-persona <20-word question, so real_call_allowed is
        # False and the router returns it verbatim with zero output tokens. Only
        # the clarify branch (with the rephrase flag on) may spend a real call, and
        # then the LLM is handed THAT question to phrase — never a choice of which.
        wants_rephrase = settings.ai_profiling_rephrase_enabled and is_clarify
        # COST-3: EMPTY history on purpose. build_chat_messages ignores `history` by
        # design; passing the transcript here is the O(n^2) regression CLI-1 removed.
        messages = build_chat_messages([], engine_question, safe.text)

        reply_text, meta = await router.run(
            "profiling_chat_turn",
            messages=messages,
            mock_response=engine_question,
            real_call_allowed=wants_rephrase,
        )
        calls.append(meta)

        # Personalize LOCALLY, after the model call — the {{worker_name}} token is
        # what crossed the boundary, the real name only lands here.
        print_fn(f"\nBada Bhai: {_render_worker_name(reply_text, name)}")
        print_fn(_turn_line(state.turn_count, asked_id, meta))
        print_fn(_progress_line(state, role_family))

        # VISIBILITY ("no mock"): the worker must always know the provider.
        note = _provider_note(meta)
        if note is not None:
            print_fn(note)

        # The ENGINE owns the stop condition (ESSENTIAL_TOPICS answered +
        # MUST_ASK_TOPICS asked) — exactly the flag chat.service.ts acts on.
        if extraction_ready:
            break

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
    resume, calls = asyncio.run(_run_chat(router, settings=settings))
    print("\n=== RESUME (JSON) ===")
    print(json.dumps(resume, indent=2, ensure_ascii=False))
    # Ops panel — PII-free metadata only (never the name/transcript).
    print("\n" + render_cost_metadata(calls))


if __name__ == "__main__":
    main()
