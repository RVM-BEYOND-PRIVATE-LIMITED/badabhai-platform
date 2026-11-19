import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `payment.reconciliation_failed` (#2773). The contract under test: ONE alert per failing day,
 * counts only, `.strict()` — no order or payment id can ride on the spine — and never an all-zero
 * "failure".
 */
function reconcileFailed(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "payment.reconciliation_failed",
    event_version: 1,
    occurred_at: "2026-11-19T21:30:00.000Z",
    actor: { actor_type: "system", actor_id: null },
    subject: { subject_type: "payer", subject_id: null },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      window_hours: 48,
      payments_checked: 12,
      orders_checked: 11,
      captured_not_paid: 1,
      paid_not_captured: 0,
      amount_mismatches: 0,
      captured_unknown_order: 0,
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("payment.reconciliation_failed (#2773)", () => {
  it("is a registered v1 name in the payment domain", () => {
    expect(isEventName("payment.reconciliation_failed")).toBe(true);
    expect(EVENT_REGISTRY["payment.reconciliation_failed"]).toMatchObject({
      version: 1,
      domain: "payment",
    });
  });

  it("validates a system alert on the aggregate payer subject", () => {
    expect(validateEvent(reconcileFailed()).success).toBe(true);
  });

  it.each([
    "captured_not_paid",
    "paid_not_captured",
    "amount_mismatches",
    "captured_unknown_order",
  ])("%s alone is a failure", (field) => {
    const zero = {
      captured_not_paid: 0,
      paid_not_captured: 0,
      amount_mismatches: 0,
      captured_unknown_order: 0,
    };
    expect(validateEvent(reconcileFailed({ ...zero, [field]: 2 })).success).toBe(true);
  });

  it("refuses an all-zero failure", () => {
    expect(validateEvent(reconcileFailed({ captured_not_paid: 0 })).success).toBe(false);
  });

  it("refuses an id, a negative count or a zero window (strict, counts only)", () => {
    expect(validateEvent(reconcileFailed({ payment_id: "pay_X" })).success).toBe(false);
    expect(validateEvent(reconcileFailed({ order_ids: [UUID_A] })).success).toBe(false);
    expect(validateEvent(reconcileFailed({ paid_not_captured: -1 })).success).toBe(false);
    expect(validateEvent(reconcileFailed({ window_hours: 0 })).success).toBe(false);
    expect(validateEvent(reconcileFailed({ payments_checked: 1.5 })).success).toBe(false);
  });
});
