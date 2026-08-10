"""Voice notes: POST /voice/transcribe."""

from __future__ import annotations

from fastapi import APIRouter

from ..ai.langfuse_tracing import TRANSCRIBE, TRANSLATE, LangfuseTracer, Observation, get_tracer
from ..contracts import TranscriptionInput, TranscriptionOutput
from ..pseudonymize import pseudonymize
from ._shared import logger, settings, stt_adapter, translate_adapter

api_router = APIRouter()

# THE PRIVACY LINE THIS MODULE TRACES ON, stated once so both hops below can point at
# it. `transcript_text` and `english_text` are RAW worker free-text (contracts.py says
# so, and the log statement at the bottom of this handler already refuses to print
# them). Langfuse is egress like any other, so the rule is:
#
#   record what the PROVIDER was sent, when that payload is already pseudonymized;
#   never record the worker's own speech.
#
# In practice: the STT hop sends AUDIO — unmaskable by nature, so nothing of its input
# or output text is traced, only shape (duration, chunks, confidence, lengths, the
# closed-set error code). The translate hop sends `translate_gate.text`, which the
# gate above it has already masked, so THAT is traced verbatim — it is exactly what
# left the process, which is the whole point of having a trace.


@api_router.post("/voice/transcribe", response_model=TranscriptionOutput)
async def voice_transcribe(body: TranscriptionInput) -> TranscriptionOutput:
    tracer = get_tracer()
    with tracer.task(
        task_type="voice_transcription",
        # The storage reference is an opaque path, never worker text (contracts.py).
        input={
            "storage_path": body.storage_path,
            "duration_seconds": body.duration_seconds,
            "language_code": body.language_code,
            "translate_to_english": body.translate_to_english,
        },
        user_ref=body.worker_ref,
        real_call=body.real_call_allowed and stt_adapter.real_enabled,
        metadata={"voice_note_id": body.voice_note_id},
    ) as task:
        return await _transcribe(body, task, tracer)


async def _transcribe(
    body: TranscriptionInput, task: Observation, tracer: LangfuseTracer
) -> TranscriptionOutput:
    """The handler body, split out only so the trace root above can wrap it whole
    without re-indenting (and re-reviewing) every privacy comment in it."""
    # Mock by default; the real Sarvam call is gated behind AI_ENABLE_REAL_CALLS
    # (+ key) and fails closed. The adapter never sends audio on the mock path.
    # 30-120s notes ride the chunked-sync path inside the adapter (D-2);
    # worker_ref attributes the per-chunk spend to the TD27 per-user daily cap.
    with tracer.observation(
        name=TRANSCRIBE,
        as_type="generation",
        model=settings.sarvam_stt_model,
        input={
            "duration_seconds": body.duration_seconds,
            "language_code": body.language_code,
        },
    ) as stt_obs:
        result = await stt_adapter.transcribe(
            storage_path=body.storage_path,
            duration_seconds=body.duration_seconds,
            language_code=body.language_code,
            real_call_allowed=body.real_call_allowed,
            worker_ref=body.worker_ref,
        )
        stt_obs.update(
            # SHAPE ONLY — see the privacy line at the top of this module.
            output={
                "transcript_chars": len(result.transcript_text),
                "confidence": result.confidence,
                "language_code": result.language_code,
                "is_mock": result.is_mock,
                "error_code": result.error_code,
            },
            # `chunk_count` is what a 120s note costs: one provider call per chunk.
            # It is the only place the per-note spend is visible, since the adapter
            # keeps it off `TranscriptionOutput` deliberately.
            metadata={"chunk_count": result.chunk_count},
            # An adapter that failed closed returns an EMPTY transcript with a 200,
            # which is indistinguishable from silence unless the trace says so.
            level="WARNING" if result.error_code else "DEFAULT",
            status_message=result.error_code,
        )
    # Translate the transcript to English (gated, mock-by-default, fail-closed).
    # The adapter skips English sources and returns empty english on any failure.
    #
    # PSEUDONYMIZE GATE — this leg used to hand `result.transcript_text` to
    # `translate_adapter.translate` RAW AND VERBATIM, and `translate.py` says so in its
    # own module docstring ("the real /translate call sends the RAW transcript (which
    # may contain PII) to Sarvam"). Documented is not gated: it was an ungated
    # worker-free-text egress to an external provider, on the one route where the
    # worker is SPEAKING — the surface most likely to carry a name, a phone number and
    # an employer in one breath.
    #
    # THE STT HOP ABOVE IS DIFFERENT AND IS NOT TOUCHED: its input is AUDIO, which
    # cannot be pseudonymized, and that exposure is inherent and already recorded
    # (stt.py). This gate covers the TEXT hop, which is the one that can be masked.
    #
    # FAIL CLOSED, consistently: on `blocked` the provider is not called and
    # `english_text` stays "" — the exact degraded value the adapter already returns
    # on any translation failure, so the OUTPUT SHAPE and every downstream consumer
    # are unchanged. `transcript_text` returned below is the RAW transcript exactly as
    # before: this route's job is to give the worker their own words back, and those
    # words go to `voice_notes` inside our own boundary, not to a provider.
    english_text = ""
    if body.translate_to_english and result.transcript_text.strip():
        translate_gate = pseudonymize(result.transcript_text)
        if translate_gate.blocked:
            logger.warning(
                "voice translation blocked before the provider",
                extra={"extra": {"reason": translate_gate.blocked_reason}},
            )
            # A refusal is an OUTCOME, not an absence. Traced with no text at all: a
            # blocked payload is by definition the one holding the residual PII.
            with tracer.observation(name=TRANSLATE, as_type="generation") as blocked_obs:
                blocked_obs.update(level="WARNING", status_message="pseudonymization_blocked")
        else:
            with tracer.observation(
                name=TRANSLATE,
                as_type="generation",
                model=settings.sarvam_translate_model,
                # SAFE TO RECORD, and the only text in this handler that is: the gate
                # above masked it, and this is byte-for-byte what Sarvam receives.
                input=translate_gate.text,
            ) as translate_obs:
                translation = await translate_adapter.translate(
                    text=translate_gate.text,
                    source_language_code=result.language_code,
                    real_call_allowed=body.real_call_allowed,
                )
                english_text = translation.english_text
                translate_obs.update(
                    output={
                        "english_chars": len(english_text),
                        "detected_source": translation.detected_source,
                        "is_mock": translation.is_mock,
                    },
                    level="WARNING" if translation.error_code else "DEFAULT",
                    status_message=translation.error_code,
                )
    # PRIVACY: never log transcript or english TEXT (raw worker free-text). Counts only.
    logger.info(
        "voice transcribe",
        extra={
            "extra": {
                "voice_note_id": body.voice_note_id,
                "is_mock": result.is_mock,
                "confidence": result.confidence,
                "char_count": len(result.transcript_text),
                "english_len": len(english_text),
                "language": result.language_code,
                "error_code": result.error_code,
            }
        },
    )
    # The trace root carries the same PII-free summary the log line does, so the two
    # never disagree about what happened on this note.
    task.update(
        output={
            "transcript_chars": len(result.transcript_text),
            "english_chars": len(english_text),
            "confidence": result.confidence,
            "language_code": result.language_code,
            "is_mock": result.is_mock,
            "error_code": result.error_code,
        },
        level="WARNING" if result.error_code else "DEFAULT",
        status_message=result.error_code,
    )
    return TranscriptionOutput(
        transcript_text=result.transcript_text,
        confidence=result.confidence,
        language_code=result.language_code,
        is_mock=result.is_mock,
        english_text=english_text,
        # The line above this one used to be the end of the response, and the code the
        # adapter had just computed went only to the log statement above. Returning it
        # is what lets the backend tell an empty transcript that MEANS silence from one
        # that means the provider was never called.
        error_code=result.error_code,
    )
