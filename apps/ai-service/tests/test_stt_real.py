"""Real Sarvam STT path tests.

NO network and NO Supabase: ``app.stt.download_object`` is monkeypatched to
return canned bytes (or raise), and ``httpx.AsyncClient`` is stubbed to capture
the Sarvam POST and return a canned response. These prove:

- success (auto-detect) maps transcript + language_probability -> SttResult;
- a specific language maps to ``xx-IN`` and uses the unreported-confidence default
  when ``language_probability`` is null;
- provider errors, malformed responses, storage failures and the >30s duration
  guard all FAIL CLOSED to an empty, never-fabricated transcript;
- the duration guard fires before any storage OR Sarvam call.

The ``transcribe`` wrapper (caught exception -> empty + ``stt_call_failed``) is the
unit under test for the failure cases — ``_transcribe_real`` itself raises.
"""

import asyncio

import pytest

from app import stt as stt_module
from app.config import Settings
from app.stt import MOCK_TRANSCRIPT, SttAdapter, _to_sarvam_language


def _run(coro):
    return asyncio.run(coro)


def _real_settings(**overrides) -> Settings:
    base = dict(
        ai_enable_real_calls=True,
        sarvam_api_key="k",
        supabase_url="https://x.supabase.co",
        supabase_service_role_key="svc",
    )
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
    last_files: dict | None = None
    last_data: dict | None = None
    response: _StubResponse = _StubResponse(200, {})

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def post(self, url, *, headers, files, data):
        _StubAsyncClient.called = True
        _StubAsyncClient.last_url = url
        _StubAsyncClient.last_headers = headers
        _StubAsyncClient.last_files = files
        _StubAsyncClient.last_data = data
        return _StubAsyncClient.response


def _reset_client(payload: dict, status_code: int = 200) -> None:
    _StubAsyncClient.called = False
    _StubAsyncClient.last_url = None
    _StubAsyncClient.last_headers = None
    _StubAsyncClient.last_files = None
    _StubAsyncClient.last_data = None
    _StubAsyncClient.response = _StubResponse(status_code, payload)


def _patch_storage(monkeypatch, *, returns: bytes | None = None, raises: Exception | None = None):
    calls = {"count": 0}

    async def _fake_download(settings, object_key, *, bucket):
        calls["count"] += 1
        if raises is not None:
            raise raises
        return returns if returns is not None else b"audio"

    monkeypatch.setattr(stt_module, "download_object", _fake_download)
    return calls


# --- language mapping (pure unit) ------------------------------------------

def test_to_sarvam_language_mapping():
    assert _to_sarvam_language(None) == "unknown"
    assert _to_sarvam_language("") == "unknown"
    assert _to_sarvam_language("hi") == "hi-IN"
    assert _to_sarvam_language("en") == "en-IN"
    assert _to_sarvam_language("hi-IN") == "hi-IN"
    assert _to_sarvam_language("zz") == "unknown"


# --- success paths ---------------------------------------------------------

def test_success_auto_detect_maps_transcript_and_probability(monkeypatch):
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client(
        {"transcript": "main vmc operator", "language_code": "hi-IN", "language_probability": 0.97}
    )
    _patch_storage(monkeypatch, returns=b"audio")

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="worker/sess/v1.ogg"))

    assert result.is_mock is False
    assert result.transcript_text == "main vmc operator"
    assert result.confidence == 0.97
    assert result.error_code is None
    assert result.language_code == "hi-IN"


def test_success_specific_language_null_probability_uses_default(monkeypatch):
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"transcript": "x", "language_code": "hi-IN", "language_probability": None})
    _patch_storage(monkeypatch, returns=b"audio")

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="worker/sess/v1.wav", language_code="hi"))

    assert result.is_mock is False
    assert result.transcript_text == "x"
    assert result.confidence == 1.0  # unreported -> _REAL_CONFIDENCE_WHEN_UNREPORTED
    assert result.error_code is None
    # Mapping verified on the wire: bare "hi" -> "hi-IN"; model is config default.
    assert _StubAsyncClient.last_data["language_code"] == "hi-IN"
    assert _StubAsyncClient.last_data["model"] == "saarika:v2.5"


def test_empty_transcript_string_is_valid_not_mock(monkeypatch):
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"transcript": "", "language_code": "hi-IN", "language_probability": 0.5})
    _patch_storage(monkeypatch, returns=b"audio")

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="worker/sess/v1.ogg"))

    assert result.is_mock is False
    assert result.transcript_text == ""
    assert result.error_code is None


# --- failure paths (must fail closed to empty) -----------------------------

def test_provider_error_fails_closed_to_empty(monkeypatch):
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client(
        {"error": {"code": "invalid_api_key_error", "message": "..."}}, status_code=403
    )
    _patch_storage(monkeypatch, returns=b"audio")

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="worker/sess/v1.ogg"))

    assert result.transcript_text == ""
    assert result.is_mock is True
    assert result.error_code == "stt_call_failed"


def test_malformed_response_missing_transcript_fails_closed(monkeypatch):
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"request_id": "x"})
    _patch_storage(monkeypatch, returns=b"audio")

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="worker/sess/v1.ogg"))

    assert result.transcript_text == ""
    assert result.is_mock is True
    assert result.error_code == "stt_call_failed"


def test_storage_failure_fails_closed_and_skips_sarvam(monkeypatch):
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"transcript": "should-not-be-used"})
    _patch_storage(
        monkeypatch, raises=RuntimeError("voice audio fetch failed with status 404")
    )

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="worker/sess/v1.ogg"))

    assert result.transcript_text == ""
    assert result.is_mock is True
    assert result.error_code == "stt_call_failed"
    assert _StubAsyncClient.called is False  # Sarvam never reached


def test_real_path_unconfigured_storage_fails_to_empty_not_mock(monkeypatch):
    # Real STT enabled (flag + sarvam key) but storage creds ABSENT. This must
    # fail CLOSED to an empty transcript — NOT silently downgrade to the mock CNC
    # transcript (which would be fabrication on the real path). Storage is NOT
    # patched here, so the real download_object runs and raises "not configured"
    # before any network; Sarvam must never be reached.
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"transcript": "should-not-be-used"})

    adapter = SttAdapter(
        _real_settings(supabase_url=None, supabase_service_role_key=None)
    )
    result = _run(adapter.transcribe(storage_path="worker/sess/v1.ogg"))

    assert result.transcript_text == ""
    assert result.transcript_text != MOCK_TRANSCRIPT  # never the mock on the real path
    assert result.is_mock is True
    assert result.error_code == "stt_call_failed"
    assert _StubAsyncClient.called is False  # Sarvam never reached


def test_duration_over_limit_fails_closed_before_storage_and_sarvam(monkeypatch):
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"transcript": "should-not-be-used"})
    storage_calls = _patch_storage(monkeypatch, returns=b"audio")

    adapter = SttAdapter(_real_settings())
    result = _run(
        adapter.transcribe(storage_path="worker/sess/v1.ogg", duration_seconds=45)
    )

    assert result.transcript_text == ""
    assert result.is_mock is True
    assert result.error_code == "stt_call_failed"
    assert storage_calls["count"] == 0  # storage never reached
    assert _StubAsyncClient.called is False  # Sarvam never reached


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
