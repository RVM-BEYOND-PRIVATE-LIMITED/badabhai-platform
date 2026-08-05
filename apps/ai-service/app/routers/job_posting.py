"""Router: POST /job-posting-chat/opening and /job-posting-chat/respond (ADR-0035).

Moved verbatim out of ``app/main.py``, together with the payer-facing
``_JOB_POSTING_BLOCKED_REPLY`` constant.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..contracts import (
    JobPostingChatOpeningInput,
    JobPostingChatOpeningOutput,
    JobPostingChatTurnInput,
    JobPostingChatTurnOutput,
)
from ..job_posting_chat import answers as job_posting_answers
from ..job_posting_chat import interview_engine as job_posting_engine
from ..pseudonymize import pseudonymize
from ..runtime import logger
from ._shared import _pseudonymization_meta

router = APIRouter()


# The PAYER-facing equivalent (ADR-0035 job-posting chat). Deliberately a separate
# constant and deliberately still English: the job-posting engine speaks English to
# payers on every turn, so handing them the worker persona's Hinglish here would be a
# tone break on a different product surface — and nothing above applies (the payer
# transcript is not a worker profiling corpus). Same fail-closed semantics.
_JOB_POSTING_BLOCKED_REPLY = (
    "Sorry, I couldn't process that safely. Please rephrase without sharing "
    "contact details like a phone number, a person's name, or a company name."
)


@router.post("/job-posting-chat/opening", response_model=JobPostingChatOpeningOutput)
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


@router.post("/job-posting-chat/respond", response_model=JobPostingChatTurnOutput)
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

    # 3. Clarify BEFORE advancing: a clarifying message ("what do you mean?") is not
    #    an answer, and next_turn would mis-advance the state (the confusing topic
    #    lands in asked_question_ids and _next_topic skips it forever, essentials
    #    included). clarify_turn refuses — None, engine runs normally — when there is
    #    nothing to re-serve, when the message carries an extractable ANSWER
    #    (answer-trumps-clarify), or when the consecutive clarify budget is spent.
    is_clarify = job_posting_engine.needs_rephrase(body.message_text)
    turn = (
        job_posting_engine.clarify_turn(
            body.conversation_state, body.message_text, body.trade_hint
        )
        if is_clarify
        else None
    )
    if turn is None:
        turn = job_posting_engine.next_turn(
            body.conversation_state,
            body.message_text,
            body.trade_hint,
            draft_text=draft_text,
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
