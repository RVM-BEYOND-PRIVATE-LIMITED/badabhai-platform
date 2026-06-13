"""LLM client (real-mode only) — OpenAI-compatible.

Uses the lightweight ``openai`` AsyncOpenAI SDK to talk to any OpenAI-protocol
gateway. We deliberately do NOT depend on ``litellm`` (a heavy 16 MB dep that
fails to install on Windows long-paths + Python 3.14); a single OpenAI-protocol
provider needs only the ``openai`` SDK.

The env vars are still named ``LITELLM_BASE_URL`` / ``LITELLM_API_KEY`` (generic
"LLM gateway" config — see TD in docs/registers/tech-debt-register.md). For
Gemini, point ``LITELLM_BASE_URL`` at the Gemini OpenAI-compatible endpoint
(``https://generativelanguage.googleapis.com/v1beta/openai/``) and use the bare
model id (``gemini-2.0-flash`` — no ``openai/`` prefix).

``openai`` is imported lazily so it is NOT required for mock mode / local dev /
CI (see requirements-ai.txt). Callers MUST pass already-pseudonymized messages.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..config import Settings


@dataclass
class LlmResult:
    content: str
    input_tokens: int
    output_tokens: int


async def acomplete(
    *,
    settings: Settings,
    model: str,
    messages: list[dict[str, str]],
    max_output_tokens: int,
    temperature: float,
    json_mode: bool,
) -> LlmResult:
    """Call a model via an OpenAI-compatible endpoint. Raises if ``openai`` is
    unavailable (real mode only) — the router catches and falls back to mock.

    ``messages`` MUST already be pseudonymized; this function never logs them.
    """
    try:
        from openai import AsyncOpenAI  # type: ignore
    except Exception as exc:  # real mode requires the optional dependency
        raise RuntimeError(
            "openai is not installed; install requirements-ai.txt to enable real calls"
        ) from exc

    client = AsyncOpenAI(
        base_url=settings.litellm_base_url,
        api_key=settings.litellm_api_key,
    )

    kwargs: dict = {
        "model": model,
        "messages": messages,
        "max_tokens": max_output_tokens,
        "temperature": temperature,
    }
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}

    resp = await client.chat.completions.create(**kwargs)
    content = resp.choices[0].message.content or ""
    usage = getattr(resp, "usage", None)
    input_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
    output_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
    return LlmResult(content=content, input_tokens=input_tokens, output_tokens=output_tokens)
