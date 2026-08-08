"""Cross-language parity for the reply closure — the manifest, and the identity function.

Two independent things are asserted, and they fail for different reasons:

1. MIRROR INTEGRITY — ``app/tts_data/reply-closure.json`` must be byte-identical to
   ``packages/db/data/question-packs/reply-closure.json``. The mirror exists because the
   ai-service image is built from the ``apps/ai-service`` context only, so ``packages/`` does not
   exist at runtime in the container. Duplication is only safe while drift is mechanically
   impossible, so it is checked from BOTH sides — the Vitest golden test in apps/api, and here.

2. IDENTITY PARITY — ``normalize_reply_text``/``clip_id`` must agree with the TypeScript
   ``normalizeReplyText``/``clipId`` on every string. The manifest ships ids computed in
   TypeScript; recomputing them here and comparing is the strongest available form of that check,
   because it runs over the REAL 434-clip corpus rather than a handful of probes.

WHY THE CODEPOINT VECTORS BELOW EXIST. The two languages used to disagree, and it was measured,
not theorised. `str.strip()` and `String.prototype.trim()` strip DIFFERENT sets: six codepoints
differ between the runtimes this repo runs (U+FEFF, U+001C-U+001F, U+0085). Both sides therefore
dropped their built-in trim for the same anchored `[ \\t\\r\\n]` class. These vectors pin that,
because the failure mode is silent — a BOM on a pack file would give the two sides different clip
ids, and the worker would hear the wrong question read aloud.

Reaches across the repo with ``parents[3]``, which is fine HERE and nowhere in ``app/``: tests are
never copied into the image.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.reply_closure import (
    MANIFEST_PATH,
    ReplyClosureError,
    clip_id,
    load_reply_closure,
    normalize_reply_text,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]
_CANONICAL = _REPO_ROOT / "packages" / "db" / "data" / "question-packs" / "reply-closure.json"

#: The measured floor. Pinned so the manifest cannot be quietly shrunk to make a failure go away —
#: deleting rows is the cheapest way to turn a parity suite green. Deliberately below the current
#: 434 so authoring the ~20 planned `retry_text` items does not redden the build.
_MIN_CLIPS = 300


def test_mirror_is_byte_identical_to_the_canonical_manifest() -> None:
    assert _CANONICAL.is_file(), f"canonical manifest missing at {_CANONICAL}"
    assert MANIFEST_PATH.is_file(), f"mirror missing at {MANIFEST_PATH}"
    assert MANIFEST_PATH.read_bytes() == _CANONICAL.read_bytes(), (
        "app/tts_data/reply-closure.json has drifted from packages/db. Regenerate both with:\n"
        "  UPDATE_REPLY_CLOSURE=1 pnpm --filter @badabhai/api run test reply-closure.golden"
    )


def test_every_clip_id_recomputes_in_python() -> None:
    """The whole cross-language contract, over the real corpus.

    ``load_reply_closure`` raises on ANY mismatch, so reaching the assertions means all 434 ids
    computed in TypeScript were reproduced here byte for byte.
    """
    clips = load_reply_closure()
    assert len(clips) >= _MIN_CLIPS
    assert all(clip_id(c.text) == c.id for c in clips)


def test_producers_all_present() -> None:
    producers = {c.producer for c in load_reply_closure()}
    # A missing producer means an entire category of thing the engine says has no audio.
    assert producers == {"prompt", "retry", "why", "clarify", "constant"}


# ---------------------------------------------------------------------------
# Identity vectors — the parts that used to diverge
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # Interior runs collapse; this half always agreed.
        ("Aap kaunsa   kaam\tkarte hain?", "Aap kaunsa kaam karte hain?"),
        ("  padded  ", "padded"),
        ("line\r\nbreak", "line break"),
        # THE SIX THAT DISAGREED. `str.strip()` would remove the leading character in every case
        # below except U+FEFF, and `.trim()` would remove U+FEFF and not the others. Neither is
        # consulted now, so all six are PRESERVED — identically on both sides.
        ("﻿BOM leads", "﻿BOM leads"),
        ("BOM trails﻿", "BOM trails﻿"),
        ("\x1cfile separator", "\x1cfile separator"),
        ("\x1funit separator", "\x1funit separator"),
        ("\x85next line", "\x85next line"),
        # NBSP is meaningful in this corpus — at the EDGES as well as inside. `.trim()` used to
        # strip a leading one while the module comment declared it meaningful; the old test only
        # covered an interior NBSP, which is why nothing caught the contradiction.
        (" nbsp leads", " nbsp leads"),
        ("nbsp inside", "nbsp inside"),
        # The Devanagari danda is not a word character and not whitespace.
        ("बात। हो", "बात। हो"),
    ],
)
def test_normalize_vectors(raw: str, expected: str) -> None:
    assert normalize_reply_text(raw) == expected


def test_clip_id_is_stable_and_case_sensitive() -> None:
    # Whitespace churn must not re-spend the render budget…
    assert clip_id("Aap kahan rehte hain?") == clip_id("  Aap kahan   rehte hain?  ")
    # …but case and punctuation change what a listener hears, so they change the clip.
    assert clip_id("Aap kahan rehte hain?") != clip_id("aap kahan rehte hain?")
    assert clip_id("Aap kahan rehte hain?") != clip_id("Aap kahan rehte hain")


def test_a_tampered_manifest_raises_rather_than_rendering_it(tmp_path: Path) -> None:
    """A renderer that skipped bad rows would spend real money on a partial catalogue."""
    payload = json.loads(_CANONICAL.read_text(encoding="utf-8"))
    payload["clips"][0]["text"] = payload["clips"][0]["text"] + " tampered"
    target = tmp_path / "reply-closure.json"
    target.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ReplyClosureError, match="diverged"):
        load_reply_closure(target)


def test_a_missing_manifest_raises_with_the_regeneration_route(tmp_path: Path) -> None:
    with pytest.raises(ReplyClosureError, match="reply-closure.golden"):
        load_reply_closure(tmp_path / "nope.json")
