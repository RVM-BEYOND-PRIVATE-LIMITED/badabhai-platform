"""Direct Anthropic (Claude) client — the FALLBACK provider.

The primary real provider is Google AI Studio (Gemini, ``gemini_client``). This
module is the second link in the router's provider-fallback chain: when Gemini
fails, the router may retry the same (already-pseudonymized) messages against
Claude Haiku 4.5.

Unlike the Gemini client (raw ``httpx``), Anthropic is reached via the OFFICIAL
``anthropic`` SDK (``AsyncAnthropic``). The SDK is imported LAZILY inside
``acomplete`` so importing this module never fails when the package is absent
(mock-only deployments don't install it).

Callers MUST pass already-pseudonymized ``messages``. This module NEVER logs the
request or response bodies — only the router observes counts/status.
"""

from __future__ import annotations

from ..config import Settings
from ..logging_config import get_logger
from .errors import REASON_MISSING_KEY, REASON_NO_TEXT_CONTENT, REASON_SDK_ERROR, LlmTransportError

# Reuse the SAME result shape as the Gemini client so the router/cost tracker
# treat every provider identically.
from .gemini_client import LlmResult
from .model_config import ANTHROPIC_CACHE_MIN_TOKENS, should_cache_system

logger = get_logger("ai.anthropic")

_MAX_TOKENS_FLOOR = 1


def _to_anthropic_request(
    messages: list[dict[str, str]],
    *,
    json_mode: bool,
) -> tuple[list[str], list[dict[str, str]]]:
    """Map OpenAI-style messages to Anthropic's (system, messages) shape.

    - ``system`` messages become an ordered LIST of system texts (kept separate,
      not pre-joined, so the caller can cache-mark only the stable first block —
      Anthropic has no ``system`` role inside ``messages``).
    - ``user`` -> role "user"; ``assistant`` -> role "assistant", order preserved.
    - In ``json_mode`` a 'reply with only valid JSON' instruction is appended as a
      final system text (Anthropic has no responseMimeType toggle).

    Returns ``(system_texts, anthropic_messages)``.
    """
    system_texts: list[str] = []
    anthropic_messages: list[dict[str, str]] = []
    for msg in messages:
        role = msg.get("role", "user")
        text = msg.get("content", "") or ""
        if role == "system":
            system_texts.append(text)
            continue
        anthropic_role = "assistant" if role == "assistant" else "user"
        anthropic_messages.append({"role": anthropic_role, "content": text})

    if json_mode:
        system_texts.append("Reply with ONLY valid JSON.")
    return system_texts, anthropic_messages


def _anthropic_system_param(system_texts: list[str]):
    """Build the Anthropic ``system`` param, prompt-caching the STABLE block (COST-2).

    Only ``system_texts[0]`` — the static persona / extraction prompt — is stable
    across calls and therefore cacheable; a per-turn instruction block (which carries
    the turn's question) is never cached. When that stable block clears the provider
    minimum we return a structured block list with a ``cache_control: ephemeral``
    breakpoint on it (Anthropic caches the prefix up to and including that block);
    otherwise we return the plain concatenated string and emit a skip diagnostic.

    SG-1: only static prompt text is ever placed in ``system`` — never a worker
    message or name — so nothing PII-bearing is ever cached. The diagnostic logs
    only a provider label + token minimum, never any content.
    """
    if not system_texts:
        return ""
    stable = system_texts[0]
    if should_cache_system(stable, ANTHROPIC_CACHE_MIN_TOKENS):
        blocks: list[dict] = [
            {"type": "text", "text": stable, "cache_control": {"type": "ephemeral"}}
        ]
        blocks.extend({"type": "text", "text": t} for t in system_texts[1:])
        return blocks
    logger.info(
        "prompt-cache skipped: system block below cache minimum",
        extra={"extra": {"provider": "anthropic", "min_tokens": ANTHROPIC_CACHE_MIN_TOKENS}},
    )
    return "\n".join(system_texts)


def _parse_anthropic_response(resp) -> LlmResult:
    """Extract content + token counts from an Anthropic Messages response.

    Response text = concatenation of ``.text`` over text blocks in
    ``resp.content``. Raises :class:`LlmTransportError` (PII-free reason code) if
    there is no text content (the router catches and tries the next provider, else
    falls back to mock).
    """
    blocks = getattr(resp, "content", None) or []
    text_parts = [
        getattr(block, "text", "") or ""
        for block in blocks
        if getattr(block, "type", None) == "text"
    ]
    content = "".join(text_parts)
    if not content:
        raise LlmTransportError(REASON_NO_TEXT_CONTENT)

    usage = getattr(resp, "usage", None)
    input_tokens = int(getattr(usage, "input_tokens", 0) or 0) if usage else 0
    output_tokens = int(getattr(usage, "output_tokens", 0) or 0) if usage else 0
    return LlmResult(content=content, input_tokens=input_tokens, output_tokens=output_tokens)


async def acomplete(
    *,
    settings: Settings,
    model: str,
    messages: list[dict[str, str]],
    max_output_tokens: int,
    temperature: float,
    json_mode: bool,
) -> LlmResult:
    """Call Claude (Anthropic) via the official SDK. Raises on failure.

    Same signature as ``gemini_client.acomplete`` so the provider dispatcher can
    treat the two interchangeably. ``messages`` MUST already be pseudonymized.
    Request/response bodies are never logged. Raises ``RuntimeError`` if the key
    is missing, the response has no text, or the SDK raises — the router catches
    and moves to the next candidate (or the deterministic mock).

    The ``anthropic`` SDK is imported HERE (lazily) so module import succeeds even
    when the package is not installed (mock-only mode).
    """
    api_key = settings.anthropic_api_key
    if not api_key:
        raise LlmTransportError(REASON_MISSING_KEY)

    try:
        from anthropic import AsyncAnthropic
    except ImportError as exc:  # SDK not installed -> treat as a failed provider.
        raise LlmTransportError(REASON_SDK_ERROR) from exc

    system_texts, anthropic_messages = _to_anthropic_request(messages, json_mode=json_mode)
    system_param = _anthropic_system_param(system_texts)

    try:
        client = AsyncAnthropic(api_key=api_key)
        # Do NOT set thinking/effort — unsupported on Haiku 4.5.
        resp = await client.messages.create(
            model=model,
            max_tokens=max(max_output_tokens, _MAX_TOKENS_FLOOR),
            system=system_param,
            messages=anthropic_messages,
            temperature=temperature,
        )
    except RuntimeError:
        # Includes LlmTransportError (a RuntimeError) -> re-raise unchanged.
        raise
    except Exception as exc:
        # Never include the body (may echo pseudonymized content) — a PII-free
        # reason code only. Chained via ``from exc`` for local tracebacks (the
        # router logs only reason_code, never this chain).
        raise LlmTransportError(REASON_SDK_ERROR) from exc

    return _parse_anthropic_response(resp)
