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
from ..contracts import AICallMetadata
from ..logging_config import get_logger
from . import cost_tracker, providers
from .errors import REASON_MAX_TOKENS_NO_PARTS, LlmTransportError
from .langfuse_tracing import LLM_CALL, LangfuseTracer, Observation, get_tracer
from .model_config import get_route, provider_for_model, resolve_model

logger = get_logger("ai.router")

# A chat message in OpenAI-style format (mapped to Gemini by the client).
Message = dict[str, str]

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
        """
        # Per-task gating: real only if the master flag + key are set AND this
        # task is allowlisted (empty allowlist = NO tasks; fail-closed). Lets
        # ONE role go real. Computed BEFORE the span so the posture can be a tag.
        real = self._settings.real_call_enabled_for(task_type) and real_call_allowed
        with self._tracer.task(
            task_type=task_type,
            input=messages,
            user_ref=user_ref,
            real_call=real,
            metadata={"real_call_allowed": real_call_allowed},
        ) as task:
            return await self._dispatch(
                task_type,
                task=task,
                messages=messages,
                mock_response=mock_response,
                real=real,
                user_ref=user_ref,
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
    ) -> tuple[str, AICallMetadata]:
        route = get_route(task_type, self._settings)
        primary_model = resolve_model(task_type, self._settings)
        input_text = "\n".join(m.get("content", "") for m in messages)
        start = time.perf_counter()

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
        any_attempted = False  # did at least one candidate actually reach the network?
        ceiling_skipped_any = False
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
                        as_type="generation",
                        input=messages,
                        model=model,
                        metadata={
                            "provider": provider_for_model(model),
                            "attempt": attempt + 1,
                            "max_attempts": route.max_retries + 1,
                            "max_output_tokens": route.max_output_tokens,
                            "temperature": route.temperature,
                            "json_mode": route.json_mode,
                        },
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
                            self._finish_task(task, result.content, meta)
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
                            generation.update(
                                level="ERROR",
                                status_message=reason,
                                metadata={
                                    "status_code": status,
                                    "typed_transport_error": (transport is not None),
                                },
                            )
                            if reason == REASON_MAX_TOKENS_NO_PARTS:
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
        #   - no candidate attempted, only ceiling-skipped -> real_call False,
        #     success True, "cost_ceiling_exceeded".
        #   - real disabled/opted-out/not-allowlisted -> "kill_switch_engaged"
        #     when the kill-switch is on, else plain mock (error_code None).
        if any_attempted:
            real_flag, success = True, False
            error_code = "retry_budget_exhausted" if retry_budget_hit else "llm_call_failed"
        elif spend_block_reason is not None:
            real_flag, success, error_code = False, True, spend_block_reason
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
            mock_response,
            meta,
            # WHY no candidate ran, in the router's own words. The terminal
            # `error_code` already names the outcome; these name the gates that
            # produced it, so a trace distinguishes "the ledger stopped us" from
            # "every model was too expensive" without reading the service logs.
            extra={
                "spend_block_reason": spend_block_reason,
                "cost_ceiling_skipped_candidate": ceiling_skipped_any,
                "retry_budget_exhausted": retry_budget_hit,
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

    @staticmethod
    def _finish_task(
        task: Observation,
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
            metadata={**meta.model_dump(), **(extra or {})},
        )
