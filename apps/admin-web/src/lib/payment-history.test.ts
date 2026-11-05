import { describe, expect, it } from "vitest";
import {
  describeHistorySimulated,
  formatHistoryAmount,
  paymentHistorySchema,
} from "./payment-history";

describe("payment-history contract (#2565 B11)", () => {
  it("parses a full timeline payload through the REAL schema", () => {
    const payload = {
      payer_id: "66666666-6666-4666-8666-666666666666",
      member_payer_ids: ["66666666-6666-4666-8666-666666666666"],
      items: [
        {
          id: "payment_order:o1",
          date: "2026-10-02T00:00:00.000Z",
          type: "payment_order",
          item: "pack_50",
          credits: 50,
          amount_inr: 2000,
          status: "paid",
          provider_reference: "razorpay:order_1",
          simulated: true,
        },
        {
          id: "posting_plan:p1",
          date: "2026-10-04T00:00:00.000Z",
          type: "posting_plan",
          item: "standard",
          credits: null,
          amount_inr: null,
          status: "active",
          provider_reference: null,
          simulated: true,
        },
      ],
      nextCursor: null,
      totals: { inr_spent: 2000, credits_bought: 50, credits_used: 0, balance: 99 },
      payments: { mode: "mock", blocked_reason: "PAYMENTS_ENABLE_REAL is not set" },
    };
    expect(() => paymentHistorySchema.parse(payload)).not.toThrow();
  });

  it("rejects a row that drops the simulated flag (every row carries it)", () => {
    const row = {
      id: "boost:b1",
      date: "2026-10-05T00:00:00.000Z",
      type: "boost",
      item: "boost_7",
      credits: null,
      amount_inr: 499,
      status: "active",
      provider_reference: null,
    };
    expect(() => paymentHistorySchema.parse({
      payer_id: "p",
      member_payer_ids: ["p"],
      items: [row],
      nextCursor: null,
      totals: { inr_spent: 0, credits_bought: 0, credits_used: 0, balance: 0 },
      payments: { mode: "mock", blocked_reason: null },
    })).toThrow();
  });
});

describe("payment-history copy helpers", () => {
  it("null ₹ is 'Not recorded', never ₹0", () => {
    expect(formatHistoryAmount(null)).toBe("Not recorded");
    expect(formatHistoryAmount(0)).not.toBe("Not recorded");
    expect(formatHistoryAmount(2000)).toContain("2,000");
  });

  it("simulated tag has one spelling", () => {
    expect(describeHistorySimulated(true)).toBe("Simulated");
    expect(describeHistorySimulated(false)).toBe("Real");
  });
});
