"""AI infrastructure: model routing, cost tracking, Langfuse tracing, direct Gemini.

The single public entry point for MODEL CALLS is :class:`app.ai.router.AIRouter`.
Domain code (profiling/extraction) supplies prompts + a deterministic mock response;
the router owns model selection, mock-vs-real gating, cost accounting, and the
per-attempt generations it records.

TRACING IS WIDER THAN THE ROUTER. :mod:`app.ai.langfuse_tracing` is the single seam
for every AI boundary, including the two that do not go through the router — the
skill embeds (:mod:`app.ai.embeddings`) and the voice STT/translate hops
(``app/routers/voice.py``). Anything that calls a provider records through
``get_tracer()`` and nowhere else.
"""
