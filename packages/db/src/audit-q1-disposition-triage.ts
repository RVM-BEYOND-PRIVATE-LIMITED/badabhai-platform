/**
 * Q1 triage pack — the machine-readable disposition artifact. **NON-BINDING.**
 *
 * Repository-only: no database, no provider, no credentials. The measured neighbour evidence
 * is read from the committed snapshot produced by `db:audit:q1-neighbours`, so this reproduces
 * from a clean checkout and never depends on the pooler.
 *
 * Fails closed on a malformed pack (`validateTriage`) rather than emitting a partial artifact:
 * an artifact that silently omits a skill is exactly the failure Q1 exists to prevent, one
 * level up.
 *
 *   pnpm db:audit:q1-triage [--batch=<dir>] [--json=<out>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ATTRIBUTE_TO_MATCH_SKILLS, MATCH_SKILLS } from "@badabhai/taxonomy";

import { batchScopeSkillIds } from "./embed-skill-aliases";
import { provenance, REPOSITORY_ONLY } from "./evidence-provenance";
import {
  FAMILIES,
  Q1_TRIAGE,
  summarizeTriage,
  validateTriage,
  type FamilyKey,
} from "./q1-disposition-triage";

const SCRIPT = "audit:q1-triage";
const DEFAULT_BATCH = "data/taxonomy/batches/batch_2026-08-16T14-30-41Z-remediation-phase9d";

const EVIDENCE = join(
  __dirname, "..", "..", "..",
  "docs", "registers", "taxonomy-decisions", "q1-neighbour-evidence.json",
);

interface NeighbourEvidence {
  measured_at: string;
  nearest_neighbour_is_mapped: number;
  probed: number;
  neighbours: Record<string, { skill_id: string; score: number; bridge: string[] }[]>;
}

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

function main(): void {
  const batchDir = arg("batch") ?? DEFAULT_BATCH;
  const promotable = batchScopeSkillIds(batchDir);
  const validMatchSkills = new Set(MATCH_SKILLS.map((m) => m.skillId));

  const problems = validateTriage(Q1_TRIAGE, promotable, validMatchSkills);
  if (problems.length > 0) {
    throw new Error(
      `[${SCRIPT}] the triage pack is invalid; refusing to emit a partial artifact:\n` +
        problems.map((p) => `  ${p.kind}: ${p.detail}`).join("\n"),
    );
  }

  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as NeighbourEvidence;
  const s = summarizeTriage(Q1_TRIAGE);

  console.log(`[${SCRIPT}] REPOSITORY-ONLY. No database, no provider. NON-BINDING.`);
  console.log(`  batch                       = ${batchDir}`);
  console.log(`  promotable skills           = ${s.total}`);
  console.log(`  match vocabulary            = ${validMatchSkills.size}\n`);
  console.log(`  MATCHED (proposed)          ${String(s.matched).padStart(5)}`);
  console.log(`  INTENTIONALLY_UNMATCHED     ${String(s.intentionallyUnmatched).padStart(5)}`);
  console.log(`  REVIEW                      ${String(s.review).padStart(5)}`);
  console.log(`  false friends named         ${String(s.falseFriendsNamed).padStart(5)}`);
  console.log(
    `\n  ${s.unrepresentedFamilies.length} of ${Object.keys(FAMILIES).length} trade families have NO match skill at all,\n` +
      `  covering ${s.skillsInUnrepresentedFamilies} of the ${s.total} promotable skills.`,
  );
  console.log(
    `\n  For comparison: the nearest already-triaged neighbour is MAPPED for ` +
      `${evidence.nearest_neighbour_is_mapped} of ${evidence.probed}.\n` +
      `  A similarity-driven triage would therefore propose ${evidence.nearest_neighbour_is_mapped} ` +
      `mappings; this pack proposes ${s.matched}.`,
  );

  console.log(`\n  === PROPOSED MATCHED (${s.matched}) — each needs the owner's ratification ===`);
  for (const r of Q1_TRIAGE.filter((x) => x.disposition === "MATCHED")) {
    console.log(`    ${r.skillId.padEnd(44)} -> ${r.candidates.join("+").padEnd(26)} ${r.confidence}`);
  }
  console.log(`\n  === REVIEW (${s.review}) ===`);
  for (const r of Q1_TRIAGE.filter((x) => x.disposition === "REVIEW")) {
    console.log(`    ${r.skillId.padEnd(44)} ?  ${r.candidates.join("+")}`);
  }

  const byFamily = Object.fromEntries(
    (Object.keys(FAMILIES) as FamilyKey[]).map((f) => {
      const rows = Q1_TRIAGE.filter((r) => r.family === f);
      return [
        f,
        {
          label: FAMILIES[f].label,
          vocabulary_represents_this_family: FAMILIES[f].represented,
          skills: rows.length,
          matched: rows.filter((r) => r.disposition === "MATCHED").length,
          review: rows.filter((r) => r.disposition === "REVIEW").length,
          intentionally_unmatched: rows.filter((r) => r.disposition === "INTENTIONALLY_UNMATCHED").length,
        },
      ];
    }),
  );

  const out = arg("json");
  if (out !== undefined) {
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          kind: "q1-disposition-triage",
          binding: false,
          ...provenance({
            source: `pnpm db:audit:q1-triage --batch=${batchDir}`,
            target: REPOSITORY_ONLY,
            readOnly: true,
            role: null,
            populationPredicate:
              `every skill_id in ${batchDir}/accepted-skills.jsonl — the promotable batch, ` +
              `NOT SKILL_CORPUS`,
          }),
          notice:
            "PROPOSALS ONLY. Nothing here is applied. ATTRIBUTE_TO_MATCH_SKILLS, MATCH_SKILLS " +
            "and SKILL_CORPUS are unmodified, no mskill_* was invented, and no skill was " +
            "promoted. Individual skill->mskill mappings remain subject to owner review.",
          batch: batchDir,
          match_vocabulary_size: validMatchSkills.size,
          bridge_keys: Object.keys(ATTRIBUTE_TO_MATCH_SKILLS).length,
          neighbour_evidence: {
            measured_at: evidence.measured_at,
            probed: evidence.probed,
            nearest_neighbour_is_mapped: evidence.nearest_neighbour_is_mapped,
            note:
              "Similarity would propose this many mappings. The pack proposes " +
              `${s.matched}. Recorded as a counter-example, not as support.`,
          },
          summary: {
            total: s.total,
            matched: s.matched,
            intentionally_unmatched: s.intentionallyUnmatched,
            review: s.review,
            false_friends_named: s.falseFriendsNamed,
            unrepresented_families: s.unrepresentedFamilies,
            skills_in_unrepresented_families: s.skillsInUnrepresentedFamilies,
          },
          by_family: byFamily,
          dispositions: Q1_TRIAGE.map((r) => ({
            skill_id: r.skillId,
            label: r.label,
            family: r.family,
            family_label: FAMILIES[r.family].label,
            candidates: r.candidates,
            proposed_disposition: r.disposition,
            confidence: r.confidence,
            rationale: r.rationale,
            false_friend: r.falseFriend ?? null,
            nearest_neighbour: evidence.neighbours[r.skillId]?.[0] ?? null,
          })),
          applied: 0,
          mskills_invented: 0,
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
