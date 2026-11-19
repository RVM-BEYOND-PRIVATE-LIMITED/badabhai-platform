/**
 * #2749 part 4 — TEST MODE: the Razorpay key id in use is a `rzp_test_` key (the switch-on
 * runbook's step 4b rehearsal). Test-mode payments move no money, so they get NO GST invoice and
 * take no invoice or credit-note number: the settle records `payment.invoice_not_issued` with reason
 * `test_mode`, the real checkout's invoice gate lets them through, and a refund of such an order is
 * refused with `NO_INVOICE_FOR_ORDER` before anything is numbered.
 *
 * Decided by the key id the api runs with NOW (a payment order does not record its mode). Only the
 * key ID is read — it is public by design — never the key secret.
 */
export const RAZORPAY_TEST_KEY_PREFIX = "rzp_test_";

export function isRazorpayTestKey(keyId: string | null | undefined): boolean {
  return typeof keyId === "string" && keyId.trim().startsWith(RAZORPAY_TEST_KEY_PREFIX);
}

export function isInvoiceTestMode(config: { PAYMENTS_PROVIDER_KEY?: string | null }): boolean {
  return isRazorpayTestKey(config.PAYMENTS_PROVIDER_KEY);
}
