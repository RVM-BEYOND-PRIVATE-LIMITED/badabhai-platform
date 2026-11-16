import { describe, expect, it } from "vitest";

import { UNLOCK_OUTCOME_ANSWERERS, UNLOCK_OUTCOMES } from "@badabhai/types";

import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UNLOCK = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const PAYER = "44444444-4444-4444-8444-444444444444";
const CORRELATION = "55555555-5555-4555-8555-555555555555";

/**
 * `unlock.outcome_recorded` (#2753 item 10). The contract under test: the unlock, the worker, the
 * outcome and who answered, `.strict()`, every value from a closed set.
 */
function recordedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UNLOCK,
    event_name: "unlock.outcome_recorded",
    event_version: 1,
    occurred_at: "2026-11-16T10:00:00.000Z",
    actor: { actor_type: "payer", actor_id: PAYER },
    subject: { subject_type: "unlock", subject_id: UNLOCK },
    source: "api",
    correlation_id: CORRELATION,
    causation_id: null,
    payload: {
      unlock_id: UNLOCK,
      worker_id: WORKER,
      outcome: "hired",
      answered_by: "company",
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("unlock.outcome_recorded", () => {
  it("is registered as a version-1 event in the unlock domain", () => {
    expect(isEventName("unlock.outcome_recorded")).toBe(true);
    expect(EVENT_REGISTRY["unlock.outcome_recorded"]).toMatchObject({
      version: 1,
      domain: "unlock",
    });
  });

  it("validates every outcome from either answerer", () => {
    let validated = 0;
    for (const outcome of UNLOCK_OUTCOMES) {
      for (const answered_by of UNLOCK_OUTCOME_ANSWERERS) {
        const parsed = recordedEvent({ outcome, answered_by });
        expect(validateEvent(parsed).success, `${outcome}/${answered_by}`).toBe(true);
        expect(createEvent(parsed as never).payload).toEqual({
          unlock_id: UNLOCK,
          worker_id: WORKER,
          outcome,
          answered_by,
        });
        validated += 1;
      }
    }
    expect(validated).toBe(8);
  });

  it("pins the payload SHAPE: two ids and two closed values, nothing else", () => {
    const shape = (
      EVENT_REGISTRY["unlock.outcome_recorded"].payload as unknown as {
        shape: Record<string, { options?: readonly unknown[] }>;
      }
    ).shape;
    expect(Object.keys(shape).sort()).toEqual(["answered_by", "outcome", "unlock_id", "worker_id"]);
    expect(shape.outcome!.options).toEqual([...UNLOCK_OUTCOMES]);
    expect(shape.answered_by!.options).toEqual([...UNLOCK_OUTCOME_ANSWERERS]);
    expect([...UNLOCK_OUTCOMES]).toEqual(["hired", "not_hired", "still_talking", "not_reached"]);
  });

  it("is STRICT: a name, a phone, a tenant, a posting or a note cannot ride along", () => {
    for (const smuggled of [
      "full_name",
      "phone",
      "payer_id",
      "tenant_payer_id",
      "job_posting_id",
      "previous_outcome",
      "note",
    ]) {
      const result = validateEvent(recordedEvent({ [smuggled]: "x" }));
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("refuses a value outside the closed sets, and a non-uuid or missing id", () => {
    for (const over of [
      { outcome: "Hired" },
      { outcome: "rejected" },
      { outcome: null },
      { answered_by: "worker" },
      { answered_by: "admin" },
      { unlock_id: "not-a-uuid" },
      { worker_id: null },
    ]) {
      expect(validateEvent(recordedEvent(over)).success, JSON.stringify(over)).toBe(false);
    }
  });

  it("rejects the event under any version but 1", () => {
    const result = validateEvent({ ...recordedEvent(), event_version: 2 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("version");
  });
});
