"""Reproduce #1950's measurements of the dot after the cue (risks-register R56).

    cd apps/ai-service && python scripts/measure_cued_id_dot.py overmask
    cd apps/ai-service && python scripts/measure_cued_id_dot.py fuzz [--samples N]
    cd apps/ai-service && python scripts/measure_cued_id_dot.py timing [reps]

#1950 adds three tokens to the cued-ID rules, in all five copies (`_CREDENTIAL_ID_RE`,
`_RESUME_CUED_ID_RE`, lexicon `credentialBefore` and its mirror, the two TypeScript ports): `\\.?`
straight after the cue word, so "Reg.No." and "Regn. No." reach their value; "regn" among the
credential cues; and `-?` after the separator, so "No.:- 123456" reads ":-" as ":".

PRE is each rule as #1933 shipped it, frozen here as text (`PRE_1950`). `apply_1950` rewrites that
text with exactly #1950's edits (`EDITS_1950`), and a test pins that the result IS the shipped
rule, so PRE differs from the shipped rules by #1950 and nothing else. `pre_rules()` swaps PRE into
the modules.

overmask  #1875's over-mask method. The corpus is #1933's (`measure_cued_id_linear.corpus()`,
          git-tracked files only, both cued-ID test files left out) plus the SQL fixtures #1891's
          reader covers. Every cue-bearing string, in each of `VIEWS` (as written, upper-cased,
          whitespace stretched, separators spaced), runs through `pseudonymize`,
          `contains_hard_identifier` and `signals.detect` under PRE and shipped. Every string
          whose result changes is printed with both results. Then every certifier label (#1891's
          set: the vocabulary and both lexicon copies, as written, UPPER and Title) runs through
          the three walls under both.
fuzz      `--samples` (default 60,000) seeded cue lines (`measure_cued_id_linear.cue_line_parts`).
          1. ONLY MORE: every character PRE masks, shipped masks; every text G1/G2 refuses under
             PRE it refuses under shipped; every slice the salary guard drops under PRE it drops.
          2. ATTRIBUTED: every line whose result moves holds one of the new shapes (`NEW_SHAPE`).
          3. TRANSPARENT: a line with "." written straight after its cue word gives the same
             masked values and verdicts as the line without it, wherever the cue already ended on
             a boundary; "regn" reads as "reg"; ":-" as ":" and "--" as "-".
timing    The shipped rules on the new tokens' worst shapes, the minimum of `reps` runs.

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
from contextlib import AbstractContextManager
from pathlib import Path

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import measure_cued_id_linear as linear  # noqa: E402
from measure_title_employer_bound import (  # noqa: E402
    certifier_labels,
    distinct,
    sql_strings,
    tracked,
)
from measure_title_employer_bound import corpus as employer_corpus  # noqa: E402

import app.pseudonymize as gateway  # noqa: E402
from app.profiling import lexicon, profile_extractor, signals  # noqa: E402

# --- the oracle: each rule as #1933 shipped it ---------------------------------------------------

#: Each rule's text as #1933 shipped it (origin/main 32545450). `credential_before` is the lexicon
#: source, `{WE}` unexpanded, compiled through the lexicon loader like the shipped guard.
PRE_1950: dict[str, str] = {
    "credential_id": (
        r"(?i:\b(?:roll|reg|regd|registration|certificate|cert|enrol(?:l)?ment|licence|license)\b"
        r"(?:\s+(?:ka|ki|ke|mera|meri))?"
        r"\s*(?:(?:no\.?|number|num|#)\s*)?(?:[:\-]\s*)?)"
        r"(?=[A-Za-z0-9/\-]{0,64}\d)"
        r"([A-Za-z0-9][A-Za-z0-9/\-]{5,})"
    ),
    "resume_cued_id": (
        r"\b(?:passport|voter|gstin|uan|esic|provident\s+fund|ifsc|"
        r"a/c|account|dob|date\s+of\s+birth)\b"
        r"\s*(?:(?:no\.?|number|num|id|#)\s*)?(?:[:\-]\s*)?"
        r"(?=[A-Za-z0-9/\-]{0,24}\d)"
        r"[A-Za-z0-9][A-Za-z0-9/\-]{4,}"
    ),
    "credential_before": (
        r"(?:roll|reg|regd|registration|certificate|cert|enrol(?:l)?ment|licence|license|ncvt|"
        r"scvt|nsqf|nsdc){WE}(?:\s+(?:ka|ki|ke|mera|meri))?\s*(?:(?:no\.?|number|num|#)\s*)?"
        r"(?:[:-]\s*)?[A-Za-z0-9/-]{0,20}$"
    ),
}
#: #1950's edits, as (old, new) pairs applied to `PRE_1950`; each `old` occurs exactly once.
EDITS_1950: dict[str, tuple[tuple[str, str], ...]] = {
    "credential_id": (
        ("|regd|", "|regd|regn|"),
        (r"license)\b", r"license)\b\.?"),
        (r"(?:[:\-]\s*)?", r"(?:[:\-]-?\s*)?"),
    ),
    "resume_cued_id": (
        (r"birth)\b", r"birth)\b\.?"),
        (r"(?:[:\-]\s*)?", r"(?:[:\-]-?\s*)?"),
    ),
    "credential_before": (
        ("|regd|", "|regd|regn|"),
        ("nsdc){WE}", r"nsdc){WE}\.?"),
        (r"(?:[:-]\s*)?", r"(?:[:-]-?\s*)?"),
    ),
}


def apply_1950(name: str, text: str) -> str:
    """``text`` with #1950's edits for rule ``name``. Raises if an edit no longer lands once."""
    for old, new in EDITS_1950[name]:
        if text.count(old) != 1:
            raise ValueError(f"{name}: {old!r} occurs {text.count(old)} times, not once")
        text = text.replace(old, new)
    return text


def shipped_source(name: str) -> str:
    """The shipped rule's text: the gateway's pattern, or the lexicon source both engines read."""
    if name == "credential_before":
        return lexicon.load("salary")["credentialBefore"]["source"]
    return linear.shipped(name).pattern


def pre(name: str) -> re.Pattern[str]:
    """Rule ``name`` as #1933 shipped it, compiled the way the shipped rule is."""
    if name == "credential_before":
        flags = lexicon.load("salary")["credentialBefore"]["flags"]
        return lexicon.compile_pattern({"source": PRE_1950[name], "flags": flags})
    return re.compile(PRE_1950[name], linear.shipped(name).flags)


def pre_rules() -> AbstractContextManager[None]:
    """The three modules with PRE swapped in, restored on exit."""
    return linear.swapped({name: pre(name) for name in linear.RULES})


def variants() -> dict[str, dict[str, re.Pattern[str]]]:
    return {
        "pre": {name: pre(name) for name in linear.RULES},
        "shipped": {name: linear.shipped(name) for name in linear.RULES},
    }


# --- what each rule decides on a text -----------------------------------------------------------


def masked_spans(pattern: re.Pattern[str], text: str) -> list[tuple[int, int]]:
    """What the gateway masks with `_CREDENTIAL_ID_RE`: its value group, match by match."""
    return [m.span(1) for m in pattern.finditer(text)]


def masked_values(pattern: re.Pattern[str], text: str) -> list[str]:
    return [text[start:end] for start, end in masked_spans(pattern, text)]


def guard_verdicts(pattern: re.Pattern[str], text: str) -> list[bool]:
    """The salary guard's verdict on each slice the detector hands it (`guard_slices`)."""
    return [bool(pattern.search(piece)) for piece in linear.guard_slices(text)]


def decisions(rules: dict[str, re.Pattern[str]], text: str) -> tuple[object, ...]:
    """What the three rules decide on ``text``: the masked values, G1/G2's verdict, the guard's."""
    return (
        masked_values(rules["credential_id"], text),
        bool(rules["resume_cued_id"].search(text)),
        guard_verdicts(rules["credential_before"], text),
    )


def outcome(text: str) -> tuple[object, ...]:
    """The three entry points' results on ``text``, under whatever rules are swapped in."""
    return (
        gateway.pseudonymize(text),
        gateway.contains_hard_identifier(text),
        signals.detect(text),
    )


# --- corpus --------------------------------------------------------------------------------------

#: #1891's reader of the SQL fixtures, the one source of its corpus that #1933's does not read.
SQL_FIXTURES = ("apps/ai-service/tests/fixtures", ".sql")
#: The cue prefilter: #1933's, which already contains "reg", so "regn" needs no entry of its own.
ANY_CUE = linear.ANY_CUE
VIEWS: dict[str, Callable[[str], str]] = {**linear.VIEWS, "upper-cased": str.upper}


def corpus() -> dict[str, list[str]]:
    """#1933's corpus plus the SQL fixtures, by source; git-tracked files only."""
    parts = linear.corpus()
    parts["sql_fixtures"] = sorted(set(sql_strings(tracked(*SQL_FIXTURES))))
    return parts


def cue_bearing(strings: list[str]) -> list[str]:
    return [t for t in strings if ANY_CUE.search(t) and len(t) <= gateway.DEFAULT_MAX_LENGTH]


def changes(texts: list[str]) -> list[tuple[str, tuple[object, ...], tuple[object, ...]]]:
    """Each text whose `outcome` differs between PRE and shipped, with both outcomes."""
    with pre_rules():
        before = [outcome(t) for t in texts]
    after = [outcome(t) for t in texts]
    return [(t, b, a) for t, b, a in zip(texts, before, after, strict=True) if b != a]


def _certify(label: str) -> tuple[object, ...]:
    return (
        gateway.is_certified_clean(label),
        tuple(gateway.certify_value(label)),
        gateway.certified_clean_skill_labels([label]) == [label],
    )


def certifier_moves(labels: list[str]) -> list[str]:
    """Each certifier label whose outcome at any of the three walls differs between PRE and
    shipped."""
    with pre_rules():
        before = [_certify(label) for label in labels]
    after = [_certify(label) for label in labels]
    return [label for label, b, a in zip(labels, before, after, strict=True) if b != a]


def _describe(result: tuple[object, ...]) -> str:
    pseudo, verdict, sig = result
    return (
        f"text={pseudo.text[:60]!r} blocked={pseudo.blocked} hard={verdict} "
        f"pay={sig.current_salary} expected={sig.expected_salary}"
    )


def overmask() -> None:
    parts = corpus()
    strings = distinct(parts)
    cued = cue_bearing(strings)
    labels = certifier_labels(employer_corpus())
    print(f"corpus: {len(strings):,} distinct strings, {len(cued):,} cue-bearing")
    print("  by source: " + ", ".join(f"{k} {len(v):,}" for k, v in parts.items()))
    for view, transform in VIEWS.items():
        moved = changes([transform(t) for t in cued])
        print(f"{view:17}: {len(moved):,} of {len(cued):,} cue-bearing strings change")
        for text, before, after in moved:
            print(f"    {text[:90]!r}")
            print(f"      PRE     {_describe(before)}")
            print(f"      shipped {_describe(after)}")
    moved_labels = certifier_moves(labels)
    print(f"certifiers       : {len(moved_labels):,} of {len(labels):,} labels change outcome")
    for label in moved_labels:
        print(f"    {label!r}")


# --- fuzz ----------------------------------------------------------------------------------------

#: A shape #1950 reads and #1933 did not: a "." straight after a cue word, "regn", or a separator
#: followed by "-". Over-approximate on purpose ("xreg." holds it and moves nothing); the property
#: is that nothing OUTSIDE it moves.
NEW_SHAPE = re.compile(
    r"(?i)(?:roll|reg|regd|registration|certificate|cert|enrol(?:l)?ment|licence|license|ncvt"
    r"|scvt|nsqf|nsdc|passport|voter|gstin|uan|esic|provident\s+fund|ifsc|a/c|account|dob"
    r"|date\s+of\s+birth)\.|regn|[:\-]-"
)


def _covered(spans: list[tuple[int, int]]) -> set[int]:
    return {i for start, end in spans for i in range(start, end)}


def unmasked_by_shipped(text: str, rules: dict[str, dict[str, re.Pattern[str]]]) -> list[str]:
    """The characters PRE's `_CREDENTIAL_ID_RE` masks on ``text`` and shipped's does not, as
    runs. Each run must be CONNECTOR text PRE swallowed into the value because it could not read
    the doubled separator ("NO--abc9" masked whole; shipped reads "NO--" and masks "abc9"), so
    `only_more` requires every run to hold no digit and to end where a shipped value starts."""
    pre_mask = _covered(masked_spans(rules["pre"]["credential_id"], text))
    new_spans = masked_spans(rules["shipped"]["credential_id"], text)
    lost = sorted(pre_mask - _covered(new_spans))
    runs: list[list[int]] = []
    for index in lost:
        if runs and runs[-1][-1] == index - 1:
            runs[-1].append(index)
        else:
            runs.append([index])
    return [text[run[0] : run[-1] + 1] for run in runs if not _swallowed(text, run, new_spans)]


def _swallowed(text: str, run: list[int], new_spans: list[tuple[int, int]]) -> bool:
    piece = text[run[0] : run[-1] + 1]
    return not re.search(r"\d", piece) and any(start == run[-1] + 1 for start, _ in new_spans)


def only_more(text: str, rules: dict[str, dict[str, re.Pattern[str]]]) -> list[str]:
    """The rules on which shipped decides LESS than PRE on ``text``; empty when it only adds.
    The masked characters are compared modulo `unmasked_by_shipped`'s connector runs."""
    old, new = rules["pre"], rules["shipped"]
    lost = []
    if unmasked_by_shipped(text, rules):
        lost.append("credential_id")
    if old["resume_cued_id"].search(text) and not new["resume_cued_id"].search(text):
        lost.append("resume_cued_id")
    pre_guard = guard_verdicts(old["credential_before"], text)
    new_guard = guard_verdicts(new["credential_before"], text)
    if any(p and not n for p, n in zip(pre_guard, new_guard, strict=True)):
        lost.append("credential_before")
    return lost


def twins(rng: random.Random) -> Iterator[tuple[str, str, int, str]]:
    """(kind, line, at, insert) cases on which #1950 must decide alike on ``line`` and on its twin,
    ``line`` with ``insert`` written at ``at``: the dot after the cue word, "regn" for "reg", or the
    separator doubled into ":-" / "--". A case is yielded only where the line does not already hold
    the shape: the cue must end on a boundary that is not a dot (a word character or "." after it
    would make the line itself the new shape), and the doubled separator must not already be
    followed by "-". One exception is not #1950's: where the generator's separator is not the
    rule's (after "ID" in a credential line, say), the doubled dash lands inside the run the rule
    reads as the value, whose class holds "-", and can lengthen it past the six-character floor.
    #1933 decides that twin exactly as shipped does, so `fuzz` counts it apart."""
    lead = rng.choice(linear.LEADS)
    parts = linear.cue_line_parts(rng)
    parts["dot"] = ""
    line = lead + "".join(parts.values())
    after_cue = len(lead) + len(parts["cue"])
    if not re.match(r"[\w.]", line[after_cue:]):
        yield "dot", line, after_cue, "."
        if parts["cue"].lower() == "reg":
            yield "regn", line, after_cue, "n"
    slots = list(parts)
    upto = slots[: slots.index("separator") + 1]
    after_separator = len(lead) + sum(len(parts[slot]) for slot in upto)
    if parts["separator"] in (":", "-") and not line[after_separator:].startswith("-"):
        yield "separator", line, after_separator, "-"


def _back(spans: list[tuple[int, int]], at: int, width: int) -> list[tuple[int, int]]:
    """Spans on the twin mapped onto the line: positions past the insertion move back by its
    width, and a span that covers the inserted text shrinks by it."""

    def place(index: int) -> int:
        return index if index <= at else max(at, index - width)

    return [(place(start), place(end)) for start, end in spans]


def transparent(rules: dict[str, re.Pattern[str]], line: str, at: int, insert: str) -> bool:
    """The twin masks the line's characters (plus the inserted text where it sits inside a masked
    run), G1/G2 gives the same verdict, and the salary guard the same verdict on every slice."""
    twin = line[:at] + insert + line[at:]
    pattern = rules["credential_id"]
    return (
        _back(masked_spans(pattern, twin), at, len(insert)) == masked_spans(pattern, line)
        and bool(rules["resume_cued_id"].search(twin)) == bool(rules["resume_cued_id"].search(line))
        and guard_verdicts(rules["credential_before"], twin)
        == guard_verdicts(rules["credential_before"], line)
    )


def fuzz(samples: int) -> None:
    rules = variants()
    rng = random.Random(1950)
    seen: Counter[str] = Counter()
    for _ in range(samples):
        text = linear.sample(rng)
        if lost := only_more(text, rules):
            seen["LESS than PRE"] += 1
            print(f"  less: {text[:80]!r} {lost}")
        seen["connector text no longer masked"] += bool(
            _covered(masked_spans(rules["pre"]["credential_id"], text))
            - _covered(masked_spans(rules["shipped"]["credential_id"], text))
        )
        moved = decisions(rules["pre"], text) != decisions(rules["shipped"], text)
        seen["moved"] += moved
        if moved and not NEW_SHAPE.search(text):
            seen["moved without a new shape"] += 1
            print(f"  unattributed: {text[:80]!r}")
    print(f"only more / attributed over {samples:,} samples: {dict(seen)}")
    rng = random.Random(1950)
    kinds: Counter[str] = Counter()
    for _ in range(samples):
        for kind, line, at, insert in twins(rng):
            kinds[kind] += 1
            if transparent(rules["shipped"], line, at, insert):
                continue
            twin = line[:at] + insert + line[at:]
            if kind == "separator" and decisions(rules["pre"], twin) == decisions(
                rules["shipped"], twin
            ):
                kinds["separator: the dash lengthens a value run, as on #1933"] += 1
                continue
            kinds[f"{kind} NOT transparent"] += 1
            print(f"  {kind}: {line[:70]!r} at {at}")
    print(f"transparency cases: {dict(kinds)}")


# --- timing --------------------------------------------------------------------------------------

#: The new tokens' worst shapes, at the size cap: a whitespace run after the dot and after the
#: doubled separator, and the many-cue strings the lookahead bound exists for, each cue with its dot
#: or ":-".
TIMING_INPUTS: dict[str, str] = {
    '"Reg." + spaces + "!"': "Reg." + " " * 19_995 + "!",
    '"reg no:-" + spaces + "!"': "reg no:-" + " " * 19_991 + "!",
    '"Passport." + spaces + "!"': "Passport." + " " * 19_990 + "!",
    '"Regn." * 4000': "Regn." * 4_000,
    '"reg:-" * 4000': "reg:-" * 4_000,
    '"a/c.-" * 4000': "a/c.-" * 4_000,
}
#: The salary guard is applied to the text from a number's line start up to the number; the whole
#: input is its worst slice.
ENTRY_POINTS: dict[str, Callable[[str], object]] = {
    "pseudonymize": gateway.pseudonymize,
    "contains_hard_identifier": gateway.contains_hard_identifier,
    "salary guard": lambda text: signals._CREDENTIAL_BEFORE_RE.search(text.lower()),
}
#: `profile_extractor.extract` at the size cap is the salary matcher's own quadratic scan, R55 (b)
#: (about 6 s at 20,000 spaces under PRE and shipped alike), so it runs on a 1,000-space run here,
#: PRE beside shipped.
EXTRACT_RUN = 1_000


def _once_ms(fn: Callable[[str], object], text: str) -> float:
    start = time.perf_counter()
    fn(text)
    return (time.perf_counter() - start) * 1000


def _best_ms(fn: Callable[[str], object], text: str, reps: int, *, under_pre: bool) -> float:
    if under_pre:
        with pre_rules():
            return min(_once_ms(fn, text) for _ in range(reps))
    return min(_once_ms(fn, text) for _ in range(reps))


def timing(reps: int) -> None:
    print(f"python {sys.version.split()[0]}; min of {reps} runs, in ms")
    print(f"{'shipped rules':28} {'chars':>7} " + " ".join(f"{n[:12]:>12}" for n in ENTRY_POINTS))
    for label, text in TIMING_INPUTS.items():
        cells = [_best_ms(fn, text, reps, under_pre=False) for fn in ENTRY_POINTS.values()]
        print(f"{label:28} {len(text):7,} " + " ".join(f"{cell:12.1f}" for cell in cells))
    print(f"{'profile_extractor.extract':28} {'chars':>7} {'PRE':>12} {'shipped':>12}")
    for cue in ("Reg.", "reg no:-", "Regn.:-"):
        text = cue + " " * EXTRACT_RUN + "!5000"
        before = _best_ms(profile_extractor.extract, text, reps, under_pre=True)
        after = _best_ms(profile_extractor.extract, text, reps, under_pre=False)
        print(f"{cue + ' + spaces + !5000':28} {len(text):7,} {before:12.1f} {after:12.1f}")


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
