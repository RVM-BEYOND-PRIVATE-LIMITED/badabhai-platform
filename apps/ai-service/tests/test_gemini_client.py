"""Direct Gemini client unit tests — message mapping + response parsing.

NO network: ``httpx.AsyncClient.post`` is stubbed. These prove the OpenAI-style
``messages`` are mapped to the Gemini ``generateContent`` shape (system ->
systemInstruction, user/assistant -> user/model, json_mode -> responseMimeType)
and that the response/usage are parsed correctly.
"""

import asyncio

import pytest

from app.ai import gemini_client
from app.ai.gemini_client import (
    LlmResult,
    _bare_model_id,
    _parse_gemini_response,
    _to_gemini_request,
    acomplete,
)
from app.config import Settings


def _run(coro):
    return asyncio.run(coro)


def test_bare_model_id_strips_gemini_prefix():
    assert _bare_model_id("gemini/gemini-2.5-flash") == "gemini-2.5-flash"
    assert _bare_model_id("gemini-2.5-flash") == "gemini-2.5-flash"


def test_message_mapping_system_user_assistant_and_json_mode():
    messages = [
        {"role": "system", "content": "be brief"},
        {"role": "system", "content": "stay factual"},
        {"role": "user", "content": "vmc 4 saal"},
        {"role": "assistant", "content": "badhiya"},
        {"role": "user", "content": "fanuc bhi"},
    ]
    body = _to_gemini_request(
        messages, max_output_tokens=256, temperature=0.0, json_mode=True
    )

    # System messages concatenated into systemInstruction.parts[].text.
    sys_parts = body["systemInstruction"]["parts"]
    assert [p["text"] for p in sys_parts] == ["be brief", "stay factual"]

    # user -> "user", assistant -> "model"; order preserved; each a text part.
    roles = [c["role"] for c in body["contents"]]
    assert roles == ["user", "model", "user"]
    assert body["contents"][0]["parts"][0]["text"] == "vmc 4 saal"
    assert body["contents"][1]["parts"][0]["text"] == "badhiya"

    gen = body["generationConfig"]
    assert gen["maxOutputTokens"] == 256
    assert gen["temperature"] == 0.0
    assert gen["responseMimeType"] == "application/json"


def test_message_mapping_no_system_and_no_json_mode():
    body = _to_gemini_request(
        [{"role": "user", "content": "hi"}],
        max_output_tokens=128, temperature=0.5, json_mode=False,
    )
    assert "systemInstruction" not in body
    assert "responseMimeType" not in body["generationConfig"]
    assert body["contents"][0]["role"] == "user"


def test_parse_response_extracts_content_and_usage():
    data = {
        "candidates": [{"content": {"parts": [{"text": '{"primary_role":"VMC Operator"}'}]}}],
        "usageMetadata": {"promptTokenCount": 42, "candidatesTokenCount": 7},
    }
    result = _parse_gemini_response(data)
    assert isinstance(result, LlmResult)
    assert result.content == '{"primary_role":"VMC Operator"}'
    assert result.input_tokens == 42
    assert result.output_tokens == 7


def test_parse_response_defaults_tokens_to_zero_when_absent():
    data = {"candidates": [{"content": {"parts": [{"text": "hi"}]}}]}
    result = _parse_gemini_response(data)
    assert result.input_tokens == 0
    assert result.output_tokens == 0


def test_parse_response_raises_when_no_candidate():
    with pytest.raises(RuntimeError):
        _parse_gemini_response({"candidates": []})
    with pytest.raises(RuntimeError):
        _parse_gemini_response({"candidates": [{"content": {"parts": []}}]})


class _StubResponse:
    def __init__(self, status_code: int, payload: dict) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class _StubAsyncClient:
    """Captures the POST call and returns a canned response — no network."""

    last_url: str | None = None
    last_headers: dict | None = None
    last_json: dict | None = None

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def post(self, url, *, headers, json):
        _StubAsyncClient.last_url = url
        _StubAsyncClient.last_headers = headers
        _StubAsyncClient.last_json = json
        return _StubResponse(
            200,
            {
                "candidates": [{"content": {"parts": [{"text": "OK"}]}}],
                "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 2},
            },
        )


def test_acomplete_posts_to_bare_model_url_with_key_header(monkeypatch):
    monkeypatch.setattr(gemini_client.httpx, "AsyncClient", _StubAsyncClient)
    settings = Settings(gemini_flash_api_key="secret-key")

    result = _run(
        acomplete(
            settings=settings,
            model="gemini/gemini-2.5-flash",  # leading prefix must be stripped
            messages=[{"role": "user", "content": "vmc"}],
            max_output_tokens=64,
            temperature=0.0,
            json_mode=True,
        )
    )

    assert result.content == "OK"
    assert result.input_tokens == 5
    assert result.output_tokens == 2
    # URL uses the BARE model id; key passed as the x-goog-api-key HEADER (never a
    # query param — that would leak the secret into request-URL logs).
    assert _StubAsyncClient.last_url.endswith("/models/gemini-2.5-flash:generateContent")
    assert _StubAsyncClient.last_headers == {"x-goog-api-key": "secret-key"}
    assert "secret-key" not in _StubAsyncClient.last_url
    assert _StubAsyncClient.last_json["generationConfig"]["responseMimeType"] == "application/json"


def test_acomplete_raises_without_key():
    with pytest.raises(RuntimeError):
        _run(
            acomplete(
                settings=Settings(),  # no key
                model="gemini-2.5-flash",
                messages=[{"role": "user", "content": "x"}],
                max_output_tokens=64,
                temperature=0.0,
                json_mode=False,
            )
        )


def test_acomplete_raises_on_non_2xx(monkeypatch):
    class _ErrClient(_StubAsyncClient):
        async def post(self, url, *, headers, json):
            return _StubResponse(500, {})

    monkeypatch.setattr(gemini_client.httpx, "AsyncClient", _ErrClient)
    with pytest.raises(RuntimeError):
        _run(
            acomplete(
                settings=Settings(gemini_flash_api_key="k"),
                model="gemini-2.5-flash",
                messages=[{"role": "user", "content": "x"}],
                max_output_tokens=64,
                temperature=0.0,
                json_mode=False,
            )
        )
