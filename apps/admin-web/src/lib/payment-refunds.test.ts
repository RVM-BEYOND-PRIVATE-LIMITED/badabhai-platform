import { describe, expect, it } from "vitest";
import {
  formatPaise,
  refusalCopy,
  refundEligibilitySchema,
  refundViewSchema,
} from "./payment-refunds";

const refund = {
  id: "r-1",
  payment_order_id: "o-1",
  payer_id: "p-1",
  rule: "unused",
  job_posting_id: null,
  applicants_counted: null,
  requested_by: "a-1",
  amount_paise: 117900,
  credits_removed: 23,
  status: "processed",
  failure_code: null,
  provider_refund_id: "rfnd_1",
  credit_note_number: "CN-1",
  requested_at: "2026-11-18T00:00:00.000Z",
  processed_at: "2026-11-18T00:05:00.000Z",
};

describe("#2750 refunds — wire parsing + operator copy", () => {
  it("parses a refund and the eligibility view including both rules", () => {
    expect(refundViewSchema.parse(refund).status).toBe("processed");
    const view = refundEligibilitySchema.parse({
      payment_order_id: "o-1",
      payer_id: "p-1",
      amount_paise: 117900,
      credits: 23,
      purchased_at: "2026-11-17T00:00:00.000Z",
      pack_unused: true,
      refund: null,
      rules: {
        unused: { eligible: true, until: "2026-11-24T00:00:00.000Z", refusal: null },
        low_match: {
          eligible: false,
          until: "2026-11-24T00:00:00.000Z",
          refusal: "too_many_applicants",
          job_posting_id: "j-1",
          applicants: 3,
          needs_fewer_than: 3,
        },
      },
    });
    expect(view.rules.low_match.applicants).toBe(3);
  });

  it("formats paise as whole rupees, and never shows a raw refusal code", () => {
    expect(formatPaise(117900)).toBe("₹1,179");
    expect(refusalCopy("too_many_applicants")).toBe("Too many people applied to the job");
    expect(refusalCopy("window_passed")).toBe("The refund window has passed");
    expect(refusalCopy(null)).toBeNull();
  });
});
