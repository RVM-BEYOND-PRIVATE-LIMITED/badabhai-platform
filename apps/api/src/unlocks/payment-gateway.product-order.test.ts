/**
 * #2751 item 6 — the ONE settle path for an order that is NOT a credit pack (Managed Hiring): the
 * product's settler is prepared on the pool, applied on the claim's transaction and told after the
 * commit; no wallet is credited; a kind with no settler is never claimed; a lost race reads as
 * already settled. And the real product checkout: the provider order first, its echoed amount
 * checked, then the payment row and the product row in one transaction.
 */
import "reflect-metadata";
import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { PaymentOrder } from "@badabhai/db";
import { gstPriceLine } from "@badabhai/pricing";

import { PaidOrderSettlers } from "./paid-order-settlers";
import { PaymentGateway } from "./payment-gateway";
import type { RazorpayClient } from "./razorpay.client";
import type { UnlocksRepository } from "./unlocks.repository";
import type { PricingService } from "../pricing/pricing.service";
import type { TenantKey } from "../payers/payer-tenant-scope";

const WALLET = "11111111-1111-4111-8111-111111111111" as TenantKey;
const CTX = { correlationId: "corr-1", requestId: "req-1" };

const created = {
  id: "order-row-1",
  payerId: WALLET,
  productKind: "managed_hiring",
  packCode: null,
  amountInr: 4720,
  creditsGranted: 0,
  provider: "razorpay",
  providerOrderId: "order_MH",
  status: "created",
  totalPaise: 472_000,
  taxablePaise: 400_000,
  gstPaise: 72_000,
  roundOffPaise: 0,
  gstRateBps: 1800,
} as unknown as PaymentOrder;
const paid = { ...created, status: "paid", providerPaymentRef: "pay_1" } as unknown as PaymentOrder;

function makeGateway(
  opts: { claim?: "wins" | "loses"; settler?: boolean; afterThrows?: boolean } = {},
) {
  const calls: string[] = [];
  let reads = 0;
  const repo = {
    findPaymentOrder: vi.fn(async () => (reads++ === 0 ? created : paid)),
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work("TX")),
    claimAndCreditPaymentOrderWithinTx: vi.fn(
      async (
        tx: unknown,
        input: { settleProduct?: (tx: unknown, row: PaymentOrder) => Promise<void> },
      ) => {
        if (opts.claim === "loses") return undefined;
        await input.settleProduct!(tx, paid);
        return { order: paid, balanceAfter: null, packReturn: null };
      },
    ),
    getBalance: vi.fn(async () => 7),
  };
  const settlers = new PaidOrderSettlers();
  if (opts.settler !== false) {
    settlers.register("managed_hiring", {
      prepare: async () => {
        calls.push("prepare");
        return "PLAN";
      },
      settleWithinTx: async (tx, order, plan, ctx) => {
        calls.push(`settle:${String(tx)}:${order.id}:${String(plan)}:${ctx.correlationId}`);
      },
      afterCommit: async () => {
        calls.push("after");
        if (opts.afterThrows) throw new Error("mail down");
      },
    });
  }
  const gw = new PaymentGateway(
    repo as unknown as UnlocksRepository,
    { PAYMENTS_ENABLE_REAL: true } as unknown as ServerConfig,
    { getActiveCatalog: vi.fn() } as unknown as PricingService,
    { isLive: true, keyId: "rzp_test_key" } as unknown as RazorpayClient,
    settlers,
  );
  return { gw, repo, calls };
}

const capture = { providerOrderId: "order_MH", providerPaymentRef: "pay_1", ctx: CTX };

describe("PaymentGateway.settleOrder — a non-pack order (#2751)", () => {
  it("prepares, settles on the claim's transaction, then runs the after-commit step; no credits", async () => {
    const { gw, repo, calls } = makeGateway();
    const result = await gw.settleOrder(capture);
    expect(calls).toEqual(["prepare", "settle:TX:order-row-1:PLAN:corr-1", "after"]);
    // Nothing was credited: no balance is read here (the verify reads its own tenant's).
    expect(result).toMatchObject({
      outcome: "granted",
      credits: 0,
      priceInr: 4720,
      balanceAfter: null,
      creditsReturned: 0,
    });
    expect(repo.getBalance).not.toHaveBeenCalled();
    expect(repo.withTransaction).toHaveBeenCalledTimes(1);
  });

  it("a kind with no settler is never claimed: 503 (the webhook retries)", async () => {
    const { gw, repo } = makeGateway({ settler: false });
    await expect(gw.settleOrder(capture)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repo.claimAndCreditPaymentOrderWithinTx).not.toHaveBeenCalled();
  });

  it("a lost race reads as already settled, and runs no after-commit step", async () => {
    const { gw, calls } = makeGateway({ claim: "loses" });
    const result = await gw.settleOrder(capture);
    expect(result.outcome).toBe("already_settled");
    expect(calls).toEqual(["prepare"]);
  });

  it("issues the GST invoice on the claim's transaction, after the settler (#2749 part 4)", async () => {
    const { gw, calls } = makeGateway();
    const onGranted = vi.fn(async (tx: unknown, order: PaymentOrder) => {
      calls.push(`invoice:${String(tx)}:${order.id}:${order.status}`);
    });
    await expect(gw.settleOrder(capture, { onGranted })).resolves.toMatchObject({
      outcome: "granted",
    });
    expect(calls).toEqual([
      "prepare",
      "settle:TX:order-row-1:PLAN:corr-1",
      "invoice:TX:order-row-1:paid",
      "after",
    ]);
  });

  it("a lost race issues no invoice (the winner's settle did)", async () => {
    const { gw } = makeGateway({ claim: "loses" });
    const onGranted = vi.fn(async () => {});
    await gw.settleOrder(capture, { onGranted });
    expect(onGranted).not.toHaveBeenCalled();
  });

  it("an after-commit failure never fails the settle (the payment and the purchase stand)", async () => {
    const { gw } = makeGateway({ afterThrows: true });
    await expect(gw.settleOrder(capture)).resolves.toMatchObject({ outcome: "granted" });
  });

  it("a capture of the wrong amount still HOLDS the order (no settler runs)", async () => {
    const { gw, repo, calls } = makeGateway();
    (repo as unknown as { holdPaymentOrder: unknown }).holdPaymentOrder = vi.fn(async () => ({
      ...created,
      status: "held",
    }));
    const result = await gw.settleOrder({
      ...capture,
      captured: { amountPaise: 1, currency: "INR" },
    });
    expect(result.outcome).toBe("held");
    expect(calls).toEqual([]);
  });
});

describe("PaymentGateway.createRealProductOrder (#2751)", () => {
  const line = gstPriceLine(4000);

  function makeCreate(echo: { amountPaise: number; currency: string }) {
    const createOrder = vi.fn(async () => ({ orderId: "order_new", ...echo }));
    const insert = vi.fn(async (_tx: unknown, input: Record<string, unknown>) => ({
      ...input,
      providerOrderId: "order_new",
    }));
    const repo = {
      withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work("TX")),
      createProductOrderWithinTx: insert,
    };
    const gw = new PaymentGateway(
      repo as unknown as UnlocksRepository,
      {} as ServerConfig,
      {} as PricingService,
      { isLive: true, keyId: "rzp_test_key", createOrder } as unknown as RazorpayClient,
    );
    return { gw, createOrder, insert };
  }

  it("creates the provider order for the GST total, then the payment row and the product row together", async () => {
    const { gw, createOrder, insert } = makeCreate({ amountPaise: 472_000, currency: "INR" });
    const withinTx = vi.fn(async (tx: unknown) => `product-row-on-${String(tx)}`);
    const out = await gw.createRealProductOrder(
      WALLET,
      {
        productKind: "managed_hiring",
        line,
        productCode: "managed_hiring:standard",
        origin: { origin: null, jobPostingId: "job-1" },
      },
      withinTx,
    );
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amountInr: 4720,
        notes: expect.objectContaining({ pack_code: "managed_hiring:standard" }),
      }),
    );
    expect(insert).toHaveBeenCalledWith(
      "TX",
      expect.objectContaining({
        productKind: "managed_hiring",
        amountInr: 4720,
        originJobPostingId: "job-1",
      }),
    );
    expect(out.result).toBe("product-row-on-TX");
    expect(out.handoff).toMatchObject({
      amountPaise: 472_000,
      amountInr: 4720,
      keyId: "rzp_test_key",
      currency: "INR",
    });
  });

  it("refuses (503, nothing persisted) when Razorpay's echoed amount is not the total", async () => {
    const { gw, insert } = makeCreate({ amountPaise: 400_000, currency: "INR" });
    await expect(
      gw.createRealProductOrder(
        WALLET,
        {
          productKind: "managed_hiring",
          line,
          productCode: "managed_hiring:standard",
          origin: { origin: null, jobPostingId: null },
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(insert).not.toHaveBeenCalled();
  });
});
