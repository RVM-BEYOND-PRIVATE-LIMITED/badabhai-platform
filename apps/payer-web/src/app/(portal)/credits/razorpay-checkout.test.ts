import { describe, expect, it } from "vitest";
import { toCheckoutResult } from "./razorpay-checkout";

/**
 * CHECKOUT OUTCOME MAPPING — the one place a browser result becomes "the payer succeeded".
 *
 * The failure this pins: mapping an incomplete handler response to a success would show a
 * payer "payment successful" and then send blank ids to /verify, which correctly rejects
 * them — leaving the UI having already lied. Fail closed: only three non-empty strings
 * count as success.
 */
describe("toCheckoutResult — only a COMPLETE response is a success", () => {
  it("maps a full, well-formed response to success", () => {
    expect(
      toCheckoutResult({
        razorpay_order_id: "order_1",
        razorpay_payment_id: "pay_1",
        razorpay_signature: "sig_1",
      }),
    ).toEqual({ outcome: "success", orderId: "order_1", paymentId: "pay_1", signature: "sig_1" });
  });

  it("treats a MISSING field as a failure, not a success with blanks", () => {
    expect(
      toCheckoutResult({ razorpay_order_id: "order_1", razorpay_payment_id: "pay_1" }),
    ).toEqual({ outcome: "failed" });
    expect(toCheckoutResult({ razorpay_order_id: "order_1", razorpay_signature: "s" })).toEqual({
      outcome: "failed",
    });
    expect(toCheckoutResult({})).toEqual({ outcome: "failed" });
  });

  it("treats an EMPTY-STRING field as a failure", () => {
    expect(
      toCheckoutResult({
        razorpay_order_id: "",
        razorpay_payment_id: "pay_1",
        razorpay_signature: "sig_1",
      }),
    ).toEqual({ outcome: "failed" });
    expect(
      toCheckoutResult({
        razorpay_order_id: "order_1",
        razorpay_payment_id: "pay_1",
        razorpay_signature: "",
      }),
    ).toEqual({ outcome: "failed" });
  });

  it("treats a NON-STRING field as a failure (a hostile/odd provider response)", () => {
    expect(
      toCheckoutResult({
        razorpay_order_id: 123,
        razorpay_payment_id: "pay_1",
        razorpay_signature: "sig_1",
      }),
    ).toEqual({ outcome: "failed" });
    expect(
      toCheckoutResult({
        razorpay_order_id: "order_1",
        razorpay_payment_id: { nested: true },
        razorpay_signature: "sig_1",
      }),
    ).toEqual({ outcome: "failed" });
  });
});
