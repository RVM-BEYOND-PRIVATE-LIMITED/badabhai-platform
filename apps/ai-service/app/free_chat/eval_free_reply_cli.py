"""The free-chat reply's served-rate eval (ADR-0051 §10, #2128), against a running service.

    python -m app.free_chat.eval_free_reply_cli --base-url http://localhost:8000 \\
        --expect-model claude-haiku-4-5 --dump-file reply-baseline.json
    node apps/api/dist/profiling/free-chat/free-chat-reply-served.js --file reply-baseline.json
    node apps/api/dist/profiling/free-chat/free-chat-reply-served.js \\
        --file reply-revised.json --baseline reply-baseline.json

RUNS THE SET (`eval_free_reply_gold`) through ``POST /free-chat/reply`` ``--repeats`` times (the
route samples at 0.5, so one pass is one draw; round 1 measured the same prompt at 117 and 131
of 138 on two 3-repeat runs, so the default is 10), and writes EVERY reply to ``--dump-file``. The
score is the API's: ``free-chat-reply-served.ts`` replays the dump through the response contract
and ``screenFreeChatAnswer``, the gate production runs, and with ``--baseline`` applies owner
ruling R31 to say whether a prompt revision may ship. This CLI prints only what it can know
without that gate: how many replies were answers, refusals per topic, and the calls.

NOT EVIDENCE, BY THE COMPANION EVAL'S SHARED RULES: a mock answer (is ``profiling_free_reply``
armed in the target's ``AI_REAL_CALL_TASKS``?), a failed call, or an answer from a model other
than ``--expect-model``. The exit code is non-zero then, and the dump records it (``evidence``
false), so the replay refuses to score it.

COST, AND WHOSE MONEY. A 10-repeat run is about 460 Haiku calls, roughly ₹150, on whatever
Anthropic account the target service holds. The laptop's key is the PRODUCTION account (round 1
drained its credit and the box's AI calls failed with it), so get the owner's OK first, run one
stream at a time, and mind the local service's in-process ₹200/day cap: past it, answers turn to
mocks and the run is not evidence.

WHAT IT PRINTS AND WRITES. Stdout carries counts, case ids and timings, never a reply. The dump
holds the fabricated case ids and each reply's contract fields (status, lines, chips, topic), the
serving model and whether it came inside the API's timeout: model output over fabricated input,
written only to the path the operator names.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

# ONE CALL LAYER FOR EVERY STAGING EVAL: timing, retries and the mock/fallback contamination rules
# are the companion eval's, imported rather than copied.
from ..companion.eval_cli import CallLog, _call, _label, _print_calls, _verdict, gate_failures
from . import eval_free_reply_gold as gold
from .eval_reply_language_cli import API_TIMEOUT_MS, ROUTE

#: The dump's self-description, read by the TS replay (pinned there).
DUMP_KIND = "free_chat_reply_eval"
DUMP_VERSION = 1
#: The ``--repeats`` bound; the replay's schema allows the same (pinned there).
MAX_REPEATS = 10

#: The contract fields a reply keeps in the dump; `ai_metadata` is the router's, not the reply.
_REPLY_FIELDS = ("status", "lines", "followup_chips", "topic")


@dataclass(frozen=True)
class Sample:
    case: gold.Case
    repeat: int
    #: The route's body, or None when the call gave nothing the API could act on.
    body: dict | None
    #: False when the model answered slower than the API's timeout (the API would serve the
    #: fallback line; the replay counts it so).
    in_time: bool


@dataclass
class ReplyRun:
    samples: list[Sample]
    calls: CallLog
    repeats: int
    cases: list[gold.Case]


def run_free_reply_eval(
    base_url: str,
    *,
    repeats: int = 1,
    pace_ms: int = 0,
    expect_model: str | None = None,
) -> ReplyRun:
    """Every case, ``repeats`` times, in set order per pass."""
    calls = CallLog(pace_ms=pace_ms, expect_model=expect_model)
    samples: list[Sample] = []
    for repeat in range(repeats):
        for case in gold.CASES:
            reply = _call(
                base_url,
                ROUTE,
                gold.request_body(case),
                calls,
                _label(case.text),
                api_timeout_ms=API_TIMEOUT_MS,
            )
            samples.append(
                Sample(
                    case,
                    repeat,
                    reply.payload if reply is not None else None,
                    reply.in_time if reply is not None else True,
                )
            )
    return ReplyRun(samples, calls, repeats, list(gold.CASES))


def print_report(run: ReplyRun) -> None:
    statuses: Counter[str] = Counter()
    topics: Counter[str] = Counter()
    for sample in run.samples:
        status = sample.body.get("status") if sample.body is not None else None
        statuses[status if isinstance(status, str) else "<unavailable>"] += 1
        if status == "refuse":
            topics[str(sample.body.get("topic"))] += 1
    print(
        f"free-chat reply eval: {len(run.cases)} cases x {run.repeats} repeats = "
        f"{len(run.samples)} replies"
    )
    print("  " + ", ".join(f"{status} {n}" for status, n in sorted(statuses.items())))
    if topics:
        print("  refused on: " + ", ".join(f"{t} {n}" for t, n in sorted(topics.items())))
    _print_calls(run.calls, None)
    print(
        "the served rate is the API gate's: replay the dump with "
        "free-chat-reply-served.js (apps/api)"
    )


def _reply_fields(body: dict | None) -> dict | None:
    if body is None:
        return None
    return {key: body[key] for key in _REPLY_FIELDS if key in body}


def dump_document(run: ReplyRun, not_evidence: list[str]) -> dict:
    """The dump: the run's self-description, then every sample in run order."""
    rows = []
    for sample in run.samples:
        meta = sample.body.get("ai_metadata") if sample.body is not None else None
        model = meta.get("model_name") if isinstance(meta, dict) else None
        rows.append(
            {
                "case_id": sample.case.id,
                "repeat": sample.repeat,
                "category": sample.case.category,
                "expect": sample.case.expect,
                "within_api_timeout": sample.in_time,
                "model": model if isinstance(model, str) else None,
                "reply": _reply_fields(sample.body),
            }
        )
    return {
        "kind": DUMP_KIND,
        "version": DUMP_VERSION,
        "expect_model": run.calls.expect_model,
        "repeats": run.repeats,
        "case_ids": [case.id for case in run.cases],
        "set_digest": gold.set_digest(run.cases),
        "evidence": not not_evidence,
        "not_evidence": not_evidence,
        "written": len(rows),
        "samples": rows,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Free-chat reply served-rate eval (staging only)")
    parser.add_argument("--base-url", required=True, help="the ai-service under test")
    parser.add_argument(
        "--repeats",
        type=int,
        default=10,
        metavar="N",
        help="run the whole set N times (default 10): the route samples, one pass is one draw",
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
        required=True,
        metavar="MODEL",
        help="the model the run must be served by; any answer from another model fails the run "
        "(required: the replay scores a run only on the model it names, R32)",
    )
    parser.add_argument(
        "--dump-file",
        type=Path,
        required=True,
        metavar="PATH",
        help="write every reply here (JSON), for free-chat-reply-served.js to score",
    )
    args = parser.parse_args(argv)
    if not 1 <= args.repeats <= MAX_REPEATS:
        parser.error(f"--repeats must be within 1..{MAX_REPEATS}")
    if args.pace_ms < 0:
        parser.error("--pace-ms must be >= 0")
    if not args.expect_model.strip():
        parser.error("--expect-model must name a model")

    run = run_free_reply_eval(
        args.base_url,
        repeats=args.repeats,
        pace_ms=args.pace_ms,
        expect_model=args.expect_model,
    )
    print_report(run)
    failed = gate_failures(run.calls, None)
    document = dump_document(run, failed)
    args.dump_file.write_text(json.dumps(document, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {document['written']} replies to {args.dump_file}")
    return _verdict(failed)


if __name__ == "__main__":
    sys.exit(main())
