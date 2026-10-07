"""Measure #2050: a figure inside a phone-shaped run is not pay.

    cd apps/ai-service && python scripts/measure_salary_phone_chain.py corpus
    cd apps/ai-service && python scripts/measure_salary_phone_chain.py timing [reps]

The salary detector read digits split by a space or a dash as separate numbers, so a spaced phone's
groups were recorded as pay: "mera number 98765 43210 hai" gave a 98,765 current salary, and with a
want cue near it ("job chahiye mera number 98765 43210") the EXPECTED salary, which
/profile/extract stores in salary_expectation. #2050 skips every figure of a phone-shaped run
(lexicon `salary.json` `phoneChain`: 10+ digits on one line joined only by the separators a
phone is written with: spaces, tabs, dashes, brackets, a soft hyphen or a zero-width space)
unless the run is a pay range (two round, rising figures at most 5x apart: #1731's rule). Owner
decisions 2026-10-07: a space-joined pair counts as a range, and the run is ten digits.

BEFORE is the detector with the guard switched off (`no_guard()` makes `signals._phone_chains`
find no run; nothing else is touched), so BEFORE and shipped differ by #2050 alone.

corpus  Every text whose (current_salary, expected_salary) differs between BEFORE and shipped, over
        four corpora: PHONES (phone shapes the guard SHOULD silence), WAGES (wage lines it must
        leave alone, ranges included), LEXICON (the parity utterances) and REPO (every distinct
        string of the repo's tracked text, #1933's reader, holding a 10+ digit run of the
        guard's shape).
timing  `signals.detect`, BEFORE and shipped, on the guard's worst shapes at the size cap, the
        minimum of `reps` runs.

Stdlib and git only. All inputs are fabricated. Re-run on the commit you judge.
"""

from __future__ import annotations

import json
import sys
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

AI_SERVICE = Path(__file__).resolve().parents[1]
REPO = AI_SERVICE.parents[1]
sys.path.insert(0, str(AI_SERVICE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import measure_cued_id_linear as linear  # noqa: E402
from measure_title_employer_bound import distinct  # noqa: E402

from app.profiling import signals  # noqa: E402
from app.pseudonymize import DEFAULT_MAX_LENGTH  # noqa: E402


@contextmanager
def no_guard() -> Iterator[None]:
    """BEFORE: the detector with no phone-shaped run found, restored on exit."""
    shipped = signals._phone_chains
    signals._phone_chains = lambda text: []
    try:
        yield
    finally:
        signals._phone_chains = shipped


def reading(text: str) -> tuple[int | None, int | None]:
    detected = signals.detect(text)
    return detected.current_salary, detected.expected_salary


def moves(texts: list[str]) -> list[tuple[str, tuple[object, ...], tuple[object, ...]]]:
    """Each text whose reading differs between BEFORE and shipped, with both readings."""
    with no_guard():
        before = [reading(text) for text in texts]
    after = [reading(text) for text in texts]
    return [(t, b, a) for t, b, a in zip(texts, before, after, strict=True) if b != a]


# --- corpora -------------------------------------------------------------------------------------

#: Phone shapes the guard SHOULD silence: each recorded a figure as pay BEFORE.
PHONES = [
    "mera number 98765 43210 hai",
    "phone 98765-43210",
    "mera number 9876 543 210",
    "mera number 987 654 3210",
    "+91 98765 43210",
    "call 098765 43210",
    "whatsapp 98765 43210 pe",
    "number 98765–43210",
    "".join(chr(0x966 + int(c)) for c in "98765")
    + " "
    + "".join(chr(0x966 + int(c)) for c in "43210"),
    "(987) 654-3210",
    "(98765) 43210",
    "98765" + chr(0x2009) + "43210",
    "98765" + chr(0x200B) + "43210",
    "98765" + chr(0xAD) + "43210",
    "job chahiye mera number 98765 43210",
    "number 98765 43210, salary 25000",
    "salary 25000, number 98765 43210",
    "job chahiye, 20000 chahiye, mera number 98765 43210",
]
#: Wage lines the guard must leave as they were: ranges, both slots, two lines, money formats.
WAGES = [
    "15000-20000 chahiye",
    "15000 - 20000 chahiye",
    "18500-22000 milta hai",
    "60000-70000",
    "salary 15000 18000",
    "25000 30000 ke beech chahiye",
    "abhi 25000 milta hai, 30000 chahiye",
    "25,000 - 30,000 chahiye",
    "25000\n35000 chahiye",
    "5000 6000 milta hai",
    "15k-20k chahiye",
    "2.5 lakh saal ka",
    "1,20,000 saal ka",
    # Nine digits: a wage next to a small count (the run is ten digits, owner decision).
    "salary 18000 2023 se mil raha hai",
    "salary 20000 3000 overtime alag",
    "salary 25000 - 2000 pf",
    "salary 15000 1000 bonus",
    "salary 20000 10 12 ghante",
    # A slash is not a separator: a date before a wage.
    "1/4/2023 25000 milta hai",
]


def lexicon_texts() -> list[str]:
    path = REPO / "packages/profiling-lexicon/__fixtures__/utterances.jsonl"
    rows = (json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line)
    return [row["text"] for row in rows]


def repo_texts() -> list[str]:
    """Every distinct tracked string that holds a run the guard could claim (10+ digits joined
    by a phone's separators), at most the gateway's size cap."""
    strings = distinct(linear.corpus())
    return [
        text
        for text in strings
        if len(text) <= DEFAULT_MAX_LENGTH
        and any(
            sum(len(f) for f in signals._RUN_FIGURE_RE.findall(run.group()))
            >= signals._PHONE_CHAIN_MIN_DIGITS
            for run in signals._PHONE_CHAIN_RE.finditer(text)
        )
    ]


def corpus() -> None:
    for name, texts in (
        ("phones", PHONES),
        ("wages", WAGES),
        ("lexicon", lexicon_texts()),
        ("repo", repo_texts()),
    ):
        moved = moves(texts)
        print(f"{name:8}: {len(moved):,} of {len(texts):,} texts move")
        for text, before, after in moved:
            print(f"    {text[:80]!r}: {before} -> {after}")


# --- timing --------------------------------------------------------------------------------------

#: The guard's worst shapes at the size cap: one run that spans the text, a separator run that a
#: run start must scan, many short runs, many phone-length runs, and Devanagari digits.
TIMING_INPUTS: dict[str, str] = {
    '"1 " * 10000': "1 " * 10_000,
    '"1-" * 10000': "1-" * 10_000,
    '"1" + spaces + "x"': "1" + " " * 19_998 + "x",
    '"98765 43210 " * 1666': "98765 43210 " * 1_666,
    '"12345 a " * 2500': "12345 a " * 2_500,
    '"9" * 20000': "9" * 20_000,
    '"१ " * 10000': "१ " * 10_000,
}


def _once_ms(fn: Callable[[str], object], text: str) -> float:
    start = time.perf_counter()
    fn(text)
    return (time.perf_counter() - start) * 1000


def timing(reps: int) -> None:
    print(f"python {sys.version.split()[0]}; min of {reps} interleaved runs of signals.detect, ms")
    print(f"{'input':28} {'chars':>7} {'BEFORE':>8} {'shipped':>8}")
    for label, text in TIMING_INPUTS.items():
        cells: dict[str, list[float]] = {"BEFORE": [], "shipped": []}
        for _ in range(reps):
            with no_guard():
                cells["BEFORE"].append(_once_ms(signals.detect, text))
            cells["shipped"].append(_once_ms(signals.detect, text))
        before, shipped = min(cells["BEFORE"]), min(cells["shipped"])
        print(f"{label:28} {len(text):7,} {before:8.1f} {shipped:8.1f}")


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "corpus"
    if command == "corpus":
        corpus()
    elif command == "timing":
        timing(int(sys.argv[2]) if len(sys.argv) > 2 else 3)
    else:
        raise SystemExit(f"unknown command {command!r}: use corpus or timing")


if __name__ == "__main__":
    main()
