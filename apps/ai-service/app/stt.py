"""Speech-to-text (Sarvam) adapter — gated, mock-by-default.

Mirrors the LLM gating discipline (see ``app/ai/router.py`` + ``app/llm.py``):
a REAL provider call is attempted ONLY when ``AI_ENABLE_REAL_CALLS`` is true AND
a Sarvam key is configured. Otherwise a deterministic, PII-free mock transcript
is returned so local dev and tests need no STT provider or key.

PRIVACY / SECURITY:
- On the mock path NO audio and NO data leaves this service.
- Audio is the one input that cannot be pseudonymized before the provider sees it
  (you need the transcript first) — which is exactly why the real call is gated
  off behind ``AI_ENABLE_REAL_CALLS`` until a DPDP/spend decision is made. The
  transcript is pseudonymized downstream before any LLM (``/profile/extract``).
- FAIL CLOSED: the real path is NOT wired in Phase 1; if reached it raises and we
  fall back to an EMPTY transcript (never a fabricated one) marked ``is_mock`` so
  the backend records a failed/empty result rather than inventing words.
"""

from __future__ import annotations

from dataclasses import dataclass

from .config import Settings
from .logging_config import get_logger

logger = get_logger("stt")

# Deterministic, PII-free mock transcript (CNC/VMC flavoured Hinglish). Used on
# the mock path so the pipeline can be exercised end-to-end without a provider.
MOCK_TRANSCRIPT = "main vmc operator hoon, char saal ka experience, fanuc control chalata hoon"
MOCK_CONFIDENCE = 0.9
DEFAULT_LANGUAGE = "hi"


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

        # Real path is intentionally not wired in Phase 1 (gated above). If it is
        # ever reached, fail closed to an empty transcript — never fabricate text.
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
        """Real Sarvam STT call. NOT implemented in Phase 1 — gated off pending a
        DPDP/spend decision. When wired: fetch the audio via service-role storage,
        POST to Sarvam, map the response to ``SttResult`` (is_mock=False)."""
        # TODO(Phase 2): lazy-import the Sarvam SDK/httpx and call the API here.
        raise NotImplementedError("Sarvam STT integration is not implemented in Phase 1")
