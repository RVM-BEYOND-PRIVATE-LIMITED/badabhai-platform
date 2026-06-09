"""Optional Langfuse tracing wrapper.

Initializes ONLY when both Langfuse keys are present AND the package is
installed. Otherwise every method is a safe no-op, so local dev never crashes
and never depends on Langfuse.

PRIVACY: only pseudonymized text is ever passed here. This wrapper must never
receive or log raw phone/name/address/employer.
"""

from __future__ import annotations

from typing import Any

from ..config import Settings
from ..logging_config import get_logger

logger = get_logger("ai.langfuse")


class LangfuseTracer:
    def __init__(self, settings: Settings) -> None:
        self._enabled = False
        self._client: Any = None

        if not settings.langfuse_enabled:
            logger.info("langfuse disabled (keys missing)")
            return
        try:
            from langfuse import Langfuse  # type: ignore
        except Exception:  # package not installed -> safe no-op
            logger.info("langfuse package not installed; tracing disabled")
            return
        try:
            self._client = Langfuse(
                public_key=settings.langfuse_public_key,
                secret_key=settings.langfuse_secret_key,
                host=settings.langfuse_base_url,
            )
            self._enabled = True
            logger.info("langfuse enabled")
        except Exception as exc:  # never let tracing break boot
            logger.warning(
                "langfuse init failed; tracing disabled", extra={"extra": {"error": str(exc)}}
            )

    @property
    def enabled(self) -> bool:
        return self._enabled

    def trace_generation(
        self,
        *,
        task_type: str,
        model: str,
        real_call: bool,
        input_text: str,
        output_text: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Record one generation. ``input_text``/``output_text`` MUST already be
        pseudonymized. No-op when disabled; never raises."""
        if not self._enabled or self._client is None:
            return
        try:
            self._client.trace(
                name=task_type,
                input=input_text,
                output=output_text,
                metadata={"model": model, "real_call": real_call, **(metadata or {})},
            )
        except Exception as exc:  # pragma: no cover - tracing must never break flow
            logger.warning("langfuse trace failed", extra={"extra": {"error": str(exc)}})
