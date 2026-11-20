import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { jobPostings, type JobPostingAudience } from "./job";

// ---------------------------------------------------------------------------
// #2956 — AN ADMIN DECIDES WHERE EACH JOB SHOWS (owner direction of 19 Nov 2026, #2959).
//
// Every company comes in through BadaBhai, and a BadaBhai admin (not the company) decides, job by
// job, who sees a posting: Campus only (`rvm_students`), both (`both`), or BadaBhai only
// (`badabhai_workers`). The posting's own `job_postings.audience` column stays THE value every
// reader obeys (`reachesBadaBhaiWorkers()`, `reachesRvmStudents()`); these two tables only record
// the admin's decision and which trades may go to Campus.
// ---------------------------------------------------------------------------

/**
 * `job_posting_audience_decisions` — the LATEST admin decision on where a posting shows. One row
 * per posting an admin has decided on; no row = no admin has decided yet (the admin list's
 * "to decide" set). Every decision ALSO writes an `audit_logs` row with the admin's reason and
 * the event `job_posting.audience_set_by_admin`; this row is the current state, not the history.
 *
 * `content_hash` is the posting's RVM review content hash at decision time
 * (`postingReviewContentHash`, `../job-review.ts`): it covers every field a student sees,
 * openings (`vacancy_band`) included. A stored hash that no longer equals the posting's hash now
 * means the company changed the job since the admin decided ("changed since decision"), so the
 * admin can look again — for example, openings going from 3 to 80. Nothing changes automatically.
 *
 * `decided_by_admin_id` is an admin-actor column with no foreign key (the
 * `job_posting_worker_visibility` pattern).
 */
export const jobPostingAudienceDecisions = pgTable(
  "job_posting_audience_decisions",
  {
    jobPostingId: uuid("job_posting_id")
      .primaryKey()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    audience: text("audience").$type<JobPostingAudience>().notNull(),
    contentHash: text("content_hash").notNull(),
    decidedByAdminId: uuid("decided_by_admin_id").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Mirrors `job_postings_audience_chk` (JOB_POSTING_AUDIENCES).
    check(
      "jpad_audience_chk",
      sql`${t.audience} IN ('badabhai_workers', 'rvm_students', 'both')`,
    ),
    // The `jpir_content_hash_chk` shape: lower-case sha256 hex.
    check("jpad_content_hash_chk", sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
  ],
).enableRLS();

/**
 * `campus_trades` — the trades RVM trains and certifies (#2957). Only a posting whose
 * `role_kind` is an ACTIVE row here may be sent to Campus by an admin (`rvm_students` or `both`).
 * A painter job, or any trade RVM has no students for, can only show on BadaBhai.
 *
 * `trade_key` is a `role_kind` value (`TradeFormKindName`). The CHECK pins only the key's SHAPE,
 * not the list: the list of trade kinds grows with the taxonomy, and the API validates the key
 * against it, so a new trade never needs a migration here.
 *
 * Removing a trade sets `removed_*`; a row is never deleted, and re-adding clears `removed_*`.
 * Postings already sent to Campus keep their audience when their trade is removed (a switch or a
 * list decides new writes, never stored state — R81); the admin list flags them. The reason of
 * every change is in `audit_logs`.
 */
export const campusTrades = pgTable(
  "campus_trades",
  {
    tradeKey: text("trade_key").primaryKey(),
    addedByAdminId: uuid("added_by_admin_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    removedByAdminId: uuid("removed_by_admin_id"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("campus_trades_key_chk", sql`${t.tradeKey} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    // A removal names who and when, together.
    check(
      "campus_trades_removed_chk",
      sql`(${t.removedAt} IS NULL) = (${t.removedByAdminId} IS NULL)`,
    ),
  ],
).enableRLS();
