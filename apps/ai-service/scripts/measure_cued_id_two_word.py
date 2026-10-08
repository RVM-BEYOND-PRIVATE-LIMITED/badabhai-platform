"""Reproduce #2091's measurements of the two-word label (risks-register R56).

    cd apps/ai-service && python scripts/measure_cued_id_two_word.py overmask
    cd apps/ai-service && python scripts/measure_cued_id_two_word.py fuzz [--samples N]
    cd apps/ai-service && python scripts/measure_cued_id_two_word.py timing [reps]

The cued-ID connector read ONE number word after the cue, so a label written as two words never
reached its value: "Voter ID No: XYZ9876543" and "IFSC code HDFC0004321" passed the G1/G2 floor
under both `AI_RAW_PII_ENABLED` postures and their digits were recorded as pay, and the gateway's
`_CREDENTIAL_ID_RE` had no "id" word at all ("Registration ID 123456" stayed raw). #2091 puts up to
two label words in front of the number word, in all five copies (`_CREDENTIAL_ID_RE`,
`_RESUME_CUED_ID_RE`, lexicon `credentialBefore` and its mirror, the two TypeScript ports): "id",
then "card" or "code", each its own optional token with its own trailing `\\s*` (#1933's fold).
The "id" word, which the résumé rule and the salary guard read in the "no"-word group, moved to the
first label slot. Owner ruling 2026-10-08: these three words, in all five copies.

PRE is each rule as it shipped before #2091, frozen here as text (`PRE_2091`). `apply_2091` rewrites
it with exactly #2091's edits (`EDITS_2091`), and a test pins that the result IS the shipped rule,
so PRE and shipped differ by #2091 and nothing else. `pre_rules()` swaps PRE into the modules.

overmask  #1875's method, on #1950's corpus and views (`measure_cued_id_dot`): every cue-bearing
          string of the git-tracked corpus, as written, whitespace stretched, separators spaced
          and upper-cased, through `pseudonymize`, `contains_hard_identifier` and `signals.detect`
          under PRE and shipped. Every string whose result changes is printed with both results.
          Then every certifier label (#1891's set) through the three walls under both.
fuzz      `--samples` (default 60,000) seeded lines of #1933's cue-line generator with the
          "no"-word slot given a label phrase half of the time (`label`): "id", "card" or "code"
          and a number word in some order, glued or spaced, and near misses ("cards", "codes").
          1. ONLY MORE: every offset the gateway masks under PRE it masks under shipped, except
             connector text PRE swallowed into a value ("code123456" masked whole; shipped reads
             "code" and masks "123456"), which holds no digit and ends where a shipped mask
             starts; every text G1/G2 refuses under PRE it refuses; every slice the salary guard
             drops under PRE it drops. A block that becomes a mask is counted apart.
          2. ATTRIBUTED: every line whose decisions move holds a label word (`NEW_SHAPE`).
          3. FOLDED: on every line, each rule's matches equal its unfolded twin's
             (`measure_cued_id_linear.differences`), so #1933's property holds on the new tokens.
timing    The shipped rules on the new tokens' worst shapes at the size cap, the minimum of
          `reps` runs.

Stdlib and git only. The counts depend on the commit: re-run them on the one you are judging.
"""

from __future__ import annotations

import argparse
import random
import re
import sys
import time
from collections import Counter
from collections.abc import Callable
from contextlib import AbstractContextManager
from pathlib import Path

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import measure_cued_id_dot as dot  # noqa: E402
import measure_cued_id_linear as linear  # noqa: E402
import measure_cued_id_monotone as monotone  # noqa: E402
from measure_title_employer_bound import certifier_labels, distinct  # noqa: E402
from measure_title_employer_bound import corpus as employer_corpus  # noqa: E402

import app.pseudonymize as gateway  # noqa: E402
from app.profiling import lexicon, profile_extractor, signals  # noqa: E402

# --- PRE: each rule as it shipped before #2091 ----------------------------------------------------

#: Each rule's text before #2091 (origin/main e06bf1ff): #1933's fold, #1950's tokens and, on the
#: salary guard, #2043's résumé cues. `credential_before` is the lexicon source, `{WB}`/`{WE}`
#: unexpanded, compiled through the lexicon loader like the shipped guard.
PRE_2091: dict[str, str] = {
    "credential_id": (
        r"(?i:\b(?:roll|reg|regd|regn|registration|certificate|cert|enrol(?:l)?ment|licence|license)"
        r"\b\.?"
        r"(?:\s+(?:ka|ki|ke|mera|meri))?"
        r"\s*(?:(?:no\.?|number|num|#)\s*)?(?:[:\-]-?\s*)?)"
        r"(?=[A-Za-z0-9/\-]{0,64}\d)"
        r"([A-Za-z0-9][A-Za-z0-9/\-]{5,})"
    ),
    "resume_cued_id": (
        r"\b(?:passport|voter|gstin|uan|esic|provident\s+fund|ifsc|"
        r"a/c|account|dob|date\s+of\s+birth)\b\.?"
        r"\s*(?:(?:no\.?|number|num|id|#)\s*)?(?:[:\-]-?\s*)?"
        r"(?=[A-Za-z0-9/\-]{0,24}\d)"
        r"[A-Za-z0-9][A-Za-z0-9/\-]{4,}"
    ),
    "credential_before": (
        r"{WB}(?:roll|reg|regd|regn|registration|certificate|cert|enrol(?:l)?ment|licence|license|"
        r"ncvt|scvt|nsqf|nsdc|passport|voter|gstin|uan|provident\s+fund|ifsc|dob|date\s+of\s+birth)"
        r"{WE}\.?(?:\s+(?:ka|ki|ke|mera|meri))?\s*(?:(?:no\.?|number|num|id|#)\s*)?"
        r"(?:[:-]-?\s*)?[A-Za-z0-9/-]{0,20}$"
    ),
}
#: The label words and the number word after them, as every rule ships them.
LABELS_2091 = r"(?:id\s*)?(?:(?:card|code)\s*)?(?:(?:no\.?|number|num|#)\s*)?"
#: #2091's edits, as (old, new) pairs applied to `PRE_2091`; each `old` occurs exactly once. The
#: credential rule gains the "id" word; the other two move it out of the "no"-word group.
EDITS_2091: dict[str, tuple[tuple[str, str], ...]] = {
    "credential_id": ((r"(?:(?:no\.?|number|num|#)\s*)?", LABELS_2091),),
    "resume_cued_id": ((r"(?:(?:no\.?|number|num|id|#)\s*)?", LABELS_2091),),
    "credential_before": ((r"(?:(?:no\.?|number|num|id|#)\s*)?", LABELS_2091),),
}


def apply_2091(name: str, text: str) -> str:
    """``text`` with #2091's edits for rule ``name``. Raises if an edit no longer lands once."""
    for old, new in EDITS_2091[name]:
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
    """Rule ``name`` as it shipped before #2091, compiled the way the shipped rule is."""
    if name == "credential_before":
        flags = lexicon.load("salary")["credentialBefore"]["flags"]
        return lexicon.compile_pattern({"source": PRE_2091[name], "flags": flags})
    return re.compile(PRE_2091[name], linear.shipped(name).flags)


def pre_rules() -> AbstractContextManager[None]:
    """The three modules with PRE swapped in, restored on exit."""
    return linear.swapped({name: pre(name) for name in linear.RULES})


# --- what the entry points decide on a text -------------------------------------------------------


def outcome(text: str) -> tuple[object, ...]:
    """The three entry points' results on ``text``, under whatever rules are swapped in."""
    return (
        gateway.pseudonymize(text),
        gateway.contains_hard_identifier(text),
        signals.detect(text),
    )


def guard_drops(text: str) -> list[bool]:
    """The salary guard's verdict on each slice the detector hands it."""
    return [bool(signals._CREDENTIAL_BEFORE_RE.search(p)) for p in linear.guard_slices(text)]


def decisions(text: str) -> tuple[object, ...]:
    """What the three rules decide on ``text``: the gateway's masked offsets and block, G1/G2's
    verdict, the guard's verdict on each slice."""
    return (
        monotone.masked_offsets(text),
        gateway.contains_hard_identifier(text),
        guard_drops(text),
    )


# --- overmask -------------------------------------------------------------------------------------


def changes(texts: list[str]) -> list[tuple[str, tuple[object, ...], tuple[object, ...]]]:
    """Each text whose `outcome` differs between PRE and shipped, with both outcomes."""
    with pre_rules():
        before = [outcome(t) for t in texts]
    after = [outcome(t) for t in texts]
    return [(t, b, a) for t, b, a in zip(texts, before, after, strict=True) if b != a]


def certifier_moves(labels: list[str]) -> list[str]:
    """Each certifier label whose outcome at any of the three walls differs between PRE and
    shipped."""
    with pre_rules():
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
            print(f"      PRE     {dot._describe(before)}")
            print(f"      shipped {dot._describe(after)}")
    moved_labels = certifier_moves(labels)
    print(f"certifiers       : {len(moved_labels):,} of {len(labels):,} labels change outcome")
    for label in moved_labels:
        print(f"    {label!r}")


# --- fuzz -----------------------------------------------------------------------------------------

#: A word #2091 reads and PRE did not: "card" or "code", or "id" (new to the credential rule, and a
#: second word's lead elsewhere). Over-approximate on purpose; the property is that nothing OUTSIDE
#: it moves. No `\b` in front of "id": the possessive slot may be glued to it ("kaID", "meraId").
#: "provident" is the one cue that holds "id", and the lookbehind keeps it out.
NEW_SHAPE = re.compile(r"(?i)(?<!prov)id|card|code")
IDS = ["id", "ID", "Id", "iD"]
CARDS = ["card", "Card", "CARD", "code", "Code", "CODE"]
NEAR_MISSES = ["cards", "codes", "idd", "car", "cod", "i.d.", "identity"]


def label(rng: random.Random) -> str:
    """A label phrase for the "no"-word slot: "id", "card"/"code" and a number word, each present
    or not, glued or spaced, sometimes out of order or with a near miss."""
    words = []
    if rng.random() < 0.7:
        words.append(rng.choice(IDS))
    if rng.random() < 0.6:
        words.append(rng.choice(CARDS))
    if rng.random() < 0.6:
        words.append(rng.choice(linear.NUMBER_WORDS))
    if rng.random() < 0.1:
        rng.shuffle(words)
    if rng.random() < 0.1:
        words.insert(rng.randrange(len(words) + 1), rng.choice(NEAR_MISSES))
    return "".join(word + linear._whitespace(rng) for word in words).rstrip()


def sample(rng: random.Random) -> str:
    """One to three of #1933's cue lines, the "no"-word slot a label phrase half of the time."""
    lines = []
    for _ in range(rng.randint(1, 3)):
        parts = linear.cue_line_parts(rng)
        if rng.random() < 0.5:
            parts["number"] = label(rng)
        lines.append("".join(parts.values()))
    return rng.choice(linear.LEADS) + " ".join(lines)


def lost_offsets(text: str, before: set[int], after: set[int]) -> list[str]:
    """The runs of offsets PRE masks and shipped does not, less connector text PRE swallowed into
    a value: a run that holds no digit and ends where a shipped mask starts."""
    runs: list[list[int]] = []
    for index in sorted(before - after):
        if runs and runs[-1][-1] == index - 1:
            runs[-1].append(index)
        else:
            runs.append([index])
    return [
        text[run[0] : run[-1] + 1]
        for run in runs
        if re.search(r"\d", text[run[0] : run[-1] + 1]) or run[-1] + 1 not in after
    ]


def judge(text: str) -> dict[str, bool]:
    """What #2091 changes on ``text``: whether shipped decides less than PRE anywhere, whether the
    decisions move, whether a block became a mask, and whether #1933's fold still holds."""
    with pre_rules():
        (old_mask, old_blocked), old_verdict, old_guard = decisions(text)
    (new_mask, new_blocked), new_verdict, new_guard = decisions(text)
    less = (
        bool(lost_offsets(text, old_mask, new_mask))
        or (old_verdict is not None and new_verdict is None)
        or any(o and not n for o, n in zip(old_guard, new_guard, strict=True))
    )
    return {
        "less": less,
        "moved": (old_mask, old_blocked, old_verdict, old_guard)
        != (new_mask, new_blocked, new_verdict, new_guard),
        "block became a mask": old_blocked and not new_blocked,
        "fold broken": bool(linear.differences(text)),
    }


def fuzz(samples: int) -> None:
    rng = random.Random(2091)
    seen: Counter[str] = Counter()
    for _ in range(samples):
        text = sample(rng)
        verdict = judge(text)
        for key in ("less", "block became a mask", "fold broken"):
            if verdict[key]:
                seen[key] += 1
                if key != "block became a mask":
                    print(f"  {key}: {text[:80]!r}")
        if verdict["moved"]:
            seen["moved"] += 1
            if not NEW_SHAPE.search(text):
                seen["moved without a label word"] += 1
                print(f"  unattributed: {text[:80]!r}")
        seen["G1/G2 refuses"] += gateway.contains_hard_identifier(text) is not None
    print(f"over {samples:,} samples: {dict(seen)}")


# --- timing ---------------------------------------------------------------------------------------

#: The new tokens' worst shapes, at the size cap: a whitespace run after each label word, and the
#: many-cue strings the lookahead bound exists for, each cue with its label words.
TIMING_INPUTS: dict[str, str] = {
    '"Voter ID" + spaces + "!"': "Voter ID" + " " * 19_991 + "!",
    '"voter id card no" + spaces + "!"': "voter id card no" + " " * 19_983 + "!",
    '"IFSC code" + spaces + "!"': "IFSC code" + " " * 19_990 + "!",
    '"reg id code" + spaces + "!"': "reg id code" + " " * 19_988 + "!",
    '"Reg ID-" * 2800': "Reg ID-" * 2_800,
    '"voter id card no:-" * 1100': "voter id card no:-" * 1_100,
    '"cert code " * 1900': "cert code " * 1_900,
}
ENTRY_POINTS: dict[str, Callable[[str], object]] = {
    "pseudonymize": gateway.pseudonymize,
    "contains_hard_identifier": gateway.contains_hard_identifier,
    "salary guard": lambda text: signals._CREDENTIAL_BEFORE_RE.search(text.lower()),
}
#: `profile_extractor.extract` at the size cap is the salary matcher's own quadratic scan, R55 (b),
#: so it runs on a 1,000-space run here, PRE beside shipped.
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
    print(f"{'shipped rules':36} {'chars':>7} " + " ".join(f"{n[:12]:>12}" for n in ENTRY_POINTS))
    for name, text in TIMING_INPUTS.items():
        cells = [_best_ms(fn, text, reps, under_pre=False) for fn in ENTRY_POINTS.values()]
        print(f"{name:36} {len(text):7,} " + " ".join(f"{cell:12.1f}" for cell in cells))
    print(f"{'profile_extractor.extract':36} {'chars':>7} {'PRE':>12} {'shipped':>12}")
    for cue in ("voter id card no", "IFSC code", "reg id"):
        text = cue + " " * EXTRACT_RUN + "!5000"
        before = _best_ms(profile_extractor.extract, text, reps, under_pre=True)
        after = _best_ms(profile_extractor.extract, text, reps, under_pre=False)
        print(f"{cue + ' + spaces + !5000':36} {len(text):7,} {before:12.1f} {after:12.1f}")


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
