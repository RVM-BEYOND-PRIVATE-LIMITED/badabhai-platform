import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { ConsentRepository } from "../consent/consent.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { PricingService } from "../pricing/pricing.service";
import { UnlockService } from "./unlocks.service";
import type { UnlocksRepository, Tx } from "./unlocks.repository";
import { PaymentGateway } from "./payment-gateway";
import type { RazorpayClient } from "./razorpay.client";
import type { PaymentOrder, PaymentOrderStatus } from "@badabhai/db";
import {
  CreateCreditOrderSchema,
  toPaymentEvent,
  RazorpayWebhookSchema,
} from "./razorpay-webhook.dto";
import { signCheckoutForTest } from "./razorpay-signature";

/**
 * REAL-MONEY IDEMPOTENCY — the properties that must hold when Razorpay retries a webhook
 * while the payer's browser is simultaneously calling verify.
 *
 * The fake repository below is not a convenience mock: it models the exact DB guarantees
 * the production code leans on, so a change that quietly drops one of them fails here.
 *  - UNIQUE (provider, provider_order_id) on payment_orders;
 *  - `credits_granted` NOT NULL, stamped at creation and read back at settle;
 *  - the conditional `status <> 'paid' → 'paid'` UPDATE as an ATOMIC compare-and-set;
 *  - the partial UNIQUE index on credit_ledger.idempotency_key;
 *  - one transaction wrapping the claim + the grant.
 */

const PAYER = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_PAYER = "bbbbbbbb-0000-4000-8000-000000000002";
const ORDER_ROW = "11111111-2222-4333-8444-555555555555";
const PROVIDER_ORDER = "order_TESTORDER1";
const PAYMENT_ID = "pay_TESTPAYMENT1";
const KEY_SECRET = "rzp_key_secret_test";

const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};

/** Real payments FULLY configured — the only posture in which any of this code runs. */
const LIVE_CONFIG = {
  PAYMENTS_ENABLE_REAL: true,
  PAYMENTS_PROVIDER_KEY: "rzp_test_keyid",
  PAYMENTS_PROVIDER_SECRET: KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: "whsec_test",
  UNLOCK_LATENCY_TARGET_MS: 0,
} as unknown as ServerConfig;

/** Yield to the microtask queue so two in-flight settles genuinely interleave. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

interface LedgerRow {
  payerId: string;
  delta: number;
  packCode: string | null;
  paymentRef: string | null;
  priceInr: number | null;
  idempotencyKey: string | null;
}

/**
 * An in-memory stand-in for UnlocksRepository that preserves the DB's concurrency
 * semantics. `claimPaymentOrderPaidWithinTx` performs its compare-and-set SYNCHRONOUSLY,
 * which is what makes a single-statement conditional UPDATE atomic in Postgres.
 */
function makeFakeRepo() {
  const orders = new Map<string, PaymentOrder>(); // keyed by `${provider}:${providerOrderId}`
  const ledger: LedgerRow[] = [];
  const ledgerKeys = new Set<string>(); // the partial UNIQUE index on idempotency_key
  const balances = new Map<string, number>();

  const key = (provider: string, providerOrderId: string): string =>
    `${provider}:${providerOrderId}`;

  const seedOrder = (over: Partial<PaymentOrder> = {}): PaymentOrder => {
    const row: PaymentOrder = {
      id: ORDER_ROW,
      payerId: PAYER,
      packCode: "pack_50",
      amountInr: 2000,
      creditsGranted: 50, // stamped at creation — the settle path reads THIS, not the catalog
      provider: "razorpay",
      providerOrderId: PROVIDER_ORDER,
      status: "created" as PaymentOrderStatus,
      providerPaymentRef: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    };
    orders.set(key(row.provider, row.providerOrderId), row);
    return row;
  };

  const repo = {
    // A transaction is just "run the callback"; the atomicity that matters is inside the CAS.
    withTransaction: vi.fn(async <T>(work: (tx: Tx) => Promise<T>): Promise<T> => work({} as Tx)),

    createPaymentOrder: vi.fn(
      async (input: {
        payerId: string;
        packCode: string;
        amountInr: number;
        creditsGranted: number;
        providerOrderId: string;
        provider?: string;
      }): Promise<PaymentOrder> => {
        const provider = input.provider ?? "razorpay";
        // UNIQUE (provider, provider_order_id) — the payment idempotency key.
        if (orders.has(key(provider, input.providerOrderId))) {
          throw new Error("duplicate key value violates unique constraint");
        }
        // CHECK (credits_granted > 0) + NOT NULL — an order that buys nothing is a bug the
        // DB refuses, so the fake refuses it too.
        if (!Number.isInteger(input.creditsGranted) || input.creditsGranted <= 0) {
          throw new Error('new row violates check constraint "payment_orders_credits_pos_chk"');
        }
        const row: PaymentOrder = {
          id: ORDER_ROW,
          payerId: input.payerId,
          packCode: input.packCode,
          amountInr: input.amountInr,
          creditsGranted: input.creditsGranted,
          provider,
          providerOrderId: input.providerOrderId,
          status: "created",
          providerPaymentRef: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        orders.set(key(provider, input.providerOrderId), row);
        return row;
      },
    ),

    findPaymentOrder: vi.fn(async (providerOrderId: string, provider = "razorpay") => {
      await tick(); // widen the read→claim window so the race is real, not theoretical
      return orders.get(key(provider, providerOrderId));
    }),

    // THE RACE CLOSURE. Synchronous check-and-set = one statement in Postgres.
    claimPaymentOrderPaidWithinTx: vi.fn(
      async (
        _tx: Tx,
        input: { providerOrderId: string; providerPaymentRef: string; provider?: string },
      ) => {
        const row = orders.get(key(input.provider ?? "razorpay", input.providerOrderId));
        if (!row || row.status === "paid") return undefined; // `status <> 'paid'` matched nothing
        const next: PaymentOrder = {
          ...row,
          status: "paid",
          providerPaymentRef: input.providerPaymentRef,
          updatedAt: new Date(),
        };
        orders.set(key(next.provider, next.providerOrderId), next);
        return next;
      },
    ),

    markPaymentOrderFailed: vi.fn(async (providerOrderId: string, provider = "razorpay") => {
      const row = orders.get(key(provider, providerOrderId));
      if (!row || row.status === "paid") return undefined; // never walk back a capture
      const next: PaymentOrder = { ...row, status: "failed", updatedAt: new Date() };
      orders.set(key(provider, providerOrderId), next);
      return next;
    }),

    creditPackWithinTx: vi.fn(
      async (
        _tx: Tx,
        input: {
          payerId: string;
          credits: number;
          packCode: string | null;
          paymentRef: string | null;
          priceInr?: number | null;
          idempotencyKey?: string | null;
        },
      ) => {
        const k = input.idempotencyKey ?? null;
        // The partial UNIQUE index: a second insert with the same key ABORTS the tx.
        if (k !== null && ledgerKeys.has(k)) {
          throw new Error("duplicate key value violates unique constraint");
        }
        if (k !== null) ledgerKeys.add(k);
        ledger.push({
          payerId: input.payerId,
          delta: input.credits,
          packCode: input.packCode,
          paymentRef: input.paymentRef,
          priceInr: input.priceInr ?? null,
          idempotencyKey: k,
        });
        const next = (balances.get(input.payerId) ?? 0) + input.credits;
        balances.set(input.payerId, next);
        return next;
      },
    ),

    creditPack: vi.fn(async () => 0),
    getBalance: vi.fn(async (payerId: string) => balances.get(payerId) ?? 0),
  };

  return { repo, orders, ledger, balances, seedOrder, key };
}

function makeService() {
  const fake = makeFakeRepo();
  const pricing = {
    getActiveCatalog: vi.fn(async () => ({
      catalog: DEFAULT_CATALOG,
      revision: 1,
      source: "db" as const,
    })),
  };
  const razorpay = {
    isLive: true,
    keyId: "rzp_test_keyid",
    createOrder: vi.fn(async () => ({
      orderId: PROVIDER_ORDER,
      amountPaise: 200000,
      currency: "INR",
    })),
  };
  const events = { emit: vi.fn(async (p: Record<string, unknown>) => p) };
  const payments = new PaymentGateway(
    fake.repo as unknown as UnlocksRepository,
    LIVE_CONFIG,
    pricing as unknown as PricingService,
    razorpay as unknown as RazorpayClient,
  );
  const svc = new UnlockService(
    fake.repo as unknown as UnlocksRepository,
    {} as unknown as ConsentRepository,
    {} as unknown as WorkersRepository,
    {} as unknown as PiiCryptoService,
    payments,
    events as unknown as EventsService,
    LIVE_CONFIG,
  );
  return { svc, payments, events, razorpay, pricing, ...fake };
}

/** The event names emitted, in order. */
function emitted(events: { emit: { mock: { calls: unknown[][] } } }): string[] {
  return events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
}

const captureEvent = (orderId: string = PROVIDER_ORDER, paymentId: string = PAYMENT_ID) =>
  toPaymentEvent(
    RazorpayWebhookSchema.parse({
      event: "payment.captured",
      payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: 200000 } } },
    }),
  );

// ---------------------------------------------------------------------------
// Order creation — the price is OURS, never the client's
// ---------------------------------------------------------------------------

describe("POST /payer/credits/order — the charged amount is the CATALOG price", () => {
  let d: ReturnType<typeof makeService>;
  beforeEach(() => {
    d = makeService();
  });

  it("charges the pack's catalog price and stamps it on the order row", async () => {
    const order = await d.svc.createCreditOrder(PAYER, "pack_50", CTX);
    // DEFAULT_CATALOG's pack_50 is ₹2,000 / 50 credits. Both come from resolvePack.
    expect(order).not.toBeNull();
    expect(order?.amountInr).toBe(2000);
    expect(order?.credits).toBe(50);
    // The provider was asked for exactly that amount…
    expect(d.razorpay.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amountInr: 2000 }),
    );
    // …and the persisted receipt carries BOTH SIDES of the transaction — the ₹ AND the
    // credits — from that one catalog read. A receipt with only the amount is the gap that
    // let a mid-flight pack edit change what an existing order was worth.
    expect(d.repo.createPaymentOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        payerId: PAYER,
        packCode: "pack_50",
        amountInr: 2000,
        creditsGranted: 50,
      }),
    );
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.creditsGranted).toBe(50);
  });

  it("follows an OPS PRICE EDIT — advertised and charged stay the same lookup (D-6)", async () => {
    d.pricing.getActiveCatalog.mockResolvedValue({
      catalog: {
        ...DEFAULT_CATALOG,
        products: DEFAULT_CATALOG.products.map((p) =>
          p.kind === "credit_pack" && p.code === "contact_unlock"
            ? { ...p, tiers: [{ code: "pack_50", priceInr: 1500, credits: 60, windowDays: 14 }] }
            : p,
        ),
      } as typeof DEFAULT_CATALOG,
      revision: 2,
      source: "db" as const,
    });
    const order = await d.svc.createCreditOrder(PAYER, "pack_50", CTX);
    expect(order?.amountInr).toBe(1500);
    expect(order?.credits).toBe(60);
    expect(d.razorpay.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amountInr: 1500 }),
    );
    // Both edited values are stamped together, so the order is self-describing from here on.
    expect(d.repo.createPaymentOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amountInr: 1500, creditsGranted: 60 }),
    );
  });

  it("IGNORES a client-supplied amount/credits — the DTO has no such field to accept", () => {
    // The request body is the only client-controlled surface on this route. Zod strips
    // anything not in the schema, so an attacker-supplied price never reaches the code.
    const parsed = CreateCreditOrderSchema.parse({
      pack_code: "pack_50",
      amount: 1,
      amount_inr: 1,
      credits: 99999,
      currency: "USD",
      payer_id: OTHER_PAYER,
    });
    expect(parsed).toEqual({ pack_code: "pack_50" });
    expect(Object.keys(parsed)).toEqual(["pack_code"]);
  });

  it("an UNKNOWN pack creates no provider order and no row (→ the controller's 404)", async () => {
    expect(await d.svc.createCreditOrder(PAYER, "pack_ghost", CTX)).toBeNull();
    expect(d.razorpay.createOrder).not.toHaveBeenCalled();
    expect(d.repo.createPaymentOrder).not.toHaveBeenCalled();
  });

  it("emits exactly ONE payment.authorized, with real_call TRUE and no PII", async () => {
    await d.svc.createCreditOrder(PAYER, "pack_50", CTX);
    expect(emitted(d.events)).toEqual(["payment.authorized"]);
    const payload = (d.events.emit.mock.calls[0]?.[0] as { payload: Record<string, unknown> })
      .payload;
    expect(payload).toMatchObject({
      payer_id: PAYER,
      pack_code: "pack_50",
      amount_inr: 2000,
      amount_credits: 50,
      real_call: true, // honest: money is genuinely in flight
    });
    // ids/codes/amounts only — no provider order id, no contact, no card data.
    expect(JSON.stringify(payload)).not.toContain(PROVIDER_ORDER);
  });

  it("never returns the key SECRET — only the public key id", async () => {
    const order = await d.svc.createCreditOrder(PAYER, "pack_50", CTX);
    const serialized = JSON.stringify(order);
    expect(serialized).toContain("rzp_test_keyid");
    expect(serialized).not.toContain(KEY_SECRET);
    expect(serialized).not.toContain("whsec_test");
  });

  it("a provider failure creates NO order row (nothing to reconcile)", async () => {
    d.razorpay.createOrder.mockRejectedValueOnce(new Error("provider down"));
    await expect(d.svc.createCreditOrder(PAYER, "pack_50", CTX)).rejects.toThrow();
    expect(d.repo.createPaymentOrder).not.toHaveBeenCalled();
    expect(emitted(d.events)).toEqual([]); // no authorization for money that never moved
  });
});

// ---------------------------------------------------------------------------
// Webhook capture + replay
// ---------------------------------------------------------------------------

describe("webhook capture — grants once, replays are no-ops", () => {
  let d: ReturnType<typeof makeService>;
  beforeEach(() => {
    d = makeService();
    d.seedOrder();
  });

  it("a capture grants the pack's credits and stamps the STAMPED ₹ + opaque payment ref", async () => {
    const out = await d.svc.handleRazorpayEvent(captureEvent(), CTX);
    expect(out).toEqual({ result: "granted" });
    expect(d.ledger).toHaveLength(1);
    expect(d.ledger[0]).toMatchObject({
      payerId: PAYER,
      delta: 50,
      packCode: "pack_50",
      paymentRef: PAYMENT_ID, // opaque `pay_*` id — never a card/UPI value
      priceInr: 2000,
      idempotencyKey: `payment_order:${ORDER_ROW}`,
    });
    expect(d.balances.get(PAYER)).toBe(50);
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("paid");
    expect(emitted(d.events)).toEqual(["payment.captured"]);
  });

  it("a REPLAYED identical webhook is a NO-OP: no second grant, no second ledger row, no second event", async () => {
    await d.svc.handleRazorpayEvent(captureEvent(), CTX);
    const replay = await d.svc.handleRazorpayEvent(captureEvent(), CTX);

    expect(replay).toEqual({ result: "no_op" }); // 200 — not a 500, not a grant
    expect(d.ledger).toHaveLength(1);
    expect(d.balances.get(PAYER)).toBe(50); // NOT 100
    expect(emitted(d.events)).toEqual(["payment.captured"]); // exactly one
  });

  it("five rapid redeliveries (Razorpay's retry storm) still grant exactly once", async () => {
    for (let i = 0; i < 5; i += 1) {
      await d.svc.handleRazorpayEvent(captureEvent(), CTX);
    }
    expect(d.ledger).toHaveLength(1);
    expect(d.balances.get(PAYER)).toBe(50);
    expect(emitted(d.events)).toEqual(["payment.captured"]);
  });

  it("an UNKNOWN event type is a 200 no-op (Razorpay adds event types over time)", async () => {
    const out = await d.svc.handleRazorpayEvent(
      { eventName: "subscription.charged", paymentId: PAYMENT_ID, orderId: PROVIDER_ORDER },
      CTX,
    );
    expect(out).toEqual({ result: "no_op" });
    expect(d.ledger).toHaveLength(0);
    expect(emitted(d.events)).toEqual([]);
  });

  it("a capture for an order we never created is a 200 no-op, never a grant", async () => {
    const out = await d.svc.handleRazorpayEvent(captureEvent("order_UNKNOWN"), CTX);
    expect(out).toEqual({ result: "no_op" });
    expect(d.ledger).toHaveLength(0);
    expect(d.balances.get(PAYER)).toBeUndefined();
  });

  it("a payment.failed marks the order failed and emits payment.failed (no grant)", async () => {
    const out = await d.svc.handleRazorpayEvent(
      { eventName: "payment.failed", paymentId: PAYMENT_ID, orderId: PROVIDER_ORDER },
      CTX,
    );
    expect(out).toEqual({ result: "failed_recorded" });
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("failed");
    expect(d.ledger).toHaveLength(0);
    expect(emitted(d.events)).toEqual(["payment.failed"]);
  });

  it("a LATE payment.failed can never walk back a completed capture (webhooks are unordered)", async () => {
    await d.svc.handleRazorpayEvent(captureEvent(), CTX);
    const late = await d.svc.handleRazorpayEvent(
      { eventName: "payment.failed", paymentId: PAYMENT_ID, orderId: PROVIDER_ORDER },
      CTX,
    );
    expect(late).toEqual({ result: "no_op" });
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("paid"); // still paid
    expect(d.balances.get(PAYER)).toBe(50); // credits intact
    expect(emitted(d.events)).toEqual(["payment.captured"]); // no spurious failure event
  });

  it("grants the STAMPED credits, not the catalog's — a mid-flight pack edit cannot touch an open order", async () => {
    // THE BUG THIS CLOSES. An order is created for pack_50 (₹2,000 / 50 credits). While the
    // buyer is on Razorpay's page, ops re-sizes pack_50 to 10 credits. Before `credits_granted`
    // existed the buyer paid ₹2,000 and received 10 credits, because the amount came off the
    // order row and the credits came off the live catalog. The window is unbounded: a tab left
    // open across a pricing change is enough.
    d.seedOrder(); // ₹2,000 / 50 credits, stamped
    d.pricing.getActiveCatalog.mockResolvedValue({
      catalog: {
        ...DEFAULT_CATALOG,
        products: DEFAULT_CATALOG.products.map((p) =>
          p.kind === "credit_pack" && p.code === "contact_unlock"
            ? { ...p, tiers: [{ code: "pack_50", priceInr: 300, credits: 10, windowDays: 14 }] }
            : p,
        ),
      } as typeof DEFAULT_CATALOG,
      revision: 9,
      source: "db" as const,
    });

    const out = await d.svc.handleRazorpayEvent(captureEvent(), CTX);

    expect(out).toEqual({ result: "granted" });
    expect(d.balances.get(PAYER)).toBe(50); // the STAMPED grant — NOT the catalog's 10
    expect(d.ledger[0]).toMatchObject({ delta: 50, priceInr: 2000 }); // both sides agree
    // The capture event reports what the buyer actually bought, so the spine reconciles too.
    const payload = (d.events.emit.mock.calls[0]?.[0] as { payload: Record<string, unknown> })
      .payload;
    expect(payload).toMatchObject({ amount_inr: 2000, amount_credits: 50 });
  });

  it("a pack DELETED from the catalog mid-flight still grants (it can no longer strand a payment)", async () => {
    // Previously this returned `unresolvable_pack` and left a captured payment ungranted
    // until a human intervened. The grant no longer depends on the catalog at all.
    d.seedOrder({ packCode: "pack_vanished" });
    d.pricing.getActiveCatalog.mockResolvedValue({
      catalog: DEFAULT_CATALOG, // no such tier
      revision: 3,
      source: "db" as const,
    });
    const out = await d.svc.handleRazorpayEvent(captureEvent(), CTX);
    expect(out).toEqual({ result: "granted" });
    expect(d.ledger).toHaveLength(1);
    expect(d.balances.get(PAYER)).toBe(50);
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("paid");
  });

  it("a CATALOG OUTAGE at capture time cannot block a grant (the drift check is a signal, not a gate)", async () => {
    d.seedOrder();
    d.pricing.getActiveCatalog.mockRejectedValue(new Error("catalog unavailable"));
    const out = await d.svc.handleRazorpayEvent(captureEvent(), CTX);
    expect(out).toEqual({ result: "granted" });
    expect(d.balances.get(PAYER)).toBe(50);
  });

  it("the settle path NEVER reads the catalog for the grant amount", async () => {
    // Structural: the only catalog read left on this path is the ops drift WARNING, which
    // cannot influence the result. Proven by making the catalog return an absurd tier and
    // asserting the grant is unmoved (above), and here by pinning that a settle with the
    // catalog stubbed to a wildly different pack still produces the stamped numbers.
    d.seedOrder({ creditsGranted: 7, amountInr: 999 });
    await d.svc.handleRazorpayEvent(captureEvent(), CTX);
    expect(d.ledger[0]).toMatchObject({ delta: 7, priceInr: 999 });
    expect(d.balances.get(PAYER)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// The webhook / verify RACE — the property this whole design exists for
// ---------------------------------------------------------------------------

describe("webhook ⇄ verify RACE — exactly one grant, one ledger row, correct balance", () => {
  let d: ReturnType<typeof makeService>;
  const signature = signCheckoutForTest(PROVIDER_ORDER, PAYMENT_ID, KEY_SECRET);

  beforeEach(() => {
    d = makeService();
    d.seedOrder();
  });

  it("both channels fired CONCURRENTLY grant exactly once (balance 50, not 100)", async () => {
    // Both start before either claims — the fake's findPaymentOrder awaits a tick, so both
    // read status='created'. That read→claim window is precisely what the conditional
    // UPDATE closes; if it were a read-then-write, this test would see a double grant.
    const [webhook, verify] = await Promise.all([
      d.svc.handleRazorpayEvent(captureEvent(), CTX),
      d.svc.verifyCheckoutPayment(
        PAYER,
        { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature },
        CTX,
      ),
    ]);

    expect(d.ledger).toHaveLength(1); // ONE ledger row
    expect(d.balances.get(PAYER)).toBe(50); // ONE grant
    expect(emitted(d.events)).toEqual(["payment.captured"]); // ONE capture event

    // Exactly one channel reports a grant; the other reports the settled state — and the
    // payer-facing one is a SUCCESS either way (never a false failure).
    expect(["granted", "no_op"]).toContain(webhook.result);
    expect(verify.verified).toBe(true);
  });

  it("verify FIRST, then the webhook: the webhook no-ops and the balance is still 50", async () => {
    const verify = await d.svc.verifyCheckoutPayment(
      PAYER,
      { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature },
      CTX,
    );
    const webhook = await d.svc.handleRazorpayEvent(captureEvent(), CTX);

    expect(verify).toMatchObject({
      verified: true,
      balance: 50,
      credits: 50,
      pack_code: "pack_50",
    });
    expect(webhook).toEqual({ result: "no_op" });
    expect(d.ledger).toHaveLength(1);
    expect(d.balances.get(PAYER)).toBe(50);
    expect(emitted(d.events)).toEqual(["payment.captured"]);
  });

  it("webhook FIRST, then verify: the payer is told SUCCESS with the real balance (never a false failure)", async () => {
    await d.svc.handleRazorpayEvent(captureEvent(), CTX);
    const verify = await d.svc.verifyCheckoutPayment(
      PAYER,
      { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature },
      CTX,
    );
    // This is the whole point of the fallback: a buyer whose webhook landed first must not
    // be shown "payment failed" — they see verified:true and their true balance.
    expect(verify).toMatchObject({ verified: true, balance: 50, credits: 0 });
    expect(d.ledger).toHaveLength(1);
    expect(emitted(d.events)).toEqual(["payment.captured"]);
  });

  it("verify replayed many times after settlement never adds a credit", async () => {
    await d.svc.verifyCheckoutPayment(
      PAYER,
      { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature },
      CTX,
    );
    for (let i = 0; i < 4; i += 1) {
      const again = await d.svc.verifyCheckoutPayment(
        PAYER,
        { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature },
        CTX,
      );
      expect(again).toMatchObject({ verified: true, credits: 0 });
    }
    expect(d.ledger).toHaveLength(1);
    expect(d.balances.get(PAYER)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// verify — authentication + tenancy
// ---------------------------------------------------------------------------

describe("POST /payer/credits/verify — signature + ownership", () => {
  let d: ReturnType<typeof makeService>;
  const signature = signCheckoutForTest(PROVIDER_ORDER, PAYMENT_ID, KEY_SECRET);

  beforeEach(() => {
    d = makeService();
    d.seedOrder();
  });

  it("REFUSES a forged signature and grants nothing", async () => {
    const out = await d.svc.verifyCheckoutPayment(
      PAYER,
      { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature: "f".repeat(64) },
      CTX,
    );
    expect(out).toEqual({ verified: false });
    expect(d.ledger).toHaveLength(0);
    expect(d.balances.get(PAYER)).toBeUndefined();
    expect(emitted(d.events)).toEqual([]);
  });

  it("REFUSES a signature signed with the WEBHOOK secret (the secrets are not interchangeable)", async () => {
    const wrong = signCheckoutForTest(PROVIDER_ORDER, PAYMENT_ID, "whsec_test");
    const out = await d.svc.verifyCheckoutPayment(
      PAYER,
      { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature: wrong },
      CTX,
    );
    expect(out).toEqual({ verified: false });
    expect(d.ledger).toHaveLength(0);
  });

  it("REFUSES another tenant's order with the byte-identical body (no order-id oracle)", async () => {
    // A valid signature, a real order — but not this payer's. The answer must be the same
    // shape as "no such order", so the endpoint cannot be used to enumerate order ids.
    const notMine = await d.svc.verifyCheckoutPayment(
      OTHER_PAYER,
      { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature },
      CTX,
    );
    const nonExistent = await d.svc.verifyCheckoutPayment(
      OTHER_PAYER,
      {
        orderId: "order_NOPE",
        paymentId: PAYMENT_ID,
        signature: signCheckoutForTest("order_NOPE", PAYMENT_ID, KEY_SECRET),
      },
      CTX,
    );
    expect(notMine).toEqual({ verified: false });
    expect(nonExistent).toEqual(notMine);
    expect(d.ledger).toHaveLength(0);
    expect(d.balances.get(OTHER_PAYER)).toBeUndefined();
    // …and the victim's order is untouched.
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("created");
  });

  it("credits the ORDER's payer, never the caller (the grant follows the row, not the session)", async () => {
    await d.svc.verifyCheckoutPayment(
      PAYER,
      { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature },
      CTX,
    );
    expect(d.ledger[0]?.payerId).toBe(PAYER);
    expect(d.balances.get(OTHER_PAYER)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mock mode is untouched
// ---------------------------------------------------------------------------

describe("PAYMENTS_ENABLE_REAL=false — the mock path is unchanged and remains the default", () => {
  const MOCK_CONFIG = { PAYMENTS_ENABLE_REAL: false } as unknown as ServerConfig;

  function makeMockService() {
    const fake = makeFakeRepo();
    const pricing = {
      getActiveCatalog: vi.fn(async () => ({
        catalog: DEFAULT_CATALOG,
        revision: 1,
        source: "db" as const,
      })),
    };
    const razorpay = {
      isLive: false,
      keyId: null,
      createOrder: vi.fn(async () => {
        throw new Error("must never be called with real payments off");
      }),
    };
    const events = { emit: vi.fn(async (p: Record<string, unknown>) => p) };
    fake.repo.creditPack = vi.fn(async () => 50);
    const payments = new PaymentGateway(
      fake.repo as unknown as UnlocksRepository,
      MOCK_CONFIG,
      pricing as unknown as PricingService,
      razorpay as unknown as RazorpayClient,
    );
    const svc = new UnlockService(
      fake.repo as unknown as UnlocksRepository,
      {} as unknown as ConsentRepository,
      {} as unknown as WorkersRepository,
      {} as unknown as PiiCryptoService,
      payments,
      events as unknown as EventsService,
      MOCK_CONFIG,
    );
    return { svc, events, razorpay, repo: fake.repo };
  }

  it("realPaymentsLive is false, so the real routes are inert", () => {
    expect(makeMockService().svc.realPaymentsLive).toBe(false);
  });

  it("the MOCK purchase still works end-to-end with real_call:false", async () => {
    const d = makeMockService();
    const out = await d.svc.purchaseCredits(PAYER, "pack_50", CTX);
    expect(out).toEqual({ payer_id: PAYER, balance: 50, credits: 50, pack_code: "pack_50" });
    expect(emitted(d.events)).toEqual(["payment.authorized", "payment.captured"]);
    for (const call of d.events.emit.mock.calls) {
      const payload = (call[0] as { payload: { real_call: boolean } }).payload;
      expect(payload.real_call).toBe(false); // honest mock flag
    }
    // No provider was contacted and no order row exists.
    expect(d.razorpay.createOrder).not.toHaveBeenCalled();
    expect(d.repo.createPaymentOrder).not.toHaveBeenCalled();
  });

  it("verify cannot be used to grant credits while real payments are off (fail closed)", async () => {
    const d = makeMockService();
    const out = await d.svc.verifyCheckoutPayment(
      PAYER,
      {
        orderId: PROVIDER_ORDER,
        paymentId: PAYMENT_ID,
        signature: signCheckoutForTest(PROVIDER_ORDER, PAYMENT_ID, KEY_SECRET),
      },
      CTX,
    );
    expect(out).toEqual({ verified: false });
    expect(emitted(d.events)).toEqual([]);
  });
});
