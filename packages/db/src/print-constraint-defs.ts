/**
 * Print the live definition of named constraints. READ-ONLY: one SELECT on `pg_constraint`.
 *
 * WHY. A migration that WIDENS a CHECK (DROP + ADD under the same name: 0129, 0130, 0131, 0160 …)
 * leaves the same constraint NAME whether or not the new text landed. `adopt-migrations.ts` and
 * `db:audit:schema-contract` see the name only, so MIGRATIONS.md asks for
 * `pg_get_constraintdef` after every such hand apply, before its ledger row is adopted. This is
 * that query, runnable where the SQL editor is not (the owner ledger workflow, #2836).
 *
 *   npx tsx src/print-constraint-defs.ts generated_resumes_generation_trigger_chk[,<name>…]
 *
 * Exit 1 when a named constraint does not exist. Prints the host, never the URL.
 */
import { config } from "dotenv";
import postgres from "postgres";

config({ path: "../../.env" });
config({ path: ".env" });

/** A Postgres identifier as this repo names constraints: lower case, digits, underscores. */
const NAME = /^[a-z0-9_]{1,63}$/;

async function main(): Promise<void> {
  const names = (process.argv[2] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0 || !names.every((n) => NAME.test(n))) {
    console.error("usage: print-constraint-defs.ts <constraint>[,<constraint>…] (a-z, 0-9, _)");
    process.exitCode = 1;
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  console.log(`[constraints] READ-ONLY host=${new URL(url).hostname}`);

  const sql = postgres(url, { max: 1 });
  try {
    const rows = await sql<{ conname: string; tbl: string; def: string }[]>`
      SELECT conname, conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conname = ANY(${names})
       ORDER BY conname, tbl`;
    for (const r of rows) console.log(`  ${r.conname} ON ${r.tbl}\n    ${r.def}`);
    const found = new Set(rows.map((r) => r.conname));
    for (const n of names) {
      if (!found.has(n)) {
        console.log(`  MISSING ${n}`);
        process.exitCode = 1;
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[constraints] failed:", err);
  process.exit(1);
});
