import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";
const UUID_E = "55555555-5555-4555-8555-555555555555";

/**
 * `payment.refund_requested` / `payment.refund_status_changed` (#2750 item 10). Ids, closed codes
 * and integers, `.strict()`: no reason text, provider id, buyer detail or amount in rupees can ride
 * along; a failure code exactly when the refund failed.
 */
function envelope(name: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: name,
    event_version: 1,
    occurred_at: "2026-11-18T10:00:00.000Z",
    actor: { actor_type: "admin", actor_id: UUID_B },
    subject: { subject_type: "payer", subject_id: UUID_C },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  };
}

const requested = (over: Record<string, unknown> = {}) =>
  envelope("payment.refund_requested", {
    refund_id: UUID_E,
    payment_order_id: UUID_A,
    payer_id: UUID_C,
    rule: "unused",
    amount_paise: 117900,
    credits_removed: 23,
    ...over,
  });

const changed = (over: Record<string, unknown> = {}) =>
  envelope("payment.refund_status_changed", {
    refund_id: UUID_E,
    payment_order_id: UUID_A,
    payer_id: UUID_C,
    status: "processed",
    failure_code: null,
    ...over,
  });

describe("payment.refund_requested", () => {
  it("is a registered v1 payment event", () => {
    expect(isEventName("payment.refund_requested")).toBe(true);
    expect(EVENT_REGISTRY["payment.refund_requested"]).toMatchObject({
      version: 1,
      domain: "payment",
    });
  });

  it("accepts both rules; refuses another rule, a zero amount and a negative credit count", () => {
    expect(validateEvent(requested()).success).toBe(true);
    expect(validateEvent(requested({ rule: "low_match" })).success).toBe(true);
    expect(validateEvent(requested({ rule: "partial" })).success).toBe(false);
    expect(validateEvent(requested({ amount_paise: 0 })).success).toBe(false);
    expect(validateEvent(requested({ credits_removed: -1 })).success).toBe(false);
  });

  it("is strict: no reason text or provider id rides along", () => {
    expect(validateEvent(requested({ reason_text: "wrong pack" })).success).toBe(false);
    expect(validateEvent(requested({ provider_payment_ref: "pay_1" })).success).toBe(false);
  });
});

describe("payment.refund_status_changed", () => {
  it("is a registered v1 payment event", () => {
    expect(isEventName("payment.refund_status_changed")).toBe(true);
    expect(EVENT_REGISTRY["payment.refund_status_changed"]).toMatchObject({
      version: 1,
      domain: "payment",
    });
  });

  it("pending and processed carry no failure code; failed carries one", () => {
    expect(validateEvent(changed()).success).toBe(true);
    expect(validateEvent(changed({ status: "pending" })).success).toBe(true);
    expect(
      validateEvent(changed({ status: "failed", failure_code: "provider_failed" })).success,
    ).toBe(true);
    expect(validateEvent(changed({ status: "failed" })).success).toBe(false);
    expect(validateEvent(changed({ failure_code: "provider_error" })).success).toBe(false);
  });

  it("never records the starting status, and is strict", () => {
    expect(validateEvent(changed({ status: "requested" })).success).toBe(false);
    expect(validateEvent(changed({ provider_refund_id: "rfnd_1" })).success).toBe(false);
  });
});
