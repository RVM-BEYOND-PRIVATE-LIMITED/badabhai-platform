"""COST-4: templated-question default — the profiling chat turn returns the
deterministic question_bank question and skips the chat LLM on the straight path
(zero output tokens). A real rephrase call fires only for a clarifying worker
message AND with ``ai_profiling_rephrase_enabled`` on (still gated by the master
real-call flag). Extraction is untouched (a separate endpoint).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import main
from app.ai import providers as providers_module
from app.ai.gemini_client import LlmResult
from app.ai.router import AIRouter
from app.config import Settings
from app.profiling import interview_engine


# --- needs_rephrase: conservative local predicate --------------------------
@pytest.mark.parametrize(
    "msg",
    [
        "main VMC chalata hu",
        "4 saal ka experience hai",
        "fanuc controller, setting bhi karta hu",
        "matlab main operator hu",  # filler 'matlab' — NOT interrogative
        "",
        # CNC/VMC domain terms that must NOT trip the say-again markers (F1):
        "main repeat order ke VMC parts banata hu, 5 saal",  # 'repeat order', not 'repeat kar'
        "repeatability check karta hu",  # 'repeat' substring — still an answer
        "company chhodi, phir se dusri join ki",  # 'phir se' join, not 'phir se bol'
        # A LONG answer that happens to end uncertainly is NOT a clarification:
        "main VMC aur CNC dono chala leta hu setting ke saath, theek hai kya?",
    ],
)
def test_needs_rephrase_false_for_straight_answers(msg):
    assert interview_engine.needs_rephrase(msg) is False


@pytest.mark.parametrize(
    "msg",
    [
        "matlab kya?",
        "samajh nahi aaya",
        "ye kya cheez hai?",
        "phir se boliye",
        "repeat karo",
        "kya matlab",
    ],
)
def test_needs_rephrase_true_for_clarifying_messages(msg):
    assert interview_engine.needs_rephrase(msg) is True


# --- adapter spy: what actually reaches the LLM transport ------------------
def _real_settings(*, rephrase: bool) -> Settings:
    # Real calls fully enabled so the ONLY thing gating a chat LLM call is COST-4.
    return Settings(
        ai_enable_real_calls=True,
        gemini_flash_api_key="test-key",
        ai_profiling_rephrase_enabled=rephrase,
    )


def _install(monkeypatch, settings: Settings):
    """Point the endpoint at real-enabled settings + a call-counting provider spy."""
    calls = {"n": 0}

    async def _spy(**_kwargs):
        calls["n"] += 1
        return LlmResult(content="Aap kaunsa kaam karte hain?", input_tokens=5, output_tokens=4)

    monkeypatch.setattr(providers_module, "complete", _spy)
    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "router", AIRouter(settings))
    return calls, TestClient(main.app)


def test_straight_turn_fires_no_chat_llm_call_even_in_real_mode(monkeypatch):
    # The biggest saving: a straight answer returns the templated question with ZERO
    # chat completions, even with real calls + the rephrase flag both ON.
    calls, client = _install(monkeypatch, _real_settings(rephrase=True))
    res = client.post(
        "/profiling/respond",
        json={"session_id": "s1", "message_text": "main VMC chalata hu 4 saal se"},
    )
    assert res.status_code == 200
    body = res.json()
    assert calls["n"] == 0  # no LLM call on the straight path
    assert body["is_mock"] is True
    assert len(body["reply_text"]) > 0  # the deterministic templated question


def test_clarifying_message_with_flag_on_fires_exactly_one_call(monkeypatch):
    calls, client = _install(monkeypatch, _real_settings(rephrase=True))
    res = client.post(
        "/profiling/respond",
        json={"session_id": "s1", "message_text": "matlab kya?"},
    )
    assert res.status_code == 200
    assert calls["n"] == 1  # the narrow rephrase branch fired once
    assert res.json()["is_mock"] is False


def test_clarifying_message_with_flag_off_stays_templated(monkeypatch):
    # Flag is OFF by default → even a clarifying message stays templated (no call).
    calls, client = _install(monkeypatch, _real_settings(rephrase=False))
    res = client.post(
        "/profiling/respond",
        json={"session_id": "s1", "message_text": "matlab kya?"},
    )
    assert res.status_code == 200
    assert calls["n"] == 0
    assert res.json()["is_mock"] is True


def test_extraction_still_calls_the_llm_in_real_mode(monkeypatch):
    # SG-3 / guardrail: COST-4 must NOT touch extraction — it is the legitimate LLM
    # job. A real-mode extraction still dispatches to the transport.
    calls, client = _install(monkeypatch, _real_settings(rephrase=False))
    res = client.post(
        "/profile/extract",
        json={"transcript": "I run a VMC, 5 years experience, Fanuc controller"},
    )
    assert res.status_code == 200
    assert calls["n"] == 1  # extraction is unaffected by the chat-turn gate


# --- tuple-shape regression (AI-PERSONA-1 backward-compat) -----------------
def test_next_turn_tuple_shape_unchanged():
    out = interview_engine.next_turn(None, "main vmc chalata hu", "cnc_vmc")
    assert len(out) == 4
    reply, asked_id, state, ready = out
    assert isinstance(reply, str)
    assert asked_id is None or isinstance(asked_id, str)
    assert isinstance(ready, bool)
