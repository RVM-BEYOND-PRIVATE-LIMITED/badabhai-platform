import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Razorpay signature verification — the ONLY thing standing between a stranger's HTTP
 * request and a free credit grant. Everything here is pure (no I/O, no DI, no logging) so
 * it can be exhaustively tested, and so it is impossible for a log line to be added inside
 * the verification path.
 *
 * WHY NOT THE SDK'S HELPER: `razorpay`'s `validateWebhookSignature` compares with `===`
 * (a short-circuiting, content-dependent string compare) and coerces the body via
 * `body.toString()`. We use `timingSafeEqual` over Buffers instead — the same primitive
 * and the same shape as {@link InternalServiceGuard} in this repo. A non-constant-time
 * compare on a money endpoint is a byte-at-a-time forgery oracle, which is exactly the
 * class of bug that makes an attacker's job feasible.
 *
 * FAIL CLOSED EVERYWHERE: a missing header, a blank secret, a malformed hex signature, or
 * a length mismatch all return `false`. There is no branch that returns `true` by default.
 */

/** The header Razorpay signs every webhook delivery with. */
export const RAZORPAY_SIGNATURE_HEADER = "x-razorpay-signature";

/** Lowercase hex of HMAC-SHA256(message, secret). Internal — never returned to a caller. */
function hmacHex(message: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Constant-time compare of two hex digests.
 *
 * The length check short-circuits (it leaks only the LENGTH of the provided signature,
 * which is public — SHA-256 hex is always 64 chars). The byte comparison itself is
 * constant-time, so an attacker learns nothing about WHERE their forgery diverged and
 * cannot walk the digest one byte at a time.
 */
function digestsMatch(expectedHex: string, providedHex: string): boolean {
  const expected = Buffer.from(expectedHex, "utf8");
  const provided = Buffer.from(providedHex, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/** A secret is usable only if it is a non-blank string (an empty secret must never verify). */
function usableSecret(secret: string | undefined | null): secret is string {
  return typeof secret === "string" && secret.trim().length > 0;
}

/**
 * Normalize the incoming signature header value.
 *
 * Node gives `string | string[] | undefined` for a header. A DUPLICATED header (array) is
 * rejected outright rather than "take the first": header smuggling that supplies two
 * signatures must not be resolvable in the attacker's favour by our choice of index.
 */
function normalizeSignatureHeader(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Verify a Razorpay WEBHOOK: HMAC-SHA256 over the RAW REQUEST BYTES, keyed by the webhook
 * secret, compared constant-time against `x-razorpay-signature`.
 *
 * RAW BYTES, NOT A RE-SERIALIZED OBJECT. `JSON.stringify(JSON.parse(body))` is NOT the
 * body Razorpay signed: key order, unicode escaping, and float formatting all differ. A
 * re-serialized body would fail verification for legitimate deliveries and, worse, would
 * tempt someone to "fix" it by weakening the check. This function only ever accepts a
 * Buffer for that reason.
 *
 * @param rawBody the exact bytes read off the wire (see razorpay-raw-body.middleware.ts)
 * @param signatureHeader the raw `x-razorpay-signature` header value (may be absent)
 * @param webhookSecret RAZORPAY_WEBHOOK_SECRET
 */
export function verifyWebhookSignature(
  rawBody: Buffer | undefined | null,
  signatureHeader: unknown,
  webhookSecret: string | undefined | null,
): boolean {
  if (!Buffer.isBuffer(rawBody)) return false; // no raw body captured ⇒ cannot verify ⇒ reject
  if (!usableSecret(webhookSecret)) return false; // blank/absent secret NEVER verifies
  const provided = normalizeSignatureHeader(signatureHeader);
  if (provided === null) return false;
  return digestsMatch(hmacHex(rawBody, webhookSecret), provided);
}

/**
 * Verify the BROWSER-returned checkout signature (the `POST /payer/credits/verify` path).
 *
 * Razorpay Checkout hands the client `razorpay_signature = HMAC-SHA256("<order_id>|<payment_id>",
 * key_secret)`. The pipe-joined message is fixed by Razorpay's spec — do not reorder it.
 *
 * This proves the client is relaying a genuine Razorpay success, but it is NOT the source
 * of truth for capture (the webhook is): a client can withhold this call entirely. It
 * exists so a payer on a flaky connection is credited immediately instead of being shown a
 * false failure while the webhook is still in flight.
 */
export function verifyCheckoutSignature(
  input: { orderId: string; paymentId: string; signature: string },
  keySecret: string | undefined | null,
): boolean {
  if (!usableSecret(keySecret)) return false;
  const provided = normalizeSignatureHeader(input.signature);
  if (provided === null) return false;
  // Both ids must be non-blank: an empty component would make the signed message ambiguous
  // (e.g. "|pay_x" and "" + "|pay_x" collide), which is a forgery surface, not a nicety.
  if (input.orderId.trim().length === 0 || input.paymentId.trim().length === 0) return false;
  return digestsMatch(hmacHex(`${input.orderId}|${input.paymentId}`, keySecret), provided);
}

/**
 * Test/ops helper: produce the signature Razorpay WOULD send for a body + secret.
 *
 * Exported so the test suite signs its own fixtures with the real primitive instead of
 * hard-coding a digest (a hard-coded digest silently stops testing anything the day the
 * message construction changes). It is never called on a request path.
 */
export function signWebhookBodyForTest(rawBody: Buffer | string, webhookSecret: string): string {
  return hmacHex(rawBody, webhookSecret);
}

/** Test/ops helper: the checkout signature for an (order, payment) pair. See above. */
export function signCheckoutForTest(orderId: string, paymentId: string, keySecret: string): string {
  return hmacHex(`${orderId}|${paymentId}`, keySecret);
}
