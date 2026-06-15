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

MEASUREMENT CORRECTNESS: in ``--per-field --real`` the rig reads each call's
``ai_metadata.real_call`` + ``ai_metadata.success`` (NOT the top-level
``is_mock``, which only means "real was attempted"). The ONLY valid per-case
outcome is a genuine real success (``real_call=true AND success=true``). Two ways
a case is contaminated: ``real_call=true AND success=false`` is a MOCK FALLBACK
(the router returned mock content after a model failure, e.g. a 429); and
``real_call=false`` means NO real call was made at all (a TD27 spend-cap block,
the kill-switch engaging, or the task not being in ``AI_REAL_CALL_TASKS``). If ANY
scored case is not a genuine real success the run is INVALID — it prints a loud
banner and exits non-zero WITHOUT a PASS/FAIL aggregate, so a throttled/erroring/
spend-capped run can never read as a valid >=90% result. Use ``--min-interval
SECONDS`` to pace a low-RPM free tier (paid billing is the clean path).

PRIVACY: every transcript is fabricated (no PII, no worker data). The ``--real``
path uses the normal endpoint, which pseudonymizes BEFORE any model call — this
CLI never bypasses pseudonymization and never makes a direct external LLM call.
"""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import dataclass
from dataclasses import field as dc_field

from app.profiling import canonicalization_gold as gold
from app.profiling import miss_attribution as attrib

DEFAULT_BASE_URL = "http://localhost:8000"


@dataclass
class RealCallCollector:
    """Records the ``ai_metadata`` outcome of every real ``/profile/extract`` call.

    The endpoint returns ``ai_metadata.real_call`` (was a real model call
    attempted) and ``ai_metadata.success`` (did it succeed). During a --real run
    the ONLY acceptable outcome is a genuine real success
    (``real_call=True AND success=True``). Two contamination modes:

      * ``real_call=True AND success=False`` — the real attempt failed (e.g. a
        429) and the router silently returned MOCK content as a fallback.
      * ``real_call=False`` — no real call was made at all (TD27 spend cap, the
        kill-switch, or the task not in ``AI_REAL_CALL_TASKS``).

    Either way, scoring that case would score MOCK output as if it were a real
    measurement.

    We capture these per call (NOT ``is_mock``, which only reflects "real was
    attempted") so the runner can reject a contaminated run. The OFFLINE
    heuristic path never feeds this collector, so a run with no recorded calls is
    treated as "not a real run" and scored normally.
    """

    outcomes: list[tuple[bool, bool]] = dc_field(default_factory=list)

    def record(self, *, real_call: bool, success: bool) -> None:
        self.outcomes.append((real_call, success))

    @property
    def total(self) -> int:
        return len(self.outcomes)

    @property
    def fell_back(self) -> list[tuple[bool, bool]]:
        """Calls where a real attempt failed -> mock-fallback content was scored.

        ``real_call=True AND success=False``: the router attempted a real model
        call, it failed (e.g. a 429), and MOCK content was returned as a fallback.
        """
        return [(rc, ok) for (rc, ok) in self.outcomes if rc and not ok]

    @property
    def not_real(self) -> list[tuple[bool, bool]]:
        """Calls where NO real model call was made during a --real run.

        ``real_call=False``: the router returned MOCK without ever attempting a
        real call — the TD27 spend cap blocked it, the kill-switch is engaged, or
        the task is not in ``AI_REAL_CALL_TASKS``. Scoring these would score MOCK
        output as if it were a real measurement.
        """
        return [(rc, ok) for (rc, ok) in self.outcomes if not rc]

    @property
    def real_success(self) -> list[tuple[bool, bool]]:
        """The ONLY acceptable per-case outcome in a --real run: a genuine real
        success (``real_call=True AND success=True``)."""
        return [(rc, ok) for (rc, ok) in self.outcomes if rc and ok]

    @property
    def contaminated(self) -> bool:
        """True if ANY scored case is NOT a genuine real success — covering both a
        mock fallback (``real_call=True, success=False``) and no real call at all
        (``real_call=False``)."""
        return bool(self.fell_back or self.not_real)


class _RoleOnly:
    """Minimal object exposing ``.canonical_role_id`` for ``evaluate()``."""

    def __init__(self, canonical_role_id: str | None) -> None:
        self.canonical_role_id = canonical_role_id


class _Experience:
    def __init__(self, total_years: float | None) -> None:
        self.total_years = total_years


class _ProfileView:
    """Full per-field view over the endpoint JSON for ``evaluate_per_field()``.

    Exposes the same surface as the legacy ``DraftProfile`` (trade/role/skills/
    machines/experience.total_years) so the SAME per-field scorers run on both
    the heuristic object and the real endpoint response — one scoring path."""

    def __init__(self, profile: dict) -> None:
        self.canonical_trade_id = profile.get("canonical_trade_id")
        self.canonical_role_id = profile.get("canonical_role_id")
        self.skills = list(profile.get("skills") or [])
        self.machines = list(profile.get("machines") or [])
        exp = profile.get("experience") or {}
        self.experience = _Experience(exp.get("total_years"))


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


def _make_real_field_extract_fn(
    base_url: str,
    timeout: float = 30.0,
    *,
    collector: RealCallCollector | None = None,
    min_interval: float = 0.0,
) -> gold.FieldExtractFn:
    """Return a per-field extract_fn that POSTs each text to /profile/extract and
    reads back the FULL profile surface (trade/role/skills/machines/experience).

    Same endpoint, same pseudonymize-first gate; we just read more fields back.

    ``collector`` (if given) records each call's ``ai_metadata.real_call`` +
    ``ai_metadata.success`` so the runner can detect mock-fallback contamination
    (real attempt failed -> the router returned MOCK content). We read
    ``ai_metadata`` as the source of truth, NOT the top-level ``is_mock`` (which
    only reflects "real was attempted").

    ``min_interval`` (seconds) sleeps between calls so a low-RPM free tier does
    not mass-429. Default 0 = no pacing (paid billing is the clean path)."""
    import httpx

    url = base_url.rstrip("/") + "/profile/extract"
    client = httpx.Client(timeout=timeout)
    _last_call_at: list[float] = []  # mutable cell for the closure

    def extract_fn(text: str) -> object:
        if min_interval > 0 and _last_call_at:
            elapsed = time.monotonic() - _last_call_at[0]
            if elapsed < min_interval:
                time.sleep(min_interval - elapsed)
        resp = client.post(url, json={"transcript": text})
        _last_call_at[:] = [time.monotonic()]
        resp.raise_for_status()
        data = resp.json() or {}
        if collector is not None:
            meta = data.get("ai_metadata") or {}
            collector.record(
                real_call=bool(meta.get("real_call", False)),
                success=bool(meta.get("success", True)),
            )
        profile = data.get("profile") or {}
        return _ProfileView(profile)

    return extract_fn


def _make_real_pseudonymize_fn(base_url: str, timeout: float = 30.0) -> attrib.PseudonymizeFn:
    """Return a pseudonymize_fn that POSTs to the LOCAL /pseudonymize endpoint.

    Miss attribution uses this so it tests over-masking against the SAME gateway
    the extraction path runs — never inspecting the original<->token mapping
    (the endpoint never returns it)."""
    import httpx

    url = base_url.rstrip("/") + "/pseudonymize"
    client = httpx.Client(timeout=timeout)

    def pseudonymize_fn(text: str) -> str:
        resp = client.post(url, json={"text": text})
        resp.raise_for_status()
        return (resp.json() or {}).get("pseudonymized_text", "")

    return pseudonymize_fn


def _smoke_profiling_respond(base_url: str, timeout: float = 30.0) -> bool:
    """Exercise POST /profiling/respond once so the per-field rig touches BOTH
    real endpoints (the brief requires both). Returns True if the turn was not
    blocked. Uses a fabricated, PII-free utterance."""
    import httpx

    url = base_url.rstrip("/") + "/profiling/respond"
    with httpx.Client(timeout=timeout) as client:
        resp = client.post(url, json={
            "session_id": "eval-smoke",
            "message_text": "vmc operator hu, fanuc pe kaam karta hu",
        })
        resp.raise_for_status()
        return not (resp.json() or {}).get("blocked", False)


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


def _print_per_field_report(
    result: gold.PerFieldEvalResult, summary: attrib.AttributionSummary
) -> None:
    print("Per-field extraction eval - fabricated Hinglish gold set (no PII)")
    print("Match semantics: trade/role=exact, skills/machines=subset, "
          f"experience=+/-{gold.EXPERIENCE_TOLERANCE_YEARS}yr")
    print("-" * 64)
    print(f"{'field':12} {'acc':>6}  count")
    for field in gold.FIELD_NAMES:
        fr = result.by_field.get(field)
        if fr is None:
            continue
        print(f"{field:12} {fr.accuracy:6.0%}  ({fr.hits}/{fr.total})")
    print("-" * 64)
    print(f"{'AGGREGATE':12} {result.aggregate_accuracy:6.0%}  "
          f"({result.aggregate_hits}/{result.aggregate_total})  "
          f"[threshold {gold.PER_FIELD_THRESHOLD:.0%}]")

    if result.misses:
        print("\nMisses (per field):")
        for m in result.misses:
            print(f"    {m.as_miss_line()}")

    # Miss attribution: TD3 over-masking vs extraction error.
    print("\nMiss attribution (TD3 over-masking vs extraction error):")
    print(f"    over-masking (TD3): {len(summary.over_masking)}")
    print(f"    extraction error  : {len(summary.extraction_errors)}")
    dom = summary.dominant_cause
    print(f"    dominant cause    : {dom if dom else 'none (no misses)'}")
    if summary.attributions:
        for a in summary.attributions:
            print(f"      [{a.cause}] [{a.tier}/{a.field}] {a.text!r} "
                  f"(in_original={list(a.present_in_original)}, "
                  f"surviving={list(a.surviving)})")


def _print_invalid_real_run(collector: RealCallCollector) -> None:
    """Loud, unmistakable banner for a CONTAMINATED real run. No PASS/FAIL aggregate
    is emitted alongside this — a run that fell back to mock OR made no real call at
    all can never be read as a valid >=90% (or <90%) measurement.

    Reports BOTH contamination modes with distinct wording: a mock fallback after a
    real attempt failed (e.g. a 429), and no real call at all (spend cap engaged,
    kill-switch on, or task not allowlisted)."""
    n = collector.total
    n_fell_back = len(collector.fell_back)
    n_not_real = len(collector.not_real)
    print("\n" + "=" * 64)
    print(f"INVALID REAL RUN: {n_fell_back}/{n} cases fell back to mock "
          f"(provider error), {n_not_real}/{n} made no real call "
          "(spend cap / kill-switch / not allowlisted) — score NOT reported.")
    print("Detected via ai_metadata: a valid --real case needs real_call=true AND "
          "success=true. real_call=true+success=false is a provider-error fallback; "
          "real_call=false means no real call was made.")
    print("Hint: check GET /ai/spend (TD27 spend cap / kill-switch) and "
          "AI_REAL_CALL_TASKS; for provider errors enable paid billing or pace the "
          "run (--min-interval SECONDS), then retry.")
    print("=" * 64)


def _run_per_field(args) -> int:
    """Per-field eval (+ miss attribution). Heuristic by default; --real hits the
    live endpoints. Gates on AGGREGATE >= PER_FIELD_THRESHOLD.

    In --real mode the ONLY valid per-case outcome is a genuine real success
    (real_call=True AND success=True). The run is INVALID if ANY scored case
    either fell back to mock (a real attempt that 429'd/errored) OR made no real
    call at all (spend cap / kill-switch / task not allowlisted). We then print the
    INVALID banner and exit non-zero WITHOUT a PASS/FAIL aggregate — measurement
    correctness over a convenient-but-false number."""
    collector: RealCallCollector | None = None
    if args.real:
        collector = RealCallCollector()
        try:
            extract_fn = _make_real_field_extract_fn(
                args.base_url, collector=collector, min_interval=args.min_interval,
            )
            pseudo_fn = _make_real_pseudonymize_fn(args.base_url)
        except ImportError:
            print("error: --per-field --real needs httpx "
                  "(pip install -r requirements-dev.txt)", file=sys.stderr)
            return 2
        base = args.base_url.rstrip("/")
        pacing = (f" (pacing {args.min_interval:g}s between cases)"
                  if args.min_interval > 0 else "")
        print(f"Mode: --per-field --real -> POST {base}/profile/extract "
              f"+ {base}/profiling/respond + {base}/pseudonymize{pacing}\n"
              "(both endpoints pseudonymize first; fabricated data only)\n")
        # Touch BOTH real endpoints per the brief; respond is a smoke pass.
        try:
            ok = _smoke_profiling_respond(args.base_url)
            print(f"/profiling/respond smoke: {'ok' if ok else 'blocked'}\n")
        except Exception as exc:  # noqa: BLE001 - report, don't crash the eval
            print(f"/profiling/respond smoke: error ({exc})\n")
        result = gold.evaluate_per_field(extract_fn)
        summary = attrib.attribute_misses(result, pseudonymize_fn=pseudo_fn)
    else:
        print("Mode: --per-field (offline heuristic - no network, no LLM)\n")
        result = gold.evaluate_per_field()
        summary = attrib.attribute_misses(result)

    # Contaminated real run: reject before any aggregate can be misread as valid.
    if collector is not None and collector.contaminated:
        _print_invalid_real_run(collector)
        return 1

    if collector is not None:
        n_ok = len(collector.real_success)
        print(f"real calls: {n_ok}/{collector.total} succeeded\n")

    _print_per_field_report(result, summary)
    passed = result.aggregate_accuracy >= gold.PER_FIELD_THRESHOLD
    print(f"\n{'PASS' if passed else 'FAIL'}: aggregate "
          f"{result.aggregate_accuracy:.0%} {'>=' if passed else '<'} "
          f"{gold.PER_FIELD_THRESHOLD:.0%}")
    return 0 if passed else 1


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
        "--per-field",
        action="store_true",
        help="Score PER FIELD (trade/role/skills/machines/experience) + aggregate "
        "and attribute every miss to TD3 over-masking vs extraction error. "
        "Combine with --real to run against the live endpoints; exits non-zero if "
        "aggregate < 90%%.",
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
    parser.add_argument(
        "--min-interval",
        type=float,
        default=0.0,
        metavar="SECONDS",
        help="Seconds to sleep between cases in --per-field --real mode so a "
        "low-RPM FREE TIER does not mass-429 (default 0 = no pacing). Paid "
        "billing is the clean path; this lets a free-tier run complete.",
    )
    args = parser.parse_args(argv)

    if args.per_field:
        return _run_per_field(args)

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
