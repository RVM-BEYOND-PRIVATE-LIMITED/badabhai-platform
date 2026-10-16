"""The interview turn's replies under ADR-0057 — staging eval (#2310).

    python -m app.profiling.eval_turn_reply_cli --base-url http://localhost:8000
    python -m app.profiling.eval_turn_reply_cli --base-url http://localhost:8000 \\
        --expect-model claude-haiku-4-5 --pace-ms 1500

SCORES A RUNNING SERVICE through ``POST /profiling/turn``: the `bridge` lines over the bridge set
and the classic turns (given the profile so far) over the classic set (`eval_turn_reply_gold`).
Exits non-zero on a persona break, a classic question about a field the profile shows filled, or
a progress line without the real count — and, by the shared call layer's rules, on a run that is
not evidence (a mock answer: is `profiling_chat_turn` armed in the target's `AI_REAL_CALL_TASKS`?;
a failed call; an answer from a fallback model). The served rate is printed, not gated.

COST: one call per case on the box's provider account — local runs share production's Anthropic
credit, so estimate first and get the owner's OK. CI never runs this; `tests/` pins the set, the
scorer and this CLI against a fake transport. Every line is fabricated.
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
from . import eval_turn_reply_gold as gold

ROUTE = "/profiling/turn"

#: The API's timeout for this route (`PROFILING_TURN_TIMEOUT_MS` in `apps/api/src/ai`), pinned by
#: a test: an answer slower than it never reaches a worker.
API_TIMEOUT_MS = 13_000.0


@dataclass
class ReplyRun:
    score: gold.ReplyScore
    calls: CallLog


def run_reply_eval(base_url: str, *, pace_ms: int = 0, expect_model: str | None = None) -> ReplyRun:
    calls = CallLog(pace_ms=pace_ms, expect_model=expect_model)

    def reply_of(request: dict, label: str) -> str | None:
        body = _served(_call(base_url, ROUTE, request, calls, label, api_timeout_ms=API_TIMEOUT_MS))
        if body is None or body.get("blocked"):
            return None
        reply = body.get("reply_text")
        return reply if isinstance(reply, str) else None

    score = gold.evaluate(
        lambda case: reply_of(case.request(), _label(case.text)),
        lambda case: reply_of(case.request(), _label(case.text)),
    )
    return ReplyRun(score, calls)


def print_report(run: ReplyRun) -> None:
    score = run.score
    print("interview turn replies (ADR-0057)")
    print(
        f"served: bridge {score.bridge_served}/{score.bridge_total}, "
        f"classic {score.classic_served}/{score.classic_total} (reported, not gated)"
    )
    print(
        f"persona breaks: {len(score.persona_breaks)}; questions about a filled field: "
        f"{len(score.filled_asks)}; progress lines without the real count: "
        f"{len(score.progress_misses)} (bar: 0, 0 and 0)"
    )
    _print_calls(run.calls, None)
    for line in [*score.persona_breaks, *score.filled_asks, *score.progress_misses]:
        print(f"  MISS {line}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Interview turn reply eval (staging)")
    parser.add_argument("--base-url", required=True, help="the ai-service under test")
    parser.add_argument("--pace-ms", type=int, default=0, metavar="N")
    parser.add_argument("--expect-model", default=None, metavar="MODEL")
    args = parser.parse_args(argv)
    if args.pace_ms < 0:
        parser.error("--pace-ms must be >= 0")
    if args.expect_model is not None and not args.expect_model.strip():
        parser.error("--expect-model must name a model")
    run = run_reply_eval(args.base_url, pace_ms=args.pace_ms, expect_model=args.expect_model)
    print_report(run)
    return _verdict(run.score.failed + gate_failures(run.calls, None))


if __name__ == "__main__":
    sys.exit(main())
