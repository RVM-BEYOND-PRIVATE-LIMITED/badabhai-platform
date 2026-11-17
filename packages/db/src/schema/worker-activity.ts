import { date, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";

import { workers } from "./worker";

// ---------------------------------------------------------------------------
// worker_activity — the days a worker was active (#2753 items 4 and 7, migration 0168).
//
// ONE DEFINITION OF "LAST ACTIVE". Before this table there were three: the applicant card's band
// read `worker_devices.last_seen_at`, the candidate-search order took the later of that and
// `workers.updated_at`, and the `worker.active` event recorded one row per UTC day on the spine.
// `last_seen_at` moves only when a device registers (an OTP login), so a worker who opens the app
// every day for a month still reads as last seen the day he signed in. This table is the day he
// actually used it, and the API's single read of the last-active day
// (`WorkerActivityRepository.lastActiveDays`) is the later of this table's newest day and the IST
// day of his newest device sighting, so the history from before the table needs no backfill.
//
// WRITTEN ON: any signed-in worker request (`WorkerActivityInterceptor` — app use, an apply and a
// reply to a company all pass through it), and a Campus application (`CampusApplicationsService`,
// which is a service call with no worker session). Every writer is fire-and-forget and never fails
// the request it rides on.
//
// ONE ROW PER WORKER PER ACTIVE IST DAY. `active_on` is the Asia/Kolkata calendar day, because the
// people reading it (a company's "not recently active" mark, an agency's "last active") read the
// day in India. The primary key is the idempotency: a second write the same day is
// `ON CONFLICT DO NOTHING`, across every process and restart. Its `worker_id` prefix also backs the
// ON DELETE CASCADE, so no second index is needed.
//
// IDS AND DATES ONLY. No route, IP, device, session or time of day: with any of those this would be
// a movement trace instead of a daily-active fact. `created_at` is when the row was written, which
// is never shown.
//
// `worker_id` cascades on worker deletion (DPDP erasure is `WorkersRepository.hardDelete`, which
// deletes the `workers` row). RLS forced, every role revoked (migration 0168).
//
// SWITCHED. Nothing reads or writes this table while `WORKER_ACTIVITY_ENABLED` is off.
// ---------------------------------------------------------------------------
export const workerActivity = pgTable(
  "worker_activity",
  {
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** The IST calendar day (`yyyy-mm-dd`) he was active. Never a time. */
    activeOn: date("active_on", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workerId, t.activeOn], name: "worker_activity_pkey" })],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0168

export type WorkerActivityRow = typeof workerActivity.$inferSelect;
export type NewWorkerActivityRow = typeof workerActivity.$inferInsert;
