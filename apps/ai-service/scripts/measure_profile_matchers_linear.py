"""Reproduce #1935's measurements of the experience and salary matchers (risks-register R55).

    cd apps/ai-service && python scripts/measure_profile_matchers_linear.py parity
    cd apps/ai-service && python scripts/measure_profile_matchers_linear.py parity --against loose
    cd apps/ai-service && python scripts/measure_profile_matchers_linear.py timing [reps]

Two `/profile/extract` detectors read worker text with a regex that is O(k^2) on a whitespace run
(lexicon `experience.json` and `salary.json` `matcher`, shared with `packages/profiling-lexicon`):

- experience: `\\s*\\+?\\s*` between the number and the unit. #1935 writes `\\s*(?:\\+\\s*)?`.
- salary: an optional currency word, then `\\s*`, then a digit. Every position of a run started a
  match that scanned to the run's end. #1935 writes the lead
  `(?:(?:₹|rs\\.?|inr)\\s*|(?<!\\s)\\s+)?`: a bare run is read only from its first character.

MAIN is each shipped matcher with main's text put back (`SWAPS`), nothing else touched.

parity   Main against the shipped matchers (or `--against loose`, a sensitivity variant that drops
         the space after the plus and the lead's whitespace: it must move spans, or the harness
         cannot see a change).
         1. Regex level, every match's whole span and every group's span (`spans`), over every
            distinct string of the repo's tracked text (`corpus()`, the #1933 sources: the service's
            code and tests, the lexicon mirror and fixtures, the question packs and job domains) in
            each of `VIEWS` and over `--fuzz` seeded samples (`sample`, default 60,000).
         2. End to end over the same texts that either matcher touches: `signals.detect` and the
            `values` normalizers that read the matchers.
timing   Main against the shipped matchers on `profile_extractor.extract`, interleaved, the minimum
         of `reps` runs (default 3). Main skips the inputs that took 25 s or more.

Corpus readers are imported from the #1933 and #1891 scripts, git-tracked files only. Stdlib and
git only. The counts depend on the commit: re-run them on the one you are judging.
"""

from __future__ import annotations

import argparse
import random
import re
import sys
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from functools import cache
from pathlib import Path

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from measure_cued_id_linear import CORPUS_SOURCES  # noqa: E402
from measure_title_employer_bound import (  # noqa: E402
    distinct,
    json_strings,
    py_strings,
    tracked,
)

from app.profiling import lexicon, profile_extractor, signals, values  # noqa: E402

# --- the two matchers ---------------------------------------------------------------------------

#: name -> (signals attribute, lexicon spec). The spec is the shipped one, read from the mirror.
MATCHERS: dict[str, tuple[str, dict[str, str]]] = {
    "experience": ("_EXPERIENCE_RE", signals._EXPERIENCE["matcher"]),
    "salary": ("_SALARY_RE", signals._SALARY["matcher"]),
}
#: name -> (the shipped text, main's text, the loose sensitivity variant's text).
SWAPS: dict[str, tuple[str, str, str]] = {
    "experience": (r"\s*(?:\+\s*)?", r"\s*\+?\s*", r"\s*\+?"),
    "salary": (
        r"(?:(?:₹|rs\.?|inr)\s*|(?<!\s)\s+)?([",
        r"(?:₹|rs\.?|inr)?\s*([",
        r"(?:(?:₹|rs\.?|inr)\s*)?([",
    ),
}
VARIANTS = ("shipped", "main", "loose")


def source(name: str, which: str) -> str:
    """The matcher's source with its connector set to `which`."""
    shipped_source = MATCHERS[name][1]["source"]
    connector = SWAPS[name][VARIANTS.index(which)]
    if shipped_source.count(SWAPS[name][0]) != 1:
        raise AssertionError(f"{name}: the shipped connector is not in the lexicon exactly once")
    return shipped_source.replace(SWAPS[name][0], connector)


@cache
def variant(name: str, which: str) -> re.Pattern[str]:
    spec = MATCHERS[name][1]
    return lexicon.compile_pattern({"source": source(name, which), "flags": spec["flags"]})


@contextmanager
def matchers(which: str) -> Iterator[None]:
    """Swap the `which` matchers into `signals` (where `values` reads them too)."""
    saved = {name: getattr(signals, attr) for name, (attr, _) in MATCHERS.items()}
    try:
        for name, (attr, _) in MATCHERS.items():
            setattr(signals, attr, variant(name, which))
        yield
    finally:
        for name, (attr, _) in MATCHERS.items():
            setattr(signals, attr, saved[name])


def spans(pattern: re.Pattern[str], text: str) -> list[tuple[tuple[int, int], ...]]:
    """Every match `finditer` yields: its whole span and each group's span. `search`, the
    experience reader, returns the first of these."""
    return [tuple(m.span(g) for g in range(pattern.groups + 1)) for m in pattern.finditer(text)]


def differences(text: str, against: str = "shipped") -> list[str]:
    """The matchers whose spans differ between main and `against` on `text`."""
    return [
        name
        for name in MATCHERS
        if spans(variant(name, "main"), text) != spans(variant(name, against), text)
    ]


# --- views and corpus ---------------------------------------------------------------------------

_RUN = re.compile(r"\s+")


def stretched(text: str) -> str:
    """Every whitespace run tripled, kinds kept: the run lengths the old connectors split."""
    return _RUN.sub(lambda m: m.group() * 3, text)


def spaced_plus(text: str) -> str:
    """A space on each side of every "+": the "5 + saal" shape, rare as written."""
    return text.replace("+", " + ")


#: The views of a corpus string the comparisons run on.
VIEWS: dict[str, Callable[[str], str]] = {
    "as written": lambda text: text,
    "stretched": stretched,
    "spaced plus": spaced_plus,
    "upper-cased": str.upper,
}
#: The #1935 test file, left out so the fix is not measured against its own fixtures.
EXCLUDED_FILES = frozenset({"test_profile_matchers_linear.py"})


def corpus() -> dict[str, list[str]]:
    """Every distinct string of the repo's own tracked text, by source."""
    parts: dict[str, list[str]] = {}
    for name, (directory, suffixes) in CORPUS_SOURCES.items():
        paths = [
            p for p in tracked(directory, *suffixes, exclude=False) if p.name not in EXCLUDED_FILES
        ]
        strings = py_strings(p for p in paths if p.suffix == ".py") + json_strings(
            p for p in paths if p.suffix != ".py"
        )
        parts[name] = sorted(set(strings))
    return parts


# --- the seeded phrase generator ----------------------------------------------------------------

NUMBERS = [
    "5", "2", "10", "12", "1.5", "2.5", "0.5", "99", "100", "५", "१२", "२.५", "15000", "15,000",
    "1,20,000", "२५०००", "25000.50", "3", "8", "18", "2026", "1999", ".5", "5.", "123456789",
]  # fmt: skip
#: Every lexicon number word, then near-misses the matcher must not read as numbers.
EXP_WORDS = [w["word"] for w in signals._EXPERIENCE["wordNumbers"]] + [
    "one", "five", "dhaii", "eks", "Adhai", "DO",
]  # fmt: skip
EXP_UNITS = ["years", "year", "yrs", "yr", "saal", "sal", "Saal", "YEARS", "salo", "sall", "yearly"]
SAL_UNITS = [
    "", "", "k", "K", "thousand", "hazaar", "hazar", "hajar", "hzr", "lakh", "lac", "l", "L",
    "kiya", "lakhs", "hazaar/-",
]  # fmt: skip
CURRENCIES = ["", "", "", "₹", "rs", "Rs.", "RS", "rs.", "inr", "INR", "rupaye", "rupees", "₹."]
PLUSES = ["", "", "", "+", "+", "++"]
SPACES = [" ", " ", " ", "\t", "\n", " ", "　", "\r"]
LEADS = [
    "", "", "mera ", "mujhe ", "experience ", "anubhav ", "salary ", "abhi ", "pichhle ", "x",
    "5", ".", "maine ", "I have ", "total ",
]  # fmt: skip
TAILS = [
    "", "", " ka experience hai", " se kaam kar raha hun", " milta hai", " chahiye",
    " per month", " mahina", " saal ka", "/-", ".", ",", " aur 5000 bonus", "\n25000 chahiye",
]  # fmt: skip


def _ws(rng: random.Random) -> str:
    return "".join(rng.choice(SPACES) for _ in range(rng.choice([0, 0, 1, 1, 1, 2, 3, 6])))


def _experience(rng: random.Random) -> str:
    number = rng.choice(NUMBERS + EXP_WORDS)
    return number + _ws(rng) + rng.choice(PLUSES) + _ws(rng) + rng.choice(EXP_UNITS)


def _salary(rng: random.Random) -> str:
    return (
        rng.choice(CURRENCIES) + _ws(rng) + rng.choice(NUMBERS) + _ws(rng) + rng.choice(SAL_UNITS)
    )


def sample(rng: random.Random) -> str:
    """One to three experience or salary phrases: Hindi, Hinglish and English leads and tails,
    digits (ASCII and Devanagari) and number words, every unit plus near-misses, "+" forms
    ("5+ years", "5 + saal", "5 ++ yrs"), every currency word plus unrecognised ones ("rupaye"),
    and whitespace runs of up to 6 of 8 kinds in every slot."""
    parts = []
    for _ in range(rng.randint(1, 3)):
        phrase = _experience(rng) if rng.random() < 0.5 else _salary(rng)
        parts.append(rng.choice(LEADS) + phrase + rng.choice(TAILS))
    return _ws(rng).join(parts) if rng.random() < 0.5 else " ".join(parts)


# --- parity -------------------------------------------------------------------------------------


def touched(text: str) -> bool:
    """Whether either matcher, main's or shipped, matches anywhere in `text`."""
    return any(variant(n, w).search(text) for n in MATCHERS for w in ("main", "shipped"))


def end_to_end(text: str) -> tuple[object, ...]:
    """Everything downstream that reads the two matchers."""
    return (
        signals.detect(text),
        values.parse_experience_years(text),
        values.salary_expected(text),
        values.salary_current(text),
        values.parse_salary_monthly(text),
    )


def parity(against: str, fuzz: int) -> None:
    parts = corpus()
    strings = distinct(parts)
    print(f"corpus: {len(strings):,} distinct strings")
    print("  by source: " + ", ".join(f"{k} {len(v):,}" for k, v in parts.items()))
    for view, transform in VIEWS.items():
        moved = [(t, d) for t in strings if (d := differences(transform(t), against))]
        print(f"regex  {view:12}: {len(moved):,} of {len(strings):,} strings move")
        for text, names in moved[:5]:
            print(f"    {text[:70]!r}: {names}")
    rng = random.Random(1935)
    samples = [sample(rng) for _ in range(fuzz)]
    moved_fuzz = [(t, d) for t in samples if (d := differences(t, against))]
    print(f"regex  {'fuzz':12}: {len(moved_fuzz):,} of {fuzz:,} seeded samples move")
    for text, names in moved_fuzz[:5]:
        print(f"    {text[:70]!r}: {names}")
    texts = [t for t in [v(s) for v in VIEWS.values() for s in strings] + samples if touched(t)]
    with matchers("main"):
        base = [end_to_end(t) for t in texts]
    with matchers(against):
        new = [end_to_end(t) for t in texts]
    changed = sum(b != n for b, n in zip(base, new, strict=True))
    print(f"e2e    detect + values: {changed:,} of {len(texts):,} matcher-touched texts change")


# --- timing -------------------------------------------------------------------------------------

#: label -> (input, whether main runs it). Main is skipped where it took 25 s or more.
TIMING_INPUTS: dict[str, tuple[str, bool]] = {
    "'adhai' + 5,000 spaces + '5'": ("adhai" + " " * 5_000 + "5", True),
    "'adhai' + 10,000 spaces + '5'": ("adhai" + " " * 10_000 + "5", True),
    "'5' + (2,000 spaces, '+') x2": ("5" + " " * 2_000 + "+" + " " * 2_000 + "!", True),
    "'hello' + 8,000 spaces + 'world'": ("hello" + " " * 8_000 + "world", True),
    "'hello' + 16,000 spaces + 'world'": ("hello" + " " * 16_000 + "world", False),
    "'rs' + 19,990 spaces + '!'": ("rs" + " " * 19_990 + "!", False),
    "'x' + 19,990 spaces + '5000'": ("x" + " " * 19_990 + "5000", False),
}


def once_ms(text: str, which: str) -> float:
    with matchers(which):
        start = time.perf_counter()
        profile_extractor.extract(text)
        return (time.perf_counter() - start) * 1000


def timing(reps: int) -> None:
    print(f"python {sys.version.split()[0]}; profile_extractor.extract, min of {reps} runs, ms")
    print(f"{'input':36} {'main':>10} {'shipped':>9}")
    for label, (text, run_main) in TIMING_INPUTS.items():
        cells: dict[str, list[float]] = {"main": [], "shipped": []}
        for _ in range(reps):
            for which in cells:
                if which == "main" and not run_main:
                    continue
                cells[which].append(once_ms(text, which))
        main_cell = f"{min(cells['main']):10.1f}" if cells["main"] else f"{'(skipped)':>10}"
        print(f"{label:36} {main_cell} {min(cells['shipped']):9.1f}")


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
