"""STT smoke-CLI tests — drive ``app.cli.stt_smoke`` with no network.

Proves the CLI reuses the production adapter and stays correct end to end:
- the readiness banner reports ON/OFF from the same gate as production;
- ``--mock`` prints the deterministic mock transcript and exits 0;
- a real attempt with the gate OFF refuses (exit 2) rather than silently mocking;
- ``--file`` real mode feeds LOCAL bytes to the real ``_transcribe_real`` (Sarvam
  stubbed) and returns is_mock=False — without any Supabase round-trip;
- the >30s duration guard fails closed (exit 1) before any Sarvam call.
"""

from app import stt as stt_module
from app.cli import stt_smoke
from app.config import Settings
from app.stt import MOCK_TRANSCRIPT, SttAdapter
from app.translate import MOCK_ENGLISH


def _real_settings(**overrides) -> Settings:
    base = dict(
        ai_enable_real_calls=True,
        sarvam_api_key="k",
        supabase_url="https://x.supabase.co",
        supabase_service_role_key="svc",
    )
    base.update(overrides)
    return Settings(**base)


class _StubResponse:
    def __init__(self, status_code: int, payload: dict) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class _StubAsyncClient:
    # One stub serves BOTH Sarvam calls the CLI now makes by default (STT, which
    # POSTs files/data, then translate, which POSTs json). ``post`` takes **kwargs
    # so either call shape works; the URL picks which armed response to return.
    called = False
    translate_called = False
    stt_response = _StubResponse(200, {})
    translate_response = _StubResponse(200, {})

    def __init__(self, *_a, **_k) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_e):
        return False

    async def post(self, url, **_kwargs):
        if "translate" in url:
            _StubAsyncClient.translate_called = True
            return _StubAsyncClient.translate_response
        _StubAsyncClient.called = True
        return _StubAsyncClient.stt_response


def _arm_sarvam(payload: dict, status_code: int = 200) -> None:
    _StubAsyncClient.called = False
    _StubAsyncClient.stt_response = _StubResponse(status_code, payload)


def _arm_translate(payload: dict, status_code: int = 200) -> None:
    _StubAsyncClient.translate_called = False
    _StubAsyncClient.translate_response = _StubResponse(status_code, payload)


# --- banner ----------------------------------------------------------------

def test_status_off_when_gate_blocked():
    banner = stt_smoke._stt_status(
        Settings(ai_enable_real_calls=False), SttAdapter(Settings(ai_enable_real_calls=False))
    )
    assert "OFF" in banner


def test_status_on_and_reports_storage_when_configured():
    s = _real_settings()
    banner = stt_smoke._stt_status(s, SttAdapter(s))
    assert "REAL Sarvam STT: ON" in banner
    assert "configured" in banner
    assert "saarika:v2.5" in banner


# --- mock + gate-guard (conftest forces a mock-only env) --------------------

def test_mock_run_prints_mock_transcript_and_exits_zero(capsys):
    rc = stt_smoke.main(["--mock"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "is_mock:       True" in out
    assert MOCK_TRANSCRIPT in out


def test_mock_translate_prints_english_section_and_exits_zero(capsys):
    # --mock with no --file uses the dummy path + the (non-empty) mock transcript,
    # so translation runs in mock too. conftest forces mock-only -> deterministic.
    rc = stt_smoke.main(["--mock", "--translate"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "=== TRANSLATION (English) ===" in out
    assert "is_mock:       True" in out
    assert MOCK_ENGLISH in out


def test_real_attempt_with_gate_off_refuses(tmp_path, capsys):
    f = tmp_path / "clip.wav"
    f.write_bytes(b"RIFFfakeaudio")
    rc = stt_smoke.main(["--file", str(f)])  # no --mock; conftest gate is OFF
    err = capsys.readouterr().err
    assert rc == 2
    assert "blocked" in err


# --- real --file path (gate forced ON via Settings override, Sarvam stubbed) -

def test_file_mode_real_success(tmp_path, monkeypatch, capsys):
    # Default flow: transcribe (real, stubbed) THEN translate (real, stubbed).
    # Patching stt_module.httpx patches the shared httpx module, so translate's
    # ``httpx.AsyncClient`` is the same stub.
    monkeypatch.setattr(stt_smoke, "Settings", lambda: _real_settings())
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _arm_sarvam(
        {"transcript": "main vmc operator", "language_code": "hi-IN", "language_probability": 0.96}
    )
    _arm_translate({"translated_text": "I am a VMC operator", "source_language_code": "hi-IN"})

    f = tmp_path / "clip.wav"
    f.write_bytes(b"RIFFfakeaudio")
    rc = stt_smoke.main(["--file", str(f), "--language", "hi"])
    out = capsys.readouterr().out

    assert rc == 0
    assert "is_mock:       False" in out
    assert "main vmc operator" in out
    assert _StubAsyncClient.called is True
    # Translation runs by default and prints the English section.
    assert "=== TRANSLATION (English) ===" in out
    assert "I am a VMC operator" in out
    assert _StubAsyncClient.translate_called is True


def test_file_mode_no_translate_skips_translation(tmp_path, monkeypatch, capsys):
    # --no-translate keeps it a pure STT run: no translate call, no English section.
    monkeypatch.setattr(stt_smoke, "Settings", lambda: _real_settings())
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _arm_sarvam({"transcript": "main vmc operator", "language_code": "hi-IN"})
    _arm_translate({"translated_text": "unused"})  # resets translate_called -> False

    f = tmp_path / "clip.wav"
    f.write_bytes(b"RIFFfakeaudio")
    rc = stt_smoke.main(["--file", str(f), "--language", "hi", "--no-translate"])
    out = capsys.readouterr().out

    assert rc == 0
    assert "main vmc operator" in out
    assert "=== TRANSLATION (English) ===" not in out
    assert _StubAsyncClient.translate_called is False


def test_file_mode_over_duration_fails_closed(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(stt_smoke, "Settings", lambda: _real_settings())
    monkeypatch.setattr(stt_module.httpx, "AsyncClient", _StubAsyncClient)
    _arm_sarvam({"transcript": "should-not-be-used"})

    f = tmp_path / "clip.wav"
    f.write_bytes(b"RIFFfakeaudio")
    rc = stt_smoke.main(["--file", str(f), "--duration", "45"])
    out = capsys.readouterr().out

    assert rc == 1
    assert "error_code:    stt_call_failed" in out
    assert _StubAsyncClient.called is False  # guard fired before any Sarvam call
