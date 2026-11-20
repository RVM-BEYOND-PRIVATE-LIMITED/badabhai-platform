import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/**
 * #2750 items 10 and 12 — refunds of real paid credit packs (admin console).
 *
 * Mirrors `apps/api/src/payment-refunds/*`. Every call needs `refund_payments` (super_admin).
 * The routes answer 503 `CREDIT_NOTES_UNAVAILABLE` until GST credit notes are live; the screen
 * shows that plainly and disables the action.
 */

export const REFUND_RULES = ["unused", "low_match"] as const;
export type RefundRule = (typeof REFUND_RULES)[number];

export const REFUND_STATUSES = ["requested", "pending", "processed", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

const refusalSchema = z
  .enum(["pack_used", "window_passed", "no_job", "too_many_applicants"])
  .nullable();

const ruleCheckSchema = z.object({
  eligible: z.boolean(),
  until: z.string().nullable(),
  refusal: refusalSchema,
});

const lowMatchCheckSchema = ruleCheckSchema.extend({
  job_posting_id: z.string().nullable(),
  applicants: z.number().nullable(),
  needs_fewer_than: z.number(),
});

export const refundViewSchema = z.object({
  id: z.string(),
  payment_order_id: z.string(),
  payer_id: z.string(),
  rule: z.enum(REFUND_RULES),
  job_posting_id: z.string().nullable(),
  applicants_counted: z.number().nullable(),
  requested_by: z.string(),
  amount_paise: z.number(),
  credits_removed: z.number(),
  status: z.enum(REFUND_STATUSES),
  failure_code: z.string().nullable(),
  provider_refund_id: z.string().nullable(),
  credit_note_number: z.string().nullable(),
  requested_at: z.string(),
  processed_at: z.string().nullable(),
});
export type RefundView = z.infer<typeof refundViewSchema>;

export const refundEligibilitySchema = z.object({
  payment_order_id: z.string(),
  payer_id: z.string(),
  amount_paise: z.number(),
  credits: z.number(),
  purchased_at: z.string(),
  pack_unused: z.boolean(),
  refund: refundViewSchema.nullable(),
  rules: z.object({ unused: ruleCheckSchema, low_match: lowMatchCheckSchema }),
});
export type RefundEligibility = z.infer<typeof refundEligibilitySchema>;

export function getRefundEligibility(paymentOrderId: string, jobPostingId?: string) {
  const q = jobPostingId ? `?job_posting_id=${encodeURIComponent(jobPostingId)}` : "";
  return adminFetch(
    `/admin/payment-orders/${encodeURIComponent(paymentOrderId)}/refund-eligibility${q}`,
    { schema: refundEligibilitySchema },
  );
}

export function refundOrder(
  paymentOrderId: string,
  input: { rule: RefundRule; reasonText: string; jobPostingId?: string },
) {
  return adminFetch(`/admin/payment-orders/${encodeURIComponent(paymentOrderId)}/refund`, {
    method: "POST",
    body: {
      rule: input.rule,
      reason_text: input.reasonText,
      ...(input.jobPostingId ? { job_posting_id: input.jobPostingId } : {}),
    },
    schema: refundViewSchema,
  });
}

export function getRefund(refundId: string) {
  return adminFetch(`/admin/payment-refunds/${encodeURIComponent(refundId)}`, {
    schema: refundViewSchema,
  });
}

export function retryRefund(refundId: string, reasonText: string) {
  return adminFetch(`/admin/payment-refunds/${encodeURIComponent(refundId)}/retry`, {
    method: "POST",
    body: { reason_text: reasonText },
    schema: refundViewSchema,
  });
}

/** "₹1,179" from integer paise. */
export function formatPaise(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

/** The rule's plain-language refusal, never the server's raw enum. */
export function refusalCopy(refusal: string | null): string | null {
  switch (refusal) {
    case "pack_used":
      return "Credits from this pack have been used";
    case "window_passed":
      return "The refund window has passed";
    case "no_job":
      return "No job to count applicants on";
    case "too_many_applicants":
      return "Too many people applied to the job";
    default:
      return null;
  }
}
