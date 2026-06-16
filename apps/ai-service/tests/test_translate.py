"""Real Sarvam translate path tests.

NO network: ``app.translate.httpx.AsyncClient`` is stubbed to capture the Sarvam
POST and return a canned response. These prove:

- the source-language mapping (None/bare/xx-IN/unmappable);
- mock-by-default when the gate is off (no client call, deterministic gloss);
- a real success maps ``translated_text`` + detected source -> TranslateResult and
  sends the required body fields (target en-IN / mayura:v1 / code-mixed);
- the English-skip optimization returns the input unchanged WITHOUT calling the API;
- empty input is a no-op (no client call);
- provider errors, malformed responses, and the >1000-char cap all FAIL CLOSED to
  an empty, never-fabricated English string with ``translate_call_failed``;
- the char-cap guard fires BEFORE any network call.

The ``translate`` wrapper (caught exception -> empty + ``translate_call_failed``)
is the unit under test for the failure cases — ``_translate_real`` itself raises.
"""

import asyncio

import pytest

from app import translate as translate_module
from app.config import Settings
from app.translate import MOCK_ENGLISH, TranslateAdapter, _is_english, _to_translate_source


def _run(coro):
    return asyncio.run(coro)


def _real_settings(**overrides) -> Settings:
    base = dict(ai_enable_real_calls=True, sarvam_api_key="k")
    base.update(overrides)
    return Settings(**base)


class _StubResponse:
    def __init__(self, status_code: int, payload: dict) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class _StubAsyncClient:
    """Captures the Sarvam POST and returns a canned response — no network."""

    called: bool = False
    last_url: str | None = None
    last_headers: dict | None = None
    last_json: dict | None = None
    response: _StubResponse = _StubResponse(200, {})

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def post(self, url, *, headers, json):
        _StubAsyncClient.called = True
        _StubAsyncClient.last_url = url
        _StubAsyncClient.last_headers = headers
        _StubAsyncClient.last_json = json
        return _StubAsyncClient.response


def _reset_client(payload: dict, status_code: int = 200) -> None:
    _StubAsyncClient.called = False
    _StubAsyncClient.last_url = None
    _StubAsyncClient.last_headers = None
    _StubAsyncClient.last_json = None
    _StubAsyncClient.response = _StubResponse(status_code, payload)


# --- pure unit: mapping helpers --------------------------------------------

def test_to_translate_source_mapping():
    assert _to_translate_source(None) == "auto"
    assert _to_translate_source("") == "auto"
    assert _to_translate_source("hi") == "hi-IN"
    assert _to_translate_source("hi-IN") == "hi-IN"
    assert _to_translate_source("zz") == "auto"


def test_is_english():
    assert _is_english("en") is True
    assert _is_english("en-IN") is True
    assert _is_english("hi") is False
    assert _is_english(None) is False


# --- mock-by-default --------------------------------------------------------

def test_mock_by_default_when_gate_off(monkeypatch):
    monkeypatch.setattr(translate_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({})

    adapter = TranslateAdapter(Settings(ai_enable_real_calls=False))
    assert adapter.real_enabled is False
    result = _run(adapter.translate(text="kuch bhi", source_language_code="hi"))

    assert result.is_mock is True
    assert result.english_text == MOCK_ENGLISH
    assert _StubAsyncClient.called is False  # no provider call on the mock path


# --- real success -----------------------------------------------------------

def test_real_success_maps_translation_and_sends_required_body(monkeypatch):
    monkeypatch.setattr(translate_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client(
        {"translated_text": "I am a VMC operator", "source_language_code": "hi-IN"}
    )

    adapter = TranslateAdapter(_real_settings())
    result = _run(adapter.translate(text="main vmc operator hoon", source_language_code="hi-IN"))

    assert result.is_mock is False
    assert result.english_text == "I am a VMC operator"
    assert result.detected_source == "hi-IN"
    assert result.error_code is None
    # Required body fields verified on the wire.
    body = _StubAsyncClient.last_json
    assert body["target_language_code"] == "en-IN"
    assert body["model"] == "mayura:v1"
    assert body["mode"] == "code-mixed"
    assert body["source_language_code"] == "hi-IN"


# --- english-skip (no API spend) -------------------------------------------

def test_english_source_skips_api_call(monkeypatch):
    monkeypatch.setattr(translate_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"translated_text": "should-not-be-used"})

    adapter = TranslateAdapter(_real_settings())
    result = _run(adapter.translate(text="hello", source_language_code="en-IN"))

    assert result.is_mock is False
    assert result.english_text == "hello"
    assert result.detected_source == "en-IN"
    assert _StubAsyncClient.called is False  # no API spend for an English source


# --- empty input ------------------------------------------------------------

def test_empty_text_is_noop(monkeypatch):
    monkeypatch.setattr(translate_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"translated_text": "should-not-be-used"})

    adapter = TranslateAdapter(_real_settings())
    result = _run(adapter.translate(text=""))

    assert result.english_text == ""
    assert _StubAsyncClient.called is False  # nothing to translate


# --- failure paths (must fail closed to empty) -----------------------------

def test_provider_error_fails_closed_to_empty(monkeypatch):
    monkeypatch.setattr(translate_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client(
        {"error": {"code": "authentication_error", "message": "..."}}, status_code=403
    )

    adapter = TranslateAdapter(_real_settings())
    result = _run(adapter.translate(text="main vmc operator hoon", source_language_code="hi"))

    assert result.english_text == ""
    assert result.is_mock is True
    assert result.error_code == "translate_call_failed"


def test_malformed_response_missing_translated_text_fails_closed(monkeypatch):
    monkeypatch.setattr(translate_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"request_id": "x"})

    adapter = TranslateAdapter(_real_settings())
    result = _run(adapter.translate(text="main vmc operator hoon", source_language_code="hi"))

    assert result.english_text == ""
    assert result.is_mock is True
    assert result.error_code == "translate_call_failed"


def test_char_cap_fails_closed_before_network(monkeypatch):
    monkeypatch.setattr(translate_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"translated_text": "should-not-be-used"})

    adapter = TranslateAdapter(_real_settings())
    long_text = "x" * 1001
    result = _run(adapter.translate(text=long_text, source_language_code="hi"))

    assert result.english_text == ""
    assert result.is_mock is True
    assert result.error_code == "translate_call_failed"
    assert _StubAsyncClient.called is False  # guard fired before any Sarvam call


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
