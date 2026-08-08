"""The batch renderer's own guards — the ones that protect operator money and the catalogue.

Nothing here calls a provider. Where a render has to be exercised, `_arm` stubs the TRANSPORT
(`_synthesize_real`) and nothing above it, so every guard inside `synthesize` still runs — which
matters, because the placeholder refusal is one of them.

What is asserted is the behaviour that only matters once real money is involved, and which is
therefore the easiest to get wrong quietly: dry-run by default, no silent caps, content-addressed
output, and a refusal rather than a green tick over an empty directory.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.cli import tts_render


def _manifest(tmp_path: Path, n: int = 3) -> Path:
    """A small real-shaped manifest, ids computed by the production identity function."""
    from app.reply_closure import clip_id

    texts = [f"Sawaal number {i} kya hai?" for i in range(n)]
    clips = [{"id": clip_id(t), "text": t, "producer": "prompt"} for t in texts]
    target = tmp_path / "reply-closure.json"
    target.write_text(
        json.dumps({"schema_version": 1, "clip_count": len(clips), "producers": {}, "clips": clips}),
        encoding="utf-8",
    )
    return target


def test_dry_run_is_the_default_and_writes_nothing(tmp_path, capsys, monkeypatch):
    """THE FLAG THAT PROTECTS THE BUDGET.

    Rendering is the moment operator money is spent. Every seeder in this repo is dry-run by
    default for the same reason, and the one time that flag was omitted in CI two steps went green
    while doing nothing at all.
    """
    monkeypatch.setattr(tts_render, "load_reply_closure", lambda: _load(tmp_path))
    out = tmp_path / "clips"

    assert tts_render.main(["--out", str(out)]) == 0

    assert not out.exists(), "a dry run created the output directory"
    printed = capsys.readouterr().out
    assert "DRY RUN (nothing is spent)" in printed
    assert "--apply" in printed, "the dry run must name the way to actually render"


def test_dry_run_prices_the_catalogue_before_it_is_bought(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(tts_render, "load_reply_closure", lambda: _load(tmp_path))
    tts_render.main(["--out", str(tmp_path / "clips")])
    assert "projected     Rs" in capsys.readouterr().out


def test_a_limit_announces_what_it_drops(tmp_path, capsys, monkeypatch):
    """NO SILENT CAPS.

    A truncated run reads as "the whole catalogue rendered" when it did not, and the missing clips
    surface only as silence in a worker's ear.
    """
    monkeypatch.setattr(tts_render, "load_reply_closure", lambda: _load(tmp_path, n=5))
    tts_render.main(["--out", str(tmp_path / "clips"), "--limit", "2"])
    printed = capsys.readouterr().out
    assert "drops 3 of 5" in printed


def test_apply_REFUSES_when_real_calls_are_blocked(tmp_path, monkeypatch, capsys):
    """MOCK IS A POSTURE, NOT A RENDER.

    The adapter's mock path returns EMPTY audio on purpose — a placeholder tone played to a worker
    who cannot read the screen looks like the question was asked when it was not. So an `--apply`
    run with real calls blocked would walk 433 clips, write nothing, and have to report either 433
    failures (wrong — nothing was attempted) or success over an empty directory (worse). The test
    environment has real calls gated off, so this is the DEFAULT outcome and it must be loud.
    """
    monkeypatch.setattr(tts_render, "load_reply_closure", lambda: _load(tmp_path))
    out = tmp_path / "clips"

    assert tts_render.main(["--out", str(out), "--apply"]) == 2

    err = capsys.readouterr().err
    assert "REFUSING to render" in err
    assert "AI_ENABLE_REAL_CALLS" in err, "the refusal must name what to arm"
    assert not out.exists(), "a refused render created the output directory"


def test_apply_is_content_addressed_and_skips_what_is_already_on_disk(tmp_path, monkeypatch):
    """Re-running after a one-word corpus fix must cost one clip, not the whole catalogue."""
    monkeypatch.setattr(tts_render, "load_reply_closure", lambda: _load(tmp_path))
    _arm(monkeypatch)
    out = tmp_path / "clips"

    assert tts_render.main(["--out", str(out), "--apply"]) == 0
    written = sorted(p.name for p in out.iterdir())
    assert len(written) == 3
    # Named by clip id, not by index or by question key — the client resolves audio by hashing
    # the string it is about to display, so the filename IS the lookup key.
    ids = {c.id for c in _load(tmp_path)}
    assert {p.split(".")[0] for p in written} == ids

    mtimes = {p.name: p.stat().st_mtime_ns for p in out.iterdir()}
    assert tts_render.main(["--out", str(out), "--apply"]) == 0
    assert {p.name: p.stat().st_mtime_ns for p in out.iterdir()} == mtimes, "re-rendered a clip it already had"


def test_a_placeholder_clip_fails_the_run_rather_than_shipping_a_hole(tmp_path, monkeypatch, capsys):
    """A PARTIAL CATALOGUE IS A FAILURE, and a `{{placeholder}}` is the worst reason for one.

    A shared audio cache plus post-emit interpolation is how one worker's name would be spoken to
    every other worker, so the adapter refuses the text. That refusal must be loud: exit non-zero,
    counted by code, and NEVER printed alongside the text, which may embed the PII.
    """
    from app.reply_closure import ReplyClip

    bad = ReplyClip(id="deadbeefdeadbeef", text="Namaste {{worker_name}} ji.", producer="prompt")
    monkeypatch.setattr(tts_render, "load_reply_closure", lambda: [bad])
    _arm(monkeypatch)

    assert tts_render.main(["--out", str(tmp_path / "clips"), "--apply"]) == 1

    printed = capsys.readouterr().out
    assert "tts_placeholder_text" in printed
    assert "worker_name" not in printed, "the refusal echoed the text it refused"


def test_a_missing_manifest_exits_non_zero(tmp_path, monkeypatch, capsys):
    def boom():
        raise tts_render.ReplyClosureError("reply closure manifest missing at /nope")

    monkeypatch.setattr(tts_render, "load_reply_closure", boom)
    assert tts_render.main(["--out", str(tmp_path / "clips"), "--apply"]) == 2


def _arm(monkeypatch) -> None:
    """Unblock the gate and stub the TRANSPORT — never the guards above it.

    `_synthesize_real` is the last thing before the socket, so patching it leaves the whole of
    `synthesize` live: the placeholder refusal, the empty-text refusal, the length clamp and the
    spend ledger all still run exactly as they would against Sarvam. Wrapping `synthesize` instead
    would have skipped them, and the placeholder test below is precisely a test OF one of them.

    `real_call` gating itself is covered in `test_tts.py`; re-proving it here would only duplicate.
    """
    from app.tts import TtsAdapter

    monkeypatch.setattr(TtsAdapter, "real_blocked_reason", lambda self: None)

    async def fake_transport(self, text: str, language_code: str | None) -> bytes:
        return b"AUDIO"

    monkeypatch.setattr(TtsAdapter, "_synthesize_real", fake_transport)


def _load(tmp_path: Path, n: int = 3):
    from app.reply_closure import load_reply_closure

    return load_reply_closure(_manifest(tmp_path, n))
