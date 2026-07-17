"""Speech-to-text (Sarvam) adapter — gated, mock-by-default.

Mirrors the LLM gating discipline (see ``app/ai/router.py`` + ``app/llm.py``):
a REAL provider call is attempted ONLY when ``AI_ENABLE_REAL_CALLS`` is true AND
a Sarvam key is configured. Otherwise a deterministic, PII-free mock transcript
is returned so local dev and tests need no STT provider or key.

PRIVACY / SECURITY:
- On the mock path NO audio and NO data leaves this service. The mock is also
  DURATION-AGNOSTIC: the 30s sync limit is a REAL-provider upload constraint, so
  it never applies to a path that never calls the provider (D-2).
- Audio is the one input that cannot be pseudonymized before the provider sees it
  (you need the transcript first) — which is why the real call is gated behind
  ``AI_ENABLE_REAL_CALLS`` and a DPDP/spend decision. The transcript is
  pseudonymized downstream before any LLM (``/profile/extract``).
- FAIL CLOSED: ``_transcribe_real`` RAISES on any failure (missing key/storage,
  over-cap audio, chunking failure, transport error, provider non-2xx, malformed
  response). The ``transcribe`` wrapper catches that and returns an EMPTY
  transcript (never a fabricated one) marked ``is_mock`` so the backend records a
  failed/empty result rather than inventing words.
- ``_transcribe_real`` logs NOTHING (no transcript, no audio, no key) and every
  raised message carries only status codes / Sarvam error ``code`` / generic
  strings — never transcript text, audio bytes, or any secret.

DURATION HANDLING (D-2 — owner ruling 2026-07-17 "BUILD IT PROPERLY = ASYNC STT"):
- <= 30s  -> one sync Sarvam call (unchanged).
- 30-120s -> CHUNKED SYNC: the stored audio is split on codec-frame boundaries
  into <30s segments (``app/audio_chunk.py`` — pure python, no ffmpeg; the
  provider's batch API contract is not known to this codebase), the segments are
  transcribed with bounded parallelism, and the transcripts are concatenated
  DETERMINISTICALLY in segment order. The FULL concatenated transcript is
  assembled HERE, before return — every downstream privacy gate (pseudonymize's
  residual-digit scan in ``/profile/extract``) sees the whole text, never a
  chunk. ANY chunk failure fails the WHOLE note closed (a transcript with silent
  holes is a fabrication risk).
- > 120s  -> rejected (the ``MAX_VOICE_NOTE_SECONDS`` platform cap; upload
  validation makes this unreachable in practice) BEFORE any storage/provider
  spend.

SPEND (TD68 pattern): each real chunk call is provider spend. The real path
reserves the note's worst-case INR on the TD27 ``SpendLedger`` BEFORE any Sarvam
call (attributed to the opaque ``worker_ref`` per-user daily budget), then
reconciles to the actual number of chunk calls made — chunks that returned
before a failure stay recorded (they were billed), only uncalled chunks are
refunded. A ledger block returns an EMPTY transcript (never mock — no
fabrication on the real path). Numbers with the defaults: a 120s note is
ceil(120/29.5) = 5 chunks x Rs 0.25 = Rs 1.25, under the Rs 6/user/day cap
(~4 full-length notes/user/day) and each chunk call is well under the Rs 10
per-call ceiling.

The real Sarvam path IS wired (calls Sarvam ``speech-to-text`` directly over REST
with ``httpx``); it is simply gated off by default until enabled per environment.
"""

from __future__ import annotations

import asyncio
import math
import os
import re
from dataclasses import dataclass

import httpx

from .ai import cost_tracker
from .audio_chunk import AudioChunkError, split_audio
from .config import Settings
from .logging_config import get_logger
from .storage import download_object

logger = get_logger("stt")

# Deterministic, PII-free mock transcript (CNC/VMC flavoured Hinglish). Used on
# the mock path so the pipeline can be exercised end-to-end without a provider.
MOCK_TRANSCRIPT = "main vmc operator hoon, char saal ka experience, fanuc control chalata hoon"
MOCK_CONFIDENCE = 0.9
DEFAULT_LANGUAGE = "hi"

# Sarvam synchronous speech-to-text. The sync endpoint accepts audio UNDER 30s
# only; longer notes (up to the 120s platform cap) ride the chunked-sync path.
SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text"
SARVAM_SYNC_MAX_SECONDS = 30.0
# PER-CALL httpx timeout — applies to EACH chunk call independently, so the
# worst-case wall time for a chunked note is waves x 60s (see the concurrency
# note below), not a single 60s budget stretched over the whole note.
SARVAM_TIMEOUT_SECONDS = 60.0
# Platform cap — mirrors MAX_VOICE_NOTE_SECONDS = 120 in packages/types (and the
# upload-side voiceDurationSecondsSchema). Anything past it is rejected before
# any storage/provider spend: upstream validation should make it unreachable.
MAX_VOICE_NOTE_SECONDS = 120.0
# Chunk budget for 30-120s notes: 29.5s keeps every frame-quantized segment
# STRICTLY under the 30s provider limit (balanced split can exceed the equal
# share by at most one AAC frame, <=64ms). 120s -> ceil(120/29.5) = 5 chunks.
SARVAM_CHUNK_MAX_SECONDS = 29.5
# Bounded parallelism across chunk calls: 2 in flight halves wall time while
# capping provider burst. 5 chunks -> ceil(5/2) = 3 waves x <=60s = <=180s worst
# case (the api-side /voice/transcribe budget in ai.service.ts is sized to this).
SARVAM_CHUNK_CONCURRENCY = 2
# Used ONLY when Sarvam returns a transcript but no ``language_probability``
# (i.e. a specific language was requested, so there is no detection uncertainty).
_REAL_CONFIDENCE_WHEN_UNREPORTED = 1.0

# Bare 2-letter codes Sarvam saarika:v2.5 supports, mapped to BCP-47 ``xx-IN``.
_SARVAM_LANGS = {"hi", "bn", "kn", "ml", "mr", "od", "pa", "ta", "te", "en", "gu"}

# Audio file extension -> MIME content type for the multipart upload.
_CONTENT_TYPES = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".webm": "audio/webm",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
    ".amr": "audio/amr",
}

_BCP47_RE = re.compile(r"^[a-z]{2}-[A-Z]{2}$")


def _to_sarvam_language(language_code: str | None) -> str:
    """Map a caller language hint to a Sarvam ``language_code``.

    None/empty -> ``"unknown"`` (auto-detect); an already-valid ``xx-IN`` passes
    through; a bare supported 2-letter code -> ``xx-IN``; anything else -> ``"unknown"``.
    """
    if not language_code:
        return "unknown"
    if _BCP47_RE.match(language_code):
        return language_code
    code = language_code.lower()
    if code in _SARVAM_LANGS:
        return f"{code}-IN"
    return "unknown"


def _content_type_for(storage_path: str) -> tuple[str, str]:
    """Return ``(filename, content_type)`` for the multipart upload, inferred from
    the path extension. Unknown extension -> ``application/octet-stream``."""
    filename = os.path.basename(storage_path) or "audio"
    _, ext = os.path.splitext(filename)
    content_type = _CONTENT_TYPES.get(ext.lower(), "application/octet-stream")
    return filename, content_type


@dataclass
class SttResult:
    transcript_text: str
    confidence: float
    language_code: str | None
    is_mock: bool
    error_code: str | None = None
    # How many provider calls produced this result (1 for sync, N for chunked).
    # INTERNAL spend accounting only — never surfaced on TranscriptionOutput.
    chunk_count: int = 1


class _ChunkedSttFailure(RuntimeError):
    """A chunked transcription failed part-way. ``chunks_spent`` counts the chunk
    calls that RETURNED before the failure — real provider spend the ledger must
    keep (never refunded as if uncalled)."""

    def __init__(self, message: str, *, chunks_spent: int) -> None:
        super().__init__(message)
        self.chunks_spent = chunks_spent


class SttAdapter:
    """Routes a transcription request to the mock or (gated) real provider."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def real_blocked_reason(self) -> str | None:
        """Why the real STT path is disabled, or None if allowed. Fails closed:
        requires the master flag AND a Sarvam key."""
        if not self._settings.ai_enable_real_calls:
            return "AI_ENABLE_REAL_CALLS is false"
        if not self._settings.sarvam_api_key:
            return "SARVAM_API_KEY is not set"
        return None

    @property
    def real_enabled(self) -> bool:
        return self.real_blocked_reason() is None

    def _projected_chunks(self, duration_seconds: float | None) -> int:
        """Worst-case provider-call count for the spend reservation. Unknown
        duration -> 1 (the single sync call the real path will attempt)."""
        if duration_seconds is None or duration_seconds <= SARVAM_SYNC_MAX_SECONDS:
            return 1
        capped = min(duration_seconds, MAX_VOICE_NOTE_SECONDS)
        return max(1, math.ceil(capped / SARVAM_CHUNK_MAX_SECONDS))

    async def transcribe(
        self,
        *,
        storage_path: str,
        duration_seconds: float | None = None,
        language_code: str | None = None,
        real_call_allowed: bool = True,
        worker_ref: str | None = None,
    ) -> SttResult:
        reason = self.real_blocked_reason()
        if reason is not None or not real_call_allowed:
            # Mock path: deterministic, no network, no data leaves the service.
            # DURATION-AGNOSTIC by design (D-2): the 30s/120s limits guard real
            # provider uploads — a path that never calls the provider has nothing
            # to fail closed against.
            return self._mock(language_code)

        settings = self._settings
        rate_inr = settings.sarvam_stt_cost_inr_per_chunk
        projected_chunks = self._projected_chunks(duration_seconds)
        projected_inr = round(projected_chunks * rate_inr, 4)

        # TD68: the per-CALL ceiling bounds EACH chunk call (one provider call =
        # one chunk); the note's TOTAL is bounded by the daily/per-user caps via
        # the reservation below. A misconfigured rate above the ceiling blocks.
        if rate_inr > settings.ai_max_call_cost_inr:
            logger.warning(
                "stt real call blocked by per-call cost ceiling",
                extra={"extra": {
                    "rate_inr": rate_inr,
                    "ceiling_inr": settings.ai_max_call_cost_inr,
                }},
            )
            return SttResult(
                transcript_text="",
                confidence=0.0,
                language_code=language_code,
                is_mock=True,
                error_code="stt_budget_blocked",
                chunk_count=0,
            )

        # Reserve the note's worst-case spend BEFORE any provider call (atomic
        # check-and-reserve; attributes to worker_ref's per-user daily budget).
        # Fail closed to EMPTY on a block — never mock on the real path.
        ledger = cost_tracker.get_ledger()
        block = await ledger.would_exceed_spend(projected_inr, settings, user_ref=worker_ref)
        if block is not None:
            logger.warning(
                "stt real call blocked by spend ledger",
                extra={"extra": {
                    "reason": block,
                    "projected_inr": projected_inr,
                    "projected_chunks": projected_chunks,
                }},
            )
            return SttResult(
                transcript_text="",
                confidence=0.0,
                language_code=language_code,
                is_mock=True,
                error_code="stt_budget_blocked",
                chunk_count=0,
            )

        # Real path: gated above. Any failure (missing storage/key, over-cap
        # audio, chunking, transport, provider error, malformed response) must
        # fail CLOSED to an empty transcript — never fabricate, never mock.
        actual_inr = 0.0
        try:
            result = await self._transcribe_real(
                storage_path=storage_path,
                duration_seconds=duration_seconds,
                language_code=language_code,
            )
            actual_inr = round(result.chunk_count * rate_inr, 4)
            return result
        except Exception as exc:  # noqa: BLE001 - any provider/dep failure is non-fatal
            # Chunk calls that RETURNED before the failure were provider spend —
            # keep them recorded; the reconcile below refunds only the remainder.
            chunks_spent = getattr(exc, "chunks_spent", 0)
            actual_inr = round(chunks_spent * rate_inr, 4)
            logger.warning(
                "stt real call failed; failing closed to empty transcript",
                extra={"extra": {"error": str(exc), "chunks_spent": chunks_spent}},
            )
            return SttResult(
                transcript_text="",
                confidence=0.0,
                language_code=language_code,
                is_mock=True,
                error_code="stt_call_failed",
                chunk_count=chunks_spent,
            )
        finally:
            # Reconcile the reservation to what was actually called. Success
            # leaves +actual; total failure refunds everything; a partial chunk
            # failure keeps exactly the calls that reached the provider.
            await ledger.record_spend(projected_inr, actual_inr, user_ref=worker_ref)

    def _mock(self, language_code: str | None) -> SttResult:
        return SttResult(
            transcript_text=MOCK_TRANSCRIPT,
            confidence=MOCK_CONFIDENCE,
            language_code=language_code or DEFAULT_LANGUAGE,
            is_mock=True,
        )

    async def _transcribe_real(
        self,
        *,
        storage_path: str,
        duration_seconds: float | None,
        language_code: str | None,
    ) -> SttResult:
        """Real Sarvam STT: fetch the audio via service-role storage, POST it to
        Sarvam ``speech-to-text`` (one sync call for <=30s; chunked sync for
        30-120s), and map to ``SttResult`` (is_mock=False). RAISES on any failure
        — the ``transcribe`` wrapper turns that into an empty, never-fabricated
        result. Logs nothing; raised messages carry only status codes / Sarvam
        ``code`` / generic strings."""
        # Defensive key guard (the wrapper already gated on this, but never assume).
        if not self._settings.sarvam_api_key:
            raise RuntimeError("SARVAM_API_KEY is not set")

        # Platform cap FIRST — before any storage/network spend on a doomed note.
        # Upload validation (voiceDurationSecondsSchema <= 120) makes this
        # unreachable in practice; keep it fail-closed anyway.
        if duration_seconds is not None and duration_seconds > MAX_VOICE_NOTE_SECONDS:
            raise RuntimeError(
                f"audio exceeds the {MAX_VOICE_NOTE_SECONDS:.0f}s platform cap"
            )

        # Fetch the private audio object (service-role; raises PII-free on failure).
        audio = await download_object(
            self._settings, storage_path, bucket=self._settings.voice_notes_bucket
        )

        sarvam_lang = _to_sarvam_language(language_code)

        if duration_seconds is None or duration_seconds <= SARVAM_SYNC_MAX_SECONDS:
            # Single sync call (the unchanged fast path). Unknown duration keeps
            # the historical behavior: attempt sync; the provider rejects
            # oversize and we fail closed.
            filename, content_type = _content_type_for(storage_path)
            async with httpx.AsyncClient(timeout=SARVAM_TIMEOUT_SECONDS) as client:
                transcript, confidence, lang_out = await self._post_sarvam(
                    client, audio, filename, content_type, sarvam_lang
                )
            return SttResult(
                transcript_text=transcript,
                confidence=confidence,
                language_code=lang_out or language_code,
                is_mock=False,
                error_code=None,
                chunk_count=1,
            )

        return await self._transcribe_chunked(
            audio=audio,
            storage_path=storage_path,
            sarvam_lang=sarvam_lang,
            language_code=language_code,
        )

    async def _transcribe_chunked(
        self,
        *,
        audio: bytes,
        storage_path: str,
        sarvam_lang: str,
        language_code: str | None,
    ) -> SttResult:
        """30-120s notes: split -> bounded-parallel sync calls -> deterministic
        in-order concatenation. ANY chunk failure fails the WHOLE note closed."""
        try:
            segments = split_audio(
                audio, storage_path, max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS
            )
        except AudioChunkError as exc:
            # AudioChunkError messages are PII-free by construction.
            raise RuntimeError(f"audio chunking failed ({exc})") from None

        semaphore = asyncio.Semaphore(SARVAM_CHUNK_CONCURRENCY)

        # ONE client for all chunk calls; timeout applies PER call. gather with
        # return_exceptions so we can count the calls that DID reach the provider
        # (real spend) even when another chunk fails.
        async with httpx.AsyncClient(timeout=SARVAM_TIMEOUT_SECONDS) as client:

            async def _one(segment) -> tuple[str, float, str | None]:
                async with semaphore:
                    return await self._post_sarvam(
                        client, segment.data, segment.filename, segment.content_type, sarvam_lang
                    )

            outcomes = await asyncio.gather(
                *(_one(segment) for segment in segments), return_exceptions=True
            )

        succeeded = sum(1 for o in outcomes if not isinstance(o, BaseException))
        first_error = next((o for o in outcomes if isinstance(o, BaseException)), None)
        if first_error is not None:
            # Fail the whole note closed: a transcript with silent holes is a
            # fabrication risk. Carry the spend that already happened.
            raise _ChunkedSttFailure(
                f"chunked stt failed ({first_error})", chunks_spent=succeeded
            )

        # Deterministic concatenation in SEGMENT ORDER (asyncio.gather preserves
        # input order regardless of completion order). The FULL transcript is
        # assembled here — downstream gates (pseudonymize's residual-digit scan)
        # always see the whole text, never an individual chunk.
        parts = [text.strip() for text, _conf, _lang in outcomes]
        transcript = " ".join(p for p in parts if p)
        # Conservative confidence: the weakest chunk bounds the whole note.
        confidence = min(conf for _text, conf, _lang in outcomes)
        lang_out = next(
            (lang for _text, _conf, lang in outcomes if lang), None
        ) or language_code

        return SttResult(
            transcript_text=transcript,
            confidence=confidence,
            language_code=lang_out,
            is_mock=False,
            error_code=None,
            chunk_count=len(segments),
        )

    async def _post_sarvam(
        self,
        client: httpx.AsyncClient,
        audio: bytes,
        filename: str,
        content_type: str,
        sarvam_lang: str,
    ) -> tuple[str, float, str | None]:
        """One sync Sarvam ``speech-to-text`` POST. Returns ``(transcript,
        confidence, language_code)``; RAISES (PII-free message) on transport
        error, non-2xx, or a malformed response."""
        try:
            # NEVER set Content-Type — let httpx build the multipart boundary.
            resp = await client.post(
                SARVAM_STT_URL,
                headers={"api-subscription-key": self._settings.sarvam_api_key},
                files={"file": (filename, audio, content_type)},
                data={
                    "model": self._settings.sarvam_stt_model,
                    "language_code": sarvam_lang,
                },
            )
        except httpx.HTTPError:
            raise RuntimeError("sarvam stt failed (transport error)") from None

        if resp.status_code < 200 or resp.status_code >= 300:
            # Best-effort error code only — never the provider's free-text message
            # (it could echo audio/transcript) and never the body.
            code = None
            try:
                code = resp.json().get("error", {}).get("code")
            except (ValueError, AttributeError, TypeError):
                code = None
            raise RuntimeError(f"sarvam stt failed with status {resp.status_code} ({code})")

        data = resp.json()
        transcript = data.get("transcript")
        if not isinstance(transcript, str):
            raise RuntimeError("sarvam stt response missing transcript")

        # ``language_probability`` is a 0..1 detection score on auto-detect; null
        # when a specific language was requested (no detection uncertainty).
        prob = data.get("language_probability")
        confidence = (
            float(prob)
            if isinstance(prob, (int, float)) and 0.0 <= prob <= 1.0
            else _REAL_CONFIDENCE_WHEN_UNREPORTED
        )
        return transcript, confidence, data.get("language_code")
