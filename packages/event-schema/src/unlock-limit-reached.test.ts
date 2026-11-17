import { describe, expect, it } from "vitest";

import {
  createEvent,
  EVENT_REGISTRY,
  isEventName,
  UNLOCK_LIMIT_KINDS,
  validateEvent,
} from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `unlock.limit_reached` (#2750 item 6). The contract under test: the tenant key, the worker
 * (null exactly for the agency limit), the closed limit kind and the positive limit in force,
 * `.strict()` — no count, name or reason can ride along.
 */
function limitEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "unlock.limit_reached",
    event_version: 1,
    occurred_at: "2026-11-17T10:00:00.000Z",
    actor: { actor_type: "payer", actor_id: UUID_B },
    subject: { subject_type: "worker", subject_id: UUID_C },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      payer_id: UUID_B,
      worker_id: UUID_C,
      limit: "worker_weekly_opens",
      max: 5,
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("unlock.limit_reached", () => {
  it("is registered as a version-1 event in the unlock domain", () => {
    expect(isEventName("unlock.limit_reached")).toBe(true);
    expect(EVENT_REGISTRY["unlock.limit_reached"]).toMatchObject({ version: 1, domain: "unlock" });
  });

  it("the limits are exactly the two the credit rules set", () => {
    expect([...UNLOCK_LIMIT_KINDS]).toEqual(["worker_weekly_opens", "agency_daily_opens"]);
  });

  it("accepts the weekly limit with its worker, and the agency limit without one", () => {
    expect(validateEvent(limitEvent()).success).toBe(true);
    expect(
      validateEvent(limitEvent({ limit: "agency_daily_opens", worker_id: null, max: 40 })).success,
    ).toBe(true);
  });

  it.each([
    ["the weekly limit with no worker", { worker_id: null }],
    ["the agency limit naming a worker", { limit: "agency_daily_opens" }],
    ["an unknown limit", { limit: "daily_reveals" }],
    ["a zero limit", { max: 0 }],
    ["a count riding along", { count: 6 }],
  ])("refuses %s", (_label, over) => {
    expect(validateEvent(limitEvent(over)).success).toBe(false);
  });

  it("createEvent keeps the payload whole, and the shape is pinned", () => {
    expect(createEvent(limitEvent() as never).payload).toEqual({
      payer_id: UUID_B,
      worker_id: UUID_C,
      limit: "worker_weekly_opens",
      max: 5,
    });
    expect(Object.keys(EVENT_REGISTRY["unlock.limit_reached"].payload.shape).sort()).toEqual([
      "limit",
      "max",
      "payer_id",
      "worker_id",
    ]);
  });
});
