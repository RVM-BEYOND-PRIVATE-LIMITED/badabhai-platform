import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { RazorpayClient, providerPaise } from "./razorpay.client";

/**
 * #2749 hardening 5 — the provider seam returns RAZORPAY'S numbers: the amount and currency its
 * order response echoes (so the gateway's "is this the stamped total?" guard can fire), and a
 * payment read back for the browser verify, reduced to the five fields the settle needs. The SDK
 * is replaced by a stub; nothing here talks to a network.
 */

const LIVE = {
  PAYMENTS_ENABLE_REAL: true,
  PAYMENTS_PROVIDER_KEY: "rzp_test_clientunit",
  PAYMENTS_PROVIDER_SECRET: "rzp_clientunit_key_secret",
  RAZORPAY_WEBHOOK_SECRET: "rzp_clientunit_webhook_secret",
} as unknown as ServerConfig;

/** A client whose lazily-built SDK is the given stub. */
function clientWith(sdk: Record<string, unknown>): RazorpayClient {
  const client = new RazorpayClient(LIVE);
  (client as unknown as { client: unknown }).client = sdk;
  return client;
}

const ORDER_INPUT = {
  amountInr: 1179,
  receipt: "11111111-2222-4333-8444-555555555555",
  notes: { pack_code: "pack_starter", payment_order_id: "11111111-2222-4333-8444-555555555555" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RazorpayClient.createOrder — returns Razorpay's echo, not the amount it sent", () => {
  it("sends the total in paise, and returns the amount and currency Razorpay's response names", async () => {
    const create = vi.fn(async () => ({ id: "order_X", amount: 99900, currency: "INR" }));
    const out = await clientWith({ orders: { create } }).createOrder(ORDER_INPUT);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 117900, currency: "INR", receipt: ORDER_INPUT.receipt }),
    );
    // The provider's 99900, NOT the 117900 that was sent: the gateway can now see a mismatch.
    expect(out).toEqual({ orderId: "order_X", amountPaise: 99900, currency: "INR" });
  });

  it("accepts Razorpay's string-typed amount, and refuses a response without an integer amount", async () => {
    const asString = vi.fn(async () => ({ id: "order_X", amount: "117900", currency: "INR" }));
    expect(
      (await clientWith({ orders: { create: asString } }).createOrder(ORDER_INPUT)).amountPaise,
    ).toBe(117900);

    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const fractional = vi.fn(async () => ({ id: "order_X", amount: 1179.5, currency: "INR" }));
    await expect(
      clientWith({ orders: { create: fractional } }).createOrder(ORDER_INPUT),
    ).rejects.toThrow("payment provider order creation failed");
  });
});

describe("RazorpayClient.fetchPayment — GET /payments/:id, five fields, no buyer data", () => {
  it("maps id, order, amount, currency and status, and drops everything else", async () => {
    const fetch = vi.fn(async () => ({
      id: "pay_X",
      order_id: "order_X",
      amount: 117900,
      currency: "INR",
      status: "captured",
      email: "buyer@example.com",
      contact: "+919876543210",
      vpa: "buyer@upi",
    }));
    const out = await clientWith({ payments: { fetch } }).fetchPayment("pay_X");
    expect(fetch).toHaveBeenCalledWith("pay_X");
    expect(out).toEqual({
      id: "pay_X",
      orderId: "order_X",
      amountPaise: 117900,
      currency: "INR",
      status: "captured",
    });
    expect(JSON.stringify(out)).not.toMatch(/buyer|9876543210/);
  });

  it("a provider failure throws a neutral error and logs the class only", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const fetch = vi.fn(async () => {
      throw new Error("502 from provider: buyer@example.com");
    });
    await expect(clientWith({ payments: { fetch } }).fetchPayment("pay_X")).rejects.toThrow(
      "payment provider payment fetch failed",
    );
    expect(error).toHaveBeenCalledWith("payment fetch failed error_class=Error");
  });
});

describe("providerPaise", () => {
  it("takes a non-negative safe integer (or its digit string) and refuses anything else", () => {
    expect(providerPaise(117900)).toBe(117900);
    expect(providerPaise("117900")).toBe(117900);
    for (const bad of [-1, 1.5, "1.5", "", "12a", null, undefined, Number.NaN, 2 ** 60]) {
      expect(() => providerPaise(bad), String(bad)).toThrow();
    }
  });
});
