"""Anthropic (Claude) fallback client unit tests — message mapping + parsing.

NO network: ``anthropic.AsyncAnthropic`` is stubbed via monkeypatch. These prove
the OpenAI-style ``messages`` map to Anthropic's (top-level ``system`` string +
alternating user/assistant ``messages``) shape, the json-mode instruction is
appended to the system string, response text + usage are parsed from blocks, and
empty/missing config raises so the router treats it as a failed provider.
"""

import asyncio
import sys
import types

import pytest

from app.ai import anthropic_client
from app.ai.anthropic_client import (
    LlmResult,
    _parse_anthropic_response,
    _to_anthropic_request,
    acomplete,
)
from app.config import Settings


def _run(coro):
    return asyncio.run(coro)


# --- Pure mapping/parsing (no SDK) -----------------------------------------

def test_request_mapping_system_top_level_and_alternation():
    messages = [
        {"role": "system", "content": "be brief"},
        {"role": "system", "content": "stay factual"},
        {"role": "user", "content": "vmc 4 saal"},
        {"role": "assistant", "content": "badhiya"},
        {"role": "user", "content": "fanuc bhi"},
    ]
    system_text, anth_messages = _to_anthropic_request(messages, json_mode=False)

    # System messages concatenated into ONE top-level string (not a message).
    assert system_text == "be brief\nstay factual"
    # user -> user, assistant -> assistant; order preserved; no system role here.
    assert anth_messages == [
        {"role": "user", "content": "vmc 4 saal"},
        {"role": "assistant", "content": "badhiya"},
        {"role": "user", "content": "fanuc bhi"},
    ]
    assert all(m["role"] in {"user", "assistant"} for m in anth_messages)


def test_json_mode_appends_instruction_to_system():
    system_text, _ = _to_anthropic_request(
        [{"role": "user", "content": "x"}], json_mode=True
    )
    # With no system messages, the instruction stands alone.
    assert system_text == "Reply with ONLY valid JSON."

    system_text2, _ = _to_anthropic_request(
        [{"role": "system", "content": "be brief"}, {"role": "user", "content": "x"}],
        json_mode=True,
    )
    assert system_text2 == "be brief\nReply with ONLY valid JSON."


class _Block:
    def __init__(self, type_, text):
        self.type = type_
        self.text = text


class _Usage:
    def __init__(self, input_tokens, output_tokens):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _Resp:
    def __init__(self, content, usage=None):
        self.content = content
        self.usage = usage


def test_parse_response_joins_text_blocks_and_usage():
    resp = _Resp(
        content=[
            _Block("text", '{"primary_role":'),
            _Block("thinking", "ignored"),  # non-text block dropped
            _Block("text", '"VMC Operator"}'),
        ],
        usage=_Usage(42, 7),
    )
    result = _parse_anthropic_response(resp)
    assert isinstance(result, LlmResult)
    assert result.content == '{"primary_role":"VMC Operator"}'
    assert result.input_tokens == 42
    assert result.output_tokens == 7


def test_parse_response_defaults_tokens_when_usage_absent():
    resp = _Resp(content=[_Block("text", "hi")], usage=None)
    result = _parse_anthropic_response(resp)
    assert result.input_tokens == 0
    assert result.output_tokens == 0


def test_parse_response_raises_when_no_text():
    with pytest.raises(RuntimeError):
        _parse_anthropic_response(_Resp(content=[], usage=_Usage(1, 0)))
    with pytest.raises(RuntimeError):
        _parse_anthropic_response(_Resp(content=[_Block("thinking", "x")], usage=None))


# --- acomplete with a stubbed AsyncAnthropic (no network) ------------------

class _StubMessages:
    last_kwargs: dict | None = None

    def __init__(self, resp):
        self._resp = resp

    async def create(self, **kwargs):
        _StubMessages.last_kwargs = kwargs
        return self._resp


class _StubAsyncAnthropic:
    last_api_key: str | None = None

    def __init__(self, *, api_key=None, **_kwargs):
        _StubAsyncAnthropic.last_api_key = api_key
        self.messages = _StubMessages(_StubAsyncAnthropic._resp)


def _install_stub_sdk(monkeypatch, resp):
    """Insert a fake ``anthropic`` module exposing AsyncAnthropic into sys.modules
    so the lazy import inside acomplete picks up the stub — no real SDK call."""
    _StubAsyncAnthropic._resp = resp
    _StubMessages.last_kwargs = None
    _StubAsyncAnthropic.last_api_key = None
    fake = types.ModuleType("anthropic")
    fake.AsyncAnthropic = _StubAsyncAnthropic
    monkeypatch.setitem(sys.modules, "anthropic", fake)


def test_acomplete_maps_system_top_level_and_parses(monkeypatch):
    resp = _Resp(content=[_Block("text", "OK")], usage=_Usage(5, 2))
    _install_stub_sdk(monkeypatch, resp)
    settings = Settings(anthropic_api_key="anth-secret")

    result = _run(
        acomplete(
            settings=settings,
            model="claude-haiku-4-5",
            messages=[
                {"role": "system", "content": "be brief"},
                {"role": "user", "content": "vmc"},
            ],
            max_output_tokens=64,
            temperature=0.0,
            json_mode=True,
        )
    )

    assert result.content == "OK"
    assert result.input_tokens == 5
    assert result.output_tokens == 2

    kwargs = _StubMessages.last_kwargs
    assert kwargs["model"] == "claude-haiku-4-5"
    assert kwargs["max_tokens"] == 64
    assert kwargs["temperature"] == 0.0
    # SYSTEM is a top-level STRING (not a message), with the json instruction.
    assert kwargs["system"] == "be brief\nReply with ONLY valid JSON."
    assert isinstance(kwargs["system"], str)
    # messages contain only user/assistant, starting with user; no system role.
    assert kwargs["messages"] == [{"role": "user", "content": "vmc"}]
    assert all(m["role"] != "system" for m in kwargs["messages"])
    # No thinking/effort params on Haiku 4.5.
    assert "thinking" not in kwargs and "effort" not in kwargs
    # Key passed to the SDK constructor.
    assert _StubAsyncAnthropic.last_api_key == "anth-secret"


def test_acomplete_raises_without_key():
    with pytest.raises(RuntimeError):
        _run(
            acomplete(
                settings=Settings(),  # no anthropic key
                model="claude-haiku-4-5",
                messages=[{"role": "user", "content": "x"}],
                max_output_tokens=64,
                temperature=0.0,
                json_mode=False,
            )
        )


def test_acomplete_raises_on_empty_text(monkeypatch):
    _install_stub_sdk(monkeypatch, _Resp(content=[], usage=_Usage(1, 0)))
    with pytest.raises(RuntimeError):
        _run(
            acomplete(
                settings=Settings(anthropic_api_key="k"),
                model="claude-haiku-4-5",
                messages=[{"role": "user", "content": "x"}],
                max_output_tokens=64,
                temperature=0.0,
                json_mode=False,
            )
        )


def test_acomplete_wraps_sdk_error_as_runtimeerror(monkeypatch):
    class _BoomMessages:
        async def create(self, **_kwargs):
            raise ValueError("sdk exploded")

    class _BoomClient:
        def __init__(self, *, api_key=None, **_kwargs):
            self.messages = _BoomMessages()

    fake = types.ModuleType("anthropic")
    fake.AsyncAnthropic = _BoomClient
    monkeypatch.setitem(sys.modules, "anthropic", fake)

    with pytest.raises(RuntimeError):
        _run(
            acomplete(
                settings=Settings(anthropic_api_key="k"),
                model="claude-haiku-4-5",
                messages=[{"role": "user", "content": "x"}],
                max_output_tokens=64,
                temperature=0.0,
                json_mode=False,
            )
        )


def test_module_imports_without_sdk():
    # The SDK is lazy-imported inside acomplete; importing the module must not
    # require ``anthropic`` to be installed.
    assert anthropic_client is not None
