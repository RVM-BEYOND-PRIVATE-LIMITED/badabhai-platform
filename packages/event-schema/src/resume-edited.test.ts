import { describe, expect, it } from "vitest";

import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";
const UUID_E = "55555555-5555-4555-8555-555555555555";

/**
 * `resume.edited` (#1311 backend half — the per-field extracted-correction audit event).
 *
 * Kept in its own file rather than appended to `event-schema.test.ts`: that file pins
 * long-settled behavior and this event is new. The contract under test: ids + closed
 * field enum only, never values — the corrected values live in the authored stores.
 */
function editedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "resume.edited",
    event_version: 1,
    occurred_at: "2026-09-18T10:00:00.000Z",
    actor: { actor_type: "worker", actor_id: UUID_B },
    subject: { subject_type: "profile", subject_id: UUID_C },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      worker_id: UUID_B,
      profile_id: UUID_C,
      correction_id: UUID_D,
      session_id: UUID_E,
      field: "skills",
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("resume.edited", () => {
  it("is registered as a versioned resume-domain event", () => {
    expect(isEventName("resume.edited")).toBe(true);
    expect(EVENT_REGISTRY["resume.edited"]).toMatchObject({ version: 1, domain: "resume" });
  });

  it("validates a minimal event for every correctable field", () => {
    for (const field of ["skills", "machines", "experience", "education", "certificates"]) {
      const parsed = editedEvent({ field });
      expect(validateEvent(parsed).success).toBe(true);
      expect(createEvent(parsed as never).payload).toMatchObject({ field });
    }
  });

  it("rejects an unknown field — the enum is the PII boundary", () => {
    const result = validateEvent(editedEvent({ field: "salary" }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("payload");
  });

  it("rejects non-uuid ids", () => {
    for (const bad of [{ profile_id: "not-a-uuid" }, { correction_id: 42 }]) {
      const result = validateEvent(editedEvent(bad));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("carries no corrected values — ids and the field enum only", () => {
    const event = createEvent(editedEvent() as never);
    expect(Object.keys(event.payload as Record<string, unknown>).sort()).toEqual(
      ["correction_id", "field", "profile_id", "session_id", "worker_id"].sort(),
    );
  });
});
