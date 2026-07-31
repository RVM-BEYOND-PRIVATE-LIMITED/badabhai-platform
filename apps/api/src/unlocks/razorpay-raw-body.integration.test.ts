import "reflect-metadata";
import { Body, Controller, Module, Post, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RAZORPAY_WEBHOOK_PATH,
  razorpayRawBodyMiddleware,
  type RawBodyRequest,
} from "./razorpay-raw-body.middleware";
import { signWebhookBodyForTest, verifyWebhookSignature } from "./razorpay-signature";

/**
 * RAW-BODY WIRING — driven against a REAL NestJS app with its REAL body parsers.
 *
 * MEASURED, NOT REASONED. The mechanism that lets one route keep its raw bytes while every
 * other route parses JSON normally is an interaction between three things we do not own:
 * where `app.use()` lands relative to `NestApplication.init()`, and how body-parser decides
 * a body was "already read". Both have changed across major versions (body-parser 1.x used
 * a `_body` flag; the 2.x in use today checks `onFinished.isFinished`). A unit test with a
 * fake stream would pass under either — and would keep passing after a dependency bump that
 * silently broke the real thing. So this test boots an actual server and makes real
 * requests, and it is the one to trust if it ever disagrees with a comment.
 *
 * Two properties, both load-bearing:
 *  1. the webhook path gets byte-exact `rawBody` that a real signature verifies against;
 *  2. EVERY other route still receives a normally-parsed JSON body (no regression).
 */

const WEBHOOK_SECRET = "whsec_integration_test";

/** Stands in for the webhook route: reports what the middleware left on the request. */
@Controller("payments/razorpay")
class ProbeWebhookController {
  @Post("webhook")
  handle(@Req() req: RawBodyRequest): {
    hasRawBody: boolean;
    rawBody: string | null;
    parsed: unknown;
  } {
    return {
      hasRawBody: Buffer.isBuffer(req.rawBody),
      rawBody: Buffer.isBuffer(req.rawBody) ? req.rawBody.toString("utf8") : null,
      parsed: req.body,
    };
  }
}

/** Stands in for EVERY other route on the API: must be unaffected. */
@Controller("probe")
class ProbeOtherController {
  @Post("echo")
  echo(@Body() body: unknown, @Req() req: RawBodyRequest): { body: unknown; hasRawBody: boolean } {
    // `hasRawBody` must be FALSE here: no other route may retain a second copy of its
    // bytes, because other routes carry PII (OTP, PIN, worker answers).
    return { body, hasRawBody: Buffer.isBuffer(req.rawBody) };
  }
}

@Module({ controllers: [ProbeWebhookController, ProbeOtherController] })
class ProbeModule {}

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await NestFactory.create(ProbeModule, { logger: false });
  // The EXACT wiring main.ts uses — mounted before listen(), scoped to the one path.
  app.use(RAZORPAY_WEBHOOK_PATH, razorpayRawBodyMiddleware);
  await app.listen(0);
  const url = await app.getUrl();
  baseUrl = url.replace("[::1]", "127.0.0.1");
}, 30_000);

afterAll(async () => {
  await app?.close();
});

async function post(path: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("raw-body middleware against a REAL Nest app + REAL body parsers", () => {
  it("gives the webhook route BYTE-EXACT raw bytes that a genuine signature verifies", async () => {
    // Key order + spacing that JSON.stringify would not reproduce — so a re-serialized
    // body would produce a different digest and fail.
    const wire = '{"event":"payment.captured", "payload":{"z":1,"a":2}}';
    const signature = signWebhookBodyForTest(Buffer.from(wire, "utf8"), WEBHOOK_SECRET);

    const res = await post(RAZORPAY_WEBHOOK_PATH, wire);
    expect(res.status).toBe(201);
    const out = (await res.json()) as { hasRawBody: boolean; rawBody: string; parsed: unknown };

    expect(out.hasRawBody).toBe(true);
    expect(out.rawBody).toBe(wire); // byte-for-byte
    expect(
      verifyWebhookSignature(Buffer.from(out.rawBody, "utf8"), signature, WEBHOOK_SECRET),
    ).toBe(true);
    // The convenience parse is still available to the controller.
    expect(out.parsed).toEqual({ event: "payment.captured", payload: { z: 1, a: 2 } });
  });

  it("does NOT break JSON parsing on any other route (the whole rest of the API)", async () => {
    const res = await post("/probe/echo", JSON.stringify({ hello: "world", n: 42 }));
    expect(res.status).toBe(201);
    const out = (await res.json()) as { body: unknown; hasRawBody: boolean };
    // Nest's parser ran exactly as before…
    expect(out.body).toEqual({ hello: "world", n: 42 });
    // …and no raw copy of the (potentially PII-bearing) body was retained.
    expect(out.hasRawBody).toBe(false);
  });

  it("handles a large-but-allowed webhook body without truncation", async () => {
    const wire = JSON.stringify({ event: "payment.captured", pad: "x".repeat(20_000) });
    const res = await post(RAZORPAY_WEBHOOK_PATH, wire);
    const out = (await res.json()) as { rawBody: string };
    expect(out.rawBody).toHaveLength(wire.length);
    expect(
      verifyWebhookSignature(
        Buffer.from(out.rawBody, "utf8"),
        signWebhookBodyForTest(Buffer.from(wire, "utf8"), WEBHOOK_SECRET),
        WEBHOOK_SECRET,
      ),
    ).toBe(true);
  });

  it("a MALFORMED webhook body does not 400 — it reaches the handler for a 200 no-op", async () => {
    // Nest's JSON parser would reject this with a 400; the raw path must not, or Razorpay
    // would retry a delivery we deliberately intend to ignore.
    const res = await post(RAZORPAY_WEBHOOK_PATH, "not json");
    expect(res.status).toBe(201);
    const out = (await res.json()) as { rawBody: string; parsed: unknown };
    expect(out.rawBody).toBe("not json");
    expect(out.parsed).toEqual({});
  });

  it("REFUSES an oversized webhook body with 413 (public-route DoS bound)", async () => {
    const huge = JSON.stringify({ pad: "x".repeat(80_000) }); // > MAX_WEBHOOK_BODY_BYTES
    const res = await fetch(`${baseUrl}${RAZORPAY_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: huge,
    }).catch(() => null);
    // Either a 413 or a hard connection reset (the request is destroyed mid-flight) — both
    // are refusals. What must NOT happen is a 2xx with a buffered body.
    if (res !== null) expect(res.status).toBe(413);
  });
});
