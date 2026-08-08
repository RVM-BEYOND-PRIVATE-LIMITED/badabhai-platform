"""Batch-render the reply closure to audio — the voice form's build step.

LOCAL/OPERATOR TOOL ONLY. Run with:

    python -m app.cli.tts_render --out ./tts-clips            # dry run, spends nothing
    python -m app.cli.tts_render --out ./tts-clips --apply    # renders

WHY A BATCH RENDER AND NOT A REQUEST. Every string this writes is STATIC, REVIEWED content: pack
copy plus a closed set of orchestrator constants. Rendering it once makes playback instant, work
offline, and cost nothing per question — the alternative is a TTS round-trip per question on a 2G
connection in a noisy yard, which is the experience this feature exists to avoid. There is
deliberately NO FastAPI route to the adapter (a boot test enforces it), so this CLI is the only way
text becomes speech and no request body can ever reach the provider.

DRY RUN BY DEFAULT, and that is not politeness. Rendering is the moment operator money is spent,
and the corpus is 434 clips. Every seeder in this repo is dry-run by default for the same reason,
and the one time that flag was omitted in CI two steps went green while doing nothing.

CONTENT-ADDRESSED OUTPUT. Each clip is written as ``<clip_id>.<codec>`` where ``clip_id`` is
``sha256(normalize(text))[:16]`` computed by :mod:`app.reply_closure` — the SAME function, over the
same normalization, that the TypeScript engine uses to name what it is serving. Re-running after a
corpus change therefore re-renders only what changed: existing files are skipped, so a wording fix
to one question costs one clip, not 434.

WHAT IT REFUSES. The adapter rejects any text carrying a ``{{placeholder}}``, because a shared
audio cache plus post-emit interpolation is exactly how one worker's name would be spoken to every
other worker. That refusal is counted and reported here rather than swallowed.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from ..config import Settings
from ..reply_closure import ReplyClip, ReplyClosureError, load_reply_closure
from ..tts import TtsAdapter


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="tts_render",
        description="Render the reply closure to per-clip audio files (dry run by default).",
    )
    parser.add_argument("--out", required=True, help="Directory to write <clip_id>.<codec> into.")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually synthesize. WITHOUT this the run only reports what it WOULD render.",
    )
    parser.add_argument(
        "--language-code",
        default=None,
        help="Override the configured TTS language code (e.g. hi-IN, en-IN).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Render at most N clips. 0 = all. Use for a costed pilot before the full run.",
    )
    parser.add_argument(
        "--producer",
        default=None,
        help="Render only one producer (prompt|retry|why|clarify|constant).",
    )
    return parser.parse_args(argv)


def _select(clips: list[ReplyClip], producer: str | None, limit: int) -> list[ReplyClip]:
    chosen = [c for c in clips if producer is None or c.producer == producer]
    # A CAP MUST ANNOUNCE ITSELF. Silently truncating reads as "the whole catalogue rendered"
    # when it did not, and the missing clips only surface as silence in a worker's ear.
    if limit and limit < len(chosen):
        print(f"NOTE: --limit {limit} drops {len(chosen) - limit} of {len(chosen)} selected clips.")
        chosen = chosen[:limit]
    return chosen


async def _run(args: argparse.Namespace) -> int:
    settings = Settings()
    adapter = TtsAdapter(settings)

    try:
        clips = load_reply_closure()
    except ReplyClosureError as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 2

    selected = _select(clips, args.producer, args.limit)
    out_dir = Path(args.out)
    codec = settings.sarvam_tts_output_codec

    blocked = adapter.real_blocked_reason()
    projected = sum(adapter.projected_inr(c.text) for c in selected)

    print(f"manifest      {len(clips)} clips ({len(selected)} selected)")
    print(f"out           {out_dir}")
    print(f"real calls    {'BLOCKED: ' + blocked if blocked else 'ENABLED'}")
    print(f"projected     Rs {projected:.2f}")
    print(f"mode          {'APPLY' if args.apply else 'DRY RUN (nothing is spent)'}")
    print()

    if not args.apply:
        # Report the skip breakdown a real run would produce, so the operator can see what the
        # spend buys before committing to it.
        existing = (
            sum(1 for c in selected if (out_dir / f"{c.id}.{codec}").is_file())
            if out_dir.is_dir()
            else 0
        )
        print(f"would render  {len(selected) - existing}  (skipping {existing} already on disk)")
        print("re-run with --apply to synthesize.")
        return 0

    # REFUSE TO "RENDER" IN MOCK POSTURE, LOUDLY.
    #
    # The adapter's mock path returns EMPTY audio on purpose — a placeholder tone played to a
    # worker who cannot read the screen looks like the question was asked when it was not. So an
    # `--apply` run with real calls blocked would walk the whole catalogue, write nothing, and
    # have to call each clip either a failure (wrong: nothing was attempted) or a success (worse:
    # a green tick over an empty directory). Neither is true, and the second is exactly the CI
    # seeder incident this repo already learned from — a step that passes while doing nothing is
    # worse than no step, because the green tick is the thing you would trust.
    #
    # Mock is a POSTURE, not a failure. The honest response to "render, but you are not allowed
    # to call anyone" is to stop and say so.
    if blocked:
        print(f"REFUSING to render: real TTS is blocked ({blocked}).", file=sys.stderr)
        print(
            "Arm it (AI_ENABLE_REAL_CALLS, tts_synthesis in AI_REAL_CALL_TASKS, SARVAM_API_KEY) "
            "or drop --apply to price the run.",
            file=sys.stderr,
        )
        return 2

    out_dir.mkdir(parents=True, exist_ok=True)
    rendered = skipped = failed = 0
    failures: dict[str, int] = {}

    for clip in selected:
        target = out_dir / f"{clip.id}.{codec}"
        if target.is_file():
            skipped += 1
            continue

        result = await adapter.synthesize(text=clip.text, language_code=args.language_code)
        if result.error_code or not result.audio:
            failed += 1
            code = result.error_code or "tts_empty_audio"
            failures[code] = failures.get(code, 0) + 1
            # NEVER the text alongside the failure: a placeholder refusal means the string may
            # embed PII, which is the entire reason that refusal exists.
            print(f"  FAIL {clip.id} ({clip.producer}): {code}")
            continue

        target.write_bytes(result.audio)
        rendered += 1

    print()
    print(f"rendered      {rendered}")
    print(f"skipped       {skipped} (already on disk)")
    print(f"failed        {failed}" + (f"  {failures}" if failures else ""))

    # A PARTIAL RENDER IS A FAILURE. Ship a catalogue with holes and the worker hears silence at
    # exactly the questions that failed, with nothing in the app to say why.
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    return asyncio.run(_run(_parse_args(argv)))


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    raise SystemExit(main())
