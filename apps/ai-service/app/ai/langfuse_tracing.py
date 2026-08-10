"""Langfuse tracing for every AI boundary this service crosses.

ONE thin, fail-open wrapper around the Langfuse Python SDK (v4 — the
OpenTelemetry-based line). The router's LLM calls, the skill embeds and the voice
transcription all record through here and nowhere else, so the optional import, the
privacy mask and the never-raise contract live in a single file.

STILL OPTIONAL. Tracing initializes only when both keys are present AND the package
is importable; otherwise every method is a safe no-op. Local dev, CI and the
mock-by-default posture never depend on Langfuse being reachable, and a tracing
outage can never take an interview down. Nothing here may raise — see ``_safe``.

PRIVACY (CLAUDE.md §3) — two independent guarantees, in this order:

1. Callers pass ALREADY-PSEUDONYMIZED text. That is the real guarantee, and it is
   enforced upstream at the endpoint, before the router is ever reached.
2. This module masks AGAIN on the way out (``_mask``), running the same
   ``pseudonymize`` gate over every value the SDK is handed. Defense in depth, and
   not theoretical: the router traces ``mock_response`` as the output on the mock
   path and on every real-call failure, and for ``/profile/extract`` that payload is
   derived from the worker's RAW text — the egress the comment in
   ``routers/profile.py`` already calls out. A payload the gate BLOCKS is replaced
   wholesale by :data:`REDACTED`: fail closed, because an unmaskable payload must
   not leave the process just to buy us a prettier trace.

   The hook is ``mask=`` and not the newer ``mask_otel_spans=`` deliberately.
   ``mask`` runs synchronously as attributes are created, so raw text never enters
   the OTel span buffer at all, where ``mask_otel_spans`` only runs at export time.
   The one thing ``mask_otel_spans`` additionally covers is third-party OTel
   instrumentation, and this service loads none — every observation is hand-written
   here.

COST. ``model`` + ``usage_details`` are what a generation needs for Langfuse to
price the call itself from its model-pricing table. Our own ``estimated_cost_inr``
goes in METADATA and NEVER in ``cost_details``: that field is denominated in USD, so
posting rupees into it would silently overstate spend by ~85x on every dashboard.
"""

from __future__ import annotations

import sys
from collections.abc import Iterator, Mapping, Sequence
from contextlib import ExitStack, contextmanager
from typing import Any

from ..config import Settings
from ..logging_config import get_logger
from ..pseudonymize import pseudonymize

logger = get_logger("ai.langfuse")

#: What a payload becomes when the pseudonymization gate refuses it (fail closed).
REDACTED = "[REDACTED: blocked by the pseudonymization gate]"

#: Observation names. Verb-first, low-cardinality and STABLE. Langfuse evaluators,
#: dashboard queries and saved views target observations BY NAME, so renaming one
#: silently unhooks everything that referenced it — treat these like an API.
#: Deliberately NOT named after a model (``gemini-flash``): the model is already a
#: first-class attribute on a generation, and baking it into the name would break
#: every filter the day the route changes.
LLM_CALL = "llm-call"
EMBED_TEXT = "embed-text"
TRANSCRIBE = "transcribe-audio"
TRANSLATE = "translate-to-english"

#: ``task_type`` -> (trace name, feature tag). Task types are a closed, short set, so
#: they are safe to put in a name (the low-cardinality rule). The feature tag groups
#: several task types into the product surface they serve, which is the dimension the
#: name alone cannot give you: "what does profiling cost vs résumé generation?".
_TASK_TRACE: dict[str, tuple[str, str]] = {
    "profile_extraction": ("extract-worker-profile", "profiling"),
    "profile_parse": ("parse-worker-profile", "profiling"),
    "profiling_chat_turn": ("run-profiling-turn", "profiling"),
    "resume_generation": ("generate-resume", "resume"),
    "skill_embedding": ("embed-skill-aliases", "taxonomy"),
    "skill_canonicalization": ("canonicalize-skill", "taxonomy"),
    "skill_canonicalization_batch": ("canonicalize-skill-labels", "taxonomy"),
    "voice_transcription": ("transcribe-voice-note", "voice"),
}


def _trace_identity(task_type: str) -> tuple[str, str]:
    """(trace name, feature tag) for ``task_type``; unknown ids keep their own id
    rather than being dropped into a bucket that hides them."""
    return _TASK_TRACE.get(task_type, (task_type.replace("_", "-"), "other"))


def _mask_value(value: Any) -> Any:
    """Re-run the pseudonymization gate over one traced value (see the module note).

    Containers are walked so a masked string inside a messages list is still masked;
    non-text scalars (token counts, INR estimates, booleans, model ids) pass through
    untouched — they carry no identity by construction and re-writing them would only
    make the trace less useful.
    """
    if isinstance(value, str):
        result = pseudonymize(value)
        return REDACTED if result.blocked else result.text
    if isinstance(value, Mapping):
        return {key: _mask_value(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, str | bytes):
        return [_mask_value(item) for item in value]
    return value


def _mask(*, data: Any, **_kwargs: Any) -> Any:
    """The SDK's ``mask=`` hook. Fails CLOSED: if masking itself breaks, the payload
    is dropped rather than exported unmasked."""
    try:
        return _mask_value(data)
    except Exception:  # pragma: no cover - defensive; pseudonymize already catches
        return REDACTED


class Observation:
    """A traced step. Wraps a Langfuse span/generation, or NOTHING when tracing is
    disabled — callers write the same code either way and never branch on ``enabled``.

    ``update`` mirrors the SDK's own keyword names (``output``, ``metadata``,
    ``level``, ``status_message``, ``usage_details``, ``model``) so there is no
    private vocabulary to learn, and swallows every failure: an observability call
    must never be able to fail an interview.
    """

    __slots__ = ("_span",)

    def __init__(self, span: Any = None) -> None:
        self._span = span

    def update(self, **fields: Any) -> None:
        if self._span is None:
            return
        try:
            self._span.update(**fields)
        except Exception as exc:  # pragma: no cover - tracing must never break flow
            logger.warning("langfuse update failed", extra={"extra": {"error": str(exc)}})


#: The single shared no-op, so the disabled path allocates nothing per call.
_NOOP = Observation()


class LangfuseTracer:
    def __init__(self, settings: Settings) -> None:
        self._enabled = False
        self._client: Any = None
        self._propagate: Any = None

        if not settings.langfuse_enabled:
            logger.info("langfuse disabled (keys missing)")
            return
        try:
            from langfuse import Langfuse, propagate_attributes  # type: ignore
        except Exception:  # package not installed -> safe no-op
            logger.info("langfuse package not installed; tracing disabled")
            return
        try:
            self._client = Langfuse(
                public_key=settings.langfuse_public_key,
                secret_key=settings.langfuse_secret_key,
                base_url=settings.langfuse_base_url,
                # Keeps staging/CI traces out of the production dashboards and
                # evaluators instead of silently polluting them.
                environment=settings.langfuse_tracing_environment,
                mask=_mask,
            )
            self._propagate = propagate_attributes
            self._enabled = True
            logger.info(
                "langfuse enabled",
                extra={"extra": {"environment": settings.langfuse_tracing_environment}},
            )
        except Exception as exc:  # never let tracing break boot
            logger.warning(
                "langfuse init failed; tracing disabled", extra={"extra": {"error": str(exc)}}
            )

    @property
    def enabled(self) -> bool:
        return self._enabled

    @contextmanager
    def task(
        self,
        *,
        task_type: str,
        input: Any = None,
        user_ref: str | None = None,
        session_id: str | None = None,
        real_call: bool | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> Iterator[Observation]:
        """The root observation for ONE unit of AI work — one extraction, one parse,
        one résumé, one voice note. This is what becomes the Langfuse trace, so its
        input/output are the trace's input/output and deserve the most care.

        ``user_ref`` is the OPAQUE worker/payer reference the spend ledger already
        attributes cost to — PII-free by construction, and exactly what Langfuse's
        per-user cost and quality views want. ``session_id`` is accepted for the
        callers that have one; none of the shipped contracts carry a conversation id
        today (the OIE cutover left one parse per interview), so it is normally None.

        Nesting is automatic: if a caller has already opened a task, this becomes a
        child of it rather than starting a second trace.
        """
        if not self._enabled or self._client is None:
            yield _NOOP
            return

        name, feature = _trace_identity(task_type)
        tags = [f"feature:{feature}", f"task:{task_type}"]
        if real_call is not None:
            # The mock/real posture is a first-class business dimension HERE: this
            # service is mock-by-default with a per-task real allowlist, so "is this
            # dashboard measuring real spend?" is a question you ask constantly.
            tags.append("real-call" if real_call else "mock-call")

        def _open(stack: ExitStack) -> Any:
            # propagate_attributes is entered FIRST, so the root span itself carries
            # the user/tags rather than only its children.
            stack.enter_context(self._propagate(user_id=user_ref, session_id=session_id, tags=tags))
            return stack.enter_context(
                self._client.start_as_current_observation(
                    as_type="span",
                    name=name,
                    input=input,
                    metadata=dict(metadata) if metadata else None,
                )
            )

        with self._scope(_open, "task span") as observation:
            yield observation

    @contextmanager
    def observation(
        self,
        *,
        name: str,
        as_type: str = "span",
        input: Any = None,
        model: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> Iterator[Observation]:
        """A step nested under the active task — an LLM attempt, an embed, an STT call.

        ``as_type`` is the Langfuse observation type and is load-bearing, not
        cosmetic: only a ``generation``/``embedding`` carries model, tokens and cost,
        and the types drive filtering, evaluator targeting and the agent graph.
        """
        if not self._enabled or self._client is None:
            yield _NOOP
            return

        def _open(stack: ExitStack) -> Any:
            return stack.enter_context(
                self._client.start_as_current_observation(
                    as_type=as_type,
                    name=name,
                    input=input,
                    model=model,
                    metadata=dict(metadata) if metadata else None,
                )
            )

        with self._scope(_open, f"{as_type} observation") as observation:
            yield observation

    @contextmanager
    def _scope(self, open_span: Any, label: str) -> Iterator[Observation]:
        """Run ``open_span`` and hold the result open for the caller's block.

        THE TWO CONTRACTS this exists to keep apart, because the obvious
        ``try: with ...: yield`` shape breaks both:

        - A failure to START tracing must degrade to a no-op. Wrapping the whole
          ``with`` in ``try/except`` instead catches exceptions raised by the CALLER'S
          BODY, and a ``@contextmanager`` that swallows those and yields a second time
          raises ``RuntimeError: generator didn't stop after throw()`` — turning a
          provider timeout into a crash in the observability layer.
        - A failure in the caller's body must propagate UNCHANGED. Ending the span
          from ``finally`` with the live ``sys.exc_info()`` lets the SDK record the
          error on the span, while the exception keeps unwinding: the ``finally``
          means a ``__exit__`` that returns True cannot silently swallow it either.
        """
        stack = ExitStack()
        span: Any = None
        try:
            span = open_span(stack)
        except Exception as exc:
            logger.warning(f"langfuse {label} failed", extra={"extra": {"error": str(exc)}})
            # Unwind whatever DID open (the attribute context may have entered before
            # the span failed), then carry an empty stack so the exit below is a no-op.
            stack.close()
            stack = ExitStack()
        try:
            yield Observation(span)
        finally:
            try:
                stack.__exit__(*sys.exc_info())
            except Exception as exc:  # pragma: no cover - tracing must never break flow
                logger.warning(
                    f"langfuse {label} close failed", extra={"extra": {"error": str(exc)}}
                )

    def flush(self) -> None:
        """Block until buffered spans are sent, leaving the client usable.

        For a script or eval runner that wants its traces visible before it moves on;
        the SDK's own ``atexit`` hook covers a clean exit, and the service uses
        :meth:`shutdown` from the lifespan instead."""
        self._safe(lambda client: client.flush(), "flush")

    def shutdown(self) -> None:
        """Flush and stop the background exporter. Called from the FastAPI lifespan:
        the SDK registers an ``atexit`` hook, but a container that is SIGTERM'd mid
        `docker stop` does not reliably reach it, and the last traces of a deploy are
        exactly the ones you want."""
        self._safe(lambda client: client.shutdown(), "shutdown")

    def _safe(self, action: Any, label: str) -> None:
        if not self._enabled or self._client is None:
            return
        try:
            action(self._client)
        except Exception as exc:  # pragma: no cover - tracing must never break flow
            logger.warning(f"langfuse {label} failed", extra={"extra": {"error": str(exc)}})


_tracer: LangfuseTracer | None = None


def get_tracer() -> LangfuseTracer:
    """Return the process singleton (built once from get_settings()).

    Mirrors ``cost_tracker.get_ledger()`` deliberately, and for the same reason: the
    AI boundaries that need it (the embed helper, the STT endpoint, the lifespan
    hook) are module-level functions with no place to inject one, and every extra
    tracer would mean another SDK client and another background exporter for the
    same keys. One process, one exporter, one flush at shutdown.
    """
    global _tracer
    if _tracer is None:
        from ..config import get_settings

        _tracer = LangfuseTracer(get_settings())
    return _tracer
