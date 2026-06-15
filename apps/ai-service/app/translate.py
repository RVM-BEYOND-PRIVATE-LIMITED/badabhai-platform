"""Transcript translation (Sarvam) adapter — gated, mock-by-default.

Mirrors the STT gating discipline (see ``app/stt.py``): a REAL provider call is
attempted ONLY when ``AI_ENABLE_REAL_CALLS`` is true AND a Sarvam key is
configured. Otherwise a deterministic, PII-free mock English gloss is returned so
local dev and tests need no provider or key.

PRIVACY / SECURITY:
- On the mock path NO transcript and NO data leaves this service.
- The real ``/translate`` call sends the RAW transcript (which may contain PII) to
  Sarvam — the SAME exposure class as the STT call that produced it (you cannot
  pseudonymize before translation without losing the spoken-language fidelity).
  That is why this real call is gated identically behind ``AI_ENABLE_REAL_CALLS``
  + a Sarvam key. The downstream pipeline still pseudonymizes before any LLM.
- FAIL CLOSED: ``_translate_real`` RAISES on any failure (missing key, oversized
  input, transport error, provider non-2xx, malformed response). The ``translate``
  wrapper catches that and returns an EMPTY English string (never a fabricated
  one) marked ``is_mock`` with ``error_code`` so callers record a failed/empty
  result rather than inventing a translation.
- ``_translate_real`` logs NOTHING (no transcript, no translation, no key) and
  every raised message carries only status codes / Sarvam error ``code`` / generic
  strings — never the input text, the translated text, or any secret.

The real Sarvam path IS wired (calls Sarvam ``translate`` directly over REST with
``httpx``); it is simply gated off by default until enabled per environment.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import httpx

from .config import Settings
from .logging_config import get_logger

logger = get_logger("translate")

# Sarvam text translation. mayura:v1 supports auto-detect + code-mixed (Hinglish)
# but caps a single request at 1000 input chars; longer needs chunking (not
# implemented — we fail closed).
SARVAM_TRANSLATE_URL = "https://api.sarvam.ai/translate"
SARVAM_TRANSLATE_TIMEOUT_SECONDS = 60.0
MAYURA_MAX_INPUT_CHARS = 1000

# Deterministic, PII-free mock English gloss of ``stt.MOCK_TRANSCRIPT``. Used on
# the mock path so the pipeline can be exercised end-to-end without a provider.
MOCK_ENGLISH = "I am a VMC operator with four years of experience, I run a Fanuc control."

# Bare 2-letter codes mapped to BCP-47 ``xx-IN`` (same 11 langs as stt._SARVAM_LANGS).
_SARVAM_LANGS = {"hi", "bn", "kn", "ml", "mr", "od", "pa", "ta", "te", "en", "gu"}

_BCP47_RE = re.compile(r"^[a-z]{2}-[A-Z]{2}$")


def _is_english(code: str | None) -> bool:
    """True if ``code`` (case-insensitive) names English — covers ``en`` and
    ``en-IN``. Used to skip the API call when the source is already English."""
    return bool(code) and code.lower().startswith("en")


def _to_translate_source(code: str | None) -> str:
    """Map a caller language hint to a Sarvam ``source_language_code``.

    None/empty/unmappable -> ``"auto"`` (mayura auto-detect); an already-valid
    ``xx-IN`` passes through; a bare supported 2-letter code -> ``xx-IN``.
    """
    if not code:
        return "auto"
    if _BCP47_RE.match(code):
        return code
    lowered = code.lower()
    if lowered in _SARVAM_LANGS:
        return f"{lowered}-IN"
    return "auto"


@dataclass
class TranslateResult:
    english_text: str
    detected_source: str | None
    is_mock: bool
    error_code: str | None = None


class TranslateAdapter:
    """Routes a translation request to the mock or (gated) real provider."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def real_blocked_reason(self) -> str | None:
        """Why the real translate path is disabled, or None if allowed. Fails
        closed: requires the master flag AND a Sarvam key."""
        if not self._settings.ai_enable_real_calls:
            return "AI_ENABLE_REAL_CALLS is false"
        if not self._settings.sarvam_api_key:
            return "SARVAM_API_KEY is not set"
        return None

    @property
    def real_enabled(self) -> bool:
        return self.real_blocked_reason() is None

    async def translate(
        self,
        *,
        text: str,
        source_language_code: str | None = None,
        real_call_allowed: bool = True,
    ) -> TranslateResult:
        # Nothing to translate -> empty result, no provider call, no mock gloss.
        if not text or not text.strip():
            return TranslateResult(
                english_text="",
                detected_source=source_language_code,
                is_mock=True,
            )

        reason = self.real_blocked_reason()
        if reason is not None or not real_call_allowed:
            # Mock path: deterministic, no network, no data leaves the service.
            return self._mock(source_language_code)

        # English-skip cost optimization: the source is already English, so the
        # translation IS the input. Do NOT call the API and do NOT mark it mock —
        # this is the real, correct English with zero provider spend.
        if _is_english(source_language_code):
            return TranslateResult(
                english_text=text,
                detected_source="en-IN",
                is_mock=False,
            )

        # Real path: gated above. Any failure (missing key, oversized input,
        # transport, provider error, malformed response) must fail CLOSED to an
        # empty English string — never fabricate, never fall back to mock text.
        try:
            return await self._translate_real(
                text=text,
                source_language_code=source_language_code,
            )
        except Exception as exc:  # noqa: BLE001 - any provider/dep failure is non-fatal
            logger.warning(
                "translate real call failed; failing closed to empty english",
                extra={"extra": {"error": str(exc)}},
            )
            return TranslateResult(
                english_text="",
                detected_source=source_language_code,
                is_mock=True,
                error_code="translate_call_failed",
            )

    def _mock(self, source_language_code: str | None) -> TranslateResult:
        return TranslateResult(
            english_text=MOCK_ENGLISH,
            detected_source=source_language_code or "hi",
            is_mock=True,
        )

    async def _translate_real(
        self,
        *,
        text: str,
        source_language_code: str | None,
    ) -> TranslateResult:
        """Real Sarvam translate call: POST the transcript to Sarvam ``translate``
        and map the response to ``TranslateResult`` (is_mock=False). RAISES on any
        failure — the ``translate`` wrapper turns that into an empty,
        never-fabricated result. Logs nothing; raised messages carry only status
        codes / Sarvam ``code`` / generic strings."""
        # Defensive key guard (the wrapper already gated on this, but never assume).
        if not self._settings.sarvam_api_key:
            raise RuntimeError("SARVAM_API_KEY is not set")

        # Char-cap guard FIRST — before any network spend on a doomed request.
        # mayura:v1 caps a single request at 1000 chars; longer needs chunking.
        if len(text) > MAYURA_MAX_INPUT_CHARS:
            raise RuntimeError(
                f"translate input exceeds mayura {MAYURA_MAX_INPUT_CHARS}-char limit; "
                "chunking not implemented"
            )

        source = _to_translate_source(source_language_code)

        async with httpx.AsyncClient(timeout=SARVAM_TRANSLATE_TIMEOUT_SECONDS) as client:
            try:
                resp = await client.post(
                    SARVAM_TRANSLATE_URL,
                    headers={
                        "api-subscription-key": self._settings.sarvam_api_key,
                        "Content-Type": "application/json",
                    },
                    json={
                        "input": text,
                        "source_language_code": source,
                        "target_language_code": "en-IN",
                        "model": self._settings.sarvam_translate_model,
                        "mode": "code-mixed",
                        "enable_preprocessing": True,
                    },
                )
            except httpx.HTTPError:
                raise RuntimeError("sarvam translate failed (transport error)") from None

        if resp.status_code < 200 or resp.status_code >= 300:
            # Best-effort error code only — never the provider's free-text message
            # (it could echo the input/translation) and never the body.
            code = None
            try:
                code = resp.json().get("error", {}).get("code")
            except (ValueError, AttributeError, TypeError):
                code = None
            raise RuntimeError(f"sarvam translate failed with status {resp.status_code} ({code})")

        data = resp.json()
        english = data.get("translated_text")
        if not isinstance(english, str):
            raise RuntimeError("sarvam translate response missing translated_text")

        detected = data.get("source_language_code") or source_language_code

        return TranslateResult(
            english_text=english,
            detected_source=detected,
            is_mock=False,
            error_code=None,
        )
