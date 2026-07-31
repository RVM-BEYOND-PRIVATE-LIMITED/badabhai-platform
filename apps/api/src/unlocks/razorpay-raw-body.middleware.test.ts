import { Readable } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import {
  MAX_WEBHOOK_BODY_BYTES,
  RAZORPAY_WEBHOOK_PATH,
  razorpayRawBodyMiddleware,
  type RawBodyRequest,
} from "./razorpay-raw-body.middleware";
import { signWebhookBodyForTest, verifyWebhookSignature } from "./razorpay-signature";

/**
 * RAW-BODY CAPTURE — the bytes this middleware preserves are the ONLY thing the webhook
 * signature can be verified against. If it captured a re-serialized body, every genuine
 * Razorpay delivery would fail verification (and the "fix" would be to weaken the check).
 */

/** A fake request stream carrying `payload`, with the shape the middleware reads. */
function fakeReq(payload: Buffer | string): RawBodyRequest {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const stream = Readable.from([buf]) as unknown as RawBodyRequest;
  stream.headers = { "content-type": "application/json" } as RawBodyRequest["headers"];
  return stream;
}

function fakeRes() {
  return { statusCode: 200, end: vi.fn() };
}

/** Run the middleware and resolve once `next` fires. */
function run(req: RawBodyRequest, res = fakeRes()): Promise<{ err?: unknown; res: typeof res }> {
  return new Promise((resolve) => {
    razorpayRawBodyMiddleware(req, res as never, (err?: unknown) => resolve({ err, res }));
  });
}

describe("razorpayRawBodyMiddleware — byte-exact capture, path-scoped", () => {
  it("preserves the EXACT bytes, so a real signature verifies against them", async () => {
    // Deliberately awkward JSON: key order and spacing that JSON.stringify would not reproduce.
    const wire = '{"event":"payment.captured", "payload":{"b":1,"a":2}}';
    const secret = "whsec_test";
    const signature = signWebhookBodyForTest(Buffer.from(wire, "utf8"), secret);

    const req = fakeReq(wire);
    await run(req);

    expect(req.rawBody?.toString("utf8")).toBe(wire);
    expect(verifyWebhookSignature(req.rawBody, signature, secret)).toBe(true);
    // The re-serialized form would NOT have verified — that is why raw capture exists.
    expect(
      verifyWebhookSignature(Buffer.from(JSON.stringify(JSON.parse(wire))), signature, secret),
    ).toBe(false);
  });

  it("also exposes a parsed body so the controller does not re-parse", async () => {
    const req = fakeReq('{"event":"payment.captured"}');
    await run(req);
    expect(req.body).toEqual({ event: "payment.captured" });
  });

  it("marks the body already-read so the downstream JSON parser SKIPS this request", async () => {
    // Without this flag, body-parser would try to read an already-consumed stream and
    // fail the request with a content-length mismatch. This is what keeps the ONE route
    // working while every other route's parsing is untouched.
    const req = fakeReq('{"event":"x"}');
    await run(req);
    expect(req._body).toBe(true);
  });

  it("a MALFORMED payload becomes {} and still captures raw bytes (no throw)", async () => {
    const req = fakeReq("not json at all");
    const { err } = await run(req);
    expect(err).toBeUndefined();
    expect(req.body).toEqual({});
    expect(req.rawBody?.toString("utf8")).toBe("not json at all");
  });

  it("an EMPTY body is captured as zero bytes (verifiable, not a special case)", async () => {
    const req = fakeReq("");
    await run(req);
    expect(req.rawBody?.length).toBe(0);
    expect(req.body).toEqual({});
  });

  it("REFUSES an oversized body with 413 and stops buffering (public-route DoS bound)", async () => {
    const huge = Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1, 0x61);
    const req = fakeReq(huge);
    const res = fakeRes();
    // The oversize path ends the response itself and never calls next(), so assert on the
    // response rather than awaiting a callback that will not come.
    razorpayRawBodyMiddleware(req, res as never, () => {
      throw new Error("next() must not run for an oversized body");
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(res.statusCode).toBe(413);
    expect(res.end).toHaveBeenCalled();
    expect(req.rawBody).toBeUndefined(); // nothing retained
  });

  it("is a no-op if something upstream already consumed the body (fail closed, no rawBody)", async () => {
    const req = fakeReq('{"event":"x"}');
    req._body = true;
    await run(req);
    // No rawBody ⇒ the guard denies. Better a rejected delivery than a body we cannot verify.
    expect(req.rawBody).toBeUndefined();
  });

  it("pins the ONE path it is mounted on (the controller route must match)", () => {
    expect(RAZORPAY_WEBHOOK_PATH).toBe("/payments/razorpay/webhook");
  });
});
