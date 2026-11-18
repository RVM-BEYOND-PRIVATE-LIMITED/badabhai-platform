import { describe, expect, it } from "vitest";

import {
  CONTACT_REACH_OUTCOMES,
  CONTACT_REACH_RESOLVERS,
  createEvent,
  EVENT_REGISTRY,
  isEventName,
  validateEvent,
} from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";
const UUID_E = "55555555-5555-4555-8555-555555555555";

/**
 * `payer.contact_reach_reported` / `payer.contact_reach_resolved` (#2750 item 7). Ids, a time,
 * closed codes and an integer, `.strict()`: no name, phone or note can ride along. A return only
 * when not reached; a deadline closure is always not reached.
 */
function envelope(name: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: name,
    event_version: 1,
    occurred_at: "2026-11-17T10:00:00.000Z",
    actor: { actor_type: "payer", actor_id: UUID_B },
    subject: { subject_type: "payer", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  };
}

const reported = (over: Record<string, unknown> = {}) =>
  envelope("payer.contact_reach_reported", {
    case_id: UUID_C,
    unlock_id: UUID_E,
    payer_id: UUID_B,
    deadline_at: "2026-11-19T10:00:00.000Z",
    ...over,
  });

const resolved = (over: Record<string, unknown> = {}) =>
  envelope("payer.contact_reach_resolved", {
    case_id: UUID_C,
    unlock_id: UUID_E,
    payer_id: UUID_B,
    status: "not_reached",
    credits_returned: 2,
    resolved_by: "desk",
    ...over,
  });

describe("payer.contact_reach_reported", () => {
  it("is registered as a version-1 event in the payer domain", () => {
    expect(isEventName("payer.contact_reach_reported")).toBe(true);
    expect(EVENT_REGISTRY["payer.contact_reach_reported"]).toMatchObject({
      version: 1,
      domain: "payer",
    });
  });

  it("accepts the case, the open, the company and the deadline", () => {
    expect(validateEvent(reported()).success).toBe(true);
  });

  it.each([
    ["a phone riding along", { phone: "9876543210" }],
    ["a non-uuid case", { case_id: "case-1" }],
    ["a non-date deadline", { deadline_at: "in two days" }],
  ])("refuses %s", (_label, over) => {
    expect(validateEvent(reported(over)).success).toBe(false);
  });

  it("the shape is pinned", () => {
    expect(Object.keys(EVENT_REGISTRY["payer.contact_reach_reported"].payload.shape).sort()).toEqual(
      ["case_id", "deadline_at", "payer_id", "unlock_id"],
    );
  });
});

describe("payer.contact_reach_resolved", () => {
  it("is registered as a version-1 event in the payer domain", () => {
    expect(isEventName("payer.contact_reach_resolved")).toBe(true);
    expect(EVENT_REGISTRY["payer.contact_reach_resolved"]).toMatchObject({
      version: 1,
      domain: "payer",
    });
  });

  it("the outcomes and resolvers are the closed sets the table's CHECKs hold", () => {
    expect([...CONTACT_REACH_OUTCOMES]).toEqual([
      "reached_interested",
      "reached_declined",
      "not_reached",
    ]);
    expect([...CONTACT_REACH_RESOLVERS]).toEqual(["desk", "deadline"]);
  });

  it("accepts each desk outcome, and a deadline closure as not reached", () => {
    expect(validateEvent(resolved()).success).toBe(true);
    expect(validateEvent(resolved({ credits_returned: 0 })).success).toBe(true);
    for (const status of ["reached_interested", "reached_declined"]) {
      expect(validateEvent(resolved({ status, credits_returned: 0 })).success).toBe(true);
    }
    expect(validateEvent(resolved({ resolved_by: "deadline" })).success).toBe(true);
  });

  it.each([
    ["credits back on a reached worker", { status: "reached_declined", credits_returned: 1 }],
    ["a deadline closure that says reached", { status: "reached_interested", credits_returned: 0, resolved_by: "deadline" }],
    ["a negative return", { credits_returned: -1 }],
    ["an open status", { status: "open" }],
    ["a note riding along", { note: "wrong number given" }],
  ])("refuses %s", (_label, over) => {
    expect(validateEvent(resolved(over)).success).toBe(false);
  });

  it("createEvent keeps the payload whole, and the shape is pinned", () => {
    expect(createEvent(resolved() as never).payload).toEqual({
      case_id: UUID_C,
      unlock_id: UUID_E,
      payer_id: UUID_B,
      status: "not_reached",
      credits_returned: 2,
      resolved_by: "desk",
    });
    expect(Object.keys(EVENT_REGISTRY["payer.contact_reach_resolved"].payload.shape).sort()).toEqual(
      ["case_id", "credits_returned", "payer_id", "resolved_by", "status", "unlock_id"],
    );
  });
});
