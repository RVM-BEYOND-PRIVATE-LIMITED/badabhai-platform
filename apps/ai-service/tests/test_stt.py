"""STT adapter tests.

Verify mock-by-default (no provider needed), real mode is gated (flag + key),
and the real path fails closed to an EMPTY transcript (never fabricated).
"""

import asyncio

from app.config import Settings
from app.stt import MOCK_TRANSCRIPT, SttAdapter


def _run(coro):
    return asyncio.run(coro)


def test_mock_mode_returns_deterministic_transcript_and_never_calls_provider():
    adapter = SttAdapter(Settings(ai_enable_real_calls=False))
    assert adapter.real_enabled is False
    result = _run(adapter.transcribe(storage_path="worker/sess/v1.ogg"))
    assert result.is_mock is True
    assert result.transcript_text == MOCK_TRANSCRIPT
    assert 0.0 <= result.confidence <= 1.0
    assert result.error_code is None


def test_real_requires_flag_and_key():
    # Flag on but no Sarvam key -> still blocked (fail closed) -> mock.
    adapter = SttAdapter(Settings(ai_enable_real_calls=True))
    assert adapter.real_enabled is False
    result = _run(adapter.transcribe(storage_path="x"))
    assert result.is_mock is True


def test_real_call_can_be_disabled_per_request():
    adapter = SttAdapter(Settings(ai_enable_real_calls=True, sarvam_api_key="k"))
    assert adapter.real_enabled is True
    result = _run(adapter.transcribe(storage_path="x", real_call_allowed=False))
    assert result.is_mock is True
    assert result.transcript_text == MOCK_TRANSCRIPT


def test_real_path_fails_closed_to_empty_transcript():
    # Real mode fully enabled, but the provider call is not wired in Phase 1
    # (raises) -> must NOT fabricate; returns empty + error_code, marked is_mock.
    adapter = SttAdapter(Settings(ai_enable_real_calls=True, sarvam_api_key="k"))
    result = _run(adapter.transcribe(storage_path="x"))
    assert result.transcript_text == ""
    assert result.is_mock is True
    assert result.error_code == "stt_call_failed"
