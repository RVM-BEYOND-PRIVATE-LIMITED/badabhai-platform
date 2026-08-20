import { Inject, Injectable } from "@nestjs/common";
import { and, count, gte, inArray, isNotNull, sql } from "drizzle-orm";
import {
  CURRENT_PROFILE_ORDER,
  applications,
  generatedResumes,
  jobPostings,
  payers,
  platformAiCostTotals,
  unlocks,
  workerProfiles,
  workers,
  type Database,
} from "@badabhai/db";
import type { ProfileStatus } from "@badabhai/types";
import { DATABASE } from "../database/database.module";
import type { AdminProviderCostBucket, AdminTaskCostBucket } from "./admin-dashboard.dto";

/** The all-time platform spend roll-up. `since` is null when nothing has ever accrued. */
export interface AdminPlatformCostTotals {
  /** Exact decimal ₹ (`numeric`), summed in Postgres. Never a float — see the DTO header. */
  totalCostInr: string;
  totalCalls: number;
  realCalls: number;
  /** `min(first_recorded_at)` — the date every figure above is "since". */
  since: Date | null;
}

/**
 * The PROFILING slice of platform spend — the numerator of the cost-per-profile figure.
 *
 * SHAPED LIKE {@link AdminPlatformCostTotals}, `since` INCLUDED, AND THAT FIELD IS THE WHOLE
 * POINT. An earlier version of this interface omitted it, on the reasoning that the subtotal
 * covers "the same rows over the same window". IT DOES NOT. `platform_ai_cost_totals` is keyed
 * on `(provider, task_type)` and every row carries its OWN `first_recorded_at`, so the window a
 * FILTERED sum actually covers starts at the first accrual OF THAT FILTER — which is later than
 * the table-wide minimum whenever a non-profiling task type accrued first. `skill_embedding`
 * and `job_posting_chat_turn` are payer-side and have no worker in them at all, so "the first
 * money the platform ever spent was not spent on a profile" is an ordinary state, not an exotic
 * one.
 *
 * MEASURED, NOT ARGUED. Against the local verification database: a `job_posting_chat_turn` row
 * at 2020-01-01 and a `profiling_chat_turn` row at 2026-08-19, with one profile completed in
 * 2021, produced a denominator of 22 against a numerator that covered exactly 1 of them — a
 * reported ₹0.454545 where the truth was ₹10.000000, a 22× understatement with nothing on the
 * page indicating it. The count must be bounded by THIS `since`, never by the table-wide one.
 */
export interface AdminProfilingCostSubtotal {
  /** Exact decimal ₹ (`numeric`), summed in Postgres over the allowed task types only. */
  totalCostInr: string;
  callCount: number;
  realCallCount: number;
  /**
   * `min(first_recorded_at)` over the ALLOWED TASK TYPES ONLY — the instant this numerator's
   * coverage actually begins, and therefore the lower bound its denominator must use.
   *
   * NULL means no profiling task type has ever accrued: there is no window, so there is no
   * ratio, and the whole block is absent rather than ₹0.00 over a real profile count. It is
   * never coalesced, for the reason `platformCostTotals().since` is never coalesced.
   */
  since: Date | null;
}

/** A `(key, count)` pair from a GROUP BY over an enum column. */
export interface AdminKeyCount {
  key: string;
  count: number;
}

/**
 * SELECT-ONLY data access for the admin DASHBOARD summary (BP-5).
 *
 * ── ITS OWN READ PATH TO THE COST TOTALS, NOT THE WRITER'S ──────────────────────────────
 * `AiCostTotalsRepository` (apps/api/src/ai) owns the three running-total tables and is
 * deliberately NOT exported from `AiModule`: one writer is the guarantee that spend only ever
 * moves through `AiCostRecorder`, bound to an `ai.cost_recorded` row. Reusing it here — or
 * exporting it so this module could — would put a class with an `accrue()` method into the
 * admin injector, and the next person to need "adjust a total" would find it already wired.
 * This repository reads the same table through a separate, write-free class instead. It has no
 * insert/update/delete method and must never gain one.
 *
 * ── `platform_ai_cost_totals` IS THE ONLY TABLE THE PLATFORM FIGURE MAY COME FROM ───────
 * Not `worker_ai_cost_totals`, which the schema header calls out by name: `skill_embedding` on
 * a job-posting write and `job_posting_chat_turn` are PAYER-side calls with no worker at all,
 * so a total summed from worker rows silently omits them and still reads as complete. That is
 * the exact failure the three-table split exists to prevent, and
 * `admin-dashboard.repository.test.ts` pins the FROM clause against it.
 *
 * ── SEQUENTIAL SCANS, KNOWINGLY, AND WHICH ONES ─────────────────────────────────────────
 * The volume counts are UNFILTERED aggregates: `count(*)` and `GROUP BY <enum>` over whole
 * tables. Postgres cannot do better than a full scan for those (a btree on a 3-value status
 * column is not selective enough to beat one, and the planner will ignore it), so NO INDEX IS
 * ADDED — an index here would be pure write-path cost for a read that is not helped by it.
 * Assessed per table at today's scale:
 *   - `workers`, `payers`, `job_postings`, `generated_resumes`, `unlocks` — small (thousands),
 *     a scan is milliseconds.
 *   - `worker_profiles` — one row per EXTRACTION, so it grows faster than workers do; the
 *     `DISTINCT ON` below sorts it. Still small today, and it is the only aggregate here with
 *     a plausible future problem. It is read TWICE (once by status, once filtered to the
 *     accrual window), and the second read is not helped by an index either: its predicates
 *     apply to the OUTPUT of the `DISTINCT ON`, i.e. after the sort an index would be there to
 *     avoid. See `countCurrentProfilesCompletedSince`.
 *   - `applications` — the largest of them, and the one to watch. Both counts are covered by
 *     nothing; if this becomes the page's latency floor, the fix is a cached/materialized
 *     roll-up on a schedule, not an index.
 * The AI-cost aggregates are the opposite: `platform_ai_cost_totals` is ~4 providers x ~9 task
 * types = a few dozen rows by construction, which is the entire point of materializing it.
 */
@Injectable()
export class AdminDashboardRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  // ---- AI cost (migration 0077's platform running totals) ------------------

  /**
   * Platform-wide spend, calls, and the accrual start date — one row, one scan of a few dozen.
   *
   * SUMMED IN POSTGRES, RETURNED AS A STRING. `sum(numeric)` is exact and associative; adding
   * the same rows up in JavaScript would reintroduce the float drift `numeric(16,6)` was chosen
   * to avoid. `::text` pins the serialization so the driver cannot hand back a `number`.
   */
  async platformCostTotals(): Promise<AdminPlatformCostTotals> {
    const rows = await this.db
      .select({
        // `coalesce` on the OUTER sum only: an empty table yields NULL, and "₹0.000000" is the
        // honest rendering of "nothing has been spent" once `since` says nothing has accrued.
        totalCostInr: sql<string>`coalesce(sum(${platformAiCostTotals.totalCostInr}), 0)::text`,
        totalCalls: sql<number>`coalesce(sum(${platformAiCostTotals.callCount}), 0)::int`,
        realCalls: sql<number>`coalesce(sum(${platformAiCostTotals.realCallCount}), 0)::int`,
        // NOT coalesced: NULL here MEANS "nothing has ever accrued", and substituting a date
        // would invent an accrual start that never happened.
        since: sql<Date | null>`min(${platformAiCostTotals.firstRecordedAt})`,
      })
      .from(platformAiCostTotals);

    const r = rows[0];
    return {
      totalCostInr: r?.totalCostInr ?? "0",
      totalCalls: Number(r?.totalCalls ?? 0),
      realCalls: Number(r?.realCalls ?? 0),
      since: r?.since ? new Date(r.since) : null,
    };
  }

  /** Spend split by the raw stored provider label — the PK's first half. */
  async costByProvider(): Promise<AdminProviderCostBucket[]> {
    const rows = await this.db
      .select({
        provider: platformAiCostTotals.provider,
        totalCostInr: sql<string>`sum(${platformAiCostTotals.totalCostInr})::text`,
        callCount: sql<number>`sum(${platformAiCostTotals.callCount})::int`,
        realCallCount: sql<number>`sum(${platformAiCostTotals.realCallCount})::int`,
        firstRecordedAt: sql<Date>`min(${platformAiCostTotals.firstRecordedAt})`,
      })
      .from(platformAiCostTotals)
      .groupBy(platformAiCostTotals.provider)
      // Biggest spender first — the ordering the screen reads in. `provider` breaks the tie so
      // two providers at the same spend do not swap places between two identical requests.
      .orderBy(sql`sum(${platformAiCostTotals.totalCostInr}) desc`, platformAiCostTotals.provider);

    return rows.map((r) => ({
      provider: r.provider,
      total_cost_inr: r.totalCostInr,
      call_count: Number(r.callCount),
      real_call_count: Number(r.realCallCount),
      first_recorded_at: new Date(r.firstRecordedAt),
    }));
  }

  /** Spend split by task type — the PK's second half, free of a second table. */
  async costByTaskType(): Promise<AdminTaskCostBucket[]> {
    const rows = await this.db
      .select({
        taskType: platformAiCostTotals.taskType,
        totalCostInr: sql<string>`sum(${platformAiCostTotals.totalCostInr})::text`,
        callCount: sql<number>`sum(${platformAiCostTotals.callCount})::int`,
        realCallCount: sql<number>`sum(${platformAiCostTotals.realCallCount})::int`,
      })
      .from(platformAiCostTotals)
      .groupBy(platformAiCostTotals.taskType)
      .orderBy(sql`sum(${platformAiCostTotals.totalCostInr}) desc`, platformAiCostTotals.taskType);

    return rows.map((r) => ({
      task_type: r.taskType,
      total_cost_inr: r.totalCostInr,
      call_count: Number(r.callCount),
      real_call_count: Number(r.realCallCount),
    }));
  }

  /**
   * The same table, restricted to the task types that PRODUCE A PROFILE — the numerator of the
   * cost-per-profile figure.
   *
   * SUMMED IN POSTGRES, FOR THE REASON THE SIBLING ABOVE STATES AND NOT MERELY BY IMITATION.
   * The buckets `costByTaskType()` already returns could be added up in JavaScript instead, and
   * that is exactly the arithmetic `numeric(16,6)` exists to keep out of IEEE-754: summing three
   * exact decimal strings as floats is neither associative nor exact, and the drift lands on a
   * line labelled "cost per profile". One `sum()` over `numeric` inside Postgres is both.
   * `::text` pins the serialization so the driver cannot hand back a `number` on the way out.
   *
   * AN ALLOWLIST, NEVER A DENYLIST. `task_type` is a plain `text` column that also holds the
   * literal `'unknown'` for an unlabelled call, so `NOT IN ('resume_generation', ...)` would
   * sweep every unclassified value into the profiling numerator the day one appears. `IN (...)`
   * excludes it instead: the average understates, which is recoverable from `by_task_type`,
   * rather than silently over-attributing, which is not. The set itself is a decision the
   * SERVICE owns (`PROFILING_TASK_TYPES`) and is passed in — this method holds no policy about
   * which spend is profiling spend, and must not grow one.
   *
   * THE BOUND COMES BACK WITH THE MONEY, IN ONE AGGREGATE. `min(first_recorded_at)` is computed
   * over the SAME filtered row set in the SAME statement as the sum, which is what makes them
   * structurally incapable of describing different periods — see {@link
   * AdminProfilingCostSubtotal.since}. Reading the bound separately would reintroduce exactly
   * the defect this field exists to close, one round trip further along.
   */
  async profilingCostSubtotal(taskTypes: readonly string[]): Promise<AdminProfilingCostSubtotal> {
    const rows = await this.db
      .select({
        // `coalesce` for the same reason as the sibling: no matching row is "nothing was spent
        // on profiling", which is ₹0 — not an absent figure.
        totalCostInr: sql<string>`coalesce(sum(${platformAiCostTotals.totalCostInr}), 0)::text`,
        callCount: sql<number>`coalesce(sum(${platformAiCostTotals.callCount}), 0)::int`,
        realCallCount: sql<number>`coalesce(sum(${platformAiCostTotals.realCallCount}), 0)::int`,
        // NOT coalesced, and it is the field that decides whether the block renders at all:
        // NULL means no profiling row has ever accrued, so there is no window and no ratio.
        since: sql<Date | null>`min(${platformAiCostTotals.firstRecordedAt})`,
      })
      .from(platformAiCostTotals)
      .where(inArray(platformAiCostTotals.taskType, [...taskTypes]));

    const r = rows[0];
    return {
      totalCostInr: r?.totalCostInr ?? "0",
      callCount: Number(r?.callCount ?? 0),
      realCallCount: Number(r?.realCallCount ?? 0),
      since: r?.since ? new Date(r.since) : null,
    };
  }

  // ---- volume --------------------------------------------------------------

  async countWorkersByStatus(): Promise<AdminKeyCount[]> {
    const rows = await this.db
      .select({ key: workers.status, count: count() })
      .from(workers)
      .groupBy(workers.status);
    return rows.map((r) => ({ key: r.key, count: r.count }));
  }

  /** Workers with a DPDP erasure scheduled but not yet executed. */
  async countWorkersPendingDeletion(): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(workers)
      .where(isNotNull(workers.deletionScheduledAt));
    return rows[0]?.n ?? 0;
  }

  /**
   * Profile progress, ONE ROW PER WORKER.
   *
   * `DISTINCT ON (worker_id)` ordered by `CURRENT_PROFILE_ORDER`, exactly as
   * `ReachRepository.listSignalRows` does — so the status this dashboard counts a worker under
   * is the status that worker's own `GET /workers/me/profile` reports. `worker_profiles` gets a
   * row per extraction job and nothing constrains a worker to one, so a plain
   * `GROUP BY profile_status` over the raw table counts every re-interviewed worker twice AND
   * counts the empty placeholder row an ai-service outage wrote as if it were a real profile.
   * Postgres requires the `DISTINCT ON` expression to lead the `ORDER BY`; the ranking tail
   * follows it.
   */
  async countCurrentProfilesByStatus(): Promise<AdminKeyCount[]> {
    const current = this.db
      .selectDistinctOn([workerProfiles.workerId], {
        workerId: workerProfiles.workerId,
        profileStatus: workerProfiles.profileStatus,
      })
      .from(workerProfiles)
      .orderBy(workerProfiles.workerId, ...CURRENT_PROFILE_ORDER)
      .as("current_profile");

    const rows = await this.db
      .select({ key: current.profileStatus, count: count() })
      .from(current)
      .groupBy(current.profileStatus);
    return rows.map((r) => ({ key: r.key, count: r.count }));
  }

  /**
   * WORKERS WHOSE CURRENT PROFILE WAS PRODUCED AT OR AFTER `since` — the denominator of the
   * cost-per-profile figure.
   *
   * ── `since` IS A PARAMETER, AND IT IS THE *NUMERATOR'S* BOUND ───────────────────────────
   * It is {@link AdminProfilingCostSubtotal.since} — `min(first_recorded_at)` over the PROFILING
   * task types — and not the table-wide `accruing_since` the section renders "Since …" from.
   * Those two are different instants whenever a non-profiling task type accrued first, and
   * bounding this count by the table-wide one counts profiles from a period the numerator has no
   * spend for. That is the same "two halves, different periods" defect as computing a second
   * bound here, arrived at from the opposite direction: measured at 22× on the local
   * verification database, and invisible on screen either way.
   *
   * NOR IS IT DERIVED INSIDE THIS METHOD. A correlated
   * `(select min(first_recorded_at) from platform_ai_cost_totals where task_type = any($1))`
   * would be tidier and one round trip cheaper, and it would be a SECOND evaluation of the bound:
   * the two reads are not in one transaction, so an accrual landing between them would give the
   * count a lower bound the response never reports. The service reads the bound once, off the
   * same aggregate that produced the numerator, and hands it to both.
   *
   * ── ONE ROW PER WORKER, THROUGH THE SHARED ORDERING ─────────────────────────────────────
   * `DISTINCT ON (worker_id)` ordered by `CURRENT_PROFILE_ORDER`, exactly as
   * `countCurrentProfilesByStatus` above. `worker_profiles` holds a row per EXTRACTION and
   * nothing constrains a worker to one, so a plain count double-counts every re-interviewed
   * worker and counts the empty placeholder row an ai-service outage wrote. There is exactly ONE
   * definition of "this worker's profile" (packages/db/src/current-profile.ts); this is not a
   * second one, and the status set is passed in rather than decided here.
   *
   * ── THE DATE FILTER IS ON THE RESOLVED ROW, NOT ON THE ROWS BEING RESOLVED ──────────────
   * Both predicates sit OUTSIDE the `DISTINCT ON`. Filtering first would change WHICH row is
   * called this worker's current profile: a worker profiled before the bound whose only
   * in-window row is an outage placeholder would have that placeholder promoted to it — a
   * window-scoped second notion of the very thing `CURRENT_PROFILE_ORDER` exists to make
   * singular.
   *
   * MEASURED, AND THE MEASUREMENT CORRECTED THE CLAIM: with today's completed set the two
   * placements return THE SAME COUNT, and moving the filter inside passed every database test
   * in `admin-dashboard.db.test.ts`. The equivalence is provable rather than lucky.
   * `PROFILE_COMPLETED_STATUSES` is a subset of the non-draft statuses, and the shared ordering
   * ranks content first and recency second — so an in-window row that is non-draft can never be
   * outranked by an out-of-window row (that row would have to be BOTH non-draft AND newer, and
   * everything out of the window is older by definition). Whenever the pre-filtered form
   * resolves to a completed row, the unfiltered form resolves to the same row.
   *
   * IT IS STILL WRITTEN THIS WAY, because the equivalence is a coincidence of two facts that
   * can each change independently: that `extracting` is excluded from the completed set, and
   * that content outranks recency. Add an in-flight status to the completed set — or reorder
   * `CURRENT_PROFILE_ORDER`, whose own header calls that a live product question — and the
   * pre-filtered form starts counting rows that produced nothing, while this form does not. The
   * shape test in `admin-dashboard.repository.test.ts` pins the placement for that reason; the
   * database test can only pin the outcome, because today the outcomes agree.
   *
   * ── NO INDEX SUPPORTS THIS, AND NONE IS ADDED ───────────────────────────────────────────
   * `worker_profiles` carries five indexes — the `id` primary key, `worker_id`, a unique
   * `ai_job_id`, the HNSW vector index and `job_domain_id` — and none on `created_at` or
   * `profile_status` (read from `pg_indexes`; every `CREATE INDEX … worker_profiles` in
   * packages/db/migrations agrees, the pkey being the one `CREATE TABLE` declares rather than
   * a `CREATE INDEX`). The pkey is named because `id` is the last tiebreak term of
   * `CURRENT_PROFILE_ORDER`, so it is the one of the five that could plausibly be thought to
   * serve the sort below — it does not; a leading `worker_id` is what that sort needs.
   * ADDING ONE WOULD NOT HELP, and that is structural rather than a fact about today's size.
   * MEASURED, not reasoned — `EXPLAIN` on the local verification database (`bb_verify`,
   * 25 `worker_profiles` rows) returns:
   *
   *     Aggregate
   *       -> Subquery Scan on current_profile
   *            Filter: created_at >= $1 AND profile_status = ANY ('{extracted,confirmed}')
   *            -> Unique
   *                 -> Sort  (worker_id, (profile_status <> 'draft') DESC, created_at DESC, id DESC)
   *                      -> Seq Scan on worker_profiles
   *
   * The Filter sits ABOVE the `Unique`, which is where it has to stay: pushing either predicate
   * below the `DISTINCT ON` would change which row per worker survives, so Postgres will not do
   * it and neither may we. An index on `created_at` or `profile_status` would therefore be asked
   * to serve a filter that runs after the very scan it exists to avoid. That plan SHAPE does not
   * change with row count; only its cost does. NO PRODUCTION SIZE WAS MEASURED — this session
   * has no production access — so no latency claim is made beyond the plan itself. The file
   * header already names the escape hatch if this ever becomes the page's floor: a scheduled
   * roll-up, not an index.
   */
  async countCurrentProfilesCompletedSince(
    since: Date,
    completedStatuses: readonly ProfileStatus[],
  ): Promise<number> {
    const current = this.db
      .selectDistinctOn([workerProfiles.workerId], {
        workerId: workerProfiles.workerId,
        profileStatus: workerProfiles.profileStatus,
        createdAt: workerProfiles.createdAt,
      })
      .from(workerProfiles)
      .orderBy(workerProfiles.workerId, ...CURRENT_PROFILE_ORDER)
      .as("current_profile");

    const rows = await this.db
      .select({ n: count() })
      .from(current)
      .where(
        and(
          // `>=`, not `>`: `since` IS an accrual instant that happened, so a profile written in
          // the same instant belongs inside the window the spend covers, not outside it.
          gte(current.createdAt, since),
          inArray(current.profileStatus, [...completedStatuses]),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  async countJobPostingsByStatus(): Promise<AdminKeyCount[]> {
    const rows = await this.db
      .select({ key: jobPostings.status, count: count() })
      .from(jobPostings)
      .groupBy(jobPostings.status);
    return rows.map((r) => ({ key: r.key, count: r.count }));
  }

  /**
   * Applications: every decision row, and the `applied` subset.
   *
   * TWO NUMBERS FROM ONE SCAN. `count(*) FILTER (WHERE action = 'applied')` gets both in a
   * single pass; two separate `count()` queries would scan the largest table in this file
   * twice for an answer one scan already has. A skip is NOT an application — reporting the
   * table's row count as "applications" would inflate the platform's headline growth metric
   * with every job a worker swiped past.
   */
  async applicationCounts(): Promise<{ total: number; applied: number }> {
    const rows = await this.db
      .select({
        total: count(),
        applied: sql<number>`count(*) filter (where ${applications.action} = 'applied')::int`,
      })
      .from(applications);
    return { total: rows[0]?.total ?? 0, applied: Number(rows[0]?.applied ?? 0) };
  }

  async countPayersByRole(): Promise<AdminKeyCount[]> {
    const rows = await this.db
      .select({ key: payers.role, count: count() })
      .from(payers)
      .groupBy(payers.role);
    return rows.map((r) => ({ key: r.key, count: r.count }));
  }

  async countPayersByStatus(): Promise<AdminKeyCount[]> {
    const rows = await this.db
      .select({ key: payers.status, count: count() })
      .from(payers)
      .groupBy(payers.status);
    return rows.map((r) => ({ key: r.key, count: r.count }));
  }

  /**
   * Contact unlocks that were actually ISSUED.
   *
   * `('granted', 'revealed')`, not `count(*)` and not `= 'granted'`. An unlock is written
   * `granted` and moves to `revealed` the moment the payer looks at the contact
   * (`UnlocksRepository`), so filtering on `granted` alone reports a number that goes DOWN as
   * payers use what they bought. `denied` is excluded because nothing was issued and nothing was
   * charged. (`requested` / `expired` are declared on `UnlockStatus` but no code path writes
   * either on this table today — listing the two positive states keeps this correct if one
   * starts being written, where a `<> 'denied'` predicate would silently absorb it.)
   */
  async countUnlocksIssued(): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(unlocks)
      .where(inArray(unlocks.status, ["granted", "revealed"]));
    return rows[0]?.n ?? 0;
  }

  async countGeneratedResumes(): Promise<number> {
    const rows = await this.db.select({ n: count() }).from(generatedResumes);
    return rows[0]?.n ?? 0;
  }
}
