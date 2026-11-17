import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, isEventName, LAUNCH_TEST_FACTORY_FIELDS, validateEvent } from "./index";

const COHORT = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const PAYER = "33333333-3333-4333-8333-333333333333";
const ORDER = "44444444-4444-4444-8444-444444444444";
const CORRELATION = "55555555-5555-4555-8555-555555555555";

/**
 * `admin.launch_test_factory_recorded` / `_updated` (#2755 item 9). The contract: ids, a count, a
 * flag and closed codes, `.strict()` — never the factory's name or phone, the link's text or a
 * worker id.
 */
function event(
  name: "admin.launch_test_factory_recorded" | "admin.launch_test_factory_updated",
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    event_id: "66666666-6666-4666-8666-666666666666",
    event_name: name,
    event_version: 1,
    occurred_at: "2026-12-01T10:00:00.000Z",
    actor: { actor_type: "admin", actor_id: ADMIN },
    subject: { subject_type: "admin_session", subject_id: ADMIN },
    source: "api",
    correlation_id: CORRELATION,
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  };
}

const recorded = (over: Record<string, unknown> = {}) =>
  event("admin.launch_test_factory_recorded", {
    cohort_id: COHORT,
    admin_id: ADMIN,
    share_count: 5,
    has_phone: true,
    payer_id: null,
    ...over,
  });
const updated = (over: Record<string, unknown> = {}) =>
  event("admin.launch_test_factory_updated", {
    cohort_id: COHORT,
    admin_id: ADMIN,
    changed: ["result"],
    result: "paid",
    payer_id: PAYER,
    payment_order_id: ORDER,
    ...over,
  });

describe("admin.launch_test_factory_recorded / _updated", () => {
  it("are registered as version-1 admin events", () => {
    for (const name of [
      "admin.launch_test_factory_recorded",
      "admin.launch_test_factory_updated",
    ]) {
      expect(isEventName(name)).toBe(true);
      expect(EVENT_REGISTRY[name as keyof typeof EVENT_REGISTRY]).toMatchObject({
        version: 1,
        domain: "admin",
      });
    }
    expect(validateEvent(recorded()).success).toBe(true);
    expect(validateEvent(updated()).success).toBe(true);
  });

  it("recorded: one to five shares; the account may be null", () => {
    expect(validateEvent(recorded({ share_count: 1, payer_id: PAYER })).success).toBe(true);
    expect(validateEvent(recorded({ share_count: 0 })).success).toBe(false);
    expect(validateEvent(recorded({ share_count: 6 })).success).toBe(false);
    expect(validateEvent(recorded({ share_count: 2.5 })).success).toBe(false);
    expect(validateEvent(recorded({ has_phone: "yes" })).success).toBe(false);
  });

  it("updated: the changed parts are closed codes, at least one, each once; the result is closed", () => {
    expect([...LAUNCH_TEST_FACTORY_FIELDS]).toEqual([
      "payment_link",
      "result",
      "payer",
      "payment_order",
    ]);
    expect(validateEvent(updated({ changed: [...LAUNCH_TEST_FACTORY_FIELDS] })).success).toBe(true);
    expect(validateEvent(updated({ changed: [] })).success).toBe(false);
    expect(validateEvent(updated({ changed: ["result", "result"] })).success).toBe(false);
    expect(validateEvent(updated({ changed: ["factory_name"] })).success).toBe(false);
    for (const result of ["pending", "paid", "declined", "no_response"]) {
      expect(validateEvent(updated({ result })).success, result).toBe(true);
    }
    expect(validateEvent(updated({ result: "refunded" })).success).toBe(false);
    expect(validateEvent(updated({ payer_id: null, payment_order_id: null })).success).toBe(true);
  });

  it("is STRICT: a name, a phone, the link's text or a worker id cannot ride along", () => {
    for (const smuggled of [
      { factory_name: "Shree Precision Works" },
      { phone: "+919876543210" },
      { payment_link_ref: "https://rzp.io/l/AbC123" },
      { worker_ids: [PAYER] },
      { note: "called twice" },
    ]) {
      const key = Object.keys(smuggled)[0];
      expect(validateEvent(recorded(smuggled)).success, key).toBe(false);
      expect(validateEvent(updated(smuggled)).success, key).toBe(false);
    }
  });

  it("refuses a non-uuid factory or admin", () => {
    expect(validateEvent(recorded({ cohort_id: "factory-1" })).success).toBe(false);
    expect(validateEvent(updated({ admin_id: "desk" })).success).toBe(false);
  });
});
