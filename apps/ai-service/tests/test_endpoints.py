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

