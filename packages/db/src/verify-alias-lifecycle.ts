/**
 * `verify()` for the unified alias lifecycle — READ ONLY, both tables.
 *
 *   pnpm db:verify:aliases                    # both tables
 *   pnpm db:verify:aliases --table skill_alias
 *
 * Recomputes election with `alias-lifecycle.ts` and diffs it against the stored
 * `is_searchable`, then checks the standing invariants. A mismatch means the column and the
 * rule disagree — either the runner never ran, or something wrote it out of band.
 *
 * THERE IS NO `--apply`. This script has no write path at all, by construction: it issues
 * only the SELECTs in `aliasFetchSql` / `parentFetchSql`, and a test asserts those contain
 * no DML. Repair is the elector's job, and the elector is a separate, authorized runner.
 *
 * EXIT CODE 1 ON ANY VIOLATION, so it can gate a deploy or a phase transition.
 *
 * PRIVACY: ids, flags and counts only.
 */
import { config } from "dotenv";

import { createDbClient } from "./client";
import {
  ALIAS_TABLE_SPECS,
  aliasFetchSql,
  parentFetchSql,
  toLifecycleAlias,
  toLifecycleParent,
  verifyElection,
  type AliasTableSpec,
  type VerifyReport,
} from "./alias-lifecycle";
import { argValue } from "./match-v1-cli";

config({ path: "../../.env" });

const SCRIPT = "verify:aliases";

async function verifyTable(
  db: ReturnType<typeof createDbClient>["db"],
  spec: AliasTableSpec,
): Promise<VerifyReport> {
  const aliasRows = (await db.execute(aliasFetchSql(spec))) as unknown as Record<string, unknown>[];
  const parentRows = (await db.execute(parentFetchSql(spec))) as unknown as Record<string, unknown>[];
  return verifyElection({
    spec,
    aliases: aliasRows.map(toLifecycleAlias),
    parents: parentRows.map(toLifecycleParent),
    // No demotion register exists yet. Passing none is correct and is why a demoted row
    // would currently REPORT as a mismatch rather than being silently accepted.
    demotions: new Set<string>(),
  });
}

function printReport(r: VerifyReport): void {
  console.log(`\n[${SCRIPT}] ${r.table}`);
  console.log(`  rows checked                 ${r.rowsChecked}`);
  console.log(`  is_searchable stored         ${r.storedElected}`);
  console.log(`  is_searchable expected       ${r.expectedElected}`);
  console.log(`  MISMATCHES                   ${r.mismatches.length}`);
  console.log(`  not-elected reasons          ${JSON.stringify(r.reasonHistogram)}`);
  console.log("  invariants:");
  for (const i of r.invariants) {
    const mark = i.passed ? "PASS" : "FAIL";
    const sample = i.sample.length > 0 ? `  e.g. ${i.sample.join(", ")}` : "";
    console.log(`    ${mark}  ${i.name.padEnd(28)} violations=${i.violations}${sample}`);
  }
  if (r.mismatches.length > 0) {
    // Group mismatches by the reason set, so 98 identical ones print as one line.
    const byReason = new Map<string, number>();
    for (const m of r.mismatches) {
      const key = `stored=${m.stored} expected=${m.expected} reasons=[${m.reasons.join(",")}]`;
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
    console.log("  mismatch classes:");
    for (const [k, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(6)}  ${k}`);
    }
  }
  console.log(`  => ${r.clean ? "CLEAN" : "VIOLATIONS PRESENT"}`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error(`[${SCRIPT}] DATABASE_URL is not set.`);
  const only = argValue("table");
  const specs = only === undefined ? ALIAS_TABLE_SPECS : ALIAS_TABLE_SPECS.filter((s) => s.table === only);
  if (specs.length === 0) throw new Error(`[${SCRIPT}] unknown --table=${String(only)}`);

  // Identify the target without printing credentials.
  const target = (() => {
    try {
      const u = new URL(databaseUrl);
      return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
    } catch {
      return "(unparsable)";
    }
  })();
  console.log(`[${SCRIPT}] READ-ONLY — no write path exists in this script.`);
  console.log(`[${SCRIPT}] target ${target}`);

  const { db, sql } = createDbClient(databaseUrl, { max: 1 });
  let clean = true;
  try {
    for (const spec of specs) {
      const report = await verifyTable(db, spec);
      printReport(report);
      clean = clean && report.clean;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  console.log(`\n[${SCRIPT}] ${clean ? "ALL CLEAN" : "VIOLATIONS FOUND"} — nothing was written.`);
  if (!clean) process.exitCode = 1;
}

main().catch((err) => {
  // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `SCRIPT` is a module-level string constant declared in this file, never input.
  console.error(`[${SCRIPT}] failed:`, err);
  process.exit(1);
});
