import { z } from "zod";
import type { CreditReason, PayerRole, PaymentOrderStatus } from "@badabhai/db";

/**
 * Zod DTOs + projections for the admin FINANCE reads (BP-2) — credits, the ledger, and
 * payment orders.
 *
 * ── THE POSTURE FIELD IS THE POINT ──────────────────────────────────────────────────────
 * Every response that carries a ₹ figure also carries {@link PaymentsPosture}. While
 * `PAYMENTS_ENABLE_REAL` is false — its default, and its state today — **no rupee on this
 * surface was ever charged to anyone**. A finance screen that renders simulated money in the
 * same type as real money is the exact failure TD81 recorded on the AI side: staging looked
 * healthy for weeks behind a mocked provider because nothing said otherwise.
 *
 * It is served IN BAND rather than read from the kill-switch status route, which is
 * `toggle_kill_switch`-gated (super_admin only). An analyst can read these numbers, so the
 * caveat has to travel with the numbers — otherwise the one role most likely to put them in
 * a report is the one role that cannot see the disclaimer.
 *
 * ── PII ─────────────────────────────────────────────────────────────────────────────────
 * Opaque payer ids, integer ₹ amounts, closed enums and timestamps. `payment_ref` /
 * `provider_payment_ref` / `provider_order_id` are NOT projected: they are documented as
 * opaque, but they originate in an external system, so their contents are the one thing this
 * codebase cannot vouch for. Nothing on the screen needs them.
 */

/** Hard page cap, mirroring the entity reads. */
export const ADMIN_FINANCE_PAGE_MAX = 100;
export const ADMIN_FINANCE_PAGE_DEFAULT = 50;
/** Hard cap on the summary aggregation window. */
export const ADMIN_FINANCE_WINDOW_DAYS_MAX = 90;
export const ADMIN_FINANCE_WINDOW_DAYS_DEFAULT = 30;
/** How many payer balances the summary lists. Bounded — this is a summary, not an export. */
export const ADMIN_TOP_BALANCES = 10;

const pageShape = {
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(ADMIN_FINANCE_PAGE_MAX)
    .optional()
    .default(ADMIN_FINANCE_PAGE_DEFAULT),
};

/** GET /admin/finance/summary */
export const AdminFinanceSummaryQuerySchema = z
  .object({
    windowDays: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_FINANCE_WINDOW_DAYS_MAX)
      .optional()
      .default(ADMIN_FINANCE_WINDOW_DAYS_DEFAULT),
  })
  .strict();
export type AdminFinanceSummaryQueryDto = z.infer<typeof AdminFinanceSummaryQuerySchema>;

/** GET /admin/finance/ledger — platform-wide credit movements. */
export const AdminLedgerQuerySchema = z
  .object({
    ...pageShape,
    payerId: z.string().uuid().optional(),
    // #2749 adds `expired` (a lot's credits removed at its date) — the ledger's own reason set.
    // #2750 item 4 adds `welcome` (a verified company's welcome credits, once); item 5 adds
    // `waived` (an open the placement team's waiver paid for: a zero-credit line); item 7 adds
    // `returned` (credits a couldn't-reach case gave back).
    reason: z
      .enum([
        "pack_purchase",
        "unlock_debit",
        "refund",
        "grant",
        "expired",
        "welcome",
        "waived",
        "returned",
        "campus_conversion",
        // #2750 item 11 — an admin grant under the credit rules.
        "goodwill",
        "correction",
        "campus_conversion_reversed",
      ])
      .optional(),
  })
  .strict();
export type AdminLedgerQueryDto = z.infer<typeof AdminLedgerQuerySchema>;

/** GET /admin/finance/orders — payment orders. */
export const AdminOrdersQuerySchema = z
  .object({
    ...pageShape,
    payerId: z.string().uuid().optional(),
    // #2749 adds `held` (a capture of the wrong amount, parked for ops) — PAYMENT_ORDER_STATUSES.
    status: z.enum(["created", "paid", "failed", "held"]).optional(),
  })
  .strict();
export type AdminOrdersQueryDto = z.infer<typeof AdminOrdersQuerySchema>;

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * Whether the ₹ figures in this response describe real money.
 *
 * `mode: "mock"` means every order was settled by the mock path and no payment provider was
 * ever called. `blocked_reason` is the PII-free operational reason from the config helper —
 * a variable name and a state, never a key or a secret.
 */
export interface PaymentsPosture {
  mode: "real" | "mock";
  blocked_reason: string | null;
}

export interface AdminReasonBucket {
  reason: CreditReason;
  /** How many ledger rows carried this reason in the window. */
  movements: number;
  /** Net credit movement (signed: grants and purchases add, debits subtract). */
  credits_delta: number;
  /** Whole ₹ stamped on those rows. Null-priced legacy rows contribute 0, never a guess. */
  amount_inr: number;
}

export interface AdminBalanceRow {
  payer_id: string;
  /**
   * The role of the payer behind `payer_id` (`payers.role`), so the admin UI can link a top
   * balance straight to the Companies (`employer`) or Agencies (`agent`) page (#2106 — the same
   * field the ledger and order rows carry since #2032). Additive. `null` when `payer_id`
   * resolves to no `payers` row — `payer_credits.payer_id` carries no FK (faceless rails), so a
   * legacy opaque id can be orphaned.
   */
  payer_role: PayerRole | null;
  balance: number;
}

export interface AdminFinanceSummary {
  payments: PaymentsPosture;
  window_days: number;
  /** Credits held across every payer right now — the platform's outstanding liability. */
  outstanding_credits: number;
  /** How many payers hold a balance row at all. */
  payers_with_balance: number;
  by_reason: AdminReasonBucket[];
  /** Paid orders in the window. `amount_inr` is mock money while `payments.mode` is "mock". */
  paid_orders: { count: number; credits: number; amount_inr: number };
  /** Orders created but never settled — the abandoned-checkout signal. */
  unsettled_orders: { count: number; amount_inr: number };
  failed_orders: { count: number };
  /**
   * #2749 hardening 5 — orders whose capture did not match their total: the money was TAKEN and
   * NOTHING was granted, so each needs ops (a refund in the Razorpay dashboard). Additive.
   */
  held_orders: { count: number; amount_inr: number };
  top_balances: AdminBalanceRow[];
}

export interface AdminLedgerRow {
  id: string;
  payer_id: string;
  /**
   * The role of the payer behind `payer_id` (`payers.role`), so the admin UI can link straight
   * to the Companies (`employer`) or Agencies (`agent`) page (#2032). Additive. `null` when
   * `payer_id` resolves to no `payers` row — the column carries no FK (faceless rails), so a
   * legacy opaque id can be orphaned.
   */
  payer_role: PayerRole | null;
  delta: number;
  reason: CreditReason;
  unlock_id: string | null;
  pack_code: string | null;
  /** Whole ₹ stamped AT PURCHASE. Null on debits/grants and on every pre-0043 row. */
  price_inr: number | null;
  created_at: Date;
}

export interface AdminOrderRow {
  id: string;
  payer_id: string;
  /**
   * The role of the payer behind `payer_id` (`payers.role`), so the admin UI can link straight
   * to the Companies (`employer`) or Agencies (`agent`) page (#2032). Additive. `null` when
   * `payer_id` resolves to no `payers` row — the column carries no FK (faceless rails), so a
   * legacy opaque id can be orphaned.
   */
  payer_role: PayerRole | null;
  /** Set on every credit-pack order (the only kind today); nullable since 0176 for #2751. */
  pack_code: string | null;
  /** Whole ₹ charged — since #2749 PR 3 the GST-inclusive total. */
  amount_inr: number;
  /** #2749 — the same total in paise (additive); null on an order from before migration 0176. */
  total_paise: number | null;
  credits_granted: number;
  provider: string;
  status: PaymentOrderStatus;
  created_at: Date;
  updated_at: Date;
}

export interface AdminFinancePage<T> {
  items: T[];
  nextCursor: string | null;
  /** Repeated on every money-bearing response — see the header. */
  payments: PaymentsPosture;
}
