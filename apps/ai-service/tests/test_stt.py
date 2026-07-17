"""STT adapter tests.

Verify mock-by-default (no provider needed), real mode is gated (flag + key),
and the real path fails closed to an EMPTY transcript (never fabricated).
"""

import asyncio

import pytest

from app.ai import cost_tracker
from app.config import Settings
from app.stt import MOCK_TRANSCRIPT, SttAdapter


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _reset_ledger():
    """The real path now reserves STT chunk spend on the TD27 ledger, so pin a
    fresh IN-PROCESS ledger (ignoring any ambient REDIS_URL/.env — a dev box
    pointing at an unreachable Redis would otherwise fail closed and block)."""
    cost_tracker._ledger = cost_tracker.SpendLedger(Settings(_env_file=None, redis_url=None))
    yield
    cost_tracker._ledger = None


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
    # Real mode fully enabled, but storage is unconfigured here (raises) -> must
    # NOT fabricate; returns empty + error_code, marked is_mock.
    adapter = SttAdapter(Settings(ai_enable_real_calls=True, sarvam_api_key="k"))
    result = _run(adapter.transcribe(storage_path="x"))
    assert result.transcript_text == ""
    assert result.is_mock is True
    assert result.error_code == "stt_call_failed"


# --- D-2: the mock path is DURATION-AGNOSTIC --------------------------------
# The 30s sync limit is a REAL-provider upload constraint. Applying it to the
# mock path was the fail-closed-on-a-path-that-never-calls-the-provider absurdity
# D-2 named: a 45s or 120s note "failed" with no provider anywhere in sight.

@pytest.mark.parametrize("duration", [30.0, 31.0, 45.0, 90.0, 120.0])
def test_mock_mode_returns_the_full_transcript_at_any_duration(duration):
    adapter = SttAdapter(Settings(ai_enable_real_calls=False))
    result = _run(
        adapter.transcribe(storage_path="voice-notes/w/x.m4a", duration_seconds=duration)
    )
    assert result.transcript_text == MOCK_TRANSCRIPT  # FULL transcript, not empty
    assert result.is_mock is True
    assert result.error_code is None  # no 30s failure on a path with no provider


def test_mock_mode_at_45s_is_byte_identical_to_a_short_note():
    # Duration must not perturb the mock AT ALL — same text, confidence, language.
    adapter = SttAdapter(Settings(ai_enable_real_calls=False))
    short = _run(adapter.transcribe(storage_path="w/x.m4a", duration_seconds=5))
    long = _run(adapter.transcribe(storage_path="w/x.m4a", duration_seconds=45))
    assert (short.transcript_text, short.confidence, short.language_code) == (
        long.transcript_text,
        long.confidence,
        long.language_code,
    )


def test_mock_mode_beyond_the_platform_cap_still_mocks():
    # Even past MAX_VOICE_NOTE_SECONDS the mock cannot leak or spend — the cap is
    # enforced on upload (voiceDurationSecondsSchema) and on the REAL path.
    adapter = SttAdapter(Settings(ai_enable_real_calls=False))
    result = _run(adapter.transcribe(storage_path="w/x.m4a", duration_seconds=600))
    assert result.transcript_text == MOCK_TRANSCRIPT
    assert result.is_mock is True


def test_mock_mode_spends_nothing_on_the_ledger_at_any_duration():
    # Zero ledger traffic on the mock path (the TD68 posture): a 120s mock note
    # must not consume a paisa of the per-user daily budget.
    adapter = SttAdapter(Settings(ai_enable_real_calls=False))
    _run(adapter.transcribe(storage_path="w/x.m4a", duration_seconds=120, worker_ref="w-1"))
    snap = _run(
        cost_tracker.get_ledger().snapshot(Settings(_env_file=None), user_ref="w-1")
    )
    assert snap["daily_spend_inr"] == 0.0
    assert snap["user_daily_spend_inr"] == 0.0
