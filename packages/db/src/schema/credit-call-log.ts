import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import type { CreditCallResult } from "@badabhai/types";

import { payers } from "./payer";

// ---------------------------------------------------------------------------
// credit_call_log — one row per call the telecaller made to a company whose credits ran out
// (#2755 item 8, metric group 10).
//
// THE CALL LIST is `GET /admin/numbers/out-of-credits`: the countable companies whose usable
// balance is zero now, newest first by the moment they ran out. Each call an admin makes from it is
// recorded here with `POST /admin/numbers/out-of-credits/:payerId/calls`, and the list shows each
// company's latest entry beside it.
//
// IDS, A TIME AND ONE CLOSED CODE ONLY. `result` is one of `CREDIT_CALL_RESULTS`
// (@badabhai/types): no note, no name, no phone, no free text of any kind
// (`credit_call_log_result_chk`). `called_by_admin_id` is the admin who logged the call; it has
// no FK, as on every admin-actor column (an admin account can be removed without rewriting
// history).
//
// APPEND-ONLY BY USE. The route inserts; nothing updates or deletes a row. A retried POST carries
// the same Idempotency-Key, from which the row's id is derived, so a retry inserts nothing.
//
// `payer_id` cascades with the company (`payers.id`, the wallet key: the tenant key the credits
// are kept under, ADR-0053), as every tenant-keyed table does. The (payer_id, called_at DESC)
// index is the list's "latest call per company" read and backs the cascade. RLS forced, every role
// revoked (the migration's hand-written tail).
//
// SWITCHED. Nothing reads or writes this table while ADMIN_NUMBERS_ENABLED is off.
// ---------------------------------------------------------------------------
export const creditCallLog = pgTable(
  "credit_call_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The company called (its wallet key). Cascades with the company. */
    payerId: uuid("payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "cascade" }),
    /** The admin who logged the call. No FK (an admin-actor column). */
    calledByAdminId: uuid("called_by_admin_id").notNull(),
    /** When the call was logged. */
    calledAt: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
    /** One of `CREDIT_CALL_RESULTS`. Never free text. */
    result: text("result").$type<CreditCallResult>().notNull(),
  },
  (t) => [
    // The list's latest-call-per-company read, and the payer_id ON DELETE CASCADE.
    index("credit_call_log_payer_called_idx").on(t.payerId, t.calledAt.desc()),
    // `CREDIT_CALL_RESULTS`, spelled out because a CHECK is static SQL (the migration test pins
    // the copy).
    check(
      "credit_call_log_result_chk",
      sql`${t.result} IN ('reached_will_buy', 'reached_not_now', 'reached_declined', 'no_answer', 'wrong_number')`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by the migration

export type CreditCallLogRow = typeof creditCallLog.$inferSelect;
export type NewCreditCallLogRow = typeof creditCallLog.$inferInsert;
