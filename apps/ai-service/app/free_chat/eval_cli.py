"""The free-chat classifier's staging eval (ADR-0051 R20): a BASELINE, never a gate.

    python -m app.free_chat.eval_cli --base-url http://localhost:8000
    python -m app.free_chat.eval_cli --base-url http://localhost:8000 \\
        --expect-model gemini-2.5-flash-lite --pace-ms 4500

SCORES A RUNNING SERVICE over the labelled set (`eval_free_classify_gold`) through
``POST /free-chat/classify``, and prints the accuracy per category and per mode, what the misses
were classified as, and the p50/p95 latency. CI never runs this: the suite is mock-only, and the
deterministic half (the set's shape, the scorer, this CLI against a fake transport) lives in
`tests/free_chat/`.

NO ACCURACY BAR, BY OWNER RULING. The feature is live on merge (R18) and this set is what the
prompt is improved against (R20), so a low accuracy is a number to record, not a failure. The
exit code is non-zero ONLY when the run is not evidence at all, by the companion eval's own
rules, shared rather than copied: an answer from the deterministic mock (is the task armed in the
target's ``AI_REAL_CALL_TASKS``?), a failed call, or an answer from a fallback model
(``--expect-model`` names the primary, ``--pace-ms`` keeps a rate-limited key under its RPM).

IT SCORES WHAT THE API WOULD ACT ON. A category below the API's confidence floor (0.6, ADR-0051
§3.2 rule 12) counts as ``unclear``, and an answer slower than the API's classify timeout counts
as unavailable, as does a blocked input: in résumé mode the API passes all of those to today's
interview, so none of them is a verdict.

WHAT IT SENDS. Each case's text, mode and question on screen, with no recent turns. Every line is
fabricated; the service applies its masking policy exactly as in production. Nothing here prints
a model's raw output: only categories, counts, timings and the fabricated case text.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass

# ONE CALL LAYER FOR EVERY STAGING EVAL: timing, retries, the mock/fallback contamination rules
# and the report lines are the companion eval's, imported rather than copied, so a fix to how a
# run is judged reaches this CLI too.
from ..companion.eval_cli import (
    CallLog,
    _call,
    _label,
    _print_calls,
    _served,
    _verdict,
    gate_failures,
)
from . import eval_free_classify_gold as gold

ROUTE = "/free-chat/classify"

#: The API's confidence floor for a free-chat verdict (ADR-0051 §3.2: "below 0.6" is clarify).
#: The classify prompt names the same number, pinned by a test.
MIN_CONFIDENCE = 0.6

#: The API's timeout for this route (ADR-0051 §3.3: "~2.5 s"). A slower answer never reaches a
#: worker: the API treats it as unavailable. Pinned to `apps/api/src/ai/ai.service.ts` by a test
#: once that client calls the route.
API_TIMEOUT_MS = 2_500.0


@dataclass
class FreeClassifyRun:
    score: gold.FreeClassifyScore
    calls: CallLog
    min_confidence: float
    #: Answers the model gave a category other than `unclear` for, below the floor.
    floored: int


def run_free_classify_eval(
    base_url: str,
    min_confidence: float = MIN_CONFIDENCE,
    *,
    pace_ms: int = 0,
    expect_model: str | None = None,
) -> FreeClassifyRun:
    """Score the classifier as the API acts on it: below ``min_confidence`` is ``unclear``, and
    a blocked, failed, mocked or late answer is unavailable (a miss for every category)."""
    calls = CallLog(pace_ms=pace_ms, expect_model=expect_model)
    floored = 0

    def predict(text: str, mode: str, question: str | None) -> str | None:
        nonlocal floored
        body = _served(
            _call(
                base_url,
                ROUTE,
                {"text": text, "recent_turns": [], "mode": mode, "pending_question": question},
                calls,
                _label(text),
                api_timeout_ms=API_TIMEOUT_MS,
            )
        )
        if body is None or body.get("blocked"):
            return None
        confidence = body.get("confidence")
        if not isinstance(confidence, int | float) or confidence < min_confidence:
            if body.get("category") != "unclear":
                floored += 1
            return "unclear"
        category = body.get("category")
        return category if isinstance(category, str) else None

    return FreeClassifyRun(gold.evaluate(predict), calls, min_confidence, floored)


def _fraction(correct: int, total: int) -> str:
    share = 0.0 if total == 0 else correct / total
    return f"{correct}/{total} = {share:.1%}"


def print_report(run: FreeClassifyRun) -> None:
    score = run.score
    print(
        f"free-chat classifier (baseline, no bar): {_fraction(score.correct, score.total)} "
        f"overall — scored after the API's confidence floor {run.min_confidence:.2f} "
        f"({run.floored} answers below it became unclear)"
    )
    for category, (correct, total) in score.per_category.items():
        print(f"  category {category:<11} {_fraction(correct, total)}")
    for mode, (correct, total) in score.per_mode.items():
        print(f"  mode     {mode:<11} {_fraction(correct, total)}")
    predicted = ", ".join(f"{label} ({count})" for label, count in score.predicted.items())
    print(f"predicted: {predicted}")
    _print_calls(run.calls, None)
    for miss in score.misses[:30]:
        print(f"  MISS {miss}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Free-chat classifier baseline (staging only)")
    parser.add_argument("--base-url", required=True, help="the ai-service under test")
    parser.add_argument(
        "--min-confidence",
        type=float,
        default=MIN_CONFIDENCE,
        help="the API's free-chat confidence floor (default 0.6)",
    )
    parser.add_argument(
        "--pace-ms",
        type=int,
        default=0,
        metavar="N",
        help="sleep N ms before every request but the first, so a rate-limited key stays under "
        "its RPM (default 0: no pause)",
    )
    parser.add_argument(
        "--expect-model",
        default=None,
        metavar="MODEL",
        help="the route's primary model id; any answer from another model fails the run "
        "(the only way to catch a run the fallback answered entirely)",
    )
    args = parser.parse_args(argv)
    if args.pace_ms < 0:
        parser.error("--pace-ms must be >= 0")
    if args.expect_model is not None and not args.expect_model.strip():
        parser.error("--expect-model must name a model")
    if not 0.0 <= args.min_confidence <= 1.0:
        parser.error("--min-confidence must be within 0..1")

    run = run_free_classify_eval(
        args.base_url,
        args.min_confidence,
        pace_ms=args.pace_ms,
        expect_model=args.expect_model,
    )
    print_report(run)
    # Evidence checks only (mock, failure, fallback): accuracy and latency are reported, not
    # gated, by owner ruling (ADR-0051 R18/R20).
    return _verdict(gate_failures(run.calls, None))


if __name__ == "__main__":
    sys.exit(main())
