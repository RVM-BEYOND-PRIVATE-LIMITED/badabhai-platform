/**
 * RESOLVABLE_ABOVE_FLOOR, read out of a floor-sweep record — read-only, no provider call.
 *
 * The promotion runner evaluates this gate only as part of a full run it will not start
 * without BOTH evidence artifacts. This reads the sweep alone, so the question "which
 * candidates clear the canonicalization floor, and by how much" is answerable on its own.
 *
 * It uses the runner's exported bestCorrectScores and CANONICALIZATION_FLOOR, so there is one
 * copy of the rule. Only CORRECT resolutions count: a skill scoring 0.9 as the WRONG answer
 * has shown it can be confidently mis-assigned, which argues against promoting it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { bestCorrectScores, CANONICALIZATION_FLOOR } from "./promote-skills";

const DIR = "data/taxonomy/eval/experiments/EXP-P9-TRAINER-V3";
const sweepFile = readdirSync(DIR).filter((f) => f.startsWith("floor-sweep-")).sort().reverse()[0] as string;
const sweep = JSON.parse(readFileSync(`${DIR}/${sweepFile}`, "utf8")) as { corpus_fingerprint?: unknown };
const best = bestCorrectScores(sweep);

const accepted = readFileSync(
  "data/taxonomy/batches/batch_2026-08-16T14-30-41Z-remediation-phase9d/accepted-skills.jsonl",
  "utf8",
)
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.startsWith("#"))
  .map((l) => (JSON.parse(l) as { skill_id: string }).skill_id);

console.log(`sweep                    = ${sweepFile}`);
console.log(`carries corpus_fingerprint = ${sweep.corpus_fingerprint !== undefined}`);
console.log(`floor                    = ${CANONICALIZATION_FLOOR}`);
console.log(`candidates               = ${accepted.length}`);

let pass = 0;
const never: string[] = [];
const below: { id: string; s: number }[] = [];
for (const id of accepted) {
  const s = best.get(id);
  if (s === undefined) { never.push(id); continue; }
  if (s >= CANONICALIZATION_FLOOR) pass += 1;
  else below.push({ id, s });
}
console.log(`\nRESOLVABLE_ABOVE_FLOOR   pass=${pass}  below-floor=${below.length}  never-resolved=${never.length}`);
console.log(`\n--- resolved CORRECTLY but BELOW the ${CANONICALIZATION_FLOOR} floor (${below.length}) ---`);
for (const b of below.sort((a, c) => a.s - c.s)) console.log(`  ${b.s.toFixed(4)}  ${b.id}`);
console.log(`\n--- never resolved correctly in the sweep (${never.length}) ---`);
for (const n of never.sort()) console.log(`  ${n}`);
