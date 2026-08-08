"""The reply closure manifest, and the Python half of its identity function.

WHAT THE MANIFEST IS. Every string the deterministic interview engine can serve — 129 prompts,
4 retries, 143 bare ``why_text``, 150 runtime ``why + question`` concatenations, and 7 fixed
orchestrator constants. It is knowable ahead of time ONLY because the engine makes zero LLM calls
between session start and completion, which is what makes pre-rendered TTS possible at all.

It is generated on the TypeScript side (``apps/api/src/profiling/reply-closure.golden.test.ts``)
from the live engine and the real question packs, and MIRRORED into ``app/tts_data/`` — byte for
byte — because the ai-service image is built from the ``apps/ai-service`` context alone, so
``packages/`` does not exist at runtime in the container. Same arrangement, and the same reasoning,
as ``app/profiling/lexicon_data/``. Both sides check the mirror; see
``tests/test_reply_closure_parity.py``.

WHY THE CLIP ID IS RECOMPUTED HERE RATHER THAN TRUSTED. The manifest ships the ids, and this module
could simply read them. It recomputes instead, because the id is the CONTRACT between two
languages: the runtime reply is hashed in TypeScript, the audio file is named in Python, and a
worker hears whichever file that name resolves to. If the two hash functions ever diverge, reading
the shipped id would hide it until a worker heard the wrong question read aloud — on the one
surface where they cannot read the screen to notice.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

#: Byte-identical mirror of `packages/db/data/question-packs/reply-closure.json`.
MANIFEST_PATH = Path(__file__).resolve().parent / "tts_data" / "reply-closure.json"

# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------

#: Collapse runs of these — and ONLY these — to a single space.
#:
#: `[ \t\r\n]` EXPLICITLY, never `\s`. `\s` matches a different set in Python's `re` than in
#: JavaScript, and this function must agree with `normalizeReplyText` byte for byte.
_RUN_RE = re.compile(r"[ \t\r\n]+")

#: The same class, anchored, INSTEAD OF `str.strip()`.
#:
#: This is the half that is easy to get wrong, and it was measured rather than reasoned about.
#: `str.strip()` and JavaScript's `String.prototype.trim()` strip DIFFERENT sets — six codepoints
#: disagree between the two runtimes this repo actually runs:
#:
#:     U+FEFF          JS strips it, Python keeps it   <- a BOM on a pack file reaches here
#:     U+001C..U+001F  Python strips them, JS keeps them
#:     U+0085 (NEL)    Python strips it, JS keeps it
#:
#: A leading BOM would therefore have produced a DIFFERENT clip id on each side. The TypeScript
#: side dropped `.trim()` for the identical anchored class, so neither runtime's built-in
#: whitespace notion is consulted by either language and there is nothing left to diverge.
_EDGE_RE = re.compile(r"^[ \t\r\n]+|[ \t\r\n]+$")


def normalize_reply_text(text: str) -> str:
    """Identity normalization for :func:`clip_id`. Mirrors ``normalizeReplyText`` exactly.

    The Devanagari danda and the non-breaking space are NOT whitespace here, on purpose — both
    carry meaning in the corpus, at the edges as well as inside.
    """
    return _RUN_RE.sub(" ", _EDGE_RE.sub("", text))


def clip_id(text: str) -> str:
    """``sha256(normalize(text))[:16]`` — the render filename and the client's cache key."""
    return hashlib.sha256(normalize_reply_text(text).encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# The manifest
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ReplyClip:
    """One thing a worker can hear."""

    id: str
    text: str
    producer: str


class ReplyClosureError(RuntimeError):
    """The manifest is missing, malformed, or disagrees with this module's hash."""


def load_reply_closure(path: Path | None = None) -> list[ReplyClip]:
    """Read the manifest and VERIFY it against the identity function above.

    Raises rather than degrading. A renderer that silently skipped mismatched rows would spend
    real money producing a partial catalogue and report success.
    """
    manifest_path = path or MANIFEST_PATH
    if not manifest_path.is_file():
        raise ReplyClosureError(
            f"reply closure manifest missing at {manifest_path}. It is generated from the "
            "TypeScript engine — see apps/api/src/profiling/reply-closure.golden.test.ts."
        )

    raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    rows = raw.get("clips")
    if not isinstance(rows, list) or not rows:
        raise ReplyClosureError("reply closure manifest carries no clips")

    declared = raw.get("clip_count")
    if declared != len(rows):
        raise ReplyClosureError(f"manifest says {declared} clips but carries {len(rows)}")

    clips: list[ReplyClip] = []
    mismatches: list[str] = []
    for row in rows:
        clip = ReplyClip(id=str(row["id"]), text=str(row["text"]), producer=str(row["producer"]))
        # THE CROSS-LANGUAGE CHECK. See the module docstring: a divergence here means the
        # pre-rendered audio and the runtime reply disagree about which clip is which.
        if clip_id(clip.text) != clip.id:
            mismatches.append(clip.id)
        clips.append(clip)

    if mismatches:
        raise ReplyClosureError(
            f"{len(mismatches)} clip id(s) do not match this module's hash of their text "
            f"(first: {mismatches[0]}). The TypeScript and Python identity functions have "
            "diverged — every rendered filename would be wrong."
        )

    ids = [c.id for c in clips]
    if len(set(ids)) != len(ids):
        raise ReplyClosureError("manifest carries duplicate clip ids")

    return clips
