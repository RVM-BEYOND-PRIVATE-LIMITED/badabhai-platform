import { describe, expect, it } from "vitest";

import { PAYMENT_HELD_ORDER_STATUSES, PAYMENT_HOLD_REASONS } from "@badabhai/types";

import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `payment.held` (#2749 hardening 5). The contract under test: our order row, the wallet, the pack,
 * the expected and captured paise and a closed reason, `.strict()` — ids, integers and codes only,
 * so no provider payment id, buyer contact or secret can ride along.
 */
function heldEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "payment.held",
    event_version: 1,
    occurred_at: "2026-11-17T10:00:00.000Z",
    actor: { actor_type: "system", actor_id: null },
    subject: { subject_type: "payer", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      payment_order_id: UUID_C,
      payer_id: UUID_B,
      pack_code: "pack_starter",
      expected_paise: 117900,
      captured_paise: 99900,
      reason: "amount_mismatch",
      order_status: "held",
      real_call: true,
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("payment.held", () => {
  it("is registered as a version-1 event in the payment domain", () => {
    expect(isEventName("payment.held")).toBe(true);
    expect(EVENT_REGISTRY["payment.held"]).toMatchObject({ version: 1, domain: "payment" });
  });

  it.each(PAYMENT_HOLD_REASONS.map((r) => [r]))("validates a hold for %s", (reason) => {
    const event = heldEvent({
      reason,
      captured_paise: reason === "amount_missing" ? null : 99900,
    });
    expect(validateEvent(event).success).toBe(true);
    expect(createEvent(event as never).payload).toMatchObject({ reason, expected_paise: 117900 });
  });

  it("pins the payload SHAPE, the reason set and the order-status set", () => {
    const def = EVENT_REGISTRY["payment.held"];
    expect(Object.keys(def.payload.shape).sort()).toEqual([
      "captured_paise",
      "expected_paise",
      "order_status",
      "pack_code",
      "payer_id",
      "payment_order_id",
      "real_call",
      "reason",
    ]);
    expect(def.payload.shape.reason.options).toEqual([...PAYMENT_HOLD_REASONS]);
    expect(def.payload.shape.order_status.options).toEqual([...PAYMENT_HELD_ORDER_STATUSES]);
  });

  it("records a LATE mismatch on an order already paid (order_status paid), and needs the field", () => {
    expect(validateEvent(heldEvent({ order_status: "paid" })).success).toBe(true);
    const missing = heldEvent();
    delete (missing.payload as Record<string, unknown>).order_status;
    expect(validateEvent(missing).success).toBe(false);
    expect(validateEvent(heldEvent({ order_status: "created" })).success).toBe(false);
  });

  it("is STRICT: a provider payment id, a contact, a signature or a balance cannot ride along", () => {
    for (const smuggled of [
      "provider_payment_ref",
      "razorpay_payment_id",
      "email",
      "contact",
      "signature",
      "balance_after",
    ]) {
      const result = validateEvent(heldEvent({ [smuggled]: "x" }));
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("refuses a zero or fractional expectation, a negative capture, a reason outside the set", () => {
    for (const over of [
      { expected_paise: 0 },
      { expected_paise: 117900.5 },
      { captured_paise: -1 },
      { reason: "gateway_error" },
      { payment_order_id: "not-a-uuid" },
      { real_call: "yes" },
    ]) {
      expect(validateEvent(heldEvent(over)).success, JSON.stringify(over)).toBe(false);
    }
  });
});
