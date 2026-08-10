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

# ── REMOVED WITH THE ROUTE (OIE Phase 8) ───────────────────────────────────────────────
# `POST /profiling/respond` is deleted: the interview is deterministic and makes no model
# call per turn, so there is no turn endpoint left to test. Four tests went with it —
# mock-when-real-calls-disabled, blocks-unsafe-input, an in-range salary must be MASKED not
# BLOCKED (D-1), and history PII must not reach the model.
#
# THE TWO PRIVACY PROPERTIES DID NOT GO WITH THEM. Both moved to the one LLM call that
# remains, and both are asserted in `test_profile_parse.py`, which is stricter about them
# than this file ever was: it masks PER MESSAGE rather than per concatenated transcript, so
# a long interview can no longer blow the 20,000-char ceiling and fail closed to an empty
# profile. See `test_worker_pii_is_masked_before_it_reaches_the_model` and
# `test_one_unmaskable_message_is_dropped_and_counted_never_fatal` there.


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


def test_voice_transcribe_returns_the_error_code_instead_of_only_logging_it(monkeypatch):
    """A degraded result must SAY it is degraded, on the wire.

    ``SttAdapter`` has always distinguished ``stt_budget_blocked`` (we refused to
    call the provider) and ``stt_call_failed`` (the call failed) from a worker who
    genuinely said nothing. That code was written to the log line in this router and
    then DROPPED from the response, so all three reached the backend as the same
    empty string — which the transcription processor stored and marked ``completed``.
    In a voice-driven form that is a worker's spoken answer vanishing behind a green
    tick, with the audio already bought and stored.
    """
    from app import main as main_module
    from app.stt import SttResult

    async def _blocked(**_kwargs):
        return SttResult("", 0.0, None, True, error_code="stt_budget_blocked")

    monkeypatch.setattr(main_module.stt_adapter, "transcribe", _blocked)
    res = client.post(
        "/voice/transcribe",
        json={"storage_path": "voice-notes/w/x.m4a", "translate_to_english": False},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["error_code"] == "stt_budget_blocked"
    assert body["transcript_text"] == ""


def test_voice_transcribe_error_code_is_null_on_the_happy_path(monkeypatch):
    """The other half: nothing wrong means nothing to report.

    Without this, a backend that treats any non-null ``error_code`` as a failure
    would reject every successful transcription.
    """
    from app import main as main_module
    from app.stt import SttResult

    async def _ok(**_kwargs):
        return SttResult("main welder hoon", 0.9, "hi-IN", False)

    monkeypatch.setattr(main_module.stt_adapter, "transcribe", _ok)
    res = client.post(
        "/voice/transcribe",
        json={"storage_path": "voice-notes/w/x.m4a", "translate_to_english": False},
    )
    assert res.status_code == 200
    assert res.json()["error_code"] is None



# --- STT cost metadata (#738) ----------------------------------------------
# Until `ai_metadata` existed on this response the backend could not price a
# transcription even in principle: it carried no cost field, so no emitter could
# have recorded one. STT spend was capped by a Redis limiter whose keys expire
# ~25h after the day they describe, and recorded nowhere durable.


def test_voice_transcribe_returns_cost_metadata_for_the_stt_call():
    res = client.post(
        "/voice/transcribe",
        json={"voice_note_id": "vn1", "storage_path": "worker/sess/v1.ogg"},
    )
    assert res.status_code == 200
    meta = res.json()["ai_metadata"]
    assert meta is not None, "the backend has nothing to emit without this"
    assert meta["task_type"] == "stt_transcription"
    assert meta["ai_call_id"]


def test_voice_transcribe_mock_reports_zero_cost_not_a_projection():
    # A mocked environment must not write fictional money into the cost history.
    # `real_call=False` is the unambiguous "nothing was attempted", and the rupees
    # must follow it — TD81 says staging silently runs mocked AI, so a projected
    # figure here would be reported as spend by the obvious SUM() query.
    res = client.post(
        "/voice/transcribe",
        json={"voice_note_id": "vn1", "storage_path": "worker/sess/v1.ogg"},
    )
    meta = res.json()["ai_metadata"]
    assert meta["real_call"] is False
    assert meta["estimated_cost_inr"] == 0.0


def test_voice_transcribe_cost_metadata_carries_no_worker_text():
    # The response's transcript is raw worker free-text; the cost record is the part
    # that goes to events, so it must never carry any of it.
    res = client.post(
        "/voice/transcribe",
        json={"voice_note_id": "vn1", "storage_path": "worker/sess/v1.ogg"},
    )
    body = res.json()
    dumped = str(body["ai_metadata"])
    assert body["transcript_text"] not in dumped
    assert body["english_text"] not in dumped
