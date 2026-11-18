import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  min,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  CURRENT_PROFILE_ORDER,
  hires,
  jobPostings,
  numbersRecomputeLog,
  numbersWeekly,
  paymentOrders,
  unlocks,
  workerProfiles,
  workers,
  type Database,
  type NumbersRecomputeActor,
} from "@badabhai/db";
import { DATABASE } from "../../database/database.module";
import { OPENED_UNLOCK_STATUSES } from "../../unlock-outcomes/unlock-outcomes.repository";
import { AdminEventsRepository } from "../admin-events.repository";
import { AdminFunnelRepository } from "../admin-funnel.repository";
import {
  countablePayer,
  countableWorker,
  excludeImportedOpens,
  excludeSamplePostings,
  excludeTestAndSampleWorkerRefs,
} from "./exclusions";
import {
  NUMBERS_COHORT_METRICS,
  NUMBERS_REPEAT_LONGEST_WINDOW_DAYS,
  numbersFreezeClassOf,
  type NumbersFreezeClass,
} from "./definitions";
import { cityGroupOf, tradeGroupOf } from "./groups";
import type { NumbersDims } from "./metrics/cells";
import { CONFIRMED_PROFILE_STATUS } from "./metrics/completed-profiles";
import type { NumbersWeekSources } from "./metrics/compute-week";
import type {
  NumbersActivityRow,
  NumbersCurrentProfileRow,
  NumbersFirstPublicationRow,
  NumbersFormCompletionRow,
  NumbersHireRow,
  NumbersOpenedContactRow,
  NumbersPaidOrderRow,
  NumbersPostingChoiceRow,
  NumbersReachCaseRow,
  NumbersWaivedOpenRow,
  NumbersWeekWindow,
  NumbersWelcomeRunOutRow,
} from "./metrics/types";
import { ACTIVE_WINDOW_DAYS } from "./metrics/active-workers";

/** The event that marks a finished trade form (once per worker and pack, subject = the worker). */
export const FORM_COMPLETED_EVENT = "profile.form_completed";

/** Largest `IN (...)` id list per statement (the funnel's bound: far under the driver ceiling). */
const ID_BATCH_MAX = 2000;
/** Snapshot rows per INSERT (11 parameters each: far under the driver's 65535). */
const INSERT_BATCH_MAX = 1000;

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One stored snapshot cell, as the sweep writes it and the route and the recompute read it. */
export interface NumbersSnapshotCellRow {
  readonly weekStart: string;
  readonly metric: string;
  readonly cityGroup: string;
  readonly tradeGroup: string;
  readonly value: number | null;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly suppressed: boolean;
  readonly definitionVersion: number;
}

/** A stored cell with its two times (the route's read). */
export interface NumbersStoredCellRow extends NumbersSnapshotCellRow {
  readonly computedAt: Date;
  readonly frozenAt: Date | null;
}

/** One applied recompute, as the log records it. */
export interface NumbersRecomputeLogInput {
  readonly actor: NumbersRecomputeActor;
  readonly fromWeek: string;
  readonly toWeek: string;
  readonly definitionVersion: number;
  readonly reason: string;
  readonly rowsChanged: number;
}

/** `yyyy-mm-dd` moved by whole days (no clock). */
function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** IST midnight of a day, as a UTC instant. */
function istMidnightUtc(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - IST_OFFSET_MS);
}

/** An instant as a timestamptz parameter (a raw `Date` in a `sql` template reaches the driver unmapped). */
function ts(at: Date): SQL {
  return sql`${at.toISOString()}::timestamptz`;
}

/** Epoch milliseconds from a raw row (`float8` arrives as a number; anything else is null). */
function msOf(value: unknown): Date | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? new Date(n) : null;
}

/** Split `ids` into bounded batches. */
function batches(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_BATCH_MAX) out.push(ids.slice(i, i + ID_BATCH_MAX));
  return out;
}

/**
 * #2755 part B — data access for the WEEKLY SNAPSHOT: the source reads each metric is counted
 * from, the snapshot's own writes (one week per transaction, under an advisory lock), the
 * recompute log, and the route's read.
 *
 * ── THE SOURCE READS ARE SELECT-ONLY, AND EXCLUDE IN SQL ───────────────────────────────────
 * Every read composes part A's exclusions (`exclusions.ts`): a company read keeps countable
 * companies only, a worker read countable workers only, so a test, sample or linked row never
 * reaches a metric function. They project ids, times, a pack code, an amount and the two raw
 * dimensions (a city and a trade key) only: no name, phone, payload or free text. The one spine
 * read (the form completions) goes through `AdminEventsRepository`, the admin reader of `events`.
 *
 * ── THE WRITES TOUCH ONLY `numbers_weekly` AND `numbers_recompute_log` ──────────────────────
 * One week is deleted and re-inserted whole, on the caller's transaction, after
 * {@link lockWeek}: two sweeps (or a sweep and a recompute) on two processes serialise on the
 * week's advisory lock, and the later one sees what the earlier one committed (a frozen week, or
 * the same rows), so a week is always exactly one set of rows.
 */
@Injectable()
export class NumbersWeeklyRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly adminEvents: AdminEventsRepository,
  ) {}

  /** One transaction. */
  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  // -- presence ----------------------------------------------------------------------------

  /** Are both snapshot tables there (the migration applied)? One catalogue read, no 42P01. */
  async snapshotTablesExist(db: Database = this.db): Promise<boolean> {
    const rows = (await db.execute(sql`
      SELECT to_regclass('public.numbers_weekly') IS NOT NULL
         AND to_regclass('public.numbers_recompute_log') IS NOT NULL AS present
    `)) as unknown as Array<{ present: boolean }>;
    return rows[0]?.present === true;
  }

  /** Is `worker_activity` there (#2753's migration)? Without it the device term stands alone. */
  async workerActivityTableExists(db: Database = this.db): Promise<boolean> {
    const rows = (await db.execute(sql`
      SELECT to_regclass('public.worker_activity') IS NOT NULL AS present
    `)) as unknown as Array<{ present: boolean }>;
    return rows[0]?.present === true;
  }

  // -- the snapshot's writes ---------------------------------------------------------------

  /** Serialise every writer of one week across processes (held to the transaction's end). */
  async lockWeek(tx: Database, week: string): Promise<void> {
    const key = `numbers_weekly:${week}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }

  /**
   * Which of the week's two FREEZE CLASSES are frozen (part C): `week` when any row of a metric
   * other than the cohort ones carries `frozen_at`, `cohort` when any repeat-buying row does. A
   * class is frozen whole (its rows are written in one statement with one `frozen_at`), so one
   * frozen row stands for all of them.
   */
  async frozenClasses(tx: Database, week: string): Promise<Set<NumbersFreezeClass>> {
    const rows = await tx
      .selectDistinct({ metric: numbersWeekly.metric })
      .from(numbersWeekly)
      .where(and(eq(numbersWeekly.weekStart, week), isNotNull(numbersWeekly.frozenAt)));
    return new Set(rows.map((r) => numbersFreezeClassOf(r.metric)));
  }

  /** The week's stored cells, for a recompute's diff. */
  async readWeek(tx: Database, week: string): Promise<NumbersSnapshotCellRow[]> {
    return tx
      .select({
        weekStart: numbersWeekly.weekStart,
        metric: numbersWeekly.metric,
        cityGroup: numbersWeekly.cityGroup,
        tradeGroup: numbersWeekly.tradeGroup,
        value: numbersWeekly.value,
        numerator: numbersWeekly.numerator,
        denominator: numbersWeekly.denominator,
        suppressed: numbersWeekly.suppressed,
        definitionVersion: numbersWeekly.definitionVersion,
      })
      .from(numbersWeekly)
      .where(eq(numbersWeekly.weekStart, week));
  }

  /**
   * Replace the rows of ONE FREEZE CLASS of the week: delete that class's rows, insert `rows`
   * (every one of that class), each stamped with `computedAt` and `frozenAt` (null: the sweep
   * comes back tomorrow). The other class's rows are not touched, so a frozen `week` class stays
   * byte for byte while the open `cohort` rows of the same week are rewritten (part C). The caller
   * holds {@link lockWeek}.
   */
  async replaceWeek(
    tx: Database,
    week: string,
    cls: NumbersFreezeClass,
    rows: readonly NumbersSnapshotCellRow[],
    computedAt: Date,
    frozenAt: Date | null,
  ): Promise<void> {
    const cohort = [...NUMBERS_COHORT_METRICS];
    await tx
      .delete(numbersWeekly)
      .where(
        and(
          eq(numbersWeekly.weekStart, week),
          cls === "cohort"
            ? inArray(numbersWeekly.metric, cohort)
            : notInArray(numbersWeekly.metric, cohort),
        ),
      );
    for (let i = 0; i < rows.length; i += INSERT_BATCH_MAX) {
      const chunk = rows.slice(i, i + INSERT_BATCH_MAX);
      if (chunk.length === 0) continue;
      await tx.insert(numbersWeekly).values(
        chunk.map((r) => {
          if (r.weekStart !== week) throw new Error(`a ${r.weekStart} row in week ${week}`);
          if (numbersFreezeClassOf(r.metric) !== cls) {
            throw new Error(`a ${r.metric} row is not of the ${cls} freeze class`);
          }
          return { ...r, computedAt, frozenAt };
        }),
      );
    }
  }

  /** The one log row of an applied recompute, on the recompute's transaction. */
  async insertRecomputeLog(tx: Database, input: NumbersRecomputeLogInput): Promise<string> {
    const rows = await tx
      .insert(numbersRecomputeLog)
      .values(input)
      .returning({ id: numbersRecomputeLog.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("numbers_recompute_log insert returned no row");
    return id;
  }

  // -- the route's read --------------------------------------------------------------------

  /** One filter's stored cells for the listed weeks (every metric). The route reads nothing else. */
  async readCells(
    weeks: readonly string[],
    cityGroup: string,
    tradeGroup: string,
  ): Promise<NumbersStoredCellRow[]> {
    if (weeks.length === 0) return [];
    return this.db
      .select({
        weekStart: numbersWeekly.weekStart,
        metric: numbersWeekly.metric,
        cityGroup: numbersWeekly.cityGroup,
        tradeGroup: numbersWeekly.tradeGroup,
        value: numbersWeekly.value,
        numerator: numbersWeekly.numerator,
        denominator: numbersWeekly.denominator,
        suppressed: numbersWeekly.suppressed,
        definitionVersion: numbersWeekly.definitionVersion,
        computedAt: numbersWeekly.computedAt,
        frozenAt: numbersWeekly.frozenAt,
      })
      .from(numbersWeekly)
      .where(
        and(
          inArray(numbersWeekly.weekStart, [...weeks]),
          eq(numbersWeekly.cityGroup, cityGroup),
          eq(numbersWeekly.tradeGroup, tradeGroup),
        ),
      )
      .orderBy(asc(numbersWeekly.weekStart), asc(numbersWeekly.metric));
  }

  /**
   * The newest COMPLETE stored cell of each cohort metric (part C) for one filter, among the weeks
   * up to `toWeek`: a cohort row whose window has closed stores its numerator (pending stores none),
   * so the newest row with a numerator is the newest closed cohort. One row per metric at most; a
   * snapshot read like the others.
   */
  async readLatestCompleteCohorts(
    toWeek: string,
    cityGroup: string,
    tradeGroup: string,
  ): Promise<NumbersStoredCellRow[]> {
    return this.db
      .selectDistinctOn([numbersWeekly.metric], {
        weekStart: numbersWeekly.weekStart,
        metric: numbersWeekly.metric,
        cityGroup: numbersWeekly.cityGroup,
        tradeGroup: numbersWeekly.tradeGroup,
        value: numbersWeekly.value,
        numerator: numbersWeekly.numerator,
        denominator: numbersWeekly.denominator,
        suppressed: numbersWeekly.suppressed,
        definitionVersion: numbersWeekly.definitionVersion,
        computedAt: numbersWeekly.computedAt,
        frozenAt: numbersWeekly.frozenAt,
      })
      .from(numbersWeekly)
      .where(
        and(
          inArray(numbersWeekly.metric, [...NUMBERS_COHORT_METRICS]),
          lte(numbersWeekly.weekStart, toWeek),
          eq(numbersWeekly.cityGroup, cityGroup),
          eq(numbersWeekly.tradeGroup, tradeGroup),
          isNotNull(numbersWeekly.numerator),
        ),
      )
      .orderBy(asc(numbersWeekly.metric), desc(numbersWeekly.weekStart));
  }

  /**
   * The first week whose stored all-cities, all-trades `paying_companies_cumulative` is above
   * zero: the week the first real payment settled in. Null while there is none. A snapshot read.
   */
  async firstPaidWeek(): Promise<string | null> {
    const rows = await this.db
      .select({ week: min(numbersWeekly.weekStart) })
      .from(numbersWeekly)
      .where(
        and(
          eq(numbersWeekly.metric, "paying_companies_cumulative"),
          eq(numbersWeekly.cityGroup, "all"),
          eq(numbersWeekly.tradeGroup, "all"),
          sql`${numbersWeekly.value} > 0`,
        ),
      );
    return rows[0]?.week ?? null;
  }

  // -- the baseline ------------------------------------------------------------------------

  /**
   * The earliest instant any source row of a live metric carries (null when there is none): the
   * sweep starts at the later of its week and `NUMBERS_BASELINE_FROM`. Each term is an indexed
   * or small aggregate; countable rows only, so a seeded sample cannot pull the start back.
   */
  async earliestSourceAt(db: Database = this.db): Promise<Date | null> {
    const activity = (await this.workerActivityTableExists(db))
      ? sql`(SELECT extract(epoch from min(wa.active_on)::timestamp) * 1000 - ${IST_OFFSET_MS} FROM worker_activity wa)`
      : sql`NULL::float8`;
    const rows = (await db.execute(sql`
      SELECT least(
        (SELECT extract(epoch from min("payment_orders"."updated_at")) * 1000 FROM "payment_orders"
          WHERE "payment_orders"."status" = 'paid'
            AND ${countablePayer(sql.raw(`"payment_orders"."payer_id"`))}),
        (SELECT extract(epoch from min("job_postings"."published_at")) * 1000 FROM "job_postings"
          WHERE "job_postings"."published_at" IS NOT NULL
            AND ${countablePayer(sql.raw(`"job_postings"."payer_id"`))}
            AND ${excludeSamplePostings(sql.raw(`"job_postings"."id"`))}),
        (SELECT extract(epoch from min("worker_profiles"."confirmed_at")) * 1000
          FROM "worker_profiles" JOIN "workers" ON "workers"."id" = "worker_profiles"."worker_id"
          WHERE ${countableWorker}),
        (SELECT extract(epoch from min("hires"."hired_on")::timestamp) * 1000 - ${IST_OFFSET_MS}
          FROM "hires" WHERE "hires"."status" = 'confirmed'),
        (SELECT extract(epoch from min("unlocks"."granted_at")) * 1000 FROM "unlocks"
          WHERE "unlocks"."granted_at" IS NOT NULL),
        ${activity}
      )::float8 AS earliest_ms
    `)) as unknown as Array<{ earliest_ms: unknown }>;
    return msOf(rows[0]?.earliest_ms);
  }

  // -- the source reads --------------------------------------------------------------------

  /**
   * The sources of one week's metrics, read on `tx` (the week's transaction). `hasActivityTable`
   * is asked once per run (a missing `worker_activity` leaves the device term alone, as the live
   * last-active read does).
   */
  sourcesFor(tx: Database, hasActivityTable: boolean): NumbersWeekSources {
    return {
      paidOrders: (w) => this.paidOrders(tx, w),
      cohortOrders: (w) => this.cohortOrders(tx, w),
      firstPublications: () => this.firstPublications(tx),
      currentProfiles: () => this.currentProfiles(tx),
      activity: (w) => this.activity(tx, w, hasActivityTable),
      confirmedHires: (w) => this.confirmedHires(tx, w),
      openedContacts: (w) => this.openedContacts(tx, w),
      formCompletions: (w) => this.formCompletions(tx, w),
      welcomeRunOuts: (w) => this.welcomeRunOuts(tx, w),
      reachCases: (w) => this.reachCases(tx, w),
      waivedOpens: (w) => this.waivedOpens(tx, w),
      postingChoices: (w) => this.postingChoices(tx, w),
      companyDims: (ids) => this.companyDims(tx, ids),
      workerDims: (ids) => this.workerDims(tx, ids),
    };
  }

  /** Paid orders of countable companies settled before the week's end. */
  private async paidOrders(tx: Database, w: NumbersWeekWindow): Promise<NumbersPaidOrderRow[]> {
    return tx
      .select({
        payerId: paymentOrders.payerId,
        packCode: paymentOrders.packCode,
        amountInr: paymentOrders.amountInr,
        taxablePaise: paymentOrders.taxablePaise,
        gstPaise: paymentOrders.gstPaise,
        settledAt: paymentOrders.updatedAt,
      })
      .from(paymentOrders)
      .where(
        and(
          eq(paymentOrders.status, "paid"),
          lt(paymentOrders.updatedAt, w.toUtcExclusive),
          countablePayer(sql.raw(`"payment_orders"."payer_id"`)),
        ),
      );
  }

  /**
   * Paid orders of countable companies settled before the week's end plus the longest repeat
   * window (part C): the same paid, real-money rule as {@link paidOrders}, read far enough for
   * each cohort company's first AND second order to be in it.
   */
  private async cohortOrders(tx: Database, w: NumbersWeekWindow): Promise<NumbersPaidOrderRow[]> {
    const until = new Date(
      w.toUtcExclusive.getTime() + NUMBERS_REPEAT_LONGEST_WINDOW_DAYS * DAY_MS,
    );
    return tx
      .select({
        payerId: paymentOrders.payerId,
        packCode: paymentOrders.packCode,
        amountInr: paymentOrders.amountInr,
        taxablePaise: paymentOrders.taxablePaise,
        gstPaise: paymentOrders.gstPaise,
        settledAt: paymentOrders.updatedAt,
      })
      .from(paymentOrders)
      .where(
        and(
          eq(paymentOrders.status, "paid"),
          lt(paymentOrders.updatedAt, until),
          countablePayer(sql.raw(`"payment_orders"."payer_id"`)),
        ),
      );
  }

  /** Each countable company's first publish (the seed's sample postings left out). */
  private async firstPublications(tx: Database): Promise<NumbersFirstPublicationRow[]> {
    const rows = await tx
      .select({ payerId: jobPostings.payerId, firstPublishedAt: min(jobPostings.publishedAt) })
      .from(jobPostings)
      .where(
        and(
          isNotNull(jobPostings.publishedAt),
          countablePayer(sql.raw(`"job_postings"."payer_id"`)),
          excludeSamplePostings(sql.raw(`"job_postings"."id"`)),
        ),
      )
      .groupBy(jobPostings.payerId);
    return rows.flatMap((r) =>
      r.payerId === null || r.firstPublishedAt === null
        ? []
        : [{ payerId: r.payerId, firstPublishedAt: new Date(r.firstPublishedAt) }],
    );
  }

  /** Every countable worker's CURRENT profile row (`CURRENT_PROFILE_ORDER`, the funnel's rule). */
  private async currentProfiles(tx: Database): Promise<NumbersCurrentProfileRow[]> {
    const rows = await tx
      .selectDistinctOn([workerProfiles.workerId], {
        workerId: workerProfiles.workerId,
        status: workerProfiles.profileStatus,
        confirmedAt: workerProfiles.confirmedAt,
      })
      .from(workerProfiles)
      .innerJoin(workers, eq(workers.id, workerProfiles.workerId))
      .where(countableWorker)
      .orderBy(workerProfiles.workerId, ...CURRENT_PROFILE_ORDER);
    return rows.map((r) => ({
      workerId: r.workerId,
      status: r.status,
      confirmedAt: r.confirmedAt === null ? null : new Date(r.confirmedAt),
    }));
  }

  /**
   * The countable workers who may have been active in the 30 days ending on the week's Sunday,
   * each with the two terms of his last active day AS OF THE WEEK'S END: his newest
   * `worker_activity` day on or before the Sunday, and his newest device sighting before the
   * week's end. A worker is listed when either term falls in the window (exactly the workers
   * whose merged day can), and the metric re-checks with `lastActiveDayOf` itself.
   */
  private async activity(
    tx: Database,
    w: NumbersWeekWindow,
    hasActivityTable: boolean,
  ): Promise<NumbersActivityRow[]> {
    const fromDay = shiftDay(w.sunday, -(ACTIVE_WINDOW_DAYS - 1));
    const activeOn = hasActivityTable
      ? sql`(SELECT to_char(max(wa.active_on), 'YYYY-MM-DD') FROM worker_activity wa
              WHERE wa.worker_id = "workers"."id" AND wa.active_on <= ${w.sunday}::date)`
      : sql`NULL::text`;
    const activeInWindow = hasActivityTable
      ? sql`EXISTS (SELECT 1 FROM worker_activity wa WHERE wa.worker_id = "workers"."id"
              AND wa.active_on >= ${fromDay}::date AND wa.active_on <= ${w.sunday}::date)`
      : sql`FALSE`;
    const rows = (await tx.execute(sql`
      SELECT "workers"."id" AS worker_id,
             ${activeOn} AS active_on,
             (SELECT extract(epoch from max(wd.last_seen_at)) * 1000 FROM worker_devices wd
               WHERE wd.worker_id = "workers"."id" AND wd.last_seen_at < ${ts(w.toUtcExclusive)}
             )::float8 AS last_seen_ms
      FROM "workers"
      WHERE ${countableWorker}
        AND (
          ${activeInWindow}
          OR EXISTS (SELECT 1 FROM worker_devices wd WHERE wd.worker_id = "workers"."id"
                       AND wd.last_seen_at >= ${ts(istMidnightUtc(fromDay))}
                       AND wd.last_seen_at < ${ts(w.toUtcExclusive)})
        )
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      workerId: String(r.worker_id),
      activeOn: typeof r.active_on === "string" ? r.active_on : null,
      lastSeenAt: msOf(r.last_seen_ms),
    }));
  }

  /**
   * #2750 item 4 — the welcome lots of countable companies that RAN OUT by the week's end: the
   * moment the running sum of the lot's `unlock_debit` lines reached its size, and the first real
   * paid order (`payment_orders` paid; the mock route writes none) the company settled after it.
   * The lot and the order are both keyed by the tenant key.
   */
  private async welcomeRunOuts(
    tx: Database,
    w: NumbersWeekWindow,
  ): Promise<NumbersWelcomeRunOutRow[]> {
    const rows = (await tx.execute(sql`
      WITH spent AS (
        SELECT l.id AS lot_id, l.payer_id, l.credits_granted, d.created_at,
               sum(-d.delta) OVER (PARTITION BY l.id ORDER BY d.created_at, d.id) AS spent_so_far
        FROM credit_lots l
        JOIN credit_ledger d ON d.lot_id = l.id AND d.reason = 'unlock_debit'
        WHERE l.source = 'welcome' AND ${countablePayer(sql.raw(`"l"."payer_id"`))}
      ), ran_out AS (
        SELECT payer_id, min(created_at) AS ran_out_at
        FROM spent
        WHERE spent_so_far >= credits_granted
        GROUP BY lot_id, payer_id
      )
      SELECT r.payer_id,
             (extract(epoch from r.ran_out_at) * 1000)::float8 AS ran_out_ms,
             (SELECT extract(epoch from min(o.updated_at)) * 1000 FROM payment_orders o
               WHERE o.payer_id = r.payer_id AND o.status = 'paid'
                 AND o.updated_at > r.ran_out_at)::float8 AS paid_after_ms
      FROM ran_out r
      WHERE r.ran_out_at < ${ts(w.toUtcExclusive)}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.flatMap((r) => {
      const ranOutAt = msOf(r.ran_out_ms);
      return ranOutAt === null
        ? []
        : [{ payerId: String(r.payer_id), ranOutAt, firstPaidAfter: msOf(r.paid_after_ms) }];
    });
  }

  /**
   * #2750 items 7 and 8 — the couldn't-reach cases of countable companies reported or closed in the
   * week. `contact_reach_cases` (0185) is written only while the credit rules are on; with none, the
   * figures are real zeros.
   */
  private async reachCases(tx: Database, w: NumbersWeekWindow): Promise<NumbersReachCaseRow[]> {
    const rows = (await tx.execute(sql`
      SELECT c.payer_id,
             (extract(epoch from c.reported_at) * 1000)::float8 AS reported_ms,
             (extract(epoch from c.resolved_at) * 1000)::float8 AS resolved_ms,
             c.credits_returned
      FROM contact_reach_cases c
      WHERE ${countablePayer(sql.raw(`"c"."payer_id"`))}
        AND ((c.reported_at >= ${ts(w.fromUtc)} AND c.reported_at < ${ts(w.toUtcExclusive)})
          OR (c.resolved_at >= ${ts(w.fromUtc)} AND c.resolved_at < ${ts(w.toUtcExclusive)}))
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.flatMap((r) => {
      const reportedAt = msOf(r.reported_ms);
      return reportedAt === null
        ? []
        : [
            {
              payerId: String(r.payer_id),
              reportedAt,
              resolvedAt: msOf(r.resolved_ms),
              creditsReturned: Number(r.credits_returned ?? 0),
            },
          ];
    });
  }

  /**
   * #2750 item 5 — the opens a placement-team waiver paid for in the week: the ledger's `waived`
   * lines (one per open, zero credits moved) of countable companies.
   */
  private async waivedOpens(tx: Database, w: NumbersWeekWindow): Promise<NumbersWaivedOpenRow[]> {
    const rows = (await tx.execute(sql`
      SELECT d.payer_id, (extract(epoch from d.created_at) * 1000)::float8 AS at_ms
      FROM credit_ledger d
      WHERE d.reason = 'waived'
        AND d.created_at >= ${ts(w.fromUtc)} AND d.created_at < ${ts(w.toUtcExclusive)}
        AND ${countablePayer(sql.raw(`"d"."payer_id"`))}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.flatMap((r) => {
      const at = msOf(r.at_ms);
      return at === null ? [] : [{ payerId: String(r.payer_id), at }];
    });
  }

  /**
   * #2751 items 1 to 3 — the posting-button taps of countable companies recorded in the week
   * (`job_posting_choices`, migration 0187: one row per posting), sample postings left out. Written
   * only while the `posting_choice` switch is on for the company; with none, the shares are null.
   */
  private async postingChoices(
    tx: Database,
    w: NumbersWeekWindow,
  ): Promise<NumbersPostingChoiceRow[]> {
    const rows = (await tx.execute(sql`
      SELECT c.payer_id, c.choice, (extract(epoch from c.recorded_at) * 1000)::float8 AS at_ms
      FROM job_posting_choices c
      WHERE c.recorded_at >= ${ts(w.fromUtc)} AND c.recorded_at < ${ts(w.toUtcExclusive)}
        AND ${countablePayer(sql.raw(`"c"."payer_id"`))}
        AND ${excludeSamplePostings(sql.raw(`"c"."job_posting_id"`))}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.flatMap((r) => {
      const recordedAt = msOf(r.at_ms);
      const choice = r.choice === "free" || r.choice === "free_plus_pack" ? r.choice : null;
      return recordedAt === null || choice === null
        ? []
        : [{ payerId: String(r.payer_id), choice, recordedAt }];
    });
  }

  /** Confirmed hires of countable companies and workers, hired on or before the week's Sunday. */
  private async confirmedHires(tx: Database, w: NumbersWeekWindow): Promise<NumbersHireRow[]> {
    const rows = await tx
      .select({ payerId: hires.tenantPayerId, hiredOn: hires.hiredOn })
      .from(hires)
      .where(
        and(
          eq(hires.status, "confirmed"),
          isNotNull(hires.hiredOn),
          lte(hires.hiredOn, w.sunday),
          countablePayer(sql.raw(`"hires"."tenant_payer_id"`)),
          excludeTestAndSampleWorkerRefs(sql.raw(`"hires"."worker_id"`)),
        ),
      );
    return rows.flatMap((r) =>
      r.hiredOn === null ? [] : [{ payerId: r.payerId, hiredOn: r.hiredOn }],
    );
  }

  /** Contacts countable companies opened in the week (unlocks granted in it). */
  private async openedContacts(
    tx: Database,
    w: NumbersWeekWindow,
  ): Promise<NumbersOpenedContactRow[]> {
    const rows = await tx
      .select({ payerId: unlocks.payerId, grantedAt: unlocks.grantedAt })
      .from(unlocks)
      .where(
        and(
          inArray(unlocks.status, [...OPENED_UNLOCK_STATUSES]),
          gte(unlocks.grantedAt, w.fromUtc),
          lt(unlocks.grantedAt, w.toUtcExclusive),
          countablePayer(sql.raw(`"unlocks"."payer_id"`)),
          excludeTestAndSampleWorkerRefs(sql.raw(`"unlocks"."worker_id"`)),
          excludeImportedOpens(sql.raw(`"unlocks"."id"`)),
        ),
      );
    return rows.flatMap((r) =>
      r.grantedAt === null ? [] : [{ payerId: r.payerId, grantedAt: new Date(r.grantedAt) }],
    );
  }

  /**
   * The countable workers whose FIRST `profile.form_completed` fell in the week, and whether each
   * one's current profile is confirmed now. The spine read is `AdminEventsRepository`'s; the
   * exclusions and the profile status are read here, on the week's transaction.
   */
  private async formCompletions(
    tx: Database,
    w: NumbersWeekWindow,
  ): Promise<NumbersFormCompletionRow[]> {
    const first = await this.adminEvents.firstWorkerSubjectEventsBetween(
      FORM_COMPLETED_EVENT,
      w.fromUtc,
      w.toUtcExclusive,
    );
    if (first.length === 0) return [];
    const countable = new Set<string>();
    const confirmed = new Set<string>();
    for (const batch of batches(first.map((f) => f.workerId))) {
      const ids = await tx
        .select({ id: workers.id })
        .from(workers)
        .where(and(inArray(workers.id, batch), countableWorker));
      for (const r of ids) countable.add(r.id);
      const profiles = await tx
        .selectDistinctOn([workerProfiles.workerId], {
          workerId: workerProfiles.workerId,
          status: workerProfiles.profileStatus,
        })
        .from(workerProfiles)
        .where(inArray(workerProfiles.workerId, batch))
        .orderBy(workerProfiles.workerId, ...CURRENT_PROFILE_ORDER);
      for (const p of profiles)
        if (p.status === CONFIRMED_PROFILE_STATUS) confirmed.add(p.workerId);
    }
    return first
      .filter((f) => countable.has(f.workerId))
      .map((f) => ({
        workerId: f.workerId,
        firstCompletedAt: f.firstAt,
        profileConfirmed: confirmed.has(f.workerId),
      }));
  }

  /**
   * Where each company sits: the city and `role_kind` of its LATEST posting (by created_at, then
   * id), through part A's maps. A company with no posting is `unknown × unknown`.
   */
  private async companyDims(
    tx: Database,
    payerIds: readonly string[],
  ): Promise<Map<string, NumbersDims>> {
    const out = new Map<string, NumbersDims>();
    for (const batch of batches([...new Set(payerIds)])) {
      const rows = await tx
        .selectDistinctOn([jobPostings.payerId], {
          payerId: jobPostings.payerId,
          city: jobPostings.city,
          roleKind: jobPostings.roleKind,
        })
        .from(jobPostings)
        .where(inArray(jobPostings.payerId, batch))
        .orderBy(
          jobPostings.payerId,
          sql`${jobPostings.createdAt} desc`,
          sql`${jobPostings.id} desc`,
        );
      for (const r of rows) {
        if (r.payerId === null) continue;
        out.set(r.payerId, { city: cityGroupOf(r.city), trade: tradeGroupOf(r.roleKind) });
      }
    }
    return out;
  }

  /**
   * Where each worker sits: `workers.current_city` and his primary trade AS THE ONBOARDING FUNNEL
   * READS IT (`AdminFunnelRepository.primaryTradeByWorker`, reused on this transaction), through
   * part A's maps. No city or trade is `unknown`.
   */
  private async workerDims(
    tx: Database,
    workerIds: readonly string[],
  ): Promise<Map<string, NumbersDims>> {
    const ids = [...new Set(workerIds)];
    const out = new Map<string, NumbersDims>();
    if (ids.length === 0) return out;
    const trades = await new AdminFunnelRepository(tx).primaryTradeByWorker(ids);
    for (const batch of batches(ids)) {
      const rows = await tx
        .select({ id: workers.id, city: workers.currentCity })
        .from(workers)
        .where(inArray(workers.id, batch));
      for (const r of rows) {
        out.set(r.id, { city: cityGroupOf(r.city), trade: tradeGroupOf(trades.get(r.id)) });
      }
    }
    return out;
  }
}
