"""The profiling turn's understanding — staging eval and the flag's GATE (ADR-0057 §6, #2309).

    python -m app.profiling.eval_understand_cli --base-url http://localhost:8000
    python -m app.profiling.eval_understand_cli --base-url http://localhost:8000 \\
        --expect-model claude-haiku-4-5 --pace-ms 1500

SCORES A RUNNING SERVICE over the gold set (`eval_understand_gold`) through
``POST /profiling/understand`` and exits non-zero when a bar is missed: intent accuracy >= 90%,
fill precision >= 95%, 0 keys outside the schema and 0 false-positive deletes (owner ruling
2026-10-16). A PASS recorded under `docs/qa/evidence/turn-understanding/` is the precondition for
appending the task to the box's `AI_REAL_CALL_TASKS` and arming `CHAT_TURN_UNDERSTANDING_ENABLED`.
CI never runs this: the suite is mock-only, and the deterministic half (the set's shape and
containment, the scorer, this CLI against a fake transport) lives in `tests/`.

ONE CALL LAYER FOR EVERY STAGING EVAL. Timing, the retry, and the rules that make a run
evidence — an answer from the deterministic mock (is the task armed?), a failed call, or an answer
from a fallback model (``--expect-model`` names the primary) each fail the run — are the
companion eval's, imported rather than copied.

IT SCORES WHAT THE API WOULD ACT ON: a blocked, failed, mocked or late answer is no answer (the API
runs today's pipeline for that turn). COST: one call per case on the box's provider account —
local runs share production's Anthropic credit, so estimate first and get the owner's OK.

WHAT IT SENDS. Each case's text, question on screen and schema (the frozen fixture plus the case's
overrides). Every line is fabricated. Nothing here prints a model's raw output: only intents,
counts, timings and the fabricated case text with the proposed keys and values.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass

from ..companion.eval_cli import (
    CallLog,
    _call,
    _label,
    _print_calls,
    _served,
    _verdict,
    gate_failures,
)
from . import eval_understand_gold as gold

ROUTE = "/profiling/understand"
TASK_TYPE = "profiling_turn_understand"

#: The API's timeout for this route (`AiService.understandTurn`), pinned by a test: an answer
#: slower than it never reaches a worker.
API_TIMEOUT_MS = 4_000.0


@dataclass
class UnderstandRun:
    score: gold.UnderstandScore
    calls: CallLog


def _prediction(body: dict) -> gold.Prediction | None:
    """The served body as the scorer reads it, or None for a blocked answer."""
    if body.get("blocked"):
        return None
    intent = body.get("intent")
    fills = [
        (fill.get("key"), fill.get("value"))
        for fill in body.get("fills", [])
        if isinstance(fill, dict)
    ]
    edits = [
        (edit.get("op"), edit.get("key"), edit.get("ref"), edit.get("value"))
        for edit in body.get("edits", [])
        if isinstance(edit, dict)
    ]
    mentions = [m for m in body.get("page_owned_mentions", []) if isinstance(m, str)]
    return (intent if isinstance(intent, str) else "unclear", fills, edits, mentions)


def run_understand_eval(
    base_url: str, *, pace_ms: int = 0, expect_model: str | None = None
) -> UnderstandRun:
    calls = CallLog(pace_ms=pace_ms, expect_model=expect_model)

    def predict(case: gold.Case) -> gold.Prediction | None:
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
        return None if body is None else _prediction(body)

    return UnderstandRun(gold.evaluate(predict), calls)


def print_report(run: UnderstandRun) -> None:
    score = run.score
    print(f"profiling turn understanding — {score.total} cases")
    print(
        f"intent accuracy: {score.intent_correct}/{score.total} = {score.intent_accuracy:.1%} "
        f"(bar >= {gold.INTENT_THRESHOLD:.0%})"
    )
    print(
        f"fill precision: {score.fills_correct}/{score.fills_proposed} = "
        f"{score.fill_precision:.1%} (bar >= {gold.FILL_PRECISION_THRESHOLD:.0%}); "
        f"fill recall {score.fills_found}/{score.fills_required} (reported, not gated)"
    )
    print(f"edits exact: {score.edits_exact}/{score.total} (reported, not gated)")
    print(
        f"keys outside the schema: {len(score.out_of_schema)}; "
        f"false-positive deletes: {len(score.false_deletes)} (bar: 0 and 0)"
    )
    _print_calls(run.calls, None)
    for miss in score.misses:
        print(f"  MISS {miss}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Profiling turn understanding eval (staging)")
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
    args = parser.parse_args(argv)
    if args.pace_ms < 0:
        parser.error("--pace-ms must be >= 0")
    if args.expect_model is not None and not args.expect_model.strip():
        parser.error("--expect-model must name a model")

    run = run_understand_eval(args.base_url, pace_ms=args.pace_ms, expect_model=args.expect_model)
    print_report(run)
    return _verdict(run.score.failed + gate_failures(run.calls, None))


if __name__ == "__main__":
    sys.exit(main())
