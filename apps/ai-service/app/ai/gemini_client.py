"""Direct Google AI Studio (Gemini) client over HTTPS — no LiteLLM.

The real provider is Google AI Studio (Gemini), reached by a direct REST call
using an API key (``GEMINI_FLASH_API_KEY``). There is NO LiteLLM proxy or SDK.

Callers MUST pass already-pseudonymized ``messages``. This module NEVER logs the
request or response bodies (pseudonymized, but still content) — only counts and
status are observable. ``httpx`` is the only transport.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

import httpx

from ..config import Settings

_GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
_TIMEOUT_SECONDS = 30.0
# On HTTP 429 (rate limit) we wait and retry IN-CALL so a per-minute (RPM) cap
# self-heals. A per-DAY cap won't recover within the request — we detect it
# (``_is_daily_quota_429``) and fail FAST so the router escalates to the next
# provider (Claude Haiku) immediately instead of burning the backoff budget.
# Bounded so even an undetected hard cap can't hang the request for long.
_MAX_RATE_LIMIT_RETRIES = 4
_MAX_BACKOFF_SECONDS = 20.0


def _retry_after_seconds(resp: httpx.Response, attempt: int) -> float:
    """Seconds to wait before retrying a 429: the server's RetryInfo if present,
    else capped exponential backoff. Never longer than ``_MAX_BACKOFF_SECONDS``."""
    try:
        for detail in resp.json().get("error", {}).get("details", []):
            delay = detail.get("retryDelay")  # e.g. "21s"
            if isinstance(delay, str) and delay.endswith("s"):
                return min(float(delay[:-1] or 0), _MAX_BACKOFF_SECONDS)
    except (ValueError, KeyError, TypeError):
        pass
    return min(2.0**attempt, _MAX_BACKOFF_SECONDS)


def _is_daily_quota_429(resp: httpx.Response) -> bool:
    """True if a 429 is a per-DAY / daily quota that won't self-heal this request
    (e.g. the free-tier ``GenerateRequestsPerDayPerProjectPerModel-FreeTier`` 20/day
    cap), as opposed to a transient per-minute (RPM) limit. We retry RPM limits but
    fail FAST on daily ones so the router can fall over to the next provider without
    waiting out a quota that only resets at the daily boundary."""
    try:
        details = resp.json().get("error", {}).get("details", [])
    except (ValueError, KeyError, TypeError):
        return False
    for detail in details:
        for violation in detail.get("violations", []) or []:
            if "PerDay" in (violation.get("quotaId") or ""):
                return True
    return False


@dataclass
class LlmResult:
    content: str
    input_tokens: int
    output_tokens: int


def _bare_model_id(model: str) -> str:
    """Strip a leading ``gemini/`` provider prefix; we use the bare id now."""
    return model[len("gemini/"):] if model.startswith("gemini/") else model


def _to_gemini_request(
    messages: list[dict[str, str]],
    *,
    max_output_tokens: int,
    temperature: float,
    json_mode: bool,
) -> dict:
    """Map OpenAI-style messages to a Gemini ``generateContent`` request body.

    - ``system`` messages are concatenated into ``systemInstruction.parts[].text``.
    - ``user`` -> role "user"; ``assistant`` -> role "model"; each a single text part.
    - ``generationConfig`` carries the token/temperature limits and (for JSON mode)
      ``responseMimeType: application/json``.
    """
    system_texts: list[str] = []
    contents: list[dict] = []
    for msg in messages:
        role = msg.get("role", "user")
        text = msg.get("content", "") or ""
        if role == "system":
            system_texts.append(text)
            continue
        gemini_role = "model" if role == "assistant" else "user"
        contents.append({"role": gemini_role, "parts": [{"text": text}]})

    generation_config: dict = {
        "maxOutputTokens": max_output_tokens,
        "temperature": temperature,
        # Gemini 2.5 Flash is a "thinking" model: by default it spends part of the
        # output-token budget on internal reasoning (`thoughtsTokenCount`), which
        # both inflates cost and can starve the visible answer (an under-budgeted
        # call returns a candidate with NO content parts). Our tasks — canonical
        # JSON extraction, warm question rephrase, resume prose — need no chain of
        # thought, so disable thinking entirely: every output token goes to the
        # answer, cost is predictable, and the per-call ceiling stays meaningful.
        "thinkingConfig": {"thinkingBudget": 0},
    }
    if json_mode:
        generation_config["responseMimeType"] = "application/json"

    body: dict = {"contents": contents, "generationConfig": generation_config}
    if system_texts:
        body["systemInstruction"] = {"parts": [{"text": t} for t in system_texts]}
    return body


def _parse_gemini_response(data: dict) -> LlmResult:
    """Extract content + token counts from a Gemini ``generateContent`` response.

    Raises ``RuntimeError`` if there is no candidate text (the router catches and
    falls back to mock — fail-safe).
    """
    candidates = data.get("candidates") or []
    if not candidates:
        raise RuntimeError("gemini response had no candidates")
    parts = (candidates[0].get("content") or {}).get("parts") or []
    if not parts:
        raise RuntimeError("gemini candidate had no content parts")
    content = parts[0].get("text") or ""

    usage = data.get("usageMetadata") or {}
    input_tokens = int(usage.get("promptTokenCount", 0) or 0)
    output_tokens = int(usage.get("candidatesTokenCount", 0) or 0)
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
    """Call Gemini directly via REST. Raises on failure (real mode only).

    ``messages`` MUST already be pseudonymized. Request/response bodies are never
    logged. Raises ``RuntimeError`` if the key is missing, on a non-2xx status, or
    when the response carries no usable candidate — the router catches and falls
    back to the deterministic mock.
    """
    api_key = settings.gemini_flash_api_key
    if not api_key:
        raise RuntimeError("GEMINI_FLASH_API_KEY is not set; cannot make a real call")

    model_id = _bare_model_id(model)
    url = f"{_GEMINI_API_BASE}/{model_id}:generateContent"
    body = _to_gemini_request(
        messages,
        max_output_tokens=max_output_tokens,
        temperature=temperature,
        json_mode=json_mode,
    )

    # Pass the key as a HEADER, not a ?key= query param: httpx/uvicorn log request
    # URLs at INFO, so a query-param key would leak into logs. The header form is
    # the documented Google AI Studio auth and keeps the secret out of any URL.
    headers = {"x-goog-api-key": api_key}
    async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
        for attempt in range(_MAX_RATE_LIMIT_RETRIES + 1):
            resp = await client.post(url, headers=headers, json=body)
            if resp.status_code != 429 or attempt == _MAX_RATE_LIMIT_RETRIES:
                break
            # A per-day cap won't clear within this request — don't wait it out;
            # break so the call raises and the router escalates to the fallback.
            if _is_daily_quota_429(resp):
                break
            await asyncio.sleep(_retry_after_seconds(resp, attempt))

    if resp.status_code < 200 or resp.status_code >= 300:
        # Do NOT include the body (may echo pseudonymized content) — status only.
        raise RuntimeError(f"gemini call failed with status {resp.status_code}")

    return _parse_gemini_response(resp.json())
