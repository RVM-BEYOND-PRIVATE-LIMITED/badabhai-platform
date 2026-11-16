import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workers } from "./worker";

// ---------------------------------------------------------------------------
// worker_search_exits — a worker who left company search (#2753 item 6).
//
// A ROW PRESENT MEANS HE IS OUT of every company's candidate search (the all-candidates pool, its
// city facet and the admin card read), and a company he did NOT apply to can no longer open him
// from an id it kept from an earlier search page. Coming back deletes the row. His consent is
// untouched either way: withdrawing consent stays the stronger exit, and this table never stands
// in for it. His own job feed, applying, chat and every company list he applied to are unaffected.
//
// A SIDE TABLE, NOT A COLUMN ON `workers`, on purpose: nothing reads or writes it while
// `SEARCH_EXIT_ENABLED` is off, so the migration is apply-before-the-switch rather than
// apply-before-deploy on a hot table (migration 0168's header).
//
// IDS, A TIME AND A CLOSED CODE ONLY. `via` says which surface took him out: `worker` (his own
// switch, `PUT /workers/me/search-visibility`) or `monthly_check` (a later part writes it when he
// answers "not now"). Not PII.
//
// `worker_id` is the primary key (one exit per worker) and cascades on worker deletion (DPDP:
// `WorkersRepository.hardDelete` deletes the workers row). RLS forced, every role revoked
// (migration 0168).
// ---------------------------------------------------------------------------

/** Which surface took the worker out of company search. */
export const WORKER_SEARCH_EXIT_VIAS = ["worker", "monthly_check"] as const;
export type WorkerSearchExitVia = (typeof WORKER_SEARCH_EXIT_VIAS)[number];

export const workerSearchExits = pgTable(
  "worker_search_exits",
  {
    /** One exit per worker. Cascades on erasure. */
    workerId: uuid("worker_id")
      .primaryKey()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** When he left; kept by a repeat "leave" (the first one stands). */
    hiddenAt: timestamp("hidden_at", { withTimezone: true }).notNull().defaultNow(),
    via: text("via").$type<WorkerSearchExitVia>().notNull(),
  },
  (t) => [
    // `WORKER_SEARCH_EXIT_VIAS`, spelled out because a CHECK is static SQL. A new value widens
    // this in its own migration, with a new event version.
    check("worker_search_exits_via_chk", sql`${t.via} IN ('worker', 'monthly_check')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by migration 0168

export type WorkerSearchExit = typeof workerSearchExits.$inferSelect;
export type NewWorkerSearchExit = typeof workerSearchExits.$inferInsert;
