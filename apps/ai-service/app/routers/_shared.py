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

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from typing import Any

from ..ai import prompt_registry, trace_metadata
from ..ai.langfuse_tracing import Observation, get_tracer
from ..ai.router import AIRouter
from ..config import get_settings
from ..contracts import PseudonymizationMeta
from ..logging_config import configure_logging, correlation_id_var, get_logger
from ..pseudonymize import PseudonymizationResult
from ..stt import SttAdapter
from ..translate import TranslateAdapter

configure_logging()
logger = get_logger("ai-service")
settings = get_settings()
router = AIRouter(settings)
stt_adapter = SttAdapter(settings)
translate_adapter = TranslateAdapter(settings)


@contextmanager
def workflow_scope(
    *,
    name: str,
    input: Any = None,
    worker_ref: str | None = None,
    session_id: str | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> Iterator[Observation]:
    """Open the ROOT trace for one business operation, correlated to the caller's request.

    THE ONE THING THIS ADDS over calling ``tracer.workflow`` directly: it reads the BL-19
    correlation id off the request context var that ``main.py``'s middleware already bound.
    That id came from ``apps/api``, which stamps the same value on every ai-service call it
    makes for one logical operation — so a parse and the Phase C extract that follow the
    same interview land in ONE trace instead of two unrelated ones.

    THE ID IS SAFE TO PUBLISH BY CONSTRUCTION. The middleware (``_safe_trace_id``) refuses
    anything that is not exactly UUID-shaped and mints a fresh uuid4 instead, precisely so
    a caller cannot get free text into a traced attribute. Nothing here needs to re-check
    it — but nothing here may widen that rule either.

    Fail-open like every other tracing call: a missing correlation id simply means this
    workflow is its own root, which is what every trace was before this existed.
    """
    correlation_id = correlation_id_var.get()
    with get_tracer().workflow(
        name=name,
        input=input,
        worker_ref=worker_ref,
        session_id=session_id,
        correlation_id=correlation_id,
        metadata=trace_metadata.build(
            workflow=name,
            application_version=settings.app_version,
            extra=dict(metadata) if metadata else None,
        ),
    ) as observation:
        yield observation


def resolve_prompt(name: str) -> prompt_registry.ResolvedPrompt | None:
    """The prompt to send, with its version, for ``name``. See ``ai/prompt_registry``.

    Wrapped here so routers pass the tracer without importing it: the tracer is only
    needed because Langfuse-managed prompts are fetched through the same client that
    exports the traces, and a route should not have to know that.
    """
    return prompt_registry.resolve(name, tracer=get_tracer())


def _pseudonymization_meta(result: PseudonymizationResult) -> PseudonymizationMeta:
    return PseudonymizationMeta(
        blocked=result.blocked,
        blocked_reason=result.blocked_reason,
        replaced_entities=result.replaced_entities,
        placeholder_tokens=result.placeholder_tokens,
    )
