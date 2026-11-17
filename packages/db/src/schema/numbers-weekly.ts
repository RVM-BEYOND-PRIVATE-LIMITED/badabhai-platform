import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// numbers_weekly — the weekly snapshot of the CEO's numbers screen (#2755 items 4, 5 and 11).
//
// ONE ROW PER WEEK × METRIC × CITY GROUP × TRADE GROUP, the `all` roll-ups INCLUDED. A roll-up is
// computed from the source rows, never by adding stored cells, so a filter on the screen reads its
// own stored cell and never adds suppressed cells together. The week is Monday to Sunday, India
// time, named by its Monday (`apps/api/src/admin/numbers/week.ts`); the metric ids, the groups and
// the rules are the API's code constants (`definitions.ts`, `groups.ts`), stamped on every row as
// `definition_version`.
//
// WRITTEN ONLY BY THE NIGHTLY SWEEP AND THE RECOMPUTE TOOL. The sweep recomputes every week from
// the baseline to the current one that is NOT frozen (one transaction per week, delete then
// insert under an advisory lock), and freezes a week NUMBERS_FREEZE_AFTER_DAYS (default 3) after
// it ends by setting `frozen_at` on its rows. It never touches a frozen week again: only the
// recompute tool (`recompute-numbers.cli.ts`) rewrites a frozen week, and it writes one
// `numbers_recompute_log` row in the same transaction. `GET /admin/numbers/weekly` reads ONLY this
// table, so a frozen figure cannot drift with the live tables under it.
//
// SMALL WORKER CELLS. A worker figure under the floor of 5 (the onboarding funnel's
// `ADMIN_FUNNEL_K_ANON_FLOOR`) is stored `suppressed` with every number NULL, except the
// `all × all` total (`numbers_weekly_suppressed_chk` keeps a suppressed row empty).
//
// AGGREGATES ONLY: counts, paise and the two terms of a ratio. No worker, company, posting or
// order id; no name, phone or free text. RLS forced, every role revoked (the migration's
// hand-written tail).
//
// SWITCHED. Nothing reads or writes this table while ADMIN_NUMBERS_ENABLED is off.
// ---------------------------------------------------------------------------
export const numbersWeekly = pgTable(
  "numbers_weekly",
  {
    /** The week's Monday (India time), `yyyy-mm-dd`. */
    weekStart: date("week_start", { mode: "string" }).notNull(),
    /** A metric id of `definitions.ts` (a revenue pack is `revenue_by_pack:<pack_code>`). */
    metric: text("metric").notNull(),
    /** A city group label of `groups.ts`, `all` included. */
    cityGroup: text("city_group").notNull(),
    /** A trade group label of `groups.ts`, `all` included. */
    tradeGroup: text("trade_group").notNull(),
    /** The figure: a count, paise, or a ratio in hundredths. NULL when suppressed or not computable. */
    value: bigint("value", { mode: "number" }),
    /** A ratio's or a share's top term (contacts opened); NULL otherwise. */
    numerator: bigint("numerator", { mode: "number" }),
    /** A ratio's or a share's bottom term (confirmed hires); NULL otherwise. */
    denominator: bigint("denominator", { mode: "number" }),
    /** A worker cell under the floor: every number above is NULL. */
    suppressed: boolean("suppressed").notNull().default(false),
    /** The `NUMBERS_DEFINITION_VERSION` the row was computed under. */
    definitionVersion: integer("definition_version").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    /** Set once, by the sweep (or a recompute): the week is final. */
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({
      columns: [t.weekStart, t.metric, t.cityGroup, t.tradeGroup],
      name: "numbers_weekly_pkey",
    }),
    // A week is named by its Monday; any other day is a bug in the writer.
    check("numbers_weekly_week_start_chk", sql`extract(isodow from ${t.weekStart}) = 1`),
    check(
      "numbers_weekly_suppressed_chk",
      sql`NOT ${t.suppressed} OR (${t.value} IS NULL AND ${t.numerator} IS NULL AND ${t.denominator} IS NULL)`,
    ),
    check("numbers_weekly_definition_version_chk", sql`${t.definitionVersion} >= 1`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by the migration's tail

export type NumbersWeeklyRow = typeof numbersWeekly.$inferSelect;
export type NewNumbersWeeklyRow = typeof numbersWeekly.$inferInsert;

/** Who ran a recompute. Only the CLI today; a new actor is a CHECK change. */
export const NUMBERS_RECOMPUTE_ACTORS = ["cli"] as const;
export type NumbersRecomputeActor = (typeof NUMBERS_RECOMPUTE_ACTORS)[number];

/** The operator's reason, in his own words: 1 to 500 characters. */
export const NUMBERS_RECOMPUTE_REASON_MAX = 500;

// ---------------------------------------------------------------------------
// numbers_recompute_log — one row per APPLIED recompute of `numbers_weekly` (#2755 item 4).
//
// A frozen week changes only through the recompute tool, and every applied run writes exactly one
// row here IN THE SAME TRANSACTION as the rewrite: which weeks, under which definition version, how
// many snapshot rows changed, and the operator's reason. A dry run writes nothing.
//
// `reason` is FREE TEXT in the operator's own words (1..500 characters). It is stored here and
// nowhere else: never logged, never printed back, never put on an event. RLS forced, every role
// revoked (the migration's hand-written tail).
// ---------------------------------------------------------------------------
export const numbersRecomputeLog = pgTable(
  "numbers_recompute_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    /** `NUMBERS_RECOMPUTE_ACTORS`. */
    actor: text("actor").$type<NumbersRecomputeActor>().notNull(),
    fromWeek: date("from_week", { mode: "string" }).notNull(),
    toWeek: date("to_week", { mode: "string" }).notNull(),
    /** The version the weeks were recomputed under. */
    definitionVersion: integer("definition_version").notNull(),
    /** The operator's own words. Never logged or put on an event. */
    reason: text("reason").notNull(),
    /** Snapshot rows added, removed or changed by the run. */
    rowsChanged: integer("rows_changed").notNull(),
  },
  (t) => [
    check("numbers_recompute_log_actor_chk", sql`${t.actor} IN ('cli')`),
    check("numbers_recompute_log_weeks_chk", sql`${t.fromWeek} <= ${t.toWeek}`),
    check("numbers_recompute_log_reason_chk", sql`char_length(${t.reason}) BETWEEN 1 AND 500`),
    check("numbers_recompute_log_rows_changed_chk", sql`${t.rowsChanged} >= 0`),
    check("numbers_recompute_log_definition_version_chk", sql`${t.definitionVersion} >= 1`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by the migration's tail

export type NumbersRecomputeLogRow = typeof numbersRecomputeLog.$inferSelect;
export type NewNumbersRecomputeLogRow = typeof numbersRecomputeLog.$inferInsert;
