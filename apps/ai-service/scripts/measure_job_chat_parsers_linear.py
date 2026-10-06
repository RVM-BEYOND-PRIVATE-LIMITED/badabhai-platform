"""Reproduce #1934's measurements of the job-posting chat's role cue and phrase splitter (R53).

    cd apps/ai-service && python scripts/measure_job_chat_parsers_linear.py parity
    cd apps/ai-service && python scripts/measure_job_chat_parsers_linear.py parity --against loose
    cd apps/ai-service && python scripts/measure_job_chat_parsers_linear.py timing [reps]

Two `app/job_posting_chat/answers.py` parsers, run inline in `async def` on the payer's turn, were
O(k^2) on a whitespace run:

- `_ROLE_CUE_RE`: the cue's `\\s+`, then `(?:a|an|some|few|the)?\\s*`. A run that failed to match
  tried every split between the two quantifiers. The article also matched as a word PREFIX, so
  "need an operator" captured "n operator" (the article read as "a"). #1934 writes the article
  group `(?:(?:an?|some|few|the)\\s+)?`: the article owns its whitespace, and is a whole word.
- `_PHRASE_SPLIT_RE`: `\\s+and\\s+|\\s+aur\\s+` started a scan to the run's end at every position
  of the run. #1934 tries the "and"/"aur" arm only where a run starts.

MAIN is each shipped regex with main's text put back (`SWAPS`), nothing else touched.

parity   Main against the shipped regexes (or `--against loose`, a sensitivity variant that must
         move results, or the harness cannot see a change).
         1. Regex level over every distinct string of the repo's tracked text (`corpus()`: the
            #1933 sources plus the API's job-posting chat code and tests) in each of `VIEWS`, and
            over `--fuzz` seeded payer phrases (`sample`, default 60,000). Every difference is
            put in a class (`role_class`, `split_class`); `unexplained` must be 0.
            - role: the first match's whole span and group span (`search`, what `_parse_label`
              reads). The allowed classes are the intended fix: `an-read-as-a` ("need an
              operator") and `article-prefix` ("hiring assistants" captured "ssistants").
            - split: the `re.split` pieces. The allowed class is `empty-pieces`: the pieces
              differ only by empty strings, which `_clean_label` drops.
         2. End to end: `detect_answers` with each of `TOPICS` on screen, over the same texts.
            Only `role_title` may change, and only on a text whose role difference is allowed.
timing   Main against the shipped regexes on `detect_answers`, interleaved, the minimum of `reps`
         runs (default 3).

Corpus readers are imported from the #1933 and #1891 scripts, git-tracked files only. Stdlib and
git only. The counts depend on the commit: re-run them on the one you are judging.
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

from measure_cued_id_linear import CORPUS_SOURCES  # noqa: E402
from measure_title_employer_bound import (  # noqa: E402
    distinct,
    json_strings,
    py_strings,
    tracked,
)

from app.job_posting_chat import answers  # noqa: E402

# --- the two regexes ----------------------------------------------------------------------------

#: name -> `answers` attribute.
RULES: dict[str, str] = {"role": "_ROLE_CUE_RE", "split": "_PHRASE_SPLIT_RE"}
#: name -> (the shipped text, main's text, the loose sensitivity variant's text). The role swaps
#: the article group only; the splitter is swapped whole. The loose role drops the article (so
#: "need a welder" captures "a welder"); the loose splitter is R53's first probe, `(?<!\s)` alone,
#: which loses the "and" after a newline ("PF\n and ESI").
SWAPS: dict[str, tuple[str, str, str]] = {
    "role": (r"(?:(?:an?|some|few|the)\s+)?", r"(?:a|an|some|few|the)?\s*", ""),
    "split": (
        r"(?<!\s)\n*[^\S\n]\s*(?:and|aur)\s+|[,;/\n|+&]",
        r"[,;/\n|+&]|\s+and\s+|\s+aur\s+",
        r"[,;/\n|+&]|(?<!\s)\s+(?:and|aur)\s+",
    ),
}
VARIANTS = ("shipped", "main", "loose")
ARTICLES = frozenset({"a", "an", "some", "few", "the"})


def source(name: str, which: str) -> str:
    """The regex's source with its swapped part set to `which`."""
    shipped_source = getattr(answers, RULES[name]).pattern
    if shipped_source.count(SWAPS[name][0]) != 1:
        raise AssertionError(f"{name}: the shipped text is not in the regex exactly once")
    return shipped_source.replace(SWAPS[name][0], SWAPS[name][VARIANTS.index(which)])


@cache
def variant(name: str, which: str) -> re.Pattern[str]:
    # The sources are this module's own constants, never payer or request text.
    return re.compile(source(name, which), getattr(answers, RULES[name]).flags)


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


def role_read(pattern: re.Pattern[str], text: str) -> tuple[tuple[int, int], ...] | None:
    match = pattern.search(text)
    return None if match is None else (match.span(), match.span(1))


def role_class(text: str, against: str = "shipped") -> str | None:
    """None when main and `against` read the same role cue on `text`; else the difference's class:
    `an-read-as-a`, `article-prefix` or `unexplained`."""
    old, new = role_read(variant("role", "main"), text), role_read(variant("role", against), text)
    if old == new:
        return None
    if old is None or new is None or old[0][0] != new[0][0]:
        return "unexplained"
    old_start, new_start = old[1][0], new[1][0]
    # Main took "a" from "an" and captured from the "n": "need an operator" -> "n operator".
    if (
        old_start < new_start
        and text[old_start - 1 : old_start + 1].lower() == "an"
        and text[old_start + 1 : new_start].isspace()
    ):
        return "an-read-as-a"
    # Main took an article off the front of the word: "hiring assistants" -> "ssistants".
    if new_start < old_start and text[new_start:old_start].lower() in ARTICLES:
        return "article-prefix"
    return "unexplained"


def split_class(text: str, against: str = "shipped") -> str | None:
    """None when main and `against` split `text` the same; `empty-pieces` when they differ only by
    empty strings; else `unexplained`."""
    old, new = variant("split", "main").split(text), variant("split", against).split(text)
    if old == new:
        return None
    if [p for p in old if p] == [p for p in new if p]:
        return "empty-pieces"
    return "unexplained"


#: The difference classes the fix is allowed to make.
ALLOWED = {
    "role": frozenset({"an-read-as-a", "article-prefix"}),
    "split": frozenset({"empty-pieces"}),
}
CLASSIFIERS: dict[str, Callable[[str, str], str | None]] = {
    "role": role_class,
    "split": split_class,
}


def classes(text: str, against: str = "shipped") -> dict[str, str]:
    """name -> the difference class, for each regex whose result on `text` differs."""
    found = {name: CLASSIFIERS[name](text, against) for name in RULES}
    return {name: cls for name, cls in found.items() if cls is not None}


def disallowed(text: str, against: str = "shipped") -> dict[str, str]:
    """The differences on `text` that are not the intended fix."""
    return {n: c for n, c in classes(text, against).items() if c not in ALLOWED[n]}


# --- views and corpus ---------------------------------------------------------------------------

_RUN = re.compile(r"\s+")


def stretched(text: str) -> str:
    """Every whitespace run tripled, kinds kept: the run lengths the old quantifiers split."""
    return _RUN.sub(lambda m: m.group() * 3, text)


def newline_runs(text: str) -> str:
    """A newline in front of every whitespace run: the run shape the splitter's anchor reads."""
    return _RUN.sub(lambda m: "\n" + m.group(), text)


#: The views of a corpus string the comparisons run on.
VIEWS: dict[str, Callable[[str], str]] = {
    "as written": lambda text: text,
    "stretched": stretched,
    "newline runs": newline_runs,
    "upper-cased": str.upper,
}
#: The #1934 test file, left out so the fix is not measured against its own fixtures.
EXCLUDED_FILES = frozenset({"test_job_chat_parsers_linear.py"})
#: The #1933 sources, plus the API side of the job-posting chat (its code and tests, read line by
#: line: `json_strings` keeps a line that is not JSON as it is).
SOURCES: dict[str, tuple[str, tuple[str, ...]]] = {
    **CORPUS_SOURCES,
    "api_job_posting_chat": ("apps/api/src/payer-portal/job-posting-chat", (".ts",)),
}


def corpus() -> dict[str, list[str]]:
    """Every distinct string of the repo's own tracked text, by source."""
    parts: dict[str, list[str]] = {}
    for name, (directory, suffixes) in SOURCES.items():
        paths = [
            p for p in tracked(directory, *suffixes, exclude=False) if p.name not in EXCLUDED_FILES
        ]
        strings = py_strings(p for p in paths if p.suffix == ".py") + json_strings(
            p for p in paths if p.suffix != ".py"
        )
        parts[name] = sorted(set(strings))
    return parts


# --- the seeded payer-phrase generator ----------------------------------------------------------

CUES = [
    "need", "needs", "hiring", "hire", "require", "requires", "looking for", "want", "wanted",
    "recruiting", "opening for", "vacancy for", "post for", "posting for", "Need", "HIRING",
    "Looking For", "chahiye", "",
]  # fmt: skip
COUNTS = ["", "", "", "5", "10", "2", "५", "1"]
#: The five articles in several casings, then near-misses: words an article is a prefix of.
ARTICLE_WORDS = [
    "", "", "", "a", "an", "A", "An", "AN", "some", "Some", "few", "the", "The", "THE", "ek",
    "kuch",
]  # fmt: skip
ROLES = [
    "welder", "CNC operator", "operator", "electrician", "fitter", "helper", "driver",
    "assistant", "accountant", "AC technician", "anchor fitter", "fewster", "theodolite operator",
    "someone", "supervisor", "machine operators", "mistri", "karigar", "VMC programmer",
    "TIG welder", "aurat helper", "andhra cook", "Electrician", "OPERATOR", "fork-lift driver",
]  # fmt: skip
TAILS = [
    "", "", " in Pune", " at Chakan", " for night shift", " urgently", " salary 20k",
    " jaldi chahiye", ".", "!", " aur 2 helpers", " and helpers", ", ITI pass",
]  # fmt: skip
PHRASES = [
    "PF", "ESI", "canteen", "bus", "room", "khana", "overtime", "bonus", "ITI", "TIG welding",
    "MIG", "AutoCAD", "forklift", "safety shoes", "uniform", "Andheri", "aurangabad", "sander",
    "brand", "AND", "AUR", "and", "aur", "Hindi", "English",
]  # fmt: skip
SEPARATORS = [
    ",", ", ", " and ", " aur ", " AND ", " Aur ", "/", " + ", "&", ";", "|", "\n", "\n and ",
    "\nand ", " \n and ", "\r\n", " ,and ", "and", " ", "",
]  # fmt: skip
SPACES = [" ", " ", " ", "\t", "\n", " ", "　", "\r"]


def _ws(rng: random.Random) -> str:
    return "".join(rng.choice(SPACES) for _ in range(rng.choice([0, 1, 1, 1, 1, 2, 3, 6])))


def _role(rng: random.Random) -> str:
    parts = [rng.choice(CUES), rng.choice(COUNTS), rng.choice(ARTICLE_WORDS), rng.choice(ROLES)]
    return "".join(p + _ws(rng) for p in parts if p).rstrip() + rng.choice(TAILS)


def _list(rng: random.Random) -> str:
    items = [rng.choice(PHRASES) for _ in range(rng.randint(1, 5))]
    out = items[0]
    for item in items[1:]:
        sep = rng.choice(SEPARATORS)
        out += (_ws(rng) + sep.strip() + _ws(rng) if rng.random() < 0.3 else sep) + item
    return out


def sample(rng: random.Random) -> str:
    """A payer's role or list answer in Hindi, Hinglish or English: every cue, a count (ASCII or
    Devanagari), the five articles in several casings plus words they are prefixes of, roles,
    tails, list items joined by every separator (",", "and", "aur", "+", "/", newline forms), and
    whitespace runs of up to 6 of 8 kinds."""
    text = _role(rng) if rng.random() < 0.5 else _list(rng)
    return text.upper() if rng.random() < 0.1 else text


# --- parity -------------------------------------------------------------------------------------

#: The questions on screen the end-to-end run answers: the role and the three list topics.
TOPICS = ("role_title", "skills", "benefits", "requirements")


def end_to_end(text: str) -> tuple[dict[str, object | None], ...]:
    return tuple(answers.detect_answers(text, topic) for topic in TOPICS)


def e2e_moves(texts: list[str], against: str = "shipped") -> list[tuple[str, str, bool]]:
    """(text, what moved, allowed) for every `detect_answers` result that differs between main and
    `against`. Allowed: only `role_title` moved, on a text with an allowed role difference."""
    with regexes("main"):
        base = [end_to_end(t) for t in texts]
    with regexes(against):
        new = [end_to_end(t) for t in texts]
    out: list[tuple[str, str, bool]] = []
    for text, before, after in zip(texts, base, new, strict=True):
        for topic, b, n in zip(TOPICS, before, after, strict=True):
            if b == n:
                continue
            moved = {k for k in b.keys() | n.keys() if b.get(k) != n.get(k)}
            allowed = moved == {"role_title"} and role_class(text, against) in ALLOWED["role"]
            out.append((text, f"{topic}: {b} -> {n}", allowed))
    return out


def e2e_changes(texts: list[str], against: str = "shipped") -> list[tuple[str, str]]:
    """The `e2e_moves` the fix does not allow, as (text, what moved)."""
    return [(text, why) for text, why, allowed in e2e_moves(texts, against) if not allowed]


def report(label: str, texts: list[str], against: str) -> list[str]:
    """Print the difference classes over `texts`; return the texts with any difference."""
    counts: Counter[str] = Counter()
    examples: dict[str, list[str]] = {}
    moved: list[str] = []
    for text in texts:
        found = classes(text, against)
        if found:
            moved.append(text)
        for name, cls in found.items():
            key = f"{name}:{cls}"
            counts[key] += 1
            examples.setdefault(key, []).append(text)
    summary = ", ".join(f"{k} {v:,}" for k, v in sorted(counts.items())) or "no differences"
    print(f"regex  {label:12}: {len(moved):,} of {len(texts):,} move ({summary})")
    for key in sorted(examples):
        for text in examples[key][:3]:
            print(f"    {key:22} {text[:70]!r}")
    return moved


def parity(against: str, fuzz: int) -> None:
    parts = corpus()
    strings = distinct(parts)
    print(f"corpus: {len(strings):,} distinct strings")
    print("  by source: " + ", ".join(f"{k} {len(v):,}" for k, v in parts.items()))
    texts: list[str] = []
    for view, transform in VIEWS.items():
        viewed = [transform(s) for s in strings]
        report(view, viewed, against)
        texts += viewed
    rng = random.Random(1934)
    samples = [sample(rng) for _ in range(fuzz)]
    report("fuzz", samples, against)
    bad = [t for t in texts + samples if disallowed(t, against)]
    print(f"regex  unexplained  : {len(bad):,}")
    touched = [t for t in dict.fromkeys(texts + samples) if answers._HAS_ALNUM_RE.search(t)]
    moves = e2e_moves(touched, against)
    changed = [(text, why) for text, why, allowed in moves if not allowed]
    print(f"e2e    detect_answers x {TOPICS} over {len(touched):,} texts:")
    print(f"       {len(moves) - len(changed):,} allowed role_title moves, {len(changed):,} other")
    for text, why in changed[:5]:
        print(f"    {text[:50]!r}: {why[:120]}")


# --- timing -------------------------------------------------------------------------------------

#: The run lengths R53 measured.
RUNS = (2_500, 5_000, 10_000, 15_000)
#: label -> (input, the topic on screen). Every input fails the regex it targets: the slow shape.
TIMING_INPUTS: dict[str, tuple[str, str]] = {
    **{f"'need' + {k:,} spaces + '5'": ("need" + " " * k + "5", "role_title") for k in RUNS},
    **{f"'PF' + {k:,} spaces + 'ESI'": ("PF" + " " * k + "ESI", "skills") for k in RUNS},
    "'need 5' + 15,000 tabs + '!'": ("need 5" + "\t" * 15_000 + "!", "role_title"),
    "'PF' + (' \\n' x 7,500) + 'and'": ("PF" + " \n" * 7_500 + "and", "benefits"),
}


def once_ms(text: str, topic: str, which: str) -> float:
    with regexes(which):
        start = time.perf_counter()
        answers.detect_answers(text, topic)
        return (time.perf_counter() - start) * 1000


def timing(reps: int) -> None:
    print(f"python {sys.version.split()[0]}; detect_answers, min of {reps} runs, ms")
    print(f"{'input':36} {'topic':>12} {'main':>10} {'shipped':>9}")
    for label, (text, topic) in TIMING_INPUTS.items():
        cells: dict[str, list[float]] = {"main": [], "shipped": []}
        for _ in range(reps):
            for which, runs in cells.items():
                runs.append(once_ms(text, topic, which))
        print(f"{label:36} {topic:>12} {min(cells['main']):10.1f} {min(cells['shipped']):9.1f}")


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
