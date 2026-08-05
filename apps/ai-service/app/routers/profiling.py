"""Router: POST /profiling/opening and POST /profiling/respond — the worker chat.

Moved verbatim out of ``app/main.py``, together with the worker-facing
``_BLOCKED_REPLY`` constant.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..config import get_settings
from ..contracts import (
    ConversationMessage,
    ConversationState,
    ProfilingOpeningInput,
    ProfilingOpeningOutput,
    ProfilingTurnInput,
    ProfilingTurnOutput,
)
from ..profiling import persona_guard, rfs
from ..profiling.opener import one_shot_opener_for
from ..profiling.prompts import build_chat_messages
from ..profiling.turn_schema import coerce_turn, fallback_turn, fallback_turn_json
from ..pseudonymize import pseudonymize
from ..runtime import logger
from ..runtime import router as ai_router
from ._shared import _pseudonymization_meta

router = APIRouter()


# The WORKER-facing pseudonymization-blocked reply.
#
# WHY THE COPY MATTERS MORE THAN A NORMAL ERROR STRING: apps/api STORES this as an
# outbound chat message, so it lands in the worker's transcript and therefore in the
# EXTRACTION CORPUS — it is not a toast that disappears. It was English ("Sorry, I
# couldn't process that safely. Please rephrase without sharing personal details like
# your phone number, full name, or company name.") in a Hinglish, chat-first product,
# from a bot that speaks Hinglish on every other turn.
#
# The persona rules it now satisfies, each pinned by test_persona_neutrality
# (_worker_facing_strings carries this string, so the whole banned-token net applies):
#   * "aap" form, never "tu"/"tum";
#   * NO vocative — never bhai / bhaiya / beta / behen / yaar;
#   * no exclamation mark, no emoji, two short sentences;
#   * it tells the worker WHAT TO DO DIFFERENTLY and says nothing about our internals
#     (no "safely", no "processing", no mention of a gateway or a rule).
#
# Aligned in tone with the Flutter sibling `kChatBlockedNotice`
# ("Aapki baat theek se nahi pahunch payi — thoda saaf karke dobara likhein.") — the
# two are DELIBERATELY not byte-identical: the client string is a generic
# transport/parse notice, this one is served when the privacy gateway blocked the turn,
# so it names the two things that most often cause it. It never says WHY in our terms.
_BLOCKED_REPLY = (
    "Aapki baat theek se nahi pahunch payi. "
    "Phone number ya poora naam likhe bina dobara bhejiye."
)


@router.post("/profiling/opening", response_model=ProfilingOpeningOutput)
async def profiling_opening(body: ProfilingOpeningInput) -> ProfilingOpeningOutput:
    """The ONE-SHOT opener text — an invitation to answer everything in one message.

    Unconditional and pure on purpose: this route always serves the opener, and the
    decision of whether a worker SEES it lives in apps/api behind
    CHAT_ONE_SHOT_OPENER_ENABLED. Putting the flag here instead would leave a dead
    branch that no test exercises, and could not make "off" mean what it has to mean
    — that /chat/session takes no network hop at all.

    No model call, no pseudonymization: the response is a module constant. The
    opener carries no vocative, so nothing worker-identifying passes through here.
    """
    return ProfilingOpeningOutput(opening_text=one_shot_opener_for(body.role_family))


@router.post("/profiling/respond", response_model=ProfilingTurnOutput)
async def profiling_respond(body: ProfilingTurnInput) -> ProfilingTurnOutput:
    """One LLM-driven interview turn.

    The deterministic question bank is gone. The model conducts the interview for
    whatever trade the worker actually does; this handler owns everything the model is
    not allowed to decide: the privacy gate, the turn budget, whether the interview is
    over, and whether the reply is on-persona.

    ORDER IS THE CONTRACT:
      1. pseudonymize EVERY worker-derived surface, fail closed
      2. call the model
      3. guard the reply, repair once, else fall back
      4. merge what was captured; the SERVICE decides completion, not the model
    """
    settings_now = get_settings()
    prior = body.conversation_state
    role_family = (prior.role_family if prior else None) or body.role_family
    turn_index = (prior.turn_count if prior else 0) + 1

    # 1. Pseudonymize FIRST — the gate for any external LLM call, and it now covers
    #    FIVE worker-derived surfaces, not one. The old handler only had `message_text`
    #    to gate because history was never sent; re-arming history widened the egress
    #    surface, so every leg is masked and ANY blocked leg fails the whole turn
    #    closed. A partially-masked transcript must never reach a provider.
    result = pseudonymize(body.message_text)
    masked_history: list[ConversationMessage] = []
    history_blocked = False
    for msg in body.history:
        leg = pseudonymize(msg.text)
        if leg.blocked:
            history_blocked = True
            break
        masked_history.append(ConversationMessage(role=msg.role, text=leg.text))

    masked_captured: dict[str, str] = {}
    captured_blocked = False
    for key, value in (prior.captured if prior else {}).items():
        leg = pseudonymize(value)
        if leg.blocked:
            captured_blocked = True
            break
        masked_captured[key] = leg.text

    if result.blocked or history_blocked or captured_blocked:
        logger.warning(
            "profiling blocked",
            extra={
                "extra": {
                    "reason": result.blocked_reason or "history_or_state_blocked",
                    "leg": "message"
                    if result.blocked
                    else ("history" if history_blocked else "captured"),
                }
            },
        )
        return ProfilingTurnOutput(
            reply_text=_BLOCKED_REPLY,
            blocked=True,
            blocked_reason=result.blocked_reason or "blocked",
            is_mock=True,
            # State is returned UNCHANGED on a blocked turn: nothing was learned, and
            # advancing the turn counter would spend one of the worker's turns on a
            # message the model never saw.
            updated_state=prior,
            pseudonymization_metadata=_pseudonymization_meta(result),
        )

    # 2. Ask the model. `mock_response` is a VALID TURN in its own right now — with the
    #    question bank deleted there is no templated question behind the router's
    #    never-raise contract, so the fallback has to be JSON of the same shape. One
    #    parse path, no "prose or JSON?" branch.
    missing_before = rfs.missing_required(masked_captured, settings_now)
    window = settings_now.profiling_history_max_turns
    # A turn is a worker+assistant pair, so the window is doubled into messages. The
    # bound exists because re-sending the transcript every turn is O(n^2) input cost —
    # exactly why history used to be dropped entirely. Windowing keeps the follow-ups
    # the interview needs while capping a pathological 40-turn session.
    windowed = masked_history[-(window * 2) :] if window > 0 else masked_history

    def _messages(repair: str | None = None) -> list[dict[str, str]]:
        return build_chat_messages(
            settings=settings_now,
            history=windowed,
            worker_message=result.text,
            role_family=role_family,
            captured=masked_captured,
            missing=missing_before,
            turn_index=turn_index,
            force_complete=body.force_complete,
            repair=repair,
        )

    fallback_json = fallback_turn_json(missing_before[0] if missing_before else None)
    reply_raw, meta = await ai_router.run(
        "profiling_chat_turn",
        messages=_messages(),
        mock_response=fallback_json,
        real_call_allowed=body.real_call_allowed,
        user_ref=body.worker_ref,
    )

    turn = coerce_turn(reply_raw) or fallback_turn(
        missing_before[0] if missing_before else None
    )

    # 3. The persona guard. Most of the persona spec is mechanically checkable, and a
    #    prompt is a request rather than a guarantee — the deterministic engine never
    #    needed this because its questions were hand-written strings. On a violation we
    #    spend ONE repair call quoting the specific broken rule; if that also fails the
    #    worker gets a safe templated turn rather than an off-persona one.
    guard_violations: list[str] = []
    if settings_now.profiling_persona_guard_enabled:
        prior_replies = [m.text for m in masked_history if m.role == "assistant"]
        # Hoisted so the FIRST check and the repair RE-CHECK ask exactly the same
        # question. They did not: the re-check omitted these two and fell back to
        # `appreciations_used=0, previous_had_appreciation=False`, under which the
        # "appreciation budget spent" and "two in a row" rules CANNOT fire. A model told
        # to fix three violations at once would fix the mechanical ones, keep the
        # appreciation, and pass a re-check that was blind to the only rule it still
        # broke — serving an off-persona line at double the cost.
        appreciations_used = persona_guard.count_appreciations(prior_replies)
        previous_had_appreciation = (
            bool(prior_replies) and persona_guard.count_appreciations(prior_replies[-1:]) > 0
        )

        def _check(reply: str, asked_field: str | None):
            return persona_guard.check_turn(
                reply,
                max_words=settings_now.profiling_max_reply_words,
                turn_index=turn_index,
                appreciations_used=appreciations_used,
                previous_had_appreciation=previous_had_appreciation,
                already_captured=frozenset(masked_captured),
                asked_field=asked_field,
            )

        check = _check(turn.reply, turn.asked_field)
        attempts = settings_now.profiling_persona_repair_retries
        while not check.ok and attempts > 0:
            guard_violations.extend(check.violations)
            logger.info(
                "persona guard repair",
                # CODES, never `check.violations`. One violation message interpolates a
                # slice of the model's own reply (the acknowledgement it invented), and
                # that branch fires precisely when the model paraphrased back what the
                # worker just said. `codes` is a closed vocabulary and content-free by
                # construction. The messages still go to the MODEL via
                # `repair_instruction` — that path is already masked and is the whole
                # point of the retry.
                extra={"extra": {"codes": check.codes, "turn": turn_index}},
            )
            repaired_raw, repair_meta = await ai_router.run(
                "profiling_chat_turn",
                messages=_messages(persona_guard.repair_instruction(check)),
                mock_response=fallback_json,
                real_call_allowed=body.real_call_allowed,
                user_ref=body.worker_ref,
            )
            repaired = coerce_turn(repaired_raw)
            attempts -= 1
            if repaired is None:
                break
            meta = repair_meta
            check = _check(repaired.reply, repaired.asked_field)
            if check.ok:
                turn = repaired
                break
        if not check.ok:
            # Still off-persona after the repair budget. A safe templated turn beats
            # serving a worker a line that breaks the voice — and it advances nothing,
            # so no topic is lost.
            guard_violations.extend(check.violations)
            logger.warning(
                "persona guard fallback",
                # Codes, never the messages — see the repair log above.
                extra={"extra": {"codes": check.codes, "turn": turn_index}},
            )
            turn = fallback_turn(missing_before[0] if missing_before else None)

    # 4. Merge what the model captured. The field vocabulary is CLOSED — an invented
    #    field id is dropped and counted, never stored, the same fail-safe posture the
    #    extraction path takes with model-invented taxonomy ids.
    kept, dropped = rfs.normalize_captured(turn.captured, settings_now)
    if dropped:
        logger.info("dropped unknown captured fields", extra={"extra": {"fields": dropped}})
    merged = {**masked_captured, **kept}
    missing_after = rfs.missing_required(merged, settings_now)

    # 5. COMPLETION IS THE SERVICE'S DECISION, never the model's. `is_complete` from the
    #    model is advisory: told "say when you have enough", a model will say so on turn
    #    two for a terse worker, and completion is irreversible downstream (it triggers
    #    the flush, the domain match and the resume). So it is honoured ONLY when every
    #    required field is actually present. The turn cap overrides everything — that is
    #    what bounds per-worker cost.
    cap_fired = body.force_complete or turn_index >= settings_now.profiling_max_turns
    fields_done = not missing_after
    extraction_ready = cap_fired or (turn.is_complete and fields_done) or fields_done
    completion_reason = (
        "turn_cap" if cap_fired and not fields_done
        else "fields_complete" if fields_done
        else None
    )

    updated_state = ConversationState(
        role_family=role_family,
        turn_count=turn_index,
        collected=prior.collected if prior else {},
        captured=merged,
        completion_reason=completion_reason,
        unanswered_essentials=missing_after,
    )
    asked_id = turn.asked_field

    return ProfilingTurnOutput(
        reply_text=turn.reply,
        blocked=False,
        # THE CHIPS. Same field the deterministic bank used to fill from a hardcoded
        # per-topic list, so the Flutter client renders them unchanged — but they are
        # now written by the model for the question it actually asked, which is what
        # makes tap-to-answer work for a trade nobody wrote a question pack for.
        suggested_followups=turn.chips,
        is_mock=not meta.real_call,
        asked_question_id=asked_id,
        extraction_ready=extraction_ready,
        updated_state=updated_state,
        ai_metadata=meta,
        pseudonymization_metadata=_pseudonymization_meta(result),
    )
