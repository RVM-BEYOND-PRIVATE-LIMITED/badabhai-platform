"""AI infrastructure: model routing, cost tracking, Langfuse tracing, LiteLLM.

The single public entry point is :class:`app.ai.router.AIRouter`. Domain code
(profiling/extraction) supplies prompts + a deterministic mock response; the
router owns model selection, mock-vs-real gating, cost accounting, and tracing.
"""
