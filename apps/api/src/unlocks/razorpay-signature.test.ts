import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  RAZORPAY_SIGNATURE_HEADER,
  signCheckoutForTest,
  signWebhookBodyForTest,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "./razorpay-signature";

/**
 * SIGNATURE VERIFICATION — the single control standing between an anonymous HTTP request
 * and a free credit grant. Every failure mode is asserted individually, because "it accepts
 * the valid case" is the one property a broken verifier also has.
 */

const WEBHOOK_SECRET = "whsec_test_abcdefghijklmnop";
const KEY_SECRET = "rzp_key_secret_test";
const BODY = Buffer.from(
  JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: { entity: { id: "pay_ABC123", order_id: "order_XYZ789", amount: 200000 } },
    },
  }),
  "utf8",
);

describe("verifyWebhookSignature — the webhook credential", () => {
  it("ACCEPTS a genuine signature over the raw bytes", () => {
    const sig = signWebhookBodyForTest(BODY, WEBHOOK_SECRET);
    expect(verifyWebhookSignature(BODY, sig, WEBHOOK_SECRET)).toBe(true);
  });

  it("REJECTS a TAMPERED BODY (one byte changed, signature untouched)", () => {
    const sig = signWebhookBodyForTest(BODY, WEBHOOK_SECRET);
    // The attack this blocks: replay a real delivery with the amount/order swapped.
    const tampered = Buffer.from(BODY.toString("utf8").replace("order_XYZ789", "order_ATTACK"));
    expect(tampered.equals(BODY)).toBe(false);
    expect(verifyWebhookSignature(tampered, sig, WEBHOOK_SECRET)).toBe(false);
  });

  it("REJECTS a TAMPERED SIGNATURE (body untouched, one hex char flipped)", () => {
    const sig = signWebhookBodyForTest(BODY, WEBHOOK_SECRET);
    const flipped = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
    expect(flipped).not.toBe(sig);
    expect(verifyWebhookSignature(BODY, flipped, WEBHOOK_SECRET)).toBe(false);
  });

  it("REJECTS a signature made with the WRONG SECRET (an attacker's own HMAC)", () => {
    const forged = createHmac("sha256", "attacker_secret").update(BODY).digest("hex");
    expect(verifyWebhookSignature(BODY, forged, WEBHOOK_SECRET)).toBe(false);
  });

  it("REJECTS a MISSING header (undefined / null / empty / whitespace)", () => {
    for (const missing of [undefined, null, "", "   "]) {
      expect(verifyWebhookSignature(BODY, missing, WEBHOOK_SECRET)).toBe(false);
    }
  });

  it("REJECTS a DUPLICATED header (array) — header smuggling is never resolved in the caller's favour", () => {
    const sig = signWebhookBodyForTest(BODY, WEBHOOK_SECRET);
    // Node surfaces a repeated header as an array. Taking [0] or [last] would let an
    // attacker append a valid-looking value; we refuse the whole request instead.
    expect(verifyWebhookSignature(BODY, [sig, "garbage"], WEBHOOK_SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, ["garbage", sig], WEBHOOK_SECRET)).toBe(false);
  });

  it("REJECTS when the SECRET is absent or blank (an empty secret can never verify — TD67)", () => {
    const sig = signWebhookBodyForTest(BODY, WEBHOOK_SECRET);
    for (const blank of [undefined, null, "", "   ", "\t"]) {
      expect(verifyWebhookSignature(BODY, sig, blank)).toBe(false);
    }
    // …and a body signed with the EMPTY string as key must not verify against a blank secret.
    const emptyKeySig = createHmac("sha256", "").update(BODY).digest("hex");
    expect(verifyWebhookSignature(BODY, emptyKeySig, "")).toBe(false);
  });

  it("REJECTS when NO RAW BODY was captured (never falls back to a re-serialized body)", () => {
    const sig = signWebhookBodyForTest(BODY, WEBHOOK_SECRET);
    expect(verifyWebhookSignature(undefined, sig, WEBHOOK_SECRET)).toBe(false);
    expect(verifyWebhookSignature(null, sig, WEBHOOK_SECRET)).toBe(false);
  });

  it("is byte-exact: a re-serialized (key-reordered) body does NOT verify", () => {
    // This is why the raw bytes are captured at all. JSON.stringify(JSON.parse(x)) is a
    // different byte sequence whenever key order or escaping differs.
    const original = Buffer.from('{"b":1,"a":2}', "utf8");
    const sig = signWebhookBodyForTest(original, WEBHOOK_SECRET);
    const reserialized = Buffer.from(JSON.stringify({ a: 2, b: 1 }), "utf8");
    expect(verifyWebhookSignature(original, sig, WEBHOOK_SECRET)).toBe(true);
    expect(verifyWebhookSignature(reserialized, sig, WEBHOOK_SECRET)).toBe(false);
  });

  it("REJECTS a truncated or padded signature (length mismatch short-circuits safely)", () => {
    const sig = signWebhookBodyForTest(BODY, WEBHOOK_SECRET);
    expect(verifyWebhookSignature(BODY, sig.slice(0, -1), WEBHOOK_SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, `${sig}0`, WEBHOOK_SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, "", WEBHOOK_SECRET)).toBe(false);
  });

  it("tolerates surrounding whitespace in the header (proxies trim/pad header values)", () => {
    const sig = signWebhookBodyForTest(BODY, WEBHOOK_SECRET);
    expect(verifyWebhookSignature(BODY, `  ${sig}  `, WEBHOOK_SECRET)).toBe(true);
  });

  it("verifies an EMPTY body correctly (no special-casing that could bypass the check)", () => {
    const empty = Buffer.alloc(0);
    const sig = signWebhookBodyForTest(empty, WEBHOOK_SECRET);
    expect(verifyWebhookSignature(empty, sig, WEBHOOK_SECRET)).toBe(true);
    expect(verifyWebhookSignature(empty, "deadbeef", WEBHOOK_SECRET)).toBe(false);
  });

  it("pins the header name Razorpay actually sends", () => {
    expect(RAZORPAY_SIGNATURE_HEADER).toBe("x-razorpay-signature");
  });
});

describe("verifyCheckoutSignature — the browser-returned credential", () => {
  const ORDER = "order_XYZ789";
  const PAYMENT = "pay_ABC123";

  it("ACCEPTS the genuine HMAC over `order_id|payment_id`", () => {
    const sig = signCheckoutForTest(ORDER, PAYMENT, KEY_SECRET);
    expect(
      verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: sig }, KEY_SECRET),
    ).toBe(true);
  });

  it("pins the exact signed message Razorpay specifies (order|payment, in that order)", () => {
    const sig = createHmac("sha256", KEY_SECRET).update(`${ORDER}|${PAYMENT}`).digest("hex");
    expect(
      verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: sig }, KEY_SECRET),
    ).toBe(true);
    // Reversed order must NOT verify — otherwise a swapped-args refactor would go unnoticed.
    const reversed = createHmac("sha256", KEY_SECRET).update(`${PAYMENT}|${ORDER}`).digest("hex");
    expect(
      verifyCheckoutSignature(
        { orderId: ORDER, paymentId: PAYMENT, signature: reversed },
        KEY_SECRET,
      ),
    ).toBe(false);
  });

  it("REJECTS a signature bound to a DIFFERENT order (the credit-theft attempt)", () => {
    // The attack: a payer completes a ₹2,000 purchase, then replays that signature against
    // someone else's (or their own cheaper) order id to claim a second grant.
    const sig = signCheckoutForTest(ORDER, PAYMENT, KEY_SECRET);
    expect(
      verifyCheckoutSignature(
        { orderId: "order_OTHER", paymentId: PAYMENT, signature: sig },
        KEY_SECRET,
      ),
    ).toBe(false);
    expect(
      verifyCheckoutSignature(
        { orderId: ORDER, paymentId: "pay_OTHER", signature: sig },
        KEY_SECRET,
      ),
    ).toBe(false);
  });

  it("REJECTS the WRONG SECRET, the webhook secret included (the two are not interchangeable)", () => {
    const withWebhookSecret = signCheckoutForTest(ORDER, PAYMENT, WEBHOOK_SECRET);
    expect(
      verifyCheckoutSignature(
        { orderId: ORDER, paymentId: PAYMENT, signature: withWebhookSecret },
        KEY_SECRET,
      ),
    ).toBe(false);
  });

  it("REJECTS a blank/absent secret and a blank signature", () => {
    const sig = signCheckoutForTest(ORDER, PAYMENT, KEY_SECRET);
    for (const blank of [undefined, null, "", "  "]) {
      expect(
        verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: sig }, blank),
      ).toBe(false);
    }
    expect(
      verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: "" }, KEY_SECRET),
    ).toBe(false);
  });

  it("REJECTS blank ids — an empty component would make the signed message ambiguous", () => {
    const sig = signCheckoutForTest("", PAYMENT, KEY_SECRET);
    expect(
      verifyCheckoutSignature({ orderId: "", paymentId: PAYMENT, signature: sig }, KEY_SECRET),
    ).toBe(false);
    const sig2 = signCheckoutForTest(ORDER, "", KEY_SECRET);
    expect(
      verifyCheckoutSignature({ orderId: ORDER, paymentId: "", signature: sig2 }, KEY_SECRET),
    ).toBe(false);
  });
});
