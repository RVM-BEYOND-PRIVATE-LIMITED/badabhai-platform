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
        any_attempted = False  # did at least one candidate actually reach the network?
        ceiling_skipped_any = False
        for model in candidates:
            worst_case_inr = cost_tracker.estimate_cost_inr(
                model, cost_tracker.estimate_tokens(input_text), route.max_output_tokens
            )
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

            # Attempt this candidate with the route's per-attempt retries.
            any_attempted = True
            for attempt in range(route.max_retries + 1):
                try:
                    result = await providers.complete(
                        settings=self._settings, model=model, messages=messages,
                        max_output_tokens=route.max_output_tokens,
                        temperature=route.temperature, json_mode=route.json_mode,
                    )
                    latency = int((time.perf_counter() - start) * 1000)
                    in_tok = result.input_tokens or cost_tracker.estimate_tokens(input_text)
                    out_tok = result.output_tokens or cost_tracker.estimate_tokens(result.content)
                    meta = cost_tracker.build_call_metadata(
                        task_type=task_type, model=model, real_call=True,
                        input_tokens=in_tok, output_tokens=out_tok,
                        latency_ms=latency, success=True, settings=self._settings,
                    )
                    self._trace(task_type, model, True, input_text, result.content, meta)
                    return result.content, meta
                except Exception as exc:
                    # NEVER log the exception body (may echo pseudonymized content)
                    # — only its type, the attempt, the task, and the model.
                    logger.warning(
                        "llm attempt failed",
                        extra={"extra": {
                            "attempt": attempt, "task": task_type, "model": model,
                            "error_type": type(exc).__name__,
                        }},
                    )

        # No candidate succeeded (or none were allowed). Fall back to the
        # deterministic mock — the router NEVER raises (fail-safe). Metadata is
        # reported under the PRIMARY model. Three terminal states:
        #   - at least one candidate hit the network and all failed -> real_call
        #     True, success False, error "llm_call_failed".
        #   - real was allowed but every candidate was ceiling-skipped (none
        #     attempted) -> real_call False, success True, "cost_ceiling_exceeded".
        #   - real disabled / opted out / not allowlisted -> plain mock.
        if any_attempted:
            real_flag, success, error_code = True, False, "llm_call_failed"
        elif ceiling_skipped_any:
            real_flag, success, error_code = False, True, "cost_ceiling_exceeded"
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

        primary_model (Gemini) first; then ``settings.default_fallback_model``
        (Claude Haiku) IFF ``settings.anthropic_api_key`` is set AND its provider
        differs from the primary's. De-duplicated, order preserved. The fallback
        key is NOT a master gate — Gemini's key already governs whether real calls
        happen at all (checked upstream via ``real_call_enabled_for``)."""
        candidates = [primary_model]
        fallback = self._settings.default_fallback_model
        if (
            self._settings.anthropic_api_key
            and fallback
            and fallback not in candidates
            and provider_for_model(fallback) != provider_for_model(primary_model)
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
