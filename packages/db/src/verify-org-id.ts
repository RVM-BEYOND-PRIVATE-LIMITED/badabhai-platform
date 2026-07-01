/**
 * Verifier: ADR-0027 B5.x Increment 0 org_id backfill (migration 0034).
 *
 * Asserts the additive org_id foundation is correct after `pnpm db:migrate` applied
 * 0034 against a DB that has the B5.1 org tables (payer_orgs) backfilled:
 *
 *   (a) ZERO NULL org_id on the 7 NOT-NULL tables.
 *   (b) every org_id = payer_orgs.id WHERE root_payer_id = payer_id (backfill correct),
 *       and NULL-payer rows on the 2 nullable-payer tables keep NULL org_id.
 *   (c) org-scoped uniqueness holds: no duplicate (org_id, worker_id) in unlocks, and no
 *       duplicate (org_id, worker_id, job_posting_id) in resume_disclosures.
 *
 * Read-only. Prints PASS / exits 0 on success; prints the first violation + exits 1.
 *
 *   DATABASE_URL=<db> pnpm --filter @badabhai/db db:verify:org-id
 *
 * NOTE: this is the programmatic twin of verify/0034_org_id_backfill.sql (same asserts).
 * Run either. On an EMPTY DB (no payer_orgs / no payer-owned rows) every assertion is
 * vacuously true — that is a real PASS (nothing to backfill), NOT a skipped check.
 */
import { config } from "dotenv";
import { createDbClient } from "./client";

config({ path: "../../.env" });

// The 7 tables whose payer_id is NOT NULL → org_id must be NOT NULL + fully backfilled.
const SEVEN_NOT_NULL = [
  "unlocks",
  "payer_credits",
  "credit_ledger",
  "posting_plans",
  "posting_boosts",
  "payer_capacity",
  "resume_disclosures",
] as const;

// The 2 tables whose payer_id is NULLABLE → org_id NULLABLE (NULL-payer rows keep it NULL).
const TWO_NULLABLE = ["job_postings", "jobs"] as const;

function fail(msg: string): never {
  console.error(`[verify:org-id] FAIL — ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[verify:org-id] DATABASE_URL is not set");

  const { sql } = createDbClient(url, { max: 1 });
  try {
    // count(*) always returns exactly one row; read it safely (noUncheckedIndexedAccess).
    const countOf = (rows: readonly unknown[]): number => {
      const first = rows[0] as { n?: number } | undefined;
      return first?.n ?? 0;
    };

    // (a) ZERO NULL org_id on the 7 NOT-NULL tables.
    for (const t of SEVEN_NOT_NULL) {
      const n = countOf(await sql`SELECT count(*)::int AS n FROM ${sql(t)} WHERE org_id IS NULL`);
      if (n !== 0) fail(`(a) ${t} has ${n} NULL org_id row(s) (expected 0)`);
    }

    // (b) Every non-null-payer row's org_id resolves to the payer's solo org, all 9 tables.
    for (const t of [...SEVEN_NOT_NULL, ...TWO_NULLABLE]) {
      const n = countOf(await sql`
        SELECT count(*)::int AS n FROM ${sql(t)} x
        WHERE x.payer_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM payer_orgs po
            WHERE po.root_payer_id = x.payer_id AND po.id = x.org_id
          )`);
      if (n !== 0) fail(`(b) ${t} has ${n} row(s) whose org_id != payer_orgs.id for its payer_id`);
    }

    // (b') NULL-payer rows on the 2 nullable-payer tables must have NULL org_id.
    for (const t of TWO_NULLABLE) {
      const n = countOf(
        await sql`SELECT count(*)::int AS n FROM ${sql(t)} WHERE payer_id IS NULL AND org_id IS NOT NULL`,
      );
      if (n !== 0) fail(`(b') ${t} has ${n} NULL-payer row(s) with a non-NULL org_id`);
    }

    // (c) Org-scoped uniqueness — unlocks (org_id, worker_id).
    const dupUnlocks = await sql`
      SELECT org_id, worker_id, count(*)::int AS c
      FROM unlocks GROUP BY org_id, worker_id HAVING count(*) > 1`;
    if (dupUnlocks.length > 0) {
      fail(`(c) unlocks has ${dupUnlocks.length} duplicate (org_id, worker_id) group(s)`);
    }

    // (c) Org-scoped uniqueness — resume_disclosures (org_id, worker_id, job_posting_id).
    const dupDisc = await sql`
      SELECT org_id, worker_id, job_posting_id, count(*)::int AS c
      FROM resume_disclosures GROUP BY org_id, worker_id, job_posting_id HAVING count(*) > 1`;
    if (dupDisc.length > 0) {
      fail(
        `(c) resume_disclosures has ${dupDisc.length} duplicate (org_id, worker_id, job_posting_id) group(s)`,
      );
    }

    console.log(
      "[verify:org-id] PASS — org_id backfill correct, NOT-NULL holds on the 7 tables, " +
        "NULL-payer rows keep NULL org_id, and org-scoped uniqueness holds.",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[verify:org-id] failed:", err);
  process.exit(1);
});
