import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workers } from "./worker";

// ---------------------------------------------------------------------------
// outbound_signals — a mark BadaBhai owes another system, sent once (#2747 item 8, ADR-0064 §3.6).
//
// The first destination is RVM's Student API: a company marks an RVM student `selected` or `hired`
// and RVM opens his proof prompt and the placement team's verification task
// (`POST /internal/campus/selection-events`, Scheduler_Backend#162 item 8). The row is written in
// the SAME transaction as the stage, so a saved mark and its signal commit together; a BullMQ
// sweep sends due rows with back-off and a dead-letter state.
//
// IDS ONLY. `payload` holds the posting, the worker, the stage and the day of the mark — never a
// company name, a job title or a student reference. The body is built at send time from the rows
// those ids name, so the company name (encrypted at rest on `payers`) is never stored in clear a
// second time, and a student whose link has ended is never sent.
//
// ONCE PER STEP. A mark's signals form a chain per (posting, worker, stage): the first selection
// holds `dedupe_key` `destination:posting_kind:posting_id:worker_id:stage`; every later row (the
// withdrawal of an undone mark, #2771, then a fresh selection if the company marks him again) holds
// that key plus `:after:<predecessor id>`. The key is unique, so a row has at most one successor:
// one withdrawal per undo, never two. The row's own id is the `event_id` RVM de-duplicates on.
//
// `worker_id` cascades on worker deletion (DPDP). RLS forced, every role revoked (migration 0167).
// ---------------------------------------------------------------------------

/** Where a signal goes. One today. */
export const OUTBOUND_SIGNAL_DESTINATIONS = ["rvm_selection_events"] as const;
export type OutboundSignalDestination = (typeof OUTBOUND_SIGNAL_DESTINATIONS)[number];

/**
 * What a signal says. `applicant_mark_withdrawn` (#2771, migration 0191): a selected or hired mark
 * RVM was sent has been undone by the company.
 */
export const OUTBOUND_SIGNAL_KINDS = [
  "applicant_selected",
  "applicant_hired",
  "applicant_mark_withdrawn",
] as const;
export type OutboundSignalKind = (typeof OUTBOUND_SIGNAL_KINDS)[number];

/**
 * `pending` waits for its `next_attempt_at`; `delivered` was accepted; `dead` gave up (attempts
 * exhausted or a refusal no retry can change); `cancelled` will never be sent: before it went, the
 * student's link ended, the mark was undone, or he was suspended or scheduled for deletion.
 */
export const OUTBOUND_SIGNAL_STATUSES = ["pending", "delivered", "dead", "cancelled"] as const;
export type OutboundSignalStatus = (typeof OUTBOUND_SIGNAL_STATUSES)[number];

/**
 * Why the last attempt did not deliver, or why the row was given up. A closed code, never a response
 * body. `abandoned`: claimed the maximum number of times without an outcome (a sender crashing on
 * it). The last three are #2771's (migration 0191), each a `cancelled` row RVM never needed:
 * `mark_never_sent` — a withdrawal of a mark RVM never received; `mark_restored` — a withdrawal
 * whose mark was given back before it went; `mark_already_sent` — a fresh selection RVM already
 * holds, because the withdrawal before it never went.
 */
export const OUTBOUND_SIGNAL_FAILURES = [
  "not_configured",
  "timeout",
  "network",
  "http_status",
  "contract",
  "not_available",
  "rejected",
  "link_inactive",
  "context_missing",
  "mark_undone",
  "worker_inactive",
  "abandoned",
  "mark_never_sent",
  "mark_restored",
  "mark_already_sent",
] as const;
export type OutboundSignalFailure = (typeof OUTBOUND_SIGNAL_FAILURES)[number];

export const outboundSignals = pgTable(
  "outbound_signals",
  {
    /** Also the `event_id` (and Idempotency-Key) the destination de-duplicates on. */
    id: uuid("id").primaryKey().defaultRandom(),
    destination: text("destination").$type<OutboundSignalDestination>().notNull(),
    kind: text("kind").$type<OutboundSignalKind>().notNull(),
    /**
     * `destination:posting_kind:posting_id:worker_id:stage` for a mark's first signal, plus
     * `:after:<predecessor id>` for each later one (#2771). One successor per row, ever.
     */
    dedupeKey: text("dedupe_key").notNull().unique("outbound_signals_dedupe_key_uq"),
    /** The worker the mark is about. Cascades on erasure; also the sweep's link re-check. */
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** Ids and closed values only (see the header). */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<OutboundSignalStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastFailure: text("last_failure").$type<OutboundSignalFailure>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The sweep's read: due pending rows, oldest first.
    index("outbound_signals_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    // Backs the `worker_id` ON DELETE CASCADE: without it every worker erasure scans the table.
    index("outbound_signals_worker_id_idx").on(t.workerId),
    check("outbound_signals_destination_chk", sql`${t.destination} IN ('rvm_selection_events')`),
    check(
      "outbound_signals_kind_chk",
      sql`${t.kind} IN ('applicant_selected', 'applicant_hired', 'applicant_mark_withdrawn')`,
    ),
    check(
      "outbound_signals_status_chk",
      sql`${t.status} IN ('pending', 'delivered', 'dead', 'cancelled')`,
    ),
    check("outbound_signals_attempts_chk", sql`${t.attempts} >= 0`),
    check("outbound_signals_payload_chk", sql`jsonb_typeof(${t.payload}) = 'object'`),
    check(
      "outbound_signals_failure_chk",
      sql`${t.lastFailure} IS NULL OR ${t.lastFailure} IN ('not_configured', 'timeout', 'network', 'http_status', 'contract', 'not_available', 'rejected', 'link_inactive', 'context_missing', 'mark_undone', 'worker_inactive', 'abandoned', 'mark_never_sent', 'mark_restored', 'mark_already_sent')`,
    ),
    check(
      "outbound_signals_delivered_chk",
      sql`(${t.status} = 'delivered') = (${t.deliveredAt} IS NOT NULL)`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0167

export type OutboundSignal = typeof outboundSignals.$inferSelect;
export type NewOutboundSignal = typeof outboundSignals.$inferInsert;
