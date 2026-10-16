import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `profiling.turn_understood` (ADR-0057, #2311) — one typed profiling-chat message, understood.
 *
 * The contract under test: ids, a closed intent, a confidence bucket, counts and closed catalogue
 * keys — `.strict()`, so the worker's words and the model's can never ride along — plus the three
 * rules that keep the counts honest.
 */
function understood(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "profiling.turn_understood",
    event_version: 1,
    occurred_at: "2026-10-16T10:00:00.000Z",
    actor: { actor_type: "worker", actor_id: WORKER },
    subject: { subject_type: "worker", subject_id: WORKER },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      worker_id: WORKER,
      session_id: SESSION,
      intent: "statement",
      confidence_bucket: "gte90",
      fills_proposed: 3,
      fills_applied: 2,
      fill_keys: ["experience_years", "willing_to_travel"],
      edits_proposed: 0,
      page_owned_mentions: 1,
      bridge_served: true,
      pointer_served: true,
      submission_id: null,
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("profiling.turn_understood", () => {
  it("is registered at v1 in the profile domain", () => {
    expect(isEventName("profiling.turn_understood")).toBe(true);
    expect(EVENT_REGISTRY["profiling.turn_understood"].version).toBe(1);
  });

  it("accepts a well-formed turn", () => {
    expect(validateEvent(understood()).success).toBe(true);
  });

  it("refuses any key it does not declare — never the worker's words", () => {
    expect(validateEvent(understood({ text: "5 saal" })).success).toBe(false);
    expect(validateEvent(understood({ values: ["5"] })).success).toBe(false);
  });

  it("refuses an intent outside the closed set", () => {
    expect(validateEvent(understood({ intent: "smalltalk" })).success).toBe(false);
  });

  it("cannot apply more fills than were proposed, and names exactly the applied ones", () => {
    expect(validateEvent(understood({ fills_applied: 4, fill_keys: ["a", "b", "c", "d"] })).success)
      .toBe(false);
    expect(validateEvent(understood({ fill_keys: ["experience_years"] })).success).toBe(false);
  });

  it("serves the Profile-page pointer only for a page-owned mention", () => {
    expect(validateEvent(understood({ page_owned_mentions: 0 })).success).toBe(false);
    expect(
      validateEvent(understood({ page_owned_mentions: 0, pointer_served: false })).success,
    ).toBe(true);
  });
});
