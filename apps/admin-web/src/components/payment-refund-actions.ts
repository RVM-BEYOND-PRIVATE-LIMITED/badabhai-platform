"use server";

import { z } from "zod";
import { isAdminRequestError } from "../lib/admin-http";
import { describeAdminActionError } from "../lib/describe-admin-error";
import {
  getRefundEligibility,
  refundOrder,
  retryRefund,
  type RefundEligibility,
  type RefundRule,
  type RefundView,
} from "../lib/payment-refunds";

export type RefundEligibilityResult =
  | { ok: true; eligibility: RefundEligibility }
  | { ok: false; creditNotesUnavailable: boolean; error: string }
  | { ok: false; creditNotesUnavailable?: false; error: string };

export type RefundActionResult =
  | { ok: true; refund: RefundView }
  | { ok: false; creditNotesUnavailable: boolean; error: string }
  | { ok: false; creditNotesUnavailable?: false; error: string };

const reasonSchema = z.string().trim().min(15).max(500);

function creditNotesUnavailable(err: unknown): boolean {
  return (
    isAdminRequestError(err) &&
    err.status === 503 &&
    (err.body?.code === "CREDIT_NOTES_UNAVAILABLE" || err.body?.code === "REAL_PAYMENTS_OFF")
  );
}

export async function refundEligibilityAction(
  paymentOrderId: string,
  jobPostingId?: string,
): Promise<RefundEligibilityResult> {
  try {
    return { ok: true, eligibility: await getRefundEligibility(paymentOrderId, jobPostingId) };
  } catch (err) {
    if (creditNotesUnavailable(err)) {
      return {
        ok: false,
        creditNotesUnavailable: true,
        error: "Refunds open once GST credit notes are live.",
      };
    }
    return { ok: false, error: describeAdminActionError(err) };
  }
}

export async function refundOrderAction(
  paymentOrderId: string,
  input: { rule: RefundRule; reasonText: string; jobPostingId?: string },
): Promise<RefundActionResult> {
  if (!reasonSchema.safeParse(input.reasonText).success) {
    return { ok: false, error: "Reason must be 15–500 characters." };
  }
  try {
    return { ok: true, refund: await refundOrder(paymentOrderId, input) };
  } catch (err) {
    if (creditNotesUnavailable(err)) {
      return {
        ok: false,
        creditNotesUnavailable: true,
        error: "Refunds open once GST credit notes are live.",
      };
    }
    if (isAdminRequestError(err) && err.body?.code === "ALREADY_REFUNDED") {
      return { ok: false, error: "This order has already been refunded." };
    }
    if (isAdminRequestError(err) && err.body?.code === "REFUND_RULE_NOT_MET") {
      return { ok: false, error: "That refund rule is not met on this order." };
    }
    return { ok: false, error: describeAdminActionError(err) };
  }
}

export async function retryRefundAction(
  refundId: string,
  reasonText: string,
): Promise<RefundActionResult> {
  if (!reasonSchema.safeParse(reasonText).success) {
    return { ok: false, error: "Reason must be 15–500 characters." };
  }
  try {
    return { ok: true, refund: await retryRefund(refundId, reasonText) };
  } catch (err) {
    if (creditNotesUnavailable(err)) {
      return {
        ok: false,
        creditNotesUnavailable: true,
        error: "Refunds open once GST credit notes are live.",
      };
    }
    return { ok: false, error: describeAdminActionError(err) };
  }
}
