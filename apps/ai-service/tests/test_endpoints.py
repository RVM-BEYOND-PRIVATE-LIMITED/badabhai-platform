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
    res = client.post(
        "/voice/transcribe",
        json={"voice_note_id": "vn1", "storage_path": "worker/sess/v1.ogg"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["is_mock"] is True
    assert len(body["transcript_text"]) > 0
    assert 0.0 <= body["confidence"] <= 1.0


def test_voice_transcribe_requires_storage_path():
    res = client.post("/voice/transcribe", json={"voice_note_id": "vn1"})
    assert res.status_code == 422  # storage_path is required


def test_conversation_history_is_pseudonymized_before_llm():
    # Privacy: prior turns must be pseudonymized before they can reach an LLM
    # (real mode) or a Langfuse trace. A phone in history is masked; a turn that
    # can't be safely pseudonymized is dropped (fail closed).
    from app.contracts import ConversationMessage
    from app.main import _pseudonymized_history

    safe = _pseudonymized_history(
        [
            ConversationMessage(role="worker", text="my number is 9876543210"),
            ConversationMessage(role="worker", text="I run a VMC machine"),
            ConversationMessage(role="worker", text="ref 12345678"),  # residual digits -> blocked
        ]
    )
    joined = " ".join(m.text for m in safe)
    assert "9876543210" not in joined  # phone masked
    assert "12345678" not in joined  # unsafe turn dropped
    assert any("VMC" in m.text for m in safe)  # safe technical turn kept
