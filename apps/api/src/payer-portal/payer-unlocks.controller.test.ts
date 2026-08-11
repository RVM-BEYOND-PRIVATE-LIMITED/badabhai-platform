import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { PayerUnlocksController } from "./payer-unlocks.controller";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import type { RequestContext } from "../common/request-context";

const PAYER_A: AuthenticatedPayer = { id: "aaaaaaaa-0000-4000-8000-000000000001", sid: "sid-a", role: "employer" };
const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};
const WORKER = "cccccccc-0000-4000-8000-000000000003";
const UNLOCK = "dddddddd-0000-4000-8000-000000000004";

function makeCtrl() {
  const unlocks = {
    requestUnlock: vi.fn(async () => ({ ok: true })),
    reveal: vi.fn(async () => ({ channel: "in_app_relay" })),
    listByPayer: vi.fn(async () => ({ unlocks: [] })),
    getCredits: vi.fn(async () => ({ payer_id: PAYER_A.id, balance: 0 })),
    getCreditLedger: vi.fn(async () => ({ payer_id: PAYER_A.id, ledger: [] })),
    purchaseCredits: vi.fn(async () => ({
      payer_id: PAYER_A.id,
      balance: 50,
      credits: 50,
      pack_code: "starter",
    })),
    // Real-payments seam. `realPaymentsLive` is a getter on the service; it is overridden
    // per-test where the LIVE posture is under test.
    realPaymentsLive: false,
    createCreditOrder: vi.fn(async () => ({
      orderRowId: "11111111-2222-4333-8444-555555555555",
      providerOrderId: "order_TEST1",
      keyId: "rzp_test_keyid",
      amountInr: 2000,
      amountPaise: 200000,
      currency: "INR",
      packCode: "pack_50",
      credits: 50,
    })),
    verifyCheckoutPayment: vi.fn(async () => ({
      verified: true as const,
      payer_id: PAYER_A.id,
      balance: 50,
      credits: 50,
      pack_code: "pack_50",
    })),
  };
  const disclosureRate = { assertWithinHourlyCap: vi.fn(async () => undefined) };
  const ctrl = new PayerUnlocksController(unlocks as never, disclosureRate as never);
  return { ctrl, unlocks, disclosureRate };
}

/**
 * XB-A at the payer boundary: every action is bound to the SESSION payer (`req.payer.id`)
 * and the request body never supplies a `payer_id`. Proves a payer cannot act under
 * another payer's id from the edge — the chokepoint ownership (reveal) is proven in
 * unlocks.service.test.ts.
 */
describe("PayerUnlocksController — identity from the session, never the body (ADR-0019 XB-A)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("requestUnlock binds payer_id to the SESSION payer (the DTO carries no payer_id)", async () => {
    await d.ctrl.requestUnlock({ worker_id: WORKER, job_id: null }, PAYER_A, CTX);
    expect(d.unlocks.requestUnlock).toHaveBeenCalledWith(
      { payerId: PAYER_A.id, workerId: WORKER, jobId: null },
      CTX,
    );
  });

  it("reveal forwards the SESSION payer as the ownership key (expectedPayerId)", async () => {
    await d.ctrl.reveal(UNLOCK, PAYER_A, CTX);
    expect(d.unlocks.reveal).toHaveBeenCalledWith(UNLOCK, CTX, PAYER_A.id);
  });

  it("listOwn + ownCredits scope to the SESSION payer", async () => {
    await d.ctrl.listOwn(PAYER_A);
    expect(d.unlocks.listByPayer).toHaveBeenCalledWith(PAYER_A.id);
    await d.ctrl.ownCredits(PAYER_A);
    expect(d.unlocks.getCredits).toHaveBeenCalledWith(PAYER_A.id);
  });

  it("creditsLedger scopes to the SESSION payer + passes the clamped limit (B4; no body/param payer_id)", async () => {
    // The only args are the token-derived payer id and the validated limit — nothing in the
    // request can select another payer's ledger (cross-payer isolation is the repo WHERE clause).
    await d.ctrl.creditsLedger({ limit: 25 }, PAYER_A);
    expect(d.unlocks.getCreditLedger).toHaveBeenCalledWith(PAYER_A.id, 25);
    expect(d.unlocks.getCreditLedger).toHaveBeenCalledTimes(1);
  });

  it("enforces the per-payer disclosure cap (XB-G) against the SESSION payer on request + reveal", async () => {
    await d.ctrl.requestUnlock({ worker_id: WORKER, job_id: null }, PAYER_A, CTX);
    await d.ctrl.reveal(UNLOCK, PAYER_A, CTX);
    expect(d.disclosureRate.assertWithinHourlyCap).toHaveBeenCalledWith(PAYER_A.id);
    expect(d.disclosureRate.assertWithinHourlyCap).toHaveBeenCalledTimes(2);
  });

  it("a tripped per-payer cap (XB-G) blocks the chokepoint (request never reaches UnlockService)", async () => {
    d.disclosureRate.assertWithinHourlyCap.mockRejectedValueOnce(new Error("429"));
    await expect(
      d.ctrl.requestUnlock({ worker_id: WORKER, job_id: null }, PAYER_A, CTX),
    ).rejects.toThrow();
    expect(d.unlocks.requestUnlock).not.toHaveBeenCalled();
  });

  it("buyPack binds payer_id to the SESSION payer (the body carries only pack_code)", async () => {
    const out = await d.ctrl.buyPack({ pack_code: "starter" }, PAYER_A, CTX);
    expect(d.unlocks.purchaseCredits).toHaveBeenCalledWith(PAYER_A.id, "starter", CTX);
    expect(out).toEqual({ payer_id: PAYER_A.id, balance: 50, credits: 50, pack_code: "starter" });
  });

  it("buyPack on an UNKNOWN pack (service → null) throws a real 404 (NotFoundException)", async () => {
    d.unlocks.purchaseCredits.mockResolvedValueOnce(null as never);
    await expect(d.ctrl.buyPack({ pack_code: "nope" }, PAYER_A, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /**
   * GAP-PAY-04 — the mock grant and the real checkout must be MUTUALLY EXCLUSIVE.
   *
   * Both rows are asserted deliberately. A gate tested only for what it BLOCKS looks correct
   * while silently refusing legitimate traffic, and gets deleted the first time it does; the
   * PERMIT row is what proves the alpha path still works.
   */
  it("buyPack is a NEUTRAL 404 once PAYMENTS_ENABLE_REAL is live (no free credits beside the paywall)", async () => {
    d.unlocks.realPaymentsLive = true;
    await expect(d.ctrl.buyPack({ pack_code: "starter" }, PAYER_A, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // The grant must not even be attempted — not merely discarded after the fact.
    expect(d.unlocks.purchaseCredits).not.toHaveBeenCalled();
  });

  it("buyPack still GRANTS while PAYMENTS_ENABLE_REAL is off (the alpha default is untouched)", async () => {
    d.unlocks.realPaymentsLive = false;
    const out = await d.ctrl.buyPack({ pack_code: "starter" }, PAYER_A, CTX);
    expect(d.unlocks.purchaseCredits).toHaveBeenCalledWith(PAYER_A.id, "starter", CTX);
    expect(out).toMatchObject({ credits: 50 });
  });
});

/**
 * REAL-PAYMENT routes (Razorpay). Two properties matter at this boundary and nowhere else:
 * the payer is the SESSION payer (XB-A), and the routes are INERT until the launch gate is
 * flipped — a neutral 404, indistinguishable from a route that does not exist.
 */
describe("PayerUnlocksController — real-payment routes (order + verify)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("createOrder + verifyPayment are a NEUTRAL 404 while PAYMENTS_ENABLE_REAL is off (the default)", async () => {
    // The service is never reached: no provider call, no order row, nothing observable.
    await expect(
      d.ctrl.createOrder({ pack_code: "pack_50" }, PAYER_A, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      d.ctrl.verifyPayment(
        { razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "sig" },
        PAYER_A,
        CTX,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(d.unlocks.createCreditOrder).not.toHaveBeenCalled();
    expect(d.unlocks.verifyCheckoutPayment).not.toHaveBeenCalled();
  });

  describe("with real payments LIVE", () => {
    beforeEach(() => {
      d.unlocks.realPaymentsLive = true;
    });

    it("createOrder binds to the SESSION payer and forwards only the pack CODE (XB-A/XT5)", async () => {
      await d.ctrl.createOrder({ pack_code: "pack_50" }, PAYER_A, CTX);
      expect(d.unlocks.createCreditOrder).toHaveBeenCalledWith(PAYER_A.id, "pack_50", CTX);
    });

    it("createOrder returns the public key ID + amounts, and NEVER a secret", async () => {
      const out = await d.ctrl.createOrder({ pack_code: "pack_50" }, PAYER_A, CTX);
      expect(out).toEqual({
        order_id: "order_TEST1",
        key_id: "rzp_test_keyid",
        amount: 200000, // paise, for checkout.js
        amount_inr: 2000, // ₹, for the UI
        currency: "INR",
        pack_code: "pack_50",
        credits: 50,
      });
      // Nothing in the response resembles a secret, and no internal row id leaks either.
      expect(JSON.stringify(out)).not.toMatch(/secret|whsec|11111111-2222/i);
    });

    it("createOrder on an UNKNOWN pack is a 404 (a public catalog item, not a tenant oracle)", async () => {
      d.unlocks.createCreditOrder.mockResolvedValueOnce(null as never);
      await expect(
        d.ctrl.createOrder({ pack_code: "nope" }, PAYER_A, CTX),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("verifyPayment binds to the SESSION payer and forwards the provider's three values", async () => {
      const out = await d.ctrl.verifyPayment(
        {
          razorpay_order_id: "order_1",
          razorpay_payment_id: "pay_1",
          razorpay_signature: "sig_1",
        },
        PAYER_A,
        CTX,
      );
      expect(d.unlocks.verifyCheckoutPayment).toHaveBeenCalledWith(
        PAYER_A.id, // never a body value
        { orderId: "order_1", paymentId: "pay_1", signature: "sig_1" },
        CTX,
      );
      expect(out).toEqual({
        payer_id: PAYER_A.id,
        balance: 50,
        credits: 50,
        pack_code: "pack_50",
      });
    });

    it("an UNVERIFIED result is a bare 404 — the same answer for a forged signature, an unknown order, and someone else's order", async () => {
      d.unlocks.verifyCheckoutPayment.mockResolvedValue({ verified: false } as never);
      const errs: unknown[] = [];
      for (const orderId of ["order_forged", "order_unknown", "order_other_tenant"]) {
        errs.push(
          await d.ctrl
            .verifyPayment(
              {
                razorpay_order_id: orderId,
                razorpay_payment_id: "pay_1",
                razorpay_signature: "sig",
              },
              PAYER_A,
              CTX,
            )
            .catch((e: unknown) => e),
        );
      }
      const messages = new Set(errs.map((e) => (e as Error).message));
      expect(errs.every((e) => e instanceof NotFoundException)).toBe(true);
      expect(messages.size).toBe(1); // byte-identical refusal — no oracle
    });
  });
});
