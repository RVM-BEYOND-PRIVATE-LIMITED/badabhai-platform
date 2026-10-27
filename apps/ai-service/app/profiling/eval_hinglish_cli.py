"""The D4 blind Hinglish extraction gate — staging CLI.

    python -m app.profiling.eval_hinglish_cli --base-url http://localhost:8000
    python -m app.profiling.eval_hinglish_cli --base-url http://localhost:8000 \\
        --expect-model gemini-2.5-flash-lite --pace-ms 1500 --label flash-lite

SCORES A RUNNING SERVICE over the 100+ fabricated cases in `eval_hinglish_gold`, through the
production `POST /profiling/understand` route with the five fields empty. The report is the five
facts the work order names — trade, level, controller, salary, location — as field accuracy,
fill precision and exact cases. It is MODEL-AGNOSTIC: the CLI never tells the scorer which model
answered, so the same set compares Flash-Lite, Haiku 4.5 and Haiku 5.5.

NO SCORE BAR YET. The scenario sheet says quality decides the model move and a tie goes to
Flash-Lite; a bar belongs to the owner's decision, not this runner. The runner only refuses a run
that is not evidence: a mock answer (is `profiling_turn_understand` armed in the target's
`AI_REAL_CALL_TASKS`?), a failed call, a late answer the API would not act on, or an answer from
a fallback model (`--expect-model` names the primary).

COST: one call per case on the target's provider account. Local runs share production's
Anthropic credit; estimate first and get the owner's OK. CI never runs this; `tests/` pins the
set, the scorer and this CLI against a fake transport.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

from ..companion.eval_cli import (
    CallLog,
    _call,
    _label,
    _print_calls,
    _served,
    _verdict,
    gate_failures,
)
from . import eval_hinglish_gold as gold

ROUTE = "/profiling/understand"
TASK_TYPE = "profiling_turn_understand"

#: The API's timeout for this route (`AiService.understandTurn`), pinned by the understand eval.
API_TIMEOUT_MS = 4_000.0


@dataclass
class HinglishRun:
    score: gold.HinglishScore
    calls: CallLog


def _fills(body: dict) -> list[tuple[str, str]]:
    """The served fills as `(key, value)` pairs; anything malformed is ignored."""
    raw = body.get("fills")
    if not isinstance(raw, list):
        return []
    fills: list[tuple[str, str]] = []
    for fill in raw:
        if not isinstance(fill, dict):
            continue
        key = fill.get("key")
        value = fill.get("value")
        if isinstance(key, str) and isinstance(value, str):
            fills.append((key, value))
    return fills


def run_hinglish_eval(
    base_url: str, *, pace_ms: int = 0, expect_model: str | None = None
) -> HinglishRun:
    calls = CallLog(pace_ms=pace_ms, expect_model=expect_model)

    def predict(case: gold.Case) -> list[tuple[str, str]] | None:
        body = _served(
            _call(
                base_url,
                ROUTE,
                case.request(),
                calls,
                _label(case.text),
                api_timeout_ms=API_TIMEOUT_MS,
            )
        )
        return None if body is None else _fills(body)

    return HinglishRun(gold.evaluate(predict), calls)


def print_report(run: HinglishRun, label: str | None = None) -> None:
    score = run.score
    title = "D4 blind Hinglish extraction"
    print(f"{title}{f' — {label}' if label else ''}: {score.total} cases")
    print(
        f"field accuracy: {score.correct_fields}/{score.expected_fields} = "
        f"{score.field_accuracy:.1%} (every stated fact)"
    )
    print(
        f"fill precision: {score.correct_fills}/{score.proposed_fills} = "
        f"{score.fill_precision:.1%} (wrong and extra fills count against)"
    )
    print(f"exact cases: {score.exact}/{score.total} = {score.exact_rate:.1%}")
    print("per field (correct / stated):")
    for field_name, tally in score.per_field.items():
        print(f"  {field_name}: {tally.correct}/{tally.expected}")
    _print_calls(run.calls, None)
    for miss in score.misses[:20]:
        print(f"  MISS {miss}")
    if len(score.misses) > 20:
        print(f"  ... {len(score.misses) - 20} more misses")
    for wrong in score.wrong_fills[:20]:
        print(f"  WRONG {wrong}")
    if len(score.wrong_fills) > 20:
        print(f"  ... {len(score.wrong_fills) - 20} more wrong fills")


def _report_json(run: HinglishRun, label: str | None, expect_model: str | None) -> dict:
    score = run.score
    return {
        "label": label,
        "expected_model": expect_model,
        "total": score.total,
        "field_accuracy": round(score.field_accuracy, 4),
        "fill_precision": round(score.fill_precision, 4),
        "exact_rate": round(score.exact_rate, 4),
        "correct_fields": score.correct_fields,
        "expected_fields": score.expected_fields,
        "correct_fills": score.correct_fills,
        "proposed_fills": score.proposed_fills,
        "per_field": {
            field_name: {"correct": tally.correct, "expected": tally.expected}
            for field_name, tally in score.per_field.items()
        },
        "misses": score.misses,
        "wrong_fills": score.wrong_fills,
        "calls": {
            "sent": run.calls.sent,
            "failed": len(run.calls.failures),
            "mocked": len(run.calls.mocked),
            "over_api_timeout": len(run.calls.over_api_timeout),
            "cost_inr": round(run.calls.cost_inr, 4),
            "served_by": run.calls.model_counts,
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="D4 blind Hinglish extraction gate (staging)")
    parser.add_argument("--base-url", required=True, help="the ai-service under test")
    parser.add_argument(
        "--pace-ms",
        type=int,
        default=0,
        metavar="N",
        help="sleep N ms before every request but the first (a rate-limited key's RPM)",
    )
    parser.add_argument(
        "--expect-model",
        default=None,
        metavar="MODEL",
        help="the route's primary model id; any answer from another model fails the run",
    )
    parser.add_argument(
        "--label",
        default=None,
        metavar="NAME",
        help="a name for this run (flash-lite, haiku-4-5, haiku-5-5); never used in scoring",
    )
    parser.add_argument(
        "--json",
        default=None,
        metavar="PATH",
        help="write the model-agnostic report to PATH as JSON",
    )
    args = parser.parse_args(argv)
    if args.pace_ms < 0:
        parser.error("--pace-ms must be >= 0")
    if args.expect_model is not None and not args.expect_model.strip():
        parser.error("--expect-model must name a model")

    run = run_hinglish_eval(args.base_url, pace_ms=args.pace_ms, expect_model=args.expect_model)
    print_report(run, args.label)
    if args.json:
        Path(args.json).write_text(
            json.dumps(_report_json(run, args.label, args.expect_model), indent=2) + "\n",
            encoding="utf-8",
        )
    return _verdict(gate_failures(run.calls, None))


if __name__ == "__main__":
    sys.exit(main())
