import { z } from "zod";
import type { PaymentsPosture } from "./admin-finance.dto";

/**
 * Zod DTOs + projections for `GET /admin/payers/:id/payment-history` (#2565 B11) —
 * ONE per-company timeline answering "what have we paid for?".
 *
 * ── WHY A NEW READ, NOT THE FINANCE SURFACE ─────────────────────────────────────
 * `GET /admin/finance/ledger|orders` are PLATFORM-wide (BP-2): every payer, one
 * reason or status at a time. An operator on the Companies page needs the opposite
 * cut — ONE company (the org, so team members' purchases roll up), EVERY money
 * shape on it (orders, ledger purchases/grants/spend, plans, boosts, capacity,
 * top-ups), in DATE order, with the totals the screen's header renders. Filtering
 * three platform endpoints client-side and re-sorting is the three-page
 * piece-together the issue retires.
 *
 * ── KEYED BY ORGANISATION ───────────────────────────────────────────────────────
 * The `:id` is any payer in the company (the founder or a team member). The
 * repository resolves the org (the founder's solo org, or the team org the payer
 * is an active member of) and scopes EVERY source predicate to ALL member
 * payer_ids in it — so a teammate's purchase rolls up to the company. A payer
 * with no org resolves to themselves alone (solo), never to an empty timeline.
 *
 * ── PII ─────────────────────────────────────────────────────────────────────────
 * Opaque payer ids, integer ₹ amounts, closed type enums, timestamps, and OPAQUE
 * provider references (a gateway order id — never card/UPI/PII, same line
 * `credit_ledger.payment_ref` has held since ADR-0010 §D5). No name/phone/email.
 *
 * ── THE SIMULATED FLAG ──────────────────────────────────────────────────────────
 * Every row carries `simulated`. While `PAYMENTS_ENABLE_REAL` is false (its
 * default, its state today) NO rupee on this surface was ever charged to anyone —
 * the same failure TD81 recorded on the AI side. The flag is served IN BAND on
 * every row AND on the response, so the "Simulated" tag the Companies page
 * renders can never disagree with the numbers beside it.
 *
 * ── RBAC ────────────────────────────────────────────────────────────────────────
 * `read_entities` (the admin read floor — the same allow-set as the finance
 * aggregates). A read is not a state change: no audit event (CLAUDE.md §1).
 */

/** Hard page cap, mirroring the finance reads. */
export const ADMIN_PAYMENT_HISTORY_PAGE_MAX = 100;
export const ADMIN_PAYMENT_HISTORY_PAGE_DEFAULT = 50;

/** GET /admin/payers/:id/payment-history query. */
export const AdminPaymentHistoryQuerySchema = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_PAYMENT_HISTORY_PAGE_MAX)
      .optional()
      .default(ADMIN_PAYMENT_HISTORY_PAGE_DEFAULT),
  })
  .strict();
export type AdminPaymentHistoryQueryDto = z.infer<typeof AdminPaymentHistoryQuerySchema>;

/** Every `:id` path param on this surface is a uuid (mirrors the entities surface). */
export const AdminPaymentHistoryParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type AdminPaymentHistoryParamsDto = z.infer<typeof AdminPaymentHistoryParamsSchema>;

/**
 * One timeline row. `amount_inr: null` is the honest "not recorded" bucket — a
 * pre-#2565 row whose purchase event carried no price, or a manual grant that has
 * no price at all. It is NEVER back-guessed from the current catalog (which would
 * retroactively rewrite what a past purchase appears to have cost).
 */
export type AdminPaymentHistoryItemType =
  | "payment_order"
  | "credit_purchase"
  | "credit_grant"
  | "credit_refund"
  | "credit_spend"
  | "posting_plan"
  | "boost"
  | "capacity_purchase"
  | "quota_topup";

export interface AdminPaymentHistoryItem {
  /** Stable row id: `<type>:<source row id>` (unique across the union). */
  id: string;
  /** When it happened — the timeline sorts on this DESC (then id DESC). */
  date: Date;
  type: AdminPaymentHistoryItemType;
  /** What was bought/spent: a pack code, a tier, a plan id — never PII. */
  item: string;
  /** Signed credit movement where one exists (purchase/grant +, spend −); else null. */
  credits: number | null;
  /** Whole ₹ stamped AT PURCHASE. Null = not recorded (see above). */
  amount_inr: number | null;
  /** Source status (`paid` / `active` / …) — the receipt's own word, not a mapping. */
  status: string;
  /** Opaque provider reference (gateway order id) where one exists; else null. */
  provider_reference: string | null;
  /** True while real payments are off — the "Simulated" tag. See the header. */
  simulated: boolean;
}

export interface AdminPaymentHistoryTotals {
  /** Whole ₹ with a stamped price across the timeline (null-priced rows add 0). */
  inr_spent: number;
  /** Credits bought (pack_purchase deltas). */
  credits_bought: number;
  /** Credits spent on unlocks (abs of unlock_debit deltas). */
  credits_used: number;
  /** Live credit balance across the org's wallets. */
  balance: number;
}

export interface AdminPaymentHistory {
  /** The company this timeline is keyed by (the resolved org anchor / solo payer). */
  payer_id: string;
  /** Every member payer_id whose purchases roll up here (incl. the anchor). */
  member_payer_ids: string[];
  items: AdminPaymentHistoryItem[];
  nextCursor: string | null;
  totals: AdminPaymentHistoryTotals;
  /** Repeated on every money-bearing response — see the header. */
  payments: PaymentsPosture;
}
