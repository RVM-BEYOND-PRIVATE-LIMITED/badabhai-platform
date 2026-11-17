import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workers } from "./worker";

// ---------------------------------------------------------------------------
// still_looking_checks — the monthly "still looking?" check (#2753 item 5).
//
// ONE ROW PER PROMPT. The daily sweep opens a check (`prompted_at`, no answer) for each worker
// whose last check is more than STILL_LOOKING_EVERY_DAYS (default 30) old, or who has none; the
// worker answers it with one tap (`POST /workers/me/still-looking`): `yes`, `not_now` or `hired`.
// A worker may also answer from Settings with no check open: that opens and answers one row in the
// same statement. The rows are the history; the spine carries `worker.still_looking_prompted` and
// `worker.still_looking_answered`.
//
// ONE OPEN CHECK PER WORKER (`still_looking_checks_open_uq`, partial on `answered_at IS NULL`):
// the sweep's insert is guarded by it, so two sweeps racing open one check, never two.
//
// IDS, TIMES AND A CLOSED CODE ONLY. No name, phone, free text or device. Not PII beyond the
// worker id. `answer` and `answered_at` are set together or not at all (`still_looking_checks_
// answered_chk`).
//
// `worker_id` cascades on worker deletion (DPDP erasure is `WorkersRepository.hardDelete`); the
// (worker_id, prompted_at) index backs the cascade and the per-worker reads. RLS forced, every
// role revoked (migration 0173).
//
// SWITCHED. Nothing reads or writes this table while `STILL_LOOKING_CHECK_ENABLED` is off.
// ---------------------------------------------------------------------------

/** The worker's three answers to the monthly check. A new value is a new event version. */
export const STILL_LOOKING_ANSWERS = ["yes", "not_now", "hired"] as const;
export type StillLookingAnswer = (typeof STILL_LOOKING_ANSWERS)[number];

export const stillLookingChecks = pgTable(
  "still_looking_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The worker asked. Cascades on erasure. */
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** When the check was opened: the sweep's tick, or the moment he answered from Settings. */
    promptedAt: timestamp("prompted_at", { withTimezone: true }).notNull(),
    /** When he answered; null while the check is open. */
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    /** His answer; null while the check is open. */
    answer: text("answer").$type<StillLookingAnswer>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ONE OPEN CHECK PER WORKER: the sweep's insert target (`ON CONFLICT ... DO NOTHING`).
    uniqueIndex("still_looking_checks_open_uq")
      .on(t.workerId)
      .where(sql`${t.answeredAt} IS NULL`),
    // The per-worker reads (the open check, the latest check, the sweep's window) and the
    // worker_id ON DELETE CASCADE.
    index("still_looking_checks_worker_prompted_idx").on(t.workerId, t.promptedAt),
    // `STILL_LOOKING_ANSWERS`, spelled out because a CHECK is static SQL.
    check(
      "still_looking_checks_answer_chk",
      sql`${t.answer} IS NULL OR ${t.answer} IN ('yes', 'not_now', 'hired')`,
    ),
    // An answer and its time are set together, or neither is.
    check(
      "still_looking_checks_answered_chk",
      sql`(${t.answer} IS NULL) = (${t.answeredAt} IS NULL)`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by migration 0173

export type StillLookingCheck = typeof stillLookingChecks.$inferSelect;
export type NewStillLookingCheck = typeof stillLookingChecks.$inferInsert;
