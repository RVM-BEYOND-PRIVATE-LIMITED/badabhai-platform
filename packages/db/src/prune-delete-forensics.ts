/**
 * The bounded retention policy for `_delete_forensics` — #1110, owner decision 2026-08-21.
 *
 *   pnpm --filter @badabhai/db db:prune:delete-forensics                 # PLAN. The default.
 *   OPS_ALLOW_PRODUCTION=prune:delete-forensics \
 *     pnpm --filter @badabhai/db db:prune:delete-forensics -- \
 *       --apply --i-am-authorised-to-write-to-production
 *
 * ===========================================================================
 * WHY THE POLICY IS CODE AND NOT A DATABASE JOB
 * ===========================================================================
 * The obvious implementation is a `pg_cron` schedule. It is the wrong one here, for the reason
 * #1110 exists at all: `_delete_forensics` and its trigger were created out of band, did
 * invisible work for a week, and nobody could say who added them or why. Answering that with a
 * second invisible scheduled job — `pg_cron` is not even installed on this cluster — would be
 * closing the finding by repeating it.
 *
 * A repo runner is the opposite in every way that matters. It is in the diff, it is
 * `opsGuard`-gated so a production sweep needs two independent signals, its predicate is
 * unit-tested without a database, and it is DRY-RUN BY DEFAULT: a deletion policy whose first
 * gesture is a deletion is not a policy anybody should trust.
 *
 * ===========================================================================
 * IT LANDS INERT, AND THAT IS THE POINT
 * ===========================================================================
 * Measured on production 2026-08-21: 147 rows, oldest `2026-08-13`, and **0 rows exceed the
 * 90-day window**. So the first sweep deletes nothing. Introducing a retention policy whose
 * first run is provably a no-op is the cheapest way to land one — the mechanism gets exercised
 * before it ever removes anything, and the first real deletion happens against a runner that has
 * already been watched.
 *
 * ===========================================================================
 * WHAT IT DOES NOT TOUCH
 * ===========================================================================
 * NOT the DPDP erasure proof. `audit_logs WHERE action = 'worker.erasure_executed'` is the
 * approved record that an erasure ran, it is a different table, and nothing here reads or writes
 * it. Neither the Redis cool-down tombstone nor the `worker.account_deleted` event is reachable
 * from this file. This sweep removes rows from ONE table, chosen by age, and nothing else.
 */
import { config } from "dotenv";
import { sql as dsql } from "drizzle-orm";
import { join } from "node:path";

import { createDbClient } from "./client";
import { enforceOpsGuard } from "./ops-guard";
import { DELETE_FORENSICS_RETENTION_DAYS } from "./schema/delete-forensics";

config({ path: join("..", "..", ".env") });

/** Short name for `OPS_ALLOW_PRODUCTION`. Must match what an operator exports. */
export const SCRIPT = "prune:delete-forensics";

/** What the sweep found, before it decided anything. */
export interface PruneCounts {
  readonly total: number;
  readonly expired: number;
  readonly oldest: string | null;
  readonly newestExpired: string | null;
}

/**
 * The retention window actually in force for a run.
 *
 * `--retention-days=<n>` exists so a sweep can be rehearsed at a tighter window before the real
 * one is trusted, and it is CLAMPED rather than trusted: 0 would mean "delete the whole table",
 * which is not a retention policy and is not something a typo should be able to express.
 * The floor is 30 days — below that a policy stops being retention and becomes disposal.
 */
export const MIN_RETENTION_DAYS = 30;

export function resolveRetentionDays(argv: readonly string[]): number {
  const raw = argv.find((a) => a.startsWith("--retention-days="))?.slice("--retention-days=".length);
  if (raw === undefined) return DELETE_FORENSICS_RETENTION_DAYS;
  // WHOLE-STRING, NOT `parseInt`. `Number.parseInt("90x", 10)` is 90 and
  // `Number.parseInt("9.5", 10)` is 9 — both accepted silently, and the second one quietly
  // shortens the window a tenfold typo away from the value that was typed. A retention period
  // is not a field to be lenient about.
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `[${SCRIPT}] --retention-days must be a whole number of days, got "${raw}"`,
    );
  }
  const n = Number.parseInt(raw, 10);
  if (n < MIN_RETENTION_DAYS) {
    throw new Error(
      `[${SCRIPT}] --retention-days=${n} is below the ${MIN_RETENTION_DAYS}-day floor. ` +
        `A window this short is disposal, not retention; if that is genuinely intended it needs ` +
        `a decision recorded in docs/registers/gap-db-undeclared-routines.md, not a flag.`,
    );
  }
  return n;
}

/** The report an operator reads. Counts and dates only — this table's PII columns are gone. */
export function render(c: PruneCounts, days: number, applied: boolean, deleted: number): string[] {
  const L = [
    `[${SCRIPT}] ${applied ? "APPLY" : "PLAN"} — retention window ${days} days`,
    "",
    `  rows in _delete_forensics   ${c.total}`,
    `  older than ${String(days).padEnd(3)} days          ${c.expired}`,
    `  oldest row                  ${c.oldest ?? "(table is empty)"}`,
  ];
  if (c.expired > 0) L.push(`  newest row that would go    ${c.newestExpired ?? "-"}`);
  L.push("");
  if (applied) {
    L.push(`  DELETED ${deleted} row(s).`);
  } else if (c.expired === 0) {
    L.push("  Nothing to do. The policy is in force and no row has reached the window yet —");
    L.push("  which is the state it was deliberately introduced in.");
  } else {
    L.push(`  PLAN ONLY — nothing was deleted. Re-run with --apply to remove ${c.expired} row(s).`);
    L.push("  A production write also needs the two ops-guard signals.");
  }
  return L;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const days = resolveRetentionDays(argv);

  const { connectionString: url } = enforceOpsGuard({
    script: SCRIPT,
    connectionString: process.env["DATABASE_URL"],
    mutating: apply,
  });

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    // COUNT FIRST, ALWAYS — including on the apply path. The report must be able to say what the
    // table looked like BEFORE, and a DELETE ... RETURNING alone cannot answer "out of how many".
    const [row] = (await db.execute(dsql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE at < now() - make_interval(days => ${days}))::int AS expired,
             min(at)::text AS oldest,
             max(at) FILTER (WHERE at < now() - make_interval(days => ${days}))::text AS newest_expired
        FROM public._delete_forensics`)) as unknown as {
      total: number;
      expired: number;
      oldest: string | null;
      newest_expired: string | null;
    }[];
    if (row === undefined) throw new Error(`[${SCRIPT}] no counts returned`);

    const counts: PruneCounts = {
      total: row.total,
      expired: row.expired,
      oldest: row.oldest,
      newestExpired: row.newest_expired,
    };

    let deleted = 0;
    if (apply && counts.expired > 0) {
      // The same predicate, re-evaluated inside the DELETE rather than a list of ids read a
      // moment ago: a row that ages into the window between the count and the delete is a row
      // the policy says should go, and one written after it is not this run's business.
      const gone = (await db.execute(dsql`
        DELETE FROM public._delete_forensics
         WHERE at < now() - make_interval(days => ${days})
         RETURNING id`)) as unknown as { id: number }[];
      deleted = gone.length;
    }

    for (const line of render(counts, days, apply, deleted)) console.log(line);
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
