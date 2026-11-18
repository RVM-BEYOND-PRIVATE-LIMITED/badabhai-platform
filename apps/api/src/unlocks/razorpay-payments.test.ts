import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { DEFAULT_CATALOG, DEFAULT_CREDIT_RULES } from "@badabhai/pricing";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { ConsentRepository } from "../consent/consent.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import { PricingService } from "../pricing/pricing.service";
import { UnlockService } from "./unlocks.service";
import type { UnlocksRepository, Tx } from "./unlocks.repository";
import { PaymentGateway } from "./payment-gateway";
import type { RazorpayClient } from "./razorpay.client";
import type { PackReturnResult, PaymentOrder, PaymentOrderStatus } from "@badabhai/db";
import {
  CreateCreditOrderSchema,
  toPaymentEvent,
  RazorpayWebhookSchema,
} from "./razorpay-webhook.dto";
import { signCheckoutForTest } from "./razorpay-signature";
import type { Queue } from "bullmq";
import type { ReferralBonusJobData } from "../queue/queue.constants";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import type {
  ActiveMembershipFacts,
  PayerOrgTenancyMode,
} from "../payers/payer-tenant-scope";

/**
 * REAL-MONEY IDEMPOTENCY — the properties that must hold when Razorpay retries a webhook
 * while the payer's browser is simultaneously calling verify.
 *
 * The fake repository below is not a convenience mock: it models the exact DB guarantees
 * the production code leans on, so a change that quietly drops one of them fails here.
 *  - UNIQUE (provider, provider_order_id) on payment_orders;
 *  - `credits_granted` NOT NULL, stamped at creation and read back at settle;
 *  - the conditional `status IN ('created','failed') → 'paid'` UPDATE as an ATOMIC compare-and-set
 *    (and the same CAS to 'held', #2749 hardening 5);
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

/**
 * The REAL tenant resolver (ADR-0053) over a fake membership read: `memberships` maps a payer id
 * to its ACTIVE memberships. Default `off` with none — every caller is their own tenant.
 */
function tenancyService(
  mode: PayerOrgTenancyMode = "off",
  memberships: Record<string, ActiveMembershipFacts[]> = {},
): PayerTenantScopeService {
  return new PayerTenantScopeService(
    { PAYER_ORG_TENANCY_MODE: mode } as unknown as ServerConfig,
    {
      listActiveMembershipsWithAnchor: vi.fn(async (id: string) => memberships[id] ?? []),
      ensureSoloOrg: vi.fn(async () => null),
    } as unknown as PayerOrgsRepository,
  );
}

/** Yield to the microtask queue so two in-flight settles genuinely interleave. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

interface LedgerRow {
  payerId: string;
  delta: number;
  packCode: string | null;
  paymentRef: string | null;
  priceInr: number | null;
  idempotencyKey: string | null;
  /** #2749 PR 3 — the lot's validity, in days (null = never expires). */
  validityDays: number | null;
}

/**
 * An in-memory stand-in for UnlocksRepository that preserves the DB's concurrency
 * semantics. `claimAndCreditPaymentOrderWithinTx` performs its compare-and-set SYNCHRONOUSLY,
 * which is what makes a single-statement conditional UPDATE atomic in Postgres.
 */
function makeFakeRepo() {
  const orders = new Map<string, PaymentOrder>(); // keyed by `${provider}:${providerOrderId}`
  const ledger: LedgerRow[] = [];
  const ledgerKeys = new Set<string>(); // the partial UNIQUE index on idempotency_key
  const balances = new Map<string, number>();
  // #2750 item 9 — what the repository's pack return gives back when the settle asks for one.
  const packReturn: { result: PackReturnResult } = {
    result: { lines: [], credits: 0, expiresAt: null },
  };

  const key = (provider: string, providerOrderId: string): string =>
    `${provider}:${providerOrderId}`;
  /** The statuses a capture may move an order out of (the repository's CAPTURABLE set). */
  const capturable = (row: PaymentOrder): boolean =>
    row.status === "created" || row.status === "failed";
  /** `${tenant}:${refId}` → what the tenant owns, for the order-origin ownership read. */
  const owned = new Map<string, { kind: "job" | "posting"; id: string }>();

  const seedOrder = (over: Partial<PaymentOrder> = {}): PaymentOrder => {
    // By default an order shaped like a pre-0176 row (no paise columns): it expects
    // amount_inr × 100 = 200000 paise, which is what `captureEvent()` reports.
    const row: PaymentOrder = {
      id: ORDER_ROW,
      payerId: PAYER,
      productKind: "credit_pack",
      packCode: "pack_50",
      amountInr: 2000,
      creditsGranted: 50, // stamped at creation — the settle path reads THIS, not the catalog
      provider: "razorpay",
      providerOrderId: PROVIDER_ORDER,
      status: "created" as PaymentOrderStatus,
      providerPaymentRef: null,
      taxablePaise: null,
      gstPaise: null,
      roundOffPaise: null,
      totalPaise: null,
      gstRateBps: null,
      creditValidityDays: null,
      origin: null,
      originJobPostingId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    };
    orders.set(key(row.provider, row.providerOrderId), row);
    return row;
  };

  /** The fake ledger movement (the real one is one upsert + one insert in a transaction). */
  async function creditPackWithinTx(
    _tx: Tx,
    input: {
      payerId: string;
      credits: number;
      packCode: string | null;
      paymentRef: string | null;
      priceInr?: number | null;
      idempotencyKey?: string | null;
      validityDays?: number | null;
    },
  ): Promise<number> {
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
      validityDays: input.validityDays ?? null,
    });
    const next = (balances.get(input.payerId) ?? 0) + input.credits;
    balances.set(input.payerId, next);
    return next;
  }

  const repo = {
    // A transaction is just "run the callback"; the atomicity that matters is inside the CAS.
    withTransaction: vi.fn(async <T>(work: (tx: Tx) => Promise<T>): Promise<T> => work({} as Tx)),

    createPaymentOrder: vi.fn(
      async (input: {
        id?: string;
        payerId: string;
        packCode: string;
        amountInr: number;
        creditsGranted: number;
        providerOrderId: string;
        provider?: string;
        money?: {
          taxablePaise: number;
          gstPaise: number;
          roundOffPaise: number;
          totalPaise: number;
          gstRateBps: number;
        } | null;
        creditValidityDays?: number | null;
        origin?: PaymentOrder["origin"];
        originJobPostingId?: string | null;
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
        // payment_orders_money_sum_chk: the rupee column is the paise total, a whole rupee.
        if (input.money && input.money.totalPaise !== input.amountInr * 100) {
          throw new Error('new row violates check constraint "payment_orders_money_sum_chk"');
        }
        const row: PaymentOrder = {
          id: input.id ?? ORDER_ROW,
          payerId: input.payerId,
          productKind: "credit_pack",
          packCode: input.packCode,
          amountInr: input.amountInr,
          creditsGranted: input.creditsGranted,
          provider,
          providerOrderId: input.providerOrderId,
          status: "created",
          providerPaymentRef: null,
          taxablePaise: input.money?.taxablePaise ?? null,
          gstPaise: input.money?.gstPaise ?? null,
          roundOffPaise: input.money?.roundOffPaise ?? null,
          totalPaise: input.money?.totalPaise ?? null,
          gstRateBps: input.money?.gstRateBps ?? null,
          creditValidityDays: input.creditValidityDays ?? null,
          origin: input.origin ?? null,
          originJobPostingId: input.originJobPostingId ?? null,
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

    // THE RACE CLOSURE + the grant, as ONE call (ADR-0053 §6). The check-and-set is SYNCHRONOUS
    // (one statement in Postgres); the credit then uses ONLY the claimed row — its stamped wallet,
    // credits and ₹ (the real mapping is pinned in unlocks.repository.test.ts).
    claimAndCreditPaymentOrderWithinTx: vi.fn(
      async (
        tx: Tx,
        input: {
          providerOrderId: string;
          providerPaymentRef: string;
          provider?: string;
          packReturn?: { max: number; windowMonths: number };
        },
      ) => {
        const row = orders.get(key(input.provider ?? "razorpay", input.providerOrderId));
        // `status IN ('created','failed')`: a paid or HELD row matches nothing.
        if (!row || !capturable(row)) return undefined;
        const claimed: PaymentOrder = {
          ...row,
          status: "paid",
          providerPaymentRef: input.providerPaymentRef,
          updatedAt: new Date(),
        };
        orders.set(key(claimed.provider, claimed.providerOrderId), claimed);
        const balanceAfter = await creditPackWithinTx(tx, {
          payerId: claimed.payerId,
          credits: claimed.creditsGranted,
          packCode: claimed.packCode,
          paymentRef: input.providerPaymentRef,
          priceInr: claimed.amountInr,
          idempotencyKey: `payment_order:${claimed.id}`,
          validityDays: claimed.creditValidityDays,
        });
        return {
          order: claimed,
          balanceAfter: balanceAfter + (input.packReturn ? packReturn.result.credits : 0),
          packReturn: input.packReturn ? packReturn.result : null,
        };
      },
    ),

    // #2749 hardening 5 — the same synchronous CAS, to 'held'; the hook runs "in" its transaction.
    holdPaymentOrder: vi.fn(
      async (
        input: { providerOrderId: string; providerPaymentRef: string; provider?: string },
        withinTx?: (tx: Tx, held: PaymentOrder) => Promise<void>,
      ) => {
        const row = orders.get(key(input.provider ?? "razorpay", input.providerOrderId));
        if (!row || !capturable(row)) return undefined;
        const held: PaymentOrder = {
          ...row,
          status: "held",
          providerPaymentRef: input.providerPaymentRef,
          updatedAt: new Date(),
        };
        orders.set(key(held.provider, held.providerOrderId), held);
        if (withinTx) {
          try {
            await withinTx({} as Tx, held);
          } catch (err) {
            orders.set(key(row.provider, row.providerOrderId), row); // the rollback
            throw err;
          }
        }
        return held;
      },
    ),

    // #1899 ownership read behind the order origin: `owned` maps a ref id to what the tenant owns.
    findOwnedJobRef: vi.fn(
      async (refId: string, tenant: string) => owned.get(`${tenant}:${refId}`) ?? null,
    ),

    markPaymentOrderFailed: vi.fn(async (providerOrderId: string, provider = "razorpay") => {
      const row = orders.get(key(provider, providerOrderId));
      if (!row || !capturable(row)) return undefined; // never walk back a capture or a hold
      const next: PaymentOrder = { ...row, status: "failed", updatedAt: new Date() };
      orders.set(key(provider, providerOrderId), next);
      return next;
    }),

    creditPack: vi.fn(async () => 0),
    getBalance: vi.fn(async (payerId: string) => balances.get(payerId) ?? 0),
  };

  return { repo, orders, ledger, balances, seedOrder, key, owned, packReturn };
}

function makeService(
  opts: {
    payerStatus?: "pending" | "active" | "suspended";
    /** ADR-0053: the tenant resolver (default: mode `off`, every caller its own tenant). */
    tenancy?: PayerTenantScopeService;
    /** #2750 item 9 — the credit rules switch for the order's company (absent: no rules at all). */
    creditRules?: { state: "on" | "off" | "unavailable"; readFails?: boolean; max?: number };
  } = {},
) {
  const fake = makeFakeRepo();
  // ADR-0037 Decision 6 — the payer's lifecycle status at capture time.
  const payers = {
    findAuthFacts: vi.fn(async () => ({
      role: "employer" as const,
      status: opts.payerStatus ?? ("active" as const),
    })),
  };
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
    // Razorpay's echo of the order it created: by default the amount it was asked for, in paise,
    // in INR. A case makes it echo something else to prove the gateway refuses (#2749).
    createOrder: vi.fn(async ({ amountInr }: { amountInr: number }) => ({
      orderId: PROVIDER_ORDER,
      amountPaise: amountInr * 100,
      currency: "INR",
    })),
    // `GET /payments/:id` for the browser verify (#2749): by default a captured payment of the
    // seeded order's amount (₹2,000 = 200000 paise) on PROVIDER_ORDER.
    fetchPayment: vi.fn(async (paymentId: string) => ({
      id: paymentId,
      orderId: PROVIDER_ORDER as string | null,
      amountPaise: 200000,
      currency: "INR",
      status: "captured",
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
    // §X.6 — the activation-bonus queue. Inert here: these tests exercise the payment
    // path, and a credit purchase is not the unlock grant that completes the bonus rule.
    { add: vi.fn(async () => undefined) } as unknown as Queue<ReferralBonusJobData>,
    // ADR-0036 §7 — read only for `free_tier_credits`. A credit PURCHASE only ever raises
    // a balance, so the exhaustion signal this feeds cannot fire on the paths under test.
    { get: vi.fn().mockResolvedValue(DEFAULT_MATCH_CONFIG) } as never,
    // ADR-0037 Decision 6 — the lifecycle read behind the suspended-capture alert.
    // MUST be wired even for the active-payer cases: the alert helper is fail-open, so an
    // undefined dependency here would be swallowed by its catch and every assertion below
    // would still pass while the alert silently never worked.
    payers as never,
    opts.tenancy ?? tenancyService("off"),
    // #2752 — the institute open gate: nobody here is an institute student.
    { decide: vi.fn(async () => "not_linked") } as never,
    ...(opts.creditRules
      ? [
          { stateFor: vi.fn(async () => opts.creditRules!.state) } as never,
          {
            get: vi.fn(async () => {
              if (opts.creditRules!.readFails) throw new Error("settings row unreadable");
              return {
                ...DEFAULT_CREDIT_RULES,
                returnedCreditsMax: opts.creditRules!.max ?? 20,
                returnedCreditsWindowMonths: 6,
              };
            }),
          } as never,
        ]
      : []),
  );
  return { svc, payments, events, razorpay, pricing, payers, ...fake };
}

/** The event names emitted, in order. */
function emitted(events: { emit: { mock: { calls: unknown[][] } } }): string[] {
  return events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
}

/** A verified capture. 200000 paise = the default seeded (pre-0176) order's ₹2,000. */
const captureEvent = (
  orderId: string = PROVIDER_ORDER,
  paymentId: string = PAYMENT_ID,
  amount: number = 200000,
) =>
  toPaymentEvent(
    RazorpayWebhookSchema.parse({
      event: "payment.captured",
      payload: {
        payment: { entity: { id: paymentId, order_id: orderId, amount, currency: "INR" } },
      },
    }),
  );

// ---------------------------------------------------------------------------
// Order creation — the price is OURS, never the client's
// ---------------------------------------------------------------------------

/** DEFAULT_CATALOG whose only `contact_unlock` tier is pack_50 (₹2,000 / 50) with `extra` fields. */
function catalogWithPack50(extra: { offered?: boolean; onSaleFrom?: string }) {
  return {
    ...DEFAULT_CATALOG,
    products: DEFAULT_CATALOG.products.map((p) =>
      p.kind === "credit_pack" && p.code === "contact_unlock"
        ? {
            ...p,
            tiers: [{ code: "pack_50", priceInr: 2000, credits: 50, windowDays: 14, ...extra }],
          }
        : p,
    ),
  } as typeof DEFAULT_CATALOG;
}

describe("POST /payer/credits/order — the charged amount is the CATALOG price, GST included", () => {
  let d: ReturnType<typeof makeService>;
  beforeEach(() => {
    d = makeService();
  });

  it("charges the pack's catalog price WITH GST and stamps the whole line on the order row", async () => {
    const order = await d.svc.createCreditOrder(PAYER, "pack_50", CTX);
    // DEFAULT_CATALOG's pack_50 is ₹2,000 / 50 credits; with 18% GST the total is ₹2,360.
    expect(order).not.toBeNull();
    expect(order?.amountInr).toBe(2360);
    expect(order?.amountPaise).toBe(236000);
    expect(order?.credits).toBe(50);
    expect(order?.price).toEqual({
      taxablePaise: 200000,
      gstPaise: 36000,
      roundOffPaise: 0,
      totalPaise: 236000,
      gstRateBps: 1800,
    });
    // The provider was asked for exactly that total…
    expect(d.razorpay.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amountInr: 2360 }),
    );
    // …and the persisted receipt carries BOTH SIDES of the transaction — the ₹ AND the
    // credits — from that one catalog read. A receipt with only the amount is the gap that
    // let a mid-flight pack edit change what an existing order was worth.
    expect(d.repo.createPaymentOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        payerId: PAYER,
        packCode: "pack_50",
        amountInr: 2360,
        creditsGranted: 50,
        money: {
          taxablePaise: 200000,
          gstPaise: 36000,
          roundOffPaise: 0,
          totalPaise: 236000,
          gstRateBps: 1800,
        },
        creditValidityDays: null, // DEFAULT_CATALOG's packs set no validity
        origin: null,
        originJobPostingId: null,
      }),
    );
    const row = d.orders.get(`razorpay:${PROVIDER_ORDER}`);
    expect(row?.creditsGranted).toBe(50);
    expect(row?.totalPaise).toBe(236000);
    // The row id IS the receipt and the notes' id (the two-way reconciliation link).
    const asked = d.razorpay.createOrder.mock.calls[0]?.[0] as unknown as {
      receipt: string;
      notes: { payment_order_id: string };
    };
    expect(row?.id).toBe(asked.receipt);
    expect(asked.notes.payment_order_id).toBe(asked.receipt);
    expect(order?.orderRowId).toBe(asked.receipt);
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
    // ₹1,500 + 18% = ₹1,770.
    expect(order?.amountInr).toBe(1770);
    expect(order?.credits).toBe(60);
    expect(d.razorpay.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amountInr: 1770 }),
    );
    // Both edited values are stamped together, so the order is self-describing from here on.
    expect(d.repo.createPaymentOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amountInr: 1770, creditsGranted: 60 }),
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

  it("#2749: a constant-only code (pack_10, pack_25) is not orderable — no provider order, no row", async () => {
    expect(await d.svc.createCreditOrder(PAYER, "pack_10", CTX)).toBeNull();
    expect(await d.svc.createCreditOrder(PAYER, "pack_25", CTX)).toBeNull();
    expect(d.razorpay.createOrder).not.toHaveBeenCalled();
    expect(d.repo.createPaymentOrder).not.toHaveBeenCalled();
    expect(emitted(d.events)).toEqual([]);
  });

  it("#2749: a hidden catalogue pack (future onSaleFrom, offered:false) is not orderable", async () => {
    d.pricing.getActiveCatalog.mockResolvedValue({
      catalog: {
        ...DEFAULT_CATALOG,
        products: DEFAULT_CATALOG.products.map((p) =>
          p.kind === "credit_pack" && p.code === "contact_unlock"
            ? {
                ...p,
                tiers: [
                  { code: "pack_50", priceInr: 2000, credits: 50, windowDays: 14, offered: false },
                  {
                    code: "pack_annual",
                    priceInr: 9999,
                    credits: 360,
                    windowDays: 14,
                    onSaleFrom: "2999-01-01",
                  },
                ],
              }
            : p,
        ),
      } as typeof DEFAULT_CATALOG,
      revision: 3,
      source: "db" as const,
    });
    expect(await d.svc.createCreditOrder(PAYER, "pack_50", CTX)).toBeNull();
    expect(await d.svc.createCreditOrder(PAYER, "pack_annual", CTX)).toBeNull();
    expect(d.razorpay.createOrder).not.toHaveBeenCalled();
    expect(d.repo.createPaymentOrder).not.toHaveBeenCalled();
    expect(emitted(d.events)).toEqual([]);
  });

  it("#2749: a hidden pack with expected_price_inr is a 404 (null), NEVER a 409 — the sale check runs first", async () => {
    // The 409 body carries `current_price_inr`, so a price check that ran before the sale check
    // would disclose a hidden pack's price. Pin the order: off sale → null (the 404), no 409.
    d.pricing.getActiveCatalog.mockResolvedValue({
      catalog: catalogWithPack50({ offered: false }),
      revision: 3,
      source: "db" as const,
    });
    await expect(d.svc.createCreditOrder(PAYER, "pack_50", CTX, 1)).resolves.toBeNull();
    await expect(d.svc.createCreditOrder(PAYER, "pack_50", CTX, 2000)).resolves.toBeNull();
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
      amount_inr: 2360, // the total charged, GST included
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

  it("#2085: a matching expected_price_inr (the LIST price, before GST) creates the order", async () => {
    const order = await d.svc.createCreditOrder(PAYER, "pack_50", CTX, 2000);
    expect(order?.amountInr).toBe(2360);
    expect(d.razorpay.createOrder).toHaveBeenCalledOnce();
  });

  it("#2085: a mismatched expected_price_inr is a 409 — no provider order, no row, no event", async () => {
    await expect(d.svc.createCreditOrder(PAYER, "pack_50", CTX, 1500)).rejects.toMatchObject({
      status: 409,
      response: { reason: "price_mismatch", expected_price_inr: 1500, current_price_inr: 2000 },
    });
    expect(d.razorpay.createOrder).not.toHaveBeenCalled();
    expect(d.repo.createPaymentOrder).not.toHaveBeenCalled();
    expect(emitted(d.events)).toEqual([]);
  });

  it("#2085: the DTO accepts an integer expected_price_inr and rejects anything else", () => {
    expect(CreateCreditOrderSchema.parse({ pack_code: "pack_50", expected_price_inr: 2000 })).toEqual({
      pack_code: "pack_50",
      expected_price_inr: 2000,
    });
    for (const bad of [-1, 1.5, "2000", null]) {
      expect(
        CreateCreditOrderSchema.safeParse({ pack_code: "pack_50", expected_price_inr: bad }).success,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Webhook capture + replay
// ---------------------------------------------------------------------------

/** A provider failure delivery (it carries an amount, which the failure path ignores). */
const failedEvent = {
  eventName: "payment.failed",
  paymentId: PAYMENT_ID,
  orderId: PROVIDER_ORDER,
  amountPaise: 200000,
  currency: "INR",
};

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
      {
        eventName: "subscription.charged",
        paymentId: PAYMENT_ID,
        orderId: PROVIDER_ORDER,
        amountPaise: null,
        currency: null,
      },
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
    const out = await d.svc.handleRazorpayEvent({ ...failedEvent }, CTX);
    expect(out).toEqual({ result: "failed_recorded" });
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("failed");
    expect(d.ledger).toHaveLength(0);
    expect(emitted(d.events)).toEqual(["payment.failed"]);
  });

  it("a LATE payment.failed can never walk back a completed capture (webhooks are unordered)", async () => {
    await d.svc.handleRazorpayEvent(captureEvent(), CTX);
    const late = await d.svc.handleRazorpayEvent({ ...failedEvent }, CTX);
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

  it("#2749: an order placed while the pack was on sale still settles after it goes offered:false", async () => {
    // On sale at order time: the order is created and stamped (₹2,000 / 50 credits). Its own
    // provider id, since this suite's beforeEach already seeded PROVIDER_ORDER.
    const ORDER_ID = "order_on_sale_then_off";
    d.razorpay.createOrder.mockResolvedValueOnce({
      orderId: ORDER_ID,
      amountPaise: 236000,
      currency: "INR",
    });
    const order = await d.svc.createCreditOrder(PAYER, "pack_50", CTX);
    expect(order).toMatchObject({ providerOrderId: ORDER_ID, amountInr: 2360, credits: 50 });
    // Ops takes the pack off sale while the buyer is on Razorpay's page.
    d.pricing.getActiveCatalog.mockResolvedValue({
      catalog: catalogWithPack50({ offered: false }),
      revision: 4,
      source: "db" as const,
    });
    // A NEW order is refused…
    expect(await d.svc.createCreditOrder(PAYER, "pack_50", CTX)).toBeNull();
    // …but the payment already in flight settles, with the stamped grant.
    const out = await d.svc.handleRazorpayEvent(
      captureEvent(ORDER_ID, "pay_on_sale_then_off", 236000),
      CTX,
    );
    expect(out).toEqual({ result: "granted" });
    expect(d.balances.get(PAYER)).toBe(50);
    expect(d.ledger).toHaveLength(1);
    expect(d.ledger[0]).toMatchObject({ delta: 50, priceInr: 2360 });
    expect(d.orders.get(`razorpay:${ORDER_ID}`)?.status).toBe("paid");
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
    await d.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 99900), CTX);
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
      { add: vi.fn(async () => undefined) } as unknown as Queue<ReferralBonusJobData>,
      { get: vi.fn().mockResolvedValue(DEFAULT_MATCH_CONFIG) } as never,
      { findAuthFacts: vi.fn(async () => ({ role: "employer", status: "active" })) } as never,
      tenancyService("off"),
      { decide: vi.fn(async () => "not_linked") } as never, // #2752 — no institute students here
    );
    return { svc, events, razorpay, pricing, repo: fake.repo };
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

  it("#2749: a hidden pack with expected_price_inr is a 404 (null), NEVER a 409, on the mock route", async () => {
    const d = makeMockService();
    d.pricing.getActiveCatalog.mockResolvedValue({
      catalog: catalogWithPack50({ onSaleFrom: "2999-01-01" }),
      revision: 2,
      source: "db" as const,
    });
    // A wrong confirmed price would be a 409 carrying current_price_inr if the price check ran
    // first; the sale check runs first, so a hidden pack's price is never disclosed.
    await expect(d.svc.purchaseCredits(PAYER, "pack_50", CTX, 1)).resolves.toBeNull();
    await expect(d.svc.purchaseCredits(PAYER, "pack_50", CTX, 2000)).resolves.toBeNull();
    expect(d.repo.creditPack).not.toHaveBeenCalled();
    expect(emitted(d.events)).toEqual([]);
  });

  it("#2749: the mock route refuses a constant-only code — no credits, no ledger row, no event", async () => {
    const d = makeMockService();
    await expect(d.svc.purchaseCredits(PAYER, "pack_10", CTX)).resolves.toBeNull();
    await expect(d.svc.purchaseCredits(PAYER, "pack_25", CTX)).resolves.toBeNull();
    expect(d.repo.creditPack).not.toHaveBeenCalled();
    expect(emitted(d.events)).toEqual([]);
  });

  it("#2085: a matching expected_price_inr buys the pack; a mismatch leaves the ledger untouched", async () => {
    const ok = makeMockService();
    await expect(ok.svc.purchaseCredits(PAYER, "pack_50", CTX, 2000)).resolves.toMatchObject({
      credits: 50,
    });
    expect(ok.repo.creditPack).toHaveBeenCalledOnce();

    const refused = makeMockService();
    await expect(refused.svc.purchaseCredits(PAYER, "pack_50", CTX, 1999)).rejects.toMatchObject({
      status: 409,
      response: { reason: "price_mismatch", expected_price_inr: 1999, current_price_inr: 2000 },
    });
    expect(refused.repo.creditPack).not.toHaveBeenCalled(); // no ledger row, no credits
    expect(emitted(refused.events)).toEqual([]); // no payment.* for money that never moved
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

describe("a capture for a SUSPENDED payer (ADR-0037 Decision 6)", () => {
  it("STILL grants the credits — money already taken is never refused", async () => {
    // The ruling, and the reason for it: Razorpay has already captured the funds by the
    // time this webhook arrives, and there is no refund path anywhere in the codebase.
    // Refusing the credit would leave the platform holding money with no ledger entry
    // against it — strictly worse than crediting an account that cannot spend.
    const d = makeService({ payerStatus: "suspended" });
    d.seedOrder();
    const out = await d.svc.handleRazorpayEvent(captureEvent(), CTX);

    expect(out).toEqual({ result: "granted" });
    expect(d.ledger).toHaveLength(1);
    expect(d.balances.get(PAYER)).toBe(50);
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("paid");
  });

  it("raises the Finance/Admin alert ALONGSIDE the capture, not instead of it", async () => {
    const d = makeService({ payerStatus: "suspended" });
    d.seedOrder();
    await d.svc.handleRazorpayEvent(captureEvent(), CTX);

    // Both events: the money record AND the alert. Dropping `payment.captured` would
    // break the ledger↔spine correspondence the capture path guarantees.
    expect(emitted(d.events)).toEqual(["payment.captured", "payer.suspended_payment_captured"]);

    const alert = d.events.emit.mock.calls[1]![0] as {
      payload: Record<string, unknown>;
      idempotencyKey?: string;
    };
    // The ORDER id, not the amount: the amount already lives on `payment.captured` and on
    // the ledger row keyed to the same order. Repeating it would create a second place for
    // the money to be stated, and to disagree.
    expect(alert.payload).toEqual({ payer_id: PAYER, order_id: ORDER_ROW });
    expect(alert.idempotencyKey).toBe(`payer.suspended_payment_captured:order:${ORDER_ROW}`);
  });

  it("an ACTIVE payer's capture raises NO alert (the alert means something)", async () => {
    // The control. Without it, a mutation that alerted on every capture would satisfy the
    // assertions above while burying real alerts in noise.
    const d = makeService({ payerStatus: "active" });
    d.seedOrder();
    await d.svc.handleRazorpayEvent(captureEvent(), CTX);
    expect(emitted(d.events)).toEqual(["payment.captured"]);
  });

  it("a REPLAYED webhook raises no second alert (keyed on the order, like the money)", async () => {
    const d = makeService({ payerStatus: "suspended" });
    d.seedOrder();
    await d.svc.handleRazorpayEvent(captureEvent(), CTX);
    const replay = await d.svc.handleRazorpayEvent(captureEvent(), CTX);

    expect(replay).toEqual({ result: "no_op" });
    // The replay settles to `already_settled`, so it never reaches the alert at all.
    expect(emitted(d.events)).toEqual(["payment.captured", "payer.suspended_payment_captured"]);
  });

  it("FAIL-OPEN: a broken status read cannot turn a successful capture into a 5xx", async () => {
    // This is the whole reason the helper swallows. Throwing here would make Razorpay
    // redeliver a payment we already settled — trading a missing notification for a retry
    // storm on the money path.
    const d = makeService({ payerStatus: "suspended" });
    d.seedOrder();
    d.payers.findAuthFacts.mockRejectedValueOnce(new Error("db down"));

    const out = await d.svc.handleRazorpayEvent(captureEvent(), CTX);

    expect(out).toEqual({ result: "granted" });
    expect(d.balances.get(PAYER)).toBe(50);
    expect(emitted(d.events)).toEqual(["payment.captured"]);
  });
});

// ---------------------------------------------------------------------------
// ADR-0053 (PAY-DB-01) §6 — the ORG wallet on the real-payment path
// ---------------------------------------------------------------------------

describe("ADR-0053 — real orders are stamped with the org wallet at intent; settlement never re-resolves", () => {
  const ANCHOR = PAYER; // A — the org's founder; their existing wallet IS the org wallet
  const MEMBER = "cccccccc-0000-4000-8000-000000000003"; // B — an active recruiter in A's org
  const OUTSIDER = OTHER_PAYER; // C — a solo payer
  const signature = signCheckoutForTest(PROVIDER_ORDER, PAYMENT_ID, KEY_SECRET);

  const facts = (anchor: string, orgRole: "owner" | "recruiter"): ActiveMembershipFacts => ({
    orgId: `0${anchor.slice(1)}`,
    orgRole,
    acceptedAt: new Date(orgRole === "owner" ? "2026-05-01" : "2026-07-01"),
    orgStatus: "active",
    anchorPayerId: anchor,
    anchorRole: "employer",
    anchorStatus: "active",
    memberRole: "employer",
  });
  const on = () =>
    tenancyService("on", {
      [ANCHOR]: [facts(ANCHOR, "owner")],
      [MEMBER]: [facts(MEMBER, "owner"), facts(ANCHOR, "recruiter")],
      [OUTSIDER]: [facts(OUTSIDER, "owner")],
    });

  type Emitted = { event_name: string; actor: { actor_id: string }; payload: { payer_id: string } };
  const sent = (d: ReturnType<typeof makeService>): Emitted[] =>
    d.events.emit.mock.calls.map((c) => c[0] as Emitted);

  it("a teammate's order is stamped with the ORG's wallet; payment.authorized names the teammate and the org", async () => {
    const d = makeService({ tenancy: on() });
    await d.svc.createCreditOrder(MEMBER, "pack_50", CTX);
    expect(d.repo.createPaymentOrder).toHaveBeenCalledWith(
      expect.objectContaining({ payerId: ANCHOR, creditsGranted: 50, amountInr: 2360 }),
    );
    const [authorized] = sent(d);
    expect(authorized?.event_name).toBe("payment.authorized");
    expect(authorized?.actor.actor_id).toBe(MEMBER);
    expect(authorized?.payload.payer_id).toBe(ANCHOR);
  });

  it("the teammate verifies it: the credits land in the ORG wallet, the body echoes the caller", async () => {
    const d = makeService({ tenancy: on() });
    d.seedOrder({ payerId: ANCHOR }); // what the stamp above writes
    const out = await d.svc.verifyCheckoutPayment(
      MEMBER,
      { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature },
      CTX,
    );
    expect(out).toEqual({
      verified: true,
      payer_id: MEMBER,
      balance: 50,
      credits: 50,
      pack_code: "pack_50",
      // #2750 item 9 — not under the credit rules: nothing came back.
      credits_returned: 0,
    });
    expect(d.balances.get(ANCHOR)).toBe(50);
    expect(d.balances.get(MEMBER)).toBeUndefined(); // the personal wallet is untouched (O-2)
    expect(d.ledger).toEqual([expect.objectContaining({ payerId: ANCHOR, delta: 50 })]);
    const [captured] = sent(d);
    expect(captured?.event_name).toBe("payment.captured");
    expect(captured?.actor.actor_id).toBe(MEMBER); // who verified
    expect(captured?.payload.payer_id).toBe(ANCHOR); // the wallet credited
  });

  it("any member may verify the org's order — the anchor settles one a teammate created", async () => {
    const d = makeService({ tenancy: on() });
    d.seedOrder({ payerId: ANCHOR });
    const out = await d.svc.verifyCheckoutPayment(
      ANCHOR,
      { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature },
      CTX,
    );
    expect(out).toMatchObject({ verified: true, payer_id: ANCHOR, balance: 50 });
    expect(d.balances.get(ANCHOR)).toBe(50);
  });

  it("an outsider cannot verify the org's order — the byte-identical refusal, and nothing moves", async () => {
    const d = makeService({ tenancy: on() });
    d.seedOrder({ payerId: ANCHOR });
    const out = await d.svc.verifyCheckoutPayment(
      OUTSIDER,
      { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature },
      CTX,
    );
    expect(out).toEqual({ verified: false });
    expect(d.ledger).toHaveLength(0);
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("created");
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("an order stamped BEFORE the flip settles into the wallet it was created for — the webhook never re-resolves", async () => {
    const d = makeService({ tenancy: on() });
    d.seedOrder({ payerId: MEMBER }); // B bought for their OWN wallet while the mode was off
    // B's browser verify after the flip is refused: B's tenant is now A, and the stamped wallet
    // is not A (ADR-0053 §6 compares with the tenant). The webhook — the source of truth — is
    // what settles it, and it credits the STAMPED wallet.
    const verify = await d.svc.verifyCheckoutPayment(
      MEMBER,
      { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature },
      CTX,
    );
    expect(verify).toEqual({ verified: false });
    expect(d.ledger).toHaveLength(0);

    expect(await d.svc.handleRazorpayEvent(captureEvent(), CTX)).toEqual({ result: "granted" });
    expect(d.balances.get(MEMBER)).toBe(50);
    expect(d.balances.get(ANCHOR)).toBeUndefined();
    const [captured] = sent(d);
    expect(captured?.actor.actor_id).toBe(MEMBER); // no login acted: the stamped wallet
    expect(captured?.payload.payer_id).toBe(MEMBER);
  });

  it("the webhook ⇄ verify race on an ORG order still grants exactly once, into the org wallet", async () => {
    const d = makeService({ tenancy: on() });
    d.seedOrder({ payerId: ANCHOR });
    const [webhook, verify] = await Promise.all([
      d.svc.handleRazorpayEvent(captureEvent(), CTX),
      d.svc.verifyCheckoutPayment(
        MEMBER,
        { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature },
        CTX,
      ),
    ]);
    expect(d.ledger).toHaveLength(1);
    expect(d.balances.get(ANCHOR)).toBe(50);
    expect(emitted(d.events)).toEqual(["payment.captured"]);
    expect(["granted", "no_op"]).toContain(webhook.result);
    expect(verify).toMatchObject({ verified: true, payer_id: MEMBER, balance: 50 });
  });
});

// ---------------------------------------------------------------------------
// #2749 PR 3 — the charged amount IS the catalogue's GST total
// ---------------------------------------------------------------------------

/** The brief's three packs (and a hidden Annual), as the go-live catalogue row would hold them. */
const BRIEF_CATALOG = {
  ...DEFAULT_CATALOG,
  products: DEFAULT_CATALOG.products.map((p) =>
    p.kind === "credit_pack" && p.code === "contact_unlock"
      ? {
          ...p,
          tiers: [
            { code: "pack_starter", priceInr: 999, credits: 20, windowDays: 14, validityDays: 30 },
            {
              code: "pack_standard",
              priceInr: 1599,
              credits: 40,
              windowDays: 14,
              validityDays: 60,
            },
            { code: "pack_big", priceInr: 2999, credits: 100, windowDays: 14, validityDays: 90 },
            {
              code: "pack_annual",
              priceInr: 9999,
              credits: 360,
              windowDays: 14,
              validityDays: 365,
              onSaleFrom: "2999-01-01",
            },
          ],
        }
      : p,
  ),
} as typeof DEFAULT_CATALOG;

/** The REAL pricing service over a fake row read: `catalog` null = no stored row (production). */
function realPricing(catalog: typeof DEFAULT_CATALOG | null): PricingService {
  return new PricingService(
    { getActive: vi.fn(async () => (catalog ? { catalog, revision: 7 } : null)) } as never,
    {} as never,
  );
}

describe("#2749 PR 3 — an order's amount equals the catalogue's price.totalPaise, for every pack on sale", () => {
  for (const [name, catalog] of [
    ["DEFAULT_CATALOG (production today: no stored row)", null],
    ["the brief's catalogue row", BRIEF_CATALOG],
  ] as const) {
    it(`${name}: shown == charged, pack by pack`, async () => {
      const pricing = realPricing(catalog);
      const view = await pricing.getPayerCatalog();
      const product = view.products.find((p) => p.kind === "credit_pack");
      const tiers = product?.kind === "credit_pack" ? product.tiers : [];
      expect(tiers.length).toBeGreaterThan(0);

      for (const tier of tiers) {
        const fake = makeFakeRepo();
        const razorpay = {
          isLive: true,
          keyId: "rzp_test_keyid",
          createOrder: vi.fn(async ({ amountInr }: { amountInr: number }) => ({
            orderId: `order_${tier.code}`,
            amountPaise: amountInr * 100,
            currency: "INR",
          })),
        };
        const gateway = new PaymentGateway(
          fake.repo as unknown as UnlocksRepository,
          LIVE_CONFIG,
          pricing,
          razorpay as unknown as RazorpayClient,
        );
        const pack = await gateway.resolvePack(tier.code);
        expect(pack, tier.code).not.toBeNull();
        const order = await gateway.createRealOrder(PAYER as never, pack!);
        // What checkout.js is handed, what Razorpay was asked for, and what the row stamps.
        expect(order.amountPaise, tier.code).toBe(tier.price.totalPaise);
        expect(order.amountInr * 100, tier.code).toBe(tier.price.totalPaise);
        expect(razorpay.createOrder).toHaveBeenCalledWith(
          expect.objectContaining({ amountInr: tier.price.totalPaise / 100 }),
        );
        expect(fake.orders.get(`razorpay:order_${tier.code}`)).toMatchObject({
          amountInr: tier.price.totalPaise / 100,
          taxablePaise: tier.price.taxablePaise,
          gstPaise: tier.price.gstPaise,
          roundOffPaise: tier.price.roundOffPaise,
          totalPaise: tier.price.totalPaise,
          gstRateBps: tier.price.gstRateBps,
          creditValidityDays: tier.validityDays,
          creditsGranted: tier.credits,
        });
      }
    });
  }

  it("the default packs: ₹2,000 / ₹8,000 / ₹32,000 charge ₹2,360 / ₹9,440 / ₹37,760", async () => {
    const view = await realPricing(null).getPayerCatalog();
    const product = view.products.find((p) => p.kind === "credit_pack");
    const tiers = product?.kind === "credit_pack" ? product.tiers : [];
    expect(tiers.map((t) => [t.code, t.priceInr, t.price.totalPaise, t.validityDays])).toEqual([
      ["pack_50", 2000, 236000, null],
      ["pack_200", 8000, 944000, null],
      ["pack_1000", 32000, 3776000, null],
    ]);
  });

  it("the brief's packs charge ₹1,179 / ₹1,887 / ₹3,539, and Annual is not orderable before its date", async () => {
    const pricing = realPricing(BRIEF_CATALOG);
    const fake = makeFakeRepo();
    const gateway = new PaymentGateway(
      fake.repo as unknown as UnlocksRepository,
      LIVE_CONFIG,
      pricing,
      {} as never,
    );
    const totals = [];
    for (const code of ["pack_starter", "pack_standard", "pack_big"]) {
      const pack = await gateway.resolvePack(code);
      totals.push([code, pack?.priceLine.totalPaise, pack?.validityDays]);
    }
    expect(totals).toEqual([
      ["pack_starter", 117900, 30],
      ["pack_standard", 188700, 60],
      ["pack_big", 353900, 90],
    ]);
    expect(await gateway.resolvePack("pack_annual")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #2749 item 9 — the purchase origin, and the posting it came from
// ---------------------------------------------------------------------------

describe("#2749 item 9 — the purchase origin is stored; a posting only when it is the tenant's own", () => {
  const POSTING = "eeeeeeee-0000-4000-8000-000000000005";
  let d: ReturnType<typeof makeService>;
  beforeEach(() => {
    d = makeService();
  });

  it("stamps the origin and the caller tenant's OWN posting", async () => {
    d.owned.set(`${PAYER}:${POSTING}`, { kind: "posting", id: POSTING });
    await d.svc.createCreditOrder(PAYER, "pack_50", CTX, undefined, {
      origin: "posting_flow",
      jobPostingId: POSTING,
    });
    expect(d.repo.findOwnedJobRef).toHaveBeenCalledWith(POSTING, PAYER);
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)).toMatchObject({
      origin: "posting_flow",
      originJobPostingId: POSTING,
    });
  });

  it("DROPS another company's (or an unknown) posting silently — the order is still created", async () => {
    d.owned.set(`${OTHER_PAYER}:${POSTING}`, { kind: "posting", id: POSTING }); // not PAYER's
    const order = await d.svc.createCreditOrder(PAYER, "pack_50", CTX, undefined, {
      origin: "unlock_prompt",
      jobPostingId: POSTING,
    });
    expect(order).not.toBeNull(); // never a 404 — no posting-id oracle
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)).toMatchObject({
      origin: "unlock_prompt",
      originJobPostingId: null,
    });
  });

  it("an agency's own `jobs` row is not a job posting: dropped (the column names job_postings)", async () => {
    d.owned.set(`${PAYER}:${POSTING}`, { kind: "job", id: POSTING });
    await d.svc.createCreditOrder(PAYER, "pack_50", CTX, undefined, { jobPostingId: POSTING });
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)).toMatchObject({
      origin: null,
      originJobPostingId: null,
    });
  });

  it("no posting id → no ownership read; a refused pack → no read either", async () => {
    await d.svc.createCreditOrder(PAYER, "pack_50", CTX, undefined, { origin: "credits_page" });
    expect(d.repo.findOwnedJobRef).not.toHaveBeenCalled();
    expect(
      await d.svc.createCreditOrder(PAYER, "pack_ghost", CTX, undefined, { jobPostingId: POSTING }),
    ).toBeNull();
    expect(d.repo.findOwnedJobRef).not.toHaveBeenCalled();
  });

  it("a failed ownership read fails CLOSED: no provider order, no row", async () => {
    d.repo.findOwnedJobRef.mockRejectedValueOnce(new Error("db down"));
    await expect(
      d.svc.createCreditOrder(PAYER, "pack_50", CTX, undefined, { jobPostingId: POSTING }),
    ).rejects.toThrow("db down");
    expect(d.razorpay.createOrder).not.toHaveBeenCalled();
    expect(d.repo.createPaymentOrder).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #2749 hardening 5 — the captured amount is checked before any grant
// ---------------------------------------------------------------------------

describe("#2749 hardening 5 — a capture of the wrong amount HOLDS the order and grants nothing", () => {
  /** A post-0176 order: ₹2,000 + GST, stamped total 236000 paise. */
  const STAMPED = {
    amountInr: 2360,
    taxablePaise: 200000,
    gstPaise: 36000,
    roundOffPaise: 0,
    totalPaise: 236000,
    gstRateBps: 1800,
  };
  const signature = signCheckoutForTest(PROVIDER_ORDER, PAYMENT_ID, KEY_SECRET);
  let d: ReturnType<typeof makeService>;
  beforeEach(() => {
    d = makeService();
    d.seedOrder(STAMPED);
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const heldPayload = () =>
    d.events.emit.mock.calls.find(
      (c) => (c[0] as { event_name: string }).event_name === "payment.held",
    )?.[0] as Record<string, unknown> | undefined;

  it("a MISMATCH holds the order, grants nothing and emits ONE payment.held on the hold's transaction", async () => {
    // The capture reports the LIST price (the pre-PR-3 amount), not the GST total.
    const out = await d.svc.handleRazorpayEvent(
      captureEvent(PROVIDER_ORDER, PAYMENT_ID, 200000),
      CTX,
    );
    expect(out).toEqual({ result: "held" });
    const row = d.orders.get(`razorpay:${PROVIDER_ORDER}`);
    expect(row?.status).toBe("held");
    expect(row?.providerPaymentRef).toBe(PAYMENT_ID); // so ops can find it to refund
    expect(d.ledger).toHaveLength(0);
    expect(d.balances.get(PAYER)).toBeUndefined();
    expect(emitted(d.events)).toEqual(["payment.held"]);
    const event = heldPayload();
    expect(event).toMatchObject({
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "payer", subject_id: PAYER },
      idempotencyKey: `payment.held:order:${ORDER_ROW}`,
      payload: {
        payment_order_id: ORDER_ROW,
        payer_id: PAYER,
        pack_code: "pack_50",
        expected_paise: 236000,
        captured_paise: 200000,
        reason: "amount_mismatch",
        order_status: "held",
        real_call: true,
      },
    });
    expect(event).toHaveProperty("tx"); // written on the hold's own transaction
    // Ids and numbers only: no provider payment id, no signature, no secret.
    expect(JSON.stringify(event?.payload)).not.toContain(PAYMENT_ID);
    expect(JSON.stringify(event?.payload)).not.toContain(KEY_SECRET);
    // Logged for ops with both amounts (numbers only).
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringMatching(/HELD.*order_row=.*expected_paise=236000 captured_paise=200000/),
    );
  });

  it("a REPLAYED mismatch, and then a matching capture, both no-op: a held order is never granted", async () => {
    await d.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 200000), CTX);
    expect(
      await d.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 200000), CTX),
    ).toEqual({ result: "no_op" });
    expect(
      await d.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 236000), CTX),
    ).toEqual({ result: "no_op" });
    expect(d.ledger).toHaveLength(0);
    expect(emitted(d.events)).toEqual(["payment.held"]); // exactly one
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("held");
  });

  it("a VERIFY after the hold grants nothing — the same neutral refusal as an unknown order", async () => {
    await d.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 200000), CTX);
    const verify = await d.svc.verifyCheckoutPayment(
      PAYER,
      { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature },
      CTX,
    );
    expect(verify).toEqual({ verified: false });
    expect(d.ledger).toHaveLength(0);
    expect(emitted(d.events)).toEqual(["payment.held"]);
  });

  it("a late payment.failed cannot turn a held order (money captured) into a failed one", async () => {
    await d.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 200000), CTX);
    expect(await d.svc.handleRazorpayEvent({ ...failedEvent }, CTX)).toEqual({ result: "no_op" });
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("held");
    expect(emitted(d.events)).toEqual(["payment.held"]);
  });

  it("a capture WITHOUT an amount is held (fail closed), and so is one in another currency", async () => {
    const noAmount = toPaymentEvent(
      RazorpayWebhookSchema.parse({
        event: "payment.captured",
        payload: { payment: { entity: { id: PAYMENT_ID, order_id: PROVIDER_ORDER } } },
      }),
    );
    expect(await d.svc.handleRazorpayEvent(noAmount, CTX)).toEqual({ result: "held" });
    expect(heldPayload()).toMatchObject({
      payload: { reason: "amount_missing", expected_paise: 236000, captured_paise: null },
    });

    const other = makeService();
    other.seedOrder(STAMPED);
    const usd = { ...captureEvent(PROVIDER_ORDER, PAYMENT_ID, 236000), currency: "USD" };
    expect(await other.svc.handleRazorpayEvent(usd, CTX)).toEqual({ result: "held" });
    expect(other.ledger).toHaveLength(0);
  });

  it("a MATCHING capture settles exactly once, with the stamped total on the ledger", async () => {
    expect(
      await d.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 236000), CTX),
    ).toEqual({ result: "granted" });
    expect(
      await d.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 236000), CTX),
    ).toEqual({ result: "no_op" });
    expect(d.ledger).toHaveLength(1);
    expect(d.ledger[0]).toMatchObject({ delta: 50, priceInr: 2360 });
    expect(emitted(d.events)).toEqual(["payment.captured"]);
  });

  it("a pre-0176 order (no paise columns) is checked against amount_inr × 100", async () => {
    const old = makeService();
    old.seedOrder(); // ₹2,000, no total_paise
    expect(
      await old.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 236000), CTX),
    ).toEqual({ result: "held" });
    const ok = makeService();
    ok.seedOrder();
    expect(
      await ok.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 200000), CTX),
    ).toEqual({ result: "granted" });
  });

  it("a mismatch reported for an order ALREADY PAID changes nothing, but RECORDS payment.held (order_status paid)", async () => {
    d.razorpay.fetchPayment.mockResolvedValue({
      id: PAYMENT_ID,
      orderId: PROVIDER_ORDER,
      amountPaise: 236000, // the verify read the right amount and settled
      currency: "INR",
      status: "captured",
    });
    await d.svc.verifyCheckoutPayment(
      PAYER,
      { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature },
      CTX,
    );
    expect(d.balances.get(PAYER)).toBe(50);
    for (let i = 0; i < 2; i += 1) {
      expect(
        await d.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 1), CTX),
      ).toEqual({ result: "no_op" });
    }
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("paid"); // unchanged
    expect(d.balances.get(PAYER)).toBe(50); // the grant stands
    expect(emitted(d.events)).toEqual(["payment.captured", "payment.held", "payment.held"]);
    const late = heldPayload();
    expect(late).toMatchObject({
      actor: { actor_type: "system", actor_id: null },
      // The same per-order key: the events table keeps ONE however many deliveries report it.
      idempotencyKey: `payment.held:order:${ORDER_ROW}`,
      payload: {
        payment_order_id: ORDER_ROW,
        expected_paise: 236000,
        captured_paise: 1,
        reason: "amount_mismatch",
        order_status: "paid",
      },
    });
    expect(late).not.toHaveProperty("tx"); // nothing to share a transaction with
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringMatching(/SETTLED order.*captured_paise=1/),
    );
  });

  it("a matching capture on a paid order records nothing (only a mismatch is an event)", async () => {
    await d.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 236000), CTX);
    await d.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 236000), CTX);
    expect(emitted(d.events)).toEqual(["payment.captured"]);
  });

  it("an event that cannot be written ROLLS BACK the hold (5xx), and the redelivery holds it then", async () => {
    d.events.emit.mockRejectedValueOnce(new Error("events table down"));
    await expect(
      d.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 200000), CTX),
    ).rejects.toThrow("events table down");
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("created");
    expect(
      await d.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 200000), CTX),
    ).toEqual({ result: "held" });
  });
});

// ---------------------------------------------------------------------------
// #2749 PR 3 — a lot's validity follows the pack (mock) or the order's stamp (settle)
// ---------------------------------------------------------------------------

describe("#2749 PR 3 — the credits' validity: the mock pack's live tier, the order's stamp at settle", () => {
  it("a settle grants with the order's STAMPED credit_validity_days (the catalogue is not re-read)", async () => {
    const d = makeService();
    d.seedOrder({ creditValidityDays: 30 });
    d.pricing.getActiveCatalog.mockResolvedValue({
      catalog: BRIEF_CATALOG, // pack_50 is gone; nothing to re-read even if it tried
      revision: 9,
      source: "db" as const,
    });
    expect(await d.svc.handleRazorpayEvent(captureEvent(), CTX)).toEqual({ result: "granted" });
    expect(d.ledger[0]).toMatchObject({ delta: 50, validityDays: 30 });
  });

  it("a pre-0176 order (no validity) grants a lot that never expires", async () => {
    const d = makeService();
    d.seedOrder();
    await d.svc.handleRazorpayEvent(captureEvent(), CTX);
    expect(d.ledger[0]).toMatchObject({ validityDays: null });
  });

  it("the MOCK purchase stamps the LIST price (unchanged by PR 3) and passes the pack's validity to its lot", async () => {
    const d = makeService();
    d.repo.creditPack = vi.fn(async () => 20);
    d.pricing.getActiveCatalog.mockResolvedValue({
      catalog: BRIEF_CATALOG,
      revision: 9,
      source: "db" as const,
    });
    // expected_price_inr is the LIST price (₹999), not the ₹1,179 total.
    await d.svc.purchaseCredits(PAYER, "pack_starter", CTX, 999);
    expect(d.repo.creditPack).toHaveBeenCalledWith(
      expect.objectContaining({
        payerId: PAYER,
        credits: 20,
        packCode: "pack_starter",
        // The live mock route takes no money and is retired at switch-on: it keeps the list price.
        priceInr: 999,
        validityDays: 30,
      }),
    );
    const amounts = d.events.emit.mock.calls.map(
      (c) => (c[0] as { payload: { amount_inr: number } }).payload.amount_inr,
    );
    expect(amounts).toEqual([999, 999]); // payment.authorized + payment.captured
  });

  it("the MOCK purchase of a default pack (no validity) stamps its ₹2,000 list price and no expiry", async () => {
    const d = makeService();
    d.repo.creditPack = vi.fn(async () => 50);
    await d.svc.purchaseCredits(PAYER, "pack_50", CTX, 2000);
    expect(d.repo.creditPack).toHaveBeenCalledWith(
      expect.objectContaining({ priceInr: 2000, validityDays: null }),
    );
  });
});

// ---------------------------------------------------------------------------
// #2749 hardening 5 — Razorpay's OWN numbers: the order it echoes, the payment verify reads back
// ---------------------------------------------------------------------------

describe("#2749 — an order whose Razorpay echo is not the stamped total is refused, nothing persisted", () => {
  it("a different echoed AMOUNT → 503, no row, no event", async () => {
    const d = makeService();
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    d.razorpay.createOrder.mockResolvedValueOnce({
      orderId: PROVIDER_ORDER,
      amountPaise: 200000, // Razorpay says ₹2,000; the stamped total is ₹2,360
      currency: "INR",
    });
    await expect(d.svc.createCreditOrder(PAYER, "pack_50", CTX)).rejects.toMatchObject({
      status: 503,
    });
    expect(d.repo.createPaymentOrder).not.toHaveBeenCalled();
    expect(emitted(d.events)).toEqual([]);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringMatching(/expected_paise=236000 provider_paise=200000/),
    );
    vi.restoreAllMocks();
  });

  it("a different echoed CURRENCY → the same 503, no row", async () => {
    const d = makeService();
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    d.razorpay.createOrder.mockResolvedValueOnce({
      orderId: PROVIDER_ORDER,
      amountPaise: 236000,
      currency: "USD",
    });
    await expect(d.svc.createCreditOrder(PAYER, "pack_50", CTX)).rejects.toMatchObject({
      status: 503,
    });
    expect(d.repo.createPaymentOrder).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("#2749 — the browser verify reads the payment back and runs the webhook's amount check", () => {
  const STAMPED = {
    amountInr: 2360,
    taxablePaise: 200000,
    gstPaise: 36000,
    roundOffPaise: 0,
    totalPaise: 236000,
    gstRateBps: 1800,
  };
  const signature = signCheckoutForTest(PROVIDER_ORDER, PAYMENT_ID, KEY_SECRET);
  const payment = (over: Record<string, unknown> = {}) => ({
    id: PAYMENT_ID,
    orderId: PROVIDER_ORDER,
    amountPaise: 236000,
    currency: "INR",
    status: "captured",
    ...over,
  });
  let d: ReturnType<typeof makeService>;
  beforeEach(() => {
    d = makeService();
    d.seedOrder(STAMPED);
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const verify = () =>
    d.svc.verifyCheckoutPayment(
      PAYER,
      { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature },
      CTX,
    );

  it("a MATCHING payment settles (one grant, the provider asked about THIS payment id)", async () => {
    d.razorpay.fetchPayment.mockResolvedValue(payment());
    expect(await verify()).toMatchObject({ verified: true, balance: 50, credits: 50 });
    expect(d.razorpay.fetchPayment).toHaveBeenCalledWith(PAYMENT_ID);
    expect(d.ledger).toHaveLength(1);
    expect(emitted(d.events)).toEqual(["payment.captured"]);
  });

  it("a MISMATCHED payment HOLDS the order: payment.held (order_status held), no grant, a neutral refusal", async () => {
    d.razorpay.fetchPayment.mockResolvedValue(payment({ amountPaise: 200000 }));
    expect(await verify()).toEqual({ verified: false });
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("held");
    expect(d.ledger).toHaveLength(0);
    expect(emitted(d.events)).toEqual(["payment.held"]);
    const held = d.events.emit.mock.calls[0]?.[0] as { payload: Record<string, unknown> };
    expect(held.payload).toMatchObject({
      reason: "amount_mismatch",
      expected_paise: 236000,
      captured_paise: 200000,
      order_status: "held",
    });
    // …and a later, matching webhook cannot settle it.
    expect(
      await d.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 236000), CTX),
    ).toEqual({ result: "no_op" });
    expect(d.ledger).toHaveLength(0);
  });

  it("a payment in another CURRENCY holds too", async () => {
    d.razorpay.fetchPayment.mockResolvedValue(payment({ currency: "USD" }));
    expect(await verify()).toEqual({ verified: false });
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("held");
  });

  it("a FETCH FAILURE settles nothing: the neutral refusal, the order still open for the webhook", async () => {
    d.razorpay.fetchPayment.mockRejectedValue(new Error("payment provider payment fetch failed"));
    expect(await verify()).toEqual({ verified: false });
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("created");
    expect(d.ledger).toHaveLength(0);
    expect(emitted(d.events)).toEqual([]);
    // The webhook remains the other channel and settles it.
    expect(
      await d.svc.handleRazorpayEvent(captureEvent(PROVIDER_ORDER, PAYMENT_ID, 236000), CTX),
    ).toEqual({ result: "granted" });
  });

  it("a fetched payment that names ANOTHER order settles nothing", async () => {
    d.razorpay.fetchPayment.mockResolvedValue(payment({ orderId: "order_SOMETHING_ELSE" }));
    expect(await verify()).toEqual({ verified: false });
    expect(d.orders.get(`razorpay:${PROVIDER_ORDER}`)?.status).toBe("created");
    expect(d.ledger).toHaveLength(0);
  });

  it("a FORGED signature never reaches the provider", async () => {
    const out = await d.svc.verifyCheckoutPayment(
      PAYER,
      { orderId: PROVIDER_ORDER, paymentId: PAYMENT_ID, signature: "forged" },
      CTX,
    );
    expect(out).toEqual({ verified: false });
    expect(d.razorpay.fetchPayment).not.toHaveBeenCalled();
  });
});

describe("#2750 item 9 — credits expired on earlier paid packs come back with the next real pack", () => {
  const LOT_OLD = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const LOT_NEW = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const EXPIRES = new Date("2026-12-18T10:00:00.000Z");
  const returned = (): PackReturnResult => ({
    lines: [{ fromLotId: LOT_OLD, lotId: LOT_NEW, ledgerId: "l1", credits: 12 }],
    credits: 12,
    expiresAt: EXPIRES,
    balanceAfter: 62,
  });

  it("under the credit rules the settle asks for the return with the rules' numbers and emits one event on its transaction", async () => {
    const d = makeService({ creditRules: { state: "on" } });
    d.seedOrder();
    d.packReturn.result = returned();
    await expect(d.svc.handleRazorpayEvent(captureEvent(), CTX)).resolves.toEqual({
      result: "granted",
    });
    expect(d.repo.claimAndCreditPaymentOrderWithinTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ packReturn: { max: 20, windowMonths: 6 } }),
    );
    expect(emitted(d.events)).toEqual(["payer.pack_credits_returned", "payment.captured"]);
    const call = d.events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(call).toMatchObject({
      payload: {
        payer_id: PAYER,
        payment_order_id: ORDER_ROW,
        credits: 12,
        lots: [{ from_lot_id: LOT_OLD, lot_id: LOT_NEW, credits: 12 }],
        expires_at: EXPIRES.toISOString(),
      },
      idempotencyKey: `payer.pack_credits_returned:order:${ORDER_ROW}`,
    });
    expect(call.tx).toBeDefined();
  });

  it("nothing came back: no event", async () => {
    const d = makeService({ creditRules: { state: "on" } });
    d.seedOrder();
    await d.svc.handleRazorpayEvent(captureEvent(), CTX);
    expect(emitted(d.events)).toEqual(["payment.captured"]);
  });

  it.each([
    ["the switch is off for the company", { state: "off" as const }],
    ["the pilot list cannot be read", { state: "unavailable" as const }],
    ["the settings row cannot be read", { state: "on" as const, readFails: true }],
    ["the cap is set to 0", { state: "on" as const, max: 0 }],
  ])("%s: the pack settles with no return asked", async (_case, creditRules) => {
    const d = makeService({ creditRules });
    d.seedOrder();
    d.packReturn.result = returned();
    await expect(d.svc.handleRazorpayEvent(captureEvent(), CTX)).resolves.toEqual({
      result: "granted",
    });
    const input = d.repo.claimAndCreditPaymentOrderWithinTx.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(input.packReturn).toBeUndefined();
    expect(emitted(d.events)).toEqual(["payment.captured"]);
  });

  it("no credit rules service at all (today's wiring in older tests): no return asked", async () => {
    const d = makeService();
    d.seedOrder();
    await d.svc.handleRazorpayEvent(captureEvent(), CTX);
    const input = d.repo.claimAndCreditPaymentOrderWithinTx.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(input.packReturn).toBeUndefined();
  });
});
