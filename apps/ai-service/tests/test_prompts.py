"""Prompt-assembly tests — COST-3 stateless chat turn.

The profiling CHAT turn is **stateless by design**: ``build_chat_messages`` must
NOT re-send prior history. ``interview_engine`` already picks the next question
from local signals, so the model only has to *phrase* one templated question — it
needs no cross-turn memory. This keeps per-interview input cost O(n) instead of
O(n²) as the transcript grows.

The EXTRACTION path is a **separate** assembly (inline in ``main.py``) and still
sends the whole transcript in one user message — it genuinely needs full context.
These tests lock both properties: chat-turn flatness, extraction fullness.
"""

from __future__ import annotations

from app.contracts import AICallMetadata, ConversationMessage
from app.profiling import prompts


def _history(n: int) -> list[ConversationMessage]:
    """n alternating worker/assistant turns with unique, greppable content."""
    turns: list[ConversationMessage] = []
    for i in range(n):
        role = "worker" if i % 2 == 0 else "assistant"
        turns.append(ConversationMessage(role=role, text=f"PRIORTURN_{i}"))
    return turns


# --- Test 1: chat-turn message count is independent of history length -------
def test_chat_turn_message_count_is_independent_of_history_length():
    q = "Kitne saal ka experience hai?"
    msg = "vmc chalata hu"
    lengths = {len(prompts.build_chat_messages(_history(n), q, msg)) for n in (0, 1, 5, 9, 50)}
    # Always exactly [system persona, current user message, question] — flat.
    assert lengths == {3}


def test_chat_turn_omits_all_prior_history_text():
    q = "Kitne saal?"
    built = prompts.build_chat_messages(_history(9), q, "abhi ka jawab")
    blob = " ".join(m["content"] for m in built)
    # No prior-turn text leaks into the stateless chat turn…
    assert "PRIORTURN_" not in blob
    # …but the current question + current message are both present.
    assert q in blob
    assert "abhi ka jawab" in blob


# --- Test 3: mock-path regression — still asks the templated question -------
def test_chat_turn_still_embeds_the_engine_question_for_phrasing():
    q = "Fanuc ya Siemens?"
    built = prompts.build_chat_messages([], q, "cnc")
    assert built[0]["role"] == "system"  # persona block
    assert built[1] == {"role": "user", "content": "cnc"}  # the current message
    assert built[-1]["role"] == "system" and q in built[-1]["content"]  # the question


# --- Endpoint-level guards: capture what each path actually sends the model -
def _fake_meta(task_type: str) -> AICallMetadata:
    return AICallMetadata(
        ai_call_id="test",
        task_type=task_type,
        model_name="mock",
        provider="mock",
        real_call=False,
        created_at="1970-01-01T00:00:00Z",
    )


def _capturing_client(monkeypatch):
    """A TestClient whose router records the messages each endpoint assembles."""
    from fastapi.testclient import TestClient

    from app import main

    captured: dict[str, list[dict[str, str]]] = {}

    async def _fake_run(task_type, *, messages, mock_response, **_kwargs):
        captured[task_type] = messages
        return mock_response, _fake_meta(task_type)

    monkeypatch.setattr(main.router, "run", _fake_run)
    return TestClient(main.app), captured


def test_chat_endpoint_sends_no_history_regardless_of_transcript(monkeypatch):
    # Integration proof of COST-3: even with a long history in the request, the
    # messages the model receives stay flat and carry no prior-turn text.
    client, captured = _capturing_client(monkeypatch)
    res = client.post(
        "/profiling/respond",
        json={
            "session_id": "s1",
            "message_text": "abhi VMC chalata hu",
            "history": [{"role": "worker", "text": f"PRIORTURN_{i}"} for i in range(9)],
        },
    )
    assert res.status_code == 200
    sent = captured["profiling_chat_turn"]
    assert len(sent) == 3  # flat, independent of the 9-turn history
    assert "PRIORTURN_" not in " ".join(m["content"] for m in sent)


def test_extraction_endpoint_still_receives_the_full_transcript(monkeypatch):
    # The extraction path must keep every turn — a truncated transcript would drop
    # early facts. All three turns' (PII-free) content must reach the single user
    # message the extraction model sees.
    client, captured = _capturing_client(monkeypatch)
    res = client.post(
        "/profile/extract",
        json={
            "messages": [
                {"role": "worker", "text": "I run a VMC machine"},
                {"role": "worker", "text": "5 saal ka experience"},
                {"role": "worker", "text": "Fanuc controller chalata hu"},
            ]
        },
    )
    assert res.status_code == 200
    sent = captured["profile_extraction"]
    user_msg = sent[-1]["content"]
    assert "VMC" in user_msg
    assert "5 saal" in user_msg
    assert "Fanuc" in user_msg
