"""Real Sarvam STT path tests.

NO network and NO Supabase: ``app.stt.download_object`` is monkeypatched to
return canned bytes (or raise), and ``httpx.AsyncClient`` is stubbed to capture
the Sarvam POST and return a canned response. These prove:

- success (auto-detect) maps transcript + language_probability -> SttResult;
- a specific language maps to ``xx-IN`` and uses the unreported-confidence default
  when ``language_probability`` is null;
- provider errors, malformed responses, storage failures and the >120s platform
  cap all FAIL CLOSED to an empty, never-fabricated transcript;
- the platform-cap guard fires before any storage OR Sarvam call;
- D-2: a 30-120s note is CHUNKED into <30s sync calls and concatenated in
  segment order; any chunk failure fails the WHOLE note closed;
- D-2 spend: chunk calls reserve/reconcile on the TD27 ledger per ``worker_ref``.

The ``transcribe`` wrapper (caught exception -> empty + ``stt_call_failed``) is the
unit under test for the failure cases — ``_transcribe_real`` itself raises.
"""

import asyncio

import pytest
from audio_fixtures import build_m4a

from app import stt as stt_module
from app.ai import cost_tracker
from app.config import Settings
from app.stt import MOCK_TRANSCRIPT, SttAdapter, _to_sarvam_language


def _run(coro):
    return asyncio.run(coro)


def _real_settings(**overrides) -> Settings:
    base = dict(
        ai_enable_real_calls=True,
        sarvam_api_key="k",
        supabase_url="https://x.supabase.co",
        supabase_service_role_key="svc",
    )
    base.update(overrides)
    return Settings(**base)


@pytest.fixture(autouse=True)
def _reset_ledger():
    """Pin a fresh IN-PROCESS ledger per test (the real STT path now reserves
    chunk spend on it). Ignores any ambient REDIS_URL/.env, which would build a
    Redis backend that fails closed against an unreachable server."""
    cost_tracker._ledger = cost_tracker.SpendLedger(Settings(_env_file=None, redis_url=None))
    yield
    cost_tracker._ledger = None


class _StubResponse:
    def __init__(self, status_code: int, payload: dict) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class _StubAsyncClient:
    """Captures the Sarvam POST and returns a canned response — no network."""

    called: bool = False
    last_url: str | None = None
    last_headers: dict | None = None
    last_files: dict | None = None
    last_data: dict | None = None
    response: _StubResponse = _StubResponse(200, {})

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def post(self, url, *, headers, files, data):
        _StubAsyncClient.called = True
        _StubAsyncClient.last_url = url
        _StubAsyncClient.last_headers = headers
        _StubAsyncClient.last_files = files
        _StubAsyncClient.last_data = data
        return _StubAsyncClient.response


def _reset_client(payload: dict, status_code: int = 200) -> None:
    _StubAsyncClient.called = False
    _StubAsyncClient.last_url = None
    _StubAsyncClient.last_headers = None
    _StubAsyncClient.last_files = None
    _StubAsyncClient.last_data = None
    _StubAsyncClient.response = _StubResponse(status_code, payload)


def _patch_storage(monkeypatch, *, returns: bytes | None = None, raises: Exception | None = None):
    calls = {"count": 0}

    async def _fake_download(settings, object_key, *, bucket):
        calls["count"] += 1
        if raises is not None:
            raise raises
        return returns if returns is not None else b"audio"

    monkeypatch.setattr(stt_module, "download_object", _fake_download)
    return calls


class _ChunkRecordingClient:
    """Per-chunk Sarvam stub: records each upload and answers from a scripted
    list (a str -> transcript, an Exception -> raise), keyed to arrival order."""

    uploads: list[tuple[str, bytes, str]] = []
    script: list = []
    _next: int = 0

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def post(self, url, *, headers, files, data):
        filename, payload, content_type = files["file"]
        _ChunkRecordingClient.uploads.append((filename, payload, content_type))
        i = _ChunkRecordingClient._next
        _ChunkRecordingClient._next += 1
        entry = _ChunkRecordingClient.script[i]
        if isinstance(entry, Exception):
            raise entry
        # Yield control so chunk calls genuinely interleave under the semaphore.
        await asyncio.sleep(0)
        return _StubResponse(
            200, {"transcript": entry, "language_code": "hi-IN", "language_probability": 0.9}
        )


def _arm_chunks(monkeypatch, script: list) -> None:
    _ChunkRecordingClient.uploads = []
    _ChunkRecordingClient.script = script
    _ChunkRecordingClient._next = 0
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _ChunkRecordingClient)


# --- language mapping (pure unit) ------------------------------------------

def test_to_sarvam_language_mapping():
    assert _to_sarvam_language(None) == "unknown"
    assert _to_sarvam_language("") == "unknown"
    assert _to_sarvam_language("hi") == "hi-IN"
    assert _to_sarvam_language("en") == "en-IN"
    assert _to_sarvam_language("hi-IN") == "hi-IN"
    assert _to_sarvam_language("zz") == "unknown"


# --- success paths ---------------------------------------------------------

def test_success_auto_detect_maps_transcript_and_probability(monkeypatch):
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client(
        {"transcript": "main vmc operator", "language_code": "hi-IN", "language_probability": 0.97}
    )
    _patch_storage(monkeypatch, returns=b"audio")

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="worker/sess/v1.ogg"))

    assert result.is_mock is False
    assert result.transcript_text == "main vmc operator"
    assert result.confidence == 0.97
    assert result.error_code is None
    assert result.language_code == "hi-IN"


def test_success_specific_language_null_probability_uses_default(monkeypatch):
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"transcript": "x", "language_code": "hi-IN", "language_probability": None})
    _patch_storage(monkeypatch, returns=b"audio")

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="worker/sess/v1.wav", language_code="hi"))

    assert result.is_mock is False
    assert result.transcript_text == "x"
    assert result.confidence == 1.0  # unreported -> _REAL_CONFIDENCE_WHEN_UNREPORTED
    assert result.error_code is None
    # Mapping verified on the wire: bare "hi" -> "hi-IN"; model is config default.
    assert _StubAsyncClient.last_data["language_code"] == "hi-IN"
    assert _StubAsyncClient.last_data["model"] == "saarika:v2.5"


def test_empty_transcript_string_is_valid_not_mock(monkeypatch):
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"transcript": "", "language_code": "hi-IN", "language_probability": 0.5})
    _patch_storage(monkeypatch, returns=b"audio")

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="worker/sess/v1.ogg"))

    assert result.is_mock is False
    assert result.transcript_text == ""
    assert result.error_code is None


def test_under_30s_note_still_uploads_the_whole_object_in_one_call(monkeypatch):
    # The <=30s fast path is UNCHANGED by D-2: one call, original bytes, no split.
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"transcript": "short note", "language_code": "hi-IN"})
    _patch_storage(monkeypatch, returns=b"whole-object-bytes")

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="w/x.m4a", duration_seconds=29.0))

    assert result.transcript_text == "short note"
    assert result.chunk_count == 1
    assert _StubAsyncClient.last_files["file"][1] == b"whole-object-bytes"


# --- failure paths (must fail closed to empty) -----------------------------

def test_provider_error_fails_closed_to_empty(monkeypatch):
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client(
        {"error": {"code": "invalid_api_key_error", "message": "..."}}, status_code=403
    )
    _patch_storage(monkeypatch, returns=b"audio")

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="worker/sess/v1.ogg"))

    assert result.transcript_text == ""
    assert result.is_mock is True
    assert result.error_code == "stt_call_failed"


def test_malformed_response_missing_transcript_fails_closed(monkeypatch):
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"request_id": "x"})
    _patch_storage(monkeypatch, returns=b"audio")

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="worker/sess/v1.ogg"))

    assert result.transcript_text == ""
    assert result.is_mock is True
    assert result.error_code == "stt_call_failed"


def test_storage_failure_fails_closed_and_skips_sarvam(monkeypatch):
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"transcript": "should-not-be-used"})
    _patch_storage(
        monkeypatch, raises=RuntimeError("voice audio fetch failed with status 404")
    )

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="worker/sess/v1.ogg"))

    assert result.transcript_text == ""
    assert result.is_mock is True
    assert result.error_code == "stt_call_failed"
    assert _StubAsyncClient.called is False  # Sarvam never reached


def test_real_path_unconfigured_storage_fails_to_empty_not_mock(monkeypatch):
    # Real STT enabled (flag + sarvam key) but storage creds ABSENT. This must
    # fail CLOSED to an empty transcript — NOT silently downgrade to the mock CNC
    # transcript (which would be fabrication on the real path). Storage is NOT
    # patched here, so the real download_object runs and raises "not configured"
    # before any network; Sarvam must never be reached.
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"transcript": "should-not-be-used"})

    adapter = SttAdapter(
        _real_settings(supabase_url=None, supabase_service_role_key=None)
    )
    result = _run(adapter.transcribe(storage_path="worker/sess/v1.ogg"))

    assert result.transcript_text == ""
    assert result.transcript_text != MOCK_TRANSCRIPT  # never the mock on the real path
    assert result.is_mock is True
    assert result.error_code == "stt_call_failed"
    assert _StubAsyncClient.called is False  # Sarvam never reached


# --- D-2: the platform cap (not the 30s sync limit) is the rejection line ---

def test_duration_over_platform_cap_fails_closed_before_storage_and_sarvam(monkeypatch):
    # >120s (MAX_VOICE_NOTE_SECONDS) is rejected before any storage/provider
    # spend. Upload validation makes this unreachable in practice.
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"transcript": "should-not-be-used"})
    storage_calls = _patch_storage(monkeypatch, returns=b"audio")

    adapter = SttAdapter(_real_settings())
    result = _run(
        adapter.transcribe(storage_path="worker/sess/v1.m4a", duration_seconds=121)
    )

    assert result.transcript_text == ""
    assert result.is_mock is True
    assert result.error_code == "stt_call_failed"
    assert storage_calls["count"] == 0  # storage never reached
    assert _StubAsyncClient.called is False  # Sarvam never reached


def test_the_batch_stt_not_implemented_raise_is_gone(monkeypatch):
    # D-2 regression pin: a 45s note used to raise "batch STT not implemented"
    # and fail closed. It must now transcribe via the chunked path.
    audio, _frames = build_m4a(704)  # 45.056s
    _patch_storage(monkeypatch, returns=audio)
    _arm_chunks(monkeypatch, ["pehla hissa", "doosra hissa"])

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="voice-notes/w/x.m4a", duration_seconds=45))

    assert result.error_code is None
    assert result.is_mock is False
    assert result.transcript_text == "pehla hissa doosra hissa"


# --- D-2: chunked real path -------------------------------------------------

def test_45s_note_chunks_into_two_sync_calls_and_concatenates_in_order(monkeypatch):
    audio, _frames = build_m4a(704)  # 45.056s
    _patch_storage(monkeypatch, returns=audio)
    _arm_chunks(monkeypatch, ["main vmc operator hoon", "char saal ka experience"])

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="voice-notes/w/x.m4a", duration_seconds=45))

    assert result.is_mock is False
    assert result.chunk_count == 2
    assert len(_ChunkRecordingClient.uploads) == 2
    assert result.transcript_text == "main vmc operator hoon char saal ka experience"
    # Every chunk uploaded as ADTS aac (a content type Sarvam accepts), in order.
    assert [u[0] for u in _ChunkRecordingClient.uploads] == ["chunk_00.aac", "chunk_01.aac"]
    assert {u[2] for u in _ChunkRecordingClient.uploads} == {"audio/aac"}
    for _name, payload, _ct in _ChunkRecordingClient.uploads:
        assert payload[:2] == b"\xff\xf1"  # real ADTS frames, not the raw m4a


def test_120s_note_chunks_into_five_calls_and_returns_the_full_transcript(monkeypatch):
    # The D-2 headline: MAX_VOICE_NOTE_SECONDS transcribes end to end.
    audio, _frames = build_m4a(1875)  # 120.0s
    _patch_storage(monkeypatch, returns=audio)
    _arm_chunks(monkeypatch, ["ek", "do", "teen", "chaar", "paanch"])

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="voice-notes/w/x.m4a", duration_seconds=120))

    assert result.is_mock is False
    assert result.error_code is None
    assert result.chunk_count == 5
    assert result.transcript_text == "ek do teen chaar paanch"


def test_concatenation_follows_segment_order_not_completion_order(monkeypatch):
    # Chunks run with bounded parallelism; the transcript order MUST come from
    # the segment index. Earlier chunks resolve LAST here (descending sleeps).
    audio, _frames = build_m4a(1875)
    _patch_storage(monkeypatch, returns=audio)

    class _OutOfOrderClient(_ChunkRecordingClient):
        async def post(self, url, *, headers, files, data):
            i = _ChunkRecordingClient._next
            _ChunkRecordingClient._next += 1
            # Earlier chunks sleep LONGER -> they complete last.
            await asyncio.sleep((10 - i) * 0.01)
            return _StubResponse(
                200,
                {"transcript": f"seg{i}", "language_code": "hi-IN", "language_probability": 0.9},
            )

    _ChunkRecordingClient.uploads = []
    _ChunkRecordingClient._next = 0
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _OutOfOrderClient)

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="voice-notes/w/x.m4a", duration_seconds=120))

    assert result.transcript_text == "seg0 seg1 seg2 seg3 seg4"


def test_chunk_confidence_is_the_weakest_chunk(monkeypatch):
    audio, _frames = build_m4a(704)
    _patch_storage(monkeypatch, returns=audio)

    class _VaryingConfidence(_ChunkRecordingClient):
        async def post(self, url, *, headers, files, data):
            i = _ChunkRecordingClient._next
            _ChunkRecordingClient._next += 1
            return _StubResponse(
                200,
                {
                    "transcript": f"seg{i}",
                    "language_code": "hi-IN",
                    "language_probability": [0.95, 0.42][i],
                },
            )

    _ChunkRecordingClient.uploads = []
    _ChunkRecordingClient._next = 0
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _VaryingConfidence)

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="w/x.m4a", duration_seconds=45))

    # Conservative: the whole note is only as trustworthy as its worst chunk.
    assert result.confidence == 0.42


def test_one_failing_chunk_fails_the_whole_note_closed(monkeypatch):
    # A transcript with a silent hole is a fabrication risk — never return a
    # partial note as if it were complete.
    audio, _frames = build_m4a(704)
    _patch_storage(monkeypatch, returns=audio)
    _arm_chunks(monkeypatch, ["good half", RuntimeError("provider exploded")])

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="w/x.m4a", duration_seconds=45))

    assert result.transcript_text == ""  # not "good half"
    assert result.is_mock is True
    assert result.error_code == "stt_call_failed"


def test_unsplittable_container_fails_closed_without_calling_sarvam(monkeypatch):
    # A 45s .ogg cannot be split without a decoder -> fail closed, no spend.
    _patch_storage(monkeypatch, returns=b"OggS-not-really")
    _arm_chunks(monkeypatch, ["should-not-be-used"])

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="w/x.ogg", duration_seconds=45))

    assert result.transcript_text == ""
    assert result.is_mock is True
    assert result.error_code == "stt_call_failed"
    assert _ChunkRecordingClient.uploads == []  # Sarvam never reached


# --- D-2 privacy: chunk boundaries must not weaken the downstream gate ------

def test_chunking_returns_ONE_full_transcript_so_the_gate_never_sees_a_chunk(monkeypatch):
    # The adapter concatenates INSIDE _transcribe_chunked; a chunk never escapes.
    # So /profile/extract's pseudonymize (which runs FIRST on the whole string,
    # main.py "1. Pseudonymize FIRST") always gates the FULL transcript. This
    # test pins that the adapter's public surface is one complete string.
    audio, _frames = build_m4a(704)
    _patch_storage(monkeypatch, returns=audio)
    _arm_chunks(monkeypatch, ["mera number 98765", "43210 hai"])

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="w/x.m4a", duration_seconds=45))

    assert result.transcript_text == "mera number 98765 43210 hai"


def test_a_phone_split_across_a_chunk_boundary_is_still_masked_downstream(monkeypatch):
    # THE chunking privacy risk: concatenation inserts a space, which could split
    # a digit run (a 10-digit phone -> "98765 43210"). That must NOT let a number
    # through. It does not: _PHONE_RE matches across whitespace/dashes
    # ([\d\s\-]{7,}), so the joined transcript is still masked before any LLM.
    from app.pseudonymize import pseudonymize

    audio, _frames = build_m4a(704)
    _patch_storage(monkeypatch, returns=audio)
    _arm_chunks(monkeypatch, ["mera number 98765", "43210 hai"])

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="w/x.m4a", duration_seconds=45))

    gated = pseudonymize(result.transcript_text)
    assert "98765" not in gated.text
    assert "43210" not in gated.text
    assert "[PHONE_1]" in gated.text

    # And the unsplit transcription of the same words masks identically — the
    # boundary changes nothing the gate cares about.
    assert pseudonymize("mera number 9876543210 hai").text == gated.text


def test_an_aadhaar_split_across_a_chunk_boundary_is_still_masked_downstream(monkeypatch):
    from app.pseudonymize import pseudonymize

    audio, _frames = build_m4a(704)
    _patch_storage(monkeypatch, returns=audio)
    _arm_chunks(monkeypatch, ["aadhaar 1234 5678", "9012 hai"])

    adapter = SttAdapter(_real_settings())
    result = _run(adapter.transcribe(storage_path="w/x.m4a", duration_seconds=45))

    gated = pseudonymize(result.transcript_text)
    assert "1234" not in gated.text and "9012" not in gated.text
    assert "[ID_1]" in gated.text


# --- D-2 spend: per-chunk ledger attribution (TD68 pattern) -----------------

def _snapshot(user_ref: str | None = None) -> dict:
    return _run(cost_tracker.get_ledger().snapshot(Settings(_env_file=None), user_ref=user_ref))


def test_chunked_note_records_spend_per_chunk_against_the_worker_ref(monkeypatch):
    audio, _frames = build_m4a(1875)  # 120s -> 5 chunks
    _patch_storage(monkeypatch, returns=audio)
    _arm_chunks(monkeypatch, ["ek", "do", "teen", "chaar", "paanch"])

    settings = _real_settings(sarvam_stt_cost_inr_per_chunk=0.25)
    adapter = SttAdapter(settings)
    result = _run(
        adapter.transcribe(
            storage_path="w/x.m4a", duration_seconds=120, worker_ref="worker-abc"
        )
    )

    assert result.chunk_count == 5
    # 5 chunks x Rs 0.25 = Rs 1.25 — reserved up-front, reconciled to actual.
    snap = _snapshot("worker-abc")
    assert snap["user_daily_spend_inr"] == 1.25
    assert snap["daily_spend_inr"] == 1.25


def test_single_call_note_records_one_chunk_of_spend(monkeypatch):
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"transcript": "short", "language_code": "hi-IN"})
    _patch_storage(monkeypatch, returns=b"audio")

    adapter = SttAdapter(_real_settings(sarvam_stt_cost_inr_per_chunk=0.25))
    _run(adapter.transcribe(storage_path="w/x.m4a", duration_seconds=20, worker_ref="w-1"))

    assert _snapshot("w-1")["user_daily_spend_inr"] == 0.25


def test_four_full_length_notes_fit_the_per_user_daily_cap_then_the_fifth_blocks(monkeypatch):
    # The documented ceiling math: Rs 6/user/day (ai_max_user_daily_cost_inr) /
    # Rs 1.25 per 120s note = 4 full-length notes/user/day, the 5th is refused.
    audio, _frames = build_m4a(1875)
    _patch_storage(monkeypatch, returns=audio)

    settings = _real_settings(sarvam_stt_cost_inr_per_chunk=0.25, ai_max_user_daily_cost_inr=6.0)
    adapter = SttAdapter(settings)

    for _ in range(4):
        _arm_chunks(monkeypatch, ["ek", "do", "teen", "chaar", "paanch"])
        result = _run(
            adapter.transcribe(storage_path="w/x.m4a", duration_seconds=120, worker_ref="w-2")
        )
        assert result.error_code is None

    assert _snapshot("w-2")["user_daily_spend_inr"] == 5.0

    # The 5th note would need Rs 1.25 more (6.25 > 6.0) -> blocked BEFORE any call.
    _arm_chunks(monkeypatch, ["should-not-be-used"] * 5)
    blocked = _run(
        adapter.transcribe(storage_path="w/x.m4a", duration_seconds=120, worker_ref="w-2")
    )
    assert blocked.error_code == "stt_budget_blocked"
    assert blocked.transcript_text == ""  # empty, NEVER the mock, on the real path
    assert blocked.transcript_text != MOCK_TRANSCRIPT
    assert _ChunkRecordingClient.uploads == []  # no provider call, no spend


def test_ledger_block_returns_empty_and_never_reaches_the_provider(monkeypatch):
    audio, _frames = build_m4a(1875)
    _patch_storage(monkeypatch, returns=audio)
    _arm_chunks(monkeypatch, ["should-not-be-used"] * 5)

    # Daily cap far below one note's projected cost -> reserve refuses.
    settings = _real_settings(sarvam_stt_cost_inr_per_chunk=0.25, ai_max_daily_cost_inr=0.1)
    result = _run(
        SttAdapter(settings).transcribe(
            storage_path="w/x.m4a", duration_seconds=120, worker_ref="w-3"
        )
    )

    assert result.error_code == "stt_budget_blocked"
    assert result.transcript_text == ""
    assert _ChunkRecordingClient.uploads == []


def test_failed_note_refunds_the_reservation_of_uncalled_chunks(monkeypatch):
    # Chunk 0 succeeds (billed), chunk 1 raises. The note fails closed, but the
    # ledger must keep ONLY the spend that actually reached the provider — the
    # reservation for the rest is refunded (no leak, no over-charge).
    audio, _frames = build_m4a(704)  # 45s -> 2 chunks, Rs 0.50 reserved
    _patch_storage(monkeypatch, returns=audio)
    _arm_chunks(monkeypatch, ["billed half", RuntimeError("boom")])

    adapter = SttAdapter(_real_settings(sarvam_stt_cost_inr_per_chunk=0.25))
    result = _run(
        adapter.transcribe(storage_path="w/x.m4a", duration_seconds=45, worker_ref="w-4")
    )

    assert result.error_code == "stt_call_failed"
    # Exactly ONE chunk reached the provider -> Rs 0.25 kept, Rs 0.25 refunded.
    assert _snapshot("w-4")["user_daily_spend_inr"] == 0.25


def test_storage_failure_leaks_no_reservation(monkeypatch):
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _reset_client({"transcript": "unused"})
    _patch_storage(monkeypatch, raises=RuntimeError("voice audio fetch failed with status 404"))

    adapter = SttAdapter(_real_settings(sarvam_stt_cost_inr_per_chunk=0.25))
    _run(adapter.transcribe(storage_path="w/x.m4a", duration_seconds=120, worker_ref="w-5"))

    # Nothing reached the provider -> the whole reservation is refunded.
    assert _snapshot("w-5")["user_daily_spend_inr"] == 0.0
    assert _snapshot()["daily_spend_inr"] == 0.0


def test_per_chunk_rate_above_the_per_call_ceiling_blocks(monkeypatch):
    # TD68 belt+suspenders: one chunk = one provider call, so a rate above
    # AI_MAX_CALL_COST_INR is a misconfiguration that must refuse, not spend.
    audio, _frames = build_m4a(704)
    _patch_storage(monkeypatch, returns=audio)
    _arm_chunks(monkeypatch, ["should-not-be-used"] * 2)

    settings = _real_settings(sarvam_stt_cost_inr_per_chunk=11.0, ai_max_call_cost_inr=10.0)
    result = _run(
        SttAdapter(settings).transcribe(storage_path="w/x.m4a", duration_seconds=45)
    )

    assert result.error_code == "stt_budget_blocked"
    assert result.transcript_text == ""
    assert _ChunkRecordingClient.uploads == []


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
