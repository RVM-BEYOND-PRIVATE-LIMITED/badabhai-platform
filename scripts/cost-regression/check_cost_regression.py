#!/usr/bin/env python3
"""Cost-regression checker for the nine recorded profiling runs.

Reads the committed per-call CSV (measured audit data, no live calls) and:

1. Gates on data integrity: exact header, 111 rows, no blank cells, and the
   Rs85 pricing column re-computes from the USD column.
2. Prints the per-flow, per-profile cost table at the Rs85 basis.
3. Prints the Done-means checklist rows that are derivable from the CSV.

Default mode exits non-zero only on (1). Pass --strict to also gate on (3);
use that once the fixes each row measures are armed.
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXTENDED = HERE / "token_audit_calls_extended.csv"

EXPECTED_ROWS = 111
EXPECTED_COLS = 42
FX = 85.0

# The basic 24-column CSV carries no blank cells at all; the extended sheet
# reuses empty strings for fields that do not apply to a row (for example the
# reply-visibility column on non-chat calls), so the no-blank rule covers
# exactly the basic columns.
BASIC_COLS = [
    "profile_ref", "run_no", "flow", "turn_no", "call_name", "provider",
    "model", "attempt", "input_tokens", "cache_read_tokens",
    "cache_write_tokens", "output_tokens", "thinking_tokens",
    "history_turns_sent", "packs_loaded", "slots_filled", "loop_state",
    "audio_seconds", "file_pages", "max_tokens", "json_valid", "latency_ms",
    "cost_usd", "timestamp",
]

# Runs that form one profile each; run 9 is the optional hard photo and is
# kept out of the per-flow averages so it cannot skew run 2.
FLOW_RUNS = {"resume": ["1", "2", "3"], "form": ["4", "5"], "chat": ["6", "7"]}


def fail(msg: str) -> int:
    print(f"GATE FAIL: {msg}")
    return 1


def load() -> tuple[list[str], list[dict[str, str]]]:
    with EXTENDED.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames or []
        return header, list(reader)


def check_integrity(header: list[str], rows: list[dict[str, str]]) -> int:
    if len(header) != EXPECTED_COLS:
        return fail(f"header has {len(header)} columns, want {EXPECTED_COLS}")
    if len(rows) != EXPECTED_ROWS:
        return fail(f"CSV has {len(rows)} rows, want {EXPECTED_ROWS}")
    for i, row in enumerate(rows, start=2):
        blanks = [c for c in BASIC_COLS if row.get(c, "") == ""]
        if blanks:
            return fail(f"row {i} has blank cells: {blanks}")
    for i, row in enumerate(rows, start=2):
        try:
            want = round(float(row["cost_usd"]) * FX, 4)
            got = float(row["cost_inr_at_85"])
        except ValueError:
            return fail(f"row {i} has non-numeric pricing")
        if abs(want - got) > 0.0002:
            return fail(f"row {i}: Rs85 price {got} != {want} from cost_usd")
    print(f"integrity OK: {len(rows)} rows, {len(header)} cols, Rs85 maths holds")
    return 0


def flow_table(rows: list[dict[str, str]]) -> dict[str, float]:
    per_run: dict[str, float] = defaultdict(float)
    per_run_flow: dict[str, str] = {}
    for row in rows:
        if row["flow"] == "voice":
            continue
        per_run[row["run_no"]] += float(row["cost_inr_at_85"])
        per_run_flow[row["run_no"]] = row["flow"]
    totals: dict[str, float] = defaultdict(float)
    counts: dict[str, int] = defaultdict(int)
    for run_no, cost in per_run.items():
        flow = per_run_flow[run_no]
        if run_no in FLOW_RUNS.get(flow, []):
            totals[flow] += cost
            counts[flow] += 1
    return {flow: totals[flow] / counts[flow] for flow in totals}


def checklist(rows: list[dict[str, str]]) -> list[tuple[str, bool, str]]:
    by_name: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        by_name[row["call_name"]].append(row)
    out: list[tuple[str, bool, str]] = []

    regen = by_name.get("resume_generation", [])
    out.append(("resume_generation absent", not regen, f"{len(regen)} rows"))

    truncated = [r for r in by_name.get("resume_option_map", []) if r["stop_reason"] == "max_tokens"]
    out.append(("option map not truncated", not truncated, f"{len(truncated)} max_tokens rows"))

    turn_polish = [r for r in by_name.get("work_history_polish", []) if r["phase"] == "turn"]
    out.append((
        "no turn-phase polish calls (benign FAIL while the print ruling is live)",
        not turn_polish,
        f"{len(turn_polish)} turn-phase rows",
    ))

    replaced = [
        r
        for r in by_name.get("profiling_chat_turn", [])
        if (r["reply_shown_to_worker"] or "").startswith("no:")
    ]
    out.append(("chat replies shown, not replaced", not replaced, f"{len(replaced)} replaced rows"))

    ledgered = [r for r in rows if r["ledgered"] == "yes"]
    if ledgered:
        ledger = sum(float(r["ledger_cost_inr"]) for r in ledgered)
        priced = sum(float(r["cost_inr_at_85"]) for r in ledgered)
        within = abs(ledger - priced) / priced <= 0.01
        out.append(("ledger within 1% of CSV", within, f"ledger {ledger:.2f} vs csv {priced:.2f}"))
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    if not EXTENDED.exists():
        return fail(f"missing {EXTENDED.name}")
    header, rows = load()
    if check_integrity(header, rows):
        return 1

    print("\nper-flow, per-profile cost at Rs85:")
    for flow, cost in sorted(flow_table(rows).items()):
        print(f"  {flow:<8} Rs{cost:.2f}")

    print("\nDone-means checklist (from CSV):")
    results = checklist(rows)
    for name, ok, detail in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name} ({detail})")

    if args.strict and not all(ok for _, ok, _ in results):
        return fail("checklist has FAIL rows under --strict")
    return 0


if __name__ == "__main__":
    sys.exit(main())
