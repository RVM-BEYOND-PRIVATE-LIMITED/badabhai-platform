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
from . import cost_tracker
from .langfuse_tracing import LangfuseTracer
from .litellm_client import acomplete
from .model_config import get_route, resolve_model

logger = get_logger("ai.router")

# A chat message in LiteLLM/OpenAI format.
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
        model = resolve_model(task_type, self._settings)
        real = self._settings.real_calls_enabled and real_call_allowed
        input_text = "\n".join(m.get("content", "") for m in messages)
        start = time.perf_counter()

        # Hard spend ceiling: refuse a real call whose WORST-CASE cost (input
        # tokens + the route's max output tokens) would exceed the per-call cap.
        # Stateless guardrail against a runaway/expensive call; per-profile
        # cumulative budgets are a deferred enhancement.
        ceiling_blocked = False
        if real:
            worst_case_inr = cost_tracker.estimate_cost_inr(
                model, cost_tracker.estimate_tokens(input_text), route.max_output_tokens
            )
            if worst_case_inr > self._settings.ai_max_call_cost_inr:
                logger.warning(
                    "cost ceiling exceeded; skipping real call",
                    extra={"extra": {
                        "task": task_type, "model": model,
                        "worst_case_inr": worst_case_inr,
                        "ceiling_inr": self._settings.ai_max_call_cost_inr,
                    }},
                )
                real = False
                ceiling_blocked = True

        if not real:
            # Mock path: deterministic, no network. Still logs estimated cost.
            latency = int((time.perf_counter() - start) * 1000)
            meta = cost_tracker.build_call_metadata(
                task_type=task_type, model=model, real_call=False,
                input_tokens=cost_tracker.estimate_tokens(input_text),
                output_tokens=cost_tracker.estimate_tokens(mock_response),
                latency_ms=latency, success=True, settings=self._settings,
                error_code="cost_ceiling_exceeded" if ceiling_blocked else None,
            )
            self._trace(task_type, model, False, input_text, mock_response, meta)
            return mock_response, meta

        # Real path with retries; falls back to mock on failure (never raises).
        last_error = "unknown"
        for attempt in range(route.max_retries + 1):
            try:
                result = await acomplete(
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
                last_error = str(exc)
                logger.warning(
                    "llm attempt failed",
                    extra={"extra": {"attempt": attempt, "task": task_type, "error": last_error}},
                )

        # All attempts failed -> safe fallback to mock content.
        latency = int((time.perf_counter() - start) * 1000)
        meta = cost_tracker.build_call_metadata(
            task_type=task_type, model=model, real_call=True,
            input_tokens=cost_tracker.estimate_tokens(input_text),
            output_tokens=cost_tracker.estimate_tokens(mock_response),
            latency_ms=latency, success=False, settings=self._settings,
            error_code="llm_call_failed",
        )
        self._trace(task_type, model, True, input_text, mock_response, meta)
        return mock_response, meta

    def _trace(
        self, task_type: str, model: str, real: bool, input_text: str, output_text: str,
        meta: AICallMetadata,
    ) -> None:
        self._tracer.trace_generation(
            task_type=task_type, model=model, real_call=real,
            input_text=input_text, output_text=output_text,
            metadata={"estimated_cost_inr": meta.estimated_cost_inr, "success": meta.success},
        )
