import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { isSampleWorkerId, sampleWorkerIdLikePatterns } from "@badabhai/db";
import { awaitingFirstSignIn } from "../admin-worker-scope";

/**
 * #2755 item 2 — WHO NEVER COUNTS, one function per rule. Every figure of the numbers screen
 * leaves these out; part B's snapshot, the live parity queries and the tests compose them from
 * here, so "test company" or "sample worker" cannot mean two things on one screen.
 *
 * Each rule comes as a SQL fragment (for the aggregate) and, where a caller holds the row in
 * memory, a pure predicate of the same rule. The fragments name their tables BY HAND, qualified,
 * like `admin-worker-scope.ts`: Drizzle may render an interpolated column without its table, and
 * an unqualified `id` inside a subquery would bind to the subquery's own table.
 *
 * ── COMPANIES ───────────────────────────────────────────────────────────────────────────────
 * A test company is a `payers` row with `is_test_account` (migration 0162, #2746: "set only by an
 * explicit ops act"). The marks are written by `PUT /admin/numbers/test-accounts/:payerId` and by
 * the `mark-synthetic-test-payers` backfill. The column is the ONE company test marker: the rows a
 * test company creates copy it (`campus_drive_requests.is_test`, `credit_lots.is_test`), so a mark
 * here is the same mark every other report reads.
 *
 * ── WORKERS ─────────────────────────────────────────────────────────────────────────────────
 * Three rules, each its own function: a test account (`workers.is_test_account`, set for the
 * reserved phone range), a sample worker (a seeded id, `isSampleWorkerId`), and a linked RVM
 * identity that never signed in (#2752: a `pending` row with an `institute` origin — the Campus
 * link made it, its student has not used BadaBhai). A linked student who HAS signed in is a real
 * worker and counts; so does a BadaBhai worker who was linked later (he keeps his own row).
 */

// -----------------------------------------------------------------------------------------------
// Companies
// -----------------------------------------------------------------------------------------------

/**
 * SQL: the company behind `payerId` is NOT a test company. `payerId` is any expression naming a
 * payer id in the OUTER query (`payment_orders.payer_id`, `job_postings.payer_id`, `payers.id`).
 *
 * `NOT IN` over the (small) set of test companies, not a correlated `NOT EXISTS`: the outer
 * reference stays outside the subquery, so it can never be captured by the subquery's own `id`.
 * The subquery's `id` is the primary key (never NULL), so `NOT IN` has no NULL trap. A NULL
 * `payerId` (a row with no company) is left out, which is right for a company figure.
 *
 * A payer id with no `payers` row (a deleted company's old order — `payment_orders.payer_id` has no
 * FK) is KEPT: deleting an account must not rewrite a frozen week.
 */
export function excludeTestPayers(payerId: SQLWrapper): SQL {
  return sql`(${payerId} NOT IN (SELECT "tp"."id" FROM "payers" "tp" WHERE "tp"."is_test_account"))`;
}

/** The same rule over a row already in memory. */
export function isTestPayer(row: { readonly isTestAccount: boolean }): boolean {
  return row.isTestAccount === true;
}

// -----------------------------------------------------------------------------------------------
// Workers (fragments over the UNALIASED `workers` table)
// -----------------------------------------------------------------------------------------------

/** SQL: not a test account (`workers.is_test_account`). */
export const excludeTestWorkers: SQL = sql`(NOT "workers"."is_test_account")`;

/** The same rule over a row already in memory. */
export function isTestWorker(row: { readonly isTestAccount: boolean }): boolean {
  return row.isTestAccount === true;
}

/**
 * SQL: not a sample worker — no seeded cohort's id (the patterns `isSampleWorkerId` tests, from the
 * same module, so the query and the predicate cannot drift).
 */
export const excludeSampleWorkers: SQL = sql.join(
  sampleWorkerIdLikePatterns().map((pattern) => sql`("workers"."id"::text NOT LIKE ${pattern})`),
  sql` AND `,
);

/** The same rule over an id already in memory. */
export { isSampleWorkerId };

/**
 * SQL: not a linked RVM identity that never signed in (#2752). The admin population of real
 * sign-ups (`signedUpWorker` in `admin-worker-scope.ts`), reused, so the funnel, the journey, the
 * dashboard and this screen leave out exactly the same rows.
 */
export const excludeLinkedRvmIdentities: SQL = sql`(NOT ${awaitingFirstSignIn})`;

/**
 * The same rule over a row already in memory: `pending` AND an `institute` origin. Both halves are
 * needed — a legacy `pending` row with no origin is an ordinary worker who is counted as before.
 */
export function isLinkedRvmIdentityAwaitingSignIn(row: {
  readonly status: string;
  readonly hasInstituteOrigin: boolean;
}): boolean {
  return row.status === "pending" && row.hasInstituteOrigin === true;
}

/** SQL: a worker every worker figure counts — all three worker rules together. */
export const countableWorker: SQL = sql`(${excludeTestWorkers} AND ${excludeSampleWorkers} AND ${excludeLinkedRvmIdentities})`;

/** The same, in memory. */
export function isCountableWorker(row: {
  readonly id: string;
  readonly isTestAccount: boolean;
  readonly status: string;
  readonly hasInstituteOrigin: boolean;
}): boolean {
  return !isTestWorker(row) && !isSampleWorkerId(row.id) && !isLinkedRvmIdentityAwaitingSignIn(row);
}
