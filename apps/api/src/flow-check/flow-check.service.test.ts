import { describe, expect, it, vi } from "vitest";
import {
  FLOW_CHECK_THRESHOLD_DEFAULTS,
  parseFlowCheckThresholds,
  type FlowCheckThresholds,
  type ServerConfig,
} from "@badabhai/config";
import type { EventRow } from "@badabhai/db";
import type { EventsService } from "../events/events.service";
import type { AdminEventsRepository } from "../admin/admin-events.repository";
import type { FlowCheckRepository, FlowCounts } from "./flow-check.repository";
import {
  FlowCheckService,
  breachedChecks,
  flowCheckDay,
  flowCountWindow,
  type CampusReportCounts,
} from "./flow-check.service";

/** #2890 — the daily flow check: off, clean, each breach, the Campus report, once a day, the read. */

// 23:30 UTC on 19 Nov = 05:00 IST on 20 Nov: the tick's own time.
const NOW = new Date("2026-11-19T23:30:00.000Z");
const HOUR = 60 * 60 * 1000;
const DEFAULTS = FLOW_CHECK_THRESHOLD_DEFAULTS as unknown as FlowCheckThresholds;

const CLEAN: FlowCounts = {
  jobsPosted: 7,
  applicationsReceived: 30,
  campusApplications: 4,
  rvmReviewOverdue: 0,
  liveZeroReach: 0,
  campusUnlinked: 0,
  applicationsUntouched: 9,
};

const REPORT = {
  checked_at: "2026-11-20T03:30:00.000+05:30",
  outbox_undelivered: 0,
  missing_on_badabhai: 0,
  not_sent: 0,
  dispatcher_on: true,
};

function reportRow(payload: Record<string, unknown>, at = new Date(NOW.getTime() - 2 * HOUR)) {
  return {
    eventName: "flow_check.campus_report_received",
    occurredAt: at,
    payload,
  } as unknown as EventRow;
}

interface Setup {
  enabled?: boolean;
  campusLink?: boolean;
  counts?: Partial<FlowCounts>;
  /** What the spine holds for the Campus report read (newest first). */
  reports?: EventRow[];
  thresholds?: string;
}

function setup(opts: Setup = {}) {
  const readCounts = vi.fn(async () => ({ ...CLEAN, ...opts.counts }));
  const sampleIds = vi.fn(async () => ({
    rvmReviewOverdue: ["p-review"],
    liveZeroReach: ["p-zero"],
    campusUnlinked: ["ia-1"],
  }));
  const listKeyset = vi.fn(async (filter: { eventName?: string[] }) =>
    filter.eventName?.[0] === "flow_check.campus_report_received" ? (opts.reports ?? []) : [],
  );
  const emitOnce = vi.fn(async () => ({ event: {} as never, written: true }));
  const service = new FlowCheckService(
    { readCounts, sampleIds } as unknown as FlowCheckRepository,
    { listKeyset } as unknown as AdminEventsRepository,
    { emitOnce } as unknown as EventsService,
    {
      FLOW_CHECK_ENABLED: opts.enabled ?? true,
      CAMPUS_LINK_ENABLED: opts.campusLink ?? false,
      FLOW_CHECK_THRESHOLDS: parseFlowCheckThresholds(opts.thresholds),
    } as ServerConfig,
  );
  const logger = (service as unknown as { logger: Record<string, (m: string) => void> }).logger;
  const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "log").mockImplementation(() => undefined);
  return { service, readCounts, sampleIds, listKeyset, emitOnce, error };
}

const emitted = (emitOnce: ReturnType<typeof vi.fn>, name: string) =>
  emitOnce.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.event_name === name);

describe("flowCheckDay / flowCountWindow", () => {
  it("names the IST day: 23:30 UTC on the 19th is the 20th in India", () => {
    expect(flowCheckDay(NOW)).toBe("2026-11-20");
    expect(flowCheckDay(new Date("2026-11-19T18:29:59.999Z"))).toBe("2026-11-19");
    expect(flowCheckDay(new Date("2026-11-19T18:30:00.000Z"))).toBe("2026-11-20");
  });

  it("reads every bound from the thresholds, the untouched cohort being one day wide", () => {
    const w = flowCountWindow(NOW, DEFAULTS);
    expect(NOW.getTime() - w.since.getTime()).toBe(24 * HOUR);
    expect(NOW.getTime() - w.reviewCutoff.getTime()).toBe(48 * HOUR);
    expect(NOW.getTime() - w.reachCutoff.getTime()).toBe(24 * HOUR);
    expect(NOW.getTime() - w.untouchedTo.getTime()).toBe(72 * HOUR);
    expect(w.untouchedTo.getTime() - w.untouchedFrom.getTime()).toBe(24 * HOUR);
  });
});

describe("breachedChecks", () => {
  const campus = (over: Partial<CampusReportCounts> = {}): CampusReportCounts => ({
    checkedAt: REPORT.checked_at,
    outboxUndelivered: 0,
    idsMissing: 0,
    dispatcherOn: true,
    ...over,
  });

  it("a clean day breaches nothing; untouched applications never alert by default", () => {
    expect(
      breachedChecks({ ...CLEAN, applicationsUntouched: 500 }, campus(), true, DEFAULTS),
    ).toEqual([]);
  });

  it("any one of a 0-max count is a breach, in the closed order", () => {
    expect(
      breachedChecks(
        { ...CLEAN, campusUnlinked: 1, rvmReviewOverdue: 1, liveZeroReach: 1 },
        campus({ outboxUndelivered: 1, idsMissing: 2 }),
        true,
        DEFAULTS,
      ),
    ).toEqual([
      "rvm_review_overdue",
      "live_zero_reach",
      "campus_unlinked",
      "campus_outbox_undelivered",
      "campus_ids_missing",
    ]);
  });

  it("a raised maximum tolerates up to it; `off` never alerts", () => {
    const t = parseFlowCheckThresholds("zero_reach_max=3,review_overdue_max=off,untouched_max=10");
    expect(
      breachedChecks({ ...CLEAN, liveZeroReach: 3, rvmReviewOverdue: 99 }, null, false, t),
    ).toEqual([]);
    expect(breachedChecks({ ...CLEAN, liveZeroReach: 4 }, null, false, t)).toEqual([
      "live_zero_reach",
    ]);
    expect(breachedChecks({ ...CLEAN, applicationsUntouched: 11 }, null, false, t)).toEqual([
      "applications_untouched",
    ]);
  });

  it("no Campus report is a breach only while the Campus link is on", () => {
    expect(breachedChecks(CLEAN, null, true, DEFAULTS)).toEqual(["campus_report_missing"]);
    expect(breachedChecks(CLEAN, null, false, DEFAULTS)).toEqual([]);
  });

  it("…and only while one of the report's two counts can alert", () => {
    const bothOff = parseFlowCheckThresholds("outbox_undelivered_max=off,campus_missing_max=off");
    expect(breachedChecks(CLEAN, null, true, bothOff)).toEqual([]);
    const oneOff = parseFlowCheckThresholds("outbox_undelivered_max=off");
    expect(breachedChecks(CLEAN, null, true, oneOff)).toEqual(["campus_report_missing"]);
  });
});

describe("FlowCheckService.run", () => {
  it("off: returns at once without a query or an event", async () => {
    const { service, readCounts, listKeyset, emitOnce } = setup({ enabled: false });
    expect(await service.run(NOW)).toEqual({ armed: false });
    expect(readCounts).not.toHaveBeenCalled();
    expect(listKeyset).not.toHaveBeenCalled();
    expect(emitOnce).not.toHaveBeenCalled();
  });

  it("clean: records the day once, keyed on the IST day, and raises no alert", async () => {
    const { service, emitOnce, sampleIds, error } = setup();
    const result = await service.run(NOW);
    expect(result).toEqual({
      armed: true,
      day: "2026-11-20",
      breached: [],
      recorded: true,
      alerted: false,
    });
    const [record] = emitted(emitOnce, "flow_check.day_recorded");
    expect(record).toMatchObject({
      actor: { actor_type: "system" },
      subject: { subject_type: "job_posting", subject_id: null },
      idempotencyKey: "flow_check.day_recorded:2026-11-20",
      payload: {
        day: "2026-11-20",
        window_hours: 24,
        jobs_posted: 7,
        applications_received: 30,
        campus_applications: 4,
        applications_untouched: 9,
        campus_outbox_undelivered: null,
        campus_ids_missing: null,
        campus_reported_at: null,
        breached: [],
      },
    });
    expect((record!.payload as { thresholds: unknown }).thresholds).toEqual(DEFAULTS);
    expect(emitted(emitOnce, "flow_check.breached")).toEqual([]);
    expect(sampleIds).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("with the Campus link off it never reads Campus's report", async () => {
    const { service, listKeyset } = setup({ campusLink: false });
    await service.run(NOW);
    expect(listKeyset).not.toHaveBeenCalled();
  });

  it("breach: one alert per IST day with the same counts, ids only in the log line", async () => {
    const { service, emitOnce, error, sampleIds } = setup({ counts: { liveZeroReach: 2 } });
    const result = await service.run(NOW);
    expect(result).toMatchObject({ breached: ["live_zero_reach"], recorded: true, alerted: true });
    const [alert] = emitted(emitOnce, "flow_check.breached");
    expect(alert).toMatchObject({
      idempotencyKey: "flow_check.breached:2026-11-20",
      payload: { live_zero_reach: 2, breached: ["live_zero_reach"] },
    });
    // The alert and the record carry the same payload.
    expect(alert!.payload).toEqual(emitted(emitOnce, "flow_check.day_recorded")[0]!.payload);
    expect(sampleIds).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]?.[0]);
    expect(line).toContain("BREACHED live_zero_reach");
    expect(line).toContain("zero_reach=[p-zero]");
    // Only the breaching count's ids are listed.
    expect(line).toContain("review_overdue=[]");
    expect(line).toContain("campus_unlinked=[]");
    expect(JSON.stringify(alert!.payload)).not.toContain("p-zero");
  });

  it("a second tick the same day is a no-op on the spine (both keys dedupe)", async () => {
    const { service, emitOnce } = setup({ counts: { campusUnlinked: 1 } });
    emitOnce.mockResolvedValue({ event: {} as never, written: false });
    const result = await service.run(NOW);
    expect(result).toMatchObject({
      recorded: false,
      alerted: false,
      breached: ["campus_unlinked"],
    });
  });

  it("does not read sample ids when only Campus-side checks breached", async () => {
    const { service, sampleIds } = setup({ campusLink: true });
    const result = await service.run(NOW);
    expect(result).toMatchObject({ breached: ["campus_report_missing"] });
    expect(sampleIds).not.toHaveBeenCalled();
  });

  it("link on: reads Campus's newest report within the allowed age and sums its missing ids", async () => {
    const { service, emitOnce, listKeyset } = setup({
      campusLink: true,
      reports: [
        reportRow({ ...REPORT, outbox_undelivered: 3, missing_on_badabhai: 1, not_sent: 2 }),
      ],
    });
    const result = await service.run(NOW);
    expect(result).toMatchObject({
      breached: ["campus_outbox_undelivered", "campus_ids_missing"],
    });
    expect(emitted(emitOnce, "flow_check.day_recorded")[0]!.payload).toMatchObject({
      campus_outbox_undelivered: 3,
      campus_ids_missing: 3,
      campus_reported_at: REPORT.checked_at,
    });
    const filter = listKeyset.mock.calls[0]![0] as { occurredFrom: Date; occurredTo: Date };
    expect(NOW.getTime() - filter.occurredFrom.getTime()).toBe(26 * HOUR);
    expect(filter.occurredTo).toEqual(NOW);
    expect((listKeyset.mock.calls[0] as unknown[])[1]).toBe(1);
  });

  it("link on: a stopped Campus dispatcher shows as undelivered rows and is named in the log", async () => {
    const { service, error } = setup({
      campusLink: true,
      reports: [reportRow({ ...REPORT, outbox_undelivered: 5, dispatcher_on: false })],
    });
    const result = await service.run(NOW);
    expect(result).toMatchObject({ breached: ["campus_outbox_undelivered"] });
    expect(String(error.mock.calls[0]?.[0])).toContain("campus_dispatcher=off");
  });

  it("link on: an unreadable report counts as no report", async () => {
    const { service } = setup({ campusLink: true, reports: [reportRow({ checked_at: "nope" })] });
    expect(await service.run(NOW)).toMatchObject({ breached: ["campus_report_missing"] });
  });
});

describe("FlowCheckService.recordCampusReport", () => {
  it("stores one counts-only event, deduplicated on Campus's Idempotency-Key", async () => {
    const { service, emitOnce } = setup();
    expect(await service.recordCampusReport(REPORT, "outbox:abc12345")).toEqual({ recorded: true });
    expect(emitOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: "flow_check.campus_report_received",
        actor: { actor_type: "system" },
        payload: REPORT,
        idempotencyKey: "flow_check.campus_report_received:outbox:abc12345",
      }),
    );
  });

  it("a replay answers recorded: false", async () => {
    const { service, emitOnce } = setup();
    emitOnce.mockResolvedValueOnce({ event: {} as never, written: false });
    expect(await service.recordCampusReport(REPORT, "outbox:abc12345")).toEqual({
      recorded: false,
    });
  });
});

describe("FlowCheckService.days", () => {
  const dayRow = (day: string, at: string, over: Record<string, unknown> = {}) =>
    ({
      eventName: "flow_check.day_recorded",
      occurredAt: new Date(at),
      payload: {
        day,
        window_hours: 24,
        jobs_posted: 1,
        applications_received: 2,
        campus_applications: 0,
        rvm_review_overdue: 0,
        live_zero_reach: 0,
        campus_unlinked: 0,
        applications_untouched: 0,
        campus_outbox_undelivered: null,
        campus_ids_missing: null,
        campus_reported_at: null,
        thresholds: {},
        breached: [],
        ...over,
      },
    }) as unknown as EventRow;

  it("returns the newest records first, one per day, skipping unreadable rows, capped at n", async () => {
    const { service, listKeyset } = setup();
    listKeyset.mockResolvedValueOnce([
      dayRow("2026-11-20", "2026-11-19T23:30:00Z"),
      dayRow("2026-11-20", "2026-11-19T23:00:00Z"),
      dayRow("2026-11-19", "2026-11-18T23:30:00Z", { jobs_posted: "x" }),
      dayRow("2026-11-18", "2026-11-17T23:30:00Z", { breached: ["live_zero_reach"] }),
      dayRow("2026-11-17", "2026-11-16T23:30:00Z"),
    ]);
    const days = await service.days(2, NOW);
    expect(days.map((d) => d.day)).toEqual(["2026-11-20", "2026-11-18"]);
    expect(days[0]!.recorded_at).toBe("2026-11-19T23:30:00.000Z");
    expect(days[1]!.breached).toEqual(["live_zero_reach"]);
    const [filter, limit] = listKeyset.mock.calls[0]! as unknown as [
      { eventName: string[]; occurredFrom: Date },
      number,
    ];
    expect(filter.eventName).toEqual(["flow_check.day_recorded"]);
    expect(NOW.getTime() - filter.occurredFrom.getTime()).toBe(3 * 24 * HOUR);
    expect(limit).toBe(3);
  });
});
