"""Process-wide singletons for the AI service.

Holds the module-globals that used to sit at the top of ``app/main.py`` (its
``logger`` / ``settings`` / ``router`` / ``stt_adapter`` / ``translate_adapter``
preamble) so that ``app.main`` AND every ``app.routers.*`` module share ONE of each
instead of constructing their own. ``app.main`` re-exports all five, so
``from app.main import settings`` (router / stt_adapter / translate_adapter /
logger likewise) keeps working exactly as before.

``configure_logging()`` runs HERE, before the adapters are built, only to preserve
the ORIGINAL ordering: main.py called it before constructing ``AIRouter``, whose
``LangfuseTracer`` emits one line at construction. main.py still calls it too (it is
idempotent — it clears the root handlers and installs the JSON one).

WHEN settings are read is unchanged: ``get_settings()`` is still called exactly once
at import of ``app.main`` (which imports this module), and the endpoints that
deliberately re-read per request still call ``get_settings()`` themselves.
"""

from __future__ import annotations

from .ai.router import AIRouter
from .config import get_settings
from .logging_config import configure_logging, get_logger
from .stt import SttAdapter
from .translate import TranslateAdapter

configure_logging()
logger = get_logger("ai-service")
settings = get_settings()
router = AIRouter(settings)
stt_adapter = SttAdapter(settings)
translate_adapter = TranslateAdapter(settings)
