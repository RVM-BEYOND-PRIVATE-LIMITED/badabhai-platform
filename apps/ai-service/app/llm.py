"""LiteLLM adapter — PLACEHOLDER for Phase 1.

The real adapter will route prompts through LiteLLM. In Phase 1 it is never
invoked with real traffic: callers check ``can_call()`` and fall back to mock
responses. Crucially, this adapter is only ever reachable AFTER pseudonymization
has succeeded (the caller must pass already-pseudonymized text).
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
        """Run a completion via LiteLLM. Phase 1: not wired — fails closed.

        ``prompt`` MUST already be pseudonymized by the caller.
        """
        enabled, reason = self.can_call()
        if not enabled:
            raise RuntimeError(f"LLM calls are disabled: {reason}")
        # TODO(Phase 2): integrate LiteLLM, e.g.
        #   import litellm
        #   resp = await litellm.acompletion(model=..., messages=[...],
        #       api_base=self._settings.litellm_base_url, api_key=self._settings.litellm_api_key)
        #   return resp.choices[0].message.content
        logger.warning("LlmAdapter.complete called but LiteLLM integration is not implemented")
        raise NotImplementedError("LiteLLM integration is not implemented in Phase 1")
