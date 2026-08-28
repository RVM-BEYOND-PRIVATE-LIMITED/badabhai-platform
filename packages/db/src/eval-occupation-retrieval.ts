/**
 * `pnpm db:eval:occupation` — measure L0+L1 occupation retrieval against the gold set.
 *
 * THE PHASE 2 ACCEPTANCE GATE. The plan's criterion is "L0+L1 hit rate >= 60% on the gold
 * set measured OFFLINE with embeddings off". This script is that measurement, and it
 * needs neither a database nor a provider: it reads the committed corpus, builds the
 * index in memory, and scores the committed gold set. A developer with a git checkout can
 * reproduce the number exactly, which is the whole point — a gate that only one machine
 * can evaluate is not a gate.
 *
 *   pnpm db:eval:occupation                 # report
 *   pnpm db:eval:occupation --failures      # also list every miss, for corpus authoring
 *   pnpm db:eval:occupation --min-hit-rate 60
 *
 * EXIT CODE 1 WHEN THE FLOOR IS MISSED, so CI can hold the line once Phase 2 lands. The
 * floor is a flag rather than a constant because the target moves: 60% is the Phase 2
 * criterion, Phase 9 re-derives it against real traffic.
 *
 * PRIVACY: reads committed reference data only. Logged failures are gold-set utterances,
 * which are authored rather than worker-derived — see the gold file's header.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { JOB_DOMAIN_DATA_DIR, resolveJobDomainCorpus } from "./job-domain-corpus";
import {
  buildOccupationIndex,
  scoreGoldSet,
  scoreGoldSetByFamily,
  type FamilyLookup,
  type GoldUtterance,
} from "./occupation-retrieval-eval";
import { loadQuestionPackCorpus } from "./question-pack-corpus";
import { resolveFamily, type ResolvableBinding } from "./question-pack-resolver";

const SCRIPT = "eval:occupation";

export const GOLD_PATH = join(JOB_DOMAIN_DATA_DIR, "__gold__", "occupation-gold.jsonl");

/** Read the gold set. Blank lines and `#` comments carry the provenance header. */
export function loadGoldSet(path: string = GOLD_PATH): GoldUtterance[] {
  if (!existsSync(path)) throw new Error(`gold set not found at ${path}`);
  const out: GoldUtterance[] = [];
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) return;
      try {
        out.push(JSON.parse(trimmed) as GoldUtterance);
      } catch {
        throw new Error(`${path}:${i + 1} is not valid JSON`);
      }
    });
  return out;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * The family lookup, built from the COMMITTED pack corpus rather than the database.
 *
 * Same reasoning as the rest of this harness: the number it prints must be reproducible
 * from a git checkout alone, so a reviewer can re-derive it without a seeded Postgres.
 * `resolveFamily` is the function the live engine calls, so the chain measured here and
 * the chain a worker meets are the same code.
 */
function buildFamilyLookup(): FamilyLookup {
  // The loader, not the resolver: `resolveQuestionPackCorpus` also validates, and a
  // half-authored pack should not make the RETRIEVAL number unmeasurable.
  const corpus = loadQuestionPackCorpus();
  const bindings: ResolvableBinding[] = corpus.bindings.map((b) => ({
    familyId: b.family_id,
    jobDomainId: b.job_domain_id ?? null,
    iscoUnitCode: b.isco_unit_code ?? null,
    iscoMinorCode: b.isco_minor_code ?? null,
    iscoSubmajorCode: b.isco_submajor_code ?? null,
    iscoMajorCode: b.isco_major_code ?? null,
    isUniversal: b.is_universal ?? false,
  }));
  return (jobDomainId, iscoUnitCode) =>
    resolveFamily(bindings, { jobDomainId, iscoUnitCode })?.familyId ?? null;
}

function main(): void {
  const argv = process.argv.slice(2);
  const showFailures = argv.includes("--failures");
  const floorIdx = argv.indexOf("--min-hit-rate");
  const floor = floorIdx >= 0 ? Number(argv[floorIdx + 1]) / 100 : 0.6;

  const corpus = resolveJobDomainCorpus();
  const index = buildOccupationIndex(corpus);
  const gold = loadGoldSet();
  const r = scoreGoldSet(index, gold);

  console.log(`[${SCRIPT}] index: ${index.spans.exact.size} exact keys, ${index.spans.skeleton.size} skeleton keys`);
  console.log(`[${SCRIPT}] gold set: ${r.total} utterances`);
  console.log(`[${SCRIPT}] results:`);
  console.log(`  L0 exact correct            = ${r.l0}  (${pct(r.l0 / r.total)})`);
  console.log(`  L1 skeleton correct         = ${r.l1}  (${pct(r.l1 / r.total)})`);
  console.log(`  wrong unit (false positive) = ${r.wrongUnit}  (${pct(r.wrongUnit / r.total)})`);
  console.log(`  no match at all             = ${r.miss}  (${pct(r.miss / r.total)})`);
  console.log(`  L0+L1 HIT RATE              = ${pct(r.hitRate)}  (floor ${pct(floor)})`);
  console.log(`  precision of answers given  = ${pct(r.precision)}`);

  if (showFailures) {
    console.log(`[${SCRIPT}] failures:`);
    for (const f of r.failures) {
      const got = f.got === null ? "NO MATCH" : `${f.got} via ${f.layer}`;
      // Fully literal format string — same reasoning as the miner, and the gold set will
      // eventually be rebuilt from real worker utterances.
      console.log("  want %s  got %s  %s", f.expected, got.padEnd(28), JSON.stringify(f.utterance));
    }
  }

  // ── Family-level precision: the Phase 7 criterion ──────────────────────────────
  //
  // Reported UNCONDITIONALLY, not behind a flag. It is the number the plan gates on, and a
  // number nobody prints is a number nobody checks — which is how the unit-level proxy
  // ended up standing in for it through three merged PRs.
  const famFloorIdx = argv.indexOf("--min-family-precision");
  const famFloor = famFloorIdx >= 0 ? Number(argv[famFloorIdx + 1]) / 100 : 0.97;
  const fam = scoreGoldSetByFamily(index, gold, buildFamilyLookup());

  console.log(`[${SCRIPT}] family-level (the Phase 7 criterion):`);
  console.log(`  correct family              = ${fam.correct}`);
  console.log(`  refined to a sub-unit family = ${fam.refined}  (counted correct)`);
  console.log(`  WRONG family                = ${fam.wrongFamily}`);
  console.log(`  no match                    = ${fam.miss}`);
  console.log(`  gold rows with no family    = ${fam.unbound}  (excluded)`);
  console.log(`  FAMILY PRECISION            = ${pct(fam.precision)}  (floor ${pct(famFloor)})`);
  console.log(`  family coverage             = ${pct(fam.coverage)}`);

  // ALWAYS PRINTED, never behind --failures. A refinement is counted as correct, so the one
  // way it could do harm is by being invisible: a binding authored at the wrong granularity
  // would quietly move utterances into a new family and the precision number would not move.
  // Listing them makes every such move show up in the CI log of the PR that caused it.
  if (fam.refinements.length > 0) {
    console.log(`[${SCRIPT}] refinements (a MORE SPECIFIC family under the gold row's own unit):`);
    for (const r of fam.refinements) {
      console.log(
        "  label says %s  resolved to %s  %s",
        r.expectedFamily.padEnd(24),
        r.gotFamily.padEnd(24),
        JSON.stringify(r.utterance),
      );
    }
  }

  if (showFailures && fam.failures.length > 0) {
    console.log(`[${SCRIPT}] family failures:`);
    for (const f of fam.failures) {
      console.log(
        "  want %s  got %s  %s",
        f.expectedFamily.padEnd(24),
        (f.gotFamily ?? "NO MATCH").padEnd(24),
        JSON.stringify(f.utterance),
      );
    }
  }

  const hitRateFailed = r.hitRate < floor;
  const familyFailed = fam.precision < famFloor;

  if (hitRateFailed) {
    console.error(
      `[${SCRIPT}] FAIL — hit rate ${pct(r.hitRate)} is below the ${pct(floor)} floor. ` +
        `Re-run with --failures and author aliases for the misses.`,
    );
  }
  if (familyFailed) {
    console.error(
      `[${SCRIPT}] FAIL — family precision ${pct(fam.precision)} is below the ${pct(famFloor)} ` +
        `floor. A wrong family makes every later question in the interview wrong.`,
    );
  }
  // BOTH are evaluated before exiting, so one run reports every problem. Same discipline as
  // the corpus validators: never throw on the first.
  if (hitRateFailed || familyFailed) process.exit(1);

  console.log(
    `[${SCRIPT}] PASS — hit rate ${pct(r.hitRate)} >= ${pct(floor)}, ` +
      `family precision ${pct(fam.precision)} >= ${pct(famFloor)}.`,
  );
}

// Guarded so importing this module for its helpers does not run the evaluation — the
// same footgun `verify-job-domains.ts` was bitten by, where a test's import executed the
// script and killed the vitest process.
if (process.argv[1] && /eval-occupation-retrieval/.test(process.argv[1])) {
  main();
}
