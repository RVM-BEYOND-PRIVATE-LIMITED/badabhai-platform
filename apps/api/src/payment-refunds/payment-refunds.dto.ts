import { z } from "zod";
import { PAYMENT_REFUND_RULES } from "@badabhai/types";
import { AdminPayerReasonTextSchema } from "../admin/admin-payer-logins.dto";

/**
 * #2750 item 10 — `POST /admin/payment-orders/:id/refund`. The admin names the rule the refund is
 * made under and writes why (the shared admin reason rule: 15–500 characters, no hard identifiers).
 * `job_posting_id` is rule 2's job when the order names none, or another of the company's jobs;
 * absent, the order's own origin job is counted.
 */
export const RefundPaymentSchema = z
  .object({
    rule: z.enum(PAYMENT_REFUND_RULES),
    reason_text: AdminPayerReasonTextSchema,
    job_posting_id: z.string().uuid().optional(),
  })
  .strict();
export type RefundPaymentDto = z.infer<typeof RefundPaymentSchema>;

/** `GET /admin/payment-orders/:id/refund-eligibility` — rule 2's job, when not the order's own. */
export const RefundEligibilityQuerySchema = z
  .object({
    job_posting_id: z.string().uuid().optional(),
  })
  .strict();
export type RefundEligibilityQuery = z.infer<typeof RefundEligibilityQuerySchema>;

/** `POST /admin/payment-refunds/:id/retry` — a failed refund sent to Razorpay again, and why. */
export const RetryRefundSchema = z
  .object({
    reason_text: AdminPayerReasonTextSchema,
  })
  .strict();
export type RetryRefundDto = z.infer<typeof RetryRefundSchema>;
