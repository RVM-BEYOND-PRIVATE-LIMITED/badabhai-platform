"""Process-wide singletons shared by every router module.

Holds exactly what used to be the ``app/main.py`` module globals (the settings
snapshot, the AI router, the STT/translate adapters, the service logger) plus the
one helper used by more than one endpoint. ``app.main`` re-exports all of it, so
``from app.main import settings`` (and friends) keeps working.

``configure_logging()`` runs here because ``AIRouter(settings)`` logs at
construction: whichever module is imported first, the JSON formatter must already
be installed. It is idempotent, and ``app.main`` still calls it too.
"""

from __future__ import annotations

from ..ai.router import AIRouter
from ..config import get_settings
from ..contracts import PseudonymizationMeta
from ..logging_config import configure_logging, get_logger
from ..pseudonymize import PseudonymizationResult
from ..stt import SttAdapter
from ..translate import TranslateAdapter

configure_logging()
logger = get_logger("ai-service")
settings = get_settings()
router = AIRouter(settings)
stt_adapter = SttAdapter(settings)
translate_adapter = TranslateAdapter(settings)


def _pseudonymization_meta(result: PseudonymizationResult) -> PseudonymizationMeta:
    return PseudonymizationMeta(
        blocked=result.blocked,
        blocked_reason=result.blocked_reason,
        replaced_entities=result.replaced_entities,
        placeholder_tokens=result.placeholder_tokens,
    )
