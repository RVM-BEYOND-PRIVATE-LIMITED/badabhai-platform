/**
 * Are the skills we are about to promote reachable by the runtime match path?
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * `ATTRIBUTE_TO_MATCH_SKILLS` is the only bridge from an extracted attribute skill to a
 * posting-level `mskill_*` (`d1-runtime-path-trace.md`). A test in `@badabhai/taxonomy`
 * asserts the bridge is EXHAUSTIVE, which sounds like full protection and is not: its universe
 * is `SKILL_CORPUS`, the 49 hand-authored seeds. A skill that never entered `SKILL_CORPUS` is
 * not unmapped-and-failing — it is outside the question the test asks.
 *
 * So a growth batch can promote to `active`, become visible to canonicalization and to the
 * corpus, and reach nothing at match time, with no test failing anywhere. This audit measures
 * that gap instead of assuming it either way.
 *
 * ===========================================================================
 * WHAT IT DOES NOT DO
 * ===========================================================================
 * It reports. It does not fail, does not gate, and does not map anything: whether a promotable
 * skill should imply a match skill is a triage decision with product consequences (mapping too
 * eagerly reaches a lathe hand for a programmer's vacancy), and it belongs to the owner of the
 * bridge, not to an audit script.
 *
 * Reads only committed files and code — no database, no provider, no credentials.
 *
 *   pnpm db:audit:bridge-coverage [--batch=<dir>] [--json=<out>]
 */
import { readFileSync, writeFileSync } from "node:fs";

import { ATTRIBUTE_TO_MATCH_SKILLS, SKILL_CORPUS } from "@badabhai/taxonomy";

import { provenance, REPOSITORY_ONLY } from "./evidence-provenance";

const SCRIPT = "audit:bridge-coverage";

/** The batch that would actually promote — the phase-9d derived set. */
const DEFAULT_BATCH = "data/taxonomy/batches/batch_2026-08-16T14-30-41Z-remediation-phase9d";

export type BridgeBucket =
  /** In the corpus and mapped to at least one `mskill_*`. */
  | "MAPPED"
  /** In the corpus and deliberately mapped to nothing — a triaged attribute. */
  | "INTENTIONALLY_UNMAPPED"
  /** In the corpus with no key at all. The exhaustiveness test would catch this. */
  | "MISSING_MAPPING"
  /** Not in `SKILL_CORPUS`, so no test asks the question and no triage was ever made. */
  | "OUTSIDE_CORPUS";

export interface BridgeCoverage {
  readonly total: number;
  readonly counts: Readonly<Record<BridgeBucket, number>>;
  readonly byBucket: Readonly<Record<BridgeBucket, readonly string[]>>;
}

/**
 * Pure classification, so the rule is testable without reading a batch off disk.
 *
 * The distinction that matters is `MISSING_MAPPING` vs `OUTSIDE_CORPUS`. Both mean "reaches no
 * match skill", but only the first is a bug the existing test can see.
 */
export function classifyBridgeCoverage(
  skillIds: readonly string[],
  corpusIds: ReadonlySet<string>,
  bridge: Readonly<Record<string, readonly string[]>>,
): BridgeCoverage {
  const byBucket: Record<BridgeBucket, string[]> = {
    MAPPED: [],
    INTENTIONALLY_UNMAPPED: [],
    MISSING_MAPPING: [],
    OUTSIDE_CORPUS: [],
  };

  for (const id of skillIds) {
    if (!corpusIds.has(id)) {
      byBucket.OUTSIDE_CORPUS.push(id);
      continue;
    }
    const mapped = bridge[id];
    if (mapped === undefined) byBucket.MISSING_MAPPING.push(id);
    else if (mapped.length === 0) byBucket.INTENTIONALLY_UNMAPPED.push(id);
    else byBucket.MAPPED.push(id);
  }

  for (const k of Object.keys(byBucket) as BridgeBucket[]) byBucket[k].sort();

  return {
    total: skillIds.length,
    counts: {
      MAPPED: byBucket.MAPPED.length,
      INTENTIONALLY_UNMAPPED: byBucket.INTENTIONALLY_UNMAPPED.length,
      MISSING_MAPPING: byBucket.MISSING_MAPPING.length,
      OUTSIDE_CORPUS: byBucket.OUTSIDE_CORPUS.length,
    },
    byBucket,
  };
}

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

export function readAcceptedSkillIds(batchDir: string): string[] {
  return readFileSync(`${batchDir}/accepted-skills.jsonl`, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !l.startsWith("#"))
    .map((l) => (JSON.parse(l) as { skill_id: string }).skill_id);
}

function main(): void {
  const batchDir = arg("batch") ?? DEFAULT_BATCH;
  const accepted = readAcceptedSkillIds(batchDir);
  const corpusIds = new Set(SKILL_CORPUS.map((s) => s.skillId));
  const bridge = ATTRIBUTE_TO_MATCH_SKILLS as Readonly<Record<string, readonly string[]>>;
  const cov = classifyBridgeCoverage(accepted, corpusIds, bridge);

  const mskills = new Set(Object.values(bridge).flat());

  console.log(`[${SCRIPT}] READ-ONLY. No database, no provider.`);
  console.log(`  batch                      = ${batchDir}`);
  console.log(`  promotable skills          = ${cov.total}`);
  console.log(`\n  === the bridge itself ===`);
  console.log(`  SKILL_CORPUS               = ${corpusIds.size}`);
  console.log(`  ATTRIBUTE_TO_MATCH_SKILLS  = ${Object.keys(bridge).length} keys`);
  console.log(`  distinct mskill_* targets  = ${mskills.size}`);
  console.log(`  exhaustiveness test covers = SKILL_CORPUS only`);

  console.log(`\n  === promotable skills, by runtime reachability ===`);
  console.log(`  in corpus, mapped                  ${String(cov.counts.MAPPED).padStart(5)}`);
  console.log(`  in corpus, intentionally unmapped  ${String(cov.counts.INTENTIONALLY_UNMAPPED).padStart(5)}`);
  console.log(`  in corpus, MISSING a mapping       ${String(cov.counts.MISSING_MAPPING).padStart(5)}   <- the exhaustiveness test WOULD fail`);
  console.log(`  outside SKILL_CORPUS               ${String(cov.counts.OUTSIDE_CORPUS).padStart(5)}   <- no test asks; no triage exists`);

  const reachable = cov.counts.MAPPED;
  const untriaged = cov.counts.MISSING_MAPPING + cov.counts.OUTSIDE_CORPUS;
  console.log(`\n  reachable at match time    = ${reachable} of ${cov.total}`);
  console.log(`  never triaged              = ${untriaged} of ${cov.total}`);

  if (cov.counts.OUTSIDE_CORPUS > 0) {
    console.log(
      `\n  These would promote to \`active\` and reach NOTHING at match time, and no test\n` +
        `  would fail, because the exhaustiveness test's universe is SKILL_CORPUS and they\n` +
        `  are not in it. Sample:`,
    );
    for (const id of cov.byBucket.OUTSIDE_CORPUS.slice(0, Number(arg("limit") ?? 15))) {
      console.log(`     ${id}`);
    }
    const rest = cov.counts.OUTSIDE_CORPUS - Number(arg("limit") ?? 15);
    if (rest > 0) console.log(`     (${rest} more)`);
  }

  console.log(
    `\n  This audit reports. Whether a promotable skill SHOULD imply an mskill_* is a triage\n` +
      `  decision owned by the bridge owner — mapping eagerly is how an unrelated worker\n` +
      `  reaches a specialist vacancy. Nothing here is changed automatically.`,
  );

  const out = arg("json");
  if (out !== undefined) {
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          kind: "runtime-bridge-coverage",
          ...provenance({
            source: "pnpm db:audit:bridge-coverage",
            target: REPOSITORY_ONLY,
            readOnly: true,
            role: null,
            populationPredicate: `accepted-skills.jsonl of ${batchDir}`,
          }),
          batch: batchDir,
          skill_corpus_size: corpusIds.size,
          bridge_keys: Object.keys(bridge).length,
          distinct_match_skills: mskills.size,
          ...cov,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`\n  written to ${out}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
