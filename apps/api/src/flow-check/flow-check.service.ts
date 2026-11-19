import { Inject, Injectable, Logger } from "@nestjs/common";
import type { FlowCheckThresholds, ServerConfig } from "@badabhai/config";
import {
  FlowCheckCampusReportReceivedPayload,
  FlowCheckDayRecordedPayload,
  FlowCheckSyntheticRunRecordedPayload,
  FLOW_CHECK_NAMES,
  type FlowCheckName,
} from "@badabhai/event-schema";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { AdminEventsRepository } from "../admin/admin-events.repository";
import {
  FlowCheckRepository,
  type FlowCounts,
  type FlowCountWindow,
  type FlowSampleIds,
} from "./flow-check.repository";

/** The per-day counts cover the 24 hours before the run. */
export const FLOW_CHECK_WINDOW_HOURS = 24;
/** The admin read shows at most this many days. */
export const FLOW_CHECK_MAX_DAYS = 14;

const HOUR_MS = 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;

/** The IST calendar day `YYYY-MM-DD` that `now` falls in: one record and one alert per such day. */
export function flowCheckDay(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The window every count is read against, from the run's time and the thresholds. */
export function flowCountWindow(now: Date, t: FlowCheckThresholds): FlowCountWindow {
  const ago = (hours: number) => new Date(now.getTime() - hours * HOUR_MS);
  return {
    now,
    since: ago(FLOW_CHECK_WINDOW_HOURS),
    reviewCutoff: ago(t.review_wait_hours),
    reachCutoff: ago(t.zero_reach_grace_hours),
    untouchedFrom: ago(t.untouched_hours + FLOW_CHECK_WINDOW_HOURS),
    untouchedTo: ago(t.untouched_hours),
  };
}

/** What Campus last reported, reduced to the two counts the flow check thresholds. */
export interface CampusReportCounts {
  /** Campus's own clock: when its check ran. */
  readonly checkedAt: string;
  readonly outboxUndelivered: number;
  /** `missing_on_badabhai` + `not_sent`: Campus application ids with no BadaBhai row. */
  readonly idsMissing: number;
  readonly dispatcherOn: boolean;
}

/** At most this many synthetic runs in the admin read (one a day, plus run-nows). */
export const FLOW_SYNTHETIC_MAX_RUNS = 50;

/** One synthetic run, as the admin read shows it. */
export type FlowSyntheticRunRow = FlowCheckSyntheticRunRecordedPayload & {
  /** When BadaBhai recorded it. */
  readonly recorded_at: string;
};

/** One day's record, as the admin read shows it. */
export type FlowCheckDay = FlowCheckDayRecordedPayload & {
  /** When BadaBhai recorded it. */
  readonly recorded_at: string;
};

/** The checks that breached, in {@link FLOW_CHECK_NAMES} order. Pure. */
export function breachedChecks(
  counts: FlowCounts,
  campus: CampusReportCounts | null,
  campusLinkOn: boolean,
  t: FlowCheckThresholds,
): FlowCheckName[] {
  const over = (count: number | null, max: number | null) =>
    count !== null && max !== null && count > max;
  const hit: Record<FlowCheckName, boolean> = {
    rvm_review_overdue: over(counts.rvmReviewOverdue, t.review_overdue_max),
    live_zero_reach: over(counts.liveZeroReach, t.zero_reach_max),
    campus_unlinked: over(counts.campusUnlinked, t.campus_unlinked_max),
    applications_untouched: over(counts.applicationsUntouched, t.untouched_max),
    campus_outbox_undelivered: over(campus?.outboxUndelivered ?? null, t.outbox_undelivered_max),
    campus_ids_missing: over(campus?.idsMissing ?? null, t.campus_missing_max),
    // The report is needed only while one of its two counts can alert: with both maxima `off`
    // (say, the link is on before Campus sends reports) its absence is not a breach either.
    campus_report_missing:
      campusLinkOn &&
      campus === null &&
      (t.outbox_undelivered_max !== null || t.campus_missing_max !== null),
  };
  return FLOW_CHECK_NAMES.filter((name) => hit[name]);
}

/** What one tick did. Counts only (BullMQ job-inspection surface). */
export type FlowCheckResult =
  | { readonly armed: false }
  | {
      readonly armed: true;
      readonly day: string;
      readonly breached: readonly FlowCheckName[];
      /** True when this run wrote the day's record (false when a tick already did today). */
      readonly recorded: boolean;
      /** True when this run wrote the day's alert. */
      readonly alerted: boolean;
    };

/**
 * #2890 — THE DAILY FLOW CHECK: is any step of posting → reach → application broken today?
 *
 * One tick reads BadaBhai's tables in one read-only snapshot ({@link FlowCheckRepository}) and the
 * latest report Campus sent (`PUT applications-check`, read back from the spine), then:
 *  - records ONE `flow_check.day_recorded` per IST day, keyed on the day, whatever breached: the
 *    admin's 14-day read is these records;
 *  - when a count passes its threshold (`FLOW_CHECK_THRESHOLDS`), emits ONE `flow_check.breached`
 *    per IST day (counts only), which the admin dashboard's breach counter shows, and logs one
 *    error line with a few ids behind each BadaBhai count, for whoever investigates.
 *
 * WHAT ONLY CAMPUS CAN SEE. BadaBhai cannot read Campus's outbox or its application table, so those
 * two counts come from Campus's own nightly check (#155 item 13), reported here. While the Campus
 * link is on, a report older than `campus_report_max_age_hours` is itself a breach
 * (`campus_report_missing`): a Campus that stopped checking, or cannot reach BadaBhai at all, is
 * the failure the issue's "stop the dispatcher" test is about. With the link off the Campus counts
 * are null and never breach.
 *
 * IT NEVER WRITES A ROW, only the two events. OFF BY DEFAULT (`FLOW_CHECK_ENABLED`): a tick returns
 * at once without a query.
 */
@Injectable()
export class FlowCheckService {
  private readonly logger = new Logger(FlowCheckService.name);

  constructor(
    private readonly repo: FlowCheckRepository,
    private readonly spine: AdminEventsRepository,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** `FLOW_CHECK_ENABLED`: the one read of the switch. */
  enabled(): boolean {
    return this.config.FLOW_CHECK_ENABLED === true;
  }

  thresholds(): FlowCheckThresholds {
    return this.config.FLOW_CHECK_THRESHOLDS;
  }

  async run(now: Date): Promise<FlowCheckResult> {
    if (!this.enabled()) return { armed: false };

    const t = this.thresholds();
    const window = flowCountWindow(now, t);
    const counts = await this.repo.readCounts(window);
    const campusLinkOn = this.config.CAMPUS_LINK_ENABLED === true;
    const campus = campusLinkOn ? await this.latestCampusReport(now, t) : null;
    const breached = breachedChecks(counts, campus, campusLinkOn, t);
    const day = flowCheckDay(now);
    const payload: FlowCheckDayRecordedPayload = {
      day,
      window_hours: FLOW_CHECK_WINDOW_HOURS,
      jobs_posted: counts.jobsPosted,
      applications_received: counts.applicationsReceived,
      campus_applications: counts.campusApplications,
      rvm_review_overdue: counts.rvmReviewOverdue,
      live_zero_reach: counts.liveZeroReach,
      campus_unlinked: counts.campusUnlinked,
      applications_untouched: counts.applicationsUntouched,
      campus_outbox_undelivered: campus?.outboxUndelivered ?? null,
      campus_ids_missing: campus?.idsMissing ?? null,
      campus_reported_at: campus?.checkedAt ?? null,
      thresholds: { ...t },
      breached,
    };
    const actor = { actor_type: "system" as const };
    const subject = { subject_type: "job_posting" as const, subject_id: null };

    const { written: recorded } = await this.events.emitOnce({
      event_name: "flow_check.day_recorded",
      actor,
      subject,
      payload,
      idempotencyKey: `flow_check.day_recorded:${day}`,
    });

    if (breached.length === 0) {
      this.logger.log(`flow check ${day}: clean ${summary(payload)}`);
      return { armed: true, day, breached, recorded, alerted: false };
    }

    const sample = await this.sampleIds(window, breached);
    this.logger.error(
      `flow check ${day}: BREACHED ${breached.join(",")} ${summary(payload)}` +
        `${campus && !campus.dispatcherOn ? " campus_dispatcher=off" : ""}; nothing was changed. ` +
        `review_overdue=${list(sample.rvmReviewOverdue)} zero_reach=${list(sample.liveZeroReach)} ` +
        `campus_unlinked=${list(sample.campusUnlinked)}`,
    );
    const { written: alerted } = await this.events.emitOnce({
      event_name: "flow_check.breached",
      actor,
      subject,
      payload,
      idempotencyKey: `flow_check.breached:${day}`,
    });
    return { armed: true, day, breached, recorded, alerted };
  }

  /**
   * Campus's report (`PUT applications-check`). Stored as one event, deduplicated on Campus's
   * Idempotency-Key so a retried call records once. `recorded` is false on such a replay.
   */
  async recordCampusReport(
    report: FlowCheckCampusReportReceivedPayload,
    idempotencyKey: string,
  ): Promise<{ recorded: boolean }> {
    const { written } = await this.events.emitOnce({
      event_name: "flow_check.campus_report_received",
      actor: { actor_type: "system" },
      subject: { subject_type: "job_posting", subject_id: null },
      payload: report,
      idempotencyKey: `flow_check.campus_report_received:${idempotencyKey}`,
    });
    return { recorded: written };
  }

  /** The newest day records, newest first, one per day, at most `days` of them. */
  async days(days: number, now: Date): Promise<FlowCheckDay[]> {
    const rows = await this.spine.listKeyset(
      {
        eventName: ["flow_check.day_recorded"],
        // A day's record is written once that day; one spare day absorbs a late tick.
        occurredFrom: new Date(now.getTime() - (days + 1) * 24 * HOUR_MS),
      },
      days + 1,
      null,
    );
    const out: FlowCheckDay[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const parsed = FlowCheckDayRecordedPayload.safeParse(row.payload);
      if (!parsed.success || seen.has(parsed.data.day)) continue;
      seen.add(parsed.data.day);
      out.push({ ...parsed.data, recorded_at: row.occurredAt.toISOString() });
      if (out.length === days) break;
    }
    return out;
  }

  /**
   * #2967 — the synthetic runs of the same days, newest first (a run-now adds one to its day), at
   * most {@link FLOW_SYNTHETIC_MAX_RUNS}. Unreadable rows are skipped.
   */
  async syntheticRuns(days: number, now: Date): Promise<FlowSyntheticRunRow[]> {
    const rows = await this.spine.listKeyset(
      {
        eventName: ["flow_check.synthetic_run_recorded"],
        occurredFrom: new Date(now.getTime() - (days + 1) * 24 * HOUR_MS),
      },
      FLOW_SYNTHETIC_MAX_RUNS,
      null,
    );
    const out: FlowSyntheticRunRow[] = [];
    for (const row of rows) {
      const parsed = FlowCheckSyntheticRunRecordedPayload.safeParse(row.payload);
      if (parsed.success) out.push({ ...parsed.data, recorded_at: row.occurredAt.toISOString() });
    }
    return out;
  }

  /** The newest Campus report BadaBhai RECEIVED within the allowed age, or null. */
  private async latestCampusReport(
    now: Date,
    t: FlowCheckThresholds,
  ): Promise<CampusReportCounts | null> {
    const [row] = await this.spine.listKeyset(
      {
        eventName: ["flow_check.campus_report_received"],
        occurredFrom: new Date(now.getTime() - t.campus_report_max_age_hours * HOUR_MS),
        occurredTo: now,
      },
      1,
      null,
    );
    if (!row) return null;
    const parsed = FlowCheckCampusReportReceivedPayload.safeParse(row.payload);
    if (!parsed.success) return null;
    const r = parsed.data;
    return {
      checkedAt: r.checked_at,
      outboxUndelivered: r.outbox_undelivered,
      idsMissing: r.missing_on_badabhai + r.not_sent,
      dispatcherOn: r.dispatcher_on,
    };
  }

  /** Read the ids only for the BadaBhai counts that breached; the rest stay empty. */
  private async sampleIds(
    window: FlowCountWindow,
    breached: readonly FlowCheckName[],
  ): Promise<FlowSampleIds> {
    const wanted: FlowCheckName[] = ["rvm_review_overdue", "live_zero_reach", "campus_unlinked"];
    if (!wanted.some((name) => breached.includes(name))) {
      return { rvmReviewOverdue: [], liveZeroReach: [], campusUnlinked: [] };
    }
    const all = await this.repo.sampleIds(window);
    return {
      rvmReviewOverdue: breached.includes("rvm_review_overdue") ? all.rvmReviewOverdue : [],
      liveZeroReach: breached.includes("live_zero_reach") ? all.liveZeroReach : [],
      campusUnlinked: breached.includes("campus_unlinked") ? all.campusUnlinked : [],
    };
  }
}

function summary(p: FlowCheckDayRecordedPayload): string {
  return (
    `(jobs_posted=${p.jobs_posted} applications=${p.applications_received} ` +
    `campus_applications=${p.campus_applications} review_overdue=${p.rvm_review_overdue} ` +
    `zero_reach=${p.live_zero_reach} campus_unlinked=${p.campus_unlinked} ` +
    `untouched=${p.applications_untouched} campus_outbox_undelivered=${p.campus_outbox_undelivered ?? "-"} ` +
    `campus_ids_missing=${p.campus_ids_missing ?? "-"})`
  );
}

function list(ids: readonly string[]): string {
  return `[${ids.join(",")}]`;
}
