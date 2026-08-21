/**
 * The offline shadow S3-D's abort thresholds were supposed to be derived from.
 *
 * ===========================================================================
 * WHY THIS EXISTS, AND WHAT IT REFUSES TO DO
 * ===========================================================================
 * `phase-9-s3-deployment-plan.md` lists five abort signals and then says, correctly:
 *
 *     No threshold is fixed here. Inventing one before the shadow data exists is the mistake
 *     REGRESSION_BASELINE's own comment warns about.
 *
 * The shadow data never existed, because the S3-C dual-read was never built. So the thresholds
 * have stayed un-derived and S3-D has stayed gated on a table of blanks — which reads like a
 * checklist item and is actually the whole safety argument.
 *
 * This produces the measurements. It does NOT propose a number for any of them, and there is
 * deliberately no `--threshold` argument to pass one in: a tool that both measures and judges
 * invites someone to tune the judgement until the measurement passes.
 *
 * ===========================================================================
 * WHY OFFLINE, AND WHAT THAT COSTS
 * ===========================================================================
 * A live dual-read would be the better instrument and is a request-path change to a system
 * whose flags are all off. This runs entirely from the committed fixture and the local vector
 * cache: no provider call, no database write, no request-path code, nothing to enable.
 *
 * What it therefore CANNOT measure, stated rather than glossed:
 *   - LATENCY. There is no request here. The p95 signal needs the live shadow.
 *   - `unresolved_phrase` VOLUME. That is a production time series, not a corpus property; the
 *     pre-switch baseline is a database read (9 rows today) and the comparison is post-switch.
 *   - REAL QUERY DISTRIBUTION. The fixture is 127 curated cases, not traffic. Every rate below
 *     is over that set, and an operator must not read it as a production rate.
 *
 * It CAN measure, from data that already exists:
 *   - Path A empty-rate vs Path B empty-rate
 *   - top-1 agreement / disagreement, with every disagreement ENUMERATED so "any unclassified
 *     disagreement" is answerable rather than aspirational
 *   - score delta distribution between the two paths on the cases where both resolve
 *   - GP-04 specifically, because the plan names it and pins 0.75
 *
 *   pnpm db:report:s3d-shadow --vectors=<tsv> [--json=<out>] [--if-promoted]
 *
 * `--if-promoted` reports the same signals over a corpus where provisional skills are
 * retrievable. It is a COUNTERFACTUAL — no database is in that state — and it exists because
 * the default run's headline finding is "Path A is empty because those skills are provisional",
 * which is only actionable next to a number for what promoting them would recover.
 */
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { config } from "dotenv";

import { argValue } from "./match-v1-cli";
import { loadEvalFixture } from "./taxonomy-eval-fixture";
import { COVERAGE_ONLY_CATEGORIES } from "./taxonomy-retrieval-eval";
import { LEGACY_ANCHOR_SKILL_DOMAIN } from "./path-a-replay";

config();

const SCRIPT = "report:s3d-shadow";

/** One case, seen by both paths. */
export interface ShadowCase {
  readonly caseId: string;
  readonly jobDomainId: string;
  readonly aTop1: string | null;
  readonly bTop1: string | null;
  readonly aScore: number | null;
  readonly bScore: number | null;
}

export interface ShadowReport {
  readonly cases: number;
  readonly aEmpty: number;
  readonly bEmpty: number;
  /** Positive = Path A returns nothing more often than Path B. The plan's first signal. */
  readonly emptyRateDelta: number;
  readonly bothResolved: number;
  readonly agreeTop1: number;
  readonly disagreeTop1: number;
  readonly agreementRate: number;
  /** Every disagreement, so "any unclassified disagreement" can actually be checked. */
  readonly disagreements: readonly { caseId: string; jobDomainId: string; a: string | null; b: string | null; scoreDelta: number | null }[];
  /** Score-delta distribution over cases both paths resolved. */
  readonly scoreDelta: { min: number; p50: number; p95: number; max: number } | null;
}

/** Percentile by nearest-rank on a sorted array. Small n here, so exactness beats interpolation. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

/**
 * Reduce the paired observations to the four measurable signals.
 *
 * Pure, and it reports rather than judges: there is no pass/fail anywhere in the return type,
 * because the thresholds are the owner's to set from exactly this output.
 */
export function summarizeShadow(cases: readonly ShadowCase[]): ShadowReport {
  const aEmpty = cases.filter((c) => c.aTop1 === null).length;
  const bEmpty = cases.filter((c) => c.bTop1 === null).length;
  const both = cases.filter((c) => c.aTop1 !== null && c.bTop1 !== null);
  const agree = both.filter((c) => c.aTop1 === c.bTop1);
  const disagree = both.filter((c) => c.aTop1 !== c.bTop1);
  const deltas = both
    .filter((c) => c.aScore !== null && c.bScore !== null)
    .map((c) => (c.aScore as number) - (c.bScore as number))
    .sort((x, y) => x - y);

  return {
    cases: cases.length,
    aEmpty,
    bEmpty,
    emptyRateDelta: cases.length === 0 ? 0 : (aEmpty - bEmpty) / cases.length,
    bothResolved: both.length,
    agreeTop1: agree.length,
    disagreeTop1: disagree.length,
    agreementRate: both.length === 0 ? 0 : agree.length / both.length,
    disagreements: disagree.map((c) => ({
      caseId: c.caseId,
      jobDomainId: c.jobDomainId,
      a: c.aTop1,
      b: c.bTop1,
      scoreDelta: c.aScore !== null && c.bScore !== null ? Number((c.aScore - c.bScore).toFixed(6)) : null,
    })),
    scoreDelta:
      deltas.length === 0
        ? null
        : {
            min: Number((deltas[0] as number).toFixed(6)),
            p50: Number(percentile(deltas, 50).toFixed(6)),
            p95: Number(percentile(deltas, 95).toFixed(6)),
            max: Number((deltas[deltas.length - 1] as number).toFixed(6)),
          },
  };
}

/** The signals this instrument structurally cannot produce. Printed, never silently omitted. */
export const UNMEASURABLE_OFFLINE: readonly { signal: string; why: string; needs: string }[] = [
  {
    signal: "latency p95",
    why: "there is no request in an offline replay",
    needs: "the live dual-read shadow, or a load test against a switched read path",
  },
  {
    signal: "unresolved_phrase volume",
    why: "a production time series, not a corpus property",
    needs: "the pre-switch count (read it now) compared against the post-switch count",
  },
  {
    signal: "real query distribution",
    why: "the fixture is 127 curated cases, not traffic",
    // WAS "which nothing records today", and that was the sharper problem: the ai-service
    // `record_unresolved` seam had no `job_domain_id` parameter at all, so a Path A miss was
    // discarded before it reached `unresolved_phrase` — flipping the switch would have hidden
    // exactly the failures this signal is derived from. That seam now carries the id end to
    // end (ProfileExtractionInput -> canonicalize_labels -> record_unresolved -> the v2 event),
    // so what remains is traffic, not plumbing.
    needs: "captured (phrase, job_domain_id) pairs from a caller that populates the canonical scope",
  },
];

async function main(): Promise<void> {
  const vectorFile = argValue("vectors");
  if (vectorFile === undefined) {
    console.error(`[${SCRIPT}] --vectors=<tsv> is required (read-only export; see replay-path-a.ts).`);
    process.exit(2);
  }
  const jsonOut = argValue("json");

  // Reuse the replay's own corpus + ranking rather than re-deriving them here. A second
  // implementation of "what does Path A see" is the defect this whole phase keeps finding.
  const { buildReplayInputs, runBothPaths, poolComposition } = await import("./s3d-shadow-inputs");
  const fixture = loadEvalFixture(join(__dirname, "..", "data", "taxonomy", "eval", "retrieval-v2.jsonl"));
  const scoring = fixture.cases.filter((c) => !COVERAGE_ONLY_CATEGORIES.has(c.category));

  // `--if-promoted` answers the ONE question the default run raises and cannot settle: the
  // default says "Path A is empty on most cases because those skills are provisional, so do not
  // flip" — and then offers no number for how much promotion would buy. Without it the
  // promotion decision has no measurement attached and stays a matter of opinion.
  //
  // It is a COUNTERFACTUAL, not a mode of production, and every line below says so. It changes
  // no default and relaxes no constant: `RETRIEVABLE_SKILL_STATUSES` is untouched and the
  // counterfactual reuses `PRE_PROMOTION_STATUSES`, the set the replay already uses for
  // `--include-provisional`.
  const ifPromoted = process.argv.slice(2).includes("--if-promoted");
  const semantics = ifPromoted ? "if_promoted" : "production";

  const inputs = buildReplayInputs(vectorFile);
  const cases = runBothPaths(inputs, scoring, 5, semantics);
  const report = summarizeShadow(cases);

  console.log(`[${SCRIPT}] OFFLINE. No provider call, no database write, no request-path change.`);
  if (ifPromoted) {
    console.log("");
    console.log("  ############################################################################");
    console.log("  ##  COUNTERFACTUAL: --if-promoted. Provisional skills are treated as       ##");
    console.log("  ##  retrievable. NO DATABASE IS IN THIS STATE. These numbers describe a    ##");
    console.log("  ##  corpus where promotion has ALREADY happened, and exist only to price   ##");
    console.log("  ##  that promotion. Do not quote them as current coverage.                 ##");
    console.log("  ############################################################################");
    console.log("");
  }
  console.log(`  semantics                = ${semantics === "production" ? "PRODUCTION (active only)" : "COUNTERFACTUAL (active + provisional)"}`);
  console.log(`  cases (scoring only)     = ${report.cases}`);
  console.log("");

  // === signal 0 — the candidate pool ========================================================
  // Printed FIRST and before any rate, because every number below is a property of this pool,
  // and reading them without it is how this report's own headline came to name the wrong cause.
  const pool = poolComposition(inputs.input);
  console.log(`  === signal 0 — what is even in the candidate pool ===`);
  console.log(`  edges (domain -> skill)  = ${pool.edges}`);
  for (const [st, n] of Object.entries(pool.skillsByStatus).sort()) {
    const v = pool.aliasVectors[st];
    const cover = v === undefined ? "no aliases" : `${v.embedded}/${v.total} aliases embedded`;
    console.log(`  ${st.padEnd(13)} ${String(n).padStart(4)} skill(s)   ${cover}`);
  }
  console.log(`  promotion would add      = ${pool.promotionWouldAdd} rankable skill(s)`);
  console.log(
    `     A skill needs BOTH a retrievable status AND an embedded alias. Promotion moves only
` +
      `     the first. That number is how much of Path A's empty-rate a promotion can possibly
` +
      `     recover — verify it with --if-promoted rather than assuming either way.`,
  );
  console.log("");
  console.log(`  === signal 1 — Path A empty-rate vs Path B ===`);
  console.log(`  Path A returned nothing  = ${report.aEmpty}`);
  console.log(`  Path B returned nothing  = ${report.bEmpty}`);
  console.log(`  delta (A - B) / cases    = ${(report.emptyRateDelta * 100).toFixed(2)}%   <- the plan aborts if A exceeds B "by any margin agreed from shadow data"`);
  if (report.aEmpty > report.bEmpty) {
    console.log(
      `  !! Path A returns NOTHING far more often than Path B, so flipping the read switch on
` +
        `     these numbers would blank the majority of queries. That much is unchanged and it is
` +
        `     still the most decision-relevant number here.
` +
        `
` +
        `     WHAT CHANGED IS THE CAUSE. This line used to say the skills are 'provisional' and
` +
        `     that S3-D therefore cannot be flipped BEFORE PROMOTION. Measured with --if-promoted
` +
        `     on 2026-08-20 that is wrong: promotion produces an IDENTICAL empty-rate, identical
` +
        `     top-1 agreement and identical score deltas. Signal 0 above says why — a skill needs
` +
        `     a retrievable status AND an embedded alias, and the growth corpus has essentially no
` +
        `     vectors. Promotion is not the blocker. EMBEDDING COVERAGE is, and that is a provider
` +
        `     run and a seed rather than a status flip.`,
    );
  }
  console.log("");
  console.log(`  === signal 2 — top-1 disagreement ===`);
  console.log(`  both paths resolved      = ${report.bothResolved}`);
  console.log(`  agree on top-1           = ${report.agreeTop1}`);
  console.log(`  DISAGREE                 = ${report.disagreeTop1}  (agreement ${(report.agreementRate * 100).toFixed(2)}%)`);
  for (const d of report.disagreements.slice(0, 30)) {
    console.log(`     ${d.caseId.padEnd(10)} ${d.jobDomainId.padEnd(18)} A=${String(d.a).padEnd(34)} B=${String(d.b).padEnd(34)} Δscore=${d.scoreDelta ?? "-"}`);
  }
  if (report.disagreements.length > 30) console.log(`     … and ${report.disagreements.length - 30} more (see --json)`);
  console.log(`  Every disagreement is listed. The plan aborts on "ANY disagreement unclassified",`);
  console.log(`  which is only answerable against a list — classification is a human read of this.`);
  console.log("");
  console.log(`  !! READ THE DISAGREEMENT RATE WITH THIS CAVEAT, OR DO NOT READ IT AT ALL.`);
  console.log(`  Path A is scoped PER JOB DOMAIN; Path B is scoped to the single legacy anchor slug`);
  console.log(`  '${LEGACY_ANCHOR_SKILL_DOMAIN}' for every case, because that is what the legacy caller`);
  console.log(`  actually passes. The two are therefore answering different questions for most cases,`);
  console.log(`  and the disagreement count is dominated by that structural mismatch rather than by any`);
  console.log(`  ranking difference. Use the LIST to classify individual cases; do not use the RATE as`);
  console.log(`  the plan's "top-1 disagreement" threshold until a per-domain Path B comparison exists.`);
  console.log("");
  console.log(`  === signal 3 — score delta (A - B), where both resolved ===`);
  console.log(
    report.scoreDelta === null
      ? "  no paired scores"
      : `  min ${report.scoreDelta.min}  p50 ${report.scoreDelta.p50}  p95 ${report.scoreDelta.p95}  max ${report.scoreDelta.max}`,
  );
  console.log("");
  console.log(`  === signals this instrument CANNOT produce ===`);
  for (const u of UNMEASURABLE_OFFLINE) {
    console.log(`  ${u.signal.padEnd(26)} ${u.why}`);
    console.log(`  ${"".padEnd(26)} needs: ${u.needs}`);
  }
  console.log("");
  console.log(`  NO THRESHOLD IS PROPOSED. This produces the distribution the owner sets them from.`);
  if (!ifPromoted) {
    console.log("");
    console.log(`  Re-run with --if-promoted to price the promotion this report keeps pointing at.`);
  }

  if (jsonOut !== undefined) {
    if (existsSync(jsonOut)) {
      console.error(`  refusing to overwrite ${jsonOut} — evidence is never replaced.`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(
      jsonOut,
      `${JSON.stringify({ kind: "s3d-shadow-report", offline: true, unmeasurable: UNMEASURABLE_OFFLINE, report }, null, 2)}\n`,
      "utf8",
    );
    console.log(`  written to ${jsonOut}`);
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
