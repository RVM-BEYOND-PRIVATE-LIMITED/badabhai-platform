"""Reproduce #1995's measurements of the job-posting chat's label tail, pay-clause splitter and
pay-range parser (risks-register R53 (d), (e) and (c)).

    cd apps/ai-service && python scripts/measure_job_chat_tail_pay_linear.py parity
    cd apps/ai-service && python scripts/measure_job_chat_tail_pay_linear.py parity --against loose
    cd apps/ai-service && python scripts/measure_job_chat_tail_pay_linear.py timing [reps]

Three `app/job_posting_chat/answers.py` regexes, run inline in `async def` on the payer's turn, were
O(k^2) on a whitespace run:

- `_LABEL_TAIL_RE` (d): `\\s+\\b(?:in|at|...)\\b.*$`, used with `.sub()`, started a scan at every
  position of a run. #1995 anchors it on the run's start: `(?<!\\s)\\s+\\b(?:...`.
- `_PAY_CLAUSE_BOUNDARY_RE` (e): its last arm `\\s+and\\s+` did the same. #1995 writes the arm in
  #1934's `_PHRASE_SPLIT_RE` shape, `(?<!\\s)\\n*[^\\S\\n]\\s*and\\s+`, listed first.
- `_PAY_RANGE_RE` (c): `\\s*` + optional suffix + `\\s*` after the low number, and `\\s*` +
  optional currency + `\\s*` before the high one. #1995 lets each optional token own its
  whitespace: `(?:\\s*SUFFIX)?\\s*` and `\\s*(?:CURRENCY\\s*)?`.

MAIN is each regex with main's text (`MAIN_SOURCES`), nothing else touched.

parity   Main against the shipped regexes (or `--against loose`, a sensitivity variant that must
         move results, or the harness cannot see a change).
         1. Regex level over every distinct string of the repo's tracked text (#1934's `corpus()`)
            in each of #1934's `VIEWS`, and over `--fuzz` seeded payer phrases (#1934's role and
            list phrases, and pay/location phrases from `pay_sample`, half each).
            - tail: the `.sub("", text)` result. Must be identical.
            - range: every `finditer` match's span and groups (`figure.end` is read). Identical.
            - clause: the boundaries, after merging boundaries that touch. The one allowed class
              is `merged`: main's boundaries differ only by being split where they touch (a
              newline-led run before "and"). And `_pay_clause` for every amount and range the
              text holds, under main's figures and the shipped ones. Identical.
         2. End to end: `detect_answers` with each of `TOPICS` on screen, over the same texts.
            Nothing may change.
timing   Main against the shipped regexes on `detect_answers`, interleaved, the minimum of `reps`.

Stdlib and git only. The counts depend on the commit: re-run them on the one you are judging.
"""

from __future__ import annotations

import argparse
import random
import re
import sys
import time
from collections import Counter
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from functools import cache
from pathlib import Path

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import measure_job_chat_parsers_linear as base  # noqa: E402

from app.job_posting_chat import answers  # noqa: E402

# --- the three regexes --------------------------------------------------------------------------

#: name -> `answers` attribute.
RULES: dict[str, str] = {
    "tail": "_LABEL_TAIL_RE",
    "clause": "_PAY_CLAUSE_BOUNDARY_RE",
    "range": "_PAY_RANGE_RE",
}
_N, _S, _W = answers._NUMBER, answers._SUFFIX, answers._SUFFIX_WORD
#: The "and" word set. #2088 added Hindi "aur" to the shipped clause and range regexes; MAIN and
#: LOOSE carry the same word set, so the comparison stays #1995's quadratic-vs-linear SHAPE.
_AND = r"(?:and|aur)"
_SEP = r"\s*(?:-|–|—|to|se|and|aur|upto|up to)\s*"
_TAIL_WORDS = r"(?:in|at|for|with|on|near|from|starting|salary|pay|shift|urgently|immediately|asap)"
#: name -> {variant: source}. `shipped` must equal the module's regex (`check_shipped`). The loose
#: variants are plausible wrong fixes: the tail anchored on a word character (`\b\s+`), so
#: "welder. in Pune" keeps its tail; the clause arm with `(?<!\s)` alone (R53's first probe for
#: (b)), which loses the "and" after a newline; the range with the suffix's whitespace dropped,
#: which loses "20 k - 25 k".
SOURCES: dict[str, dict[str, str]] = {
    "tail": {
        "shipped": r"(?<!\s)\s+\b" + _TAIL_WORDS + r"\b.*$",
        "main": r"\s+\b" + _TAIL_WORDS + r"\b.*$",
        "loose": r"\b\s+\b" + _TAIL_WORDS + r"\b.*$",
    },
    "clause": {
        "shipped": (
            r"(?<!\s)\n*[^\S\n]\s*"
            + _AND
            + r"\s+|[;\n]|(?<!\d),|,(?!\d)|\+|(?<![A-Za-z])plus(?![A-Za-z])"
        ),
        "main": r"[;\n]|(?<!\d),|,(?!\d)|\+|(?<![A-Za-z])plus(?![A-Za-z])|\s+" + _AND + r"\s+",
        "loose": (
            r"[;\n]|(?<!\d),|,(?!\d)|\+|(?<![A-Za-z])plus(?![A-Za-z])|(?<!\s)\s+" + _AND + r"\s+"
        ),
    },
    "range": {
        "shipped": (
            _N + r"(?:\s*" + _W + r")?" + _SEP + r"(?:(?:₹|rs\.?|inr)\s*)?" + _N + r"\s*" + _S
        ),
        "main": _N + r"\s*" + _S + _SEP + r"(?:₹|rs\.?|inr)?\s*" + _N + r"\s*" + _S,
        "loose": _N + _S + _SEP + r"(?:(?:₹|rs\.?|inr)\s*)?" + _N + r"\s*" + _S,
    },
}
VARIANTS = ("shipped", "main", "loose")


#: The module's own regexes, read once at import (before any swap).
SHIPPED: dict[str, re.Pattern[str]] = {name: getattr(answers, attr) for name, attr in RULES.items()}


def check_shipped() -> None:
    """The `shipped` sources are the module's regexes, or every comparison below is moot."""
    for name, attr in RULES.items():
        if SHIPPED[name].pattern != SOURCES[name]["shipped"]:
            raise AssertionError(f"{name}: the shipped source is not answers.{attr}")


@cache
def variant(name: str, which: str) -> re.Pattern[str]:
    # The sources are this module's own constants, never payer or request text.
    check_shipped()
    return re.compile(SOURCES[name][which], SHIPPED[name].flags)


@contextmanager
def regexes(which: str) -> Iterator[None]:
    """Swap the `which` regexes into `answers`, restored on exit."""
    saved = {name: getattr(answers, attr) for name, attr in RULES.items()}
    try:
        for name, attr in RULES.items():
            setattr(answers, attr, variant(name, which))
        yield
    finally:
        for name, attr in RULES.items():
            setattr(answers, attr, saved[name])


# --- difference classes -------------------------------------------------------------------------


def tail_class(text: str, against: str = "shipped") -> str | None:
    old, new = variant("tail", "main").sub("", text), variant("tail", against).sub("", text)
    return None if old == new else "unexplained"


def range_read(pattern: re.Pattern[str], text: str) -> list[tuple[object, ...]]:
    return [(m.span(), m.groups()) for m in pattern.finditer(text)]


def range_class(text: str, against: str = "shipped") -> str | None:
    old = range_read(variant("range", "main"), text)
    new = range_read(variant("range", against), text)
    return None if old == new else "unexplained"


def _merged(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for start, end in spans:
        if out and out[-1][1] == start:
            out[-1] = (out[-1][0], end)
        else:
            out.append((start, end))
    return out


def _figure_spans(text: str) -> set[tuple[int, int]]:
    """Every span `_pay_clause` could be asked about: each amount, and each range under main's
    regex and the shipped one."""
    spans = {m.span() for m in answers._AMOUNT_RE.finditer(text)}
    for which in ("main", "shipped"):
        spans |= {m.span() for m in variant("range", which).finditer(text)}
    return spans


def _clauses(text: str, which: str) -> list[str]:
    with regexes(which):
        return [
            answers._pay_clause(text, answers._PayFigure(s, e, 0, None, False))
            for s, e in sorted(_figure_spans(text))
        ]


def clause_class(text: str, against: str = "shipped") -> str | None:
    """None when main and `against` find the same boundaries; `merged` when they differ only by
    touching boundaries being one, and every clause `_pay_clause` returns is the same; else
    `unexplained`."""
    old = [m.span() for m in variant("clause", "main").finditer(text)]
    new = [m.span() for m in variant("clause", against).finditer(text)]
    if old == new:
        return None
    if _merged(old) == _merged(new) and _clauses(text, "main") == _clauses(text, against):
        return "merged"
    return "unexplained"


ALLOWED = {"tail": frozenset(), "range": frozenset(), "clause": frozenset({"merged"})}
CLASSIFIERS: dict[str, Callable[[str, str], str | None]] = {
    "tail": tail_class,
    "clause": clause_class,
    "range": range_class,
}


def classes(text: str, against: str = "shipped") -> dict[str, str]:
    found = {name: CLASSIFIERS[name](text, against) for name in RULES}
    return {name: cls for name, cls in found.items() if cls is not None}


def disallowed(text: str, against: str = "shipped") -> dict[str, str]:
    return {n: c for n, c in classes(text, against).items() if c not in ALLOWED[n]}


# --- the seeded pay / location phrase generator ---------------------------------------------------

PAY_CUES = [
    "", "", "salary", "Salary", "pay", "in hand", "inhand", "take home", "gross", "CTC", "ctc",
    "stipend", "Rs", "Rs.", "₹", "INR", "rupees", "wage", "SALARY",
]  # fmt: skip
AMOUNTS = [
    "20k", "20 k", "20K", "25000", "25,000", "1.5 lakh", "1.5lakh", "2 lakhs", "3 lac", "15 hazar",
    "18 thousand", "5", "8", "1998", "2005", "12000/-", "₹ 20000", "Rs 2000", "rs.15000", "20",
]  # fmt: skip
RANGE_SEPS = [
    "-", " - ", "–", "—", " to ", " se ", " and ", " upto ", " up to ", "to", " TO ", "  -  ",
    " to Rs ", " to ₹", "- inr ", " and\n", "\n and ",
]  # fmt: skip
PAY_TAILS = [
    "", "", " per month", " pm", " monthly", " p.m.", "/month", " /-", " in hand", " net",
    " + 2k bonus", " plus OT", ", OT extra 2000", " and PF", " and ESI", "\n and bonus 2k",
    "; food free", " bonus", " allowance 1500", " and 2 helpers",
]  # fmt: skip
CLAUSE_SEPS = [
    ", ", ",", "; ", "\n", " + ", "+", " plus ", " and ", " AND ", "\n and ", "\n\nand ",
    " \n and ", "\r\n and ", "\nand ", " ,and ", " ", "\t and\t",
]  # fmt: skip
PLACES = [
    "plant is in Pune", "site is in Chakan", "in Pune", "at Chakan", "located in Thane",
    "based in Nashik", "near Andheri", "location is Bhosari MIDC", "city is Indore",
    "need welder in Pune", "need welder. in Pune", "hiring CNC operators at Chakan salary 20k",
    "need fitter for night shift", "need helper urgently", "require driver with licence",
    "need 5 CNC operators in Pune at 20k", "the plant is in Chakan for a client",
    "need welder\nin Pune", "plant is in Pune\n", "need electrician starting Monday",
    "need cook from Monday", "need AC technician asap", "need welder.in Pune",
]  # fmt: skip


def _ws(rng: random.Random) -> str:
    return base._ws(rng) or " "


def _pay(rng: random.Random) -> str:
    cue = rng.choice(PAY_CUES)
    if rng.random() < 0.5:
        figure = rng.choice(AMOUNTS) + rng.choice(RANGE_SEPS) + rng.choice(AMOUNTS)
    else:
        figure = rng.choice(AMOUNTS)
    if rng.random() < 0.3:
        figure = figure.replace(" ", _ws(rng))
    return (cue + _ws(rng) if cue else "") + figure + rng.choice(PAY_TAILS)


def pay_sample(rng: random.Random) -> str:
    """A payer's pay or location answer: cues, amounts with every suffix, ranges with every
    separator (and a currency between), add-on tails, clauses joined by every boundary (",", ";",
    newline, "+", "plus", "and" with newline-led runs), role and location cues with every tail
    word, and whitespace runs of up to 6 of 8 kinds."""
    parts = [_pay(rng) if rng.random() < 0.7 else rng.choice(PLACES)]
    for _ in range(rng.choice([0, 0, 1, 1, 2, 3])):
        part = _pay(rng) if rng.random() < 0.6 else rng.choice(PLACES)
        sep = rng.choice(CLAUSE_SEPS)
        if rng.random() < 0.3:
            sep = _ws(rng) + sep.strip() + _ws(rng)
        parts.append(sep + part)
    text = "".join(parts)
    return text.upper() if rng.random() < 0.1 else text


def sample(rng: random.Random) -> str:
    """Half #1934's role and list phrases, half `pay_sample`."""
    return base.sample(rng) if rng.random() < 0.5 else pay_sample(rng)


# --- parity -------------------------------------------------------------------------------------

#: The questions on screen the end-to-end run answers. None is the cross-topic read (the pay band
#: is read in passing on every turn with a money cue).
TOPICS: tuple[str | None, ...] = (None, "role_title", "location_label", "pay_range")


def end_to_end(text: str) -> tuple[dict[str, object | None], ...]:
    return tuple(answers.detect_answers(text, topic) for topic in TOPICS)


def e2e_changes(texts: list[str], against: str = "shipped") -> list[tuple[str, str]]:
    """(text, what moved) for every `detect_answers` result that differs. None may."""
    with regexes("main"):
        before = [end_to_end(t) for t in texts]
    with regexes(against):
        after = [end_to_end(t) for t in texts]
    out: list[tuple[str, str]] = []
    for text, b_all, a_all in zip(texts, before, after, strict=True):
        for topic, b, a in zip(TOPICS, b_all, a_all, strict=True):
            if b != a:
                out.append((text, f"{topic}: {b} -> {a}"))
    return out


def report(label: str, texts: list[str], against: str) -> None:
    counts: Counter[str] = Counter()
    examples: dict[str, list[str]] = {}
    moved = 0
    for text in texts:
        found = classes(text, against)
        moved += bool(found)
        for name, cls in found.items():
            counts[f"{name}:{cls}"] += 1
            examples.setdefault(f"{name}:{cls}", []).append(text)
    summary = ", ".join(f"{k} {v:,}" for k, v in sorted(counts.items())) or "no differences"
    print(f"regex  {label:12}: {moved:,} of {len(texts):,} move ({summary})")
    for key in sorted(examples):
        for text in examples[key][:3]:
            print(f"    {key:22} {text[:70]!r}")


def parity(against: str, fuzz: int) -> None:
    parts = base.corpus()
    strings = base.distinct(parts)
    print(f"corpus: {len(strings):,} distinct strings")
    texts: list[str] = []
    for view, transform in base.VIEWS.items():
        viewed = [transform(s) for s in strings]
        report(view, viewed, against)
        texts += viewed
    rng = random.Random(1995)
    samples = [sample(rng) for _ in range(fuzz)]
    report("fuzz", samples, against)
    bad = [t for t in texts + samples if disallowed(t, against)]
    print(f"regex  unexplained  : {len(bad):,}")
    touched = [t for t in dict.fromkeys(texts + samples) if answers._HAS_ALNUM_RE.search(t)]
    changed = e2e_changes(touched, against)
    print(f"e2e    detect_answers x {TOPICS} over {len(touched):,} texts: {len(changed):,} changed")
    for text, why in changed[:5]:
        print(f"    {text[:50]!r}: {why[:120]}")


# --- timing -------------------------------------------------------------------------------------

#: The run lengths: R53's and the #1995 tests'.
RUNS = (5_000, 10_000, 20_000)
#: label -> (shape, the topic on screen). `{}` is the run. #1995's three inputs and R53 (c)'s.
SHAPES: dict[str, tuple[str, str | None]] = {
    "(d) role tail": ("need welder{}x", "role_title"),
    "(d) location tail": ("plant is in Pune{}x", "location_label"),
    "(e) pay clause": ("salary 20k bonus{}x", None),
    "(c) pay range": ("salary 20k 5{}!", None),
}


def once_ms(text: str, topic: str | None, which: str) -> float:
    with regexes(which):
        start = time.perf_counter()
        answers.detect_answers(text, topic)
        return (time.perf_counter() - start) * 1000


def timing(reps: int) -> None:
    print(f"python {sys.version.split()[0]}; detect_answers, min of {reps} runs, ms")
    print(f"{'input':20} {'k':>7} {'topic':>15} {'main':>10} {'shipped':>9}")
    for label, (shape, topic) in SHAPES.items():
        for k in RUNS:
            text = shape.format(" " * k)
            cells: dict[str, list[float]] = {"main": [], "shipped": []}
            for _ in range(reps):
                for which, runs in cells.items():
                    runs.append(once_ms(text, topic, which))
            print(
                f"{label:20} {k:7,} {topic or '-':>15} {min(cells['main']):10.1f} "
                f"{min(cells['shipped']):9.1f}"
            )


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
