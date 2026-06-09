"""LiteLLM client (real-mode only).

``litellm`` is imported lazily so it is NOT required for mock mode / local dev
(see requirements-ai.txt). Callers MUST pass already-pseudonymized messages.
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
    """Call a model via LiteLLM. Raises if litellm is unavailable (real mode only).

    ``messages`` MUST already be pseudonymized.
    """
    try:
        import litellm  # type: ignore
    except Exception as exc:  # real mode requires the optional dependency
        raise RuntimeError(
            "litellm is not installed; install requirements-ai.txt to enable real calls"
        ) from exc

    kwargs: dict = {
        "model": model,
        "messages": messages,
        "api_base": settings.litellm_base_url,
        "api_key": settings.litellm_api_key,
        "max_tokens": max_output_tokens,
        "temperature": temperature,
    }
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}

    resp = await litellm.acompletion(**kwargs)
    content = resp.choices[0].message.content or ""
    usage = getattr(resp, "usage", None)
    input_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
    output_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
    return LlmResult(content=content, input_tokens=input_tokens, output_tokens=output_tokens)
