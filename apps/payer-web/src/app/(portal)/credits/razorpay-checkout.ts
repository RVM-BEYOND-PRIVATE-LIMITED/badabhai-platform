/**
 * Razorpay Checkout browser loader — the ONLY place `checkout.js` is touched.
 *
 * Kept out of the component so the outcome mapping is unit-testable without a DOM: the
 * thing that matters here is that a DISMISS and a FAILURE are distinguishable from a
 * SUCCESS, and that neither is ever reported as a success.
 *
 * NO SECRET LIVES HERE. The only Razorpay value the browser receives is the `rzp_*` KEY
 * ID, which arrives on the order response from our API (not a `NEXT_PUBLIC_*` build
 * value). The key secret and the webhook secret exist only on the API server.
 */

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

/** What the browser hands back on a successful checkout. Verified SERVER-side afterwards. */
export interface CheckoutSuccess {
  outcome: "success";
  orderId: string;
  paymentId: string;
  signature: string;
}

/** The payer closed the modal. NOT an error, and definitely not a success. */
export interface CheckoutDismissed {
  outcome: "dismissed";
}

/** Razorpay reported a failed payment, or the script could not be loaded/opened. */
export interface CheckoutFailed {
  outcome: "failed";
}

export type CheckoutResult = CheckoutSuccess | CheckoutDismissed | CheckoutFailed;

export interface CheckoutOptions {
  orderId: string;
  keyId: string;
  amount: number; // paise
  currency: string;
  name: string;
  description: string;
}

interface RazorpayHandlerResponse {
  razorpay_order_id?: unknown;
  razorpay_payment_id?: unknown;
  razorpay_signature?: unknown;
}

interface RazorpayInstance {
  open: () => void;
  on: (event: string, handler: () => void) => void;
}

type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

/** Inject `checkout.js` once; resolves false if it cannot be loaded (offline, blocked). */
export function loadCheckoutScript(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);

  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(Boolean(window.Razorpay)));
      existing.addEventListener("error", () => resolve(false));
      return;
    }
    const script = document.createElement("script");
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = () => resolve(Boolean(window.Razorpay));
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

/**
 * Map a raw Razorpay handler response to our result type.
 *
 * FAIL CLOSED: anything missing or non-string is a FAILURE, not a success with blanks —
 * an empty signature would otherwise be sent to the server and (correctly) rejected there,
 * but the payer would have been shown a success first. Exported for direct unit testing.
 */
export function toCheckoutResult(response: RazorpayHandlerResponse): CheckoutResult {
  const {
    razorpay_order_id: order,
    razorpay_payment_id: payment,
    razorpay_signature: sig,
  } = response;
  if (
    typeof order === "string" &&
    order.length > 0 &&
    typeof payment === "string" &&
    payment.length > 0 &&
    typeof sig === "string" &&
    sig.length > 0
  ) {
    return { outcome: "success", orderId: order, paymentId: payment, signature: sig };
  }
  return { outcome: "failed" };
}

/**
 * Open Razorpay Checkout and resolve with the outcome. Resolves EXACTLY ONCE: the first of
 * success / dismiss / failure wins, so a `payment.failed` event followed by the modal close
 * cannot flip a settled outcome.
 */
export function openCheckout(options: CheckoutOptions): Promise<CheckoutResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: CheckoutResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const Ctor = typeof window !== "undefined" ? window.Razorpay : undefined;
    if (!Ctor) {
      settle({ outcome: "failed" });
      return;
    }

    // Brand the provider's hosted form with the deep-blue structure step (`--blue-500`).
    // Razorpay paints WHITE text on `theme.color`, so haldi/marigold would fail contrast — the
    // deep blue is the safe brand step. Read from the DESIGN TOKEN at runtime (mirrors
    // `syncThemeColorMeta` in lib/theme.ts) rather than hardcoding a hex, so it flows through
    // the token layer; if the token can't be resolved we omit `theme` and let Razorpay default.
    const brandColor =
      typeof getComputedStyle !== "undefined" && typeof document !== "undefined"
        ? getComputedStyle(document.documentElement).getPropertyValue("--blue-500").trim()
        : "";

    try {
      const rzp = new Ctor({
        key: options.keyId, // PUBLIC key id — never the secret
        order_id: options.orderId,
        amount: options.amount,
        currency: options.currency,
        name: options.name,
        description: options.description,
        ...(brandColor ? { theme: { color: brandColor } } : {}),
        // NO `prefill` block: we deliberately do not push the payer's name/email/phone
        // into the provider's form from our side (CLAUDE.md §2 #2). Razorpay collects
        // whatever it needs on its own surface.
        handler: (response: RazorpayHandlerResponse) => settle(toCheckoutResult(response)),
        modal: {
          // The payer closed the modal without paying. Honest, distinct outcome.
          ondismiss: () => settle({ outcome: "dismissed" }),
        },
      });
      rzp.on("payment.failed", () => settle({ outcome: "failed" }));
      rzp.open();
    } catch {
      settle({ outcome: "failed" });
    }
  });
}
