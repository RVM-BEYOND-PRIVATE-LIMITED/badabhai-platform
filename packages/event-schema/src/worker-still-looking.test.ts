import { describe, expect, it } from "vitest";

import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";
import { STILL_LOOKING_CHECK_ANSWERS } from "./payloads";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `worker.still_looking_prompted` and `worker.still_looking_answered` (#2753 item 5). The contract
 * under test: the worker's opaque id, the check's id and (answered) the closed answer, `.strict()`
 * — so a name, a phone, a device, an availability or a company can never ride along.
 */
function prompted(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "worker.still_looking_prompted",
    event_version: 1,
    occurred_at: "2026-11-16T10:00:00.000Z",
    actor: { actor_type: "system" },
    subject: { subject_type: "worker", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: { worker_id: UUID_B, check_id: UUID_C, ...over },
    metadata: { environment: "test", service: "api" },
  };
}

function answered(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...prompted(),
    event_name: "worker.still_looking_answered",
    actor: { actor_type: "worker", actor_id: UUID_B },
    payload: { worker_id: UUID_B, check_id: UUID_C, answer: "yes", ...over },
  };
}

const SMUGGLED = [
  "full_name",
  "phone",
  "device_id",
  "availability",
  "payer_id",
  "company",
  "posting_id",
  "reason",
];

describe("worker.still_looking_prompted", () => {
  it("is registered as a version-1 event in the worker domain", () => {
    expect(isEventName("worker.still_looking_prompted")).toBe(true);
    expect(EVENT_REGISTRY["worker.still_looking_prompted"]).toMatchObject({
      version: 1,
      domain: "worker",
    });
  });

  it("validates the worker and the check, and pins that SHAPE exactly", () => {
    expect(validateEvent(prompted()).success).toBe(true);
    expect(createEvent(prompted() as never).payload).toEqual({
      worker_id: UUID_B,
      check_id: UUID_C,
    });
    const def = EVENT_REGISTRY["worker.still_looking_prompted"];
    expect(Object.keys(def.payload.shape).sort()).toEqual(["check_id", "worker_id"]);
  });

  it("is STRICT: nothing else can ride along", () => {
    for (const smuggled of [...SMUGGLED, "answer"]) {
      const result = validateEvent(prompted({ [smuggled]: "x" }));
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("requires both ids, and both must be uuids", () => {
    for (const key of ["worker_id", "check_id"]) {
      const event = prompted();
      const { [key]: _dropped, ...rest } = event.payload as Record<string, unknown>;
      event.payload = rest;
      expect(validateEvent(event).success, key).toBe(false);
      expect(validateEvent(prompted({ [key]: "not-a-uuid" })).success, key).toBe(false);
    }
  });
});

describe("worker.still_looking_answered", () => {
  it("is registered as a version-1 event in the worker domain", () => {
    expect(isEventName("worker.still_looking_answered")).toBe(true);
    expect(EVENT_REGISTRY["worker.still_looking_answered"]).toMatchObject({
      version: 1,
      domain: "worker",
    });
  });

  it.each([...STILL_LOOKING_CHECK_ANSWERS])("validates the answer %s", (answer) => {
    const parsed = answered({ answer });
    expect(validateEvent(parsed).success).toBe(true);
    expect(createEvent(parsed as never).payload).toEqual({
      worker_id: UUID_B,
      check_id: UUID_C,
      answer,
    });
  });

  it("pins the payload SHAPE and the closed answers", () => {
    const def = EVENT_REGISTRY["worker.still_looking_answered"];
    expect(Object.keys(def.payload.shape).sort()).toEqual(["answer", "check_id", "worker_id"]);
    expect(def.payload.shape.answer.options).toEqual([...STILL_LOOKING_CHECK_ANSWERS]);
    expect([...STILL_LOOKING_CHECK_ANSWERS]).toEqual(["yes", "not_now", "hired"]);
  });

  it("is STRICT: nothing else can ride along", () => {
    for (const smuggled of SMUGGLED) {
      const result = validateEvent(answered({ [smuggled]: "x" }));
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("refuses an answer outside the closed set, and requires every field", () => {
    for (const answer of ["no", "Yes", "not now", "maybe", "", null]) {
      expect(validateEvent(answered({ answer })).success, String(answer)).toBe(false);
    }
    for (const key of ["worker_id", "check_id", "answer"]) {
      const event = answered();
      const { [key]: _dropped, ...rest } = event.payload as Record<string, unknown>;
      event.payload = rest;
      expect(validateEvent(event).success, key).toBe(false);
    }
  });
});
