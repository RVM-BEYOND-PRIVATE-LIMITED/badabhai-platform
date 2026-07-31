import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { RazorpayWebhookGuard } from "./razorpay-webhook.guard";
import { signWebhookBodyForTest } from "./razorpay-signature";
import type { RawBodyRequest } from "./razorpay-raw-body.middleware";

/**
 * The webhook guard is the ENTIRE authentication boundary on a PUBLIC, unauthenticated,
 * money-granting route. These tests pin every deny path, and pin that all of them are
 * INDISTINGUISHABLE from one another (the response must not be a configuration oracle).
 */

const WEBHOOK_SECRET = "whsec_test_secret";
const BODY = Buffer.from('{"event":"payment.captured"}', "utf8");
const VALID_SIG = signWebhookBodyForTest(BODY, WEBHOOK_SECRET);

const LIVE = {
  PAYMENTS_ENABLE_REAL: true,
  PAYMENTS_PROVIDER_KEY: "rzp_test_keyid",
  PAYMENTS_PROVIDER_SECRET: "rzp_secret",
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
} as unknown as ServerConfig;

const OFF = { PAYMENTS_ENABLE_REAL: false } as unknown as ServerConfig;

function ctxWith(req: Partial<RawBodyRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers: {}, ...req }) }),
  } as unknown as ExecutionContext;
}

function run(config: ServerConfig, req: Partial<RawBodyRequest>): boolean {
  return new RazorpayWebhookGuard(config).canActivate(ctxWith(req));
}

/** The thrown error, for comparing deny paths against each other. */
function denyMessage(config: ServerConfig, req: Partial<RawBodyRequest>): string {
  try {
    run(config, req);
    return "ALLOWED";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe("RazorpayWebhookGuard — the only credential on a public money route", () => {
  it("ALLOWS a correctly signed delivery", () => {
    expect(
      run(LIVE, {
        rawBody: BODY,
        headers: { "x-razorpay-signature": VALID_SIG } as RawBodyRequest["headers"],
      }),
    ).toBe(true);
  });

  it("DENIES a missing signature header", () => {
    expect(() => run(LIVE, { rawBody: BODY })).toThrow(UnauthorizedException);
  });

  it("DENIES a wrong signature", () => {
    expect(() =>
      run(LIVE, {
        rawBody: BODY,
        headers: { "x-razorpay-signature": "0".repeat(64) } as RawBodyRequest["headers"],
      }),
    ).toThrow(UnauthorizedException);
  });

  it("DENIES a signature over a DIFFERENT body (replay with a mutated payload)", () => {
    const other = Buffer.from('{"event":"payment.captured","x":1}', "utf8");
    expect(() =>
      run(LIVE, {
        rawBody: other,
        headers: { "x-razorpay-signature": VALID_SIG } as RawBodyRequest["headers"],
      }),
    ).toThrow(UnauthorizedException);
  });

  it("DENIES when NO raw body was captured — never falls back to the parsed body", () => {
    // If the middleware did not run we cannot know the signed bytes. Trusting `req.body`
    // here would be the single most dangerous shortcut in this integration.
    expect(() =>
      run(LIVE, {
        body: { event: "payment.captured" },
        headers: { "x-razorpay-signature": VALID_SIG } as RawBodyRequest["headers"],
      }),
    ).toThrow(UnauthorizedException);
  });

  it("DENIES everything when real payments are OFF (no secret ⇒ nothing can be verified)", () => {
    expect(() =>
      run(OFF, {
        rawBody: BODY,
        headers: { "x-razorpay-signature": VALID_SIG } as RawBodyRequest["headers"],
      }),
    ).toThrow(UnauthorizedException);
  });

  it("DENIES when the webhook secret is BLANK (empty never arms the gate — TD67)", () => {
    const blank = { ...LIVE, RAZORPAY_WEBHOOK_SECRET: "" } as unknown as ServerConfig;
    const emptySecretSig = signWebhookBodyForTest(BODY, "");
    expect(() =>
      run(blank, {
        rawBody: BODY,
        headers: { "x-razorpay-signature": emptySecretSig } as RawBodyRequest["headers"],
      }),
    ).toThrow(UnauthorizedException);
  });

  it("every deny path returns the IDENTICAL message — the response is not a config oracle", () => {
    const messages = new Set([
      denyMessage(LIVE, { rawBody: BODY }), // no signature
      denyMessage(LIVE, {
        rawBody: BODY,
        headers: { "x-razorpay-signature": "bad" } as RawBodyRequest["headers"],
      }), // wrong signature
      denyMessage(LIVE, {
        headers: { "x-razorpay-signature": VALID_SIG } as RawBodyRequest["headers"],
      }), // no raw body
      denyMessage(OFF, {
        rawBody: BODY,
        headers: { "x-razorpay-signature": VALID_SIG } as RawBodyRequest["headers"],
      }), // payments off
    ]);
    expect(messages.size).toBe(1);
    // …and it names nothing useful.
    const [only] = [...messages];
    expect(only).toBe("invalid signature");
    expect(only).not.toMatch(/secret|PAYMENTS_|RAZORPAY_|raw|body|disabled/i);
  });
});
