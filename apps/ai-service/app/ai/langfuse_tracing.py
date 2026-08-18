"""Langfuse tracing for every AI boundary this service crosses.

ONE thin, fail-open wrapper around the Langfuse Python SDK (v4 — the
OpenTelemetry-based line). The router's LLM calls, the skill embeds and the voice
transcription all record through here and nowhere else, so the optional import, the
privacy mask and the never-raise contract live in a single file.

STILL OPTIONAL. Tracing initializes only when both keys are present AND the package
is importable; otherwise every method is a safe no-op. Local dev, CI and the
mock-by-default posture never depend on Langfuse being reachable, and a tracing
outage can never take an interview down. Nothing here may raise — see ``_safe``.

THE HIERARCHY (added after the trace-shape audit). There are now THREE levels, and the
top one is new:

    WORKFLOW  ── one business operation, e.g. "profile a worker"     (``workflow()``)
      └── TASK ── one unit of AI work, e.g. "parse the answer map"   (``task()``)
            └── GENERATION ── one provider request                   (``observation()``)

Before this, ``task()`` was the root, so one worker's profile produced three to five
DISCONNECTED traces (the interview turns, the parse, Phase C's extract) with nothing tying
them together — you could see that a parse cost ₹0.31 but not that it belonged to the same
worker as the twelve turns before it. ``workflow()`` is that missing root. It is OPTIONAL:
a ``task()`` opened with no workflow around it behaves exactly as it always did and becomes
its own root, so every existing call site keeps working untouched.

CROSS-SERVICE CORRELATION. ``apps/api`` already stamps ``x-request-id`` and
``x-correlation-id`` on every call it makes here (BL-19), and ``main.py``'s middleware
already validates them to UUID shape and binds them to context vars. ``workflow()`` turns
that EXISTING id into the Langfuse trace id, deterministically, so the NestJS request and
every ai-service call it fans out to land in ONE trace. No new propagation system, no new
header, no new id — the correlation id was already there and was already PII-free by
construction (the middleware regenerates anything that is not UUID-shaped, precisely so a
caller cannot get free text into a trace attribute).

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

CAPABILITY PROBING, and why this file does something unusual. The SDK is an OPTIONAL
dependency that is not installed in this repo's dev or CI environment, so the exact method
names for scoring, prompt fetching and trace continuation cannot be verified here — only in
an image that installed ``requirements-ai.txt``. Hardcoding one guess would ship a feature
that is silently dead, which is the worst outcome for an observability layer: everything
still "works", the data is just never there. So each optional capability is BOUND ONCE at
init by probing the client for a short ordered list of plausible names, the result is
LOGGED, and it is reported on ``GET /health`` — an unbound capability is visible rather
than silent, and a version bump in either direction degrades to a no-op instead of a crash.
"""

from __future__ import annotations

import hashlib
import inspect
import sys
from collections.abc import Iterator, Mapping, Sequence
from contextlib import ExitStack, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from ..config import Settings
from ..logging_config import get_logger
from ..pseudonymize import pseudonymize
from .trace_metadata import AS_SPAN

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

#: Names for the non-LLM steps a workflow spends real time in. Same stability contract as
#: the four above. These are what turn "the request took 4.2 s" into "3.1 s of it was the
#: provider and 0.9 s was the gate wall" — the whole point of instrumenting a boundary that
#: makes no model call.
ROUTE_MODELS = "route-models"
APPLY_PARSE_GATES = "apply-parse-gates"
MATCH_JOB_DOMAIN = "match-job-domain"

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

#: Workflow names — the ROOT trace names. Business operations, not AI tasks: a workflow is
#: named for what a worker or payer was trying to do, which is the grain the question
#: "why did this candidate get this result?" is asked at.
WORKFLOW_PROFILE_INTERVIEW = "candidate-interview-turn"
WORKFLOW_PROFILE_BUILD = "build-worker-profile"
WORKFLOW_RESUME = "generate-worker-resume"
WORKFLOW_VOICE = "transcribe-worker-voice-note"
WORKFLOW_TAXONOMY = "resolve-taxonomy"

#: Langfuse score data types. Only the three the SDK documents across the v2->v4 line.
SCORE_NUMERIC = "NUMERIC"
SCORE_BOOLEAN = "BOOLEAN"
SCORE_CATEGORICAL = "CATEGORICAL"


@dataclass(frozen=True)
class WorkflowContext:
    """What an open workflow makes available to the tasks nested inside it.

    Carried in a ContextVar rather than threaded through every signature: the router is
    reached through four different call chains (a route handler, a BullMQ-driven route, the
    embed helper, the CLI) and adding a parameter to each would be a much larger and much
    more breakable change than the observability it buys.
    """

    workflow: str
    worker_ref: str | None = None
    session_id: str | None = None
    correlation_id: str | None = None
    trace_id: str | None = None


_workflow_ctx: ContextVar[WorkflowContext | None] = ContextVar("langfuse_workflow", default=None)


def current_workflow() -> WorkflowContext | None:
    """The open workflow, or None. Read by the router so a generation can record which
    business operation it belonged to without every caller passing it down."""
    return _workflow_ctx.get()


def _trace_identity(task_type: str) -> tuple[str, str]:
    """(trace name, feature tag) for ``task_type``; unknown ids keep their own id
    rather than being dropped into a bucket that hides them."""
    return _TASK_TRACE.get(task_type, (task_type.replace("_", "-"), "other"))


def derive_trace_id(correlation_id: str) -> str:
    """A stable 32-char lowercase-hex Langfuse/W3C trace id for a correlation id.

    DETERMINISTIC BY DESIGN — that is the entire mechanism behind cross-service
    correlation. The NestJS side does not know Langfuse exists and cannot mint a trace id;
    what it DOES have, already, is a correlation uuid it stamps on every outbound call. Two
    ai-service requests carrying the same correlation id must land in the same trace, and
    the only way to get that without a shared store is to compute the id from the input
    rather than generate one.

    SHA-256 rather than a straight hex-strip of the uuid: a uuid is 32 hex chars once its
    dashes are removed, so stripping would work, but it would also PUBLISH the correlation
    id verbatim as the trace id and tie the two identifier spaces together forever. Hashing
    keeps them independent — and keeps a trace id opaque to anyone who only has a log line.
    """
    return hashlib.sha256(correlation_id.encode("utf-8")).hexdigest()[:32]


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
        self._settings = settings
        # Optional capabilities, resolved by probe below. Every one of these stays None on
        # a client that does not expose it, and every consumer checks for None — an
        # unbound capability degrades to a no-op, never to an AttributeError.
        self._score_fn: Any = None
        self._score_style: str | None = None
        self._get_prompt_fn: Any = None
        self._trace_id_fn: Any = None
        self._supports_trace_context = False

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
            self._probe_capabilities(Langfuse)
            logger.info(
                "langfuse enabled",
                extra={
                    "extra": {
                        "environment": settings.langfuse_tracing_environment,
                        **self.capabilities,
                    }
                },
            )
        except Exception as exc:  # never let tracing break boot
            logger.warning(
                "langfuse init failed; tracing disabled", extra={"extra": {"error": str(exc)}}
            )

    # --- capability probing --------------------------------------------------
    def _probe_capabilities(self, client_class: Any) -> None:
        """Bind the optional SDK surfaces ONCE, by name, and record what was found.

        See the module docstring for why this is a probe rather than a hardcoded call.
        Each candidate list is ordered MOST-PREFERRED FIRST, and preference means "needs
        the least from us": a method that scores the ACTIVE trace cannot be handed the
        wrong trace id, so it beats one that makes us look the id up ourselves.

        Never raises: a probe failure leaves everything unbound, which is exactly the
        no-op state a missing method would produce anyway.
        """
        try:
            # Scoring. The three shapes across the v2->v4 line differ in what they need to
            # be told about WHICH trace they attach to; `_score_style` records that so
            # `record_score` calls each correctly instead of guessing kwargs.
            for name, style in (
                ("score_current_trace", "current"),
                ("create_score", "explicit"),
                ("score", "explicit"),
            ):
                fn = getattr(self._client, name, None)
                if callable(fn):
                    self._score_fn, self._score_style = fn, style
                    break

            # Prompt management.
            fn = getattr(self._client, "get_prompt", None)
            if callable(fn):
                self._get_prompt_fn = fn

            # Trace-id helper, used to keep our derived ids in whatever shape the SDK
            # expects. We can compute one ourselves (`derive_trace_id`), so this is a
            # preference, not a requirement.
            fn = getattr(client_class, "create_trace_id", None) or getattr(
                self._client, "create_trace_id", None
            )
            if callable(fn):
                self._trace_id_fn = fn

            # Cross-process continuation. Probed by SIGNATURE rather than by trying a call:
            # passing an unsupported kwarg would raise inside the first traced request,
            # which is precisely the failure this whole file exists to prevent.
            starter = getattr(self._client, "start_as_current_observation", None)
            if starter is not None:
                try:
                    params = inspect.signature(starter).parameters
                    self._supports_trace_context = "trace_context" in params or any(
                        p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()
                    )
                except (TypeError, ValueError):  # pragma: no cover - unintrospectable
                    self._supports_trace_context = False
        except Exception as exc:  # pragma: no cover - probing must never break boot
            logger.warning("langfuse capability probe failed", extra={"extra": {"error": str(exc)}})

    @property
    def capabilities(self) -> dict[str, Any]:
        """What this client can actually do, for ``GET /health`` and the logs.

        The POINT of surfacing this: every capability here degrades silently to a no-op by
        design, so without a readout "no scores in Langfuse" and "scores are unsupported by
        the installed SDK" look identical from the outside — and one of those is a bug.
        """
        return {
            "scores": self._score_style or "unavailable",
            "prompt_management": self._get_prompt_fn is not None,
            "trace_continuation": self._supports_trace_context,
        }

    @property
    def enabled(self) -> bool:
        return self._enabled

    # --- the root: one business operation ------------------------------------
    @contextmanager
    def workflow(
        self,
        *,
        name: str,
        input: Any = None,
        worker_ref: str | None = None,
        session_id: str | None = None,
        correlation_id: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> Iterator[Observation]:
        """The ROOT trace for one business operation. Everything else nests under it.

        ``correlation_id`` is the BL-19 id ``apps/api`` already sends. When present it is
        turned into the trace id deterministically (:func:`derive_trace_id`), which is what
        makes a NestJS request and the ai-service calls it fans out into ONE trace rather
        than three unrelated ones. When absent — a CLI run, a direct curl — the SDK
        generates its own id and the workflow is simply its own root, which is the same
        behaviour every trace had before this method existed.

        ALWAYS SETS THE CONTEXT VAR, even when tracing is disabled. The context is not only
        for Langfuse: the router reads it to put ``workflow`` into the metadata of a
        generation, and a mock-mode run should carry the same shape as a real one so the
        two are comparable.
        """
        # NORMALISED ONCE, HERE, and that is a correctness requirement rather than tidiness.
        # `Langfuse.create_trace_id(seed=...)` HASHES the seed — it does not pass it through —
        # so the id the SDK actually files the span under is not `derive_trace_id`'s output.
        # Storing the raw value here and normalising at each use site meant
        # `current_trace_id()` returned a DIFFERENT id from the one the span carried, which
        # would silently attach any explicitly-addressed score to a trace that does not exist.
        # Verified against langfuse 4.14.4: derive -> d1bfaf4a..., create_trace_id(seed) ->
        # bf268f59.... Latent today only because the probe binds `score_current_trace`, which
        # addresses the ACTIVE trace and never takes an id.
        ctx = WorkflowContext(
            workflow=name,
            worker_ref=worker_ref,
            session_id=session_id,
            correlation_id=correlation_id,
            trace_id=self._sdk_trace_id(derive_trace_id(correlation_id))
            if correlation_id
            else None,
        )
        token = _workflow_ctx.set(ctx)
        try:
            if not self._enabled or self._client is None:
                yield _NOOP
                return

            tags = [f"workflow:{name}"]

            def _open(stack: ExitStack) -> Any:
                stack.enter_context(
                    self._propagate(user_id=worker_ref, session_id=session_id, tags=tags)
                )
                kwargs: dict[str, Any] = {
                    "as_type": AS_SPAN,
                    "name": name,
                    "input": input,
                    "metadata": dict(metadata) if metadata else None,
                }
                # Only when the SDK actually accepts it — see `_probe_capabilities`.
                if ctx.trace_id and self._supports_trace_context:
                    kwargs["trace_context"] = {"trace_id": ctx.trace_id}
                return stack.enter_context(self._client.start_as_current_observation(**kwargs))

            with self._scope(_open, "workflow span") as observation:
                yield observation
        finally:
            _workflow_ctx.reset(token)

    def _sdk_trace_id(self, derived: str) -> str:
        """Our derived id, run through the SDK's own helper when it has one.

        The helper exists so a seed becomes whatever shape that SDK version considers a
        valid trace id. Ours is already 32 lowercase hex (the W3C shape), so this is
        belt-and-braces — and if the helper rejects or reshapes it, the SDK's answer wins,
        because it is the thing that has to accept it.
        """
        if self._trace_id_fn is None:
            return derived
        try:
            return self._trace_id_fn(seed=derived) or derived
        except Exception:  # pragma: no cover - helper signature varies by version
            return derived

    def current_trace_id(self) -> str | None:
        """The active Langfuse trace id, if any. Used to attach a score computed AFTER the
        traced block has closed (the parse gates run outside ``router.run``)."""
        ctx = _workflow_ctx.get()
        if ctx is not None and ctx.trace_id:
            return ctx.trace_id
        if not self._enabled or self._client is None:
            return None
        try:
            getter = getattr(self._client, "get_current_trace_id", None)
            return getter() if callable(getter) else None
        except Exception:  # pragma: no cover - tracing must never break flow
            return None

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
        """One unit of AI work — one extraction, one parse, one résumé, one voice note.

        THE ROOT ONLY WHEN NOTHING WRAPS IT. Opened inside a :meth:`workflow` this becomes
        a child span of it; opened alone it is still the trace root, exactly as before.
        That is what let the workflow layer be added without touching a single existing
        call site.

        ``user_ref`` is the OPAQUE worker/payer reference the spend ledger already
        attributes cost to — PII-free by construction, and exactly what Langfuse's
        per-user cost and quality views want. ``session_id`` is accepted for the
        callers that have one; when a workflow is open and this call did not supply
        either, they are INHERITED from it rather than being sent as None — passing
        None into ``propagate_attributes`` inside an open workflow would clear the
        user the workflow had just set.

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

        ctx = _workflow_ctx.get()
        effective_user = user_ref if user_ref is not None else (ctx.worker_ref if ctx else None)
        effective_session = (
            session_id if session_id is not None else (ctx.session_id if ctx else None)
        )

        def _open(stack: ExitStack) -> Any:
            # propagate_attributes is entered FIRST, so the root span itself carries
            # the user/tags rather than only its children.
            stack.enter_context(
                self._propagate(user_id=effective_user, session_id=effective_session, tags=tags)
            )
            kwargs: dict[str, Any] = {
                "as_type": AS_SPAN,
                "name": name,
                "input": input,
                "metadata": dict(metadata) if metadata else None,
            }
            # Carries the correlation-derived id when there is one. Harmless inside an
            # open workflow (the child would inherit the same trace anyway) and load-
            # bearing without one: the single-call routes (/skills/canonicalize, the embed
            # helper) never open a workflow, so this is their only route to correlation.
            #
            # `ctx.trace_id` is used AS-IS — it was already normalised through the SDK when
            # the workflow opened it. Re-normalising here would HASH IT A SECOND TIME
            # (`create_trace_id` is not idempotent), handing the child a different trace id
            # from its parent and splitting one workflow into two traces.
            if ctx is not None and ctx.trace_id and self._supports_trace_context:
                kwargs["trace_context"] = {"trace_id": ctx.trace_id}
            return stack.enter_context(self._client.start_as_current_observation(**kwargs))

        with self._scope(_open, "task span") as observation:
            yield observation

    @contextmanager
    def observation(
        self,
        *,
        name: str,
        as_type: str = AS_SPAN,
        input: Any = None,
        model: str | None = None,
        model_parameters: Mapping[str, Any] | None = None,
        prompt: Any = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> Iterator[Observation]:
        """A step nested under the active task — an LLM attempt, an embed, an STT call.

        ``as_type`` is the Langfuse observation type and is load-bearing, not
        cosmetic: only a ``generation``/``embedding`` carries model, tokens and cost,
        and the types drive filtering, evaluator targeting and the agent graph.

        ``prompt`` is the SDK's own prompt object, passed straight through so Langfuse can
        associate this generation with the managed prompt version that produced it. It is
        only ever non-None when the text actually CAME from Langfuse — a locally-built
        prompt records its content-hash version in metadata instead, because claiming a
        link to a managed prompt that was not used would corrupt that prompt's own metrics.

        Both ``model_parameters`` and ``prompt`` are omitted from the call entirely when
        empty, so an SDK version that does not accept them is never handed them.
        """
        if not self._enabled or self._client is None:
            yield _NOOP
            return

        def _open(stack: ExitStack) -> Any:
            kwargs: dict[str, Any] = {
                "as_type": as_type,
                "name": name,
                "input": input,
                "model": model,
                "metadata": dict(metadata) if metadata else None,
            }
            if model_parameters:
                kwargs["model_parameters"] = dict(model_parameters)
            if prompt is not None:
                kwargs["prompt"] = prompt
            return stack.enter_context(self._client.start_as_current_observation(**kwargs))

        with self._scope(_open, f"{as_type} observation") as observation:
            yield observation

    # --- evaluation ----------------------------------------------------------
    def record_score(
        self,
        *,
        name: str,
        value: float | bool | str,
        data_type: str = SCORE_NUMERIC,
        comment: str | None = None,
        trace_id: str | None = None,
    ) -> None:
        """Attach ONE deterministic measurement to the active trace.

        A SCORE MUST BE A REAL MEASUREMENT. Everything wired to this today is computed by
        code that already ran for its own reasons — the six-gate parse wall's accept/reject
        counts, a contract validation that either passed or did not. Nothing here estimates,
        and nothing asks a model to judge another model (that is deliberately a later
        stage). If a number cannot be pointed at a line that computed it, it does not
        belong in a score.

        ``comment`` is for a closed-set code or a count summary — NEVER worker text, and
        never a value the gate rejected. The mask does not run over score fields on every
        SDK version, so this one is disciplined at the call site rather than trusted to the
        hook.

        Fail-open like everything else here, and silent about it beyond a warning: a score
        that cannot be recorded must not cost the worker their profile.
        """
        if not self._enabled or self._score_fn is None:
            return
        if data_type == SCORE_BOOLEAN:
            # Langfuse's BOOLEAN scores are 1/0 on the wire; sending a Python bool where a
            # number is expected is the kind of thing that fails at the API, not the SDK.
            value = 1 if value else 0
        try:
            kwargs: dict[str, Any] = {"name": name, "value": value, "data_type": data_type}
            if comment is not None:
                kwargs["comment"] = comment
            if self._score_style == "explicit":
                resolved = trace_id or self.current_trace_id()
                if resolved is None:
                    # No trace to hang it on. Dropping is right: a score with no trace is
                    # an orphan row that no dashboard can join to anything.
                    return
                kwargs["trace_id"] = resolved
            self._score_fn(**kwargs)
        except Exception as exc:  # pragma: no cover - tracing must never break flow
            logger.warning(
                "langfuse score failed", extra={"extra": {"score": name, "error": str(exc)}}
            )

    # --- prompt management ---------------------------------------------------
    def fetch_prompt(self, name: str, *, fallback: str) -> tuple[Any, str, Any] | None:
        """``(prompt_client, text, version)`` from Langfuse, or None to use the local text.

        Called only by ``prompt_registry.resolve``; see that module for why the local
        prompt stays authoritative. ``fallback`` is handed to the SDK as well as being the
        caller's own answer, so a version of the SDK that supports it can serve the local
        text from inside its own cache path rather than raising.
        """
        if not self._enabled or self._get_prompt_fn is None:
            return None
        if not self._settings.langfuse_prompts_enabled:
            return None
        try:
            prompt = self._get_prompt_fn(
                name,
                fallback=fallback,
                cache_ttl_seconds=self._settings.langfuse_prompt_cache_ttl_seconds,
            )
        except Exception as exc:
            logger.warning(
                "langfuse get_prompt failed; using local",
                extra={"extra": {"prompt": name, "error": str(exc)}},
            )
            return None
        if prompt is None:
            return None
        # Duck-typed on purpose: the prompt client's attribute names are part of the
        # unverified surface, and a missing attribute must mean "use local", not a crash.
        text = getattr(prompt, "prompt", None)
        if not isinstance(text, str):
            return None
        return prompt, text, getattr(prompt, "version", None)

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
