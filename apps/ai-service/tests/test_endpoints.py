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
    # THREE, not four: the city is no longer masked (owner ruling 2026-07-31 — cities
    # are a matching input, never PII). Name + phone + employer still are.
    assert body["replaced_entities"] == 3
    assert "[PERSON_1]" in body["pseudonymized_text"]
    assert "9876543210" not in body["pseudonymized_text"]
    assert "ABC Industries" not in body["pseudonymized_text"]
    assert "Faridabad" in body["pseudonymized_text"]


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
    # The blocked reply is now persona Hinglish (it is STORED as a chat message, so it
    # enters the transcript and the extraction corpus). `app/profiling/persona.py` owns
    # the copy rules; this asserts the ROUTE serves the worker-facing constant.
    from app.main import _BLOCKED_REPLY

    assert body["reply_text"] == _BLOCKED_REPLY
    assert "dobara" in body["reply_text"].lower()


def test_profiling_respond_salary_amount_does_not_block_the_turn():
    """D-1 (docs/registers/context-drift-2026-07-16.md row D-1; ruling 2026-07-17):
    a worker answering the salary question with "1000000" used to get the whole
    turn blocked ("please rephrase..."). The in-range amount is now masked to
    [AMOUNT_n] pre-LLM while the raw turn still reaches the local signal
    detectors — so the interview advances instead of dead-ending on a real answer.

    WHAT MOVED, AND WHAT DID NOT. The original assertion was
    ``"salary_current" in updated_state["answered_topics"]``, which the deterministic
    engine populated. That engine is deleted and ``answered_topics`` is now permanently
    [] on this path — the model owns what was learned and records it in ``captured``.
    The D-1 property itself is unchanged and is the assertions below: an in-range rupee
    amount must be MASKED, not BLOCKED. Which field the model files it under is the
    model's business now, so asserting a specific key here would pin the model rather
    than the privacy gate this test exists for."""
    res = client.post(
        "/profiling/respond",
        json={"session_id": "s1", "message_text": "meri salary 1000000 hai"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["blocked"] is False
    assert "rephrase" not in body["reply_text"].lower()
    # The turn ADVANCED: state came back and the counter moved. That — not a particular
    # topic id — is what "the amount did not block the turn" means now.
    assert body["updated_state"] is not None
    assert body["updated_state"]["turn_count"] == 1
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


def test_voice_transcribe_returns_the_full_mock_transcript_for_a_120s_note():
    # D-2 at the ENDPOINT: a 120s note (MAX_VOICE_NOTE_SECONDS) must come back
    # with a full transcript in mock mode. It used to hit the 30s sync guard.
    from app.stt import MOCK_TRANSCRIPT

    for duration in (45, 120):
        res = client.post(
            "/voice/transcribe",
            json={
                "voice_note_id": "vn1",
                "storage_path": "voice-notes/w/x.m4a",
                "duration_seconds": duration,
            },
        )
        assert res.status_code == 200
        body = res.json()
        assert body["transcript_text"] == MOCK_TRANSCRIPT
        assert body["is_mock"] is True


def test_voice_transcribe_accepts_and_forwards_the_opaque_worker_ref(monkeypatch):
    # The D-2 spend-attribution seam: worker_ref rides the contract to the
    # adapter (per-user daily cap). It is an opaque id — never PII.
    from app import main as main_module
    from app.stt import SttResult

    seen = {}

    async def _fake_transcribe(**kwargs):
        seen.update(kwargs)
        return SttResult("t", 0.9, "hi", True)

    monkeypatch.setattr(main_module.stt_adapter, "transcribe", _fake_transcribe)
    res = client.post(
        "/voice/transcribe",
        json={
            "storage_path": "voice-notes/w/x.m4a",
            "duration_seconds": 120,
            "worker_ref": "opaque-worker-uuid",
            "translate_to_english": False,
        },
    )
    assert res.status_code == 200
    assert seen["worker_ref"] == "opaque-worker-uuid"
    assert seen["duration_seconds"] == 120


def test_chat_turn_masks_history_so_history_pii_cannot_reach_the_llm(monkeypatch):
    # Privacy. HISTORY IS THREADED NOW, which REVERSES the COST-3 posture this test was
    # written for. It used to assert the strongest possible property — the transcript is
    # not in the assembled messages AT ALL, so a raw phone in an earlier turn is
    # unreachable by construction. That is no longer available to us: a model conducting
    # its own interview cannot ask a follow-up to a conversation it cannot see.
    #
    # So the guarantee moves from "not sent" to "sent, masked, and fail-closed", and this
    # test moves with it. It is the ONLY endpoint-level assertion of that property — the
    # per-leg pseudonymize loop in profiling_respond is what stands between an old turn's
    # phone number and a provider, and if that loop is ever removed this is what catches
    # it. Capture what the endpoint actually hands the model.
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
    messages = captured["profiling_chat_turn"]
    blob = " ".join(m["content"] for m in messages)
    # THE assertion. The history leg reaches the model, but the phone in it does not.
    assert "9876543210" not in blob
    assert "[PHONE_1]" in blob  # masked, not dropped — the turn still has its context
    # Four messages: [0] the byte-stable static block, [1] the per-turn context,
    # [2] the masked history leg, [3] this turn's message. Pinned as a COUNT because
    # the ordering is load-bearing for prompt caching (messages[0] must stay stable)
    # and because a history leg silently vanishing would make the privacy assertion
    # above pass for the wrong reason.
    assert len(messages) == 4
    assert messages[2]["role"] == "user"
    assert "[PHONE_1]" in messages[2]["content"]
