import { Inject, Injectable, Logger } from "@nestjs/common";
import Razorpay from "razorpay";
import { type ServerConfig, getRazorpayCredentials } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";

/**
 * The Razorpay PROVIDER seam — the only place the SDK is constructed or called.
 *
 * Keeping it behind one narrow interface means (a) the money logic in
 * {@link PaymentGateway} is testable without a network or credentials, and (b) there is
 * exactly one file to audit for "does a secret leave the process here".
 *
 * SECRET HYGIENE:
 *  - Credentials come from {@link getRazorpayCredentials}, which returns null unless real
 *    payments are FULLY configured. There is no path that reads a raw config field.
 *  - The client is built LAZILY and cached: with the flag off, the SDK is never even
 *    instantiated with a key.
 *  - Nothing here logs a credential, a request body, or a provider response. On failure we
 *    log the ERROR CLASS and the pack code only — never the message (a provider error
 *    message can echo request contents, and this call carries an amount + our order id).
 */

/** What the money path needs from the provider. Deliberately tiny — two calls. */
export interface RazorpayOrderClient {
  /** Whether a REAL provider is wired (flag + full credential set). */
  readonly isLive: boolean;
  /** The `rzp_*` key id, or null when not live. PUBLIC by design (the browser needs it). */
  readonly keyId: string | null;
  /** Create an order server-to-server. Throws on any provider failure — money never guesses. */
  createOrder(input: CreateOrderInput): Promise<CreatedOrder>;
  /**
   * Read one payment back from the provider (`GET /payments/:id`, #2749 hardening 5): the browser
   * verify path checks its captured amount before settling. Throws on any provider failure.
   */
  fetchPayment(paymentId: string): Promise<FetchedPayment>;
}

export interface CreateOrderInput {
  /** Whole ₹ (never paise) — converted at this boundary, so the rest of the app stays in ₹. */
  amountInr: number;
  /** Our own `payment_orders.id`, used as the provider receipt for reconciliation. */
  receipt: string;
  /** PII-FREE reconciliation notes: catalog code + our opaque order uuid. Nothing else. */
  notes: { pack_code: string; payment_order_id: string };
}

export interface CreatedOrder {
  /** The provider's `order_*` id — half of the payment idempotency key. */
  orderId: string;
  /**
   * The amount RAZORPAY's response says the order is for, in its subunit (paise) — the provider's
   * own number, never the one we sent (#2749): the gateway refuses the order unless it equals the
   * total it is about to stamp.
   */
  amountPaise: number;
  /** The currency Razorpay's response names. */
  currency: string;
}

/**
 * The fields of a provider payment the verify path acts on. Opaque ids, an integer amount, a
 * currency and a status; the entity's buyer contact, card and VPA fields are never read.
 */
export interface FetchedPayment {
  /** `pay_*`. */
  id: string;
  /** `order_*` the payment belongs to, or null when the provider names none. */
  orderId: string | null;
  /** Captured / authorized amount in paise, as the provider reports it. */
  amountPaise: number;
  currency: string;
  /** `created` | `authorized` | `captured` | `refunded` | `failed`. */
  status: string;
}

/**
 * #2750 item 10 — one provider refund, as the refund path reads it: the opaque `rfnd_*` id, its
 * status (`pending` | `processed` | `failed`) and the amount in paise. Nothing else is read.
 */
export interface ProviderRefund {
  id: string;
  status: string;
  amountPaise: number;
}

/**
 * A provider amount as an integer number of paise, or a thrown error. Razorpay types amounts as
 * `number | string`; anything that is not a non-negative safe integer is refused, never coerced.
 */
export function providerPaise(value: unknown): number {
  const n = typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw new Error("provider returned a non-integer amount");
  }
  return n;
}

/** Razorpay bills in paise. ONE conversion, at the provider boundary, nowhere else. */
export function inrToPaise(amountInr: number): number {
  if (!Number.isInteger(amountInr) || amountInr <= 0) {
    // A non-positive or fractional charge is a bug upstream (the catalog stores integer ₹).
    // Fail loudly rather than send a nonsense amount to a payment provider.
    throw new Error("amountInr must be a positive integer number of rupees");
  }
  return amountInr * 100;
}

/** Currency is fixed for this market; it is not a client-supplied field. */
export const RAZORPAY_CURRENCY = "INR";

@Injectable()
export class RazorpayClient implements RazorpayOrderClient {
  private readonly logger = new Logger(RazorpayClient.name);
  private client: Razorpay | null = null;

  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  get isLive(): boolean {
    return getRazorpayCredentials(this.config) !== null;
  }

  get keyId(): string | null {
    return getRazorpayCredentials(this.config)?.keyId ?? null;
  }

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    const sdk = this.resolveClient();
    const amountPaise = inrToPaise(input.amountInr);
    try {
      const order = await sdk.orders.create({
        amount: amountPaise,
        currency: RAZORPAY_CURRENCY,
        // Our own order-row uuid. Razorpay caps receipts at 40 chars; a uuid is 36.
        receipt: input.receipt,
        // PII-FREE by construction: a catalog code + an opaque uuid. No payer name/email/
        // phone is ever sent to the provider from here (Razorpay collects contact details
        // itself, on its own surface — they must not round-trip through us).
        notes: input.notes,
      });
      const orderId = typeof order.id === "string" ? order.id : "";
      if (orderId.length === 0) {
        throw new Error("provider returned an order without an id");
      }
      // RAZORPAY'S echoed amount and currency (#2749), not `amountPaise` above: the gateway
      // compares them with the total it stamps, which only means something if they are theirs.
      return {
        orderId,
        amountPaise: providerPaise(order.amount),
        currency: typeof order.currency === "string" ? order.currency : "",
      };
    } catch (err) {
      // CLASS + pack code only. A provider error body can echo the request (amount, notes)
      // and, on some error paths, buyer contact details — none of that may reach a log.
      // The logger context is already `RazorpayClient`, so the provider name adds nothing.
      this.logger.error(
        `order creation failed pack=${input.notes.pack_code} error_class=${
          err instanceof Error ? err.constructor.name : typeof err
        }`,
      );
      throw new Error("payment provider order creation failed");
    }
  }

  async fetchPayment(paymentId: string): Promise<FetchedPayment> {
    const sdk = this.resolveClient();
    try {
      const payment = await sdk.payments.fetch(paymentId);
      // Only these five fields are read. The entity also carries the buyer's email, contact, card
      // and VPA; none of it is copied, returned or logged.
      return {
        id: typeof payment.id === "string" ? payment.id : "",
        orderId: typeof payment.order_id === "string" ? payment.order_id : null,
        amountPaise: providerPaise(payment.amount),
        currency: typeof payment.currency === "string" ? payment.currency : "",
        status: typeof payment.status === "string" ? payment.status : "",
      };
    } catch (err) {
      // CLASS only, as for createOrder: a provider error body can echo payment details.
      this.logger.error(
        `payment fetch failed error_class=${err instanceof Error ? err.constructor.name : typeof err}`,
      );
      throw new Error("payment provider payment fetch failed");
    }
  }

  /**
   * #2750 item 10 — refund a captured payment IN FULL (`POST /payments/:id/refund`). The notes and
   * receipt carry only our refund row id (opaque), so a retry can find a refund already made
   * ({@link findRefundForRow}). Throws on any provider failure.
   */
  async refundPayment(input: {
    paymentId: string;
    amountPaise: number;
    refundRowId: string;
  }): Promise<ProviderRefund> {
    const sdk = this.resolveClient();
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
      throw new Error("amountPaise must be a positive integer");
    }
    try {
      const refund = await sdk.payments.refund(input.paymentId, {
        amount: input.amountPaise,
        speed: "normal",
        receipt: input.refundRowId,
        notes: { payment_refund_id: input.refundRowId },
      });
      return toProviderRefund(refund);
    } catch (err) {
      // CLASS only: a provider error body can echo payment details.
      this.logger.error(
        `refund failed refund_row=${input.refundRowId} error_class=${
          err instanceof Error ? err.constructor.name : typeof err
        }`,
      );
      throw new Error("payment provider refund failed");
    }
  }

  /**
   * #2750 item 10 — the refund on `paymentId` that names our row in its notes, or null. A retry
   * reads it first, so a refund whose answer was lost is adopted, never made twice.
   */
  async findRefundForRow(paymentId: string, refundRowId: string): Promise<ProviderRefund | null> {
    const sdk = this.resolveClient();
    try {
      const page = await sdk.payments.fetchMultipleRefund(paymentId, { count: 100 });
      const match = (page.items ?? []).find(
        (r) => (r.notes as Record<string, unknown> | undefined)?.payment_refund_id === refundRowId,
      );
      return match ? toProviderRefund(match) : null;
    } catch (err) {
      this.logger.error(
        `refund lookup failed refund_row=${refundRowId} error_class=${
          err instanceof Error ? err.constructor.name : typeof err
        }`,
      );
      throw new Error("payment provider refund lookup failed");
    }
  }

  /** Build (once) or return the SDK client. Throws when real payments are not fully enabled. */
  private resolveClient(): Razorpay {
    if (this.client) return this.client;
    const creds = getRazorpayCredentials(this.config);
    if (!creds) {
      // Unreachable via the controller (the route is gated on `isLive`), but a hard stop
      // here guarantees the SDK can never be constructed from a partial credential set.
      throw new Error("real payments are not enabled — refusing to construct a provider client");
    }
    this.client = new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret });
    return this.client;
  }
}

/** The three fields of a provider refund the refund path reads; anything malformed throws. */
function toProviderRefund(refund: { id?: unknown; status?: unknown; amount?: unknown }): ProviderRefund {
  const id = typeof refund.id === "string" ? refund.id : "";
  if (id.length === 0) throw new Error("provider returned a refund without an id");
  return {
    id,
    status: typeof refund.status === "string" ? refund.status : "",
    amountPaise: providerPaise(refund.amount),
  };
}
