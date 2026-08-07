"""In-process terminal TTS smoke test for the Sarvam text-to-speech path.

LOCAL DEV TOOL ONLY. Run with:  python -m app.cli.tts_smoke --matrix --out ./tts-probe

WHY THIS EXISTS, AND WHY IT RUNS BEFORE ANY UI. Two questions decide whether the
voice profiling form works at all, and neither is answerable from the repo:

1. **Does bulbul speak ROMANIZED Hinglish?** Every one of the 466 question-pack
   items is ASCII — zero Devanagari codepoints — while the packs declare
   ``locale: hi-IN``. If the model applies English grapheme-to-phoneme rules to
   "Aap kaunsa kaam karte hain?", the result is confident nonsense in an English
   accent. For a worker who cannot read the screen to catch it, that is WORSE than
   silence, and the fix (a reviewed transliteration sidecar) is a whole extra
   artifact with its own drift and review surface. Better to know for ~Rs 450.
2. **What is the real billing unit?** The rate card says per character, rounded up
   PER REQUEST. A 40-character question billed as a full request is a completely
   different unit-economics story from 40 characters of a 10,000-character block,
   and it is the difference between "render the catalogue once" being obviously
   right and merely probably right.

``--matrix`` answers both in one run: it sweeps script (roman vs Devanagari) against
language code, so the two audio sets can be listened to back to back by a native
speaker. Listen to them. Do not grade this from a log line.

What it is / is NOT:
- It drives the PRODUCTION ``TtsAdapter`` (``app.tts``) UNCHANGED — same gate chain,
  same spend ledger, same fail-closed behaviour. It does NOT touch FastAPI, the
  queue, Postgres, or event emission.
- It writes audio files to ``--out`` and prints a table. Nothing is uploaded.

Gating is the SAME as production: a real call needs AI_ENABLE_REAL_CALLS=true AND
GEMINI_FLASH_API_KEY (the real-calls master key) AND ``tts_synthesis`` in
AI_REAL_CALL_TASKS (an empty allowlist blocks every task — fail-closed) AND
SARVAM_API_KEY. ``tts_synthesis`` is its OWN allowlist key, so TTS can be armed
without arming STT — which is the point of doing the outbound-only leg first.

PRIVACY: this tool synthesizes AUTHORED text only. The adapter refuses any string
carrying a ``{{placeholder}}``, because a shared audio cache plus post-emit
interpolation is how one worker's name would be spoken to every other worker.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from ..config import Settings
from ..tts import TtsAdapter, TtsResult

# Five probes, each chosen for a reason rather than for coverage.
#
# The first four are REAL pack copy (qp_universal), so the test measures the corpus
# that will actually ship rather than a curated sentence. The Devanagari column is a
# hand transliteration of the same four, so roman-vs-Devanagari is a controlled
# comparison of ONE variable on IDENTICAL content.
#
# The fifth is the adversarial one: a trade question mixing an English technical
# noun ("VMC operator", "fanuc") into Hindi grammar. That is exactly where an
# English G2P pass and a Hindi one diverge most audibly, and exactly what a
# manufacturing worker is asked.
PROBES: tuple[tuple[str, str, str], ...] = (
    (
        "trade",
        "Aap kaunsa kaam karte hain?",
        "आप कौन सा काम करते हैं?",
    ),
    (
        "experience",
        "Is kaam mein aapko kitne saal ho gaye?",
        "इस काम में आपको कितने साल हो गए?",
    ),
    (
        "city",
        "Abhi aap kaunse sheher mein hain?",
        "अभी आप कौन से शहर में हैं?",
    ),
    (
        "salary",
        "Aap mahine ka kitna vetan chahte hain?",
        "आप महीने का कितना वेतन चाहते हैं?",
    ),
    (
        "mixed_technical",
        "Kya aap VMC machine par fanuc control chala lete hain?",
        "क्या आप वीएमसी मशीन पर फanuc कंट्रोल चला लेते हैं?",
    ),
)


def _status(settings: Settings, adapter: TtsAdapter) -> str:
    """Up-front readiness banner. A silent all-mock run is the most confusing
    failure mode, so report the exact gate state before doing anything."""
    reason = adapter.real_blocked_reason()
    lines = ["=== TTS SMOKE — readiness ==="]
    if reason is None:
        lines.append("REAL Sarvam TTS: ON")
    else:
        lines.append(f"REAL Sarvam TTS: OFF ({reason})")
        lines.append("  -> a real call needs AI_ENABLE_REAL_CALLS=true, GEMINI_FLASH_API_KEY,")
        lines.append("     'tts_synthesis' in AI_REAL_CALL_TASKS, and SARVAM_API_KEY.")
    lines.append(f"model:       {settings.sarvam_tts_model}")
    lines.append(f"speaker:     {settings.sarvam_tts_speaker}")
    lines.append(f"language:    {settings.sarvam_tts_language}")
    lines.append(f"sample_rate: {settings.sarvam_tts_sample_rate}")
    lines.append(f"codec:       {settings.sarvam_tts_output_codec}")
    lines.append(
        f"rate:        Rs {settings.sarvam_tts_cost_inr_per_10k_chars}/10k chars, "
        f"min billed {settings.sarvam_tts_min_billed_chars} chars"
    )
    return "\n".join(lines)


async def _run_one(
    adapter: TtsAdapter, *, text: str, language: str | None, allow_real: bool
) -> TtsResult:
    return await adapter.synthesize(text=text, language_code=language, real_call_allowed=allow_real)


def _write(out_dir: Path, name: str, result: TtsResult) -> str:
    """Write the clip and return the path, or a dash when there is nothing to write.

    Empty audio is NOT written as a zero-byte file — an empty .wav in an output
    directory reads as "rendered" at a glance, which is the wrong impression on the
    one run whose whole purpose is judging output quality.
    """
    if not result.audio:
        return "-"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{name}.{result.audio_format}"
    path.write_bytes(result.audio)
    return str(path)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m app.cli.tts_smoke",
        description="Terminal smoke test for the Sarvam TTS path (does not touch the API/queue).",
    )
    p.add_argument("--text", help="synthesize one arbitrary string instead of the probe set")
    p.add_argument(
        "--matrix",
        action="store_true",
        help=(
            "sweep roman vs Devanagari against --language and --alt-language — the run "
            "that answers whether bulbul speaks romanized Hinglish"
        ),
    )
    p.add_argument("--language", default=None, help="BCP-47 code (default: config, hi-IN)")
    p.add_argument(
        "--alt-language",
        default="en-IN",
        help="second language code for --matrix (default: en-IN)",
    )
    p.add_argument("--model", default=None, help="override sarvam_tts_model for this run")
    p.add_argument("--speaker", default=None, help="override sarvam_tts_speaker for this run")
    p.add_argument(
        "--out", default="./tts-probe", help="directory for the audio (default ./tts-probe)"
    )
    p.add_argument("--mock", action="store_true", help="force the mock path (no provider call)")
    return p


def main(argv: list[str] | None = None) -> int:
    # Probe text is Devanagari/Hinglish; keep stdout tolerant on legacy Windows code
    # pages so the tool never dies on an un-encodable character.
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass

    args = _build_parser().parse_args(argv)

    overrides: dict[str, object] = {}
    if args.model:
        overrides["sarvam_tts_model"] = args.model
    if args.speaker:
        overrides["sarvam_tts_speaker"] = args.speaker
    settings = Settings(**overrides)  # type: ignore[arg-type]
    adapter = TtsAdapter(settings)
    print(_status(settings, adapter))

    # A real attempt needs the gate on; never silently downgrade to mock, because a
    # mock run here produces no audio and would read as "the provider returned
    # nothing" rather than "the provider was never called".
    reason = adapter.real_blocked_reason()
    if not args.mock and reason is not None:
        print(
            f"\nerror: real TTS is blocked ({reason}). Re-run with --mock or set the env.",
            file=sys.stderr,
        )
        return 2

    out_dir = Path(args.out)
    allow_real = not args.mock
    rows: list[tuple[str, str, int, bool, str | None, str]] = []
    total_inr = 0.0

    if args.text:
        cases = [("custom", args.text, args.language)]
    elif args.matrix:
        # script x language, on identical content — one variable at a time.
        cases = []
        for key, roman, deva in PROBES:
            for lang in (args.language or settings.sarvam_tts_language, args.alt_language):
                cases.append((f"{key}__roman__{lang}", roman, lang))
                cases.append((f"{key}__deva__{lang}", deva, lang))
    else:
        cases = [(key, roman, args.language) for key, roman, _ in PROBES]

    for name, text, lang in cases:
        result = asyncio.run(_run_one(adapter, text=text, language=lang, allow_real=allow_real))
        path = _write(out_dir, name, result)
        rows.append((name, lang or settings.sarvam_tts_language, result.char_count,
                     result.is_mock, result.error_code, path))
        if not result.is_mock:
            total_inr += adapter.projected_inr(text.strip())

    print("\n=== RESULTS ===")
    print(f"{'probe':<34} {'lang':<7} {'chars':>5} {'mock':<5} {'error':<22} file")
    for name, lang, chars, is_mock, err, path in rows:
        print(f"{name:<34} {lang:<7} {chars:>5} {str(is_mock):<5} {str(err or '-'):<22} {path}")

    print(f"\ncalls: {len(rows)}   estimated spend: Rs {round(total_inr, 4)}")
    if not args.mock:
        print(
            "\nNOW LISTEN TO THEM. Compare each __roman__ clip against its __deva__ pair on\n"
            "identical content. The question is not 'does it produce audio' — it is whether a\n"
            "native speaker from the target demographic understands the roman one. Then check\n"
            "the Sarvam dashboard: chars billed vs the char counts above is the rounding rule."
        )

    failed = [r for r in rows if r[4] not in (None, "-")]
    return 1 if failed and not args.mock else 0


if __name__ == "__main__":
    raise SystemExit(main())
