import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const WORKER = "33333333-3333-4333-8333-333333333333";
const CORRELATION = "55555555-5555-4555-8555-555555555555";

/**
 * `admin.candidate_viewed` (ADR-0062 §3.9, #2560): an admin opened one candidate's full-detail
 * record. The contract under test: two opaque ids and nothing else. The response carries every
 * candidate field; the spine must carry none of them — no value, no field key, no name, no phone.
 */
function viewedEvent(
  payload: Record<string, unknown> = { admin_id: ADMIN, worker_id: WORKER },
): Record<string, unknown> {
  return {
    event_id: EVENT_ID,
    event_name: "admin.candidate_viewed",
    event_version: 1,
    occurred_at: "2026-11-04T10:00:00.000Z",
    actor: { actor_type: "admin", actor_id: ADMIN },
    subject: { subject_type: "worker", subject_id: WORKER },
    source: "api",
    correlation_id: CORRELATION,
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  };
}

describe("admin.candidate_viewed", () => {
  it("is registered at v1 in the admin domain", () => {
    expect(isEventName("admin.candidate_viewed")).toBe(true);
    expect(EVENT_REGISTRY["admin.candidate_viewed"].version).toBe(1);
    expect(EVENT_REGISTRY["admin.candidate_viewed"].domain).toBe("admin");
  });

  it("accepts the two opaque ids, and the validated payload carries exactly those two keys", () => {
    const result = validateEvent(viewedEvent());
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "admin.candidate_viewed") {
      expect(Object.keys(result.event.payload).sort()).toEqual(["admin_id", "worker_id"]);
    }
  });

  it("refuses a name, a phone or a field value riding along (.strict)", () => {
    for (const extra of [
      { full_name: "Ramesh Kumar" },
      { phone: "+919876543210" },
      { current_city: "Pune" },
      { fields: ["salary_expected"] },
    ]) {
      const bad = validateEvent(viewedEvent({ admin_id: ADMIN, worker_id: WORKER, ...extra }));
      expect(bad.success, JSON.stringify(extra)).toBe(false);
      if (!bad.success) expect(bad.error.stage).toBe("payload");
    }
  });

  it("refuses a non-uuid id (opaque ids only — never a name in the id slot)", () => {
    expect(validateEvent(viewedEvent({ admin_id: ADMIN, worker_id: "Ramesh Kumar" })).success).toBe(
      false,
    );
    expect(
      validateEvent(viewedEvent({ admin_id: "ops@badabhai.ai", worker_id: WORKER })).success,
    ).toBe(false);
  });

  it("requires both ids (a view with no worker or no admin is not an audit row)", () => {
    expect(validateEvent(viewedEvent({ admin_id: ADMIN })).success).toBe(false);
    expect(validateEvent(viewedEvent({ worker_id: WORKER })).success).toBe(false);
  });
});
