import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  PaymentRefundFailureCode,
  PaymentRefundRuleCode,
  PaymentRefundStatusCode,
} from "@badabhai/types";
import { jobPostings } from "./job";
import { paymentOrders } from "./payer";

/**
 * #2750 item 10 — the refund rule, status and failure codes. One list each in `@badabhai/types`,
 * shared by the CHECKs below, the events and the admin route.
 */
export type PaymentRefundRule = PaymentRefundRuleCode;
export type PaymentRefundStatus = PaymentRefundStatusCode;
export type PaymentRefundFailure = PaymentRefundFailureCode;

// ---------------------------------------------------------------------------
// payment_refunds — an admin refund of one real paid pack (#2750 item 10, brief 4C.12).
//
// ONE refund per order, ever (`payment_refunds_order_uq`), and it is always FULL: the order's
// whole total, GST included. The pack must be unused. The pack's credits (and any credits that came
// back with it, #2750 item 9) are removed in the same transaction that writes this row, BEFORE
// Razorpay is called, so a company can never spend credits whose money is on its way back.
// A provider failure leaves the credits removed and the row `failed`; an admin retries it.
//
// `payer_id` is the wallet (the tenant key stamped on the order). `requested_by` is the admin.
// The admin's written reason is on the `audit_logs` row, not here: no free text on this table.
// `credit_note_number` is the GST credit note's number, written by the invoices work (#2749);
// until credit notes exist the refund route refuses (owner ruling 2026-11-18).
//
// PII-FREE: ids, closed codes, integers, an opaque provider id (`rfnd_*`) and times. RLS forced,
// every role revoked (the migration's hand-written tail).
// ---------------------------------------------------------------------------
export const paymentRefunds = pgTable(
  "payment_refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentOrderId: uuid("payment_order_id")
      .notNull()
      .references(() => paymentOrders.id),
    payerId: uuid("payer_id").notNull(),
    rule: text("rule").$type<PaymentRefundRule>().notNull(),
    // Rule 2's job (the order's origin, or the one the admin named) and its applicant count.
    jobPostingId: uuid("job_posting_id").references(() => jobPostings.id, { onDelete: "set null" }),
    applicantsCounted: integer("applicants_counted"),
    requestedBy: uuid("requested_by").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    creditsRemoved: integer("credits_removed").notNull(),
    status: text("status").$type<PaymentRefundStatus>().notNull().default("requested"),
    providerRefundId: text("provider_refund_id"),
    failureCode: text("failure_code").$type<PaymentRefundFailure>(),
    creditNoteNumber: text("credit_note_number"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payment_refunds_order_uq").on(t.paymentOrderId),
    uniqueIndex("payment_refunds_provider_uq")
      .on(t.providerRefundId)
      .where(sql`${t.providerRefundId} IS NOT NULL`),
    index("payment_refunds_payer_idx").on(t.payerId, t.requestedAt.desc()),
    check("payment_refunds_rule_chk", sql`${t.rule} IN ('unused', 'low_match')`),
    check(
      "payment_refunds_status_chk",
      sql`${t.status} IN ('requested', 'pending', 'processed', 'failed')`,
    ),
    check(
      "payment_refunds_failure_chk",
      sql`(${t.status} = 'failed') = (${t.failureCode} IS NOT NULL) AND (${t.failureCode} IS NULL OR ${t.failureCode} IN ('provider_error', 'provider_failed'))`,
    ),
    check("payment_refunds_amount_chk", sql`${t.amountPaise} > 0`),
    check("payment_refunds_credits_chk", sql`${t.creditsRemoved} >= 0`),
    check(
      "payment_refunds_low_match_chk",
      sql`(${t.rule} = 'low_match') = (${t.applicantsCounted} IS NOT NULL)`,
    ),
    check(
      "payment_refunds_processed_chk",
      sql`(${t.status} = 'processed') = (${t.processedAt} IS NOT NULL) AND (${t.status} NOT IN ('pending', 'processed') OR ${t.providerRefundId} IS NOT NULL)`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by the migration's tail

export type PaymentRefundRow = typeof paymentRefunds.$inferSelect;
