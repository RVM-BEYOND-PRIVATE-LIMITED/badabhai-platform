import "server-only";
import { z } from "zod";
import { payerFetch } from "./payer-http";
import { isPayerStatus } from "./payer-errors";

/**
 * #2751 items 4 to 13 — Managed Hiring. Everything is behind `MANAGED_HIRING_ROLLOUT` and real
 * payments; every `/payer/managed-hiring/*` route answers 404 while either is off, which callers
 * treat as "do not show Managed Hiring at all".
 */

const priceSchema = z.object({
  price_inr: z.number(),
  taxable_paise: z.number(),
  gst_paise: z.number(),
  round_off_paise: z.number(),
  total_paise: z.number(),
  gst_rate_bps: z.number(),
});

export const managedHiringQuoteSchema = z.union([
  z.object({
    job_posting_id: z.string(),
    offer: z.literal("order"),
    tier: z.enum(["standard", "large"]),
    price: priceSchema,
    target_count: z.number(),
    working_days: z.number(),
    extension_days: z.number(),
    terms: z.string(),
    open_order: z
      .object({ order_id: z.string(), status: z.enum(["created", "active", "extended"]) })
      .nullable(),
  }),
  z.object({
    job_posting_id: z.string(),
    offer: z.literal("callback"),
    vacancy_band: z.string(),
    terms: z.string(),
    callback_request_id: z.string().nullable(),
  }),
]);
export type ManagedHiringQuote = z.infer<typeof managedHiringQuoteSchema>;

export const checkoutSchema = z.object({
  order_id: z.string(),
  provider_order_id: z.string(),
  key_id: z.string(),
  amount: z.number(),
  amount_inr: z.number(),
  currency: z.literal("INR"),
  price: priceSchema.omit({ price_inr: true }),
});
export type ManagedHiringCheckout = z.infer<typeof checkoutSchema>;

export const managedHiringOrderSchema = z.object({
  order_id: z.string(),
  job_posting_id: z.string(),
  tier: z.enum(["standard", "large"]),
  status: z.enum(["created", "active", "met", "extended", "closed_unmet", "cancelled"]),
  price_inr: z.number(),
  target_count: z.number(),
  confirmed_count: z.number(),
  started_at: z.string().nullable(),
  due_at: z.string().nullable(),
  extended_until: z.string().nullable(),
  ended_at: z.string().nullable(),
  terms: z.string(),
  checkout: checkoutSchema.nullable(),
  workers: z.array(z.object({ worker_id: z.string(), confirmed_at: z.string() })),
});
export type ManagedHiringOrder = z.infer<typeof managedHiringOrderSchema>;

export function getManagedHiringQuote(jobPostingId: string): Promise<ManagedHiringQuote | null> {
  return payerFetch(
    `/payer/managed-hiring/quote?job_posting_id=${encodeURIComponent(jobPostingId)}`,
    { schema: managedHiringQuoteSchema },
  ).catch((e) => {
    if (is404(e)) return null;
    throw e;
  });
}

export function listManagedHiringOrders(jobPostingId?: string): Promise<{
  orders: ManagedHiringOrder[];
}> {
  const q = jobPostingId ? `?job_posting_id=${encodeURIComponent(jobPostingId)}` : "";
  return payerFetch(`/payer/managed-hiring/orders${q}`, {
    schema: z.object({ orders: z.array(managedHiringOrderSchema) }),
  });
}

export function createManagedHiringOrder(input: {
  jobPostingId: string;
  expectedPriceInr?: number;
  idempotencyKey: string;
}): Promise<ManagedHiringCheckout> {
  return payerFetch("/payer/managed-hiring/orders", {
    method: "POST",
    idempotencyKey: input.idempotencyKey,
    body: {
      job_posting_id: input.jobPostingId,
      ...(input.expectedPriceInr !== undefined
        ? { expected_price_inr: input.expectedPriceInr }
        : {}),
      origin: "posting_flow",
    },
    schema: checkoutSchema,
  });
}

export function requestManagedHiringCallback(jobPostingId: string): Promise<{
  request_id: string;
  job_posting_id: string;
  created: boolean;
}> {
  return payerFetch("/payer/managed-hiring/callback-requests", {
    method: "POST",
    body: { job_posting_id: jobPostingId },
    schema: z.object({
      request_id: z.string(),
      job_posting_id: z.string(),
      created: z.boolean(),
    }),
  });
}

/** The start of the next IST day, worded as "by the end of <day before>". */
export function deadlineLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const dayBefore = new Date(d.getTime() - 24 * 60 * 60 * 1000);
  return `by the end of ${dayBefore.toISOString().slice(0, 10)}`;
}

function is404(e: unknown): boolean {
  return isPayerStatus(e, 404);
}
