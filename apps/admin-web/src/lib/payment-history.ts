import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/**
 * The COMPANY PAYMENT-HISTORY data layer — `GET /admin/payers/:id/payment-history`
 * (#2565 B11): one company's timeline answering "what have we paid for?".
 *
 * Its own module rather than a block inside `customer.ts`, for the same reason
 * `funnel.ts` is its own: one module per admin API surface, so a controller's
 * contract has exactly one mirror on this side. Everything else here follows
 * `funnel.ts` verbatim — `server-only`, `adminFetch`, and every response parsed
 * rather than trusted.
 *
 * ── MIRRORED FROM `apps/api/src/admin/admin-payment-history.dto.ts` ──────────
 * Compared, never assumed — the server owns the contract, this file re-states
 * it in zod, and a field the server adds must appear here the day it ships.
 * Screens arrive separately (#2579); this is the typed fetch + the pure copy
 * helpers the screens will read.
 *
 * ── NULL ₹ IS "NOT RECORDED", NEVER ZERO ─────────────────────────────────────
 * A row whose `amount_inr` is null is a pre-#2565 receipt (or a manual grant)
 * with no stamped price. Rendering it as ₹0 would rewrite what a past purchase
 * appears to have cost; the screens render the honest placeholder instead, and
 * `formatHistoryAmount` below is the one spelling of it.
 */

// ---------------------------------------------------------------------------
// Wire shapes (mirrored)
// ---------------------------------------------------------------------------

/** Closed on the server; open here — a new type must display, never blank the page. */
const historyItemSchema = z.object({
  id: z.string(),
  date: z.string(),
  type: z.string(),
  item: z.string(),
  credits: z.number().nullable(),
  amount_inr: z.number().nullable(),
  status: z.string(),
  provider_reference: z.string().nullable(),
  simulated: z.boolean(),
});
export type AdminPaymentHistoryItem = z.infer<typeof historyItemSchema>;

const historyTotalsSchema = z.object({
  inr_spent: z.number(),
  credits_bought: z.number(),
  credits_used: z.number(),
  balance: z.number(),
});
export type AdminPaymentHistoryTotals = z.infer<typeof historyTotalsSchema>;

/** Exported so tests can parse a captured payload through the REAL schema. */
export const paymentHistorySchema = z.object({
  payer_id: z.string(),
  member_payer_ids: z.array(z.string()),
  items: z.array(historyItemSchema),
  nextCursor: z.string().nullable(),
  totals: historyTotalsSchema,
  payments: z.object({
    mode: z.enum(["real", "mock"]),
    blocked_reason: z.string().nullable(),
  }),
});
export type AdminPaymentHistory = z.infer<typeof paymentHistorySchema>;

/**
 * One company's payment history. `:id` is ANY payer in the company — team
 * members' purchases roll up to it. `cursor`/`limit` page the timeline
 * (newest-first); totals always cover the WHOLE timeline, never the page.
 * Requires `read_entities`.
 */
export function getPaymentHistory(
  payerId: string,
  opts?: { cursor?: string; limit?: number },
) {
  const q = new URLSearchParams();
  if (opts?.cursor) q.set("cursor", opts.cursor);
  if (opts?.limit !== undefined) q.set("limit", String(opts.limit));
  const qs = q.toString();
  return adminFetch(`/admin/payers/${encodeURIComponent(payerId)}/payment-history${qs ? `?${qs}` : ""}`, {
    schema: paymentHistorySchema,
  });
}

// ---------------------------------------------------------------------------
// Pure copy helpers (no DOM, no fetch — testable like `funnel.ts`)
// ---------------------------------------------------------------------------

/**
 * The one spelling of a timeline ₹ figure. Null is "not recorded" — never ₹0,
 * never a guess from the current catalog.
 */
export function formatHistoryAmount(amountInr: number | null): string {
  if (amountInr === null) return "Not recorded";
  return `₹${amountInr.toLocaleString("en-IN")}`;
}

/**
 * The one spelling of the simulated tag. While real payments are off, every row
 * is simulated — the tag travels with the numbers so a mock rupee can never be
 * read as a real one.
 */
export function describeHistorySimulated(simulated: boolean): string {
  return simulated ? "Simulated" : "Real";
}
