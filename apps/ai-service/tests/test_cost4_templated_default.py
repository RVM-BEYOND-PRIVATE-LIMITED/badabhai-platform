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
from app.profiling import interview_engine, question_bank


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


# --- COST-4 clarify fix: the rephrase targets the CONFUSING question, and the
# --- engine must NOT advance on a clarifying message ------------------------
_CLARIFY_STATE = {
    "role_family": "cnc_vmc",
    "turn_count": 1,
    "answered_topics": [],
    "asked_question_ids": ["role"],
    "collected": {},
}


def test_clarify_flag_off_reserves_the_same_question_without_advancing(monkeypatch):
    # Flag OFF (templated mode): "matlab kya?" after the ROLE question must re-serve
    # the ROLE question — not the next topic — and must NOT mis-advance the state
    # (pre-fix, asked_question_ids gained the next topic and ROLE was skipped forever,
    # ESSENTIAL_TOPICS included).
    calls, client = _install(monkeypatch, _real_settings(rephrase=False))
    role_q = question_bank.topic_by_id("cnc_vmc", "role").question
    res = client.post(
        "/profiling/respond",
        json={
            "session_id": "s1",
            "message_text": "matlab kya?",
            "conversation_state": _CLARIFY_STATE,
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert calls["n"] == 0  # flag OFF -> still zero LLM calls
    assert body["reply_text"] == role_q  # the ROLE question again, verbatim
    assert body["asked_question_id"] == "role"
    st = body["updated_state"]
    assert st["asked_question_ids"] == ["role"]  # UNCHANGED — topic stays re-askable
    assert st["answered_topics"] == []  # a clarification is not an answer
    assert st["turn_count"] == 2
    assert st["clarify_count"] == 1  # the consecutive-clarify streak counter
    assert body["extraction_ready"] is False


def test_clarify_flag_on_rephrases_the_confusing_question(monkeypatch):
    # Flag ON: the rephrase LLM call receives the CONFUSING (re-served ROLE) question
    # as its target — not the next topic's question.
    seen: list[list[dict]] = []

    async def _spy(**kwargs):
        seen.append(kwargs["messages"])
        return LlmResult(
            content="Aap kaunsa kaam karte hain, aaram se bataiye?",
            input_tokens=5,
            output_tokens=6,
        )

    settings = _real_settings(rephrase=True)
    monkeypatch.setattr(providers_module, "complete", _spy)
    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "router", AIRouter(settings))
    client = TestClient(main.app)

    role_q = question_bank.topic_by_id("cnc_vmc", "role").question
    machines_q = question_bank.topic_by_id("cnc_vmc", "machines").question
    res = client.post(
        "/profiling/respond",
        json={
            "session_id": "s1",
            "message_text": "matlab kya?",
            "conversation_state": _CLARIFY_STATE,
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert len(seen) == 1  # exactly one rephrase call
    blob = "\n".join(m["content"] for m in seen[0])
    assert role_q in blob  # the CONFUSING question is the rephrase target...
    assert machines_q not in blob  # ...never the next topic's question
    assert body["asked_question_id"] == "role"
    assert body["updated_state"]["asked_question_ids"] == ["role"]
    assert body["is_mock"] is False


def test_clarify_without_state_still_falls_through_to_the_engine(monkeypatch):
    # No conversation_state (first contact): nothing to re-serve, so the engine runs
    # normally and the reply is a real question (backward-compatible fall-through).
    calls, client = _install(monkeypatch, _real_settings(rephrase=False))
    res = client.post(
        "/profiling/respond",
        json={"session_id": "s1", "message_text": "matlab kya?"},
    )
    assert res.status_code == 200
    body = res.json()
    assert calls["n"] == 0
    assert body["asked_question_id"] is not None  # the engine chose a question
    assert len(body["reply_text"]) > 0


def test_clarify_turn_helper_is_none_for_unknown_last_id():
    # Defensive: an unknown asked id (state from an older bank) falls through.
    from app.contracts import ConversationState

    st = ConversationState(asked_question_ids=["not_a_topic"])
    assert interview_engine.clarify_turn(st, "matlab kya?", "cnc_vmc") is None
    assert interview_engine.clarify_turn(None, "matlab kya?", "cnc_vmc") is None


# --- #238 HIGH regression: the clarify gate must never EAT an answer --------
@pytest.mark.parametrize(
    ("msg", "topic"),
    [
        ("Fanuc?", "controllers"),  # short '?'-suffixed answer
        ("2 saal?", "experience"),  # short '?'-suffixed answer
        ("Pune?", "location"),  # short '?'-suffixed answer
        # marker-bearing HONEST answer ('samajh nahi' on the skills question that
        # literally asks "kya aata hai?"):
        ("program edit samajh nahi aata, baaki sab aata hai", "skills"),
    ],
)
def test_extractable_answer_trumps_clarify_and_advances(monkeypatch, msg, topic):
    # Answer-trumps-clarify: each needs_rephrase false-positive class must advance
    # the interview exactly as on main — the topic is RECORDED and the engine moves
    # on (pre-fix these re-served the identical question forever, state frozen).
    calls, client = _install(monkeypatch, _real_settings(rephrase=False))
    res = client.post(
        "/profiling/respond",
        json={
            "session_id": "s1",
            "message_text": msg,
            "conversation_state": {
                "role_family": "cnc_vmc",
                "turn_count": 1,
                "answered_topics": [],
                "asked_question_ids": [topic],
                "collected": {},
            },
        },
    )
    assert res.status_code == 200
    body = res.json()
    st = body["updated_state"]
    assert topic in st["answered_topics"]  # the answer was extracted, not eaten
    assert body["asked_question_id"] != topic  # the engine moved to a NEW question
    assert len(st["asked_question_ids"]) == 2  # progressed — not frozen at [topic]
    assert st["clarify_count"] == 0  # next_turn ran (and resets the streak)


def test_third_consecutive_clarify_falls_through_to_the_engine(monkeypatch):
    # Bounded clarifies: after 2 consecutive re-serves the third genuine clarify
    # falls through to next_turn — the interview can never loop on one question.
    calls, client = _install(monkeypatch, _real_settings(rephrase=False))
    state = dict(_CLARIFY_STATE, clarify_count=2)
    res = client.post(
        "/profiling/respond",
        json={"session_id": "s1", "message_text": "matlab kya?", "conversation_state": state},
    )
    assert res.status_code == 200
    body = res.json()
    # next_turn ran: role is already in asked_question_ids, so the engine moves on.
    assert body["asked_question_id"] == "machines"
    st = body["updated_state"]
    assert "machines" in st["asked_question_ids"]
    assert st["clarify_count"] == 0  # every next_turn resets the streak


def test_second_consecutive_clarify_still_reserves(monkeypatch):
    # Inside the budget (count=1 -> 2nd consecutive) a genuine clarify still
    # re-serves the same question.
    calls, client = _install(monkeypatch, _real_settings(rephrase=False))
    state = dict(_CLARIFY_STATE, clarify_count=1)
    res = client.post(
        "/profiling/respond",
        json={"session_id": "s1", "message_text": "matlab kya?", "conversation_state": state},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["asked_question_id"] == "role"  # re-served, still within budget
    assert body["updated_state"]["clarify_count"] == 2


# --- tuple-shape regression (AI-PERSONA-1 backward-compat) -----------------
def test_next_turn_tuple_shape_unchanged():
    out = interview_engine.next_turn(None, "main vmc chalata hu", "cnc_vmc")
    assert len(out) == 4
    reply, asked_id, state, ready = out
    assert isinstance(reply, str)
    assert asked_id is None or isinstance(asked_id, str)
    assert isinstance(ready, bool)
