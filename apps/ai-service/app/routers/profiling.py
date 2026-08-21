"""The LLM-led worker interview: POST /profiling/turn and POST /profiling/extract.

This file was DELETED by the OIE Phase 8 cutover and is deliberately not a restoration of what
was here. The old version let a model run the whole interview and hold the state. This one lets
a model choose the next question inside a stretch the API bounds, and holds no state at all:
every call carries its own `stage`, `draft` and `history`, so the API remains the only thing
that knows how long an interview has run and the only thing that can end it.

WHAT COMES BACK ON EVERY FAILURE IS AN EMPTY `reply_text`. The caller has a deterministic
question ready — 101 authored packs' worth — and treats an empty reply as "you take this turn".
Blocked by the privacy gate, mock posture, a spend cap, a provider 429, malformed JSON: all one
outcome, because the caller's response to all of them is identical and a worker mid-interview
must never see any of them.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter

from ..ai import prompt_registry
from ..ai.langfuse_tracing import (
    SCORE_BOOLEAN,
    SCORE_NUMERIC,
    WORKFLOW_PROFILE_BUILD,
    WORKFLOW_PROFILE_INTERVIEW,
    get_tracer,
)
from ..config import get_settings
from ..contracts import (
    ExperienceEntry,
    InterviewExtractInput,
    InterviewExtractOutput,
    LlmTurnInput,
    LlmTurnOutput,
)
from ..profiling.canonical_roles import coerce_json_text
from ..profiling.interview_prompts import extract_system_prompt, interview_system_prompt
from ..profiling.parse_masking import mask_transcript_lines
from ..pseudonymize import pseudonymize
from ._shared import logger, resolve_prompt, router, workflow_scope

api_router = APIRouter()

TURN_TASK_TYPE = "profiling_chat_turn"
EXTRACT_TASK_TYPE = "profile_extraction"

#: Returned when anything at all goes wrong. An empty reply IS the fallback signal.
_SILENT = LlmTurnOutput(reply_text="", is_mock=True)


def _turn_messages(
    body: LlmTurnInput, masked_message: str, system_prompt: str
) -> list[dict[str, str]]:
    """System prompt + a compact rendering of where we are and what was said.

    THE SYSTEM PROMPT IS PASSED IN rather than built here, so the caller can record WHICH
    prompt version produced the reply (`ai/prompt_registry`). The text is exactly what
    `interview_system_prompt()` returns unless Langfuse prompt management is deliberately
    switched on, so nothing about the request the provider sees changes by default.

    The draft is sent back each turn rather than kept here: this service holds no session
    state, which is what makes an API-owned turn cap enforceable rather than advisory.
    """
    history = "\n".join(
        f"{'Worker' if line.role == 'worker' else 'Bada Bhai'}: {line.text}"
        for line in body.history
    )
    draft = body.draft
    state = json.dumps(
        {
            "stage": body.stage,
            "domain_label": draft.domain_label,
            "role_label": draft.role_label,
            "skills": draft.skills,
            "experiences_recorded": len(draft.experiences),
        },
        ensure_ascii=False,
    )
    closing = (
        "\n\nTHIS IS YOUR LAST TURN. Do not ask anything. Set phase_a_done true and reply with a "
        "short closing acknowledgement."
        if body.force_close
        else ""
    )
    return [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": (
                f"Conversation so far:\n{history or '(nothing yet)'}\n\n"
                f"What you have gathered: {state}\n\n"
                f"The worker just said: {masked_message or '(nothing yet - open the conversation)'}"
                f"{closing}"
            ),
        },
    ]


def _parse_turn(content: str, body: LlmTurnInput) -> LlmTurnOutput | None:
    """Model output is untrusted input (§11). `None` on anything unreadable."""
    # THROUGH `coerce_json_text` FIRST, which is not optional — its own docstring says every
    # place that parses model JSON for a profile must go through it. Claude has no strict JSON
    # mode and routinely wraps the object in a ```json fence, so a bare `json.loads` rejects a
    # perfectly good turn. Measured live: a real call came back with 102 tokens of valid content
    # and this function threw it away, which the caller then reported as "the model is
    # unavailable", falling the whole interview back to the packs.
    try:
        raw = json.loads(coerce_json_text(content))
    except (TypeError, ValueError):
        logger.warning("llm turn output was not JSON")
        return None
    if not isinstance(raw, dict):
        return None
    try:
        out = LlmTurnOutput.model_validate(raw)
    except Exception:
        # Includes an `experience_entry` carrying `employer_name`: ExperienceEntry forbids
        # extras, so the whole turn is refused rather than quietly stripped. A model that tried
        # to hand us an employer once will try again, and a silent strip hides that.
        logger.warning("llm turn output failed the contract")
        return None
    # NO STAGE NORMALIZATION HERE, and the absence is deliberate. This used to re-check
    # `out.stage` against the closed set and fall back to `body.stage` — unreachable code:
    # `LlmInterviewStage` is a `Literal`, so `model_validate` above has already refused anything
    # outside it and returned None. A stage the model invented therefore fails the whole turn,
    # which is the same fail-closed direction every other branch here takes, and the API owns
    # progression regardless: `LlmTurnService` decides `done` from its own caps, never from this.
    return out


@api_router.post("/profiling/turn", response_model=LlmTurnOutput)
async def profiling_turn(body: LlmTurnInput) -> LlmTurnOutput:
    """One Phase A turn: the model asks the next question about domain/role/skills/experience.

    Privacy order is the same as every other worker-text route and it fails CLOSED:
    pseudonymize BEFORE the model, and a blocked message never reaches a provider and never
    advances anything.
    """
    settings = get_settings()

    # ONE ROOT TRACE per turn, so the generation the router opens nests under a BUSINESS
    # operation instead of standing alone. Without it, a twelve-turn interview is twelve
    # unrelated traces and nothing says they belong to the same worker's conversation.
    #
    # NO `session_id`, deliberately. `LlmTurnInput` carries none — the API owns interview
    # state and this service holds none — and minting one here would stamp a fabricated
    # identifier on every trace that correlates nothing. What DOES tie the turns together is
    # the BL-19 correlation id `workflow_scope` reads off the request, which comes from the
    # one component that actually knows.
    with workflow_scope(
        name=WORKFLOW_PROFILE_INTERVIEW,
        worker_ref=body.worker_ref,
        # Closed-set stage id + a bool. Never worker text.
        metadata={"stage": body.stage, "force_close": body.force_close},
    ):
        masked_message = ""
        if body.message_text:
            result = pseudonymize(body.message_text)
            if result.blocked:
                logger.warning(
                    "llm turn blocked by the privacy gate",
                    extra={"extra": {"reason": result.blocked_reason}},
                )
                return LlmTurnOutput(
                    reply_text="", blocked=True, blocked_reason=result.blocked_reason, is_mock=True
                )
            masked_message = result.text

        # History is masked PER MESSAGE, not as one blob. A 20k whole-transcript gate is what
        # once blocked long interviews outright and handed the worker an empty profile —
        # punished, precisely, for answering at length.
        body = body.model_copy(update={"history": mask_transcript_lines(body.history)})

        # RESOLVED, not called, so the generation records which prompt version produced this
        # reply. `resolve_prompt` returns the LOCAL builder's text unless Langfuse prompt
        # management is explicitly enabled (off by default), and `None` only if the name was
        # never registered — hence the direct call as the fallback. Either way the bytes the
        # provider sees are `interview_system_prompt()`'s today.
        resolved = resolve_prompt(prompt_registry.INTERVIEW_TURN)
        system_prompt = resolved.text if resolved is not None else interview_system_prompt()

        try:
            content, meta = await asyncio.wait_for(
                router.run(
                    TURN_TASK_TYPE,
                    messages=_turn_messages(body, masked_message, system_prompt),
                    mock_response="{}",
                    real_call_allowed=True,
                    user_ref=body.worker_ref,
                    prompt=resolved,
                ),
                timeout=settings.profiling_turn_deadline_seconds,
            )
        except TimeoutError:
            # TimeoutError ONLY — a CancelledError means the CLIENT went away, and swallowing
            # it would turn a disconnect into a fabricated 200.
            logger.warning(
                "llm turn deadline exceeded",
                extra={"extra": {"deadline_s": settings.profiling_turn_deadline_seconds}},
            )
            return _SILENT

        if not meta.real_call:
            # A posture (mock mode, a cap, the kill switch), not an incident. No mock question
            # is invented: a fabricated interview question is worse than a deterministic real
            # one.
            return _SILENT

        out = _parse_turn(content, body)
        if out is None or not out.reply_text.strip():
            return _SILENT

        out.is_mock = False
        out.ai_metadata = meta
        return out


@api_router.post("/profiling/extract", response_model=InterviewExtractOutput)
async def profiling_extract(body: InterviewExtractInput) -> InterviewExtractOutput:
    """Phase C: the whole conversation in, the resume-shaped values out.

    Separate from `/profile/parse`, which types and cites a deterministic answer map against a
    closed field list. This one reads a conversation the model itself conducted and must
    SYNTHESISE across turns — `experiences[]` in particular has no answer-map equivalent,
    because the packs can only ask a fixed question once.
    """
    settings = get_settings()

    # ROOT TRACE. Phase C is the same business operation as the parse that may follow it —
    # building one worker's profile — so it shares `WORKFLOW_PROFILE_BUILD`, and the shared
    # BL-19 correlation id lands both in ONE trace rather than two unrelated ones.
    with workflow_scope(
        name=WORKFLOW_PROFILE_BUILD,
        worker_ref=body.worker_ref,
        # A count, not content: how long a conversation this synthesis had to read is the
        # dimension that explains its cost and its latency.
        metadata={"transcript_lines": len(body.transcript)},
    ):
        masked = mask_transcript_lines(body.transcript)
        if not masked:
            return InterviewExtractOutput(is_mock=True)

        rendered = "\n".join(
            f"{'Worker' if line.role == 'worker' else 'Bada Bhai'}: {line.text}" for line in masked
        )
        # RESOLVED, not called — see the identical note in `profiling_turn`. `None` (name never
        # registered) falls back to the local builder, so the default behaviour is unchanged.
        resolved = resolve_prompt(prompt_registry.INTERVIEW_EXTRACT)
        system_prompt = resolved.text if resolved is not None else extract_system_prompt()
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"The conversation:\n{rendered}"},
        ]

        try:
            content, meta = await asyncio.wait_for(
                router.run(
                    EXTRACT_TASK_TYPE,
                    messages=messages,
                    mock_response="{}",
                    real_call_allowed=True,
                    user_ref=body.worker_ref,
                    prompt=resolved,
                ),
                timeout=settings.profiling_extract_deadline_seconds,
            )
        except TimeoutError:
            logger.warning(
                "interview extract deadline exceeded",
                extra={"extra": {"deadline_s": settings.profiling_extract_deadline_seconds}},
            )
            return InterviewExtractOutput(is_mock=True)

        if not meta.real_call:
            return InterviewExtractOutput(is_mock=True)

        # EVERY SCORE BELOW THIS LINE IS ON A REAL CALL BY CONSTRUCTION — the branch directly
        # above returns on a mock posture, so no `meta.real_call` re-check is needed and adding
        # one would be dead code. A mock call measures nothing and must score nothing.
        tracer = get_tracer()

        try:
            # Same fence tolerance as the turn parser above, and for the same reason.
            raw = json.loads(coerce_json_text(content))
            out = InterviewExtractOutput.model_validate(raw if isinstance(raw, dict) else {})
        except Exception:
            logger.warning("interview extract output failed the contract")
            # The one branch where the model's body could not be read as the contract. Recorded
            # as a score rather than only a log line so "how often does this model produce an
            # off-contract extract?" is answerable per prompt version. No exception text: a
            # Pydantic error echoes the input, and the input is worker-derived.
            tracer.record_score(
                name="interview_extract_contract_valid",
                value=False,
                data_type=SCORE_BOOLEAN,
            )
            return InterviewExtractOutput(is_mock=True, ai_metadata=meta)

        tracer.record_score(
            name="interview_extract_contract_valid", value=True, data_type=SCORE_BOOLEAN
        )

        # COUNTED BEFORE THE PASS MUTATES `out`. The certification below drops in place, so the
        # "proposed" side of the ratio does not exist afterwards — and an estimate would make
        # the score a guess about a wall whose whole value is that it is mechanical.
        proposed = _certifiable_item_count(out)

        # Re-certify every surviving string. The model read a masked transcript, but it composes
        # new text (`work_done`, skill phrases) and composed text is not covered by the input
        # gate.
        #
        # EVERY STRING FIELD, not just these two (#831). `experiences` and `skills` were
        # certified here and the other six were not, which read as a complete gate and was not
        # one: every remaining field is model-composed FREE TEXT (`shift` and `availability` are
        # `str | None` capped at 40 chars, the rest at 120 — none is an enum), so each can carry
        # exactly what this step exists to catch.
        #
        # THAT WAS NOT THEORETICAL. `shift` is read by `resume-render-input.ts::fromResumeProfile`
        # with no audience distinction, so an uncertified value reaches the EMPLOYER-facing masked
        # disclosure PDF — a cross-party surface — as well as the worker's own. Certifying at the
        # source is what makes the guarantee inheritable: the text résumé, the worker PDF and the
        # employer PDF each read this container, and one gate here beats three read-sites
        # re-implementing it and drifting.
        out.experiences = [e for e in out.experiences if _certified(e)]
        out.skills = _certified_list(out.skills)
        out.preferred_locations = _certified_list(out.preferred_locations)
        out.domain_label = _certified_scalar(out.domain_label)
        out.role_label = _certified_scalar(out.role_label)
        out.shift = _certified_scalar(out.shift)
        out.current_city = _certified_scalar(out.current_city)
        out.availability = _certified_scalar(out.availability)
        # `expected_salary` is a float and carries no free text, so there is nothing to certify.

        if proposed:
            # WHAT SURVIVED THE CERTIFICATION WALL, as a fraction. A real measurement: both
            # sides are counted off the same container, before and after the pass that drops
            # from it. A falling ratio means the model is composing text the gateway will not
            # vouch for — the signal a prompt regression would show up as first.
            #
            # SKIPPED WHEN NOTHING WAS PROPOSED. A ratio over an empty set is not a
            # measurement, and recording 0/0 as either 0.0 or 1.0 would move the average by
            # inventing a data point. It also keeps the division out of an unguarded route
            # handler — `record_score` is fail-open, but the arithmetic at this call site is
            # not inside that boundary.
            surviving = _certifiable_item_count(out)
            tracer.record_score(
                name="interview_extract_certified_ratio",
                value=surviving / proposed,
                data_type=SCORE_NUMERIC,
                # Counts only. Never an item, never a dropped value.
                comment=f"{surviving}/{proposed} certifiable items survived",
            )

        out.is_mock = False
        out.ai_metadata = meta
        return out


def _certifiable_item_count(out: InterviewExtractOutput) -> int:
    """How many items on `out` the certification pass is able to drop, right now.

    EXACTLY the fields `profiling_extract` certifies and no others — the three lists plus the
    five `str | None` scalars — so calling this before and after the pass yields a
    before/after over the SAME population. `expected_salary` is excluded because it is a float
    the pass never touches, and counting an item that can never be dropped would silently
    inflate the ratio toward 1.0 on every call.

    A `None` scalar was never proposed, so it is not counted on the "before" side either; that
    is what stops an absent field from reading as a rejected one.
    """
    return (
        len(out.experiences)
        + len(out.skills)
        + len(out.preferred_locations)
        + sum(
            1
            for value in (
                out.domain_label,
                out.role_label,
                out.shift,
                out.current_city,
                out.availability,
            )
            if value is not None
        )
    )


def _certified(entry: ExperienceEntry) -> bool:
    """Drop an experience whose composed prose carries something the gateway will not mask.
    Dropping one entry costs coverage; keeping it costs the worker their credibility."""
    return not any(
        pseudonymize(text).blocked
        for text in (entry.role_label, entry.duration_text, entry.work_done)
        if text
    )


def _certified_list(values: list[str]) -> list[str]:
    """Keep only the entries the gateway will vouch for. Drops per ITEM rather than emptying the
    list, so one bad skill never costs a worker the other four."""
    return [v for v in values if not pseudonymize(v).blocked]


def _certified_scalar(value: str | None) -> str | None:
    """`None` for a value the gateway will not vouch for — fail closed (CLAUDE.md §3).

    NULL RATHER THAN A MASKED STRING, deliberately. `pseudonymize` returns a masked rendering,
    and writing that back would put "[PHONE]" on a worker's résumé under `Shift` — visible,
    unexplained, and worse than the field simply being absent. Every consumer already renders
    these as optional (they are `| None` in the contract and nullable in Zod), so absence is a
    shape they all handle; a mask token is not.
    """
    if value is None:
        return None
    return None if pseudonymize(value).blocked else value
