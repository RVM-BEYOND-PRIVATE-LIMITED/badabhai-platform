"""Reproduce #1933's measurements of the cued-ID connector (risks-register R54).

    cd apps/ai-service && python scripts/measure_cued_id_linear.py parity
    cd apps/ai-service && python scripts/measure_cued_id_linear.py parity --against loose
    cd apps/ai-service && python scripts/measure_cued_id_linear.py timing [reps]

Three rules shared one cue-to-value connector, `\\s*(?:no\\.?|number|num|#)?\\s*[:\\-]?\\s*`, which
is O(k^3) on a whitespace run: the gateway's `_CREDENTIAL_ID_RE`, G1/G2's `_RESUME_CUED_ID_RE`
(with an `id` word) and the salary detector's credential guard (`signals._CREDENTIAL_BEFORE_RE`,
lexicon `credentialBefore`). #1933 folds each quantifier into the optional token it follows:
`\\s*(?:(?:no\\.?|number|num|#)\\s*)?(?:[:\\-]\\s*)?`.

UNFOLDED is each shipped rule with its connector written main's way, every whitespace quantifier
standing alone between the optional tokens, and nothing else touched. So the comparison isolates
the folding and stays valid if a cue list later grows. Until #1950 UNFOLDED was main's exact text.
#1950 (R56) added `-?` after the separator, so both forms now carry it: `[:\\-]-?` folded, and
`(?:[:\\-]-?)?` unfolded. Its other two tokens, the `\\.?` after the cue word and the "regn" cue,
sit outside the connector, so the swap keeps them. `scripts/measure_cued_id_dot.py` measures what
#1950 itself changed. `rules("unfolded")` swaps those patterns into the modules for the end-to-end
runs.

#2091 (R56) put up to two label words in front of the "no" word: "id", then "card" or "code",
each folded with its own `\\s*`. They never existed unfolded, so UNFOLDED carries them exactly
as shipped and still differs from the shipped rule by #1933's folding alone. Written unfolded
they would put five whitespace quantifiers in a row, which the timing run could not finish.
`scripts/measure_cued_id_two_word.py` measures what #2091 itself changed.

parity   Unfolded against the shipped rules (or `--against loose`, a sensitivity variant that
         drops the `\\s*` after the "no" word: it must move spans, or the harness cannot see a
         change).
         1. Regex level, over every distinct string of the repo's own text (`corpus()`) in each
            of `VIEWS` (as written, whitespace runs stretched, separators spaced) and
            upper-cased: each rule's matches (whole span and every group span) and the salary
            guard's verdict on every slice the detector hands it (`guard_slices`).
         2. The same over `--fuzz` samples (default 60,000) of the seeded cue-line generator.
         3. End to end, over every corpus string that holds a cue (`ANY_CUE`), in each of
            `VIEWS`: `pseudonymize`, `contains_hard_identifier` and `signals.detect`.
timing   Unfolded against the shipped rules on a cue + whitespace run, interleaved in one process
         so machine load hits both alike, the minimum of `reps` runs (default 3). Unfolded stops
         at 800 spaces (1,600 took 13-20 s); the shipped rules also run at 20,000 characters, the
         size cap.

The corpus is read from git-tracked files only, with the file readers of
`measure_title_employer_bound.py` (imported, not copied), so an untracked local file never enters
it and a dirty checkout counts what CI counts. Stdlib and git only. The counts depend on the
commit: re-run them on the one you are judging.
"""

from __future__ import annotations

import argparse
import random
import re
import sys
import time
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))
# The sibling script's corpus readers: one copy of `tracked`, `json_strings` and `py_strings`.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from measure_title_employer_bound import (  # noqa: E402
    distinct,
    json_strings,
    py_strings,
    tracked,
)

import app.pseudonymize as gateway  # noqa: E402
from app.profiling import profile_extractor, signals  # noqa: E402

# --- the three rules and their connectors -------------------------------------------------------

#: name -> (module, attribute, the unfolded connector, the linear connector). The
#: `credential_before` text is the lexicon's, which writes the class `[:-]` with no escape (a
#: JavaScript u-mode rule). Main's text before #1933 was the unfolded one without `-?`, and
#: without #2091's label words in front of the "no" word ("id", then "card" or "code"), which
#: both forms carry folded, as shipped. The "id" word was in the "no"-word group until then.
RULES: dict[str, tuple[object, str, str, str]] = {
    "credential_id": (
        gateway,
        "_CREDENTIAL_ID_RE",
        r"\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:no\.?|number|num|#)?\s*(?:[:\-]-?)?\s*",
        r"\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:(?:no\.?|number|num|#)\s*)?(?:[:\-]-?\s*)?",
    ),
    "resume_cued_id": (
        gateway,
        "_RESUME_CUED_ID_RE",
        r"\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:no\.?|number|num|#)?\s*(?:[:\-]-?)?\s*",
        r"\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:(?:no\.?|number|num|#)\s*)?(?:[:\-]-?\s*)?",
    ),
    "credential_before": (
        signals,
        "_CREDENTIAL_BEFORE_RE",
        r"\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:no\.?|number|num|#)?\s*(?:[:-]-?)?\s*",
        r"\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:(?:no\.?|number|num|#)\s*)?(?:[:-]-?\s*)?",
    ),
}
#: Every cue of the three rules contains one of these, matched the same case-insensitive way, so a
#: string with none of them can match no rule under either connector.
ANY_CUE = re.compile(
    r"(?i)roll|reg|cert|enrol|licen|ncvt|scvt|nsqf|nsdc|passport|voter|gstin|uan|esic|provident"
    r"|ifsc|a/c|account|dob|date\s+of\s+birth"
)


def shipped(name: str) -> re.Pattern[str]:
    module, attribute, _unfolded, _linear = RULES[name]
    return getattr(module, attribute)


def _swap(name: str, replacement: str) -> re.Pattern[str]:
    pattern = shipped(name)
    _module, _attribute, _unfolded, linear = RULES[name]
    if linear not in pattern.pattern:
        raise ValueError(f"{name}: the shipped rule no longer holds the linear connector")
    return re.compile(pattern.pattern.replace(linear, replacement), pattern.flags)


def variant(name: str, which: str) -> re.Pattern[str]:
    """`shipped`, `unfolded` (the connector written main's way) or `loose` (sensitivity: the "no"
    word's trailing `\\s*` dropped)."""
    if which == "shipped":
        return shipped(name)
    if which == "unfolded":
        return _swap(name, RULES[name][2])
    if which == "loose":
        return _swap(name, RULES[name][3].replace(r"|#)\s*)?", r"|#))?"))
    raise SystemExit(f"unknown variant {which!r}: use shipped, unfolded or loose")


@contextmanager
def swapped(patterns: dict[str, re.Pattern[str]]) -> Iterator[None]:
    """The three modules with ``patterns`` (name -> pattern) swapped in, restored on exit."""
    saved = {name: shipped(name) for name in RULES}
    try:
        for name, pattern in patterns.items():
            module, attribute, _unfolded, _linear = RULES[name]
            setattr(module, attribute, pattern)
        yield
    finally:
        for name, pattern in saved.items():
            module, attribute, _unfolded, _linear = RULES[name]
            setattr(module, attribute, pattern)


def rules(which: str) -> AbstractContextManager[None]:
    """The three modules with the `which` variant of each rule swapped in, restored on exit."""
    return swapped({name: variant(name, which) for name in RULES})


# --- comparing two variants ---------------------------------------------------------------------


def spans(pattern: re.Pattern[str], text: str) -> list[tuple[tuple[int, int], ...]]:
    """Every match as (whole span, each group's span): what `sub`, `_apply` and `search` read."""
    return [
        (m.span(), *(m.span(g) for g in range(1, pattern.groups + 1)))
        for m in pattern.finditer(text)
    ]


def guard_slices(text: str) -> Iterator[str]:
    """The slices `signals._salary_amounts` hands the credential guard: the lowered text from the
    start of a number's line up to the number. One per digit-run start, a superset of the salary
    matches."""
    lower = text.lower()
    for digit in re.finditer(r"(?<!\d)\d", lower):
        start = digit.start()
        yield lower[lower.rfind("\n", 0, start) + 1 : start]


def differences(text: str, against: str = "shipped") -> list[str]:
    """The rules whose matches on ``text`` differ between unfolded and ``against``; empty if
    none."""
    moved = []
    for name in RULES:
        unfolded, other = variant(name, "unfolded"), variant(name, against)
        if spans(unfolded, text) != spans(other, text):
            moved.append(name)
    base_guard = variant("credential_before", "unfolded")
    guard = variant("credential_before", against)
    for piece in guard_slices(text):
        base_hit, hit = base_guard.search(piece), guard.search(piece)
        if (base_hit and base_hit.span()) != (hit and hit.span()):
            moved.append("credential_before (a guard slice)")
            break
    return moved


def stretched(text: str) -> str:
    """Each whitespace run three characters longer, in three kinds: the shape the unfolded
    connector split many ways, on real text."""
    return re.sub(r"\s+", lambda m: m.group(0) + " \t\u00a0", text)


def spaced(text: str) -> str:
    """A space on each side of every ":", "-" and "#": the "no :" and "# -" shapes, where a
    whitespace run sits between two of the connector's optional tokens. Few corpus strings have
    them as written."""
    return re.sub(r"([:#\-])", r" \1 ", text)


#: The views of a corpus string the comparisons run on.
VIEWS: dict[str, Callable[[str], str]] = {
    "as written": lambda text: text,
    "stretched": stretched,
    "spaced separators": spaced,
}


# --- corpus -------------------------------------------------------------------------------------

#: Each source of the corpus: a repo-relative directory and the file suffixes read under it. The
#: service's code and tests (prompts, docstrings, fixtures), the lexicon's sources and parity
#: corpus, the shared hard-identifier fixture, and the question packs and job-domain corpus.
CORPUS_SOURCES: dict[str, tuple[str, tuple[str, ...]]] = {
    "ai_service_code": ("apps/ai-service/app", (".py",)),
    "ai_service_tests": ("apps/ai-service/tests", (".py",)),
    "lexicon_data": ("apps/ai-service/app/profiling/lexicon_data", (".json", ".jsonl")),
    "lexicon_fixtures": ("packages/profiling-lexicon/__fixtures__", (".json", ".jsonl")),
    "ai_contract_fixtures": ("packages/ai-contracts/src/__fixtures__", (".json", ".jsonl")),
    "question_packs": ("packages/db/data/question-packs", (".json", ".jsonl")),
    "job_domains": ("packages/db/data/job-domains", (".json", ".jsonl")),
}
#: The #1933, #1950, #2043, #2049 and #2091 test files, left out so no fix is measured against
#: its own fixtures. (#2043's holds "Passport.No. M123456" and #2049's "Licence. 098765
#: 43210", which #1950's dot reads by design.)
EXCLUDED_FILES = frozenset(
    {
        "test_pseudonymize_cued_id_linear.py",
        "test_pseudonymize_cued_id_dot.py",
        "test_salary_guard_resume_cues.py",
        "test_pseudonymize_cued_id_monotone.py",
        "test_pseudonymize_cued_id_two_word.py",
    }
)


def corpus_files() -> dict[str, list[Path]]:
    """The files each source reads: git-tracked only, less `EXCLUDED_FILES`."""
    return {
        name: [
            path
            for path in tracked(directory, *suffixes, exclude=False)
            if path.name not in EXCLUDED_FILES
        ]
        for name, (directory, suffixes) in CORPUS_SOURCES.items()
    }


def corpus() -> dict[str, list[str]]:
    """Every distinct string of the repo's own tracked text these rules can meet, by source."""
    parts = {
        name: py_strings(p for p in paths if p.suffix == ".py")
        + json_strings(p for p in paths if p.suffix != ".py")
        for name, paths in corpus_files().items()
    }
    return {name: sorted(set(strings)) for name, strings in parts.items()}


# --- the seeded cue-line generator --------------------------------------------------------------

CUES = [
    "roll", "reg", "regd", "registration", "certificate", "cert", "enrolment", "enrollment",
    "licence", "license", "ncvt", "scvt", "nsqf", "nsdc", "passport", "voter", "gstin", "uan",
    "esic", "provident fund", "provident \t fund", "ifsc", "a/c", "account", "dob",
    "date of birth", "regn", "certificates", "xreg", "registered",
]  # fmt: skip
# Each list leads with the real forms, repeated so they dominate, then the near-misses.
#: Straight after the cue word: #1950's abbreviation dot ("Reg.No."), and ".." as a near miss.
CUE_DOTS = ["", "", "", "", ".", ".", ".."]
POSSESSIVES = ["", "", "", "", " ka", " ki", " ke", " mera", " meri", "  ka", " kaa", "ka", " kab"]
NUMBER_WORDS = [
    "", "", "", "no", "no.", "No.", "number", "NUMBER", "num", "#", "id", "ID", "nO", "n", "numb",
    "nos",
]  # fmt: skip
SEPARATORS = ["", "", "", ":", ":", "-", "-", "::", "--", ":-", ".", ";"]
SPACES = [" ", " ", " ", "\t", "\n", "\u00a0", "\u3000", "\r"]
VALUES = [
    "R/2019/123456", "MH2019CN4471", "NAPS/2020/44521", "123456", "ABCD1234EF", "DL04201100",
    "M123456", "ABC123456", "12/05/1988", "/2019/12", "-123456", "12345", "1234", "ABCDE",
    "ABC12", "A1", "chahiye", "hai", "", "!", "[ID_1]", "x" * 70 + "1", "1" + "a" * 70,
    "ab" * 12 + "9", "ab" * 13 + "9",
]  # fmt: skip
TAILS = ["", "", " hai", ",", " 5000", "\n25000", " salary 18000", "/", "-x"]
VALUE_CHARS = "abcXYZ0189/-:#. "
LEADS = ["", "", "mera ", "NCVT hai, ", "abhi 25000 milta hai, ", "x", "5"]


def _whitespace(rng: random.Random) -> str:
    return "".join(rng.choice(SPACES) for _ in range(rng.choice([0, 0, 1, 1, 2, 3, 5])))


def _cased(rng: random.Random, word: str) -> str:
    style = rng.randrange(4)
    if style == 1:
        return word.upper()
    if style == 2:
        return word.title()
    if style == 3:
        return "".join(c.upper() if rng.random() < 0.5 else c for c in word)
    return word


def _value(rng: random.Random) -> str:
    if rng.random() < 0.75:
        return rng.choice(VALUES)
    return "".join(rng.choice(VALUE_CHARS) for _ in range(rng.randint(0, 30)))


def cue_line_parts(rng: random.Random) -> dict[str, str]:
    """One cue line, slot by slot in reading order, so a caller can rewrite a single slot
    (`scripts/measure_cued_id_dot.py` compares each line with and without the dot)."""
    return {
        "cue": _cased(rng, rng.choice(CUES)),
        "dot": rng.choice(CUE_DOTS),
        "possessive": rng.choice(POSSESSIVES),
        "space before number": _whitespace(rng),
        "number": _cased(rng, rng.choice(NUMBER_WORDS)),
        "space before separator": _whitespace(rng),
        "separator": rng.choice(SEPARATORS),
        "space before value": _whitespace(rng),
        "value": _value(rng),
        "tail": rng.choice(TAILS),
    }


def sample(rng: random.Random) -> str:
    """One to three cue lines: every cue of the three rules (and near-misses such as
    "certificates" and "xreg") in four casings, with or without the abbreviation dot, the
    possessive slot, every "no" word and separator plus near-misses, whitespace runs of up to 5 of
    8 kinds in each of the connector's three slots, and values with and without digits, short and
    past each lookahead's bound."""
    lines = ("".join(cue_line_parts(rng).values()) for _ in range(rng.randint(1, 3)))
    return rng.choice(LEADS) + " ".join(lines)


# --- parity -------------------------------------------------------------------------------------


def _end_to_end(text: str) -> tuple[object, ...]:
    return (
        gateway.pseudonymize(text),
        gateway.contains_hard_identifier(text),
        signals.detect(text),
    )


def parity(against: str, fuzz: int) -> None:
    parts = corpus()
    strings = distinct(parts)
    print(f"corpus: {len(strings):,} distinct strings")
    print("  by source: " + ", ".join(f"{k} {len(v):,}" for k, v in parts.items()))
    views = {**VIEWS, "upper-cased": str.upper}
    for view, transform in views.items():
        moved = [(t, d) for t in strings if (d := differences(transform(t), against))]
        print(f"regex  {view:17}: {len(moved):,} of {len(strings):,} strings move")
        for text, rules_moved in moved[:5]:
            print(f"    {text[:70]!r}: {rules_moved}")
    rng = random.Random(1933)
    samples = [sample(rng) for _ in range(fuzz)]
    moved_fuzz = [(t, d) for t in samples if (d := differences(t, against))]
    print(f"regex  {'fuzz':17}: {len(moved_fuzz):,} of {fuzz:,} seeded samples move")
    for text, rules_moved in moved_fuzz[:5]:
        print(f"    {text[:70]!r}: {rules_moved}")
    cued = [t for t in strings if ANY_CUE.search(t) and len(t) <= gateway.DEFAULT_MAX_LENGTH]
    texts = [transform(t) for transform in VIEWS.values() for t in cued]
    with rules("unfolded"):
        base = [_end_to_end(t) for t in texts]
    with rules(against):
        new = [_end_to_end(t) for t in texts]
    labels = ("pseudonymize", "contains_hard_identifier", "signals.detect")
    for index, label in enumerate(labels):
        changed = sum(b[index] != n[index] for b, n in zip(base, new, strict=True))
        print(f"e2e    {label:24}: {changed:,} of {len(texts):,} cue-bearing texts change")


# --- timing -------------------------------------------------------------------------------------

ENTRY_POINTS: dict[str, tuple[Callable[[str], object], str, str]] = {
    "pseudonymize": (gateway.pseudonymize, "reg", ""),
    "contains_hard_identifier": (gateway.contains_hard_identifier, "passport", ""),
    "profile_extractor.extract": (profile_extractor.extract, "reg", "5000"),
}


def _once_ms(fn: Callable[[str], object], text: str, which: str) -> float:
    with rules(which):
        start = time.perf_counter()
        fn(text)
        return (time.perf_counter() - start) * 1000


def timing(reps: int) -> None:
    print(f"python {sys.version.split()[0]}; min of {reps} interleaved runs, in ms")
    print(f"{'entry point':26} {'spaces':>7} {'unfolded':>10} {'shipped':>9}")
    for label, (fn, cue, tail) in ENTRY_POINTS.items():
        for run in (200, 400, 800):
            text = cue + " " * run + "!" + tail
            cells: dict[str, list[float]] = {"unfolded": [], "shipped": []}
            for _ in range(reps):
                for which in cells:
                    cells[which].append(_once_ms(fn, text, which))
            fastest = {which: min(times) for which, times in cells.items()}
            print(f"{label:26} {run:7,} {fastest['unfolded']:10.1f} {fastest['shipped']:9.1f}")
        run = gateway.DEFAULT_MAX_LENGTH - len(cue) - 1 - len(tail)
        text = cue + " " * run + "!" + tail
        best = min(_once_ms(fn, text, "shipped") for _ in range(reps))
        print(f"{label:26} {run:7,} {'(skipped)':>10} {best:9.1f}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    par = sub.add_parser("parity")
    par.add_argument("--against", default="shipped", help="shipped (default) or loose")
    par.add_argument("--fuzz", type=int, default=60_000)
    sub.add_parser("timing").add_argument("reps", nargs="?", type=int, default=3)
    args = parser.parse_args()
    if args.command == "parity":
        parity(args.against, args.fuzz)
    else:
        timing(args.reps)


if __name__ == "__main__":
    main()
