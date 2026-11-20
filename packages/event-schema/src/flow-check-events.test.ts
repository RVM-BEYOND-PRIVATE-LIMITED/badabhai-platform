import { describe, expect, it } from "vitest";

import { EVENT_DOMAINS } from "./enums";
import { EVENT_REGISTRY, FLOW_CHECK_NAMES, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * #2890 — the daily flow check's three events. The contract under test: counts, closed check names
 * and times only, `.strict()` so no posting, application, worker or company id can ride the spine;
 * a breach always names a check; Campus's report carries only its counts and its dispatcher flag.
 */

function envelope(eventName: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: eventName,
    event_version: 1,
    occurred_at: "2026-11-19T23:30:00.000Z",
    actor: { actor_type: "system", actor_id: null },
    subject: { subject_type: "job_posting", subject_id: null },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  };
}

const COUNTS = {
  day: "2026-11-20",
  window_hours: 24,
  jobs_posted: 12,
  applications_received: 40,
  campus_applications: 6,
  rvm_review_overdue: 1,
  live_zero_reach: 0,
  campus_unlinked: 0,
  applications_untouched: 3,
  campus_outbox_undelivered: 2,
  campus_ids_missing: 0,
  campus_reported_at: "2026-11-19T22:00:00.000+05:30",
  thresholds: { review_wait_hours: 48, review_overdue_max: 0, untouched_max: null },
  breached: ["rvm_review_overdue", "campus_outbox_undelivered"],
};

const dayRecorded = (over: Record<string, unknown> = {}) =>
  envelope("flow_check.day_recorded", { ...COUNTS, ...over });
const breached = (over: Record<string, unknown> = {}) =>
  envelope("flow_check.breached", { ...COUNTS, ...over });
const campusReport = (over: Record<string, unknown> = {}) =>
  envelope("flow_check.campus_report_received", {
    checked_at: "2026-11-20T03:30:00.000+05:30",
    outbox_undelivered: 2,
    missing_on_badabhai: 0,
    not_sent: 1,
    dispatcher_on: true,
    ...over,
  });

describe("the flow_check domain (#2890)", () => {
  it("is a domain, and its three names are registered v1", () => {
    expect(EVENT_DOMAINS).toContain("flow_check");
    for (const name of [
      "flow_check.day_recorded",
      "flow_check.breached",
      "flow_check.campus_report_received",
    ] as const) {
      expect(isEventName(name)).toBe(true);
      expect(EVENT_REGISTRY[name]).toMatchObject({ version: 1, domain: "flow_check" });
    }
  });
});

describe("flow_check.day_recorded", () => {
  it("validates a day with breaches, and a clean day with none", () => {
    expect(validateEvent(dayRecorded()).success).toBe(true);
    expect(validateEvent(dayRecorded({ breached: [] })).success).toBe(true);
  });

  it("takes null Campus counts when Campus sent no report in time", () => {
    expect(
      validateEvent(
        dayRecorded({
          campus_outbox_undelivered: null,
          campus_ids_missing: null,
          campus_reported_at: null,
          breached: ["campus_report_missing"],
        }),
      ).success,
    ).toBe(true);
  });

  it("is strict: no id, list of ids or note can ride along", () => {
    for (const extra of [
      { job_posting_id: UUID_A },
      { posting_ids: [UUID_A] },
      { payer_id: UUID_A },
      { note: "x" },
    ]) {
      expect(validateEvent(dayRecorded(extra)).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("refuses an unknown check name, a name given twice, a bad day or a negative count", () => {
    expect(validateEvent(dayRecorded({ breached: ["everything"] })).success).toBe(false);
    expect(
      validateEvent(dayRecorded({ breached: ["live_zero_reach", "live_zero_reach"] })).success,
    ).toBe(false);
    expect(validateEvent(dayRecorded({ day: "20-11-2026" })).success).toBe(false);
    expect(validateEvent(dayRecorded({ jobs_posted: -1 })).success).toBe(false);
    expect(validateEvent(dayRecorded({ live_zero_reach: 0.5 })).success).toBe(false);
  });

  it("thresholds carry numbers or null under snake_case keys only", () => {
    expect(validateEvent(dayRecorded({ thresholds: { "Bad Key": 1 } })).success).toBe(false);
    expect(validateEvent(dayRecorded({ thresholds: { zero_reach_max: "5" } })).success).toBe(false);
  });
});

describe("flow_check.breached", () => {
  it("validates the same counts as the day's record", () => {
    expect(validateEvent(breached()).success).toBe(true);
  });

  it("refuses a breach that names no check: a clean day raises no alert", () => {
    const result = validateEvent(breached({ breached: [] }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("payload");
  });

  it("every check name the service can raise is in the closed list", () => {
    expect(FLOW_CHECK_NAMES).toEqual([
      "rvm_review_overdue",
      "live_zero_reach",
      "campus_unlinked",
      "applications_untouched",
      "campus_outbox_undelivered",
      "campus_ids_missing",
      "campus_report_missing",
    ]);
  });
});

describe("flow_check.campus_report_received", () => {
  it("validates Campus's counts and dispatcher flag", () => {
    expect(validateEvent(campusReport()).success).toBe(true);
    expect(validateEvent(campusReport({ dispatcher_on: false })).success).toBe(true);
  });

  it("is strict: Campus's findings and ids stay on Campus", () => {
    for (const extra of [
      { findings: [{ application_id: "app_1234567" }] },
      { application_ids: ["app_1234567"] },
      { student_ref: UUID_A },
    ]) {
      expect(validateEvent(campusReport(extra)).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("refuses a time without an offset and a negative count", () => {
    expect(validateEvent(campusReport({ checked_at: "2026-11-20 03:30" })).success).toBe(false);
    expect(validateEvent(campusReport({ not_sent: -1 })).success).toBe(false);
  });
});
