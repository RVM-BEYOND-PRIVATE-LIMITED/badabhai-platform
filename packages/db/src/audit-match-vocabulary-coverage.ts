/**
 * Q1 — the match-vocabulary coverage report, over the batch that would actually promote.
 *
 * The rule lives in `match-vocabulary-coverage.ts`; this is the reporting surface. Reads only
 * committed files and code — **no database, no provider, no credentials** — so it is immune to
 * the intermittent pooler and reproduces identically from a clean checkout.
 *
 * Distinct from `db:audit:bridge-coverage`, which answers a neighbouring question and stops at
 * "outside SKILL_CORPUS". This one refuses that answer: being outside the seed corpus is not a
 * category a promotable skill is allowed to rest in. It needs a decision either way.
 *
 *   pnpm db:audit:match-vocabulary [--batch=<dir>] [--json=<out>] [--limit=<n>]
 */
import { writeFileSync } from "node:fs";

import { ATTRIBUTE_TO_MATCH_SKILLS, MATCH_SKILLS, SKILL_CORPUS } from "@badabhai/taxonomy";

import { batchScopeSkillIds } from "./embed-skill-aliases";
import { provenance, REPOSITORY_ONLY } from "./evidence-provenance";
import { vocabularyCoverage, type VocabularyDecision } from "./match-vocabulary-coverage";

const SCRIPT = "audit:match-vocabulary";

/** The batch that would actually promote — the phase-9d derived set. */
const DEFAULT_BATCH = "data/taxonomy/batches/batch_2026-08-16T14-30-41Z-remediation-phase9d";

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

function main(): void {
  const batchDir = arg("batch") ?? DEFAULT_BATCH;
  const limit = Number(arg("limit") ?? 15);
  const scope = batchScopeSkillIds(batchDir);
  const validMatchSkills = new Set(MATCH_SKILLS.map((m) => m.skillId));
  const cov = vocabularyCoverage(scope, ATTRIBUTE_TO_MATCH_SKILLS, validMatchSkills);

  const corpusIds = new Set(SKILL_CORPUS.map((s) => s.skillId));
  const inCorpus = scope.filter((id) => corpusIds.has(id)).length;

  console.log(`[${SCRIPT}] READ-ONLY. No database, no provider.`);
  console.log(`  batch                        = ${batchDir}`);
  console.log(`  promotable skills (universe) = ${cov.total}`);
  console.log(`  ...of which in SKILL_CORPUS  = ${inCorpus}`);
  console.log(`  match vocabulary             = ${validMatchSkills.size} mskill_*`);
  console.log(`  bridge keys                  = ${Object.keys(ATTRIBUTE_TO_MATCH_SKILLS).length}`);

  console.log(`\n  === match-vocabulary decision, per promotable skill ===`);
  const row = (label: string, n: number, note = ""): void =>
    console.log(`  ${label.padEnd(34)}${String(n).padStart(5)}   ${note}`);
  row("matched", cov.counts.MATCHED);
  row("intentionally unmatched", cov.counts.INTENTIONALLY_UNMATCHED, "explicit [] — passes");
  row("MISSING a decision", cov.counts.MISSING_DECISION, "<- blocks promotion");
  row("matched to an UNKNOWN mskill", cov.counts.INVALID_TARGET, "<- blocks promotion");

  console.log(`\n  TRIPWIRE = ${cov.passed ? "PASS" : "FAIL"}   (${cov.blocking.length} blocking)`);

  if (cov.blocking.length > 0) {
    console.log(`\n  These would promote to \`active\` and reach NOTHING at match time:`);
    for (const id of cov.blocking.slice(0, limit)) console.log(`     ${id}`);
    const rest = cov.blocking.length - limit;
    if (rest > 0) console.log(`     (${rest} more)`);
    console.log(
      `\n  Each needs ONE of, in ATTRIBUTE_TO_MATCH_SKILLS:\n` +
        `     <skill_id>: ["mskill_..."]   a mapping into the match vocabulary\n` +
        `     <skill_id>: []               an explicit "stays an attribute"\n` +
        `\n  NOTHING HERE WILL GENERATE THAT. Which one a skill deserves is a product\n` +
        `  judgement owned by the bridge owner; mapping eagerly is how an unrelated worker\n` +
        `  reaches a specialist vacancy.`,
    );
  }

  const out = arg("json");
  if (out !== undefined) {
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          kind: "match-vocabulary-coverage",
          ...provenance({
            source: `pnpm db:audit:match-vocabulary --batch=${batchDir}`,
            target: REPOSITORY_ONLY,
            readOnly: true,
            role: null,
            populationPredicate:
              `every skill_id in ${batchDir}/accepted-skills.jsonl — the batch that would ` +
              `promote, NOT SKILL_CORPUS`,
          }),
          batch: batchDir,
          universe: "promotable batch (accepted-skills.jsonl)",
          promotable_skills: cov.total,
          promotable_also_in_skill_corpus: inCorpus,
          skill_corpus_size: corpusIds.size,
          match_vocabulary_size: validMatchSkills.size,
          bridge_keys: Object.keys(ATTRIBUTE_TO_MATCH_SKILLS).length,
          counts: cov.counts,
          by_decision: cov.byDecision as Readonly<Record<VocabularyDecision, readonly string[]>>,
          blocking: cov.blocking,
          tripwire_passed: cov.passed,
          decisions_generated: 0,
          mappings_proposed: 0,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`\n  written to ${out}`);
  }
}

if (require.main === module) main();
