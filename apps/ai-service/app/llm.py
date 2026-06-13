"""LLM adapter — PLACEHOLDER (unused).

The live model path is ``app.ai.router.AIRouter`` -> ``app.ai.gemini_client``
(direct Gemini over REST, no LiteLLM). This stub is retained only as the
``can_call()`` gate example; it is never invoked with real traffic and is only
ever reachable AFTER pseudonymization has succeeded (callers must pass
already-pseudonymized text).
"""

from __future__ import annotations

from .config import Settings
from .logging_config import get_logger

logger = get_logger(__name__)


class LlmAdapter:
    def __init__(self, settings: Settings):
        self._settings = settings

    def can_call(self) -> tuple[bool, str | None]:
        reason = self._settings.real_calls_blocked_reason()
        return (reason is None, reason)

    async def complete(self, *, prompt: str, purpose: str) -> str:
        """Unused stub — the live path is ``app.ai.gemini_client.acomplete``.

        ``prompt`` MUST already be pseudonymized by the caller.
        """
        enabled, reason = self.can_call()
        if not enabled:
            raise RuntimeError(f"LLM calls are disabled: {reason}")
        logger.warning("LlmAdapter.complete is a stub; use app.ai.router.AIRouter")
        raise NotImplementedError("LlmAdapter is unused; route via app.ai.router.AIRouter")
