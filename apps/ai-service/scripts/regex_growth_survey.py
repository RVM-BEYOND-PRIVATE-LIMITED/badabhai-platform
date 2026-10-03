"""Screen every compiled regex in the ai-service for super-linear time (#1891's survey).

    cd apps/ai-service && python scripts/regex_growth_survey.py [--k 100] [--timeout 40]

Every `re.Pattern` reachable from the globals of an `app/` module the service imports (through
tuples, lists, sets and dicts, four levels deep) is timed on 22 input shapes at `k` and `2k`
units. The shapes are runs of spaces, mixed whitespace, word windows, dotted runs, and runs of
digits, commas and dashes. Each one follows a cue word taken from the pattern's own source, or
no cue at all. The ops are
`finditer` (what `search`, `sub` and `findall` cost at worst), `match` and `fullmatch`.

A pattern is FLAGGED when an op takes over 1 ms at `2k` and more than 2.8x its `k` time (linear is
2x). Each pattern runs in a worker process. If a pattern's sweep takes longer than `timeout`
seconds it is reported as TIMEOUT, so an exponential pattern cannot hang the run.

A flag says the pattern ALONE grows faster than linear. Whether that is live depends on the
caller, so time each flagged pattern through its real entry point before calling it a stall:
many run on whitespace-collapsed text or are anchored at a figure. Not covered: a pattern
compiled inside a function body. Stdlib only.
"""

from __future__ import annotations

import argparse
import multiprocessing as mp
import queue
import re
import sys
import time
from collections.abc import Callable
from pathlib import Path

AI_SERVICE = Path(__file__).resolve().parents[1]
FLOOR_MS = 1.0
RATIO = 2.8


def collect() -> list[tuple[re.Pattern[str], str]]:
    """Every distinct compiled pattern reachable from an `app/` module's globals, with a path."""
    sys.path.insert(0, str(AI_SERVICE))
    # A LITERAL import of the service entry point, then every `app.` module it pulled in: the
    # patterns a running service can reach. No dynamic import (semgrep non-literal-import), so a
    # module the service never imports (an eval CLI, a script) is outside the survey.
    import app.main  # noqa: F401

    modules = [mod for name, mod in sorted(sys.modules.items()) if name.startswith("app.")]
    found: dict[tuple[str, int], tuple[re.Pattern[str], str]] = {}

    def walk(obj: object, depth: int, path: str) -> None:
        if isinstance(obj, re.Pattern):
            found.setdefault((obj.pattern, obj.flags), (obj, path))
        elif depth and isinstance(obj, (list, tuple, set, frozenset)):
            for i, item in enumerate(obj):
                walk(item, depth - 1, f"{path}[{i}]")
        elif depth and isinstance(obj, dict):
            for key, value in list(obj.items())[:500]:
                walk(value, depth - 1, f"{path}[{key!r}]")

    for module in modules:
        for name, value in vars(module).items():
            walk(value, 4, f"{module.__name__}.{name}")
    return list(found.values())


def cues(source: str) -> list[str]:
    """No cue, then literal words lifted from the source: the first 8 and the last 4."""
    words: list[str] = []
    for word in re.findall(r"[A-Za-z]{2,}", re.sub(r"\\[A-Za-z]", " ", source)):
        if word not in words:
            words.append(word)
    return ["", *words[:8], *(w for w in words[-4:] if w not in words[:8])]


def shapes(cue: str, k: int) -> dict[str, str]:
    c = cue + " " if cue else ""
    return {
        "spaces+5": cue + " " * k + "5",
        "spaces+!": cue + " " * k + "!",
        "spaces-end": cue + " " * k,
        "5+spaces+!": c + "5" + " " * k + "!",
        "a-window": c + "a " * k + "!",
        "A-window": c + "A " * k + "5",
        "Ab-window": c + "Ab " * k + "5",
        "a.run": c + "a." * k,
        "A.run": c + "A." * k,
        "A&run": c + "A&" * k,
        "digit-window": c + "1 " * k + "x",
        "digits": c + "1" * k + "x",
        "commas": c + "," * k + "5",
        "comma-window": c + ", " * k + "5",
        "dashes": c + "-" * k + "5",
        "dash-window": c + "- " * k + "5",
        "dots": c + "." * k + "5",
        "letters": c + "a" * k + "!",
        "a-dash-run": c + "a-" * k + "5",
        "devanagari-window": c + "\u0915\u093e " * k + "5",
        "mixed-whitespace": cue + " \t\n" * k + "5",
        "cue-repeat": (c * k) + "5" if cue else "x",
    }


def _ops(pattern: re.Pattern[str]) -> dict[str, Callable[[str], object]]:
    return {
        "finditer": lambda s: sum(1 for _ in pattern.finditer(s)),
        "match": pattern.match,
        "fullmatch": pattern.fullmatch,
    }


def _ms(op: Callable[[str], object], text: str) -> float:
    best = float("inf")
    for _ in range(2):
        start = time.perf_counter()
        op(text)
        best = min(best, (time.perf_counter() - start) * 1000)
    return best


def _worker(k: int, tasks: mp.Queue, results: mp.Queue) -> None:
    patterns = collect()
    results.put(len(patterns))
    while (index := tasks.get()) is not None:
        pattern, path = patterns[index]
        flags = []
        for cue in cues(pattern.pattern):
            small, big = shapes(cue, k), shapes(cue, 2 * k)
            for shape in small:
                for op_name, op in _ops(pattern).items():
                    t2 = _ms(op, big[shape])
                    if t2 < FLOOR_MS:
                        continue
                    t1 = _ms(op, small[shape])
                    if t2 / max(t1, 1e-3) > RATIO:
                        flags.append((t2, t1, cue, shape, op_name))
        results.put((index, path, sorted(flags, reverse=True)))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--k", type=int, default=100, help="units per shape (default 100)")
    parser.add_argument("--timeout", type=float, default=40.0, help="seconds per pattern")
    args = parser.parse_args()
    paths = [path for _, path in collect()]
    index = 0
    flagged = timed_out = 0
    while index < len(paths):
        tasks: mp.Queue = mp.Queue()
        results: mp.Queue = mp.Queue()
        worker = mp.Process(target=_worker, args=(args.k, tasks, results), daemon=True)
        worker.start()
        results.get(timeout=300)
        while index < len(paths):
            tasks.put(index)
            try:
                _, path, flags = results.get(timeout=args.timeout)
            except queue.Empty:
                print(f"TIMEOUT  {paths[index]} (sweep over {args.timeout:.0f} s)", flush=True)
                worker.terminate()
                worker.join()
                timed_out += 1
                index += 1
                break
            if flags:
                flagged += 1
                t2, t1, cue, shape, op_name = flags[0]
                print(
                    f"FLAGGED  {path}: {len(flags)} flags; worst {op_name} on {shape!r} after "
                    f"{cue!r}: {t1:.2f} -> {t2:.2f} ms",
                    flush=True,
                )
            index += 1
        else:
            tasks.put(None)
            worker.join(timeout=10)
    print(f"{len(paths)} patterns at k={args.k}: {flagged} flagged, {timed_out} timed out")


if __name__ == "__main__":
    main()
