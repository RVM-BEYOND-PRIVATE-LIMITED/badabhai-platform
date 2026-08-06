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
  type GoldUtterance,
} from "./occupation-retrieval-eval";

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

function main(): void {
  const argv = process.argv.slice(2);
  const showFailures = argv.includes("--failures");
  const floorIdx = argv.indexOf("--min-hit-rate");
  const floor = floorIdx >= 0 ? Number(argv[floorIdx + 1]) / 100 : 0.6;

  const corpus = resolveJobDomainCorpus();
  const index = buildOccupationIndex(corpus);
  const gold = loadGoldSet();
  const r = scoreGoldSet(index, gold);

  console.log(`[${SCRIPT}] index: ${index.exact.size} exact keys, ${index.skeleton.size} skeleton keys`);
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
      // Utterance passed as a separate argument, not interpolated — same reasoning as the
      // miner: console.log honours format specifiers only in its first argument, and the
      // gold set will eventually be rebuilt from real worker text.
      console.log(`  want ${f.expected}  got ${got.padEnd(28)}  %s`, JSON.stringify(f.utterance));
    }
  }

  if (r.hitRate < floor) {
    console.error(
      `[${SCRIPT}] FAIL — hit rate ${pct(r.hitRate)} is below the ${pct(floor)} floor. ` +
        `Re-run with --failures and author aliases for the misses.`,
    );
    process.exit(1);
  }
  console.log(`[${SCRIPT}] PASS — ${pct(r.hitRate)} >= ${pct(floor)}.`);
}

// Guarded so importing this module for its helpers does not run the evaluation — the
// same footgun `verify-job-domains.ts` was bitten by, where a test's import executed the
// script and killed the vitest process.
if (process.argv[1] && /eval-occupation-retrieval/.test(process.argv[1])) {
  main();
}
