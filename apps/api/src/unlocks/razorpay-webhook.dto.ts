import { z } from "zod";
import { PAYMENT_ORDER_ORIGINS } from "@badabhai/types";
import { expectedPriceInrSchema } from "../pricing/charge-price";

/**
 * Zod DTOs for the Razorpay webhook boundary (invariant #7 — runtime validation at every
 * boundary, including one we do not control).
 *
 * TRUST MODEL: the signature is verified over the RAW BYTES before any of this runs
 * ({@link RazorpayWebhookGuard}). These schemas therefore validate SHAPE, not authenticity.
 * They are still strict, because "signed by Razorpay" does not mean "well-formed", and a
 * money path must never read a field it has not proven exists.
 *
 * DELIBERATELY NARROW: only the five fields the settle path needs are modelled. Razorpay's
 * payment entity also carries `email`, `contact`, `card`, `vpa`, `bank` — buyer PII we
 * neither want nor may store (CLAUDE.md §2 #2). Not modelling them is a privacy control:
 * nothing downstream can read what the DTO does not expose. `.passthrough()` is NOT used.
 */

/** The payment entity fields we act on. Opaque ids + an integer amount + a status. */
const RazorpayPaymentEntitySchema = z.object({
  /** `pay_*` — the opaque provider payment id stored as `provider_payment_ref`. */
  id: z.string().min(1).max(128),
  /** `order_*` — the join key onto our `payment_orders` row. */
  order_id: z.string().min(1).max(128).nullable().default(null),
  /**
   * Amount in paise, as the provider reports it. Since #2749 (hardening 5) a capture's amount is
   * compared with the order's total, and a mismatch (or a capture without one) HOLDS the order and
   * grants nothing.
   */
  amount: z.number().int().nonnegative().optional(),
  currency: z.string().min(1).max(8).optional(),
  status: z.string().min(1).max(32).optional(),
});

/**
 * The webhook envelope. `event` is a free-form string on purpose: Razorpay adds event
 * types over time and an UNKNOWN type must be a 200 no-op, not a validation failure that
 * makes Razorpay retry forever.
 */
/**
 * #2750 item 10 — the refund entity of a `refund.*` delivery: the opaque `rfnd_*` id, its status and
 * the notes WE wrote (`payment_refund_id`, our row id). Nothing else is parsed.
 */
const RazorpayRefundEntitySchema = z.object({
  id: z.string().min(1).max(128),
  status: z.string().min(1).max(32).optional(),
  notes: z
    .union([
      z.object({ payment_refund_id: z.string().min(1).max(64).optional() }).passthrough(),
      z.array(z.unknown()),
    ])
    .optional(),
});

export const RazorpayWebhookSchema = z.object({
  event: z.string().min(1).max(128),
  payload: z
    .object({
      payment: z.object({ entity: RazorpayPaymentEntitySchema }).optional(),
      refund: z.object({ entity: RazorpayRefundEntitySchema }).optional(),
    })
    .optional(),
});

/** #2750 item 10 — a `refund.*` delivery, reduced to what the refund path reads. */
export interface RazorpayRefundEvent {
  eventName: string;
  /** `rfnd_*`, or null when the delivery carried no refund entity. */
  refundId: string | null;
  status: string | null;
  /** The row id we put in the refund's notes, or null. */
  notesRefundRowId: string | null;
}

/** The refund events Razorpay sends; every other `refund.*` name is acknowledged and ignored. */
export const RAZORPAY_REFUND_EVENTS = ["refund.created", "refund.processed", "refund.failed"] as const;

export function isRefundEvent(body: RazorpayWebhookBody): boolean {
  return body.event.startsWith("refund.");
}

export function toRefundEvent(body: RazorpayWebhookBody): RazorpayRefundEvent {
  const entity = body.payload?.refund?.entity;
  const notes = entity?.notes;
  const rowId =
    notes !== undefined && !Array.isArray(notes) && typeof notes.payment_refund_id === "string"
      ? notes.payment_refund_id
      : null;
  return {
    eventName: body.event,
    refundId: entity?.id ?? null,
    status: entity?.status ?? null,
    notesRefundRowId: rowId,
  };
}

export type RazorpayWebhookBody = z.infer<typeof RazorpayWebhookSchema>;

/** The normalized, provider-agnostic view the service acts on. */
export interface RazorpayPaymentEvent {
  /** Raw provider event name (e.g. `payment.captured`). */
  eventName: string;
  /** `pay_*`, or null when the delivery carried no payment entity. */
  paymentId: string | null;
  /** `order_*`, or null. Without it there is no order to settle. */
  orderId: string | null;
  /** The captured amount in paise, or null when the delivery carried none (#2749 hardening 5). */
  amountPaise: number | null;
  /** The payment currency (`INR`), or null when the delivery carried none. */
  currency: string | null;
}

/** Provider event names this integration acts on. Anything else is an explicit no-op. */
export const RAZORPAY_CAPTURE_EVENTS = ["payment.captured"] as const;
export const RAZORPAY_FAILURE_EVENTS = ["payment.failed"] as const;

/**
 * Reduce a parsed webhook body to the values the settle path needs. Returns nulls
 * rather than throwing so an unexpected shape degrades to a 200 no-op.
 */
export function toPaymentEvent(body: RazorpayWebhookBody): RazorpayPaymentEvent {
  const entity = body.payload?.payment?.entity;
  return {
    eventName: body.event,
    paymentId: entity?.id ?? null,
    orderId: entity?.order_id ?? null,
    amountPaise: entity?.amount ?? null,
    currency: entity?.currency ?? null,
  };
}

/**
 * POST /payer/credits/order body — create a REAL provider order.
 *
 * XB-A: the payer is the AUTHENTICATED session payer (`req.payer.id`), so there is no
 * `payer_id` here. XT5: there is no `amount`, no `credits`, and no `currency` either — the
 * price is resolved server-side from the pricing catalog. A client cannot name its price.
 * `expected_price_inr` (#2085) does not change that: it is never charged, it only lets the
 * server REFUSE (409 `price_mismatch`) when the confirmed ₹ is not the resolved one. It is the
 * pack's LIST price before GST (the catalogue `priceInr`), not the GST-inclusive total the order
 * charges (#2749 PR 3).
 *
 * #2749 item 9 — the purchase ORIGIN, both optional (an older client sends neither): `origin`,
 * the button that started it (`PAYMENT_ORDER_ORIGINS`), and `origin_job_posting_id`, the job
 * posting it came from. The posting is stored only when it is the caller tenant's own; any other
 * id is dropped silently (never a 404, so this route is no posting-id oracle).
 */
export const CreateCreditOrderSchema = z.object({
  pack_code: z.string().min(1).max(64),
  expected_price_inr: expectedPriceInrSchema.optional(),
  origin: z.enum(PAYMENT_ORDER_ORIGINS).optional(),
  origin_job_posting_id: z.string().uuid().optional(),
});
export type CreateCreditOrderDto = z.infer<typeof CreateCreditOrderSchema>;

/**
 * POST /payer/credits/verify body — the browser-returned checkout result.
 *
 * These three values are exactly what Razorpay Checkout hands the page on success. They are
 * UNTRUSTED input: the signature is verified server-side against the key secret, and the
 * order must belong to the session payer. Still no amount — a verified signature proves the
 * payment, and our own order row supplies what it bought.
 */
export const VerifyCreditPaymentSchema = z.object({
  razorpay_order_id: z.string().min(1).max(128),
  razorpay_payment_id: z.string().min(1).max(128),
  razorpay_signature: z.string().min(1).max(256),
});
export type VerifyCreditPaymentDto = z.infer<typeof VerifyCreditPaymentSchema>;
