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


def test_profile_extract_degrades_on_a_blown_deadline():
    """`/profile/extract` shipped with NO deadline while `/profile/parse` had one, and
    that asymmetry is the shape of the reported incident.

    apps/api aborts this request at 8 s, and Starlette does NOT cancel a running handler
    when the client disconnects — so an unbounded call kept its worker slot and kept
    putting requests on a provider that was already rate-limiting us, minutes after the
    profile it was computing had been written from the fallback. The next trigger then
    started another one on top of it.

    Degrading costs only the enrichment overlay: the heuristic pass runs locally over the
    worker's own text before the model is ever reached, so the profile survives intact.
    `error_code` NAMES the degradation, which is what lets apps/api tell an outage from a
    worker who genuinely said nothing."""
    import asyncio

    from app.config import Settings
    from app.routers import profile as profile_router

    class _SlowRouter:
        async def run(self, *_args, **_kwargs):
            await asyncio.sleep(5.0)
            raise AssertionError("the deadline should have fired first")

    original_router = profile_router.router
    original_settings = profile_router.get_settings
    profile_router.router = _SlowRouter()
    profile_router.get_settings = lambda: Settings(profile_extract_deadline_seconds=0.05)
    try:
        res = client.post(
            "/profile/extract",
            json={"transcript": "I run a VMC, 5 years experience, Fanuc controller"},
        )
    finally:
        profile_router.router = original_router
        profile_router.get_settings = original_settings

    assert res.status_code == 200
    body = res.json()
    assert body["error_code"] == "extract_deadline_exceeded"
    assert body["blocked"] is False
    # The local heuristic pass survives the timeout — only the model overlay is lost.
    assert "mach_vmc" in body["profile"]["machines"]
    assert body["profile"]["experience"]["total_years"] == 5
    # NO fabricated cost record: a zero-cost row is indistinguishable from a real call
    # that happened to be free, which is the same rule /profile/parse states.
    assert body["ai_metadata"] is None


def test_profile_extract_deadline_defaults_inside_the_callers_abort():
    """7 s sits just inside apps/api's 8 s AbortController, so the deadline fires HERE —
    named, logged, `error_code` set — rather than presenting to the caller as an
    unexplained socket close it cannot diagnose."""
    from app.config import Settings

    assert Settings().profile_extract_deadline_seconds < 8.0


def test_resume_generate_returns_the_cost_record(monkeypatch):
    """#745 — `router.run` always built this metadata; the route used to discard it.

    With no field on the contract there was no way for apps/api to record resume spend,
    so `SELECT ... WHERE task_type = 'resume_generation'` read as "no spend" rather than
    "not instrumented" — the identical root cause #738 fixed for STT.
    """
    body = client.post(
        "/resume/generate",
        json={"profile": {"canonical_role_id": "role_vmc_operator", "machines": ["mach_vmc"]}},
    ).json()

    meta = body["ai_metadata"]
    assert meta is not None, "a routed call must report what it cost"
    assert meta["task_type"] == "resume_generation"
    assert meta["ai_call_id"]
    # Mock run => real_call False => Rs 0. `real_call` follows the money, so a mocked
    # environment records nothing rather than the fiction TD81 wrote into staging.
    assert meta["real_call"] is False
    assert meta["estimated_cost_inr"] == 0.0


def test_resume_generate_reports_no_cost_when_the_gate_blocks():
    """The pseudonymize block returns BEFORE the provider, so there is nothing to record.

    The route still COMPLETES from the local deterministic resume — a worker never loses
    their resume over a gateway block — but an absent cost record is the honest output;
    a synthesized Rs 0 one would describe a call that never happened.
    """
    body = client.post(
        "/resume/generate",
        json={"profile": {"education_level": "my reference number is 12345678"}},
    ).json()

    assert body["is_mock"] is True
    assert body["resume_text"]  # the resume still exists
    assert body["ai_metadata"] is None


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


# --- Spoken-digit PII redaction at the ENDPOINT (#747 leg (a)) ---------------
# The unit tests cover the redactor. These cover the WIRING: that the response
# the backend receives — and therefore persists into voice_notes — is the
# redacted one, and that the count comes with it.


def test_voice_transcribe_reports_a_redaction_count_field():
    res = client.post(
        "/voice/transcribe",
        json={"voice_note_id": "vn1", "storage_path": "worker/sess/v1.ogg"},
    )
    assert res.status_code == 200
    # The mock transcript carries no phone number, so the honest answer is 0 — present
    # and zero, not absent. A missing field would make "not instrumented" look like
    # "nothing found", which is the exact confusion #738 was about.
    assert res.json()["spoken_digit_redactions"] == 0


def test_voice_transcribe_redacts_a_spoken_number_before_it_leaves_the_service(monkeypatch):
    # Drive a spoken phone number through the real handler by making the adapter return
    # one, which is the only thing the mock path cannot produce on its own.
    from app import stt as stt_module
    from app.routers import _shared

    spoken = "mera number nau aath saat chhe paanch char teen do ek shunya hai"

    async def fake_transcribe(**_kwargs):
        return stt_module.SttResult(
            transcript_text=spoken,
            confidence=0.9,
            language_code="hi-IN",
            is_mock=True,
        )

    monkeypatch.setattr(_shared.stt_adapter, "transcribe", fake_transcribe)
    res = client.post(
        "/voice/transcribe",
        json={
            "voice_note_id": "vn1",
            "storage_path": "worker/sess/v1.ogg",
            "translate_to_english": False,
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["spoken_digit_redactions"] == 1
    # The number is gone from what the backend will store.
    for word in ("nau", "aath", "saat", "chhe", "paanch", "shunya"):
        assert word not in body["transcript_text"]
    # ...and the rest of the answer is intact.
    assert body["transcript_text"].startswith("mera number ")
    assert body["transcript_text"].endswith(" hai")
