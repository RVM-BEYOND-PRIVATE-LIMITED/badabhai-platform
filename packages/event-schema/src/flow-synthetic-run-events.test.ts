import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, FLOW_SYNTHETIC_STEPS, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * #2967 — the daily synthetic run's two events: closed codes, a day and a duration only, strict;
 * the pass/fail fields must agree; a failure alert always names its step and code.
 */
function envelope(eventName: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: eventName,
    event_version: 1,
    occurred_at: "2026-11-19T23:00:00.000Z",
    actor: { actor_type: "system", actor_id: null },
    subject: { subject_type: "job_posting", subject_id: null },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  };
}

const PASSED = {
  day: "2026-11-20",
  trigger: "schedule",
  passed: true,
  steps_passed: FLOW_SYNTHETIC_STEPS.length,
  failed_step: null,
  failure: null,
  duration_ms: 1840,
};
const FAILED = {
  ...PASSED,
  passed: false,
  steps_passed: 3,
  failed_step: "rvm_audience",
  failure: "no_campus_trade",
};

const recorded = (p: Record<string, unknown>) =>
  validateEvent(envelope("flow_check.synthetic_run_recorded", p)).success;
const failed = (p: Record<string, unknown>) =>
  validateEvent(envelope("flow_check.synthetic_run_failed", p)).success;

describe("flow_check.synthetic_run_recorded / synthetic_run_failed (#2967)", () => {
  it("are registered v1 names in the flow_check domain", () => {
    for (const name of [
      "flow_check.synthetic_run_recorded",
      "flow_check.synthetic_run_failed",
    ] as const) {
      expect(isEventName(name)).toBe(true);
      expect(EVENT_REGISTRY[name]).toMatchObject({ version: 1, domain: "flow_check" });
    }
  });

  it("a record takes a pass or a failure; an alert only a failure", () => {
    expect(recorded(PASSED)).toBe(true);
    expect(recorded(FAILED)).toBe(true);
    expect(failed(FAILED)).toBe(true);
    expect(failed(PASSED)).toBe(false);
  });

  it("the step that failed is the one after the steps that passed", () => {
    expect(recorded({ ...FAILED, steps_passed: 2 })).toBe(false);
    expect(recorded({ ...FAILED, steps_passed: 0, failed_step: "setup" })).toBe(true);
  });

  it("a pass names no failure and passed every step; a failure names both", () => {
    expect(recorded({ ...PASSED, failure: "error" })).toBe(false);
    expect(recorded({ ...PASSED, steps_passed: 9 })).toBe(false);
    expect(recorded({ ...FAILED, failure: null })).toBe(false);
    expect(recorded({ ...FAILED, failed_step: null })).toBe(false);
  });

  it("is strict, with closed codes: no id or message rides along", () => {
    for (const extra of [{ job_posting_id: UUID_A }, { message: "boom" }, { worker_id: UUID_A }]) {
      expect(recorded({ ...FAILED, ...extra }), JSON.stringify(extra)).toBe(false);
    }
    expect(recorded({ ...FAILED, failure: "kaboom" })).toBe(false);
    expect(recorded({ ...FAILED, failed_step: "deployed" })).toBe(false);
    expect(recorded({ ...PASSED, trigger: "cron" })).toBe(false);
    expect(recorded({ ...PASSED, duration_ms: -1 })).toBe(false);
  });
});
