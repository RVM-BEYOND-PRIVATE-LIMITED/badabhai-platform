import { Inject, Injectable, Logger } from "@nestjs/common";
import Razorpay from "razorpay";
import { type ServerConfig, getRazorpayCredentials } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RAZORPAY_PROVIDER } from "./payment-orders.table";

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

/** What the money path needs from the provider. Deliberately tiny — one call. */
export interface RazorpayOrderClient {
  /** Whether a REAL provider is wired (flag + full credential set). */
  readonly isLive: boolean;
  /** The `rzp_*` key id, or null when not live. PUBLIC by design (the browser needs it). */
  readonly keyId: string | null;
  /** Create an order server-to-server. Throws on any provider failure — money never guesses. */
  createOrder(input: CreateOrderInput): Promise<CreatedOrder>;
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
  /** Echoed amount in the provider's subunit (paise), for the checkout handoff. */
  amountPaise: number;
  currency: string;
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
      return { orderId, amountPaise, currency: RAZORPAY_CURRENCY };
    } catch (err) {
      // CLASS + pack code only. A provider error body can echo the request (amount, notes)
      // and, on some error paths, buyer contact details — none of that may reach a log.
      this.logger.error(
        `razorpay order creation failed provider=${RAZORPAY_PROVIDER} pack=${input.notes.pack_code} error_class=${
          err instanceof Error ? err.constructor.name : typeof err
        }`,
      );
      throw new Error("payment provider order creation failed");
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
