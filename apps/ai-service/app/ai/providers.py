"""Provider dispatch — route an LLM call to the right transport by model id.

The router builds a candidate model list (primary Gemini, then a cross-provider
fallback). This module is the single place that maps a model id to its concrete
client and forwards the (already-pseudonymized) call. Each client shares the same
``acomplete`` signature and returns the same ``LlmResult``, so the router treats
providers interchangeably.

NEVER logs request/response bodies — the underlying clients enforce that too.
"""

from __future__ import annotations

from ..config import Settings
from . import anthropic_client, gemini_client
from .gemini_client import LlmResult
from .model_config import provider_for_model


async def complete(
    *,
    settings: Settings,
    model: str,
    messages: list[dict[str, str]],
    max_output_tokens: int,
    temperature: float,
    json_mode: bool,
) -> LlmResult:
    """Dispatch one completion to the transport for ``model``'s provider.

    "google" -> ``gemini_client.acomplete`` (direct REST), "anthropic" ->
    ``anthropic_client.acomplete`` (official SDK). Any other provider has no live
    transport and raises ``RuntimeError`` (the router catches it as a failed
    candidate). ``messages`` MUST already be pseudonymized.
    """
    provider = provider_for_model(model)
    if provider == "google":
        client = gemini_client
    elif provider == "anthropic":
        client = anthropic_client
    else:
        raise RuntimeError(f"no live transport for provider {provider!r} (model {model!r})")

    return await client.acomplete(
        settings=settings,
        model=model,
        messages=messages,
        max_output_tokens=max_output_tokens,
        temperature=temperature,
        json_mode=json_mode,
    )
