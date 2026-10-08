"""The free-chat reply-language eval (ADR-0051 §11, #2181), against a running service.

    python -m app.free_chat.eval_reply_language_cli --base-url http://localhost:8000 \\
        --omit-language --expect-model claude-haiku-4-5 --dump-file baseline.json
    python -m app.free_chat.eval_reply_language_cli --base-url http://localhost:8000 \\
        --expect-model claude-haiku-4-5 --dump-file revised.json
    python -m app.free_chat.eval_reply_language_cli --rescore baseline.json

SCORES A RUNNING SERVICE over the reply-language set (`eval_free_reply_language`) through
``POST /free-chat/reply``, and prints, per reply language, per case kind and overall: language
adherence, non-Latin replies, persona slips and verbatim repeats, plus the misses. CI never runs
this: the suite is mock-only, and the deterministic half (the set's shape, the scorer, this CLI
against a fake transport) lives in `tests/free_chat/`.

TWO RUNS MAKE ONE MEASUREMENT. ``--omit-language`` is the BASELINE: no ``reply_language``, so
the prompt's own rules choose (what an API that predates §11 sends). Without it the case's
``reply_language`` rides the request, as the §11 API sends it. Compare the two on one model.

NO BAR, ONLY EVIDENCE CHECKS. The exit code is non-zero only when the run is not evidence, by the
companion eval's shared rules: a mock answer (is ``profiling_free_reply`` armed in the target's
``AI_REAL_CALL_TASKS``?), a failed call, or an answer from a model other than ``--expect-model``.
A reply slower than the API's timeout is still SCORED (the question is what the model wrote) and
listed.

WHAT IT PRINTS AND WRITES. Stdout carries counts, timings, case ids and the scorer's verdicts,
never a model's reply. ``--dump-file`` writes every reply (fabricated case, lines, chips and the
verdicts) to the file the operator names, for review, and nowhere else.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

# ONE CALL LAYER FOR EVERY STAGING EVAL: timing, retries and the mock/fallback contamination rules
# are the companion eval's, imported rather than copied.
from ..companion.eval_cli import CallLog, _call, _label, _print_calls, _verdict, gate_failures
from . import eval_free_reply_language as gold

ROUTE = "/free-chat/reply"

#: The API client's timeout for this route (`apps/api/src/ai/ai.service.ts`, pinned by a test).
API_TIMEOUT_MS = 10_000.0

#: The worker context every case sends: unknown, as for a worker whose résumé is not made yet.
WORKER_CONTEXT = {"trade_label": None, "experience_bucket": None}


@dataclass
class ReplyLanguageRun:
    score: gold.LanguageScore
    calls: CallLog
    #: False for the baseline (``--omit-language``).
    sent_language: bool
    #: case id -> the route's body (None when the call gave nothing), for ``--dump-file``.
    bodies: dict[str, dict | None]


def request_body(case: gold.Case, *, send_language: bool) -> dict:
    """The body the API would post for ``case``; ``reply_language`` only when it is sent."""
    body: dict = {
        "category": case.category,
        "text": case.text,
        "recent_turns": [{"role": role, "text": text} for role, text in case.turns],
        "worker_context": dict(WORKER_CONTEXT),
    }
    if send_language:
        body["reply_language"] = case.reply_language
    return body


def run_reply_language_eval(
    base_url: str,
    *,
    send_language: bool = True,
    pace_ms: int = 0,
    expect_model: str | None = None,
    case_ids: list[str] | None = None,
) -> ReplyLanguageRun:
    """Run the set (or the cases named by ``case_ids``, in set order) against ``base_url``."""
    cases = gold.CASES if case_ids is None else [c for c in gold.CASES if c.id in case_ids]
    calls = CallLog(pace_ms=pace_ms, expect_model=expect_model)
    bodies: dict[str, dict | None] = {}

    def predict(case: gold.Case) -> dict | None:
        reply = _call(
            base_url,
            ROUTE,
            request_body(case, send_language=send_language),
            calls,
            _label(case.text),
            api_timeout_ms=API_TIMEOUT_MS,
        )
        # A LATE reply is still scored: the language is the question, not the latency.
        payload = reply.payload if reply is not None else None
        bodies[case.id] = payload
        return payload

    return ReplyLanguageRun(gold.evaluate(predict, cases), calls, send_language, bodies)


def _rate(hit: int, total: int) -> str:
    share = 0.0 if total == 0 else hit / total
    return f"{hit}/{total} = {share:.0%}"


def _tally_line(name: str, tally: gold.Tally) -> str:
    return (
        f"  {name:<9} language {_rate(tally.adhered, tally.answered):<12} "
        f"non-Latin {tally.non_latin}  slips {tally.slipped}  repeats {tally.repeated}  "
        f"(cases {tally.cases}, refused {tally.refused}, unavailable {tally.unavailable})"
    )


def print_report(run: ReplyLanguageRun) -> None:
    mode = (
        "REVISED, reply_language sent" if run.sent_language else "BASELINE, reply_language omitted"
    )
    score = run.score
    print(
        f"free-chat reply language ({mode}): {_rate(score.overall.adhered, score.overall.answered)}"
    )
    print("per reply language (adherence over answered replies; slips and repeats are answers):")
    for language, tally in score.per_language.items():
        print(_tally_line(language, tally))
    print("per case kind:")
    for kind, tally in score.per_kind.items():
        print(_tally_line(kind, tally))
    print(_tally_line("overall", score.overall))
    if run.calls.sent:
        _print_calls(run.calls, None)
    else:
        print("re-scored from a dump: no calls made (spend and latency are the original run's)")
    for miss in score.misses:
        print(f"  MISS {miss}")


def rescore(path: Path) -> ReplyLanguageRun:
    """A dump re-scored by today's scorer, with NO call: so two runs written at different times
    are compared by one scorer. Rows are matched to the set by case id; a case the dump lacks is
    unavailable. The call log is empty (spend and latency are the original run's)."""
    rows = json.loads(path.read_text(encoding="utf-8"))
    by_id = {row["id"]: row for row in rows if isinstance(row, dict) and "id" in row}
    sent = any(row.get("sent_language") for row in by_id.values())
    bodies: dict[str, dict | None] = {}

    def predict(case: gold.Case) -> dict | None:
        row = by_id.get(case.id)
        body = None
        if row is not None and row.get("status") in (gold.ANSWER, gold.REFUSE):
            body = {
                "status": row["status"],
                "lines": row.get("lines"),
                "followup_chips": row.get("followup_chips"),
                "topic": row.get("topic"),
                "ai_metadata": {"model_name": row.get("model")},
            }
        bodies[case.id] = body
        return body

    return ReplyLanguageRun(gold.evaluate(predict), CallLog(), sent, bodies)


def write_dump(path: Path, run: ReplyLanguageRun) -> None:
    """Every reply with its verdicts, for the operator's review. Fabricated cases only."""
    rows = []
    for result in run.score.results:
        body = run.bodies.get(result.case.id) or {}
        meta = body.get("ai_metadata") if isinstance(body.get("ai_metadata"), dict) else {}
        rows.append(
            {
                "id": result.case.id,
                "reply_language": result.case.reply_language,
                "sent_language": run.sent_language,
                "kind": result.case.kind,
                "script": result.case.script,
                "text": result.case.text,
                "status": result.status,
                "lines": body.get("lines"),
                "followup_chips": body.get("followup_chips"),
                "topic": body.get("topic"),
                "model": meta.get("model_name"),
                "detected": result.detected,
                "adhered": result.adhered,
                "non_latin": result.non_latin,
                "slips": list(result.slips),
                "repeat": result.repeat,
                "markers": dict(result.counts),
            }
        )
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {len(rows)} replies to {path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Free-chat reply-language eval (staging only)")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--base-url", help="the ai-service under test")
    target.add_argument(
        "--rescore",
        type=Path,
        default=None,
        metavar="DUMP",
        help="re-score a --dump-file with today's scorer, making no call",
    )
    parser.add_argument(
        "--omit-language",
        action="store_true",
        help="the BASELINE: send no reply_language, so the prompt's own rules choose",
    )
    parser.add_argument(
        "--pace-ms",
        type=int,
        default=0,
        metavar="N",
        help="sleep N ms before every request but the first (default 0: no pause)",
    )
    parser.add_argument(
        "--expect-model",
        default=None,
        metavar="MODEL",
        help="the model the run must be served by; any answer from another model fails the run",
    )
    parser.add_argument(
        "--cases",
        default=None,
        metavar="IDS",
        help="comma-separated case ids: run only these (a cheap re-check of earlier misses)",
    )
    parser.add_argument(
        "--dump-file",
        type=Path,
        default=None,
        metavar="PATH",
        help="write every reply and its verdicts here (JSON), for review",
    )
    args = parser.parse_args(argv)
    if args.pace_ms < 0:
        parser.error("--pace-ms must be >= 0")
    if args.expect_model is not None and not args.expect_model.strip():
        parser.error("--expect-model must name a model")
    case_ids = None
    if args.cases is not None:
        case_ids = [part.strip() for part in args.cases.split(",") if part.strip()]
        unknown = sorted(set(case_ids) - {case.id for case in gold.CASES})
        if not case_ids or unknown:
            parser.error(f"--cases names no case or an unknown one: {', '.join(unknown)}")

    if args.rescore is not None:
        print_report(rescore(args.rescore))
        return 0
    run = run_reply_language_eval(
        args.base_url,
        send_language=not args.omit_language,
        pace_ms=args.pace_ms,
        expect_model=args.expect_model,
        case_ids=case_ids,
    )
    print_report(run)
    if args.dump_file is not None:
        write_dump(args.dump_file, run)
    # Evidence checks only (mock, failure, fallback): the scores are compared across runs, not
    # gated here.
    return _verdict(gate_failures(run.calls, None))


if __name__ == "__main__":
    sys.exit(main())
