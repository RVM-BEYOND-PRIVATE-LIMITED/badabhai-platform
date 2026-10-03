"""Reproduce #1933's measurements of the cued-ID connector (risks-register R54).

    cd apps/ai-service && python scripts/measure_cued_id_linear.py parity
    cd apps/ai-service && python scripts/measure_cued_id_linear.py parity --against loose
    cd apps/ai-service && python scripts/measure_cued_id_linear.py timing [reps]

Three rules shared one cue-to-value connector, `\\s*(?:no\\.?|number|num|#)?\\s*[:\\-]?\\s*`, which
is O(k^3) on a whitespace run: the gateway's `_CREDENTIAL_ID_RE`, G1/G2's `_RESUME_CUED_ID_RE`
(with an `id` word) and the salary detector's credential guard (`signals._CREDENTIAL_BEFORE_RE`,
lexicon `credentialBefore`). #1933 folds each quantifier into the optional token it follows:
`\\s*(?:(?:no\\.?|number|num|#)\\s*)?(?:[:\\-]\\s*)?`.

MAIN is each shipped rule with the linear connector put back to main's text and nothing else
touched, so the comparison isolates the connector and stays valid if a cue list later grows.
`main_rules()` swaps those patterns into the modules for the end-to-end runs.

parity   Main against the shipped rules (or `--against loose`, a sensitivity variant that drops
         the `\\s*` after the "no" word: it must move spans, or the harness cannot see a change).
         1. Regex level, over every distinct string of the repo's own text (`corpus()`) in each
            of `VIEWS` (as written, whitespace runs stretched, separators spaced) and
            upper-cased: each rule's matches (whole span and every group span) and the salary
            guard's verdict on every slice the detector hands it (`guard_slices`).
         2. The same over `--fuzz` samples (default 60,000) of the seeded cue-line generator.
         3. End to end, over every corpus string that holds a cue (`ANY_CUE`), in each of
            `VIEWS`: `pseudonymize`, `contains_hard_identifier` and `signals.detect`.
timing   Main against the shipped rules on a cue + whitespace run, interleaved in one process so
         machine load hits both alike, the minimum of `reps` runs (default 3). Main stops at 800
         spaces (1,600 took 13-20 s); the shipped rules also run at 20,000 characters, the size
         cap.

Stdlib only. The counts depend on the checkout: re-run them on the commit you are judging.
"""

from __future__ import annotations

import argparse
import ast
import json
import random
import re
import sys
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

AI_SERVICE = Path(__file__).resolve().parents[1]
REPO = AI_SERVICE.parents[1]
sys.path.insert(0, str(AI_SERVICE))

import app.pseudonymize as gateway  # noqa: E402
from app.profiling import profile_extractor, signals  # noqa: E402

# --- the three rules and their connectors -------------------------------------------------------

#: name -> (module, attribute, main's connector, the linear connector). The `credential_before`
#: text is the lexicon's, which writes the class `[:-]` with no escape (a JavaScript u-mode rule).
RULES: dict[str, tuple[object, str, str, str]] = {
    "credential_id": (
        gateway,
        "_CREDENTIAL_ID_RE",
        r"\s*(?:no\.?|number|num|#)?\s*[:\-]?\s*",
        r"\s*(?:(?:no\.?|number|num|#)\s*)?(?:[:\-]\s*)?",
    ),
    "resume_cued_id": (
        gateway,
        "_RESUME_CUED_ID_RE",
        r"\s*(?:no\.?|number|num|id|#)?\s*[:\-]?\s*",
        r"\s*(?:(?:no\.?|number|num|id|#)\s*)?(?:[:\-]\s*)?",
    ),
    "credential_before": (
        signals,
        "_CREDENTIAL_BEFORE_RE",
        r"\s*(?:no\.?|number|num|#)?\s*[:-]?\s*",
        r"\s*(?:(?:no\.?|number|num|#)\s*)?(?:[:-]\s*)?",
    ),
}
#: Every cue of the three rules contains one of these, matched the same case-insensitive way, so a
#: string with none of them can match no rule under either connector.
ANY_CUE = re.compile(
    r"(?i)roll|reg|cert|enrol|licen|ncvt|scvt|nsqf|nsdc|passport|voter|gstin|uan|esic|provident"
    r"|ifsc|a/c|account|dob|date\s+of\s+birth"
)


def shipped(name: str) -> re.Pattern[str]:
    module, attribute, _main, _linear = RULES[name]
    return getattr(module, attribute)


def _swap(name: str, replacement: str) -> re.Pattern[str]:
    pattern = shipped(name)
    _module, _attribute, _main, linear = RULES[name]
    if linear not in pattern.pattern:
        raise ValueError(f"{name}: the shipped rule no longer holds the linear connector")
    return re.compile(pattern.pattern.replace(linear, replacement), pattern.flags)


def variant(name: str, which: str) -> re.Pattern[str]:
    """`shipped`, `main` (main's connector put back) or `loose` (sensitivity: the "no" word's
    trailing `\\s*` dropped)."""
    if which == "shipped":
        return shipped(name)
    if which == "main":
        return _swap(name, RULES[name][2])
    if which == "loose":
        return _swap(name, RULES[name][3].replace(r"|#)\s*)?", r"|#))?"))
    raise SystemExit(f"unknown variant {which!r}: use shipped, main or loose")


@contextmanager
def rules(which: str) -> Iterator[None]:
    """The three modules with the `which` variant of each rule swapped in, restored on exit."""
    saved = {name: shipped(name) for name in RULES}
    replacements = {name: variant(name, which) for name in RULES}
    try:
        for name, pattern in replacements.items():
            module, attribute, _main, _linear = RULES[name]
            setattr(module, attribute, pattern)
        yield
    finally:
        for name, pattern in saved.items():
            module, attribute, _main, _linear = RULES[name]
            setattr(module, attribute, pattern)


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
    """The rules whose matches on ``text`` differ between main and ``against``; empty if none."""
    moved = []
    for name in RULES:
        main, other = variant(name, "main"), variant(name, against)
        if spans(main, text) != spans(other, text):
            moved.append(name)
    main_guard, guard = variant("credential_before", "main"), variant("credential_before", against)
    for piece in guard_slices(text):
        main_hit, hit = main_guard.search(piece), guard.search(piece)
        if (main_hit and main_hit.span()) != (hit and hit.span()):
            moved.append("credential_before (a guard slice)")
            break
    return moved


def stretched(text: str) -> str:
    """Each whitespace run three characters longer, in three kinds: the shape main's connector
    split many ways, on real text."""
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


def _walk_json(node: object, sink: list[str]) -> None:
    if isinstance(node, str):
        sink.append(node)
    elif isinstance(node, dict):
        for key, value in node.items():
            sink.append(key)
            _walk_json(value, sink)
    elif isinstance(node, list):
        for value in node:
            _walk_json(value, sink)


def json_strings(directory: Path) -> list[str]:
    """Every string in the `.json` and `.jsonl` files under ``directory``. A `.jsonl` line that is
    not JSON (a comment) is kept as text, as `measure_title_employer_bound.py` reads it."""
    out: list[str] = []
    for path in sorted(p for p in directory.rglob("*") if p.suffix in (".json", ".jsonl")):
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".json":
            _walk_json(json.loads(text), out)
            continue
        for line in text.splitlines():
            if not line.strip():
                continue
            try:
                _walk_json(json.loads(line), out)
            except json.JSONDecodeError:
                out.append(line)
    return out


#: The #1933 test file, left out so the fix is not measured against its own fixtures.
EXCLUDED_FILES = frozenset({"test_pseudonymize_cued_id_linear.py"})


def py_strings(directory: Path) -> list[str]:
    out: list[str] = []
    for path in sorted(directory.rglob("*.py")):
        if path.name in EXCLUDED_FILES:
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                out.append(node.value)
    return out


def corpus() -> dict[str, list[str]]:
    """Every distinct string of the repo's own text these rules can meet: the service's code and
    tests (prompts, docstrings, fixtures), the lexicon's sources and parity corpus, the shared
    hard-identifier fixture, and the question packs and job-domain corpus. A directory outside
    `apps/ai-service` that is absent (a partial checkout) contributes nothing."""
    packages = REPO / "packages"
    parts = {
        "ai_service_code": py_strings(AI_SERVICE / "app"),
        "ai_service_tests": py_strings(AI_SERVICE / "tests"),
        "lexicon_data": json_strings(AI_SERVICE / "app" / "profiling" / "lexicon_data"),
        "lexicon_fixtures": json_strings(packages / "profiling-lexicon" / "__fixtures__"),
        "ai_contract_fixtures": json_strings(packages / "ai-contracts" / "src" / "__fixtures__"),
        "question_packs": json_strings(packages / "db" / "data" / "question-packs"),
        "job_domains": json_strings(packages / "db" / "data" / "job-domains"),
    }
    return {name: sorted(set(strings)) for name, strings in parts.items()}


def distinct(parts: dict[str, list[str]]) -> list[str]:
    return sorted(set().union(*map(set, parts.values())))


# --- the seeded cue-line generator --------------------------------------------------------------

CUES = [
    "roll", "reg", "regd", "registration", "certificate", "cert", "enrolment", "enrollment",
    "licence", "license", "ncvt", "scvt", "nsqf", "nsdc", "passport", "voter", "gstin", "uan",
    "esic", "provident fund", "provident \t fund", "ifsc", "a/c", "account", "dob",
    "date of birth", "certificates", "xreg", "registered",
]  # fmt: skip
# Each list leads with the real forms, repeated so they dominate, then the near-misses.
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


def _cue_line(rng: random.Random) -> str:
    return "".join(
        [
            _cased(rng, rng.choice(CUES)),
            rng.choice(POSSESSIVES),
            _whitespace(rng),
            _cased(rng, rng.choice(NUMBER_WORDS)),
            _whitespace(rng),
            rng.choice(SEPARATORS),
            _whitespace(rng),
            _value(rng),
            rng.choice(TAILS),
        ]
    )


def sample(rng: random.Random) -> str:
    """One to three cue lines: every cue of the three rules (and near-misses such as
    "certificates" and "xreg") in four casings, the possessive slot, every "no" word and separator
    plus near-misses, whitespace runs of up to 5 of 8 kinds in each of the connector's three slots,
    and values with and without digits, short and past each lookahead's bound."""
    return rng.choice(LEADS) + " ".join(_cue_line(rng) for _ in range(rng.randint(1, 3)))


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
    with rules("main"):
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
    print(f"{'entry point':26} {'spaces':>7} {'main':>10} {'shipped':>9}")
    for label, (fn, cue, tail) in ENTRY_POINTS.items():
        for run in (200, 400, 800):
            text = cue + " " * run + "!" + tail
            cells: dict[str, list[float]] = {"main": [], "shipped": []}
            for _ in range(reps):
                for which in cells:
                    cells[which].append(_once_ms(fn, text, which))
            print(f"{label:26} {run:7,} {min(cells['main']):10.1f} {min(cells['shipped']):9.1f}")
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
