import { Inject, Injectable } from "@nestjs/common";
import { count, inArray, isNotNull, sql } from "drizzle-orm";
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
 *     a plausible future problem.
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
