"""Voice notes: POST /voice/transcribe."""

from __future__ import annotations

from fastapi import APIRouter

from ..contracts import TranscriptionInput, TranscriptionOutput
from ..pseudonymize import pseudonymize
from ._shared import logger, stt_adapter, translate_adapter

api_router = APIRouter()


@api_router.post("/voice/transcribe", response_model=TranscriptionOutput)
async def voice_transcribe(body: TranscriptionInput) -> TranscriptionOutput:
    # Mock by default; the real Sarvam call is gated behind AI_ENABLE_REAL_CALLS
    # (+ key) and fails closed. The adapter never sends audio on the mock path.
    # 30-120s notes ride the chunked-sync path inside the adapter (D-2);
    # worker_ref attributes the per-chunk spend to the TD27 per-user daily cap.
    result = await stt_adapter.transcribe(
        storage_path=body.storage_path,
        duration_seconds=body.duration_seconds,
        language_code=body.language_code,
        real_call_allowed=body.real_call_allowed,
        worker_ref=body.worker_ref,
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
        else:
            translation = await translate_adapter.translate(
                text=translate_gate.text,
                source_language_code=result.language_code,
                real_call_allowed=body.real_call_allowed,
            )
            english_text = translation.english_text
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
    return TranscriptionOutput(
        transcript_text=result.transcript_text,
        confidence=result.confidence,
        language_code=result.language_code,
        is_mock=result.is_mock,
        english_text=english_text,
    )
