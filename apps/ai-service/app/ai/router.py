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

from ..config import Settings
from ..contracts import AICallMetadata
from ..logging_config import get_logger
from . import cost_tracker, providers
from .langfuse_tracing import LangfuseTracer
from .model_config import get_route, provider_for_model, resolve_model

logger = get_logger("ai.router")

# A chat message in OpenAI-style format (mapped to Gemini by the client).
Message = dict[str, str]


class AIRouter:
    def __init__(self, settings: Settings, tracer: LangfuseTracer | None = None) -> None:
        self._settings = settings
        self._tracer = tracer or LangfuseTracer(settings)

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
        route = get_route(task_type)
        primary_model = resolve_model(task_type, self._settings)
        # Per-task gating: real only if the master flag + key are set AND this
        # task is allowlisted (empty allowlist = all tasks). Lets ONE role go real.
        real = self._settings.real_call_enabled_for(task_type) and real_call_allowed
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
        for model in candidates:
            worst_case_inr = cost_tracker.estimate_cost_inr(
                model, cost_tracker.estimate_tokens(input_text), route.max_output_tokens
            )
            # 1. Per-call ceiling: a single call whose worst case is too pricey.
            if worst_case_inr > self._settings.ai_max_call_cost_inr:
                logger.warning(
                    "cost ceiling exceeded; skipping candidate",
                    extra={"extra": {
                        "task": task_type, "model": model,
                        "worst_case_inr": worst_case_inr,
                        "ceiling_inr": self._settings.ai_max_call_cost_inr,
                    }},
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
                logger.warning(
                    "spend cap reached; blocking real call",
                    extra={"extra": {
                        "task": task_type, "model": model, "reason": reason,
                        "worst_case_inr": worst_case_inr,
                    }},
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
            try:
                for attempt in range(route.max_retries + 1):
                    # 3. Retry budget (TD27): a RETRY (attempt > 0) must consume a
                    # slot of the rolling cross-request budget. Exhausted -> stop
                    # hammering this failing provider (break the retry loop).
                    if attempt > 0 and not ledger.try_consume_retry(self._settings):
                        retry_budget_hit = True
                        logger.warning(
                            "retry budget exhausted; stopping retries",
                            extra={"extra": {
                                "task": task_type, "model": model, "attempt": attempt,
                                "budget_per_window": self._settings.ai_retry_budget_per_window,
                            }},
                        )
                        break
                    try:
                        result = await providers.complete(
                            settings=self._settings, model=model, messages=messages,
                            max_output_tokens=route.max_output_tokens,
                            temperature=route.temperature, json_mode=route.json_mode,
                        )
                        latency = int((time.perf_counter() - start) * 1000)
                        in_tok = result.input_tokens or cost_tracker.estimate_tokens(input_text)
                        out_tok = result.output_tokens or cost_tracker.estimate_tokens(
                            result.content
                        )
                        meta = cost_tracker.build_call_metadata(
                            task_type=task_type, model=model, real_call=True,
                            input_tokens=in_tok, output_tokens=out_tok,
                            latency_ms=latency, success=True, settings=self._settings,
                        )
                        # Reconcile the reservation: refund worst_case - actual so
                        # the net recorded spend is the ACTUAL estimated cost.
                        await ledger.record_spend(
                            worst_case_inr, meta.estimated_cost_inr, user_ref=user_ref
                        )
                        reconciled = True
                        self._trace(task_type, model, True, input_text, result.content, meta)
                        return result.content, meta
                    except Exception as exc:
                        # NEVER log the exception body (may echo pseudonymized
                        # content) — only its type, the attempt, task, and model.
                        logger.warning(
                            "llm attempt failed",
                            extra={"extra": {
                                "attempt": attempt, "task": task_type, "model": model,
                                "error_type": type(exc).__name__,
                            }},
                        )
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
        meta = cost_tracker.build_call_metadata(
            task_type=task_type, model=primary_model, real_call=real_flag,
            input_tokens=cost_tracker.estimate_tokens(input_text),
            output_tokens=cost_tracker.estimate_tokens(mock_response),
            latency_ms=latency, success=success, settings=self._settings,
            error_code=error_code,
        )
        self._trace(task_type, primary_model, real_flag, input_text, mock_response, meta)
        return mock_response, meta

    def _candidate_models(self, primary_model: str) -> list[str]:
        """Ordered provider-fallback chain for a real call.

        ``primary_model`` first; then ``settings.default_fallback_model`` IFF the
        credential for the FALLBACK's OWN provider is set AND its provider differs
        from the primary's. De-duplicated, order preserved. Gating on the fallback
        provider's own key (not a hardcoded one) lets primary/fallback be either
        provider — e.g. Claude Haiku primary, Gemini fallback — without the chain
        silently dropping the fallback. The fallback key is NOT a master gate; the
        master switch is enforced upstream via ``real_call_enabled_for``."""
        candidates = [primary_model]
        fallback = self._settings.default_fallback_model
        if (
            fallback
            and fallback not in candidates
            and provider_for_model(fallback) != provider_for_model(primary_model)
            and self._settings.has_credential_for(provider_for_model(fallback))
        ):
            candidates.append(fallback)
        return candidates

    def _trace(
        self, task_type: str, model: str, real: bool, input_text: str, output_text: str,
        meta: AICallMetadata,
    ) -> None:
        self._tracer.trace_generation(
            task_type=task_type, model=model, real_call=real,
            input_text=input_text, output_text=output_text,
            metadata={"estimated_cost_inr": meta.estimated_cost_inr, "success": meta.success},
        )
