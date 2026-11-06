/**
 * THE COMPLETED-PROFILE LEDGER — spend attribution that survives account deletion
 * (migration 0158, B2 #2555).
 *
 * WHY THIS TABLE EXISTS. #2554 made the dashboard's cost-per-profile ratio honest by
 * reading both halves off the event spine — but the SPLIT still joins each event to
 * the LIVE `workers` row at read time, and the denominator counts distinct workers off
 * `profile.extraction_completed` the same way. Deleting a test account therefore moves
 * its spend AND its completed profile into `deleted_or_unattributed`: the headline is
 * right, but the real/test boundary the investor number rests on is a function of who
 * has been erased lately rather than of who spent what. This table records the test
 * flag WHEN THE MONEY IS SPENT (cost events) and WHEN THE PROFILE COMPLETES (this
 * ledger), so a later erasure moves nothing.
 *
 * ONE ROW PER FINISHED PROFILE. Written in the SAME transaction as the
 * `profile.extraction_completed` event it mirrors (`ProfileExtractionProcessor`), so
 * the two can never disagree about whether a completion happened. The backfill
 * (`db:backfill:cost-ledger`) writes the same rows for historical completions, keyed
 * identically — `ON CONFLICT (profile_id) DO NOTHING` makes live and backfill writes
 * idempotent against each other.
 *
 * NO FOREIGN KEYS — DELIBERATELY. The whole point is surviving deletion: a FK to
 * `workers` (or to `worker_profiles`, whose rows cascade from `workers`) would erase
 * exactly the rows this table exists to keep. Every id here is opaque and internal,
 * the same UUIDs the completion event already carries.
 *
 * PRIVACY (§2): profile/session/job ids, a timestamp, a boolean flag and a closed
 * source enum. No name, phone, prompt, completion or transcript — the same discipline
 * as the running totals in {@link ./ai-cost}.
 */
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid, boolean } from "drizzle-orm/pg-core";

/** Where a ledger row came from — the live extraction path or the one-time backfill. */
export const PROFILE_COMPLETION_LEDGER_SOURCES = ["extraction", "backfill"] as const;
export type ProfileCompletionLedgerSource = (typeof PROFILE_COMPLETION_LEDGER_SOURCES)[number];

export const profileCompletionLedger = pgTable(
  "profile_completion_ledger",
  {
    // One row per finished profile — the PK, and the backfill/live idempotency key.
    // No FK: the profile row cascades from `workers` on erasure, and this row must not.
    profileId: uuid("profile_id").primaryKey(),
    // The interview that produced it. Nullable: an extraction can complete without a
    // chat session behind it (the OIE parse path), and a null reads "no session",
    // never "unknown".
    chatSessionId: uuid("chat_session_id"),
    // The extraction job. Nullable: the same surfaces that emit cost with a null
    // `ai_job_id` (#745) complete here — inline resume, skill-embed fan-out.
    aiJobId: uuid("ai_job_id"),
    // The opaque worker id, WITHOUT a foreign key — this is the column the old
    // denominator joined through `workers`, and the join is what deletion broke.
    // Nullable so a completion that never named a worker is still countable (as
    // unattributed), never dropped.
    workerId: uuid("worker_id"),
    // WHEN the profile finished — the event's `occurred_at`, not the insert time, so
    // backfilled rows land in their true window and windowed ratios do not shift as
    // the backfill runs.
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    // The test flag AS OF COMPLETION — read off the live `workers` row in the same
    // transaction that writes this row. Deleting the account later cannot move it.
    isTestAccount: boolean("is_test_account").notNull(),
    // Provenance: `extraction` for the live processor write, `backfill` for the
    // one-time historical rebuild. An operator auditing a row knows which path made it.
    source: text("source").$type<ProfileCompletionLedgerSource>().notNull(),
  },
  (t) => [
    // The windowed dashboard read: `WHERE completed_at >= $since GROUP BY is_test_account`.
    index("profile_completion_ledger_completed_idx").on(t.completedAt),
    // The per-worker read the acceptance test uses ("this worker's completions").
    index("profile_completion_ledger_worker_idx").on(t.workerId),
    check("profile_completion_ledger_source_chk", sql`${t.source} IN ('extraction', 'backfill')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0158

export type ProfileCompletionLedgerRow = typeof profileCompletionLedger.$inferSelect;
export type NewProfileCompletionLedgerRow = typeof profileCompletionLedger.$inferInsert;
