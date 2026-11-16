import { describe, expect, it } from "vitest";

import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";
import { SEARCH_VISIBILITY_VIAS } from "./payloads";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `worker.search_visibility_changed` (#2753 item 6). The contract under test: the worker's opaque
 * id, the visibility now in force and the closed `via`, `.strict()` — so a consent purpose, a
 * name, a phone or a company can never ride along.
 */
function changedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "worker.search_visibility_changed",
    event_version: 1,
    occurred_at: "2026-11-16T10:00:00.000Z",
    actor: { actor_type: "worker", actor_id: UUID_B },
    subject: { subject_type: "worker", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: { worker_id: UUID_B, visible: false, via: "worker", ...over },
    metadata: { environment: "test", service: "api" },
  };
}

describe("worker.search_visibility_changed", () => {
  it("is registered as a version-1 event in the worker domain", () => {
    expect(isEventName("worker.search_visibility_changed")).toBe(true);
    expect(EVENT_REGISTRY["worker.search_visibility_changed"]).toMatchObject({
      version: 1,
      domain: "worker",
    });
  });

  it.each([
    [false, "worker"],
    [true, "worker"],
    [false, "monthly_check"],
    [true, "monthly_check"],
  ])("validates visible=%s via %s", (visible, via) => {
    const parsed = changedEvent({ visible, via });
    expect(validateEvent(parsed).success).toBe(true);
    expect(createEvent(parsed as never).payload).toEqual({ worker_id: UUID_B, visible, via });
  });

  it("pins the payload SHAPE: the worker, the visibility and the via, nothing else", () => {
    const def = EVENT_REGISTRY["worker.search_visibility_changed"];
    expect(Object.keys(def.payload.shape).sort()).toEqual(["via", "visible", "worker_id"]);
    expect(def.payload.shape.via.options).toEqual([...SEARCH_VISIBILITY_VIAS]);
    expect([...SEARCH_VISIBILITY_VIAS]).toEqual(["worker", "monthly_check"]);
  });

  it("is STRICT: a consent purpose, a name, a phone or a company cannot ride along", () => {
    for (const smuggled of ["purposes", "full_name", "phone", "payer_id", "company", "reason"]) {
      const result = validateEvent(changedEvent({ [smuggled]: "x" }));
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("refuses a via outside the closed set, a non-boolean visibility and a non-uuid id", () => {
    for (const over of [
      { via: "admin" },
      { via: "Worker" },
      { visible: "false" },
      { visible: null },
      { worker_id: "not-a-uuid" },
    ]) {
      expect(validateEvent(changedEvent(over)).success, JSON.stringify(over)).toBe(false);
    }
  });

  it("requires every field", () => {
    for (const key of ["worker_id", "visible", "via"]) {
      const event = changedEvent();
      const { [key]: _dropped, ...rest } = event.payload as Record<string, unknown>;
      event.payload = rest;
      expect(validateEvent(event).success, key).toBe(false);
    }
  });
});
