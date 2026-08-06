"""Dual-language parity for the profiling lexicon, plus the mirror integrity check.

Two independent things are asserted here, and they fail for different reasons:

1. MIRROR INTEGRITY — `app/profiling/lexicon_data/` must be byte-identical to
   `packages/profiling-lexicon/data/`. The mirror exists because the ai-service image is built
   from the `apps/ai-service` context only, so `packages/` does not exist at runtime in the
   container (see `app/profiling/lexicon.py`). Duplication is only safe while drift is
   mechanically impossible, so it is checked from BOTH sides — `pnpm lexicon:verify` in the
   node CI job, and this file in the ai-service job.

2. DETECTOR PARITY — the Python detectors must agree with the corpus at
   `packages/profiling-lexicon/__fixtures__/utterances.jsonl`, which the Vitest suite in that
   package asserts against too. Changing a cue list or the classification precedence on one
   side only turns the other side red. Same mechanism as `test_contract_parity.py`.

Both reach across the repo with `parents[3]`, which is fine HERE and nowhere in `app/`: tests
are never copied into the image.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app.profiling import lexicon
from app.profiling.predicates import PREDICATE_BY_NAME, classify_utterance
from app.profiling.values import VALUE_BY_NAME

_REPO_ROOT = Path(__file__).resolve().parents[3]
_PACKAGE = _REPO_ROOT / "packages" / "profiling-lexicon"
_CANONICAL_DIR = _PACKAGE / "data"
_MIRROR_DIR = Path(lexicon.__file__).resolve().parent / "lexicon_data"
_CORPUS = _PACKAGE / "__fixtures__" / "utterances.jsonl"

#: Phase 3's stated floor. Pinned so the corpus cannot be quietly shrunk to make a failure go
#: away — deleting cases is the cheapest way to turn a parity suite green.
_MIN_CASES = 300


def _canonical_files() -> list[Path]:
    assert _CANONICAL_DIR.is_dir(), (
        f"canonical lexicon data missing at {_CANONICAL_DIR} — the Vitest suite asserts against "
        "this same directory, so losing it silently removes the only cross-language guard"
    )
    return sorted(_CANONICAL_DIR.glob("*.json"))


def _load_corpus() -> list[dict]:
    assert _CORPUS.exists(), (
        f"parity corpus missing at {_CORPUS}. It must never degrade to 'zero cases, suite "
        "green': a silently-skipped parity suite is worse than none, because it reports success."
    )
    lines = _CORPUS.read_text(encoding="utf-8").splitlines()
    rows = [json.loads(line) for line in lines if line.strip()]
    assert rows, "parity corpus is empty"
    return rows


_CORPUS_ROWS = _load_corpus()
_IDS = [row["id"] for row in _CORPUS_ROWS]


# --------------------------------------------------------------- mirror integrity --
def test_every_canonical_file_is_mirrored():
    missing = [p.name for p in _canonical_files() if not (_MIRROR_DIR / p.name).exists()]
    assert not missing, f"not mirrored into {_MIRROR_DIR}: {missing} — run `pnpm lexicon:sync`"


def _read_lf(path: Path) -> str:
    """Text with LF endings, whatever the working tree holds.

    `.gitattributes` sets `* text=auto eol=lf`, so the repo stores LF and a Linux CI checkout has
    LF — but a Windows working tree can still hold CRLF for a file git has not normalized yet. A
    raw byte compare would pass on one machine and fail on the other. `sync-mirror.mjs` normalizes
    identically, so both gates test the same invariant.
    """
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def test_mirror_is_identical_to_canonical():
    """Compared as TEXT, not as parsed JSON: a reformat is drift too, and the mirror's `git diff`
    has to be reviewable line by line against the canonical diff in the same commit. Only line
    endings are normalized — see `_read_lf`."""
    differing = [
        p.name for p in _canonical_files() if _read_lf(_MIRROR_DIR / p.name) != _read_lf(p)
    ]
    assert not differing, (
        f"mirror differs from canonical for {differing} — edit "
        "packages/profiling-lexicon/data, run `pnpm lexicon:sync`, and commit both directories"
    )


def test_mirror_holds_no_orphan_files():
    """A renamed canonical file must not leave its old copy behind for `lexicon.py` to read."""
    canonical = {p.name for p in _canonical_files()}
    orphans = [p.name for p in sorted(_MIRROR_DIR.glob("*.json")) if p.name not in canonical]
    assert not orphans, f"stale mirrored file(s) {orphans} — run `pnpm lexicon:sync`"


# ------------------------------------------------------- the common-regex-subset rule --
def _collect_patterns() -> list[tuple[str, dict, str]]:
    """Every ``{"source", "flags"}`` object in every lexicon file, found STRUCTURALLY.

    Walking rather than listing means a new file or a new pattern is covered the day it is
    added, without anyone remembering to extend this test.
    """
    found: list[tuple[str, dict, str]] = []
    stem = ""

    def walk(node: object, path: str) -> None:
        if isinstance(node, list):
            for index, child in enumerate(node):
                walk(child, f"{path}[{index}]")
        elif isinstance(node, dict):
            if isinstance(node.get("source"), str):
                found.append((path, node, stem))
                return
            for key, child in node.items():
                walk(child, f"{path}.{key}")

    for path in _canonical_files():
        stem = path.stem
        data = json.loads(path.read_text(encoding="utf-8"))
        walk(data, path.stem)
        # FRAGMENTS ARE PATTERN SOURCE TOO. They are bare strings rather than {source, flags}
        # objects, so the structural walk cannot see them — and a `\w` hiding in a fragment
        # would reach every pattern that references it. Collected explicitly for that reason.
        for name, source in (data.get("fragments") or {}).items():
            found.append((f"{path.stem}.fragments.{name}", {"source": source}, path.stem))
    return found


_PATTERNS = _collect_patterns()


def test_the_walker_finds_patterns_at_all():
    """Without this, a bug in `_collect_patterns` would make every assertion below vacuous."""
    assert len(_PATTERNS) > 5


@pytest.mark.parametrize("path,spec,stem", _PATTERNS, ids=[p for p, _, _ in _PATTERNS])
def test_pattern_uses_no_banned_escape(path: str, spec: dict, stem: str):
    """`\\d` and `\\w` mean different things in Python and JavaScript, and `\\b` is DEFINED in
    terms of `\\w`, so it inherits the same divergence. `{WB}`/`{WE}` are the replacements.

    Checked on the RAW source, before expansion: the expansion contains none of these, so
    checking afterwards would test the wrong string."""
    # The COMPLEMENTS divide the same disputed character set, so they inherit the same split:
    # `^\W*...\W*$` anchors on different characters in each engine. `{NWC}` is the replacement.
    for banned in ("\\d", "\\w", "\\b", "\\W", "\\D"):
        assert banned not in spec["source"], (
            f"{path} uses {banned}, which the two regex engines disagree on — "
            "see packages/profiling-lexicon/data/README.md"
        )


@pytest.mark.parametrize("path,spec,stem", _PATTERNS, ids=[p for p, _, _ in _PATTERNS])
def test_pattern_compiles(path: str, spec: dict, stem: str):
    # With that file's own fragments, which is how the real readers compile it.
    compiled = lexicon.compile_pattern(spec, lexicon.fragments_of(stem))
    assert isinstance(compiled, re.Pattern), path


def test_unknown_macro_raises_instead_of_compiling_as_a_literal():
    """`{NOPE}` is VALID regex syntax, so an un-expanded macro compiles happily and then never
    matches. A detector that never fires is the silent failure this package exists to prevent."""
    with pytest.raises(ValueError, match="unknown lexicon macro"):
        lexicon.expand("{NOPE}")


def test_regex_quantifiers_are_not_mistaken_for_macros():
    """`{0,24}` looks like a macro to a careless expander. The job-prospect pattern needs it."""
    assert lexicon.expand("a{0,24}b") == "a{0,24}b"


def test_unsupported_flag_raises_rather_than_being_dropped():
    with pytest.raises(ValueError, match="unsupported lexicon regex flag"):
        lexicon.compile_pattern({"source": "x", "flags": "gu"})


def test_missing_data_file_raises_rather_than_returning_empty():
    """Fail closed (CLAUDE.md §3): a missing gazetteer must not turn every detector into a
    silent no-op, which is exactly what a `.get(..., {})` default would buy."""
    with pytest.raises(FileNotFoundError, match="profiling lexicon data missing"):
        lexicon.load("does-not-exist")


def test_skill_keywords_keep_their_file_order():
    """"tool offset" must precede "offset" or the generic term shadows the specific one."""
    keywords = lexicon.skill_keywords()
    assert keywords.index("tool offset") < keywords.index("offset")


# ------------------------------------------------------------------ corpus parity --
def test_corpus_meets_the_phase_3_floor():
    assert len(_CORPUS_ROWS) >= _MIN_CASES, (
        f"parity corpus has {len(_CORPUS_ROWS)} cases, below the {_MIN_CASES} Phase 3 requires"
    )


def test_corpus_ids_and_texts_are_unique():
    assert len(set(_IDS)) == len(_CORPUS_ROWS)
    assert len({row["text"] for row in _CORPUS_ROWS}) == len(_CORPUS_ROWS)


def test_corpus_covers_every_utterance_class():
    seen = {row["cls"] for row in _CORPUS_ROWS}
    for cls in (
        "dont_know",
        "correction",
        "hardship",
        "question_back",
        "abusive",
        "empty",
        "off_topic",
    ):
        assert cls in seen, f"no fixture produces cls={cls}"


def test_every_detector_both_fires_and_stays_silent():
    """A predicate expected `False` on all 346 cases would pass every per-case assertion below
    while being completely broken. This is the guard against a vacuously green suite."""
    for name in PREDICATE_BY_NAME:
        values = {row["predicates"][name] for row in _CORPUS_ROWS}
        assert True in values, f"{name} never expected true"
        assert False in values, f"{name} never expected false"


def _describe(row: dict) -> str:
    note = f" — {row['note']}" if row.get("note") else ""
    return f"{row['id']} {row['text']!r}{note}"


@pytest.mark.parametrize("row", _CORPUS_ROWS, ids=_IDS)
def test_classification_matches_the_corpus(row: dict):
    assert classify_utterance(row["text"]).cls == row["cls"], _describe(row)


@pytest.mark.parametrize("row", _CORPUS_ROWS, ids=_IDS)
def test_predicates_match_the_corpus(row: dict):
    for name, expected in row["predicates"].items():
        detector = PREDICATE_BY_NAME.get(name)
        assert detector is not None, f"corpus references unknown predicate {name!r}"
        assert detector(row["text"]) is expected, f"{name} — {_describe(row)}"


# ------------------------------------------------------------------ value parity --
def test_corpus_exercises_every_normalizer_and_the_negation_veto():
    """Guards against a vacuously green suite: a normalizer returning None on all 409 cases would
    satisfy every per-case assertion below."""
    for name in VALUE_BY_NAME:
        hits = [r for r in _CORPUS_ROWS if name in r.get("values", {})]
        assert hits, f"{name} never produces a value anywhere in the corpus"
    vetoed = [v for r in _CORPUS_ROWS for v in r.get("values", {}).values() if v["negationVetoed"]]
    assert vetoed, "no fixture exercises the negation veto"


@pytest.mark.parametrize("row", _CORPUS_ROWS, ids=_IDS)
def test_normalizers_match_the_corpus(row: dict):
    """Spans are asserted, not just values.

    The span is what the Phase 7 parse call's provenance gate checks, so a normalizer that finds
    the right value at the wrong offset is a real defect a value-only assertion would wave through.
    """
    wanted = row.get("values", {})
    for name, normalizer in VALUE_BY_NAME.items():
        got = normalizer(row["text"])
        if name not in wanted:
            # An ABSENT key means the normalizer must return None. This is the assertion that
            # catches a detector which starts firing where it should not.
            assert got is None, f"{name} should not fire — {_describe(row)}"
            continue
        assert got is not None, f"{name} returned None — {_describe(row)}"
        want = wanted[name]
        assert got.value == want["value"], f"{name} value — {_describe(row)}"
        assert [got.span.start, got.span.end] == want["span"], f"{name} span — {_describe(row)}"
        assert got.negation_vetoed is want["negationVetoed"], f"{name} veto — {_describe(row)}"


# ----------------------------------------- semantics the corpus alone would not pin --
def test_the_devanagari_danda_closes_a_match():
    """REGRESSION. U+0964 sits inside the Devanagari block but is PUNCTUATION, so Python's `\\b`
    treats it as a boundary. A boundary class that swallowed the whole block made it a word
    character and killed the trailing boundary — measured, 15 detectors."""
    from app.profiling import signals

    assert signals.is_dont_know("idk।")
    assert signals.is_hardship("kaam nahi mil raha।")
    assert signals.is_abusive("chutiya।")


def test_devanagari_letters_and_digits_still_block_a_match():
    from app.profiling import signals

    assert not signals.is_dont_know("idkहै")
    assert not signals.is_dont_know("idk५")


def test_the_salary_ceiling_agrees_with_the_pseudonymizer():
    """The plausibility ceiling is a MASKING decision, not just a parsing one.

    What `_parse_amount` accepts as a salary, the gateway's D-1 money carve-out masks as
    `[AMOUNT_n]` instead of blocking the turn. `pseudonymize.py` is the single source of truth;
    the lexicon carries a copy only because TypeScript cannot import it. `signals.py` already
    raises at import on disagreement — this asserts the guard is wired to the real constant
    rather than to a second copy of the same literal.
    """
    from app.profiling import lexicon
    from app.pseudonymize import MAX_PLAUSIBLE_SALARY_INR

    assert lexicon.load("salary")["maxPlausibleInr"] == MAX_PLAUSIBLE_SALARY_INR


def test_the_salary_unit_alternation_matches_the_unit_lists():
    """The matcher spells its units inline while `_parse_amount` reads them from two lists.

    Nothing else connects the two, so a unit added to one and not the other either never matches
    (silently dropping every "25 <unit>") or matches and then multiplies by 1. Both are silent.
    """
    from app.profiling import lexicon

    salary = lexicon.load("salary")
    expected = "|".join([*salary["thousandUnits"], *salary["lakhUnits"]])
    assert f"(?:{expected}){{WE}}" in salary["matcher"]["source"]


# ---------------------------------------------------- the curated-vocabulary privacy pin --
def test_the_curated_vocabulary_is_pinned():
    """VOCABULARY_TOKENS decides what the PSEUDONYMIZER un-masks. Changing it is a privacy change.

    Its only consumer is `pseudonymize.certified_clean_skill_labels`, which rescues a label the
    gateway masked as an EMPLOYER — so a token added here makes the gateway release a string it
    was previously withholding, and a token removed silently deletes a real qualification from a
    worker's profile ("Diploma Mechanical Engineering" was lost to exactly that collision).

    The set is DERIVED from the role/machine/welding/skill/education tables in trades.json and
    education.json, which means an innocent-looking keyword edit moves it. Pinned by checksum so
    that movement can never be invisible: if this fails, the diff is a privacy decision and wants
    a security review, not a re-baselined constant.

    Recompute with:
        python -c "import hashlib,sys; sys.path.insert(0,'.'); \
from app.profiling import signals as s; \
print(hashlib.sha256('\n'.join(sorted(s.VOCABULARY_TOKENS)).encode()).hexdigest())"
    """
    import hashlib

    from app.profiling import signals

    tokens = sorted(signals.VOCABULARY_TOKENS)
    digest = hashlib.sha256("\n".join(tokens).encode("utf-8")).hexdigest()

    assert len(tokens) == 141, (
        f"curated vocabulary changed size ({len(tokens)}, was 141) — this moves what the "
        "pseudonymizer un-masks"
    )
    assert digest == "9d6a242e311f58fb2617b26c22fb92d03e8a8e908c6b56903022414c091f380f", (
        "curated vocabulary CONTENTS changed while staying the same size — this moves what the "
        "pseudonymizer un-masks and needs a security review, not a new hash"
    )


def test_the_curated_vocabulary_still_rescues_the_label_that_forced_it():
    """The measured case: the gateway masked 'Diploma Mechanical Engineering' as an EMPLOYER
    because 'Engineering' is a company suffix, and nothing rescued it — a real qualification
    vanished from a worker's profile. A behaviour assertion beside the checksum, so the pin is
    not the only thing standing between this and a regression."""
    from app.profiling import signals

    assert signals.is_curated_vocabulary_label("Diploma Mechanical Engineering")
    assert signals.is_curated_vocabulary_label("Mechanical")
    assert signals.is_curated_vocabulary_label("ITI")
    # ...and still refuses a real employer name and a person's name.
    assert not signals.is_curated_vocabulary_label("Sharma Industries")
    assert not signals.is_curated_vocabulary_label("Rajesh Kumar")

    # MEASURED, and a real pre-existing gap rather than a design choice: the rescue requires
    # EVERY token to be curated vocabulary, and role LABELS are not in the harvest — only the
    # role KEYWORDS are. So "ITI Fitter" is not rescued and a masked one is simply lost, while
    # the bare "ITI" survives. Pinned here so closing it is a deliberate, reviewed change to a
    # privacy boundary rather than a side effect of editing a keyword table.
    assert not signals.is_curated_vocabulary_label("ITI Fitter")
