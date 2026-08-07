"""Sarvam text-to-speech, for the voice profiling form's spoken questions.

WHAT THIS IS FOR. The voice form reads each question aloud so a worker who cannot
comfortably read the screen can still answer it. Those questions are STATIC,
REVIEWED content — question-pack ``prompt_text``/``retry_text``/``why_text`` plus a
closed set of fixed orchestrator strings — so the audio is a BUILD ARTIFACT, not a
per-request call. ``app/cli/tts_render.py`` renders the corpus once; the app ships
or fetches the result.

THE DIRECTION OF EXPOSURE IS THE OPPOSITE OF STT, AND THAT IS THE WHOLE POINT.
``stt.py`` states that audio is the one input that cannot be pseudonymized before
the provider sees it. TTS inverts that: the input is TEXT we authored, so nothing a
worker said, typed or is named needs to cross the boundary at all. The design
keeps it that way STRUCTURALLY rather than by promise:

- there is NO FastAPI route that reaches this adapter (asserted by a boot test), so
  no request body can become speech;
- ``synthesize`` refuses text carrying a ``{{...}}`` placeholder, because a
  post-emit interpolation (the AI-PERSONA-2 mechanism) is exactly how one worker's
  name would end up rendered into a SHARED cache and spoken to every other worker.

Spend is attributed with ``user_ref=None`` deliberately: rendering the catalogue is
OPERATOR spend, run once by a human, not a worker's per-day AI budget. Charging a
one-off batch render against whichever worker happened to trigger it would be wrong,
and would let a render exhaust a real worker's daily cap.

FAILS CLOSED to EMPTY audio, never a fabricated or substituted clip. A missing clip
degrades the client to text-only; a WRONG clip would read the wrong question aloud
to someone who cannot read the screen to catch it.
"""

from __future__ import annotations

import base64
import binascii
import re
from dataclasses import dataclass

import httpx

from .ai import cost_tracker
from .config import Settings
from .logging_config import get_logger

logger = get_logger("tts")

SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech"
SARVAM_TTS_TIMEOUT_SECONDS = 30.0

# Task-type key for the per-task real-call allowlist (config.ai_real_call_tasks).
# ITS OWN KEY, not STT's. ``translate.py`` deliberately shares ``STT_TASK_TYPE``
# because it is the same provider on the same audio in one logical operation — one
# flip arms or disarms the whole voice->English leg. TTS is not that: it is a
# different direction, a different unit (characters, not audio-seconds) and a
# different risk profile (outbound authored text vs inbound worker audio), so it
# must be armable and revocable on its own.
TTS_TASK_TYPE = "tts_synthesis"

# Sarvam's own per-request input ceiling. bulbul:v2 caps at 1500 characters and
# bulbul:v3 at 2500; the lower bound is enforced for BOTH so a model swap in config
# can never silently start truncating a question mid-sentence at the provider.
MAX_INPUT_CHARS = 1500

# Placeholder syntax banned from anything spoken. See the module docstring: a
# shared audio cache plus post-emit interpolation is how one worker's name gets
# spoken to every other worker. The corpus validator bans these in pack copy too;
# this is the second wall, at the provider boundary.
_PLACEHOLDER_RE = re.compile(r"\{\{.*?\}\}")


@dataclass(frozen=True)
class TtsResult:
    """One synthesis attempt.

    ``audio`` is EMPTY on every failure path, and ``is_mock`` is True whenever the
    bytes did not come from a real provider call — mirroring ``SttResult`` so a
    caller cannot tell the two adapters apart when handling degradation.
    """

    audio: bytes
    audio_format: str
    is_mock: bool
    error_code: str | None = None
    char_count: int = 0


class TtsAdapter:
    """Routes a synthesis request to the mock or (gated) real provider."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def real_blocked_reason(self) -> str | None:
        """Why the real TTS path is disabled, or None if allowed. Fails closed.

        THE ORDER IS COPIED FROM ``SttAdapter.real_blocked_reason`` ON PURPOSE, and
        that docstring records two shipped incidents from getting it wrong: reading
        ``ai_enable_real_calls`` directly walks past the kill-switch, and skipping
        ``real_call_enabled_for`` walks past the per-task allowlist — which is the
        whole mechanism for turning one provider on at a time.

        ``real_call_enabled_for`` supplies both in one call: the kill-switch, the
        master flag and ``GEMINI_FLASH_API_KEY`` via ``real_calls_blocked_reason``,
        then the allowlist, where EMPTY means NO tasks (fail-closed, owner-ruled
        2026-08-01; no wildcard).

        The same ACCEPTED COUPLING as STT applies: real TTS needs the LLM master
        credential as well as ``SARVAM_API_KEY``, so there is ONE definition of
        "real calls are on" for the whole service. Staging must set the Gemini key
        even when only TTS is being armed.
        """
        reason = self._settings.real_calls_blocked_reason()
        if reason is not None:
            return reason
        if not self._settings.real_call_enabled_for(TTS_TASK_TYPE):
            return f"{TTS_TASK_TYPE} is not in AI_REAL_CALL_TASKS"
        if not self._settings.sarvam_api_key:
            return "SARVAM_API_KEY is not set"
        return None

    @property
    def real_enabled(self) -> bool:
        return self.real_blocked_reason() is None

    def projected_inr(self, text: str) -> float:
        """Projected cost of one synthesis.

        Sarvam prices per character and — per the published rate card — rounds UP
        per request, so a 40-character question is not 40/10000 of the rate in
        practice. ``sarvam_tts_min_billed_chars`` models that floor rather than
        pretending the marginal cost is linear, because the difference between the
        two is the entire unit-economics argument for rendering the catalogue once
        instead of synthesising per session. CALIBRATE against the first invoice.
        """
        billed = max(len(text), self._settings.sarvam_tts_min_billed_chars)
        return round(billed * self._settings.sarvam_tts_cost_inr_per_10k_chars / 10_000, 6)

    async def synthesize(
        self,
        *,
        text: str,
        language_code: str | None = None,
        real_call_allowed: bool = True,
    ) -> TtsResult:
        """Synthesize ``text``. Returns empty audio on every failure — never a
        substituted or fabricated clip."""
        settings = self._settings
        stripped = text.strip()

        # Refusals BEFORE any spend, each a distinct closed-set code so a batch
        # render can report exactly which rows it skipped and why.
        if not stripped:
            return TtsResult(b"", settings.sarvam_tts_output_codec, True, "tts_empty_text", 0)
        if _PLACEHOLDER_RE.search(stripped):
            # Never logged with the text — the point is that it may embed PII.
            logger.warning("tts refused: text carries a {{placeholder}}")
            return TtsResult(
                b"", settings.sarvam_tts_output_codec, True, "tts_placeholder_text", len(stripped)
            )
        if len(stripped) > MAX_INPUT_CHARS:
            logger.warning(
                "tts refused: text over the provider input cap",
                extra={"extra": {"char_count": len(stripped), "cap": MAX_INPUT_CHARS}},
            )
            return TtsResult(
                b"", settings.sarvam_tts_output_codec, True, "tts_text_too_long", len(stripped)
            )

        if not real_call_allowed or not self.real_enabled:
            return self._mock(stripped)

        projected_inr = self.projected_inr(stripped)

        if projected_inr > settings.ai_max_call_cost_inr:
            logger.warning(
                "tts real call blocked by per-call cost ceiling",
                extra={
                    "extra": {
                        "projected_inr": projected_inr,
                        "ceiling_inr": settings.ai_max_call_cost_inr,
                    }
                },
            )
            return TtsResult(
                b"", settings.sarvam_tts_output_codec, True, "tts_budget_blocked", len(stripped)
            )

        # OPERATOR spend, not a worker's: user_ref=None. See the module docstring.
        ledger = cost_tracker.get_ledger()
        block = await ledger.would_exceed_spend(projected_inr, settings, user_ref=None)
        if block is not None:
            logger.warning(
                "tts real call blocked by spend ledger",
                extra={"extra": {"reason": block, "projected_inr": projected_inr}},
            )
            return TtsResult(
                b"", settings.sarvam_tts_output_codec, True, "tts_budget_blocked", len(stripped)
            )

        actual_inr = 0.0
        try:
            audio = await self._synthesize_real(stripped, language_code)
            actual_inr = projected_inr
            return TtsResult(
                audio, settings.sarvam_tts_output_codec, False, None, len(stripped)
            )
        except Exception as exc:  # noqa: BLE001 - any provider failure is non-fatal
            # A request that reached the provider may well have been billed, but we
            # cannot know from a transport error, and over-charging our own operator
            # budget is the safe direction: refund. (Contrast STT, which keeps
            # chunks that demonstrably returned.)
            logger.warning(
                "tts real call failed; failing closed to empty audio",
                extra={"extra": {"error": str(exc)}},
            )
            return TtsResult(
                b"", settings.sarvam_tts_output_codec, True, "tts_call_failed", len(stripped)
            )
        finally:
            await ledger.record_spend(projected_inr, actual_inr, user_ref=None)

    async def _synthesize_real(self, text: str, language_code: str | None) -> bytes:
        """One Sarvam ``text-to-speech`` POST. RAISES (PII-free message) on transport
        error, non-2xx, or a malformed/undecodable response body."""
        settings = self._settings
        body: dict[str, object] = {
            "text": text,
            "target_language_code": language_code or settings.sarvam_tts_language,
            "model": settings.sarvam_tts_model,
            "speaker": settings.sarvam_tts_speaker,
            "speech_sample_rate": settings.sarvam_tts_sample_rate,
            "output_audio_codec": settings.sarvam_tts_output_codec,
        }

        async with httpx.AsyncClient(timeout=SARVAM_TTS_TIMEOUT_SECONDS) as client:
            try:
                resp = await client.post(
                    SARVAM_TTS_URL,
                    headers={
                        "api-subscription-key": settings.sarvam_api_key or "",
                        "Content-Type": "application/json",
                    },
                    json=body,
                )
            except httpx.HTTPError:
                raise RuntimeError("sarvam tts failed (transport error)") from None

        if resp.status_code < 200 or resp.status_code >= 300:
            # Status + a best-effort closed-set code only — never the provider's
            # free-text message, which can echo the input back.
            code = None
            try:
                code = resp.json().get("error", {}).get("code")
            except (ValueError, AttributeError, TypeError):
                code = None
            raise RuntimeError(f"sarvam tts failed with status {resp.status_code} ({code})")

        try:
            payload = resp.json()
            audios = payload["audios"]
            first = audios[0]
        except (ValueError, KeyError, IndexError, TypeError):
            raise RuntimeError("sarvam tts returned a malformed response") from None

        if not isinstance(first, str) or not first:
            raise RuntimeError("sarvam tts returned no audio")

        try:
            audio = base64.b64decode(first, validate=True)
        except (binascii.Error, ValueError):
            raise RuntimeError("sarvam tts returned undecodable base64") from None

        if not audio:
            raise RuntimeError("sarvam tts returned empty audio")
        return audio

    def _mock(self, text: str) -> TtsResult:
        """Deterministic, silent, PII-free stand-in.

        EMPTY bytes rather than a synthetic tone: the client's resolver already
        degrades a missing clip to text-only, and a placeholder sound played to a
        worker who cannot read the screen is worse than silence — it looks like the
        question was asked when it was not.
        """
        return TtsResult(
            audio=b"",
            audio_format=self._settings.sarvam_tts_output_codec,
            is_mock=True,
            error_code=None,
            char_count=len(text),
        )
