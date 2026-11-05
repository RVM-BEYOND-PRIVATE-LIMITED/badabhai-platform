import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { type Database, events } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** One task's recorded calls inside the window: total, and how many never reached a provider. */
export interface AiTaskFallbackRow {
  taskType: string;
  totalCalls: number;
  realCalls: number;
  fallbackCalls: number;
}

/** The latest fallback-alert verdict per task inside the window (`raised` or `cleared`). */
export interface AiFallbackAlertStateRow {
  taskType: string;
  eventName: "ai.fallback_alert_raised" | "ai.fallback_alert_cleared";
  occurredAt: Date;
}

/** One row of the admin "recent alerts" feed: a raised/cleared verdict or a spend-cap trip. */
export interface AiRecentAlertRow {
  id: string;
  eventName: string;
  occurredAt: Date;
  taskType: string | null;
  reason: string | null;
}

/** Spend-cap trips inside the window: the count, and the latest row (the email watermark). */
export interface AiSpendCapStats {
  count: number;
  latestId: string | null;
  latestAt: Date | null;
}

/**
 * SELECT-ONLY reads over the `events` spine for the B13 loud-AI-alert feature (#2567).
 *
 * WHY HERE AND NOT ON `AdminEventsRepository`. That class is the ONE admin reader of the
 * spine by build-blocker (`admin-static-guards.test.ts` — exactly one non-test file under
 * admin/** may contain `.from(events)`), and this feature is not admin-only: the
 * UNAUTHENTICATED `GET /health` per-task breakdown and the `AiCostRecorder`-driven
 * evaluation both need the same aggregates. Keeping them here (outside admin/**) leaves
 * the single-reader invariant untouched, and the admin endpoint consumes the
 * `AiAlertsService` that composes this repository — the same split the dashboard's
 * `AdminDashboardService` (composition) / `AdminEventsRepository` (spine access) makes.
 *
 * SELECT-ONLY, like its admin sibling: no `insert`/`update`/`delete` against `events`
 * here, ever. The only writer stays `EventsRepository` (via `EventsService.emit`).
 *
 * FALLBACK MEANS `real_call=false` ON `ai.cost_recorded`. A missing/invalid `real_call`
 * counts as fallback rather than aborting the page — the same rule
 * `AdminEventsRepository.profilingCostSplit` documents: a row that cannot prove it went
 * real must not read as real. (A total transport failure emits NO cost row at all, so
 * this share understates fallback while that gap is open — see the payload header.)
 */
@Injectable()
export class AiAlertsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Per-task recorded calls inside the window.
   *
   * ONE grouped statement over `event_name = 'ai.cost_recorded'` (uses
   * `events_event_name_idx`) bounded by `occurred_at` (uses `events_occurred_at_idx`).
   * The jsonb reads apply to the rows those indexes narrow — no new index needed.
   */
  async taskFallbackSplit(since: Date): Promise<AiTaskFallbackRow[]> {
    const taskType = sql<string>`${events.payload}->>'task_type'`;
    const isReal = sql`(${events.payload}->>'real_call') = 'true'`;
    const rows = await this.db
      .select({
        taskType,
        totalCalls: sql<number>`count(*)::int`,
        realCalls: sql<number>`count(*) filter (where ${isReal})::int`,
      })
      .from(events)
      .where(and(eq(events.eventName, "ai.cost_recorded"), gte(events.occurredAt, since)))
      .groupBy(taskType)
      .orderBy(taskType);
    return rows.map((r) => ({
      taskType: r.taskType ?? "unknown",
      totalCalls: Number(r.totalCalls),
      realCalls: Number(r.realCalls),
      // Derived, never a second count: fallback is exactly "not provably real".
      fallbackCalls: Number(r.totalCalls) - Number(r.realCalls),
    }));
  }

  /**
   * The latest fallback verdict per task inside the window.
   *
   * Rows arrive ordered (task, newest first) and JS keeps the first per task — the table
   * is small per window (one raised/cleared pair per breach), so no DISTINCT ON needed.
   */
  async latestFallbackAlertPerTask(since: Date): Promise<AiFallbackAlertStateRow[]> {
    const taskType = sql<string>`${events.payload}->>'task_type'`;
    const rows = await this.db
      .select({
        taskType,
        eventName: events.eventName,
        occurredAt: events.occurredAt,
      })
      .from(events)
      .where(
        and(
          inArray(events.eventName, ["ai.fallback_alert_raised", "ai.fallback_alert_cleared"]),
          gte(events.occurredAt, since),
        ),
      )
      .orderBy(taskType, desc(events.occurredAt), desc(events.id));
    const latest = new Map<string, AiFallbackAlertStateRow>();
    for (const r of rows) {
      const task = r.taskType ?? "unknown";
      if (latest.has(task)) continue;
      if (
        r.eventName !== "ai.fallback_alert_raised" &&
        r.eventName !== "ai.fallback_alert_cleared"
      ) {
        continue;
      }
      latest.set(task, { taskType: task, eventName: r.eventName, occurredAt: r.occurredAt });
    }
    return [...latest.values()];
  }

  /** Spend-cap trips inside the window: the count plus the latest row (the email watermark). */
  async spendCapStats(since: Date): Promise<AiSpendCapStats> {
    const [agg] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        latestAt: sql<Date | null>`max(${events.occurredAt})`,
      })
      .from(events)
      .where(and(eq(events.eventName, "ai.spend_cap_exceeded"), gte(events.occurredAt, since)));
    const [latest] = await this.db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.eventName, "ai.spend_cap_exceeded"), gte(events.occurredAt, since)))
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(1);
    return {
      count: Number(agg?.count ?? 0),
      latestId: latest?.id ?? null,
      latestAt: agg?.latestAt ?? null,
    };
  }

  /**
   * The recent-alerts feed: raised/cleared verdicts plus spend-cap trips, newest first.
   * Bounded by `limit` — the caller passes an already-capped value.
   */
  async recentAlerts(since: Date, limit: number): Promise<AiRecentAlertRow[]> {
    const rows = await this.db
      .select({
        id: events.id,
        eventName: events.eventName,
        occurredAt: events.occurredAt,
        taskType: sql<string | null>`${events.payload}->>'task_type'`,
        reason: sql<string | null>`${events.payload}->>'reason'`,
      })
      .from(events)
      .where(
        and(
          inArray(events.eventName, [
            "ai.fallback_alert_raised",
            "ai.fallback_alert_cleared",
            "ai.spend_cap_exceeded",
          ]),
          gte(events.occurredAt, since),
        ),
      )
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      eventName: r.eventName,
      occurredAt: r.occurredAt,
      taskType: r.taskType,
      reason: r.reason,
    }));
  }
}
