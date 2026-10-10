/**
 * ADR-0053 (PAY-DB-01) — the payer org tenancy CENSUS, as a CLI. READ-ONLY, ₹0.
 *
 * Runs ORG_TENANCY_PLAN §6's queries C1–C9 (`org-tenancy-census.ts`, where each check's meaning
 * is written down) and prints counts plus opaque ids. It is the first step of the flip (plan §5,
 * owner action O-8 step 1): before `PAYER_ORG_TENANCY_MODE` goes to `shadow`, this must show
 * C2 = C3 = C4 = C6 = 0, and C1 and C5 recorded. EXIT 1 when that flip gate fails.
 *
 *   pnpm --filter @badabhai/db db:audit:org-tenancy
 *
 * Read-only by construction (one `read only` transaction; see `org-tenancy-census.ts`). Output is
 * opaque uuids, enum values, counts and one timestamp — no name, email, phone or ciphertext.
 * `apps/api/src/payers/org-tenancy-census.db.test.ts` runs THIS command against seeded breaches
 * in CI and asserts it exits 1.
 */
import { config } from "dotenv";

import { createDbClient } from "./client";
import { censusCount, flipGate, runCensus } from "./org-tenancy-census";

const SCRIPT = "audit:org-tenancy";

/** At most this many rows are listed per check; the count is always exact. */
const LIST_LIMIT = 50;

function formatRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString() : String(v)}`)
    .join(" ");
}

async function main(): Promise<void> {
  // The repository-root file first, as the other db runners do (cwd = packages/db under pnpm).
  // dotenv never overwrites an already-set variable, so a real environment still wins. Loaded
  // HERE, not at import: importing the census must never load a dotenv file into the importer.
  config({ path: "../../.env" });
  config();

  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  // Show WHICH database — never credentials.
  const parsed = new URL(url);
  console.log(`[${SCRIPT}] target host=${parsed.hostname} db=${parsed.pathname.slice(1)}`);
  console.log(`[${SCRIPT}] READ-ONLY — measures, repairs nothing\n`);

  const { sql } = createDbClient(url, { max: 1 });
  try {
    const results = await runCensus(sql);
    for (const result of results) {
      const { query, rows } = result;
      const n = censusCount(result);
      const tag = query.rule === "must_be_zero" ? (n === 0 ? "ok" : "MUST BE 0") : query.rule;
      console.log(`${query.id.padEnd(4)} ${String(n).padStart(6)}  [${tag}] ${query.title}`);
      for (const row of rows.slice(0, LIST_LIMIT)) console.log(`         ${formatRow(row)}`);
      if (rows.length > LIST_LIMIT) console.log(`         … ${rows.length - LIST_LIMIT} more`);
    }

    const gate = flipGate(results);
    console.log("");
    if (gate.pass) {
      console.log(
        "✓ Flip gate (plan §5 step 1): C2, C3, C4 and C6 are all 0. Record C1, C5 and C5b.",
      );
    } else {
      console.log(`✗ Flip gate (plan §5 step 1) FAILS on ${gate.failing.join(", ")}.`);
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
