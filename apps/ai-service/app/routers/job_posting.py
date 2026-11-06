"""The payer job-posting chat (ADR-0035): POST /job-posting-chat/{opening,respond}."""

from __future__ import annotations

import asyncio
import json
import re

from fastapi import APIRouter
from pydantic import ValidationError

from ..ai import prompt_registry
from ..ai.langfuse_tracing import WORKFLOW_TAXONOMY
from ..config import get_settings
from ..contracts import (
    JobDescriptionDraftInput,
    JobDescriptionDraftOutput,
    JobPostingChatOpeningInput,
    JobPostingChatOpeningOutput,
    JobPostingChatTurnInput,
    JobPostingChatTurnOutput,
)
from ..job_posting_chat import answers as job_posting_answers
from ..job_posting_chat import interview_engine as job_posting_engine
from ..job_posting_chat.description_prompt import job_description_draft_prompt
from ..llm_input_policy import llm_input_gate
from ..output_floor import carries_hard_identifier
from ..profiling.canonical_roles import coerce_json_text
from ..pseudonymize import is_certified_clean, pseudonymize
from ._shared import _pseudonymization_meta, logger, resolve_prompt, router, workflow_scope

api_router = APIRouter()


# The PAYER-facing equivalent (ADR-0035 job-posting chat). Deliberately a separate
# constant and deliberately still English: the job-posting engine speaks English to
# payers on every turn, so handing them the worker persona's Hinglish here would be a
# tone break on a different product surface — and nothing above applies (the payer
# transcript is not a worker profiling corpus). Same fail-closed semantics.
_JOB_POSTING_BLOCKED_REPLY = (
    "Sorry, I couldn't process that safely. Please rephrase without sharing "
    "contact details like a phone number, a person's name, or a company name."
)


@api_router.post("/job-posting-chat/opening", response_model=JobPostingChatOpeningOutput)
async def job_posting_chat_opening(
    body: JobPostingChatOpeningInput,
) -> JobPostingChatOpeningOutput:
    """The payer-facing opening line (ADR-0035).

    Unconditional and pure, mirroring /profiling/opening: this route always serves
    the opener and the decision of whether a payer SEES it lives in apps/api. No
    model call and no pseudonymization — the response is a module constant.

    PII-free by construction: the opener carries no vocative, no payer name and no
    organisation name (§Decision 3 — the org name is stamped server-side at publish
    and never enters this service).
    """
    return JobPostingChatOpeningOutput(
        opening_text=job_posting_engine.opening_message(body.trade_hint)
    )


@api_router.post("/job-posting-chat/respond", response_model=JobPostingChatTurnOutput)
async def job_posting_chat_respond(body: JobPostingChatTurnInput) -> JobPostingChatTurnOutput:
    """One payer turn of the job-posting interview (ADR-0035).

    Structurally identical to /profiling/respond, with the privacy order IDENTICAL
    and one deliberate difference (step 3).
    """
    # 1. Pseudonymize FIRST — the gate for any external LLM call, and it fails CLOSED.
    #    It runs even though the payer is describing a job rather than themselves: a
    #    payer can absolutely type their own phone number, a plant manager's name, or
    #    an applicant's name into free text, and the privacy gateway does not get an
    #    exemption based on who the principal is (§2 #3, ADR-0035 §Decision 2). It
    #    also runs BEFORE the engine, so a blocked turn never advances the interview
    #    and never touches the draft.
    result = pseudonymize(body.message_text)
    if result.blocked:
        logger.warning(
            "job posting chat blocked", extra={"extra": {"reason": result.blocked_reason}}
        )
        return JobPostingChatTurnOutput(
            reply_text=_JOB_POSTING_BLOCKED_REPLY,
            blocked=True,
            blocked_reason=result.blocked_reason,
            is_mock=True,
            # Both null: nothing was parsed, so the caller keeps the state and draft
            # it already had. The turn is a no-op by construction.
            draft=None,
            updated_state=None,
            pseudonymization_metadata=_pseudonymization_meta(result),
        )

    # 2. The text the DRAFT may keep. Raw by default — a job's city and pay figures
    #    are the point of the posting and are masked before an LLM call but must
    #    survive onto the draft. Masked when this turn carried IDENTITY-class content
    #    (phone/person/employer/id), so a phone number typed into a description can
    #    never reach the stored draft or a published posting.
    draft_text = job_posting_answers.safe_draft_text(
        body.message_text, result.text, result.placeholder_tokens
    )
    #    The ONE thing the raw answer may still feed when identity was masked: the pay parser,
    #    on the pay question, when the gateway's only finding was a dashed pay range it calls a
    #    phone (#1731). Never the draft text, never another topic.
    asked = body.conversation_state.asked_question_ids if body.conversation_state else []
    pay_text = (
        job_posting_answers.pay_text_for(body.message_text, result.placeholder_tokens)
        if asked and asked[-1] == "pay_range"
        else None
    )

    # 3. Clarify BEFORE advancing: a clarifying message ("what do you mean?") is not
    #    an answer, and next_turn would mis-advance the state (the confusing topic
    #    lands in asked_question_ids and _next_topic skips it forever, essentials
    #    included). clarify_turn refuses — None, engine runs normally — when there is
    #    nothing to re-serve, when the message carries an extractable ANSWER
    #    (answer-trumps-clarify), or when the consecutive clarify budget is spent.
    is_clarify = job_posting_engine.needs_rephrase(body.message_text)
    turn = (
        job_posting_engine.clarify_turn(body.conversation_state, body.message_text, body.trade_hint)
        if is_clarify
        else None
    )
    if turn is None:
        turn = job_posting_engine.next_turn(
            body.conversation_state,
            body.message_text,
            body.trade_hint,
            draft_text=draft_text,
            pay_text=pay_text,
        )
    reply_text, asked_id, updated_state, draft_ready = turn

    # 4. ZERO LLM CALLS, on every path — the one place this route deviates from
    #    /profiling/respond, and it deviates in the cheaper direction. The engine has
    #    already produced a short, on-tone, employer-facing question, so the reply is
    #    returned verbatim: no router round-trip, no tokens, no cost. The rephrase
    #    seam (prompts.build_job_posting_chat_messages) is written and documented but
    #    NOT wired, because AIRouter.run resolves the task route first and RAISES on
    #    an unknown task type — registering `job_posting_chat_turn` in
    #    app/ai/model_config.py plus a rephrase settings flag is the follow-up that
    #    turns it on. `is_mock=True` and `ai_metadata=None` are therefore the honest
    #    values, not placeholders.
    return JobPostingChatTurnOutput(
        reply_text=reply_text,
        blocked=False,
        # Chips are ANSWERS to the question in `reply_text`, keyed on the topic
        # actually being asked this turn — `None` on the wrap-up turn yields none.
        suggested_answers=job_posting_engine.suggested_answers(asked_id, body.trade_hint),
        is_mock=True,
        asked_question_id=asked_id,
        draft_ready=draft_ready,
        draft=job_posting_engine.build_draft(updated_state, body.trade_hint),
        updated_state=updated_state,
        pseudonymization_metadata=_pseudonymization_meta(result),
    )


#: The voice-toggle draft call. CHEAP + JSON, like the work-history polish it
#: mirrors — rephrasing under prohibitions, not open composition. Real only when
#: `AI_REAL_CALL_TASKS` names it; leaving it out IS the kill switch (same
#: posture as `work_history_polish`).
DESCRIPTION_DRAFT_TASK_TYPE = "job_description_draft"

#: Hard wall matching the `job_postings.description` column (DTO DESCRIPTION_MAX).
DESCRIPTION_DRAFT_MAX = 2000

_DIGIT_RUN = re.compile(r"\d+")
_PLACEHOLDER = re.compile(r"\[[A-Z]+_\d+\]")


def _strip_delimiters(text: str) -> str:
    """Keep the tagged span from breaking out of its tag (same defence as polish)."""
    return text.replace("<", " ").replace(">", " ")


def _context_label(value: str | None, *, fallback: str, raw: bool) -> str:
    """A poster-typed context label the model may read: clean or the literal fallback.

    The polish route's `_polish_role` shape. The trade and role arrive on the same
    form as the voice note and carry the same threat ("Operator, Ramesh sir ke
    under" reached the model verbatim once the gateway's carve-outs stopped
    minting an incidental placeholder for the leading word) — so they are held to
    the same CLEAN OR NOT AT ALL test, and the fallback is a literal rather than
    masked text. Reads no flag either way.
    """
    if not value or not value.strip():
        return fallback
    if raw:
        return fallback if llm_input_gate(value, raw=raw).blocked else value.strip()
    return value.strip() if is_certified_clean(value) else fallback


def _digits_are_grounded(drafted: str, source: str) -> bool:
    """Every digit run in the output must already exist in what the model saw."""
    grounded = set(_DIGIT_RUN.findall(source))
    return all(run in grounded for run in _DIGIT_RUN.findall(drafted))


@api_router.post("/job-posting/description/draft", response_model=JobDescriptionDraftOutput)
async def job_description_draft(body: JobDescriptionDraftInput) -> JobDescriptionDraftOutput:
    """Draft ONE job description from a Hinglish voice note, filtered to trade + role.

    The voice toggle on the Perks & Details step (payer-app + payer-web share
    this contract). The poster speaks Hinglish; the model returns professional
    English for the worker job card, keeping ONLY what belongs to the posting's
    trade and role: an all-irrelevant transcript returns null, a partly
    relevant one keeps the relevant part.

    NULL IS THE SAFE ANSWER, as on the polish route: blocked input, mock
    posture, deadline, unreadable body, ungrounded digit, placeholder echo, or
    a draft the gateway will not vouch for. The caller keeps the poster's own
    text in every one of those cases.
    """
    settings = get_settings()
    raw_pii = settings.ai_raw_pii_enabled

    with workflow_scope(
        name=WORKFLOW_TAXONOMY,
        metadata={"spoken_chars": len(body.spoken_text)},
    ):
        # THE INPUT GATE. The poster dictated this and it routinely carries a
        # name, a company or a phone — the gateway exists for exactly this
        # text. A blocked input is not rewritten at all: masking it and
        # rewriting the mask would put "[EMPLOYER_1]" on a worker's job card.
        masked = llm_input_gate(body.spoken_text, raw=raw_pii)
        if masked.blocked:
            logger.warning("job-description draft skipped: the input did not clear the gateway")
            return JobDescriptionDraftOutput(is_mock=True)

        resolved = resolve_prompt(prompt_registry.JOB_DESCRIPTION_DRAFT)
        system_prompt = resolved.text if resolved is not None else job_description_draft_prompt()
        trade = _context_label(body.trade_label, fallback="unspecified trade", raw=raw_pii)
        role = _context_label(body.role_label, fallback="worker", raw=raw_pii)
        messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                # DELIMITED: the spoken text is DATA, never instructions (same
                # defence as the polish route's <work_done> tags).
                "content": (
                    f"<trade>{_strip_delimiters(trade)}</trade>\n"
                    f"<role>{_strip_delimiters(role)}</role>\n"
                    f"<spoken_text>{_strip_delimiters(masked.text)}</spoken_text>"
                ),
            },
        ]

        try:
            content, meta = await asyncio.wait_for(
                router.run(
                    DESCRIPTION_DRAFT_TASK_TYPE,
                    messages=messages,
                    mock_response='{"description": null}',
                    real_call_allowed=True,
                    user_ref=body.payer_ref,
                    prompt=resolved,
                ),
                timeout=settings.profiling_extract_deadline_seconds,
            )
        except TimeoutError:
            logger.warning("job-description draft deadline exceeded")
            return JobDescriptionDraftOutput(is_mock=True)

        if not meta.real_call:
            return JobDescriptionDraftOutput(is_mock=True)

        try:
            raw = json.loads(coerce_json_text(content))
            out = JobDescriptionDraftOutput.model_validate(raw if isinstance(raw, dict) else {})
        except (json.JSONDecodeError, ValidationError, ValueError, TypeError):
            logger.warning("job-description draft output failed the contract")
            return JobDescriptionDraftOutput(is_mock=True, ai_metadata=meta)

        drafted = (out.description or "").strip()
        if not drafted:
            # The model declined — licensed by the prompt (all-irrelevant
            # input). Not a failure.
            return JobDescriptionDraftOutput(description=None, ai_metadata=meta)

        # WALLS (same shape as the polish route, with the posting's length cap):
        # length, placeholder echo, digit grounding, gateway re-certification,
        # plus the hard-identifier floor (ADR-0047 G1).
        if len(drafted) > DESCRIPTION_DRAFT_MAX:
            logger.warning("job-description draft rejected: over length")
            return JobDescriptionDraftOutput(description=None, ai_metadata=meta)
        if _PLACEHOLDER.search(drafted):
            logger.warning("job-description draft rejected: it echoed a gateway placeholder")
            return JobDescriptionDraftOutput(description=None, ai_metadata=meta)
        if not _digits_are_grounded(drafted, _PLACEHOLDER.sub(" ", masked.text)):
            logger.warning("job-description draft rejected: it introduced a number")
            return JobDescriptionDraftOutput(description=None, ai_metadata=meta)
        if pseudonymize(drafted).blocked:
            logger.warning("job-description draft rejected: the draft did not clear the gateway")
            return JobDescriptionDraftOutput(description=None, ai_metadata=meta)
        if carries_hard_identifier(drafted):
            logger.warning("job-description draft rejected: the draft carried a hard identifier")
            return JobDescriptionDraftOutput(description=None, ai_metadata=meta)

        return JobDescriptionDraftOutput(description=drafted, ai_metadata=meta)
