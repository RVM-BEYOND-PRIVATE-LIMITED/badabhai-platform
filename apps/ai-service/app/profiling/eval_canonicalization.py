"""Canonicalization eval CLI — the one command behind the staging runbook.

Two modes, one gold set (``app.profiling.canonicalization_gold``):

  Heuristic (default, offline, no network)::

      python -m app.profiling.eval_canonicalization

    Scores the deterministic local heuristic. Prints overall + per-tier
    accuracy and a per-miss report. Exits 0 only if the heuristic clears its
    EXPECTED floor (core + negative >= 90%). The ``hard`` tier is informational
    here — it stresses the heuristic and must NOT fail this gate.

  Real (staging only)::

      python -m app.profiling.eval_canonicalization --real [--base-url URL]

    Points the extractor at a client that POSTs each FABRICATED transcript to
    the LOCAL ``POST /profile/extract`` and reads back ``canonical_role_id``.
    Scores ALL tiers (the real LLM is expected to clear the hard tier too) and
    exits non-zero if OVERALL accuracy < 90%. This is runbook step 4.

PRIVACY: every transcript is fabricated (no PII, no worker data). The ``--real``
path uses the normal endpoint, which pseudonymizes BEFORE any model call — this
CLI never bypasses pseudonymization and never makes a direct external LLM call.
"""

from __future__ import annotations

import argparse
import sys

from app.profiling import canonicalization_gold as gold

DEFAULT_BASE_URL = "http://localhost:8000"


class _RoleOnly:
    """Minimal object exposing ``.canonical_role_id`` for ``evaluate()``."""

    def __init__(self, canonical_role_id: str | None) -> None:
        self.canonical_role_id = canonical_role_id


def _make_real_extract_fn(
    base_url: str, timeout: float = 120.0, delay_seconds: float = 0.0
) -> gold.ExtractFn:
    """Return an extract_fn that POSTs each text to the LOCAL /profile/extract.

    The endpoint pseudonymizes first, then extracts (mock or real per the gate),
    and returns the legacy DraftProfile. We read back ``canonical_role_id`` only.

    ``timeout`` is generous because a real call may back off on a provider rate
    limit (429) server-side. ``delay_seconds`` paces the (sequential) requests to
    stay under a free-tier per-minute quota so calls succeed on the first try. A
    per-case transport error is reported and counted as a miss (None) rather than
    crashing the whole run.
    """
    import time

    import httpx  # local import: only needed for --real, keeps default path stdlib

    url = base_url.rstrip("/") + "/profile/extract"
    client = httpx.Client(timeout=timeout)

    def extract_fn(text: str) -> object:
        if delay_seconds:
            time.sleep(delay_seconds)
        try:
            resp = client.post(url, json={"transcript": text})
            resp.raise_for_status()
        except httpx.HTTPError as exc:  # timeout / non-2xx — count as a miss, keep going
            print(f"  [warn] request failed ({type(exc).__name__}); scoring as miss",
                  file=sys.stderr)
            return _RoleOnly(None)
        data = resp.json()
        profile = data.get("profile") or {}
        return _RoleOnly(profile.get("canonical_role_id"))

    return extract_fn


def _print_report(result: gold.EvalResult, *, gated_only: bool) -> None:
    counts = gold.tier_counts()
    print("Canonicalization eval - fabricated Hinglish gold set (no PII)")
    print(f"Gold cases: {len(gold.GOLD_CASES)}  " + "  ".join(
        f"{t}={n}" for t, n in counts.items()
    ))
    print("-" * 64)
    for tier in ("core", "negative", "hard"):
        tr = result.by_tier.get(tier)
        if tr is None:
            continue
        tag = ""
        if tier == "hard":
            tag = "  (informational - stresses heuristic; the LLM's bar)"
        print(f"{tier:9} {tr.accuracy:6.0%}  ({tr.hits}/{tr.total}){tag}")
    print("-" * 64)
    print(f"overall   {result.overall_accuracy:6.0%}  "
          f"({result.overall_hits}/{result.overall_total})")
    if gated_only:
        print(f"gated     {result.gated_accuracy:6.0%}  (core+negative - the CI floor)")

    if result.misses:
        print("\nMisses (text: expected X, got Y):")
        for tier in ("core", "negative", "hard"):
            tr = result.by_tier.get(tier)
            if not tr or not tr.misses:
                continue
            print(f"  [{tier}]")
            for miss in tr.misses:
                print(f"    {miss}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.profiling.eval_canonicalization",
        description="Score canonicalization over the fabricated Hinglish gold set.",
    )
    parser.add_argument(
        "--real",
        action="store_true",
        help="Score the LOCAL /profile/extract endpoint (staging runbook step 4) "
        "instead of the offline heuristic. Scores ALL tiers; exits non-zero if "
        "overall < 90%%.",
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"Base URL of the local AI service (default: {DEFAULT_BASE_URL}).",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.0,
        help="Seconds to pace between --real requests (stay under a free-tier "
        "per-minute quota, e.g. 4.0). Default 0 (no pacing).",
    )
    parser.add_argument(
        "--per-tier",
        type=int,
        default=None,
        help="Score only the first N cases of EACH tier (stratified subset). Lets "
        "a real run fit a tight quota (e.g. a free-tier 20/day cap) while still "
        "covering every tier. Default: the full gold set.",
    )
    args = parser.parse_args(argv)

    if args.real:
        # Real mode: score every tier against the live local endpoint.
        try:
            extract_fn = _make_real_extract_fn(args.base_url, delay_seconds=args.delay)
        except ImportError:
            print("error: --real needs httpx (pip install -r requirements-dev.txt)",
                  file=sys.stderr)
            return 2
        print(f"Mode: --real -> POST {args.base_url.rstrip('/')}/profile/extract "
              "(pseudonymizes first; fabricated data only)"
              + (f"  [per-tier subset: {args.per_tier}]" if args.per_tier else "") + "\n")
        result = gold.evaluate(extract_fn, per_tier_limit=args.per_tier)
        _print_report(result, gated_only=False)
        passed = result.overall_accuracy >= gold.THRESHOLD
        print(f"\n{'PASS' if passed else 'FAIL'}: overall "
              f"{result.overall_accuracy:.0%} {'>=' if passed else '<'} "
              f"{gold.THRESHOLD:.0%}")
        return 0 if passed else 1

    # Default mode: offline heuristic. Gate on core+negative only.
    print("Mode: heuristic (offline, deterministic - no network, no LLM)\n")
    result = gold.evaluate()
    _print_report(result, gated_only=True)
    passed = result.gated_accuracy >= gold.THRESHOLD
    print(f"\n{'PASS' if passed else 'FAIL'}: core+negative "
          f"{result.gated_accuracy:.0%} {'>=' if passed else '<'} "
          f"{gold.THRESHOLD:.0%}  (hard tier informational)")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
