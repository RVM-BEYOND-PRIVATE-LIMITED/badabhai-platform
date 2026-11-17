import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  isSampleWorkerId,
  samplePayerIdLikePatterns,
  samplePostingIdLikePatterns,
  sampleWorkerIdLikePatterns,
} from "@badabhai/db";
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
 * here is the same mark every other report reads. A SAMPLE company (the synthetic workforce seed's
 * employers and their postings, on production since 2026-10-07) is told by its seeded id instead,
 * and {@link countablePayer} leaves out both (part B).
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

/**
 * SQL: the company behind `payerId` is NOT a SAMPLE company — one of the synthetic workforce
 * seed's employers (`face10…` ids, `samplePayerIdLikePatterns`), written to production beside the
 * real companies so search had employers. It is not a customer, so no company figure counts it. A
 * NULL `payerId` is left out, as in {@link excludeTestPayers}.
 */
export function excludeSamplePayers(payerId: SQLWrapper): SQL {
  return sql.join(
    samplePayerIdLikePatterns().map((pattern) => sql`(${payerId}::text NOT LIKE ${pattern})`),
    sql` AND `,
  );
}

/** The same rule over an id already in memory (Postgres prints a uuid in lower case). */
export function isSamplePayerId(payerId: string): boolean {
  const id = payerId.toLowerCase();
  return samplePayerIdLikePatterns().some((pattern) => id.startsWith(pattern.slice(0, -1)));
}

/** SQL: a company every company figure counts — neither a test company nor a sample one. */
export function countablePayer(payerId: SQLWrapper): SQL {
  return sql`(${excludeTestPayers(payerId)} AND ${excludeSamplePayers(payerId)})`;
}

/** SQL: the posting `postingId` is not one of the workforce seed's sample postings (`face30…`). */
export function excludeSamplePostings(postingId: SQLWrapper): SQL {
  return sql.join(
    samplePostingIdLikePatterns().map((pattern) => sql`(${postingId}::text NOT LIKE ${pattern})`),
    sql` AND `,
  );
}

/**
 * SQL: a contact open is NOT one carried over by the company-move import of #2754. NAMED HOOK, NO
 * RULE YET: no import exists, so no open is left out today (`TRUE`). When #2754 lands its import
 * ledger, this is the ONE place that learns to recognise an imported open, and contacts-per-hire
 * leaves it out without any other change (a definition-version bump, since the figure moves).
 */
export function excludeImportedOpens(_unlockId: SQLWrapper): SQL {
  return sql`TRUE`;
}

/**
 * SQL: the worker `workerId` names (a hire's or an unlock's, in the OUTER query) is neither a test
 * account nor a sample worker, so a company figure built on workers (hires, contacts opened) never
 * counts a test or seeded row. A NULL `workerId` (a worker erased since: `unlocks.worker_id` is
 * SET NULL on erasure) is KEPT: the company really opened that contact. The linked-identity rule is
 * not applied: a Campus student a company opened or hired is a real person.
 */
export function excludeTestAndSampleWorkerRefs(workerId: SQLWrapper): SQL {
  const notSample = sql.join(
    sampleWorkerIdLikePatterns().map((pattern) => sql`(${workerId}::text NOT LIKE ${pattern})`),
    sql` AND `,
  );
  return sql`(${workerId} IS NULL OR (${workerId} NOT IN (SELECT "tw"."id" FROM "workers" "tw" WHERE "tw"."is_test_account") AND ${notSample}))`;
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
