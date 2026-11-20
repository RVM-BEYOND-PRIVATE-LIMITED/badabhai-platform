import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import {
  PAY_ON_JOINING_PAYMENT_STATES,
  type PayOnJoiningHireRow,
  type PayOnJoiningPaymentState,
} from "./pay-on-joining-vocabulary";

/**
 * Pay-on-joining hire records — `GET /admin/pay-on-joining-hires` (#2753 item 11; see
 * docs/api/admin-pay-on-joining-api-reference.md).
 *
 * The list is keyset-paged and strict: the three filters are optional, and every value is an id
 * or a closed payment state. The write actions live beside the page because they are governed
 * Server Actions; this module owns the read.
 */
const payOnJoiningHireSchema = z.object({
  id: z.string(),
  factory_payer_id: z.string(),
  job_posting_id: z.string().nullable(),
  worker_id: z.string(),
  partner_payer_id: z.string().nullable(),
  joined_on: z.string(),
  stay_checked_on: z.string().nullable(),
  stayed_30_days: z.boolean().nullable(),
  fee_paise: z.number().int(),
  partner_share_percent: z.number().int(),
  partner_share_paise: z.number().int(),
  invoiced_on: z.string().nullable(),
  factory_paid_on: z.string().nullable(),
  partner_paid_on: z.string().nullable(),
  note: z.string().nullable(),
  payment_state: z.enum(PAY_ON_JOINING_PAYMENT_STATES),
  created_by_admin_id: z.string(),
  updated_by_admin_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const payOnJoiningHiresPageSchema = z.object({
  items: z.array(payOnJoiningHireSchema),
  nextCursor: z.string().nullable(),
});
export type PayOnJoiningHiresPage = z.infer<typeof payOnJoiningHiresPageSchema>;

export interface PayOnJoiningHireFilters {
  factoryPayerId?: string;
  partnerPayerId?: string;
  paid?: PayOnJoiningPaymentState;
  cursor?: string;
  limit?: number;
}

/** The API's snake_case query, with empty values omitted (its DTO is strict). */
export function payOnJoiningHiresQuery(filters: PayOnJoiningHireFilters): string {
  const q = new URLSearchParams();
  if (filters.factoryPayerId) q.set("factory_payer_id", filters.factoryPayerId);
  if (filters.partnerPayerId) q.set("partner_payer_id", filters.partnerPayerId);
  if (filters.paid) q.set("paid", filters.paid);
  if (filters.cursor) q.set("cursor", filters.cursor);
  if (filters.limit !== undefined) q.set("limit", String(filters.limit));
  const query = q.toString();
  return query ? `?${query}` : "";
}

export async function listPayOnJoiningHires(
  filters: PayOnJoiningHireFilters = {},
): Promise<PayOnJoiningHiresPage> {
  return adminFetch(`/admin/pay-on-joining-hires${payOnJoiningHiresQuery(filters)}`, {
    schema: payOnJoiningHiresPageSchema,
  });
}

export type { PayOnJoiningHireRow };
