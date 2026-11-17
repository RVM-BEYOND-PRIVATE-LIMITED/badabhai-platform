/**
 * #2749 item 9 — the payment-order sets. `packages/db` spells the product kinds, statuses and
 * origins into CHECKs on `payment_orders` (its migration-0176 test pins those copies to these), and
 * `payment.held` takes its reason enum from the hold reasons, so this file pins the sets themselves.
 */
import { describe, expect, it } from "vitest";

import {
  PAYMENT_HELD_ORDER_STATUSES,
  PAYMENT_HOLD_REASONS,
  PAYMENT_ORDER_ORIGINS,
  PAYMENT_ORDER_PRODUCT_KINDS,
  PAYMENT_ORDER_STATUSES,
  isPaymentOrderOrigin,
  isPaymentOrderStatus,
} from "./index";

describe("payment order sets", () => {
  it("one product kind today (#2751 widens it), frozen", () => {
    expect(PAYMENT_ORDER_PRODUCT_KINDS).toEqual(["credit_pack"]);
    expect(Object.isFrozen(PAYMENT_ORDER_PRODUCT_KINDS)).toBe(true);
  });

  it("the four statuses, `held` last, frozen", () => {
    expect(PAYMENT_ORDER_STATUSES).toEqual(["created", "paid", "failed", "held"]);
    expect(Object.isFrozen(PAYMENT_ORDER_STATUSES)).toBe(true);
  });

  it("the six purchase origins, frozen", () => {
    expect(PAYMENT_ORDER_ORIGINS).toEqual([
      "credits_page",
      "unlock_prompt",
      "candidate_search",
      "posting_flow",
      "dashboard",
      "other",
    ]);
    expect(Object.isFrozen(PAYMENT_ORDER_ORIGINS)).toBe(true);
  });

  it("the hold reasons, frozen (payment.held v1)", () => {
    expect(PAYMENT_HOLD_REASONS).toEqual([
      "amount_mismatch",
      "amount_missing",
      "currency_mismatch",
    ]);
    expect(Object.isFrozen(PAYMENT_HOLD_REASONS)).toBe(true);
  });

  it("a mismatched capture leaves the order held, or finds it already paid (payment.held v1)", () => {
    expect(PAYMENT_HELD_ORDER_STATUSES).toEqual(["held", "paid"]);
    expect(Object.isFrozen(PAYMENT_HELD_ORDER_STATUSES)).toBe(true);
  });

  it("the guards admit their set and nothing else", () => {
    for (const s of PAYMENT_ORDER_STATUSES) expect(isPaymentOrderStatus(s)).toBe(true);
    for (const o of PAYMENT_ORDER_ORIGINS) expect(isPaymentOrderOrigin(o)).toBe(true);
    for (const other of ["Paid", "refunded", "", null, undefined, 0, {}]) {
      expect(isPaymentOrderStatus(other)).toBe(false);
      expect(isPaymentOrderOrigin(other)).toBe(false);
    }
  });
});
