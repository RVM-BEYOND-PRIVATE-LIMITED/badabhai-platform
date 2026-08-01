"""STT adapter tests.

Verify mock-by-default (no provider needed), real mode is gated (flag + key),
and the real path fails closed to an EMPTY transcript (never fabricated).
"""

import asyncio

import pytest

from app.ai import cost_tracker
from app.config import Settings
from app.stt import MOCK_TRANSCRIPT, STT_TASK_TYPE, SttAdapter


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _reset_ledger():
    """The real path now reserves STT chunk spend on the TD27 ledger, so pin a
    fresh IN-PROCESS ledger (ignoring any ambient AI_SPEND_REDIS_URL/.env — a dev box
    pointing at an unreachable Redis would otherwise fail closed and block)."""
    cost_tracker._ledger = cost_tracker.SpendLedger(
        Settings(_env_file=None, ai_spend_redis_url=None)
    )
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


def _armed(**overrides) -> Settings:
    """Settings with the real STT path FULLY armed. `gemini_flash_api_key` is required
    since the gating fix — `real_blocked_reason` delegates to
    `Settings.real_calls_blocked_reason()` so the kill-switch and the per-task allowlist
    reach STT, and that helper also demands the master key."""
    base = dict(ai_enable_real_calls=True, sarvam_api_key="k", gemini_flash_api_key="g")
    base.update(overrides)
    return Settings(**base)


def test_real_requires_flag_and_key():
    # Flag on but no Sarvam key -> still blocked (fail closed) -> mock.
    adapter = SttAdapter(Settings(ai_enable_real_calls=True, gemini_flash_api_key="g"))
    assert adapter.real_enabled is False
    assert "SARVAM_API_KEY" in (adapter.real_blocked_reason() or "")
    result = _run(adapter.transcribe(storage_path="x"))
    assert result.is_mock is True


def test_real_call_can_be_disabled_per_request():
    adapter = SttAdapter(_armed())
    assert adapter.real_enabled is True
    result = _run(adapter.transcribe(storage_path="x", real_call_allowed=False))
    assert result.is_mock is True
    assert result.transcript_text == MOCK_TRANSCRIPT


def test_real_path_fails_closed_to_empty_transcript():
    # Real mode fully enabled, but storage is unconfigured here (raises) -> must
    # NOT fabricate; returns empty + error_code, marked is_mock.
    adapter = SttAdapter(_armed())
    result = _run(adapter.transcribe(storage_path="x"))
    assert result.transcript_text == ""
    assert result.is_mock is True
    assert result.error_code == "stt_call_failed"


# --- STT GATING (flip safety) ------------------------------------------------
# THE TWO HOLES, both measured on the shipped code, which gated the real Sarvam path on
# `ai_enable_real_calls` + `sarvam_api_key` and NOTHING else:
#
#   1. AI_REAL_CALLS_KILL_SWITCH=true stopped every LLM call and left real AUDIO going
#      to Sarvam. Audio is the one input that cannot be pseudonymized before the
#      provider sees it, so it is the worst thing to leave armed during an incident.
#   2. AI_REAL_CALL_TASKS=profile_extraction — the intended FIRST flip — silently armed
#      real STT too, because STT consulted no allowlist at all.
#
# Every test below asserts the DEGRADED behaviour is exactly the missing-key behaviour
# (mock transcript, is_mock, no error_code): the caller contract does not move.


def test_the_kill_switch_stops_real_stt():
    """TD27's independent HARD stop must reach audio, not just the LLM."""
    adapter = SttAdapter(_armed(ai_real_calls_kill_switch=True))
    assert adapter.real_enabled is False
    assert adapter.real_blocked_reason() == "kill switch engaged"
    result = _run(adapter.transcribe(storage_path="x"))
    # Degrades EXACTLY like a missing key does — mock, never a fabricated real result.
    assert result.is_mock is True
    assert result.transcript_text == MOCK_TRANSCRIPT
    assert result.error_code is None


def test_an_allowlist_without_stt_blocks_real_stt():
    """One flag at a time: enabling real calls for extraction must not arm audio."""
    adapter = SttAdapter(_armed(ai_real_call_tasks="profile_extraction"))
    assert adapter.real_enabled is False
    assert STT_TASK_TYPE in (adapter.real_blocked_reason() or "")
    result = _run(adapter.transcribe(storage_path="x"))
    assert result.is_mock is True
    assert result.transcript_text == MOCK_TRANSCRIPT
    assert result.error_code is None


def test_an_allowlist_naming_stt_permits_it():
    adapter = SttAdapter(_armed(ai_real_call_tasks=f"profile_extraction,{STT_TASK_TYPE}"))
    assert adapter.real_blocked_reason() is None
    assert adapter.real_enabled is True


def test_an_empty_allowlist_permits_stt_for_back_compat():
    """EMPTY = all tasks. This is the pre-existing semantics and must not move — a
    deployment that never set AI_REAL_CALL_TASKS behaves exactly as before."""
    assert Settings(ai_real_call_tasks="").real_call_task_allowlist == frozenset()
    adapter = SttAdapter(_armed(ai_real_call_tasks=""))
    assert adapter.real_blocked_reason() is None
    assert adapter.real_enabled is True


def test_the_master_flag_still_governs_and_the_reason_names_it():
    adapter = SttAdapter(Settings(sarvam_api_key="k", gemini_flash_api_key="g"))
    assert adapter.real_blocked_reason() == "AI_ENABLE_REAL_CALLS is false"
    assert adapter.real_enabled is False


def test_the_stt_task_id_uses_the_one_existing_allowlist_mechanism():
    """No second mechanism was invented: the id is a plain string fed to the SAME
    `Settings.real_call_enabled_for` the embedding task uses."""
    from app.ai.embeddings import EMBEDDING_TASK_TYPE

    assert STT_TASK_TYPE == "stt_transcription"
    assert STT_TASK_TYPE != EMBEDDING_TASK_TYPE
    settings = _armed(ai_real_call_tasks=STT_TASK_TYPE)
    assert settings.real_call_enabled_for(STT_TASK_TYPE) is True
    assert settings.real_call_enabled_for(EMBEDDING_TASK_TYPE) is False


# --- D-2: the mock path is DURATION-AGNOSTIC --------------------------------
# The 30s sync limit is a REAL-provider upload constraint. Applying it to the
# mock path was the fail-closed-on-a-path-that-never-calls-the-provider absurdity
# D-2 named: a 45s or 120s note "failed" with no provider anywhere in sight.


@pytest.mark.parametrize("duration", [30.0, 31.0, 45.0, 90.0, 120.0])
def test_mock_mode_returns_the_full_transcript_at_any_duration(duration):
    adapter = SttAdapter(Settings(ai_enable_real_calls=False))
    result = _run(adapter.transcribe(storage_path="voice-notes/w/x.m4a", duration_seconds=duration))
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
    snap = _run(cost_tracker.get_ledger().snapshot(Settings(_env_file=None), user_ref="w-1"))
    assert snap["daily_spend_inr"] == 0.0
    assert snap["user_daily_spend_inr"] == 0.0
