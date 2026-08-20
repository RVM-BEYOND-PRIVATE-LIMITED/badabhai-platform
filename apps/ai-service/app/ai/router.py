"""AI router: the single entry point for model calls.

Owns infrastructure concerns — model routing, mock-vs-real gating, cost/token
accounting, and Langfuse tracing. Domain callers supply the prompt messages and
a deterministic ``mock_response``; the router decides whether to actually call a
model and always returns ``(content, AICallMetadata)``.

INVARIANTS:
- Messages passed here MUST already be pseudonymized. The router does NOT
  pseudonymize; that is enforced by the endpoint before the router is reached.
- The router NEVER raises for model failures — it falls back to ``mock_response``
  so the worker flow always completes (fail-safe, while LLM calls fail-closed).
"""

from __future__ import annotations

import time
from typing import Any

from ..config import Settings
from ..contracts import TRACE_TEXT_FIELDS, AICallMetadata
from ..logging_config import get_logger
from . import cost_tracker, error_taxonomy, providers, trace_metadata
from .errors import REASON_HTTP_429, REASON_MAX_TOKENS_NO_PARTS, LlmTransportError
from .langfuse_tracing import (
    LLM_CALL,
    LangfuseTracer,
    Observation,
    current_workflow,
    get_tracer,
    masked_trace_text,
)
from .model_config import get_route, provider_for_model, resolve_model
from .provider_cooldown import get_cooldown
from .trace_metadata import AS_GENERATION

logger = get_logger("ai.router")

# A chat message in OpenAI-style format (mapped to Gemini by the client).
Message = dict[str, str]

# FAILURES A RETRY CANNOT FIX. Hitting one breaks the per-candidate attempt loop and
# escalates to the next provider immediately, instead of spending the remaining
# attempts on an outcome that is already decided.
#
#   max_tokens_no_parts — the model hit its output ceiling and returned no parts.
#     The next attempt sends the identical request and hits the identical ceiling.
#
#   http_429 — a rate limit, and retrying one is how you STAY rate-limited: every
#     attempt spends another token from a bucket that is already empty, and the
#     provider counts the rejected request against the same window. This loop runs
#     ``max_retries + 1`` times (3 for extraction/parse) and each pass wraps the
#     Gemini client's OWN in-call 429 loop, so one parse could put 15 POSTs on the
#     wire, none of which could have succeeded. Falling over to Claude is both
#     faster and cheaper than waiting out a window this request will not outlive.
#
# Everything else stays retryable: a timeout, a 5xx, or a malformed response can
# genuinely differ on the next attempt.
_NO_RETRY_REASONS: frozenset[str] = frozenset(
    {
        REASON_MAX_TOKENS_NO_PARTS,
        REASON_HTTP_429,
    }
)

# The two `AICallMetadata` fields that carry TEXT rather than a count or a code, held
# back from the Langfuse task-span metadata blob.
#
# NOT tidiness. `input`/`output` are NATIVE Langfuse fields and they are the ONLY two the
# privacy mask rewrites (`trace_metadata`'s rule: never duplicate a native field). Letting
# these ride the metadata dump would put the prompt and the response into the trace TWICE
# — once where the mask governs them and once in a free-form blob — and would roughly
# double the payload of every span on a service whose largest values are prompts.
#
# THE SET ITSELF MOVED TO `app/contracts.py`, beside the model that declares the fields,
# because `ai/cost_tracker.py` needs the identical exclusion for its `ai_call` structured
# log line and two copies of "which fields are the dangerous ones" is one copy too many.
_TRACE_TEXT_FIELDS = TRACE_TEXT_FIELDS

# MSG-1: an accurate headline per spend-ledger block reason. The ledger already
# returns a CLOSED SET of distinct reasons; collapsing them into one "spend cap
# reached" line made a CONFIG error (unreachable Redis) indistinguishable from a
# real budget stop. Keys mirror the reasons produced by cost_tracker's backends
# (the Lua script + the fail-closed except path). PII-free, no value interpolation.
_SPEND_BLOCK_LOG_MESSAGES = {
    "spend_store_unavailable": (
        "spend ledger unreachable; blocking real call (fail-closed, NOT a cap) — "
        "check AI_SPEND_REDIS_URL"
    ),
    "daily_cap_exceeded": "daily spend cap reached; blocking real call",
    "cumulative_cap_exceeded": "cumulative spend cap reached; blocking real call",
    "user_daily_cap_exceeded": "per-user daily spend cap reached; blocking real call",
}


def _attempt_failure_message(
    *,
    task_type: str,
    model: str,
    attempt: int,
    max_attempts: int,
    reason: str,
    status: int | None,
    typed: bool,
) -> str:
    """The per-attempt failure headline — self-describing, PII-free.

    THE DEFECT it fixes: this line used to be the bare string "llm attempt failed".
    A real owner-run session printed it twice and then succeeded, and the operator
    had no way to tell WHICH provider failed or WHY. The structured ``extra`` did
    carry the reason, but only the JSON formatter renders it (``logging_config``),
    and the CLI/plain-`logging` paths never install it — so in the place this line
    is actually READ, the reason was invisible. The diagnosis therefore belongs in
    the MESSAGE.

    HONESTY about what we know (the point of the ``typed`` split): a
    :class:`LlmTransportError` carries a CLOSED-SET ``reason_code`` (and sometimes
    an HTTP status) — an actual diagnosis. Any other exception carries no such
    thing; all we have is its CLASS NAME, which is not a reason. The two are
    rendered under DIFFERENT keys (``reason=`` vs ``error_class=``) and the second
    says so out loud, rather than dressing a class name up as a cause. This is the
    same failure mode as the "model unavailable" / "spend cap reached" messages
    that cost this project two debugging rounds.

    PII: every part is a config id, a closed-set code, an exception CLASS name or an
    int. The exception BODY, the prompt and the API key are never touched — see the
    contract in ``ai/errors.py``.
    """
    where = f"provider={provider_for_model(model)} model={model}"
    if typed:
        cause = f"reason={reason}" + (f" status={status}" if status is not None else "")
    else:
        cause = f"error_class={reason} (no transport reason code)"
    return (
        f"llm attempt failed: task={task_type} {where} {cause} attempt={attempt + 1}/{max_attempts}"
    )


class AIRouter:
    def __init__(self, settings: Settings, tracer: LangfuseTracer | None = None) -> None:
        self._settings = settings
        self._tracer = tracer or get_tracer()

    @property
    def langfuse_enabled(self) -> bool:
        """Whether tracing is ACTUALLY active (keys present AND package installed).
        Distinct from `settings.langfuse_enabled`, which only reflects config."""
        return self._tracer.enabled

    async def run(
        self,
        task_type: str,
        *,
        messages: list[Message],
        mock_response: str,
        real_call_allowed: bool = True,
        user_ref: str | None = None,
        prompt: Any = None,
    ) -> tuple[str, AICallMetadata]:
        """One unit of AI work, and therefore ONE Langfuse trace.

        The trace root is opened here rather than inside :meth:`_dispatch` so that a
        call which never reaches a provider — mock posture, a spend cap, the kill
        switch — is still a trace that says so. Those are the calls an operator most
        needs to see, and they are precisely the ones a provider-level integration
        would never record.

        ``messages`` (already pseudonymized) is the trace input verbatim: it is a
        role-labelled OpenAI-shaped list, which is what makes Langfuse render it as a
        conversation instead of a JSON blob.

        ``prompt`` is an optional :class:`~app.ai.prompt_registry.ResolvedPrompt`. The
        router does not build prompts and never will — the caller owns the messages — but
        it is the only place that opens a generation, so it is the only place that CAN
        record which prompt version produced the output. Callers that have one pass it;
        callers that do not are unchanged and simply record no prompt dimension.
        """
        # Per-task gating: real only if the master flag + key are set AND this
        # task is allowlisted (empty allowlist = NO tasks; fail-closed). Lets
        # ONE role go real. Computed BEFORE the span so the posture can be a tag.
        real = self._settings.real_call_enabled_for(task_type) and real_call_allowed
        workflow = current_workflow()
        with self._tracer.task(
            task_type=task_type,
            input=messages,
            user_ref=user_ref,
            real_call=real,
            metadata=trace_metadata.build(
                workflow=workflow.workflow if workflow else None,
                task=task_type,
                application_version=self._settings.app_version,
                prompt_name=getattr(prompt, "name", None),
                prompt_version=getattr(prompt, "version", None),
                prompt_source=getattr(prompt, "source", None),
                real_call=real,
                extra={"real_call_allowed": real_call_allowed},
            ),
        ) as task:
            return await self._dispatch(
                task_type,
                task=task,
                messages=messages,
                mock_response=mock_response,
                real=real,
                user_ref=user_ref,
                prompt=prompt,
            )

    async def _dispatch(
        self,
        task_type: str,
        *,
        task: Observation,
        messages: list[Message],
        mock_response: str,
        real: bool,
        user_ref: str | None,
        prompt: Any = None,
    ) -> tuple[str, AICallMetadata]:
        route = get_route(task_type, self._settings)
        primary_model = resolve_model(task_type, self._settings)
        input_text = "\n".join(m.get("content", "") for m in messages)
        start = time.perf_counter()
        workflow = current_workflow()
        # Sampling parameters are IDENTICAL for every attempt of a dispatch (the route
        # decides them, and no retry path mutates them), so they are computed once here
        # rather than rebuilt per attempt.
        model_params = trace_metadata.model_parameters(
            temperature=route.temperature,
            max_output_tokens=route.max_output_tokens,
            json_mode=route.json_mode,
        )

        # Ordered provider-fallback chain: primary (Gemini) first, then the
        # configured cross-provider fallback (Claude Haiku) IFF its key is set
        # AND its provider differs from the primary's. Each candidate is tried in
        # turn; the first success wins. messages are pseudonymized once, upstream,
        # and reused unchanged for every candidate (privacy invariant intact).
        candidates = self._candidate_models(primary_model) if real else []

        # Hard spend ceiling: a candidate whose WORST-CASE cost (input tokens +
        # the route's max output tokens, priced at THAT model's rate) would exceed
        # the per-call cap is skipped. Stateless runaway guard; per-profile
        # cumulative budgets are a deferred enhancement.
        ledger = cost_tracker.get_ledger()
        cooldown = get_cooldown(self._settings)
        any_attempted = False  # did at least one candidate actually reach the network?
        ceiling_skipped_any = False
        cooldown_skipped_any = False  # a candidate was skipped as rate-limited
        spend_block_reason: str | None = None  # daily/cumulative cap hit (TD27)
        retry_budget_hit = False  # rolling retry budget exhausted (TD27)
        # Diagnostics (reconcile per-attempt log volume vs per-call metadata, and
        # attribute a terminal failure to the model that ACTUALLY failed last —
        # not always the primary). All PII-free: model ids + closed-set reasons.
        last_attempted_model: str | None = None
        last_failure_reason: str | None = None
        attempt_count = 0  # every dispatch to providers.complete across candidates
        candidates_tried: list[str] = []  # each candidate that reached the network
        for model in candidates:
            # 0. Rate-limit cooldown: this provider told us to stop recently enough that
            # the window has not reopened. Skip it WITHOUT a network call and let the
            # chain fall through to the next candidate.
            #
            # FIRST, before the cost estimate and before the ledger reserve, because a
            # call we are not going to make should not reserve spend that then has to be
            # refunded — and because being cheap is the entire point: this runs in front
            # of every candidate on every real call.
            provider = provider_for_model(model)
            if await cooldown.is_cooling(provider, self._settings):
                logger.warning(
                    "provider cooling down after a rate limit; skipping candidate",
                    extra={"extra": {"task": task_type, "model": model, "provider": provider}},
                )
                cooldown_skipped_any = True
                continue

            worst_case_inr = cost_tracker.estimate_cost_inr(
                model, cost_tracker.estimate_tokens(input_text), route.max_output_tokens
            )
            # 1. Per-call ceiling: a single call whose worst case is too pricey.
            if worst_case_inr > self._settings.ai_max_call_cost_inr:
                logger.warning(
                    "cost ceiling exceeded; skipping candidate",
                    extra={
                        "extra": {
                            "task": task_type,
                            "model": model,
                            "worst_case_inr": worst_case_inr,
                            "ceiling_inr": self._settings.ai_max_call_cost_inr,
                        }
                    },
                )
                ceiling_skipped_any = True
                continue

            # 2. Cumulative spend caps (TD27): an atomic check-AND-RESERVE of the
            # worst-case projected cost, BEFORE the call. A breach reserves nothing
            # and blocks EVERY candidate -> mock fallback (same fail-closed posture
            # as the ceiling). spend_store_unavailable (Redis unreachable) flows
            # through here too. On success the reservation MUST be reconciled (on a
            # real success) or refunded (on every non-success path) exactly once.
            reason = await ledger.would_exceed_spend(
                worst_case_inr, self._settings, user_ref=user_ref
            )
            if reason is not None:
                # MSG-1: surface the REAL reason. This used to log "spend cap
                # reached" for EVERY block reason, including
                # ``spend_store_unavailable`` — so an unreachable/misconfigured
                # ledger Redis (a CONFIG error) presented as a cap/model problem
                # and cost real debugging time. The reason is a closed set; map it
                # to an accurate headline. Distinguishing them changes only the
                # MESSAGE — every reason still blocks the real call (fail-closed).
                logger.warning(
                    _SPEND_BLOCK_LOG_MESSAGES.get(reason, "real call blocked by the spend ledger"),
                    extra={
                        "extra": {
                            "task": task_type,
                            "model": model,
                            "reason": reason,
                            "worst_case_inr": worst_case_inr,
                        }
                    },
                )
                spend_block_reason = reason
                continue

            # A reservation is now outstanding for THIS candidate. ``reconciled``
            # guards the refund-on-failure: it is set True only by a real success
            # (which reconciles reserved->actual). Any other exit from this
            # candidate (all attempts failed, or the retry budget broke the loop)
            # falls through to the full refund below.
            reconciled = False
            any_attempted = True
            candidates_tried.append(model)  # once per candidate that reaches network
            try:
                for attempt in range(route.max_retries + 1):
                    # 3. Retry budget (TD27): a RETRY (attempt > 0) must consume a
                    # slot of the rolling cross-request budget. Exhausted -> stop
                    # hammering this failing provider (break the retry loop).
                    if attempt > 0 and not ledger.try_consume_retry(self._settings):
                        retry_budget_hit = True
                        logger.warning(
                            "retry budget exhausted; stopping retries",
                            extra={
                                "extra": {
                                    "task": task_type,
                                    "model": model,
                                    "attempt": attempt,
                                    "budget_per_window": self._settings.ai_retry_budget_per_window,
                                }
                            },
                        )
                        break
                    attempt_count += 1  # counts every dispatch (across candidates)
                    # ONE generation per dispatch, not one per call. A cross-provider
                    # fallback that succeeded on its third try is the single most
                    # useful thing this router can show an operator, and collapsing
                    # the chain into one observation would hide both the retries and
                    # the fact that a DIFFERENT model served the answer. The name is
                    # constant and the varying parts (model, attempt) are attributes,
                    # so filters and dashboards keep matching.
                    with self._tracer.observation(
                        name=LLM_CALL,
                        as_type=AS_GENERATION,
                        input=messages,
                        model=model,
                        # Sampling parameters move to the SDK's first-class field; they
                        # used to sit in metadata, where an A/B on temperature could only
                        # be run by diffing JSON blobs.
                        model_parameters=model_params,
                        # Only ever non-None for a Langfuse-MANAGED prompt — see
                        # `prompt_registry`. A locally-built prompt records its content
                        # hash in the metadata below instead, because linking a generation
                        # to a managed prompt that did not produce it would corrupt that
                        # prompt's own metrics.
                        prompt=getattr(prompt, "client", None),
                        metadata=trace_metadata.build(
                            workflow=workflow.workflow if workflow else None,
                            task=task_type,
                            provider=provider_for_model(model),
                            application_version=self._settings.app_version,
                            prompt_name=getattr(prompt, "name", None),
                            prompt_version=getattr(prompt, "version", None),
                            prompt_source=getattr(prompt, "source", None),
                            attempt=attempt + 1,
                            max_attempts=route.max_retries + 1,
                            real_call=True,
                            extra={
                                # WHICH candidate in the fallback chain this is. Without
                                # it, "attempt 1" on the Haiku generation and "attempt 1"
                                # on the Gemini one are indistinguishable, and the
                                # fallback rate — the number Part 8 is actually about —
                                # cannot be computed.
                                "candidate_index": len(candidates_tried),
                                "is_fallback_candidate": model != primary_model,
                            },
                        ),
                    ) as generation:
                        try:
                            result = await providers.complete(
                                settings=self._settings,
                                model=model,
                                messages=messages,
                                max_output_tokens=route.max_output_tokens,
                                temperature=route.temperature,
                                json_mode=route.json_mode,
                            )
                            latency = int((time.perf_counter() - start) * 1000)
                            in_tok = result.input_tokens or cost_tracker.estimate_tokens(input_text)
                            out_tok = result.output_tokens or cost_tracker.estimate_tokens(
                                result.content
                            )
                            meta = cost_tracker.build_call_metadata(
                                task_type=task_type,
                                model=model,
                                real_call=True,
                                input_tokens=in_tok,
                                output_tokens=out_tok,
                                latency_ms=latency,
                                success=True,
                                settings=self._settings,
                                attempt_count=attempt_count,
                                candidates_tried=candidates_tried,
                            )
                            # Reconcile the reservation: refund worst_case - actual so
                            # the net recorded spend is the ACTUAL estimated cost.
                            await ledger.record_spend(
                                worst_case_inr, meta.estimated_cost_inr, user_ref=user_ref
                            )
                            reconciled = True
                            generation.update(
                                output=result.content,
                                # Model id + token buckets are all Langfuse needs to
                                # price the call from its own table. `estimated_cost_inr`
                                # stays in metadata — `cost_details` is USD.
                                usage_details={"input": in_tok, "output": out_tok},
                                metadata={
                                    "tokens_reported_by_provider": bool(
                                        result.input_tokens and result.output_tokens
                                    ),
                                    "estimated_cost_inr": meta.estimated_cost_inr,
                                },
                            )
                            self._finish_task(
                                task,
                                messages,
                                result.content,
                                meta,
                                # The SUCCESS path needs the fallback dimension too. A
                                # call served by Haiku after Gemini failed twice is a
                                # success, and it is also the single most important thing
                                # a provider-reliability dashboard has to count — reading
                                # it only off the failure branch would undercount it to
                                # zero.
                                extra={
                                    "primary_model": primary_model,
                                    "candidates_considered": candidates,
                                    "fell_back_to_another_provider": model != primary_model,
                                },
                            )
                            return result.content, meta
                        except Exception as exc:
                            # NEVER log the exception body (may echo pseudonymized
                            # content). A LlmTransportError carries a PII-free
                            # closed-set reason_code; any other exception is reduced to
                            # its type NAME. Track the last failing model + reason so
                            # the terminal metadata attributes the failure truthfully.
                            last_attempted_model = model
                            transport = exc if isinstance(exc, LlmTransportError) else None
                            reason = (
                                transport.reason_code
                                if transport is not None
                                else type(exc).__name__
                            )
                            last_failure_reason = reason
                            status = transport.status_code if transport is not None else None
                            logger.warning(
                                _attempt_failure_message(
                                    task_type=task_type,
                                    model=model,
                                    attempt=attempt,
                                    max_attempts=route.max_retries + 1,
                                    reason=reason,
                                    status=status,
                                    typed=transport is not None,
                                ),
                                extra={
                                    "extra": {
                                        "attempt": attempt,
                                        "task": task_type,
                                        "model": model,
                                        "provider": provider_for_model(model),
                                        "reason": reason,
                                        "status": status,
                                    }
                                },
                            )
                            # The SAME closed-set code the log carries — never the
                            # exception body, which can echo pseudonymized content.
                            #
                            # BOTH grains ride along, deliberately: `status_message` keeps
                            # the SPECIFIC code an operator needs to act on, while
                            # `error_category` is the coarse axis a dashboard groups by.
                            # Collapsing to one loses either the diagnosis or the ability
                            # to ask "how often does any provider rate-limit us?".
                            generation.update(
                                level="ERROR",
                                status_message=reason,
                                metadata={
                                    "status_code": status,
                                    "typed_transport_error": (transport is not None),
                                    "error_category": error_taxonomy.categorize_transport(reason),
                                    # Says whether the NEXT loop iteration will happen, so
                                    # a trace shows the retry DECISION and not just its
                                    # consequence. `http_429`/`max_tokens_no_parts` break
                                    # the loop; everything else retries if budget remains.
                                    "retryable": reason not in _NO_RETRY_REASONS,
                                },
                            )
                            # ARM THE COOLDOWN, so the NEXT request skips this provider
                            # instead of rediscovering the same rate limit. Awaited rather
                            # than fired-and-forgotten: a background task could still be
                            # pending when the following request runs its check, which is
                            # exactly the race the cooldown exists to close. The store
                            # fails open, so this cannot raise.
                            if reason == REASON_HTTP_429:
                                await cooldown.start(provider, self._settings)
                            if reason in _NO_RETRY_REASONS:
                                break
            finally:
                # Leak fix: if this candidate's reservation was not reconciled by a
                # real success, fully refund it (actual=0.0) before moving on. This
                # runs on EVERY non-success exit from the candidate — all attempts
                # failed, the retry-budget break, or the outer break below.
                if not reconciled:
                    await ledger.record_spend(worst_case_inr, 0.0, user_ref=user_ref)
            if retry_budget_hit:
                break

        # No candidate succeeded (or none were allowed). Fall back to the
        # deterministic mock — the router NEVER raises (fail-safe). Metadata is
        # reported under the PRIMARY model. Terminal states:
        #   - at least one candidate hit the network and all failed -> real_call
        #     True, success False, "retry_budget_exhausted" if a retry was
        #     budget-blocked else "llm_call_failed".
        #   - no candidate attempted but a spend cap blocked them -> real_call
        #     False, success True, "daily_cap_exceeded"/"cumulative_cap_exceeded".
        #   - no candidate attempted, every one cooling after a 429 -> real_call
        #     False, success True, "provider_cooldown".
        #   - no candidate attempted, only ceiling-skipped -> real_call False,
        #     success True, "cost_ceiling_exceeded".
        #   - real disabled/opted-out/not-allowlisted -> "kill_switch_engaged"
        #     when the kill-switch is on, else plain mock (error_code None).
        #
        # THE COOLDOWN BRANCH OUTRANKS THE CEILING because it is the more specific and
        # more actionable diagnosis: "we are rate-limited right now, this will clear on
        # its own" is a different instruction to an operator than "this call is too
        # expensive to make", and only one of them resolves without a config change.
        if any_attempted:
            real_flag, success = True, False
            error_code = "retry_budget_exhausted" if retry_budget_hit else "llm_call_failed"
        elif spend_block_reason is not None:
            real_flag, success, error_code = False, True, spend_block_reason
        elif cooldown_skipped_any:
            real_flag, success, error_code = False, True, "provider_cooldown"
        elif ceiling_skipped_any:
            real_flag, success, error_code = False, True, "cost_ceiling_exceeded"
        elif self._settings.ai_real_calls_kill_switch:
            real_flag, success, error_code = False, True, "kill_switch_engaged"
        else:
            real_flag, success, error_code = False, True, None

        latency = int((time.perf_counter() - start) * 1000)
        # Attribute a terminal failure to the model that ACTUALLY failed last (e.g.
        # the Haiku fallback), not always the primary — fixes the divergence where
        # a Haiku-served attempt was mis-labelled as Gemini. When nothing was
        # attempted (spend/ceiling/kill-switch/plain-mock) fall back to the primary.
        report_model = last_attempted_model or primary_model
        meta = cost_tracker.build_call_metadata(
            task_type=task_type,
            model=report_model,
            real_call=real_flag,
            input_tokens=cost_tracker.estimate_tokens(input_text),
            output_tokens=cost_tracker.estimate_tokens(mock_response),
            latency_ms=latency,
            success=success,
            settings=self._settings,
            error_code=error_code,
            attempt_count=attempt_count,
            candidates_tried=candidates_tried,
            failure_reason=last_failure_reason,
        )
        self._finish_task(
            task,
            messages,
            mock_response,
            meta,
            # WHY no candidate ran, in the router's own words. The terminal
            # `error_code` already names the outcome; these name the gates that
            # produced it, so a trace distinguishes "the ledger stopped us" from
            # "every model was too expensive" without reading the service logs.
            #
            # THE FULL ROUTING DECISION CHAIN LIVES HERE rather than in a span of its
            # own. Part 8's question — initial model, attempts, failure reason, fallback,
            # final result — is answerable from these attributes plus the per-attempt
            # generations, and a candidate loop is ONE logical step: a span per gate
            # would add four empty spans to every mock call, which is exactly the
            # instrumentation noise a trace becomes useless from.
            extra={
                "spend_block_reason": spend_block_reason,
                "cost_ceiling_skipped_candidate": ceiling_skipped_any,
                "provider_cooldown_skipped_candidate": cooldown_skipped_any,
                "retry_budget_exhausted": retry_budget_hit,
                "primary_model": primary_model,
                "candidates_considered": candidates,
                "fell_back_to_another_provider": len(candidates_tried) > 1,
                "error_category": error_taxonomy.categorize_terminal(error_code),
            },
        )
        return mock_response, meta

    def _candidate_models(self, primary_model: str) -> list[str]:
        """Ordered provider-fallback chain for a real call.

        ``primary_model`` first; then ``settings.default_fallback_model`` IFF the
        FALLBACK's OWN provider transport is actually usable (credential set AND its
        client library importable) AND its provider differs from the primary's.
        De-duplicated, order preserved. Gating on the fallback provider's own
        TRANSPORT (not just a hardcoded key) lets primary/fallback be either provider
        — e.g. Claude Haiku primary, Gemini fallback — without the chain silently
        dropping the fallback, AND prevents a key-set-but-SDK-absent config from
        arming a fallback that fails 100% of the time and burns the per-call retries
        + the TD27 retry budget. The fallback key is NOT a master gate; the master
        switch is enforced upstream via ``real_call_enabled_for``."""
        candidates = [primary_model]
        fallback = self._settings.default_fallback_model
        if (
            fallback
            and fallback not in candidates
            and provider_for_model(fallback) != provider_for_model(primary_model)
            and self._settings.fallback_transport_available(provider_for_model(fallback))
        ):
            candidates.append(fallback)
        return candidates

    def _record_trace_text(
        self, meta: AICallMetadata, messages: list[Message], output: str
    ) -> None:
        """Put the FINAL prompt/response text on ``meta``, or leave both ``None``.

        The ONLY writer of ``AICallMetadata.prompt_text`` / ``response_text``. It is
        called from :meth:`_finish_task` and nowhere else, deliberately: that method is
        already the one place that closes the Langfuse task span with the caller's
        output, so the store and the trace are populated from the SAME arguments in the
        SAME call. There is no second code path that could drift.

        WHY THIS TEXT IS POST-BOUNDARY, which is the whole point of the feature:

        - ``messages`` is pseudonymized by the ENDPOINT before ``run`` is ever reached
          (the invariant at the top of this module), so it is post-boundary on arrival;
        - and BOTH values are then run through :func:`masked_trace_text`, i.e. through
          ``pseudonymize`` again, in the same module and by the same hook that masks what
          Langfuse exports. So even a caller that hands the router raw text — and
          ``mock_response`` on ``/profile/extract`` IS derived from raw worker text —
          cannot get raw text into the store.

        HONESTY ABOUT WHAT THAT PROVES. It proves the WIRING sits on the right side of
        ``app/pseudonymize.py``. It does NOT prove the text is clean: R32 measured the
        name gazetteer's recall as poor, and the residual gaps in R30 are open. That is
        exactly why the store encrypts at rest and gates the read on a super-admin
        capability rather than treating this text as safe.

        GATED AND FAIL-CLOSED. Nothing is written unless ``AI_CALL_TRACE_TEXT_ENABLED``
        is on. ``masked_trace_text`` cannot raise (``_mask`` swallows and returns
        ``REDACTED``), but if it ever did, both fields are cleared rather than left
        half-written — an absent trace, never an unmasked one.
        """
        if not self._settings.ai_call_trace_text_enabled:
            return
        try:
            meta.prompt_text = masked_trace_text(messages)
            meta.response_text = masked_trace_text(output)
        except Exception as exc:  # pragma: no cover - defensive; the mask never raises
            meta.prompt_text = None
            meta.response_text = None
            logger.warning(
                "ai trace text dropped; the privacy mask failed",
                extra={"extra": {"task": meta.task_type, "error_class": type(exc).__name__}},
            )

    def _finish_task(
        self,
        task: Observation,
        messages: list[Message],
        output: str,
        meta: AICallMetadata,
        extra: dict[str, Any] | None = None,
    ) -> None:
        """Close the trace root with what the caller actually got back.

        The whole of ``AICallMetadata`` goes on, because it is already the PII-free
        record this service returns to the backend — ids, model names, counts and an
        INR estimate — and duplicating a subset here would guarantee the two drift.

        The LEVEL is the point of this method. A router that never raises is easy to
        operate and impossible to monitor: every terminal state returns a 200 with a
        mock body, so "the provider is down" and "we are deliberately in mock mode"
        look identical from outside. Splitting them into ERROR and WARNING is what
        makes the failure visible in Langfuse without breaking the never-raise
        contract.
        """
        # BEFORE the span update, so the store's text and the span's `output` come off
        # the same `output` argument in the same call — see `_record_trace_text`.
        self._record_trace_text(meta, messages, output)
        if meta.real_call and not meta.success:
            level, status = "ERROR", meta.failure_reason or meta.error_code or "llm_call_failed"
        elif meta.error_code is not None:
            # Nothing was attempted: a spend cap, the per-call ceiling or the kill
            # switch chose the mock. Degraded on purpose, so WARNING, not ERROR.
            level, status = "WARNING", meta.error_code
        else:
            level, status = "DEFAULT", None
        task.update(
            output=output,
            level=level,
            status_message=status,
            # `exclude=` and not a hand-written subset: the docstring above commits to
            # putting the WHOLE metadata record on the span so the two cannot drift, and
            # an exclusion keeps that property while holding back exactly the two TEXT
            # fields (see `_TRACE_TEXT_FIELDS`). A future field is included by default,
            # which is the right default for a PII-free record.
            metadata={**meta.model_dump(exclude=_TRACE_TEXT_FIELDS), **(extra or {})},
        )
