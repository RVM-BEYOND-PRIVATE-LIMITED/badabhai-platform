"""Endpoint tests using FastAPI's TestClient (needs fastapi + pydantic + httpx)."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == "ai-service"
    # Real calls are disabled by default (fail closed).
    assert body["real_calls_enabled"] is False


def test_pseudonymize_endpoint_masks_pii():
    res = client.post(
        "/pseudonymize",
        json={"text": "Rahul, phone 9876543210, worked at ABC Industries in Faridabad"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["blocked"] is False
    assert body["replaced_entities"] == 4
    assert "[PERSON_1]" in body["pseudonymized_text"]
    assert "9876543210" not in body["pseudonymized_text"]


def test_profiling_respond_returns_mock_when_real_calls_disabled():
    res = client.post(
        "/profiling/respond",
        json={"session_id": "s1", "message_text": "I run a VMC machine"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["blocked"] is False
    assert body["is_mock"] is True
    assert len(body["reply_text"]) > 0


def test_profiling_respond_blocks_unsafe_input():
    res = client.post(
        "/profiling/respond",
        json={"session_id": "s1", "message_text": "my reference number is 12345678"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["blocked"] is True
    assert "rephrase" in body["reply_text"].lower()


def test_profiling_respond_salary_amount_does_not_block_the_turn():
    """D-1 (docs/registers/context-drift-2026-07-16.md row D-1; ruling 2026-07-17):
    a worker answering the salary question with "1000000" used to get the whole
    turn blocked ("please rephrase..."). The in-range amount is now masked to
    [AMOUNT_n] pre-LLM while the raw turn still reaches the local signal
    detectors — so the interview advances and the salary topic is recorded."""
    res = client.post(
        "/profiling/respond",
        json={"session_id": "s1", "message_text": "meri salary 1000000 hai"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["blocked"] is False
    assert "rephrase" not in body["reply_text"].lower()
    assert "salary_current" in body["updated_state"]["answered_topics"]
    # The masked text (what could reach an LLM) carries no digits.
    meta = body["pseudonymization_metadata"]
    assert meta["blocked"] is False
    assert "[AMOUNT_1]" in meta["placeholder_tokens"]


def test_profile_extract_returns_structured_draft():
    res = client.post(
        "/profile/extract",
        json={"transcript": "I run a VMC, 5 years experience, Fanuc controller"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["is_mock"] is True
    assert body["blocked"] is False
    assert "mach_vmc" in body["profile"]["machines"]
    assert body["profile"]["canonical_role_id"] == "role_vmc_operator"
    assert body["profile"]["experience"]["total_years"] == 5
    assert "skill_fanuc" in body["profile"]["skills"]


def test_resume_generate_builds_text():
    res = client.post(
        "/resume/generate",
        json={"profile": {"canonical_role_id": "role_vmc_operator", "machines": ["mach_vmc"]}},
    )
    assert res.status_code == 200
    body = res.json()
    assert "WORKER PROFILE" in body["resume_text"]
    assert body["is_mock"] is True


def test_profile_extract_fails_closed_on_unsafe_input():
    # Privacy gate for the extraction path we are about to make real: if
    # pseudonymization blocks, the endpoint returns BEFORE the router/LLM is
    # reached — extraction_status=blocked, mock, no profile leaked.
    res = client.post("/profile/extract", json={"transcript": "my reference number is 12345678"})
    assert res.status_code == 200
    body = res.json()
    assert body["blocked"] is True
    assert body["extraction_status"] == "blocked"
    assert body["is_mock"] is True


def test_voice_transcribe_returns_mock_when_real_calls_disabled():
    from app.translate import MOCK_ENGLISH

    res = client.post(
        "/voice/transcribe",
        json={"voice_note_id": "vn1", "storage_path": "worker/sess/v1.ogg"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["is_mock"] is True
    assert len(body["transcript_text"]) > 0
    assert 0.0 <= body["confidence"] <= 1.0
    # Translation also runs in mock mode (gate off → TranslateAdapter mock gloss).
    assert len(body["english_text"]) > 0
    assert body["english_text"] == MOCK_ENGLISH


def test_voice_transcribe_skips_translation_when_disabled():
    res = client.post(
        "/voice/transcribe",
        json={"voice_note_id": "vn1", "storage_path": "x", "translate_to_english": False},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["english_text"] == ""


def test_voice_transcribe_requires_storage_path():
    res = client.post("/voice/transcribe", json={"voice_note_id": "vn1"})
    assert res.status_code == 422  # storage_path is required


def test_chat_turn_sends_no_history_so_history_pii_cannot_reach_the_llm(monkeypatch):
    # Privacy (COST-3): the chat turn is stateless — prior history is never sent to
    # the model. This is STRONGER than pseudonymizing history: even a raw phone in a
    # prior turn cannot reach LLM input / a Langfuse trace, because history is not in
    # the assembled messages at all. Capture what the endpoint hands the model.
    from app import main
    from app.contracts import AICallMetadata

    captured: dict[str, list[dict[str, str]]] = {}

    async def _fake_run(task_type, *, messages, mock_response, **_kwargs):
        captured[task_type] = messages
        return mock_response, AICallMetadata(
            ai_call_id="t",
            task_type=task_type,
            model_name="mock",
            provider="mock",
            real_call=False,
            created_at="1970-01-01T00:00:00Z",
        )

    monkeypatch.setattr(main.router, "run", _fake_run)
    res = client.post(
        "/profiling/respond",
        json={
            "session_id": "s1",
            "message_text": "I run a VMC machine",
            "history": [{"role": "worker", "text": "my number is 9876543210"}],
        },
    )
    assert res.status_code == 200
    blob = " ".join(m["content"] for m in captured["profiling_chat_turn"])
    assert "9876543210" not in blob  # the history phone never reaches the model
    assert len(captured["profiling_chat_turn"]) == 3  # flat: no history threaded
