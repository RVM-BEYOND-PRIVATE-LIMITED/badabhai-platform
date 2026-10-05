"""Reproduce #1891's measurements of the title-case employer rule (risks-register R48).

    cd apps/ai-service && python scripts/measure_title_employer_bound.py overmask
    cd apps/ai-service && python scripts/measure_title_employer_bound.py overmask --against bound8
    cd apps/ai-service && python scripts/measure_title_employer_bound.py timing [reps]
    cd apps/ai-service && python scripts/measure_title_employer_bound.py longwords

MAIN is this module with `_EMPLOYER_RE` swapped back to its pre-#1891 pattern, the unbounded name
word `[A-Z][\\w&.]*`. The swap is sound because `_EMPLOYER_RE` is the only rule #1891 changed. On
2026-10-03 it reproduced the real origin/main module byte for byte over the corpus below.

overmask   #1875's over-mask method. The corpus is every distinct string of the repo's own text,
           from tracked files only: the question packs, both lexicon copies, the job-domain
           corpus, the ai-service test strings (Python string constants and SQL fixtures) and the
           companion eval strings. The two employer test files are left out, so neither fix
           measures its own fixtures. Each string runs as written and upper-cased through
           `pseudonymize`. Each certifier label (`signals.VOCABULARY_TOKENS` plus every lexicon
           string) runs as written, UPPER and Title through the three walls. It prints how many
           outputs, blocked statuses and certifier outcomes differ between MAIN and the module.
           `--against bound8` is the sensitivity run: an 8-character bound must move strings, or
           the harness cannot see a bound that bites.
timing     MAIN against the module, interleaved in one process so machine load hits both alike.
           `pseudonymize` end to end and the rule alone; the minimum of `reps` runs (default 5).
longwords  The distance to the boundary. It prints the longest capital-led `[\\w&.]` run in the
           corpus, as written and upper-cased, and in every tracked .py/.json/.yaml/.csv file
           under apps/ai-service and packages.

Stdlib only. The counts depend on the checkout: re-run them on the commit you are judging.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
import sys
import time
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path

AI_SERVICE = Path(__file__).resolve().parents[1]
REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(AI_SERVICE))

import app.pseudonymize as gateway  # noqa: E402
from app.profiling import signals  # noqa: E402

#: `_EMPLOYER_RE` as it was before #1891.
MAIN_EMPLOYER_RE = re.compile(r"\b(?:[A-Z][\w&.]*\s+){1,4}" + gateway._COMPANY_SUFFIX + r"\b")
#: Test files that pin these rules' own fixtures; measuring them would measure the fix against
#: itself.
EXCLUDED_FILES = frozenset(
    {"test_pseudonymize_allcaps_employer.py", "test_pseudonymize_title_employer_bound.py"}
)
#: What `_EMPLOYER_RE` can open on: a capital at a word boundary, then `[\w&.]`.
CAPITAL_LED_RUN = re.compile(r"\b[A-Z][\w&.]*")
ZWSP = "\u200b"


def variant(name: str) -> re.Pattern[str]:
    """`module` (as shipped), `main` (pre-#1891) or `boundN` (a name word of N characters)."""
    if name == "module":
        return gateway._EMPLOYER_RE
    if name == "main":
        return MAIN_EMPLOYER_RE
    if name.startswith("bound") and name[5:].isdigit():
        word = r"[A-Z][\w&.]{0," + str(int(name[5:]) - 1) + r"}+"
        return re.compile(r"\b(?:" + word + r"\s+){1,4}" + gateway._COMPANY_SUFFIX + r"\b")
    raise SystemExit(f"unknown variant {name!r}: use module, main or boundN")


@contextmanager
def employer_rule(pattern: re.Pattern[str]) -> Iterator[None]:
    shipped = gateway._EMPLOYER_RE
    gateway._EMPLOYER_RE = pattern
    try:
        yield
    finally:
        gateway._EMPLOYER_RE = shipped


# --- corpus ------------------------------------------------------------------------------------


def tracked(
    directory: str, *suffixes: str, name_glob: str = "*", exclude: bool = True
) -> list[Path]:
    listed = subprocess.run(
        ["git", "-C", str(REPO), "ls-files", "-z", "--", directory],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split("\0")
    paths = [REPO / p for p in listed if p and p.endswith(suffixes)]
    skip = EXCLUDED_FILES if exclude else frozenset()
    return sorted(p for p in paths if p.match(name_glob) and p.name not in skip)


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


def json_strings(paths: Iterable[Path]) -> list[str]:
    out: list[str] = []
    for path in paths:
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".json":
            _walk_json(json.loads(text), out)
            continue
        for line in text.splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            try:
                _walk_json(json.loads(line), out)
            except json.JSONDecodeError:
                out.append(line)
    return out


def py_strings(paths: Iterable[Path]) -> list[str]:
    out: list[str] = []
    for path in paths:
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                out.append(node.value)
    return out


def sql_strings(paths: Iterable[Path]) -> list[str]:
    literal = re.compile(r"'((?:[^']|'')*)'")
    return [
        m.group(1).replace("''", "'")
        for path in paths
        for m in literal.finditer(path.read_text(encoding="utf-8"))
    ]


def corpus() -> dict[str, list[str]]:
    parts = {
        "question_packs": json_strings(
            tracked("packages/db/data/question-packs", ".json", ".jsonl")
        ),
        "lexicon_pkg": json_strings(tracked("packages/profiling-lexicon/data", ".json")),
        "lexicon_ai": json_strings(tracked("apps/ai-service/app/profiling/lexicon_data", ".json")),
        "job_domains": json_strings(tracked("packages/db/data/job-domains", ".jsonl")),
        "test_fixtures": py_strings(tracked("apps/ai-service/tests", ".py"))
        + sql_strings(tracked("apps/ai-service/tests/fixtures", ".sql"))
        + py_strings(tracked("apps/ai-service/app/companion", ".py", name_glob="eval_*.py")),
    }
    return {name: sorted(set(strings)) for name, strings in parts.items()}


def distinct(parts: dict[str, list[str]]) -> list[str]:
    return sorted(set().union(*map(set, parts.values())))


def certifier_labels(parts: dict[str, list[str]]) -> list[str]:
    labels = set(signals.VOCABULARY_TOKENS) | set(parts["lexicon_ai"]) | set(parts["lexicon_pkg"])
    return sorted(labels | {s.upper() for s in labels} | {s.title() for s in labels})


# --- overmask ----------------------------------------------------------------------------------


def _run(texts: list[str]) -> dict[str, tuple[str, bool, int]]:
    out = {}
    for text in texts:
        result = gateway.pseudonymize(text)
        out[text] = (result.text, result.blocked, result.replaced_entities)
    return out


def _certify(labels: list[str]) -> dict[str, tuple[bool, tuple[object, ...], bool]]:
    return {
        label: (
            gateway.is_certified_clean(label),
            tuple(gateway.certify_value(label)),
            gateway.certified_clean_skill_labels([label]) == [label],
        )
        for label in labels
    }


def overmask(against: str) -> None:
    parts = corpus()
    strings = distinct(parts)
    labels = certifier_labels(parts)
    print(f"corpus: {len(strings):,} distinct strings; {len(labels):,} certifier labels")
    print("  by source: " + ", ".join(f"{k} {len(v):,}" for k, v in parts.items()))
    views = {"as written": strings, "upper-cased": [s.upper() for s in strings]}
    measured = {}
    for name in ("main", against):
        with employer_rule(variant(name)):
            measured[name] = (
                {view: _run(texts) for view, texts in views.items()},
                _certify(labels),
            )
    (base_views, base_cert), (new_views, new_cert) = measured["main"], measured[against]
    for view in views:
        base, new = base_views[view], new_views[view]
        changed = [s for s in base if base[s] != new[s]]
        blocked = [s for s in base if base[s][1] != new[s][1]]
        print(f"{view:12}: outputs changed {len(changed):,}; blocked changed {len(blocked):,}")
        for text in changed[:10]:
            print(f"    {text[:70]!r}: {base[text][0][:50]!r} -> {new[text][0][:50]!r}")
    moved = [label for label in base_cert if base_cert[label] != new_cert[label]]
    print(f"certifiers  : outcomes changed {len(moved):,} of {len(base_cert):,} labels")
    for label in moved[:10]:
        print(f"    {label!r}: {base_cert[label]} -> {new_cert[label]}")


# --- timing ------------------------------------------------------------------------------------

TIMING_INPUTS = {
    '"A." * 10000': "A." * 10_000,
    '"A." * 9999 + one ZWSP': "A." * 9_999 + ZWSP,
    '"A&" * 10000': "A&" * 10_000,
    '"Ab." * 6666': "Ab." * 6_666,
    '"A." * 9990 + " Steel"': "A." * 9_990 + " Steel",
}
TYPICAL_LINE = "Main Tata Motors Ltd Pune mein 5 saal CNC operator tha, salary 25000"


def _once_ms(fn: Callable[[str], object], text: str, pattern: re.Pattern[str]) -> float:
    with employer_rule(pattern):
        start = time.perf_counter()
        fn(text)
        return (time.perf_counter() - start) * 1000


def timing(reps: int) -> None:
    main, bounded = variant("main"), variant("module")
    print(f"python {sys.version.split()[0]}; min of {reps} interleaved runs, in ms")
    print(f"{'input':26} {'pseudonymize main':>18} {'bounded':>9} {'rule main':>11} {'bounded':>9}")
    for label, text in TIMING_INPUTS.items():
        text = text[: gateway.DEFAULT_MAX_LENGTH]
        cells = {}
        for step, fn in (("full", gateway.pseudonymize), ("rule", None)):
            runs: dict[str, list[float]] = {"main": [], "bounded": []}
            for _ in range(reps):
                for name, pattern in (("main", main), ("bounded", bounded)):
                    call = fn or (lambda t, p=pattern: p.sub("X", t))
                    runs[name].append(_once_ms(call, text, pattern))
            cells[step] = (min(runs["main"]), min(runs["bounded"]))
        print(
            f"{label:26} {cells['full'][0]:18.1f} {cells['full'][1]:9.1f}"
            f" {cells['rule'][0]:11.1f} {cells['rule'][1]:9.1f}"
        )
    typical = {"main": [], "bounded": []}
    for _ in range(3_000):
        for name, pattern in (("main", main), ("bounded", bounded)):
            typical[name].append(_once_ms(gateway.pseudonymize, TYPICAL_LINE, pattern))
    print(
        f"{'typical line (us)':26} {min(typical['main']) * 1000:18.1f}"
        f" {min(typical['bounded']) * 1000:9.1f}"
    )


# --- longwords ---------------------------------------------------------------------------------


def _longest(texts: Iterable[str]) -> tuple[int, int]:
    longest = over = 0
    for text in texts:
        for match in CAPITAL_LED_RUN.finditer(text):
            length = len(match.group(0))
            longest = max(longest, length)
            over += length > gateway._CAPS_NAME_WORD_MAX
    return longest, over


def longwords() -> None:
    strings = distinct(corpus())
    limit = gateway._CAPS_NAME_WORD_MAX
    for view, texts in (("as written", strings), ("upper-cased", [s.upper() for s in strings])):
        longest, over = _longest(texts)
        print(f"corpus {view:12}: longest capital-led run {longest}; runs over {limit}: {over}")
    files = [
        path
        for directory in ("apps/ai-service", "packages")
        for path in tracked(directory, ".py", ".json", ".yaml", ".yml", ".csv", exclude=False)
    ]
    longest, over = _longest(p.read_text(encoding="utf-8", errors="replace") for p in files)
    print(f"{len(files)} tracked files: longest capital-led run {longest}; over {limit}: {over}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    over = sub.add_parser("overmask")
    over.add_argument("--against", default="module", help="module (default), main or boundN")
    sub.add_parser("timing").add_argument("reps", nargs="?", type=int, default=5)
    sub.add_parser("longwords")
    args = parser.parse_args()
    if args.command == "overmask":
        overmask(args.against)
    elif args.command == "timing":
        timing(args.reps)
    else:
        longwords()


if __name__ == "__main__":
    main()
