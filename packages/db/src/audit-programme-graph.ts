/**
 * Render the programme graph — who is blocking what, and what can start today. NO DATABASE, ₹0.
 *
 * The graph itself lives in `programme-graph.ts` as typed data with a validator. This prints it
 * and writes the artifact, so the register carries a machine-readable copy that a later reader
 * can diff rather than re-derive from prose.
 *
 *   pnpm db:audit:programme-graph [--json=<out>]
 */
import { writeFileSync } from "node:fs";

import { provenance, REPOSITORY_ONLY } from "./evidence-provenance";
import {
  blockersOf,
  executable,
  PROGRAMME,
  statusCounts,
  validateProgramme,
  type ItemStatus,
} from "./programme-graph";

const SCRIPT = "audit:programme-graph";

/** The order a reader wants: what can move, then who is holding the rest. */
const ORDER: readonly ItemStatus[] = [
  "EXECUTABLE",
  "BLOCKED_ON_OWNER",
  "BLOCKED_ON_AI_SPEND",
  "BLOCKED_ON_PRODUCTION_WRITE",
  "BLOCKED_ON_DATA",
  "BLOCKED_ON_INFRA",
  "COMPLETE",
];

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

function main(): void {
  // FAIL CLOSED ON AN INCOHERENT GRAPH. A dependency map that contradicts itself is worse than
  // none: it reads authoritative and plans work that cannot start.
  const problems = validateProgramme(PROGRAMME);
  if (problems.length > 0) {
    throw new Error(
      `[${SCRIPT}] the graph is incoherent:\n` +
        problems.map((p) => `  - ${p.id}: ${p.problem}`).join("\n"),
    );
  }

  const counts = statusCounts(PROGRAMME);
  console.log(`[${SCRIPT}] ${PROGRAMME.length} items, coherent.\n`);
  for (const s of ORDER) console.log(`  ${s.padEnd(30)} ${String(counts[s]).padStart(3)}`);

  for (const s of ORDER) {
    const items = PROGRAMME.filter((i) => i.status === s);
    if (items.length === 0) continue;
    console.log(`\n  === ${s} (${items.length}) ===`);
    for (const i of items) {
      console.log(`    ${i.id.padEnd(26)} ${i.title}`);
      if (i.decision !== undefined) console.log(`      DECIDE: ${i.decision}`);
      if (i.costInr !== undefined) console.log(`      COST:   INR ${i.costInr}`);
      if (i.dependsOn.length > 0) console.log(`      after:  ${i.dependsOn.join(", ")}`);
    }
  }

  console.log(`\n  === the two leaves, and everything still in their way ===`);
  for (const leaf of ["PROMOTION", "CANONICALIZATION"]) {
    const b = blockersOf(PROGRAMME, leaf);
    console.log(`    ${leaf}  blocked by ${b.length}:`);
    for (const x of b) console.log(`      ${x.status.padEnd(28)} ${x.id}`);
  }

  const ex = executable(PROGRAMME);
  console.log(
    `\n  Engineering can start ${ex.length} item(s) today without asking anyone: ` +
      `${ex.map((i) => i.id).join(", ") || "(none)"}`,
  );

  const out = arg("json");
  if (out !== undefined) {
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          kind: "programme-graph",
          ...provenance({
            source: `pnpm db:audit:programme-graph`,
            target: REPOSITORY_ONLY,
            readOnly: true,
            role: null,
            populationPredicate:
              "every remaining item of the Phase 9 programme as enumerated in programme-graph.ts, " +
              "classified by WHO is blocking rather than by difficulty",
          }),
          ai_spend_inr: 0,
          counts,
          total_spend_to_clear_spend_blocked_inr: PROGRAMME.filter(
            (i) => i.status === "BLOCKED_ON_AI_SPEND",
          ).reduce((n, i) => n + (i.costInr ?? 0), 0),
          items: PROGRAMME,
          blockers: Object.fromEntries(
            ["PROMOTION", "CANONICALIZATION"].map((l) => [
              l,
              blockersOf(PROGRAMME, l).map((i) => ({ id: i.id, status: i.status })),
            ]),
          ),
          executable_today: ex.map((i) => i.id),
          production_mutation_performed: false,
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
