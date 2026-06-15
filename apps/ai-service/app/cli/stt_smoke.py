"""In-process terminal STT smoke test for the Sarvam speech-to-text path.

LOCAL DEV TOOL ONLY. Run with:  python -m app.cli.stt_smoke --file clip.wav

What it is / is NOT:
- It drives the PRODUCTION ``SttAdapter`` (``app.stt``) UNCHANGED. It does NOT
  touch the FastAPI ``/voice/transcribe`` endpoint, the BullMQ queue, the
  ``VoiceTranscriptionProcessor``, Postgres, or event emission. It is a separate
  flow purely for exercising the STT call from a terminal.
- Two modes:
    --file PATH          read a LOCAL audio file and transcribe it. The audio is
                         fed to the real ``_transcribe_real`` via an in-process
                         seam (``app.stt.download_object`` is swapped for a local
                         loader ONLY inside this process), so you can test the real
                         Sarvam call with just SARVAM_API_KEY — no Supabase needed.
    --storage-path KEY   the FULL real path: download the object from the private
                         Supabase bucket (service-role) and then call Sarvam. This
                         needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
  ``--mock`` forces the deterministic mock path (no provider call).

Gating is the SAME as production: a real call needs AI_ENABLE_REAL_CALLS=true AND
SARVAM_API_KEY; otherwise (or with ``--mock``) the mock transcript is returned.
The adapter still FAILS CLOSED — any provider/storage/oversize failure yields an
EMPTY transcript with ``error_code=stt_call_failed``, never a fabricated one.

PRIVACY: the service NEVER logs the transcript. This CLI prints it to STDOUT
because seeing it is the whole point of a manual smoke test; pass
``--hide-transcript`` to suppress it (prints only length + metadata).
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from unittest.mock import patch

from ..config import Settings
from ..stt import SttAdapter, SttResult


def _stt_status(settings: Settings, adapter: SttAdapter) -> str:
    """Up-front readiness banner: is the REAL Sarvam path on, and is storage wired?

    A silent all-mock run is the most confusing failure mode, so report the exact
    gate state before doing anything (mirrors the onboarding CLI's banner)."""
    reason = adapter.real_blocked_reason()
    lines = ["=== STT SMOKE — readiness ==="]
    if reason is None:
        lines.append("REAL Sarvam STT: ON")
    else:
        lines.append(f"REAL Sarvam STT: OFF ({reason})")
        lines.append(
            "  -> set AI_ENABLE_REAL_CALLS=true and SARVAM_API_KEY for a real call,"
        )
        lines.append("     or pass --mock to see the deterministic mock transcript.")
    lines.append(f"model:   {settings.sarvam_stt_model}")
    lines.append(
        "storage: "
        + (
            f"configured (bucket={settings.voice_notes_bucket})"
            if settings.storage_configured
            else "NOT configured (only --file mode works; --storage-path will fail closed)"
        )
    )
    return "\n".join(lines)


async def _transcribe(
    adapter: SttAdapter,
    *,
    storage_path: str,
    audio_bytes: bytes | None,
    duration_seconds: float | None,
    language_code: str | None,
    allow_real: bool,
) -> SttResult:
    """Run the real adapter. When ``audio_bytes`` is supplied (``--file`` mode) the
    module-level ``download_object`` is swapped for a local loader for THIS call
    only, so no Supabase round-trip happens; the rest of ``_transcribe_real``
    (Sarvam request, mapping, fail-closed) runs exactly as in production."""
    if audio_bytes is None:
        return await adapter.transcribe(
            storage_path=storage_path,
            duration_seconds=duration_seconds,
            language_code=language_code,
            real_call_allowed=allow_real,
        )

    async def _local_loader(_settings, _object_key, *, bucket):  # noqa: ANN001
        return audio_bytes

    # Patch the name in app.stt's namespace (where _transcribe_real looks it up).
    with patch("app.stt.download_object", new=_local_loader):
        return await adapter.transcribe(
            storage_path=storage_path,
            duration_seconds=duration_seconds,
            language_code=language_code,
            real_call_allowed=allow_real,
        )


def _format_result(result: SttResult, *, show_transcript: bool) -> str:
    lines = [
        "=== STT RESULT ===",
        f"is_mock:       {result.is_mock}",
        f"error_code:    {result.error_code}",
        f"confidence:    {result.confidence}",
        f"language_code: {result.language_code}",
        f"transcript_len:{len(result.transcript_text)}",
    ]
    if show_transcript:
        lines.append("transcript:")
        lines.append(result.transcript_text or "(empty)")
    return "\n".join(lines)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m app.cli.stt_smoke",
        description="Terminal smoke test for the Sarvam STT path (does not touch the API/queue).",
    )
    src = p.add_mutually_exclusive_group()
    src.add_argument("--file", help="local audio file to transcribe (bypasses Supabase)")
    src.add_argument(
        "--storage-path",
        help="object key in the voice-notes bucket (full real path: Supabase + Sarvam)",
    )
    p.add_argument(
        "--language",
        default=None,
        help="language hint, e.g. hi / en / hi-IN (default: auto-detect)",
    )
    p.add_argument(
        "--duration",
        type=float,
        default=None,
        help="audio duration in seconds (optional; >30 exercises the fail-closed sync guard)",
    )
    p.add_argument("--mock", action="store_true", help="force the mock path (no provider call)")
    p.add_argument(
        "--hide-transcript",
        action="store_true",
        help="do not print the transcript text (PII) — show only length + metadata",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    # Transcripts may be Hindi/Hinglish (UTF-8); keep stdout tolerant on legacy
    # Windows code pages so the tool never crashes on an un-encodable char.
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass

    args = _build_parser().parse_args(argv)

    if not args.mock and not args.file and not args.storage_path:
        print("error: provide --file or --storage-path (or --mock).", file=sys.stderr)
        return 2

    settings = Settings()
    adapter = SttAdapter(settings)
    print(_stt_status(settings, adapter))

    # A real attempt needs the gate on; don't silently downgrade to mock.
    reason = adapter.real_blocked_reason()
    if not args.mock and reason is not None:
        print(
            f"\nerror: real STT is blocked ({reason}). Re-run with --mock or set the env.",
            file=sys.stderr,
        )
        return 2

    audio_bytes: bytes | None = None
    storage_path: str
    if args.file:
        path = Path(args.file)
        if not path.is_file():
            print(f"error: file not found: {args.file}", file=sys.stderr)
            return 2
        audio_bytes = path.read_bytes()
        # Use the basename as the storage_path so the adapter infers the content
        # type from the extension (e.g. .wav -> audio/wav).
        storage_path = path.name
        print(f"\nsource:  local file {args.file} ({len(audio_bytes)} bytes)")
    elif args.storage_path:
        storage_path = args.storage_path
        print(f"\nsource:  storage object {args.storage_path}")
    else:
        # --mock with no source: use a dummy path just to show the mock output.
        storage_path = "mock.ogg"
        print("\nsource:  (none — mock only)")

    result = asyncio.run(
        _transcribe(
            adapter,
            storage_path=storage_path,
            audio_bytes=audio_bytes,
            duration_seconds=args.duration,
            language_code=args.language,
            allow_real=not args.mock,
        )
    )

    print("\n" + _format_result(result, show_transcript=not args.hide_transcript))

    # Exit non-zero on a real-path failure so the tool is scriptable; mock and
    # successful real runs exit 0.
    if not args.mock and result.error_code == "stt_call_failed":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
