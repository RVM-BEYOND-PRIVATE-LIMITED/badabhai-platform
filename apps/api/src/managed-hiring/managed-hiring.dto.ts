import { createHash } from "node:crypto";
import { PAYMENT_ORDER_ORIGINS } from "@badabhai/types";
import { z } from "zod";
import { AdminPayerReasonTextSchema } from "../admin/admin-payer-logins.dto";

/**
 * #2751 items 4 to 13 — the Managed Hiring contract. The company names a JOB; the server decides the
 * tier, the price and every text. No amount, tier or worker detail is accepted from a client.
 */

/** `GET /payer/managed-hiring/quote?job_posting_id=` */
export const ManagedHiringQuoteQuerySchema = z
  .object({ job_posting_id: z.string().uuid() })
  .strict();
export type ManagedHiringQuoteQuery = z.infer<typeof ManagedHiringQuoteQuerySchema>;

/**
 * `POST /payer/managed-hiring/orders` (an `Idempotency-Key` header is REQUIRED). `expected_price_inr`
 * is the list price before GST the company confirmed on the quote (#2085: a different current price
 * is a 409 `price_mismatch`, nothing charged). `origin` records which button the checkout came from.
 */
export const CreateManagedHiringOrderSchema = z
  .object({
    job_posting_id: z.string().uuid(),
    expected_price_inr: z.number().int().positive().optional(),
    origin: z.enum(PAYMENT_ORDER_ORIGINS).optional(),
  })
  .strict();
export type CreateManagedHiringOrderDto = z.infer<typeof CreateManagedHiringOrderSchema>;

/** The digest an order's `Idempotency-Key` is bound to: every body field, in a fixed order. */
export function managedHiringOrderFingerprint(dto: CreateManagedHiringOrderDto): string {
  return createHash("sha256")
    .update(
      JSON.stringify([dto.job_posting_id, dto.expected_price_inr ?? null, dto.origin ?? null]),
    )
    .digest("hex");
}

/** `GET /payer/managed-hiring/orders?job_posting_id=` */
export const ManagedHiringOrdersQuerySchema = z
  .object({ job_posting_id: z.string().uuid().optional() })
  .strict();
export type ManagedHiringOrdersQuery = z.infer<typeof ManagedHiringOrdersQuerySchema>;

/** `POST /payer/managed-hiring/callback-requests` */
export const ManagedHiringCallbackSchema = z.object({ job_posting_id: z.string().uuid() }).strict();
export type ManagedHiringCallbackDto = z.infer<typeof ManagedHiringCallbackSchema>;

/** `GET /admin/managed-hiring/orders` — `open` = active or extended; `ended` = met, closed, cancelled. */
export const AdminManagedHiringOrdersQuerySchema = z
  .object({
    status: z.enum(["open", "ended", "all"]).default("open"),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type AdminManagedHiringOrdersQuery = z.infer<typeof AdminManagedHiringOrdersQuerySchema>;

/**
 * `POST /admin/managed-hiring/orders/:id/interest` — the worker the desk reached and his
 * confirmation note (15–500 characters, no phone, email or other hard identifier: the shared admin
 * reason rule, because the note sits on `audit_logs`, which erasure does not reach).
 */
export const AddManagedHiringInterestSchema = z
  .object({
    worker_id: z.string().uuid(),
    note: AdminPayerReasonTextSchema,
  })
  .strict();
export type AddManagedHiringInterestDto = z.infer<typeof AddManagedHiringInterestSchema>;

/** `DELETE /admin/managed-hiring/orders/:id/interest` — the worker and why he comes off. */
export const RemoveManagedHiringInterestSchema = z
  .object({
    worker_id: z.string().uuid(),
    reason_text: AdminPayerReasonTextSchema,
  })
  .strict();
export type RemoveManagedHiringInterestDto = z.infer<typeof RemoveManagedHiringInterestSchema>;

/** `GET /admin/managed-hiring/callback-requests` */
export const AdminCallbackRequestsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type AdminCallbackRequestsQuery = z.infer<typeof AdminCallbackRequestsQuerySchema>;
