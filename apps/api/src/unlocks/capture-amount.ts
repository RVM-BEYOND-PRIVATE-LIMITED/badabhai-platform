import type { PaymentOrder } from "@badabhai/db";
import type { PaymentHoldReason } from "@badabhai/types";
import { RAZORPAY_CURRENCY } from "./razorpay.client";

/**
 * #2749 hardening 5 — DOES A CAPTURE MATCH ITS ORDER? Pure: no I/O.
 *
 * A Razorpay order is fixed-amount (partial payments are off), so a genuine capture carries exactly
 * the order's amount. Anything else — a different number of paise, no amount at all, a currency
 * other than INR — means the order and the money disagree, and the settle path then grants NOTHING
 * and holds the order for ops instead (`PaymentGateway.settleOrder`). Fail closed: an absent
 * amount is a hold, never a pass.
 */

/** What a webhook capture reported. Both may be absent from a delivery. */
export interface CapturedAmount {
  /** Captured paise, as the provider reported them; null when the delivery carried none. */
  readonly amountPaise: number | null;
  /** The payment currency; null when the delivery carried none (then only the amount is checked). */
  readonly currency: string | null;
}

/** Why a capture does not match its order, with both amounts (numbers only, no secrets). */
export interface CaptureMismatch {
  readonly reason: PaymentHoldReason;
  readonly expectedPaise: number;
  readonly capturedPaise: number | null;
}

/**
 * The paise an order expects to be captured: its stamped `total_paise` (#2749, migration 0176), or
 * `amount_inr` × 100 for an order created before the paise columns existed — exactly what the build
 * that created it asked Razorpay for (`inrToPaise(amount_inr)`).
 */
export function expectedOrderPaise(order: Pick<PaymentOrder, "totalPaise" | "amountInr">): number {
  return order.totalPaise ?? order.amountInr * 100;
}

/** Null when `captured` matches `order`; otherwise why not. */
export function captureMismatch(
  order: Pick<PaymentOrder, "totalPaise" | "amountInr">,
  captured: CapturedAmount,
): CaptureMismatch | null {
  const expectedPaise = expectedOrderPaise(order);
  const capturedPaise = captured.amountPaise;
  if (capturedPaise === null) return { reason: "amount_missing", expectedPaise, capturedPaise };
  if (captured.currency !== null && captured.currency !== RAZORPAY_CURRENCY) {
    return { reason: "currency_mismatch", expectedPaise, capturedPaise };
  }
  if (capturedPaise !== expectedPaise) {
    return { reason: "amount_mismatch", expectedPaise, capturedPaise };
  }
  return null;
}
