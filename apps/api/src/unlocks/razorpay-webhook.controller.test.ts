import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { RazorpayWebhookGuard } from "./razorpay-webhook.guard";
import type { UnlockService } from "./unlocks.service";
import type { RawBodyRequest } from "./razorpay-raw-body.middleware";

/**
 * The webhook controller's whole job is choosing the HTTP STATUS, which for Razorpay is a
 * retry control signal — so the status is the behaviour under test, not decoration.
 */

const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};

function makeCtrl(result: "granted" | "failed_recorded" | "no_op" | "retry" = "granted") {
  const unlocks = {
    handleRazorpayEvent: vi.fn(async (_event: unknown, _ctx: unknown) => ({ result })),
  };
  const ctrl = new RazorpayWebhookController(unlocks as unknown as UnlockService);
  return { ctrl, unlocks };
}

const req = (body: unknown): RawBodyRequest => ({ body }) as RawBodyRequest;

const CAPTURE = {
  event: "payment.captured",
  payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 200000 } } },
};

describe("RazorpayWebhookController — status codes are retry control signals", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("a handled capture returns 200 with a fixed, information-free body", async () => {
    await expect(d.ctrl.webhook(req(CAPTURE), CTX)).resolves.toEqual({ received: true });
    expect(d.unlocks.handleRazorpayEvent).toHaveBeenCalledWith(
      { eventName: "payment.captured", paymentId: "pay_1", orderId: "order_1" },
      CTX,
    );
  });

  it("a DUPLICATE/REPLAYED delivery returns 200 — never a 500 (which would spam retries)", async () => {
    const dup = makeCtrl("no_op");
    await expect(dup.ctrl.webhook(req(CAPTURE), CTX)).resolves.toEqual({ received: true });
  });

  it("an UNKNOWN event type returns 200 and is forwarded for the service to no-op", async () => {
    const unknown = makeCtrl("no_op");
    await expect(
      unknown.ctrl.webhook(req({ event: "subscription.charged" }), CTX),
    ).resolves.toEqual({ received: true });
  });

  it("a MALFORMED body returns 200 without touching the service (no retry for a shape we don't know)", async () => {
    await expect(d.ctrl.webhook(req({ nonsense: true }), CTX)).resolves.toEqual({ received: true });
    expect(d.unlocks.handleRazorpayEvent).not.toHaveBeenCalled();
  });

  it("an internal failure asks Razorpay to RETRY (503) so captured money is never dropped", async () => {
    const retry = makeCtrl("retry");
    await expect(retry.ctrl.webhook(req(CAPTURE), CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("the response body reveals nothing about the order, the payer, or the outcome", async () => {
    const outcomes: Array<"granted" | "failed_recorded" | "no_op"> = [
      "granted",
      "failed_recorded",
      "no_op",
    ];
    const bodies = new Set<string>();
    for (const outcome of outcomes) {
      const c = makeCtrl(outcome);
      bodies.add(JSON.stringify(await c.ctrl.webhook(req(CAPTURE), CTX)));
    }
    // Byte-identical for a grant, a recorded failure, and a replay.
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toBe('{"received":true}');
  });

  it("carries the signature guard — the route's only credential (authz contract)", () => {
    const handler = (RazorpayWebhookController.prototype as unknown as Record<string, object>)
      .webhook;
    expect(handler).toBeDefined();
    const guards = (Reflect.getMetadata("__guards__", handler as object) ?? []) as Array<{
      name?: string;
    }>;
    expect(guards.map((g) => g.name)).toEqual(["RazorpayWebhookGuard"]);
    expect(guards[0]).toBe(RazorpayWebhookGuard);
  });

  it("does NOT parse provider-side buyer PII into our model (email/contact/card are dropped)", async () => {
    // Razorpay's real payment entity carries these. The DTO does not model them, so nothing
    // downstream can read, log, or store them (CLAUDE.md §2 #2).
    await d.ctrl.webhook(
      req({
        event: "payment.captured",
        payload: {
          payment: {
            entity: {
              id: "pay_1",
              order_id: "order_1",
              email: "buyer@example.com",
              contact: "+919876543210",
              card: { last4: "1111", name: "A Buyer" },
              vpa: "buyer@upi",
            },
          },
        },
      }),
      CTX,
    );
    const forwarded = JSON.stringify(d.unlocks.handleRazorpayEvent.mock.calls[0]?.[0]);
    expect(forwarded).not.toMatch(/buyer@example\.com|9876543210|1111|A Buyer|buyer@upi/);
    expect(forwarded).toBe(
      JSON.stringify({ eventName: "payment.captured", paymentId: "pay_1", orderId: "order_1" }),
    );
  });
});
