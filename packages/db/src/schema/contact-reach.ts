import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { unlocks } from "./payer";
import { workers } from "./worker";

/** Where a couldn't-reach case stands. `open` until the desk closes it or its deadline passes. */
export type ContactReachStatus = "open" | "reached_interested" | "reached_declined" | "not_reached";

/** Who closed a case: a desk staff member, or the deadline sweep (no one closed it in time). */
export type ContactReachResolvedBy = "desk" | "deadline";

/** What one desk call attempt got. Closed codes only: no free text (PII). */
export type ContactReachAttemptResult =
  | "no_answer"
  | "busy"
  | "switched_off"
  | "wrong_number"
  | "other";

// ---------------------------------------------------------------------------
// contact_reach_cases — the working-number guarantee (#2750 item 7, brief 4C.9).
//
// A company that opened a contact and could not reach the worker reports it within
// `couldntReachWindowDays` (7) of the open. The report opens ONE case per open (`unlock_id`
// unique) with a deadline `deskWindowHours` (48) away. The worker desk calls him and closes the
// case: reached and interested, reached and declined (no credit back), or not reached (the credits
// the open took come back). A case still open at its deadline closes as not reached, attempted or
// not (owner ruling 2026-11-17), so the company never waits on the desk.
//
// `payer_id` is the company's TENANT key (ADR-0053): the wallet the credits return to.
// `reported_by` is the acting login that pressed the button. `worker_id` is nulled on a worker's
// erasure; the case and its money record stay.
//
// PII-FREE: ids, closed codes, integers and times. READ ONLY WHILE `CREDIT_RULES_ROLLOUT` IS ON.
// RLS forced, every role revoked (the migration's hand-written tail).
// ---------------------------------------------------------------------------
export const contactReachCases = pgTable(
  "contact_reach_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    unlockId: uuid("unlock_id")
      .notNull()
      .references(() => unlocks.id, { onDelete: "cascade" }),
    payerId: uuid("payer_id").notNull(),
    workerId: uuid("worker_id").references(() => workers.id, { onDelete: "set null" }),
    reportedBy: uuid("reported_by").notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    status: text("status").$type<ContactReachStatus>().notNull().default("open"),
    creditsReturned: integer("credits_returned").notNull().default(0),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by").$type<ContactReachResolvedBy>(),
    resolvedByAdminId: uuid("resolved_by_admin_id"),
  },
  (t) => [
    // One case per open, ever: a second report answers the first case.
    uniqueIndex("contact_reach_cases_unlock_uq").on(t.unlockId),
    // The desk queue (open, the nearest deadline first) and the deadline sweep.
    index("contact_reach_cases_open_deadline_idx")
      .on(t.deadlineAt)
      .where(sql`${t.status} = 'open'`),
    index("contact_reach_cases_payer_idx").on(t.payerId, t.reportedAt.desc()),
    check(
      "contact_reach_cases_status_chk",
      sql`${t.status} IN ('open', 'reached_interested', 'reached_declined', 'not_reached')`,
    ),
    check("contact_reach_cases_credits_chk", sql`${t.creditsReturned} >= 0`),
    check(
      "contact_reach_cases_resolved_by_chk",
      sql`${t.resolvedBy} IS NULL OR ${t.resolvedBy} IN ('desk', 'deadline')`,
    ),
    check(
      "contact_reach_cases_resolution_chk",
      sql`(${t.status} = 'open') = (${t.resolvedAt} IS NULL) AND (${t.resolvedAt} IS NULL) = (${t.resolvedBy} IS NULL) AND (${t.resolvedByAdminId} IS NULL OR ${t.resolvedBy} = 'desk')`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by the migration's tail

export type ContactReachCaseRow = typeof contactReachCases.$inferSelect;

// ---------------------------------------------------------------------------
// contact_reach_attempts — each call the desk made on a case (#2750 item 7). Who called (the
// admin id), when, and a closed result code. No notes: free text is where a number or a name
// would end up. PII-free.
// ---------------------------------------------------------------------------
export const contactReachAttempts = pgTable(
  "contact_reach_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => contactReachCases.id, { onDelete: "cascade" }),
    adminId: uuid("admin_id").notNull(),
    result: text("result").$type<ContactReachAttemptResult>().notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("contact_reach_attempts_case_idx").on(t.caseId),
    check(
      "contact_reach_attempts_result_chk",
      sql`${t.result} IN ('no_answer', 'busy', 'switched_off', 'wrong_number', 'other')`,
    ),
  ],
).enableRLS();

export type ContactReachAttemptRow = typeof contactReachAttempts.$inferSelect;
