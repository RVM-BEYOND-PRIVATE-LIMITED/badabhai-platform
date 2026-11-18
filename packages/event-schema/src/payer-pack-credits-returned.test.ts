import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";
const UUID_E = "55555555-5555-4555-8555-555555555555";
const UUID_F = "66666666-6666-4666-8666-666666666666";

/**
 * `payer.pack_credits_returned` (#2750 item 9). Ids, integers and a date, `.strict()`: no name,
 * phone, payment id or amount in rupees can ride along; `credits` is the sum of the lots.
 */
function returned(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "payer.pack_credits_returned",
    event_version: 1,
    occurred_at: "2026-11-18T10:00:00.000Z",
    actor: { actor_type: "system", actor_id: null },
    subject: { subject_type: "payer", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      payer_id: UUID_B,
      payment_order_id: UUID_C,
      credits: 12,
      lots: [
        { from_lot_id: UUID_E, lot_id: UUID_F, credits: 8 },
        { from_lot_id: UUID_F, lot_id: UUID_E, credits: 4 },
      ],
      expires_at: "2026-12-18T10:00:00.000Z",
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("payer.pack_credits_returned", () => {
  it("is a registered v1 payer event", () => {
    expect(isEventName("payer.pack_credits_returned")).toBe(true);
    expect(EVENT_REGISTRY["payer.pack_credits_returned"]).toMatchObject({
      version: 1,
      domain: "payer",
    });
  });

  it("accepts ids, integers and the new pack's expiry (or none)", () => {
    expect(validateEvent(returned()).success).toBe(true);
    expect(validateEvent(returned({ expires_at: null })).success).toBe(true);
  });

  it("refuses a total that is not the sum of the lots", () => {
    expect(validateEvent(returned({ credits: 13 })).success).toBe(false);
  });

  it("refuses an empty return and a zero-credit lot", () => {
    expect(validateEvent(returned({ credits: 0, lots: [] })).success).toBe(false);
    expect(
      validateEvent(
        returned({ credits: 0, lots: [{ from_lot_id: UUID_E, lot_id: UUID_F, credits: 0 }] }),
      ).success,
    ).toBe(false);
  });

  it("is strict: no payment id or other field rides along", () => {
    expect(validateEvent(returned({ payment_ref: "pay_123" })).success).toBe(false);
    expect(Object.keys(EVENT_REGISTRY["payer.pack_credits_returned"].payload.shape).sort()).toEqual(
      ["credits", "expires_at", "lots", "payer_id", "payment_order_id"],
    );
  });
});
