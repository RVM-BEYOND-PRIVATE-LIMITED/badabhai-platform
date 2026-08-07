"""TTS adapter tests.

Mirrors `test_stt.py`: mock-by-default (no provider needed), real mode gated by the
FULL chain, and every failure path fails closed to EMPTY audio — never a fabricated
or substituted clip.

The gate-chain block is the important part. `stt.py`'s docstring records two shipped
incidents where a provider kept firing because an adapter read `ai_enable_real_calls`
directly instead of going through `real_calls_blocked_reason` + `real_call_enabled_for`.
These tests assert TTS cannot regress the same way, one rung at a time.
"""

import asyncio
import base64
from pathlib import Path

import httpx
import pytest

from app.ai import cost_tracker
from app.config import Settings
from app.tts import MAX_INPUT_CHARS, TTS_TASK_TYPE, TtsAdapter


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _reset_ledger():
    """The real path reserves spend on the TD27 ledger, so pin a fresh IN-PROCESS
    ledger (ignoring any ambient AI_SPEND_REDIS_URL/.env — a dev box pointing at an
    unreachable Redis would otherwise fail closed and block)."""
    cost_tracker._ledger = cost_tracker.SpendLedger(
        Settings(_env_file=None, ai_spend_redis_url=None)
    )
    yield
    cost_tracker._ledger = None


def _armed(**overrides) -> Settings:
    """Settings with the real TTS path FULLY armed."""
    base = dict(
        _env_file=None,
        ai_enable_real_calls=True,
        ai_real_calls_kill_switch=False,
        gemini_flash_api_key="gem-key",
        ai_real_call_tasks=TTS_TASK_TYPE,
        sarvam_api_key="sarvam-key",
        ai_spend_redis_url=None,
    )
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# The gate chain — one rung at a time, each degrading identically
# ---------------------------------------------------------------------------


def test_fully_armed_is_the_only_state_that_enables_the_real_path():
    assert TtsAdapter(_armed()).real_blocked_reason() is None


@pytest.mark.parametrize(
    "overrides,expected_fragment",
    [
        ({"ai_real_calls_kill_switch": True}, "kill switch"),
        ({"ai_enable_real_calls": False}, "AI_ENABLE_REAL_CALLS"),
        ({"gemini_flash_api_key": None}, "GEMINI_FLASH_API_KEY"),
        ({"ai_real_call_tasks": ""}, TTS_TASK_TYPE),
        ({"ai_real_call_tasks": "profile_extraction"}, TTS_TASK_TYPE),
        ({"sarvam_api_key": None}, "SARVAM_API_KEY"),
    ],
)
def test_every_missing_rung_blocks_the_real_path(overrides, expected_fragment):
    adapter = TtsAdapter(_armed(**overrides))
    reason = adapter.real_blocked_reason()
    assert reason is not None
    assert expected_fragment in reason
    assert adapter.real_enabled is False


def test_kill_switch_outranks_the_master_flag():
    """TD27: the kill-switch is the independent HARD stop. It must win even when
    every other rung is armed — the incident in stt.py was a kill-switch pulled
    during an incident that silenced LLM calls while audio kept flowing."""
    adapter = TtsAdapter(_armed(ai_real_calls_kill_switch=True))
    assert "kill switch" in (adapter.real_blocked_reason() or "")


def test_stt_allowlist_alone_does_not_arm_tts():
    """The whole point of a per-task allowlist is one provider leg at a time. Arming
    STT must not arm TTS, and vice versa — otherwise the staged flip is a fiction."""
    adapter = TtsAdapter(_armed(ai_real_call_tasks="stt_transcription"))
    assert adapter.real_enabled is False


def test_blocked_real_path_returns_mock_and_never_calls_the_provider(monkeypatch):
    def _boom(*_a, **_k):  # pragma: no cover - must never run
        raise AssertionError("provider must not be called when the gate is closed")

    monkeypatch.setattr(httpx.AsyncClient, "post", _boom)
    result = _run(TtsAdapter(_armed(ai_enable_real_calls=False)).synthesize(text="Namaste"))
    assert result.is_mock is True
    assert result.audio == b""
    assert result.error_code is None


# ---------------------------------------------------------------------------
# Refusals that happen BEFORE any spend
# ---------------------------------------------------------------------------


def test_placeholder_text_is_refused_before_any_provider_call(monkeypatch):
    """THE PRIVACY WALL. A shared pre-rendered cache plus post-emit interpolation
    (the AI-PERSONA-2 mechanism) is how one worker's name would be spoken to every
    other worker. Refuse at the boundary, not just in the corpus validator."""

    def _boom(*_a, **_k):  # pragma: no cover - must never run
        raise AssertionError("provider must not be called for placeholder text")

    monkeypatch.setattr(httpx.AsyncClient, "post", _boom)
    result = _run(TtsAdapter(_armed()).synthesize(text="Namaste {{worker_name}}, kaise hain?"))
    assert result.error_code == "tts_placeholder_text"
    assert result.audio == b""
    assert result.is_mock is True


def test_placeholder_text_is_never_logged(caplog):
    """The refusal must not defeat itself by logging the very string it refused."""
    secret = "{{worker_name}}"
    _run(TtsAdapter(_armed()).synthesize(text=f"Namaste {secret}"))
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "worker_name" not in joined


def test_empty_text_is_refused():
    result = _run(TtsAdapter(_armed()).synthesize(text="   "))
    assert result.error_code == "tts_empty_text"
    assert result.audio == b""


def test_over_cap_text_is_refused_before_the_call(monkeypatch):
    def _boom(*_a, **_k):  # pragma: no cover - must never run
        raise AssertionError("provider must not be called for over-cap text")

    monkeypatch.setattr(httpx.AsyncClient, "post", _boom)
    result = _run(TtsAdapter(_armed()).synthesize(text="a" * (MAX_INPUT_CHARS + 1)))
    assert result.error_code == "tts_text_too_long"
    assert result.audio == b""


# ---------------------------------------------------------------------------
# The real path — success, and every way it fails closed
# ---------------------------------------------------------------------------


def _resp(status: int, payload: object) -> httpx.Response:
    return httpx.Response(status_code=status, json=payload)


def test_real_success_returns_decoded_audio(monkeypatch):
    raw = b"RIFFfake-wav-bytes"

    async def _post(self, url, **kwargs):  # noqa: ANN001
        assert url == "https://api.sarvam.ai/text-to-speech"
        assert kwargs["headers"]["api-subscription-key"] == "sarvam-key"
        assert kwargs["json"]["text"] == "Aap kaunsa kaam karte hain?"
        return _resp(200, {"audios": [base64.b64encode(raw).decode()]})

    monkeypatch.setattr(httpx.AsyncClient, "post", _post)
    result = _run(TtsAdapter(_armed()).synthesize(text="Aap kaunsa kaam karte hain?"))
    assert result.is_mock is False
    assert result.error_code is None
    assert result.audio == raw


@pytest.mark.parametrize(
    "payload,status",
    [
        ({"audios": []}, 200),
        ({"audios": [""]}, 200),
        ({"audios": ["!!!not-base64!!!"]}, 200),
        ({"wrong_key": ["x"]}, 200),
        ({"error": {"code": "rate_limited"}}, 429),
        ({"error": {"code": "boom"}}, 500),
    ],
)
def test_every_bad_response_fails_closed_to_empty_audio(monkeypatch, payload, status):
    async def _post(self, url, **kwargs):  # noqa: ANN001
        return _resp(status, payload)

    monkeypatch.setattr(httpx.AsyncClient, "post", _post)
    result = _run(TtsAdapter(_armed()).synthesize(text="Namaste"))
    assert result.audio == b""
    assert result.error_code == "tts_call_failed"
    assert result.is_mock is True


def test_transport_error_fails_closed(monkeypatch):
    async def _post(self, url, **kwargs):  # noqa: ANN001
        raise httpx.ConnectError("no route to host")

    monkeypatch.setattr(httpx.AsyncClient, "post", _post)
    result = _run(TtsAdapter(_armed()).synthesize(text="Namaste"))
    assert result.audio == b""
    assert result.error_code == "tts_call_failed"


def test_provider_error_text_never_reaches_the_logs(monkeypatch, caplog):
    """A provider's free-text message can echo the input back, so only the status
    and a closed-set code may be surfaced."""
    echoed = "SECRETQUESTIONTEXT"

    async def _post(self, url, **kwargs):  # noqa: ANN001
        return _resp(400, {"error": {"message": echoed}})

    monkeypatch.setattr(httpx.AsyncClient, "post", _post)
    _run(TtsAdapter(_armed()).synthesize(text="Namaste"))
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert echoed not in joined


# ---------------------------------------------------------------------------
# Spend
# ---------------------------------------------------------------------------


def test_per_call_ceiling_blocks_before_the_provider(monkeypatch):
    def _boom(*_a, **_k):  # pragma: no cover - must never run
        raise AssertionError("provider must not be called over the per-call ceiling")

    monkeypatch.setattr(httpx.AsyncClient, "post", _boom)
    # A rate high enough that one request exceeds the per-call ceiling.
    settings = _armed(sarvam_tts_cost_inr_per_10k_chars=100_000.0, ai_max_call_cost_inr=1.0)
    result = _run(TtsAdapter(settings).synthesize(text="Namaste"))
    assert result.error_code == "tts_budget_blocked"
    assert result.audio == b""


def test_projected_cost_applies_the_per_request_rounding_floor():
    """Sarvam rounds UP per request, so a 27-character question is not billed as 27
    characters. Modelling the floor is what makes 'render once' vs 'synthesize per
    session' an honest comparison rather than a flattering one."""
    adapter = TtsAdapter(_armed(sarvam_tts_min_billed_chars=500,
                                sarvam_tts_cost_inr_per_10k_chars=15.0))
    short = adapter.projected_inr("Aap kaunsa kaam karte hain?")  # 27 chars
    assert short == pytest.approx(500 * 15.0 / 10_000)
    # Past the floor it becomes linear again.
    long_text = "a" * 1000
    assert adapter.projected_inr(long_text) == pytest.approx(1000 * 15.0 / 10_000)


def test_mock_path_spends_nothing_at_any_length():
    adapter = TtsAdapter(_armed(ai_enable_real_calls=False))
    result = _run(adapter.synthesize(text="a" * 1200))
    assert result.is_mock is True
    assert result.audio == b""


# ---------------------------------------------------------------------------
# The structural wall
# ---------------------------------------------------------------------------


def test_no_router_can_reach_the_tts_adapter():
    """THE WALL IS STRUCTURAL, NOT A PROMISE.

    TTS is reachable only from the render CLI. If a FastAPI router ever imports it,
    a request body becomes speech — and the moment caller-supplied text can be
    synthesized, the pre-rendered corpus stops being authored content and the
    "no worker data crosses the TTS boundary" property is gone.

    Asserted over the source rather than over imports, so it fails on the line that
    introduces the coupling rather than at whatever runtime path first exercises it.
    """
    routers = (Path(__file__).resolve().parents[1] / "app" / "routers").glob("*.py")
    offenders = [
        p.name
        for p in routers
        if "TtsAdapter" in (src := p.read_text(encoding="utf-8"))
        or "from ..tts" in src
        or "app.tts" in src
    ]
    assert offenders == [], (
        f"{offenders} reference the TTS adapter. TTS must stay CLI-only: a router "
        "that can synthesize caller-supplied text defeats the whole privacy argument."
    )
