/**
 * `_delete_forensics` — the deletion trail #1110 found, now DECLARED and NARROWED.
 *
 * ===========================================================================
 * WHY THIS IS BEING DECLARED, WHICH IS AN OWNER DECISION AND NOT A CLEANUP
 * ===========================================================================
 * The table and its trigger function were created out of band on 2026-08-13 with this project's
 * credentials, and no migration or schema file described either. `db:audit:live-drift` found the
 * table; `db:audit:undeclared-routines` found the rest of the mechanism and measured it. The
 * register is `docs/registers/gap-db-undeclared-routines.md`.
 *
 * Investigation deliberately made no change, because three questions were only a person's to
 * answer: was the trail deliberate, is it permanent, and what is its retention. **Answered by
 * the owner on 2026-08-21:**
 *
 *   > "keep the DPDP erasure proof, but do not retain raw statement text/operator IP
 *   >  indefinitely... define a bounded retention policy for deletion forensics; remove
 *   >  unnecessary query/forensics exposure if it is not required by the approved erasure/audit
 *   >  design; preserve the actual DPDP erasure proof/tombstone mechanism."
 *
 * That is the ownership answer register item 3 was blocked on: the mechanism **stays**, bounded.
 * A mechanism that stays must be declared, or the next fresh database silently does not have it
 * and `db:audit:live-drift` goes on reporting a question that has been settled.
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY NOT HERE: `query` AND `client_addr`
 * ===========================================================================
 * The live table has two more columns, and they are the reason #1110 was a privacy finding
 * rather than a drift item:
 *
 *   - **`query`** stored `current_query()` — the whole statement text. A parameterised delete
 *     carries no values; a hand-typed `DELETE FROM workers WHERE phone_e164 = '+91…'` carries
 *     them verbatim, into a record that OUTLIVES the row it describes.
 *   - **`client_addr`** stored the operator's IP, which is personal data under DPDP.
 *
 * **Neither is required by the approved erasure/audit design, and that is checked rather than
 * assumed.** The design is `ErasureAuditRepository` → `audit_logs WHERE action =
 * 'worker.erasure_executed'`, whose own docstring says it takes *"prefixes, counts and a closed
 * set of outcomes"* and never a key, path, phone or transcript. It keeps neither statement text
 * nor IP. Nothing else reads `_delete_forensics` at all — 0 callers in this repository.
 *
 * So the columns are dropped and the trigger function stops writing them. What survives
 * identifies the deletion without describing it: `txid`, `table_name`, `row_id`, `worker_id`,
 * `db_user`, `app_name`, `backend_pid`. Measured on production 2026-08-20, all 147 rows: **0
 * phone-shaped, 0 email-shaped, and none of the 35 quoted ten-digit literals is a bare Indian
 * mobile** — so the drop destroys no realised PII, and that measurement is what makes an
 * irreversible change safe to make now rather than later.
 *
 * **What is lost, stated plainly:** network-level attribution for a console deletion. `db_user`
 * and `app_name` still say *which role and which client*, and `backend_pid`/`txid` still identify
 * the session — measured, every one of the 147 rows is `postgres` via `supabase/dashboard`.
 *
 * ===========================================================================
 * RETENTION
 * ===========================================================================
 * `at` carries an index for exactly one reason: the bounded-retention sweep
 * (`db:prune:delete-forensics`) is an age predicate, and without an index it is a sequential
 * scan of a table that only ever grows. The policy lives in the runner, in code, tested and
 * `opsGuard`-gated — NOT in `pg_cron`, which is not even installed here, and which would put the
 * policy back out of band in exactly the way that produced this finding.
 */
import { sql } from "drizzle-orm";
import { bigserial, bigint, index, pgTable, text, timestamp, uuid, integer } from "drizzle-orm/pg-core";

/**
 * Matches the live catalog column for column, minus the two dropped by `0086`.
 *
 * No foreign key on `worker_id`, and that is faithful rather than an oversight: the row exists
 * BECAUSE the worker row is gone, so a reference would delete the evidence with the subject.
 * It also means the cascade cannot remove these rows, which is precisely why the retention
 * policy has to exist.
 */
export const deleteForensics = pgTable(
  "_delete_forensics",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    txid: bigint("txid", { mode: "number" }),
    tableName: text("table_name").notNull(),
    rowId: uuid("row_id"),
    /** The erased worker. Opaque, and already the platform's deliberate post-erasure residue. */
    workerId: uuid("worker_id"),
    dbUser: text("db_user"),
    appName: text("app_name"),
    backendPid: integer("backend_pid"),
  },
  (t) => [index("_delete_forensics_at_idx").on(t.at)],
);

/**
 * The retention window, in days. **One definition, imported by the runner and by its tests.**
 *
 * 90 days is a proposal, not a derived number, and it is deliberately introduced INERT: measured
 * on production 2026-08-21, the oldest row is 2026-08-13 and **0 rows exceed 90 days**, so the
 * first sweep deletes nothing. A retention policy whose first run is a no-op is the cheapest
 * possible way to land one — the mechanism is proved before it ever removes anything.
 */
export const DELETE_FORENSICS_RETENTION_DAYS = 90;

/** The age predicate the sweep uses, as SQL. Shared so the runner and its test cannot diverge. */
export const deleteForensicsExpiredBefore = (days: number) =>
  sql`now() - make_interval(days => ${days})`;
