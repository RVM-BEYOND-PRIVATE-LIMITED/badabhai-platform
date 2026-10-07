"""Reproduce #2049's measurements: the gateway masks every cue's value (risks-register R62).

    cd apps/ai-service && python scripts/measure_cued_id_monotone.py overmask
    cd apps/ai-service && python scripts/measure_cued_id_monotone.py fuzz [--samples N]
    cd apps/ai-service && python scripts/measure_cued_id_monotone.py timing [reps]

#2049 changes how the gateway SCANS with `_CREDENTIAL_ID_RE`, not the rule. The gateway ran the
rule as a non-overlapping `sub` ahead of the phone rule, so a value that ran on through a later cue
("Cert NAPS/2020/reg: 445566") hid that cue's own ID, and a value that ended inside a spaced phone
("Licence 098765 43210") left the phone's tail raw. `_cued_id_values` now masks the value the rule
matches from every cue start, each grown to the end of a phone run it cuts.

OLD is the scan as #1950 left it: the rule's non-overlapping matches, their value spans
(`old_values`), swapped in for `_cued_id_values` by `old_scan()`. Its masked text is the old
gateway's, byte for byte: a value holds a digit and its cue and connector hold none, so masking the
value's span is what replacing the value inside the match did.

overmask  #1875's over-mask method on #1950's corpus (`measure_cued_id_dot.corpus()`, git-tracked
          files only, the cued-ID test files left out): every cue-bearing string, in each of
          #1950's four views, through `pseudonymize` under OLD and shipped. Every string whose
          result changes is printed with both. Then every certifier label (#1891's set: the
          vocabulary and both lexicon copies, as written, UPPER and Title) through the three
          walls. G1/G2 and the salary detector never read the scan, so they cannot move.
fuzz      `--samples` (default 60,000) seeded lines of one to four of #1933's cue lines, glued by
          a space, "/", "-", ", " or nothing, and some ending in a spaced number (`chained`).
          1. ONLY MORE: every source offset OLD masks, shipped masks (`masked_offsets`, read from
             the gateway's own record of what each mask covered).
          2. MONOTONE: every offset inside a value the rule matches from ANY offset, or inside a
             phone run, is masked by shipped (`oracle`, a brute-force scan from every offset).
             Lines OLD left short of the oracle are the R62 shape; their count is the rate.
timing    Shipped and OLD on the many-cue and chained shapes at the size cap, the minimum of
          `reps` runs.

Stdlib and git only. The counts depend on the commit: re-run them on the one you are judging.
"""

from __future__ import annotations

import argparse
import random
import sys
import time
from collections import Counter
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import measure_cued_id_dot as dot  # noqa: E402
import measure_cued_id_linear as linear  # noqa: E402
from measure_title_employer_bound import certifier_labels, distinct  # noqa: E402
from measure_title_employer_bound import corpus as employer_corpus  # noqa: E402

import app.pseudonymize as gateway  # noqa: E402

# --- OLD: the scan as #1950 left it --------------------------------------------------------------


def old_values(text: str) -> list[tuple[int, int]]:
    """The value spans of `_CREDENTIAL_ID_RE`'s non-overlapping matches: what `sub` masked."""
    return [match.span(1) for match in gateway._CREDENTIAL_ID_RE.finditer(text)]


@contextmanager
def old_scan() -> Iterator[None]:
    """The gateway with OLD's scan swapped in, restored on exit."""
    shipped = gateway._cued_id_values
    gateway._cued_id_values = old_values
    try:
        yield
    finally:
        gateway._cued_id_values = shipped


def masked_offsets(text: str) -> tuple[set[int], bool]:
    """The offsets of ``text`` the gateway masks, read from its own region record (`_mask` with
    `track=True`, which masks exactly as the fast path does), and whether it blocks."""
    result, regions = gateway._mask(gateway._View(text, list(range(len(text)))), track=True)
    return set().union(*regions) if regions else set(), result.blocked


#: The rules `_mask` runs before the cued-ID scan, in its order: the scan reads their output.
#: `test_the_rules_ahead_of_the_scan_are_these` pins the order against `_mask`'s source.
EARLIER = ("_EMAIL_RE", "_PAN_RE", "_AADHAAR_RE")
#: What an earlier rule's mask reads as here. A token's brackets are no value, digit, phone
#: separator or word character, so to every rule the scan runs a token is a barrier; so is this.
BARRIER = "■"


def scan_input(text: str) -> str:
    """``text`` as the cued-ID scan reads it, offsets kept: each earlier rule's match becomes a run
    of `BARRIER`, where the gateway writes a token."""
    for name in EARLIER:
        text = getattr(gateway, name).sub(lambda m: BARRIER * len(m.group()), text)
    return text


def oracle(text: str) -> set[int]:
    """Every offset inside a value `_CREDENTIAL_ID_RE` matches from ANY offset, overlapping or not,
    or inside a phone run, on the text the scan reads: what no cue's reading may leave raw. Brute
    force, by construction independent of the scan it judges."""
    text = scan_input(text)
    covered: set[int] = set()
    for start in range(len(text)):
        if match := gateway._CREDENTIAL_ID_RE.match(text, start):
            covered.update(range(*match.span(1)))
    for match in gateway._PHONE_RE.finditer(text):
        covered.update(range(*match.span()))
    return covered


# --- overmask ------------------------------------------------------------------------------------


def changes(texts: list[str]) -> list[tuple[str, object, object]]:
    """Each text whose `pseudonymize` result differs between OLD and shipped, with both."""
    with old_scan():
        before = [gateway.pseudonymize(t) for t in texts]
    after = [gateway.pseudonymize(t) for t in texts]
    return [(t, b, a) for t, b, a in zip(texts, before, after, strict=True) if b != a]


def certifier_moves(labels: list[str]) -> list[str]:
    """Each certifier label whose outcome at any of the three walls differs between OLD and
    shipped."""
    with old_scan():
        before = [dot._certify(label) for label in labels]
    after = [dot._certify(label) for label in labels]
    return [label for label, b, a in zip(labels, before, after, strict=True) if b != a]


def overmask() -> None:
    parts = dot.corpus()
    strings = distinct(parts)
    cued = dot.cue_bearing(strings)
    labels = certifier_labels(employer_corpus())
    print(f"corpus: {len(strings):,} distinct strings, {len(cued):,} cue-bearing")
    for view, transform in dot.VIEWS.items():
        moved = changes([transform(t) for t in cued])
        print(f"{view:17}: {len(moved):,} of {len(cued):,} cue-bearing strings change")
        for text, before, after in moved:
            print(f"    {text[:90]!r}")
            print(f"      OLD     {before.text[:80]!r} blocked={before.blocked}")
            print(f"      shipped {after.text[:80]!r} blocked={after.blocked}")
    moved_labels = certifier_moves(labels)
    print(f"certifiers       : {len(moved_labels):,} of {len(labels):,} labels change outcome")
    for label in moved_labels:
        print(f"    {label!r}")


# --- fuzz ----------------------------------------------------------------------------------------

#: What joins one cue line to the next: a space (#1933's generator), or the glue that lets a value
#: run on into the next cue ("/" and "-" are in the value's class).
GLUES = [" ", " ", "/", "/", "-", ", ", ""]
#: What may follow the last line: nothing, or a number a value can cut ("098765 43210"), short or
#: phone-long, with the separators the phone rule reads.
NUMBER_TAILS = [
    "", "", "", " 43210", " 4321", " 98765 43210", " 43210", ".43210", " 1234 5678",
    " 56789012",
]  # fmt: skip


def chained(rng: random.Random) -> str:
    """One to four of #1933's cue lines, each line's tail dropped half the time so the next cue is
    glued straight onto its value, then a number that may continue the last value as a phone."""
    lines = []
    for _ in range(rng.randint(1, 4)):
        parts = linear.cue_line_parts(rng)
        if rng.random() < 0.5:
            parts["tail"] = ""
        lines.append("".join(parts.values()))
    text = rng.choice(linear.LEADS) + lines[0]
    for line in lines[1:]:
        text += rng.choice(GLUES) + line
    return text + rng.choice(NUMBER_TAILS)


def judge(text: str) -> dict[str, bool]:
    """What one line shows: shipped masking less than OLD anywhere (`less`), shipped missing an
    oracle offset (`short`), OLD missing one (`old short`, the R62 shape), a block that became a
    mask, and whether anything moved."""
    with old_scan():
        old_masked, old_blocked = masked_offsets(text)
        old_text = gateway.pseudonymize(text).text
    new_masked, new_blocked = masked_offsets(text)
    must = oracle(text)
    return {
        "less": not old_masked <= new_masked,
        "short": not new_blocked and not must <= new_masked,
        "old short": not old_blocked and not must <= old_masked,
        "block became a mask": old_blocked and not new_blocked,
        "moved": old_text != gateway.pseudonymize(text).text,
    }


def fuzz(samples: int) -> None:
    rng = random.Random(2049)
    seen: Counter[str] = Counter()
    for _ in range(samples):
        text = chained(rng)
        verdict = judge(text)
        seen.update(name for name, hit in verdict.items() if hit)
        if verdict["less"] or verdict["short"]:
            print(f"  FAIL {text[:90]!r} {verdict}")
    print(f"over {samples:,} seeded lines: {dict(seen)}")


# --- timing --------------------------------------------------------------------------------------

#: The shapes the every-start scan meets most cues on, at the size cap: many cues inside one token
#: (each starts inside the last value), the R62 shapes repeated, and #1933's and #1950's worst
#: connector shapes.
TIMING_INPUTS: dict[str, str] = {
    '"reg-1-" * 3333': "reg-1-" * 3_333,
    '"reg-" * 5000': "reg-" * 5_000,
    '"Cert 12/reg: 445566 " * 950': "Cert 12/reg: 445566 " * 950,
    '"Licence 098765 43210 " * 952': "Licence 098765 43210 " * 952,
    '"reg 123456 " * 1818': "reg 123456 " * 1_818,
    '"reg" + spaces + "!"': "reg" + " " * 19_996 + "!",
    '"Regn." * 4000': "Regn." * 4_000,
}


def _once_ms(fn: Callable[[str], object], text: str) -> float:
    start = time.perf_counter()
    fn(text)
    return (time.perf_counter() - start) * 1000


def timing(reps: int) -> None:
    print(f"python {sys.version.split()[0]}; min of {reps} interleaved runs of pseudonymize, in ms")
    print(f"{'input':32} {'chars':>7} {'OLD':>8} {'shipped':>8}")
    for label, text in TIMING_INPUTS.items():
        cells: dict[str, list[float]] = {"OLD": [], "shipped": []}
        for _ in range(reps):
            with old_scan():
                cells["OLD"].append(_once_ms(gateway.pseudonymize, text))
            cells["shipped"].append(_once_ms(gateway.pseudonymize, text))
        print(f"{label:32} {len(text):7,} {min(cells['OLD']):8.1f} {min(cells['shipped']):8.1f}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("overmask")
    sub.add_parser("fuzz").add_argument("--samples", type=int, default=60_000)
    sub.add_parser("timing").add_argument("reps", nargs="?", type=int, default=3)
    args = parser.parse_args()
    if args.command == "overmask":
        overmask()
    elif args.command == "fuzz":
        fuzz(args.samples)
    else:
        timing(args.reps)


if __name__ == "__main__":
    main()
