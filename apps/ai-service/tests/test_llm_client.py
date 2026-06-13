"""Unit tests for the OpenAI-compatible LLM client (real-mode path).

These mock ``openai.AsyncOpenAI`` so NO network call is made and NO real key is
needed. They prove the request is shaped correctly (model, messages,
response_format) and that usage/content are parsed back into ``LlmResult``.
"""

import asyncio
import sys
import types
from dataclasses import dataclass

from app.ai.litellm_client import acomplete
from app.config import Settings

_MESSAGES = [{"role": "user", "content": "vmc 4 saal"}]


def _run(coro):
    return asyncio.run(coro)


@dataclass
class _Usage:
    prompt_tokens: int
    completion_tokens: int


class _Message:
    def __init__(self, content):
        self.content = content


class _Choice:
    def __init__(self, content):
        self.message = _Message(content)


class _Response:
    def __init__(self, content, prompt_tokens, completion_tokens):
        self.choices = [_Choice(content)]
        self.usage = _Usage(prompt_tokens, completion_tokens)


class _FakeCompletions:
    def __init__(self, response, captured):
        self._response = response
        self._captured = captured

    async def create(self, **kwargs):
        self._captured.update(kwargs)
        return self._response


class _FakeChat:
    def __init__(self, response, captured):
        self.completions = _FakeCompletions(response, captured)


class _FakeAsyncOpenAI:
    last_init: dict = {}

    def __init__(self, **kwargs):
        _FakeAsyncOpenAI.last_init = kwargs
        # response + captured create-kwargs are injected via class attrs below.
        self.chat = _FakeChat(self._response, self._captured)


def _install_fake_openai(monkeypatch, response, captured):
    """Inject a fake ``openai`` module so the lazy import inside acomplete
    resolves to our stub (no real openai network client)."""
    fake_module = types.ModuleType("openai")

    class _Client(_FakeAsyncOpenAI):
        _response = response
        _captured = captured

    fake_module.AsyncOpenAI = _Client
    monkeypatch.setitem(sys.modules, "openai", fake_module)
    return _Client


def test_acomplete_passes_model_messages_and_parses_usage(monkeypatch):
    captured: dict = {}
    resp = _Response("CANONICAL_JSON", prompt_tokens=11, completion_tokens=7)
    client_cls = _install_fake_openai(monkeypatch, resp, captured)

    settings = Settings(
        ai_enable_real_calls=True,
        litellm_api_key="k",
        litellm_base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
    )
    result = _run(
        acomplete(
            settings=settings,
            model="gemini-2.0-flash",
            messages=_MESSAGES,
            max_output_tokens=1024,
            temperature=0.0,
            json_mode=True,
        )
    )

    # Client constructed with the gateway base_url + key (env-driven).
    assert client_cls.last_init["base_url"].endswith("/v1beta/openai/")
    assert client_cls.last_init["api_key"] == "k"

    # Request shaped correctly — bare model id, messages passed through, json mode.
    assert captured["model"] == "gemini-2.0-flash"
    assert captured["messages"] == _MESSAGES
    assert captured["max_tokens"] == 1024
    assert captured["temperature"] == 0.0
    assert captured["response_format"] == {"type": "json_object"}

    # Usage + content parsed back.
    assert result.content == "CANONICAL_JSON"
    assert result.input_tokens == 11
    assert result.output_tokens == 7


def test_acomplete_omits_response_format_when_not_json_mode(monkeypatch):
    captured: dict = {}
    resp = _Response("free text", prompt_tokens=3, completion_tokens=2)
    _install_fake_openai(monkeypatch, resp, captured)

    settings = Settings(ai_enable_real_calls=True, litellm_api_key="k")
    result = _run(
        acomplete(
            settings=settings,
            model="gemini-2.0-flash",
            messages=_MESSAGES,
            max_output_tokens=256,
            temperature=0.6,
            json_mode=False,
        )
    )
    assert "response_format" not in captured
    assert result.content == "free text"


def test_acomplete_raises_clear_error_when_openai_missing(monkeypatch):
    # Force the lazy import to fail; the router catches this and falls back to mock.
    monkeypatch.setitem(sys.modules, "openai", None)
    settings = Settings(ai_enable_real_calls=True, litellm_api_key="k")
    try:
        _run(
            acomplete(
                settings=settings,
                model="gemini-2.0-flash",
                messages=_MESSAGES,
                max_output_tokens=256,
                temperature=0.0,
                json_mode=False,
            )
        )
        raised = None
    except RuntimeError as exc:
        raised = exc
    assert raised is not None
    assert "openai is not installed" in str(raised)


def test_acomplete_handles_none_content_and_missing_usage(monkeypatch):
    captured: dict = {}

    class _NoUsageResponse:
        def __init__(self):
            self.choices = [_Choice(None)]
            self.usage = None

    _install_fake_openai(monkeypatch, _NoUsageResponse(), captured)
    settings = Settings(ai_enable_real_calls=True, litellm_api_key="k")
    result = _run(
        acomplete(
            settings=settings,
            model="gemini-2.0-flash",
            messages=_MESSAGES,
            max_output_tokens=256,
            temperature=0.0,
            json_mode=False,
        )
    )
    assert result.content == ""
    assert result.input_tokens == 0
    assert result.output_tokens == 0
