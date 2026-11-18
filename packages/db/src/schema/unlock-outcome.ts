import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import type { UnlockOutcome, UnlockOutcomeAnswerer } from "@badabhai/types";

import { unlocks } from "./payer";
import { workers } from "./worker";

// ---------------------------------------------------------------------------
// unlock_outcomes — what became of one opened contact (#2753 item 10).
//
// THE COMPANY FOLLOW-UP. A company that opened a contact is asked, after
// `UNLOCK_FOLLOWUP_AFTER_DAYS`, what came of it: `hired`, `not_hired` or `still_talking`
// (`POST /payer/unlocks/:unlockId/outcome`); the desk writes `not_reached` when the company could
// not reach him (#2750). ONE ROW PER UNLOCK: a later answer replaces the earlier one
// (`still_talking` → `hired`); the history is on the spine (`unlock.outcome_recorded`), not in rows.
// "Due" is computed at read time from `unlocks.granted_at` and this row, so nothing here marks it.
//
// These rows are what the second launch test in #2755 reads, and they cannot be rebuilt later.
//
// `tenant_payer_id` is the company's TENANT key: the `unlocks.payer_id` of the unlock (the
// unlock writer stores the tenant there, ADR-0053). No FK, like `unlocks.payer_id` itself: the
// unlock row is the parent, and it cascades. `answered_at` is when the stored answer was given (a
// repeated `still_talking` moves it: that restarts the wait); `(tenant_payer_id, answered_at)` is
// the per-company weekly read.
//
// IDS, DATES AND CLOSED CODES ONLY. `worker_id` cascades on worker deletion (DPDP erasure; the
// unlock itself survives an erasure with its worker_id nulled). RLS forced, every role revoked
// (hand-written in the migration).
//
// Nothing reads or writes this table while `UNLOCK_FOLLOWUP_ENABLED` is off.
// ---------------------------------------------------------------------------

export const unlockOutcomes = pgTable(
  "unlock_outcomes",
  {
    /** The opened contact this answer is about. One row per unlock. */
    unlockId: uuid("unlock_id")
      .primaryKey()
      .references(() => unlocks.id, { onDelete: "cascade" }),
    /** The company's tenant key: the unlock's own `payer_id` (no FK, as on `unlocks`). */
    tenantPayerId: uuid("tenant_payer_id").notNull(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    outcome: text("outcome").$type<UnlockOutcome>().notNull(),
    /** `company` (its own answer) or `desk` (#2750's couldn't-reach case). */
    answeredBy: text("answered_by").$type<UnlockOutcomeAnswerer>().notNull(),
    /** When the stored answer was given. */
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The per-company read by week (#2755's launch test) and the due list's answered side.
    index("unlock_outcomes_tenant_answered_idx").on(t.tenantPayerId, t.answeredAt),
    // Backs the `worker_id` ON DELETE CASCADE: without it every worker erasure scans the table.
    index("unlock_outcomes_worker_id_idx").on(t.workerId),
    // `UNLOCK_OUTCOMES` / `UNLOCK_OUTCOME_ANSWERERS` in @badabhai/types, spelled out because a
    // CHECK is static SQL.
    check(
      "unlock_outcomes_outcome_chk",
      sql`${t.outcome} IN ('hired', 'not_hired', 'still_talking', 'not_reached')`,
    ),
    check("unlock_outcomes_answered_by_chk", sql`${t.answeredBy} IN ('company', 'desk')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by the migration

export type UnlockOutcomeRow = typeof unlockOutcomes.$inferSelect;
export type NewUnlockOutcomeRow = typeof unlockOutcomes.$inferInsert;
