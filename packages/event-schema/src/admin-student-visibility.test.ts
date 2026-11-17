import { describe, expect, it } from "vitest";

import {
  createEvent,
  EVENT_REGISTRY,
  isEventName,
  STUDENT_VISIBILITY_SELECTORS,
  validateEvent,
} from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `admin.student_visibility_changed` / `admin.student_visibility_bulk_changed` (#2887). The
 * contract under test: ids, a boolean, a closed selector and a count, `.strict()` — no name,
 * branch or course text and no reason can ride along.
 */
function envelope(name: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: name,
    event_version: 1,
    occurred_at: "2026-11-17T10:00:00.000Z",
    actor: { actor_type: "admin", actor_id: UUID_B },
    subject: { subject_type: "worker", subject_id: UUID_C },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  };
}

const single = (over: Record<string, unknown> = {}) =>
  envelope("admin.student_visibility_changed", { worker_id: UUID_C, visible: true, ...over });
const bulk = (over: Record<string, unknown> = {}) =>
  envelope("admin.student_visibility_bulk_changed", {
    selector: "batch",
    batch_id: UUID_D,
    visible: true,
    changed: 120,
    ...over,
  });

describe("admin.student_visibility_changed", () => {
  it("is registered as a version-1 event in the admin domain", () => {
    expect(isEventName("admin.student_visibility_changed")).toBe(true);
    expect(EVENT_REGISTRY["admin.student_visibility_changed"]).toMatchObject({
      version: 1,
      domain: "admin",
    });
  });

  it("accepts on and off", () => {
    expect(validateEvent(single()).success).toBe(true);
    expect(validateEvent(single({ visible: false })).success).toBe(true);
  });

  it.each([
    ["a non-uuid worker", { worker_id: "w-1" }],
    ["a reason riding along", { reason: "drive at Pune" }],
    ["a name riding along", { full_name: "Ravi" }],
  ])("refuses %s", (_label, over) => {
    expect(validateEvent(single(over)).success).toBe(false);
  });

  it("the shape is pinned", () => {
    expect(createEvent(single() as never).payload).toEqual({ worker_id: UUID_C, visible: true });
    expect(Object.keys(EVENT_REGISTRY["admin.student_visibility_changed"].payload.shape).sort()).toEqual([
      "visible",
      "worker_id",
    ]);
  });
});

describe("admin.student_visibility_bulk_changed", () => {
  it("is registered as a version-1 event in the admin domain", () => {
    expect(isEventName("admin.student_visibility_bulk_changed")).toBe(true);
    expect(EVENT_REGISTRY["admin.student_visibility_bulk_changed"]).toMatchObject({
      version: 1,
      domain: "admin",
    });
  });

  it("the selectors are batch, branch and course", () => {
    expect([...STUDENT_VISIBILITY_SELECTORS]).toEqual(["batch", "branch", "course"]);
  });

  it("accepts a batch with its id, and a branch or course without one", () => {
    expect(validateEvent(bulk()).success).toBe(true);
    expect(validateEvent(bulk({ selector: "branch", batch_id: null })).success).toBe(true);
    expect(validateEvent(bulk({ selector: "course", batch_id: null, changed: 0 })).success).toBe(true);
  });

  it.each([
    ["a batch without its id", { batch_id: null }],
    ["a branch naming a batch", { selector: "branch" }],
    ["a negative count", { changed: -1 }],
    ["an unknown selector", { selector: "city", batch_id: null }],
    ["the branch name riding along", { selector: "branch", batch_id: null, branch: "Pune" }],
  ])("refuses %s", (_label, over) => {
    expect(validateEvent(bulk(over)).success).toBe(false);
  });

  it("the shape is pinned", () => {
    expect(
      Object.keys(EVENT_REGISTRY["admin.student_visibility_bulk_changed"].payload.shape).sort(),
    ).toEqual(["batch_id", "changed", "selector", "visible"]);
  });
});
