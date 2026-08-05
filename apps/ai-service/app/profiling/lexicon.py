"""Reader for the shared profiling lexicon.

The DATA lives in `packages/profiling-lexicon/data/` (canonical) and is mirrored
byte-for-byte into `lexicon_data/` next to this file. This module reads the mirror,
compiles the patterns, and hands `signals.py` the same objects it used to build inline.

WHY THE MIRROR AND NOT THE CANONICAL PATH
-----------------------------------------
`apps/ai-service/Dockerfile` builds from the `apps/ai-service` context ONLY — `packages/`
is not in the build context. A `parents[3] / "packages" / ...` read works on a laptop and
in CI and then fails to import on boot in staging and production. `tests/test_contract_parity.py`
reaches across the repo exactly that way and is fine, because tests never enter the image;
this module is runtime code, so it cannot. `lexicon_data/` sits under `app/`, which the
Dockerfile already `COPY`s wholesale.

Drift is prevented mechanically, from both sides:
    pnpm lexicon:verify           (node CI job)
    tests/test_lexicon_parity.py  (ai-service CI job)

THE COMMON-REGEX-SUBSET RULE
----------------------------
Every pattern here is compiled by BOTH Python `re` and JavaScript `RegExp`. `\\d`, `\\w` and
`\\b` are banned in the data because the two engines disagree on them for non-ASCII text —
Python's are Unicode-aware, JavaScript's are ASCII-only. `{WB}` / `{WE}` are the explicit
replacements. See `packages/profiling-lexicon/data/README.md` for the full rule.
"""

from __future__ import annotations

import json
import re
from functools import cache, lru_cache
from pathlib import Path
from typing import Any

# Anchored on THIS FILE, so it resolves identically from any working directory and from
# inside the container — the same discipline `config.py` uses for its env anchor.
_DATA_DIR = Path(__file__).resolve().parent / "lexicon_data"

# --- The macro alphabet ------------------------------------------------------
# What counts as a "word character" for the `{WB}` / `{WE}` boundary macros. This must
# reproduce Python's `\w` over the text this corpus actually contains, or the extraction is
# not behaviour-preserving — and it must be expressible identically in JavaScript.
#
# ASCII alphanumerics + "_" is `\w`'s ASCII behaviour, which both engines implement.
#
# The Devanagari part is enumerated rather than taken as the whole U+0900-U+097F block,
# because Python's `\w` is `str.isalnum()`-backed and the block is NOT all alphanumeric:
#
#   U+0904-U+0939  letters (Lo)                     WORD
#   U+093A-U+093C  combining marks                  not word
#   U+093D         avagraha ऽ (Lo)                  WORD
#   U+093E-U+094F  matras + virama (Mn/Mc)          not word
#   U+0950         ॐ (Lo)                           WORD
#   U+0951-U+0957  accents (Mn)                     not word
#   U+0958-U+0961  letters (Lo)                     WORD
#   U+0962-U+0963  vocalic marks (Mn)               not word
#   U+0964-U+0965  DANDA and double danda (Po)      not word   <-- see below
#   U+0966-U+096F  digits (Nd)                      WORD
#   U+0970         abbreviation sign (Po)           not word
#   U+0971         high spacing dot (Lm)            WORD
#   U+0972-U+097F  letters (Lo)                     WORD
#
# THE DANDA IS WHY THIS IS ENUMERATED. `।` ends a Hindi sentence the way `.` ends an English
# one, so it lands directly after the very tokens these detectors match. Taking the block
# wholesale makes it a word character, which kills the trailing boundary: "idk।" and
# "kaam nahi mil raha।" both stopped matching. Caught by a 3,924-comparison differential
# against the pre-extraction patterns — 15 regressions, all of them a danda.
#
# NOTE this is a different question from `_dev()` below, which brackets a DEVANAGARI token to
# stop it matching inside a longer one. That helper wants the whole block; a boundary macro
# standing in for `\b` wants only the alphanumerics.
#
# Deliberately narrower than Python's `\b` for scripts this corpus does not contain: a Tamil
# or Bengali character now counts as a boundary in BOTH engines rather than only in
# JavaScript. Narrowing toward agreement is the safe direction; the alternative is a detector
# that silently fires in one language only.
# Written as escapes, not literal glyphs: these ranges must be auditable against the table
# above without trusting a font, an editor, or this file's encoding. The TypeScript reader
# carries the identical string.
_BOUNDARY_CLASS = (
    "0-9A-Za-z_"
    "ऄ-ह"  # letters
    "ऽ"  # avagraha
    "ॐ"  # om
    "क़-ॡ"  # letters
    "०-९"  # digits
    "ॱ-ॿ"  # high spacing dot + letters
)
_WB = f"(?<![{_BOUNDARY_CLASS}])"
_WE = f"(?![{_BOUNDARY_CLASS}])"

# Escaped for regex-literal use inside a pattern the OTHER engine also compiles. Only the
# characters that are a JS `SyntaxCharacter` AND a Python metacharacter. Space, "-" and "&"
# are deliberately NOT escaped: they are literal outside a character class in both engines,
# and `\-` is a SyntaxError in a JavaScript `u`-mode pattern. `re.escape` would escape them,
# which is why the composed source is not byte-identical to the string signals.py used to
# build — only semantically identical, which is what the parity corpus asserts.
_ESCAPE_CHARS = frozenset(".*+?^$(){}[]|\\")

# Guards against a typo'd or newly-invented macro silently reaching the regex compiler as a
# literal `{FOO}` — which is valid regex syntax, so it would NOT raise. It would just never
# match, and a detector that never fires is exactly the silent failure this package exists to
# prevent. Deliberately does not match a quantifier like `{0,24}`.
_UNEXPANDED_MACRO_RE = re.compile(r"\{[A-Z][A-Z0-9_]*\}")


def _escape_for_both_engines(literal: str) -> str:
    """Regex-escape ``literal`` using the JS/Python-common escape set."""
    return "".join(f"\\{ch}" if ch in _ESCAPE_CHARS else ch for ch in literal)


@cache
def load(name: str) -> dict[str, Any]:
    """Load one lexicon file by stem (``"negation"``, ``"predicates"``, ``"skills"``).

    Fails LOUDLY and at import time rather than degrading to an empty gazetteer: a missing
    data file must not turn every detector into a silent no-op, which is what a `.get(...)`
    default would buy. CLAUDE.md §3 — fail closed.
    """
    path = _DATA_DIR / f"{name}.json"
    if not path.exists():
        raise FileNotFoundError(
            f"profiling lexicon data missing: {path}. This directory is a generated mirror of "
            "packages/profiling-lexicon/data — run `pnpm lexicon:sync` and commit both."
        )
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def skill_keywords() -> tuple[str, ...]:
    """The `skills.json` keywords, in file order. ORDER IS LOAD-BEARING (see that file)."""
    return tuple(entry["keyword"] for entry in load("skills")["skills"])


@lru_cache(maxsize=1)
def _skill_keyword_alternation() -> str:
    return "|".join(_escape_for_both_engines(kw) for kw in skill_keywords())


def expand(source: str) -> str:
    """Expand the `{WB}` / `{WE}` / `{SKILL_KEYWORDS}` macros to their regex source.

    The TypeScript reader performs the IDENTICAL substitution, which is what makes one JSON
    file compile to the same matcher in both languages.
    """
    expanded = (
        source.replace("{WB}", _WB)
        .replace("{WE}", _WE)
        .replace("{SKILL_KEYWORDS}", _skill_keyword_alternation())
    )
    leftover = _UNEXPANDED_MACRO_RE.search(expanded)
    if leftover:
        raise ValueError(
            f"unknown lexicon macro {leftover.group(0)} in pattern source {source!r} — "
            "add it to BOTH lexicon.py and src/internal/regex.ts, never to one side only"
        )
    return expanded


def _flags(spec_flags: str) -> int:
    """Map the data file's flag string onto `re` flags.

    Only `i` is supported, and an unknown flag RAISES rather than being ignored: silently
    dropping a flag would change what the pattern matches in one engine only.
    """
    unknown = set(spec_flags) - {"i"}
    if unknown:
        raise ValueError(f"unsupported lexicon regex flag(s): {sorted(unknown)}")
    return re.IGNORECASE if "i" in spec_flags else 0


def compile_pattern(spec: dict[str, str]) -> re.Pattern[str]:
    """Compile one ``{"source": ..., "flags": ...}`` object from a lexicon file."""
    return re.compile(expand(spec["source"]), _flags(spec.get("flags", "")))


def compile_named(file_stem: str, key: str) -> re.Pattern[str]:
    """Compile the pattern at ``key`` in ``file_stem``.json."""
    return compile_pattern(load(file_stem)[key])
