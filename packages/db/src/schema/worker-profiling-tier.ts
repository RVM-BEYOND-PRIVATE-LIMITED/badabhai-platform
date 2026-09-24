import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import type { ProfilingTier } from "@badabhai/types";

import { workers } from "./worker";

// ===========================================================================
// worker_profiling_tier — how deep a worker chose to profile (migration 0126)
// ===========================================================================
//
// Tiered profiling: on the Chat path a form-routed worker picks Easy, Medium or Hard, the form
// asks only that tier's questions, and the résumé prints only that tier's rows. ONE ROW PER
// WORKER, because the résumé is per worker: the tier the sheet renders at is this row's `tier`.
//
// THE SESSION HALF LIVES ON THE SAME ROW. `chat_session_id` is the interview whose form the tier
// was chosen on, and `selected_at` is when — the start of the duration the completion event
// reports. Neither is a join: the session id is an opaque anchor, exactly as
// `profile_correction.session_id` is.
//
// NO ROW MEANS HARD (`DEFAULT_PROFILING_TIER`), which is today's full profiling. Migration 0125
// also backfills an explicit `hard`/`backfill` row for every worker who had already profiled, so
// the tier screen can tell "went through full profiling before tiers existed" from "has not
// chosen yet".
//
// A SEPARATE TABLE RATHER THAN A COLUMN ON `workers`, deliberately. A bare `workers` select names
// every model column, so a column there would 500 every worker read on a build that reaches the
// database before the migration does (the 2026-09-10 form outage). This table is read only by
// the tier repository and only while `PROFILING_TIERS_ENABLED` is on.
//
// NOT PII: an id, closed-set tiers, an opaque session id, a closed form kind, timestamps. Nothing
// here crosses the AI boundary. Erasure is the cascade on `worker_id`.
//
// ADDITIVE. Rollback: DROP TABLE "worker_profiling_tier";
// ===========================================================================
export const workerProfilingTiers = pgTable(
  "worker_profiling_tier",
  {
    workerId: uuid("worker_id")
      .primaryKey()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** The tier the form asks and the résumé renders at. Only ever raised, never lowered. */
    tier: text("tier").$type<ProfilingTier>().notNull(),
    /** `selected` — the worker chose it; `backfill` — migration 0126, a pre-tier full profile. */
    source: text("source").$type<"selected" | "backfill">().notNull(),
    /** The tier before the most recent upgrade; null until the worker upgrades. */
    upgradedFrom: text("upgraded_from").$type<ProfilingTier>(),
    /** The form kind the tier was chosen on (`TRADE_FORM_KINDS_ALL`), validated in code. */
    formKind: text("form_kind"),
    /** The interview that handed over that form — opaque, never a join. Null for a backfill. */
    chatSessionId: uuid("chat_session_id"),
    /** When the CURRENT tier was chosen (reset on upgrade). Null for a backfill. */
    selectedAt: timestamp("selected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // `PROFILING_TIERS` in @badabhai/types, spelled out because a CHECK is static SQL.
    check("wpt_tier_chk", sql`${t.tier} IN ('easy', 'medium', 'hard')`),
    check(
      "wpt_upgraded_from_chk",
      sql`${t.upgradedFrom} IS NULL OR ${t.upgradedFrom} IN ('easy', 'medium', 'hard')`,
    ),
    check("wpt_source_chk", sql`${t.source} IN ('selected', 'backfill')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0126

export type WorkerProfilingTier = typeof workerProfilingTiers.$inferSelect;
export type NewWorkerProfilingTier = typeof workerProfilingTiers.$inferInsert;
