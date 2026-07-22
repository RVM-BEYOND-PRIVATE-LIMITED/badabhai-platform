"""Per-turn TRACE rendering for the onboarding CLI.

The point of this module: make the production behaviour LEGIBLE. Everything it
prints is either straight off the endpoint response or derived from it — no
decision is taken here, and nothing here feeds back into the flow.

What each turn shows, and why it earns its line:

* ``worker`` / ``-> to LLM`` — the raw message and the pseudonymized text, i.e.
  exactly what a model would receive. This is CLAUDE.md §2 #3 made visible: on a
  BLOCK, the line says so and no model is reachable.
* ``engine`` — ADVANCE vs CLARIFY (the COST-4 branch), which topic was asked and
  which ask of that topic it was (the INTERVIEW-1 bounded re-ask).
* ``detected`` / ``collected`` / ``discarded`` — what
  ``signals.detect_answered_topics`` found in the message versus what actually
  landed in ``ConversationState.collected``, with the reason for every drop.
* ``answered`` / ``essentials`` / ``must-ask`` — the readiness state the engine
  gates on, so it is obvious WHY the interview did or did not end.
* ``source`` — REAL model call or mock, stated plainly. With
  ``AI_ENABLE_REAL_CALLS`` unset everything is mock; an operator must never
  mistake a templated question for model output.

ASCII furniture only: this runs in Windows terminals on legacy code pages.
"""

from __future__ import annotations

import json
from typing import Any

from ..profiling.interview_engine import (
    ESSENTIAL_TOPICS,
    MAX_ASKS_PER_TOPIC,
    MUST_ASK_TOPICS,
)
from .api_session import ExtractResult, TurnResult

_RULE = "-" * 72
_LABEL = 12


def _line(label: str, value: str) -> str:
    return f"  {label:<{_LABEL}}: {value}"


def _fmt(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)


def _pairs(mapping: dict[str, Any]) -> str:
    if not mapping:
        return "(none)"
    return "  ".join(f"{k}={_fmt(v)}" for k, v in mapping.items())


def _topic_state(state: dict[str, Any] | None, topic: str) -> str:
    if state is None:
        return "unknown"
    if topic in (state.get("answered_topics") or []):
        return "ANSWERED"
    if topic in (state.get("asked_question_ids") or []):
        return "asked"
    return "pending"


def must_ask_line(state: dict[str, Any] | None) -> str:
    """MUST_ASK is an asked-OR-answered gate (issue #424) — show which half each
    topic satisfies, because that is what decides whether the interview may end."""
    return "  ".join(f"{t}[{_topic_state(state, t)}]" for t in MUST_ASK_TOPICS)


def essentials_line(state: dict[str, Any] | None) -> str:
    """ESSENTIAL topics must be ANSWERED. ``unanswered_essentials`` is the
    engine's own completeness signal (INTERVIEW-1), so print it verbatim."""
    if state is None:
        return "unknown (no state returned)"
    missing = state.get("unanswered_essentials")
    if missing is None:
        missing = [t for t in ESSENTIAL_TOPICS if t not in (state.get("answered_topics") or [])]
    if not missing:
        return "all answered"
    return f"MISSING {', '.join(missing)}  (of {', '.join(ESSENTIAL_TOPICS)})"


def _gate_lines(turn: TurnResult) -> list[str]:
    gate = turn.gate
    meta = turn.turn_pseudonymization
    if gate is None:
        # No probe (or it failed). Fall back to the turn's OWN gate metadata, and
        # say "unknown" rather than "PASS" when there is none — a privacy line must
        # never assert something it did not observe.
        if not meta:
            return [
                _line("-> to LLM", "UNKNOWN - neither the /pseudonymize probe nor the "
                                   "turn response reported the gate")
            ]
        status = "BLOCKED" if meta.get("blocked") else "PASS"
        return [
            _line("-> to LLM", f"(text not probed) gate={status} "
                               f"masked={meta.get('replaced_entities', 0)}")
        ]
    if gate.blocked:
        return [
            _line("-> to LLM", "NOTHING - the gate BLOCKED this message"),
            _line("", f"reason: {gate.blocked_reason} "
                      "(fail-closed: no model call, safe reply returned)"),
        ]
    tokens = f" tokens={gate.placeholder_tokens}" if gate.placeholder_tokens else ""
    lines = [
        _line("-> to LLM", gate.text),
        _line("", f"gate: PASS  masked={gate.replaced_entities} entit(ies){tokens}"),
    ]
    if gate.replaced_entities == 0 and gate.text == turn.message:
        lines.append(_line("", "gate: nothing was masked - the model would see this verbatim"))
    return lines


def _engine_lines(turn: TurnResult) -> list[str]:
    if not turn.ok:
        if turn.response.status_code == 0:
            return [_line("engine", "NOT RUN - the ai-service was unreachable")]
        return [
            _line("engine", "NOT RUN - the request failed the contract "
                            f"(HTTP {turn.response.status_code})"),
        ]
    if turn.blocked:
        return [
            _line("engine", "NOT RUN - the endpoint returned the blocked reply first "
                            "(pseudonymize is step 1)"),
            _line("state", "unchanged (updated_state=null; apps/api persists nothing "
                           "on a blocked turn)"),
            _line("transcript", "the message IS still stored - chat.service.ts inserts the "
                                "inbound row BEFORE the AI call"),
        ]
    branch = "CLARIFY (re-serve)" if turn.clarified else "ADVANCE"
    asked = turn.asked_question_id or "-"
    detail = f"{branch} -> asks '{asked}'"
    if turn.clarified:
        clarify_count = int((turn.state or {}).get("clarify_count") or 0)
        detail += f"  (needs_rephrase matched; consecutive clarify {clarify_count}/2)"
    elif turn.asked_question_id is None:
        detail += "  (WRAP-UP: nothing left to ask)"
    else:
        n = turn.ask_number
        if n is not None:
            detail += f"  (ask {n} of at most {MAX_ASKS_PER_TOPIC})"
    prev = turn.last_asked
    if prev:
        detail += f"  [previous ask: {prev}]"
    return [_line("engine", detail)]


def _signal_lines(turn: TurnResult, *, local_diagnostics: bool) -> list[str]:
    lines: list[str] = []
    if local_diagnostics:
        lines.append(_line("detected", _pairs(turn.detected)))
    lines.append(_line("collected", _pairs(turn.newly_collected)))
    discarded = turn.discarded()
    if discarded:
        for topic, value, why in discarded:
            lines.append(_line("discarded", f"{topic}={_fmt(value)} - {why}"))
    elif local_diagnostics:
        lines.append(_line("discarded", "(none)"))
    return lines


def source_line(turn: TurnResult, *, real_calls_blocked: str | None) -> str:
    """State plainly whether a model produced this reply. This is the line an
    operator is most likely to misread, so it never says anything ambiguous."""
    meta = turn.ai_metadata or {}
    if not turn.is_mock and meta.get("real_call"):
        model = meta.get("model_name", "?")
        provider = meta.get("provider", "?")
        return (
            f"REAL model call - {model} ({provider}) "
            f"in={meta.get('input_tokens', 0)} out={meta.get('output_tokens', 0)} tok, "
            f"Rs {float(meta.get('estimated_cost_inr') or 0):.4f}"
        )
    if turn.blocked:
        return "MOCK - safe fallback reply; the gate blocked before any model path"
    why = (
        "clarify turn: a real call needs AI_PROFILING_REPHRASE_ENABLED *and* real calls on"
        if turn.clarified
        else "straight-line turn: the endpoint passes real_call_allowed=False (COST-4), "
        "so no model is reachable here even with real calls ON"
    )
    suffix = f"; real calls are OFF ({real_calls_blocked})" if real_calls_blocked else ""
    return f"MOCK - the reply is the engine's templated question, NOT model output. {why}{suffix}"


def render_turn(
    turn: TurnResult,
    *,
    verbose: bool = False,
    local_diagnostics: bool = True,
    real_calls_blocked: str | None = None,
) -> str:
    """The per-turn trace block."""
    lines = [_RULE, f"  turn {turn.index}  (POST /profiling/respond)"]
    lines.append(_line("worker", turn.message if turn.message else "(empty string)"))
    lines.extend(_gate_lines(turn))

    if not turn.ok:
        if turn.response.status_code == 0:
            lines.append(_line("TRANSPORT", str(turn.response.body.get("detail"))))
            lines.append(
                _line("in prod", "apps/api degrades to its OWN local mock interview here "
                                 "(ai.service.ts post() -> null -> mockProfilingTurn); "
                                 "this tool does not emulate that")
            )
        else:
            lines.append(
                _line("HTTP", f"{turn.response.status_code} - the ai-service contract rejected it")
            )
            for err in turn.response.validation_errors():
                lines.append(_line("", f"{'.'.join(str(p) for p in err['loc'] or [])}: "
                                       f"{err['msg']} [{err['type']}]"))
            lines.append(
                _line("in prod", "apps/api rejects this at ITS boundary first "
                                 "(nonEmptyMessageSchema / safeTextSchema(4000)) -> 400, "
                                 "nothing stored")
            )
        lines.extend(_engine_lines(turn))
        return "\n".join(lines)

    lines.extend(_engine_lines(turn))
    if not turn.blocked:
        lines.extend(_signal_lines(turn, local_diagnostics=local_diagnostics))
        state = turn.state or {}
        lines.append(_line("answered", ", ".join(state.get("answered_topics") or []) or "(none)"))
        lines.append(_line("essentials", essentials_line(state)))
        lines.append(_line("must-ask", must_ask_line(state)))
    # RAW on purpose: this is the string the endpoint emitted and apps/api stores +
    # emits (SG-1). The worker's real name is interpolated over the
    # {{worker_name}} token LOCALLY, at print time, in the conversation line below.
    lines.append(_line("reply(raw)", turn.reply_text))
    lines.append(_line("source", source_line(turn, real_calls_blocked=real_calls_blocked)))
    lines.append(_line("ready", f"extraction_ready={turn.extraction_ready}"))
    disagreement = turn.gate_disagreement
    if disagreement:
        lines.append(_line("WARNING", f"gate disagreement - {disagreement}"))

    if verbose:
        shape = json.dumps(_redact_request(turn.request), ensure_ascii=False)
        lines.append(_line("request", shape))
        lines.append(_line("state", json.dumps(turn.state, ensure_ascii=False, default=str)))
        lines.append(_line("ai_meta", json.dumps(turn.ai_metadata, ensure_ascii=False)))
    return "\n".join(lines)


def _redact_request(request: dict[str, Any]) -> dict[str, Any]:
    """Show the request SHAPE without re-printing the message body/state blob."""
    out = dict(request)
    out["message_text"] = f"<{len(request.get('message_text') or '')} chars>"
    out["conversation_state"] = "<state>" if request.get("conversation_state") else None
    return out


# --- end-of-run panels ------------------------------------------------------


def render_extraction(result: ExtractResult, *, verbose: bool = False) -> str:
    """The HEADLINE result: what ``POST /profile/extract`` actually returned.

    This is the profile apps/api persists (``profiles.raw_profile`` +
    ``rich_profile_draft``). It is deliberately printed BEFORE any CLI-only view.
    """
    request = result.request
    transcript = str(request.get("transcript") or "")
    lines = [
        "=== PRODUCTION RESULT: POST /profile/extract ===",
        _line("request", f"{{worker_ref: <uuid>, transcript: {len(transcript)} chars / "
                         f"{len(transcript.splitlines())} lines}}"),
    ]
    if not result.ok:
        lines.append(_line("HTTP", f"{result.response.status_code}"))
        lines.append(_line("body", json.dumps(result.response.body, ensure_ascii=False)[:400]))
        return "\n".join(lines)
    lines.append(
        _line(
            "status",
            f"{result.status}  blocked={result.blocked}"
            + (f" ({result.blocked_reason})" if result.blocked_reason else "")
            + f"  is_mock={result.is_mock}",
        )
    )
    if result.blocked:
        lines.append(
            _line("meaning", "fail-closed: NO model call, EMPTY profile. apps/api stores this "
                             "as profile_status='draft'")
        )
    lines.append("")
    lines.append("  profile (DraftProfile - apps/api persists this as profiles.raw_profile):")
    lines.append(_indent(json.dumps(result.profile, indent=2, ensure_ascii=False)))
    lines.append("")
    lines.append("  worker_profile_draft (rich draft - persisted as rich_profile_draft):")
    lines.append(_indent(json.dumps(result.draft, indent=2, ensure_ascii=False)))
    if verbose:
        lines.append("")
        lines.append("  ai_metadata:")
        lines.append(_indent(json.dumps(result.ai_metadata, indent=2, ensure_ascii=False)))
    return "\n".join(lines)


def _indent(text: str, pad: str = "    ") -> str:
    return "\n".join(pad + line for line in text.splitlines())


def render_transcript(transcript: str) -> str:
    """The exact text posted to /profile/extract — worth seeing, because it is
    NOT just the worker's words (see buildTranscript)."""
    return "\n".join(
        ["=== EXTRACTION TRANSCRIPT (exactly what was posted) ==="]
        + [f"    {line}" for line in transcript.splitlines()]
    )


def render_cli_only_merge(result: ExtractResult, collected: dict[str, Any] | None) -> str:
    """CLI-ONLY DIAGNOSTIC — ``profile_extractor.merge_collected`` applied to the
    endpoint's rich draft.

    READ THIS LABEL. Production does NOT do this. ``merge_collected`` has no caller
    in ``app/`` outside this CLI: ``/profile/extract`` builds its profile from a
    context-free ``signals.detect`` pass over the transcript and never sees the
    interview's ``ConversationState.collected``. The previous CLI silently applied
    this merge and printed the result as "the" profile, which meant the terminal
    showed a profile the deployed service never produces.

    It is still worth printing, SEPARATELY and labelled, because the diff is the
    interesting part: every field listed below is one the interview attributed to a
    specific QUESTION but the production transcript re-derivation got differently
    (or missed). That gap is a real finding about the production extractor, not a
    CLI feature.
    """
    header = (
        "=== CLI-ONLY DIAGNOSTIC: merge_collected view (PRODUCTION DOES NOT PRODUCE THIS) ==="
    )
    draft = result.draft
    if not draft:
        return f"{header}\n  (no rich draft returned - nothing to compare)"
    if not collected:
        return f"{header}\n  (the interview collected nothing - the merged view is identical)"

    from ..contracts import WorkerProfileDraft
    from ..profiling import profile_extractor

    try:
        base = WorkerProfileDraft.model_validate(draft)
    except Exception as exc:  # pragma: no cover - defensive
        return f"{header}\n  (could not validate the returned draft: {exc})"
    merged = profile_extractor.merge_collected(base, dict(collected))
    before, after = base.model_dump(), merged.model_dump()
    diffs = [
        f"{key}: production={_fmt(before[key])} -> merged={_fmt(after[key])}"
        for key in before
        if before[key] != after[key]
    ]
    lines = [header, _line("collected", _pairs(dict(collected)))]
    if not diffs:
        lines.append(_line("diff", "none - the merged view matches the production profile"))
        return "\n".join(lines)
    lines.append("  fields where the QUESTION-ATTRIBUTED answer differs from what")
    lines.append("  the production transcript pass produced:")
    lines.extend(f"    - {d}" for d in diffs)
    return "\n".join(lines)
