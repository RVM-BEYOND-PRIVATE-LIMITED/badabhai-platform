"""Speech-to-text (Sarvam) adapter — gated, mock-by-default.

Mirrors the LLM gating discipline (see ``app/ai/router.py`` + ``app/llm.py``):
a REAL provider call is attempted ONLY when ``AI_ENABLE_REAL_CALLS`` is true AND
a Sarvam key is configured. Otherwise a deterministic, PII-free mock transcript
is returned so local dev and tests need no STT provider or key.

PRIVACY / SECURITY:
- On the mock path NO audio and NO data leaves this service.
- Audio is the one input that cannot be pseudonymized before the provider sees it
  (you need the transcript first) — which is why the real call is gated behind
  ``AI_ENABLE_REAL_CALLS`` and a DPDP/spend decision. The transcript is
  pseudonymized downstream before any LLM (``/profile/extract``).
- FAIL CLOSED: ``_transcribe_real`` RAISES on any failure (missing key/storage,
  oversized audio, transport error, provider non-2xx, malformed response). The
  ``transcribe`` wrapper catches that and returns an EMPTY transcript (never a
  fabricated one) marked ``is_mock`` so the backend records a failed/empty result
  rather than inventing words.
- ``_transcribe_real`` logs NOTHING (no transcript, no audio, no key) and every
  raised message carries only status codes / Sarvam error ``code`` / generic
  strings — never transcript text, audio bytes, or any secret.

The real Sarvam path IS wired (calls Sarvam ``speech-to-text`` directly over REST
with ``httpx``); it is simply gated off by default until enabled per environment.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

import httpx

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
# only; longer clips need the batch API (not implemented — we fail closed).
SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text"
SARVAM_SYNC_MAX_SECONDS = 30.0
SARVAM_TIMEOUT_SECONDS = 60.0
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

    async def transcribe(
        self,
        *,
        storage_path: str,
        duration_seconds: float | None = None,
        language_code: str | None = None,
        real_call_allowed: bool = True,
    ) -> SttResult:
        reason = self.real_blocked_reason()
        if reason is not None or not real_call_allowed:
            # Mock path: deterministic, no network, no data leaves the service.
            return self._mock(language_code)

        # Real path: gated above. Any failure (missing storage/key, oversized
        # audio, transport, provider error, malformed response) must fail CLOSED
        # to an empty transcript — never fabricate text, never fall back to mock.
        try:
            return await self._transcribe_real(
                storage_path=storage_path,
                duration_seconds=duration_seconds,
                language_code=language_code,
            )
        except Exception as exc:  # noqa: BLE001 - any provider/dep failure is non-fatal
            logger.warning(
                "stt real call failed; failing closed to empty transcript",
                extra={"extra": {"error": str(exc)}},
            )
            return SttResult(
                transcript_text="",
                confidence=0.0,
                language_code=language_code,
                is_mock=True,
                error_code="stt_call_failed",
            )

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
        """Real Sarvam STT call: fetch the audio via service-role storage, POST it
        to Sarvam ``speech-to-text``, and map the response to ``SttResult``
        (is_mock=False). RAISES on any failure — the ``transcribe`` wrapper turns
        that into an empty, never-fabricated result. Logs nothing; raised messages
        carry only status codes / Sarvam ``code`` / generic strings."""
        # Defensive key guard (the wrapper already gated on this, but never assume).
        if not self._settings.sarvam_api_key:
            raise RuntimeError("SARVAM_API_KEY is not set")

        # Duration guard FIRST — before any network spend on a doomed upload. The
        # sync endpoint accepts audio under 30s only; longer needs batch STT.
        if duration_seconds is not None and duration_seconds > SARVAM_SYNC_MAX_SECONDS:
            raise RuntimeError(
                f"audio exceeds Sarvam sync limit ({SARVAM_SYNC_MAX_SECONDS:.0f}s); "
                "batch STT not implemented"
            )

        # Fetch the private audio object (service-role; raises PII-free on failure).
        audio = await download_object(
            self._settings, storage_path, bucket=self._settings.voice_notes_bucket
        )

        sarvam_lang = _to_sarvam_language(language_code)
        filename, content_type = _content_type_for(storage_path)

        async with httpx.AsyncClient(timeout=SARVAM_TIMEOUT_SECONDS) as client:
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
        lang_out = data.get("language_code") or language_code

        return SttResult(
            transcript_text=transcript,
            confidence=confidence,
            language_code=lang_out,
            is_mock=False,
            error_code=None,
        )
