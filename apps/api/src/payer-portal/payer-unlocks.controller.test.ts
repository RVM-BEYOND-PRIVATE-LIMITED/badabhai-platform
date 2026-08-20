import "reflect-metadata";
import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { PayerUnlocksController } from "./payer-unlocks.controller";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import type { RequestContext } from "../common/request-context";

/** A request carrying no `Idempotency-Key` — the unguarded path every legacy case takes. */
const NO_KEY = { header: () => undefined } as unknown as Request;

/** A request carrying one, so a case can exercise the real dedupe. */
const withKey = (key: string): Request =>
  ({ header: (n: string) => (n.toLowerCase() === "idempotency-key" ? key : undefined) }) as unknown as Request;

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
  // #1046 — a PASS-THROUGH double. Every case in this file sends NO Idempotency-Key, which is
  // exactly the path where runOnce must run the work unchanged, so each assertion below keeps
  // testing the handler rather than the seam. The seam has its own suite, and the cases that
  // exercise it through this controller use the REAL one (see the #1046 describe).
  const idempotency = {
    runOnce: vi.fn(async (o: { work: () => Promise<unknown> }) => o.work()),
  };
  const ctrl = new PayerUnlocksController(
    unlocks as never,
    disclosureRate as never,
    idempotency as never,
  );
  return { ctrl, unlocks, disclosureRate, idempotency };
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
    const out = await d.ctrl.buyPack({ pack_code: "starter" }, PAYER_A, NO_KEY, CTX);
    expect(d.unlocks.purchaseCredits).toHaveBeenCalledWith(PAYER_A.id, "starter", CTX);
    expect(out).toEqual({ payer_id: PAYER_A.id, balance: 50, credits: 50, pack_code: "starter" });
  });

  it("buyPack on an UNKNOWN pack (service → null) throws a real 404 (NotFoundException)", async () => {
    d.unlocks.purchaseCredits.mockResolvedValueOnce(null as never);
    await expect(
      d.ctrl.buyPack({ pack_code: "nope" }, PAYER_A, NO_KEY, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
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
    await expect(
      d.ctrl.buyPack({ pack_code: "starter" }, PAYER_A, NO_KEY, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    // The grant must not even be attempted — not merely discarded after the fact.
    expect(d.unlocks.purchaseCredits).not.toHaveBeenCalled();
  });

  it("buyPack still GRANTS while PAYMENTS_ENABLE_REAL is off (the alpha default is untouched)", async () => {
    d.unlocks.realPaymentsLive = false;
    const out = await d.ctrl.buyPack({ pack_code: "starter" }, PAYER_A, NO_KEY, CTX);
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

describe("#1046 — POST /payer/credits is idempotent on Idempotency-Key", () => {
  // THE BUG, AS REPORTED. The payer app posts `{pack_code}` with no key. On a 15s timeout the
  // server may already have committed the grant, but the app re-enables the Buy button, the
  // user taps again, and a second identical POST grants the pack a SECOND time — silently
  // corrupting a balance that is money. Nothing on the wire let the server tell the two apart.
  //
  // WHY A NATURAL KEY CANNOT FIX THIS, which is the reason it needs a client-supplied one.
  // `POST /payer/unlocks` — the route that SPENDS credits — is already idempotent by
  // `(payer, worker)`: a live grant is returned rather than debited twice. That works because
  // unlocking the same worker twice is meaningless. Buying the same pack twice is a legitimate
  // action, so there is no natural key here, and only the caller can say "this is the same
  // purchase" by reusing a key.
  //
  // These cases drive the REAL seam against an in-memory Redis, so the mutex, the replay and
  // the in-flight branch are exercised rather than described.

  /** In-memory Redis covering the three commands the seam uses, with NX semantics. */
  function makeRedis() {
    const store = new Map<string, string>();
    return {
      store,
      client: {
        async set(key: string, value: string, _m: string, _s: number, nx?: string) {
          if (nx === "NX") {
            if (store.has(key)) return null;
            store.set(key, value);
            return "OK";
          }
          store.set(key, value);
          return "OK";
        },
        async get(key: string) {
          return store.get(key) ?? null;
        },
      },
    };
  }

  function realSeam() {
    const redis = makeRedis();
    const pii = {
      // A REAL digest, not `hmac_${v}`. An echoing double would make the "never the raw header"
      // case below pass for the wrong reason — and that case exists precisely because an
      // unauthenticated-ish header must not land in a Redis key verbatim.
      hmac: (v: string) => createHash("sha256").update(v).digest("hex"),
      hashPhone: (v: string) => `phash_${v}`,
      encrypt: (v: string) => `enc(${v})`,
      decrypt: (v: string) => v.replace(/^enc\(|\)$/g, ""),
    };
    const queue = { client: Promise.resolve(redis.client) };
    return { seam: new RequestIdempotency(pii as never, queue as never), redis };
  }

  function ctrlWithRealSeam() {
    const purchaseCredits = vi.fn(async (payerId: string, packCode: string) => ({
      payer_id: payerId,
      balance: 50,
      credits: 50,
      pack_code: packCode,
    }));
    const unlocks = { realPaymentsLive: false, purchaseCredits };
    const { seam, redis } = realSeam();
    const ctrl = new PayerUnlocksController(
      unlocks as never,
      { assertWithinHourlyCap: vi.fn(async () => undefined) } as never,
      seam,
    );
    return { ctrl, unlocks, purchaseCredits, redis };
  }

  it("THE DOUBLE-GRANT: the same key twice grants ONCE and replays the original result", async () => {
    const { ctrl, purchaseCredits } = ctrlWithRealSeam();
    const req = withKey("purchase-1");

    const first = await ctrl.buyPack({ pack_code: "starter" }, PAYER_A, req, CTX);
    const second = await ctrl.buyPack({ pack_code: "starter" }, PAYER_A, req, CTX);

    expect(purchaseCredits).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("a duplicate landing MID-FLIGHT is refused 409, and does NOT start a second grant", async () => {
    // THE CASE THE BUG IS ACTUALLY MADE OF. A timeout means the first attempt is still running,
    // so there is no stored result yet — a result cache alone would miss this entirely and let
    // the second grant through. Only the NX reservation taken BEFORE the work stops it.
    const { ctrl, unlocks } = ctrlWithRealSeam();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (unlocks.purchaseCredits as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await gate;
      return { payer_id: PAYER_A.id, balance: 50, credits: 50, pack_code: "starter" };
    });
    const req = withKey("purchase-2");

    const inflight = ctrl.buyPack({ pack_code: "starter" }, PAYER_A, req, CTX);
    await expect(
      ctrl.buyPack({ pack_code: "starter" }, PAYER_A, req, CTX),
    ).rejects.toBeInstanceOf(ConflictException);

    release();
    await inflight;
    expect(unlocks.purchaseCredits).toHaveBeenCalledTimes(1);
  });

  it("409 RATHER THAN AN OPTIMISTIC BALANCE — the seam must not invent a number", async () => {
    // The deliberate divergence from the OTP path, which CAN answer optimistically because
    // "a code is on its way" is honest. A guessed balance is not: the client would render a
    // figure that never existed, which is worse than the double-grant this prevents.
    const { ctrl, unlocks } = ctrlWithRealSeam();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (unlocks.purchaseCredits as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await gate;
      return { payer_id: PAYER_A.id, balance: 999, credits: 50, pack_code: "starter" };
    });
    const req = withKey("purchase-3");

    const inflight = ctrl.buyPack({ pack_code: "starter" }, PAYER_A, req, CTX);
    const err = await ctrl
      .buyPack({ pack_code: "starter" }, PAYER_A, req, CTX)
      .catch((e: ConflictException) => e);

    expect((err as ConflictException).getStatus()).toBe(409);
    // The advice copy may SAY "balance"; what it must never carry is a NUMBER a client could
    // render as one, or any field of the result shape.
    const body = JSON.stringify((err as ConflictException).getResponse());
    expect(body).not.toContain("999");
    expect(body).not.toMatch(/"balance"|"credits"|"pack_code"/);
    release();
    await inflight;
  });

  it("A SAME-TICK DEAD HEAT grants exactly once", async () => {
    const { ctrl, purchaseCredits } = ctrlWithRealSeam();
    const req = withKey("purchase-4");
    const results = await Promise.allSettled([
      ctrl.buyPack({ pack_code: "starter" }, PAYER_A, req, CTX),
      ctrl.buyPack({ pack_code: "starter" }, PAYER_A, req, CTX),
      ctrl.buyPack({ pack_code: "starter" }, PAYER_A, req, CTX),
    ]);
    expect(purchaseCredits).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("A DIFFERENT KEY IS A DIFFERENT PURCHASE — a genuine second buy still works", async () => {
    // The property that stops this becoming a bug of its own. A payer who really does want two
    // packs taps twice, the client mints two keys, and both grants happen.
    const { ctrl, purchaseCredits } = ctrlWithRealSeam();
    await ctrl.buyPack({ pack_code: "starter" }, PAYER_A, withKey("tap-1"), CTX);
    await ctrl.buyPack({ pack_code: "starter" }, PAYER_A, withKey("tap-2"), CTX);
    expect(purchaseCredits).toHaveBeenCalledTimes(2);
  });

  it("ANOTHER PAYER'S KEY IS NOT THIS PAYER'S KEY — the bucket is scoped by session payer", async () => {
    // A safety property, not bookkeeping: without the subject in the key, one tenant presenting
    // another's key would be served that tenant's stored purchase result.
    const { ctrl, purchaseCredits } = ctrlWithRealSeam();
    const PAYER_B: typeof PAYER_A = { ...PAYER_A, id: "bbbbbbbb-0000-4000-8000-000000000002" };
    const shared = withKey("same-key");
    await ctrl.buyPack({ pack_code: "starter" }, PAYER_A, shared, CTX);
    await ctrl.buyPack({ pack_code: "starter" }, PAYER_B, shared, CTX);
    expect(purchaseCredits).toHaveBeenCalledTimes(2);
    expect(purchaseCredits.mock.calls.map((c) => c[0])).toEqual([PAYER_A.id, PAYER_B.id]);
  });

  it("NO KEY, NO GUARD — an older client behaves exactly as before (§3)", async () => {
    // The header stays OPTIONAL. 400-ing a caller that omits a header it was never asked for
    // would be a breaking change to fix a bug that only affects callers who DO send one.
    const { ctrl, purchaseCredits } = ctrlWithRealSeam();
    await ctrl.buyPack({ pack_code: "starter" }, PAYER_A, NO_KEY, CTX);
    await ctrl.buyPack({ pack_code: "starter" }, PAYER_A, NO_KEY, CTX);
    expect(purchaseCredits).toHaveBeenCalledTimes(2);
  });

  it("AN UNKNOWN PACK replays its 404 rather than re-running the lookup", async () => {
    const { ctrl, unlocks } = ctrlWithRealSeam();
    (unlocks.purchaseCredits as ReturnType<typeof vi.fn>).mockResolvedValue(null as never);
    const req = withKey("purchase-5");
    await expect(ctrl.buyPack({ pack_code: "nope" }, PAYER_A, req, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(ctrl.buyPack({ pack_code: "nope" }, PAYER_A, req, CTX)).rejects.toMatchObject({
      status: 404,
    });
    expect(unlocks.purchaseCredits).toHaveBeenCalledTimes(1);
  });

  it("THE REAL-PAYMENTS 404 IS NOT STORED — it is a config gate, not a request outcome", async () => {
    // Storing it would pin that answer for the whole window, so a payer who tapped during a
    // config flip would keep being told the route does not exist for three minutes after it did.
    const { ctrl, unlocks, purchaseCredits } = ctrlWithRealSeam();
    const req = withKey("purchase-6");

    unlocks.realPaymentsLive = true;
    await expect(ctrl.buyPack({ pack_code: "starter" }, PAYER_A, req, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(purchaseCredits).not.toHaveBeenCalled();

    unlocks.realPaymentsLive = false;
    const out = await ctrl.buyPack({ pack_code: "starter" }, PAYER_A, req, CTX);
    expect(out).toMatchObject({ credits: 50 });
    expect(purchaseCredits).toHaveBeenCalledTimes(1);
  });

  it("the Redis key carries the payer and the HASHED client key, never the raw header", async () => {
    const { ctrl, redis } = ctrlWithRealSeam();
    await ctrl.buyPack({ pack_code: "starter" }, PAYER_A, withKey("secret-key-value"), CTX);
    const keys = [...redis.store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(`payer_idem:credits_purchase:${PAYER_A.id}:`);
    expect(keys[0]).not.toContain("secret-key-value");
  });
});
