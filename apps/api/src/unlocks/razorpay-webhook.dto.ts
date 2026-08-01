import { z } from "zod";

/**
 * Zod DTOs for the Razorpay webhook boundary (invariant #7 — runtime validation at every
 * boundary, including one we do not control).
 *
 * TRUST MODEL: the signature is verified over the RAW BYTES before any of this runs
 * ({@link RazorpayWebhookGuard}). These schemas therefore validate SHAPE, not authenticity.
 * They are still strict, because "signed by Razorpay" does not mean "well-formed", and a
 * money path must never read a field it has not proven exists.
 *
 * DELIBERATELY NARROW: only the four fields the settle path needs are modelled. Razorpay's
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
  /** Amount in paise, as the provider reports it. Recorded for reconciliation only. */
  amount: z.number().int().nonnegative().optional(),
  currency: z.string().min(1).max(8).optional(),
  status: z.string().min(1).max(32).optional(),
});

/**
 * The webhook envelope. `event` is a free-form string on purpose: Razorpay adds event
 * types over time and an UNKNOWN type must be a 200 no-op, not a validation failure that
 * makes Razorpay retry forever.
 */
export const RazorpayWebhookSchema = z.object({
  event: z.string().min(1).max(128),
  payload: z
    .object({
      payment: z.object({ entity: RazorpayPaymentEntitySchema }).optional(),
    })
    .optional(),
});

export type RazorpayWebhookBody = z.infer<typeof RazorpayWebhookSchema>;

/** The normalized, provider-agnostic view the service acts on. */
export interface RazorpayPaymentEvent {
  /** Raw provider event name (e.g. `payment.captured`). */
  eventName: string;
  /** `pay_*`, or null when the delivery carried no payment entity. */
  paymentId: string | null;
  /** `order_*`, or null. Without it there is no order to settle. */
  orderId: string | null;
}

/** Provider event names this integration acts on. Anything else is an explicit no-op. */
export const RAZORPAY_CAPTURE_EVENTS = ["payment.captured"] as const;
export const RAZORPAY_FAILURE_EVENTS = ["payment.failed"] as const;

/**
 * Reduce a parsed webhook body to the three values the settle path needs. Returns nulls
 * rather than throwing so an unexpected shape degrades to a 200 no-op.
 */
export function toPaymentEvent(body: RazorpayWebhookBody): RazorpayPaymentEvent {
  const entity = body.payload?.payment?.entity;
  return {
    eventName: body.event,
    paymentId: entity?.id ?? null,
    orderId: entity?.order_id ?? null,
  };
}

/**
 * POST /payer/credits/order body — create a REAL provider order.
 *
 * XB-A: the payer is the AUTHENTICATED session payer (`req.payer.id`), so there is no
 * `payer_id` here. XT5: there is no `amount`, no `credits`, and no `currency` either — the
 * price is resolved server-side from the pricing catalog. A client cannot name its price.
 */
export const CreateCreditOrderSchema = z.object({
  pack_code: z.string().min(1).max(64),
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
