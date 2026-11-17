import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { ConflictException, Logger } from "@nestjs/common";
import type { Request } from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import { createDbClient, type DbClient } from "@badabhai/db";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { ConsentRepository } from "../consent/consent.repository";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { InstituteLinkRepository } from "../campus-link/institute-link.repository";
import { InstituteOpenGate } from "../campus-link/institute-open-gate.service";
import { PayerUnlocksController } from "../payer-portal/payer-unlocks.controller";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import { PayersRepository } from "../payers/payers.repository";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { WorkersRepository } from "../workers/workers.repository";
import { PaymentGateway } from "./payment-gateway";
import { signCheckoutForTest } from "./razorpay-signature";
import type { RazorpayPaymentEvent } from "./razorpay-webhook.dto";
import { UnlockService } from "./unlocks.service";
import { UnlocksRepository } from "./unlocks.repository";

/**
 * #2749 PR 3 — CHECKOUT against real Postgres (migration 0176).
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api test payment-orders.db
 *
 * What only a real database proves: the 0176 CHECKs and the origin FK, the `held` compare-and-set
 * racing a settle, the lot's expiry computed by the database clock from the order's stamped
 * `credit_validity_days`, the events written on the hold's transaction, and — through the REAL
 * controller, idempotency seam, service, gateway and repository — that two concurrent order
 * calls under one `Idempotency-Key` create ONE provider order and ONE row. The Razorpay client is
 * a fake (it counts its calls); the seam's Redis is an in-memory NX store (the seam's own suite
 * covers Redis itself). Wallet keys are fresh uuids (tenancy off: the payer is its own wallet).
 * Every row is deleted afterwards. PII-free: ids and integers only.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

/** Fake, test-only credential values (the gate never talks to Razorpay). */
const KEY_SECRET = "rzp_dbgate_key_secret";

/** DEFAULT_CATALOG plus a brief-style pack with a validity, as a published row would hold it. */
const CATALOG = {
  ...DEFAULT_CATALOG,
  products: DEFAULT_CATALOG.products.map((p) =>
    p.kind === "credit_pack" && p.code === "contact_unlock"
      ? {
          ...p,
          tiers: [
            ...p.tiers,
            { code: "pack_starter", priceInr: 999, credits: 20, windowDays: 14, validityDays: 30 },
          ],
        }
      : p,
  ),
} as typeof DEFAULT_CATALOG;

/** An in-memory Redis with the three commands the idempotency seam uses (SET NX / SET / GET). */
function memoryRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async set(key: string, value: string, _mode: string, _seconds: number, nx?: string) {
      if (nx === "NX" && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
  };
}

const withKey = (key: string | undefined): Request =>
  ({
    header: (n: string) => (n.toLowerCase() === "idempotency-key" ? key : undefined),
  }) as unknown as Request;

describe.skipIf(!RUN)("payment orders (#2749 PR 3) — against real Postgres", () => {
  let client: DbClient;
  let repo: UnlocksRepository;
  let svc: UnlockService;
  let ctrl: PayerUnlocksController;
  const createOrder = vi.fn();
  /**
   * The fake `GET /payments/:id` (#2749 hardening 5): `payments` maps a payment id to what
   * Razorpay would report for it; an id that is not there is a provider failure.
   */
  const payments = new Map<string, { orderId: string; amountPaise: number; currency: string }>();
  const fetchPayment = vi.fn();
  const wallets: string[] = [];
  const postings: string[] = [];
  const TAG = randomUUID().slice(0, 8);
  const CTX: RequestContext = {
    correlationId: randomUUID(),
    requestId: `payment-orders-db-${TAG}`,
  };

  function wallet(): string {
    const id = randomUUID();
    wallets.push(id);
    return id;
  }

  beforeAll(() => {
    client = createDbClient(DATABASE_URL, { max: 8 });
    repo = new UnlocksRepository(client.db);
    const base = loadServerConfig({ NODE_ENV: "test", UNLOCK_LATENCY_TARGET_MS: "0" });
    const config = {
      ...base,
      PAYMENTS_ENABLE_REAL: true,
      PAYMENTS_PROVIDER_KEY: "rzp_test_dbgate",
      PAYMENTS_PROVIDER_SECRET: KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: "rzp_dbgate_webhook_secret",
    } as ServerConfig;
    const pii = new PiiCryptoService(config);
    const events = new EventsService(new EventsRepository(client.db), config);
    const pricing = {
      getActiveCatalog: async () => ({ catalog: CATALOG, revision: 1, source: "db" as const }),
    };
    const razorpay = { isLive: true, keyId: "rzp_test_dbgate", createOrder, fetchPayment };
    const gateway = new PaymentGateway(repo, config, pricing as never, razorpay as never);
    svc = new UnlockService(
      repo,
      new ConsentRepository(client.db),
      new WorkersRepository(client.db),
      pii,
      gateway,
      events,
      config,
      { add: async () => undefined } as never,
      { get: async () => DEFAULT_MATCH_CONFIG } as never,
      new PayersRepository(client.db, pii),
      new PayerTenantScopeService(config, new PayerOrgsRepository(client.db)),
      new InstituteOpenGate(new InstituteLinkRepository(client.db), {} as never),
    );
    const seam = new RequestIdempotency(pii, { client: Promise.resolve(memoryRedis()) } as never);
    ctrl = new PayerUnlocksController(
      svc,
      { assertWithinHourlyCap: async () => undefined } as never,
      seam,
    );
  });

  beforeEach(() => {
    // The fake provider: a fresh order id per call, the amount echoed in paise (as the real client
    // computes it), and a delay so two concurrent requests genuinely overlap. Set per test, because
    // `vi.restoreAllMocks()` (the Logger spies) also resets a vi.fn implementation.
    createOrder.mockReset();
    createOrder.mockImplementation(async ({ amountInr }: { amountInr: number }) => {
      await new Promise((r) => setTimeout(r, 60));
      return {
        orderId: `order_${TAG}_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
        amountPaise: amountInr * 100,
        currency: "INR",
      };
    });
  });

  beforeEach(() => {
    fetchPayment.mockReset();
    fetchPayment.mockImplementation(async (paymentId: string) => {
      const p = payments.get(paymentId);
      if (!p) throw new Error("payment provider payment fetch failed");
      return { id: paymentId, status: "captured", ...p };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const { sql } = client;
      await sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      await sql`DELETE FROM credit_ledger WHERE payer_id = ANY(${wallets}::uuid[])`;
      await sql`DELETE FROM credit_lots WHERE payer_id = ANY(${wallets}::uuid[])`;
      await sql`DELETE FROM payment_orders WHERE payer_id = ANY(${wallets}::uuid[])`;
      await sql`DELETE FROM payer_credits WHERE payer_id = ANY(${wallets}::uuid[])`;
      await sql`DELETE FROM job_postings WHERE id = ANY(${postings}::uuid[])`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  // -------------------------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------------------------

  /** The SQLSTATE and constraint a raw statement failed with (postgres-js puts both on the error). */
  async function pgError(
    run: () => Promise<unknown>,
  ): Promise<{ code?: string; constraint?: string }> {
    try {
      await run();
    } catch (err) {
      const e = err as { code?: string; constraint_name?: string };
      return { code: e.code, constraint: e.constraint_name };
    }
    throw new Error("the statement was expected to fail");
  }

  /** A raw post-0176 order row; `over` replaces any column (raw SQL, so every CHECK is exercised). */
  async function insertOrder(over: Record<string, unknown> = {}): Promise<string> {
    const w = wallet();
    const row: Record<string, unknown> = {
      payer_id: w,
      product_kind: "credit_pack",
      pack_code: "pack_starter",
      amount_inr: 1179,
      credits_granted: 20,
      provider: "razorpay",
      provider_order_id: `order_${TAG}_${randomUUID().slice(0, 8)}`,
      taxable_paise: 99900,
      gst_paise: 17982,
      round_off_paise: 18,
      total_paise: 117900,
      gst_rate_bps: 1800,
      credit_validity_days: 30,
      origin: "credits_page",
      ...over,
    };
    const [inserted] = await client.sql<{ id: string }[]>`
      INSERT INTO payment_orders ${client.sql(row)} RETURNING id`;
    return inserted!.id;
  }

  async function posting(owner: string): Promise<string> {
    const [row] = await client.sql<{ id: string }[]>`
      INSERT INTO job_postings (created_by, payer_id, org_label, role_title, vacancy_band)
      VALUES (${owner}::uuid, ${owner}::uuid, 'Checkout Org', 'CNC Turner', '1')
      RETURNING id`;
    postings.push(row!.id);
    return row!.id;
  }

  function capture(
    orderId: string,
    amountPaise: number | null,
    paymentId: string,
  ): RazorpayPaymentEvent {
    return { eventName: "payment.captured", paymentId, orderId, amountPaise, currency: "INR" };
  }

  async function orderRow(providerOrderId: string) {
    const [row] = await client.sql<
      {
        id: string;
        status: string;
        amount_inr: number;
        total_paise: number | null;
        credit_validity_days: number | null;
        origin: string | null;
        origin_job_posting_id: string | null;
        provider_payment_ref: string | null;
      }[]
    >`SELECT id, status, amount_inr, total_paise, credit_validity_days, origin,
             origin_job_posting_id, provider_payment_ref
        FROM payment_orders WHERE provider_order_id = ${providerOrderId}`;
    return row!;
  }

  async function countWhere(
    table: "credit_lots" | "credit_ledger",
    orderRowId: string,
  ): Promise<number> {
    const [r] =
      table === "credit_lots"
        ? await client.sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM credit_lots WHERE payment_order_id = ${orderRowId}::uuid`
        : await client.sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM credit_ledger
             WHERE idempotency_key = ${`payment_order:${orderRowId}`}`;
    return Number(r!.n);
  }

  async function heldEvents(orderRowId: string): Promise<Record<string, unknown>[]> {
    const rows = await client.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM events
       WHERE event_name = 'payment.held' AND payload->>'payment_order_id' = ${orderRowId}`;
    return rows.map((r) => r.payload);
  }

  // -------------------------------------------------------------------------------------------
  // (a) the 0176 CHECKs and the FK
  // -------------------------------------------------------------------------------------------

  it("(a) a well-formed order and a pre-0176-shaped one both insert; the defaults read credit_pack and nulls", async () => {
    await insertOrder();
    const w = wallet();
    const providerOrderId = `order_${TAG}_old`;
    await client.sql`
      INSERT INTO payment_orders (payer_id, pack_code, amount_inr, credits_granted, provider_order_id)
      VALUES (${w}::uuid, 'pack_50', 2000, 50, ${providerOrderId})`;
    const [old] = await client.sql<
      { product_kind: string; total_paise: number | null; origin: string | null; status: string }[]
    >`SELECT product_kind, total_paise, origin, status FROM payment_orders
       WHERE provider_order_id = ${providerOrderId}`;
    expect(old).toEqual({
      product_kind: "credit_pack",
      total_paise: null,
      origin: null,
      status: "created",
    });
  });

  it("(a) the money: the parts must sum to the total, the total must be a whole rupee = amount_inr × 100, all five or none", async () => {
    // 99,900 + 17,982 + 0 ≠ 1,17,900.
    expect(await pgError(() => insertOrder({ round_off_paise: 0 }))).toEqual({
      code: "23514",
      constraint: "payment_orders_money_sum_chk",
    });
    // Sums, but 1,17,882 paise is not a whole rupee (and so cannot equal amount_inr × 100).
    expect(await pgError(() => insertOrder({ round_off_paise: 0, total_paise: 117882 }))).toEqual({
      code: "23514",
      constraint: "payment_orders_money_sum_chk",
    });
    // A whole rupee that sums, but not the rupee column.
    expect(await pgError(() => insertOrder({ amount_inr: 999 }))).toEqual({
      code: "23514",
      constraint: "payment_orders_money_sum_chk",
    });
    // Four of the five.
    expect(await pgError(() => insertOrder({ gst_rate_bps: null }))).toEqual({
      code: "23514",
      constraint: "payment_orders_money_set_chk",
    });
  });

  it("(a) a credit-pack order needs its pack code and a positive grant; closed sets are closed", async () => {
    for (const [over, constraint] of [
      [{ pack_code: null }, "payment_orders_pack_code_chk"],
      [{ credits_granted: 0 }, "payment_orders_credits_pos_chk"],
      [{ product_kind: "posting_plan" }, "payment_orders_product_kind_chk"],
      [{ status: "refunded" }, "payment_orders_status_chk"],
      [{ origin: "homepage" }, "payment_orders_origin_chk"],
      [{ credit_validity_days: 0 }, "payment_orders_validity_pos_chk"],
    ] as const) {
      expect(await pgError(() => insertOrder(over)), JSON.stringify(over)).toEqual({
        code: "23514",
        constraint,
      });
    }
    // `held` is a status now.
    await insertOrder({ status: "held" });
  });

  it("(a) the origin posting must exist, and is nulled (not cascaded) when the posting is deleted", async () => {
    expect(await pgError(() => insertOrder({ origin_job_posting_id: randomUUID() }))).toEqual({
      code: "23503",
      constraint: "payment_orders_origin_job_posting_id_job_postings_id_fk",
    });
    const p = await posting(randomUUID());
    const id = await insertOrder({ origin_job_posting_id: p });
    await client.sql`DELETE FROM job_postings WHERE id = ${p}::uuid`;
    const [row] = await client.sql<{ origin_job_posting_id: string | null }[]>`
      SELECT origin_job_posting_id FROM payment_orders WHERE id = ${id}::uuid`;
    expect(row).toEqual({ origin_job_posting_id: null }); // the order (a billing record) stays
  });

  // -------------------------------------------------------------------------------------------
  // (b) the order: the GST total, the validity, the origin — and idempotency under one key
  // -------------------------------------------------------------------------------------------

  it("(b) an order charges the GST-inclusive total and stamps the line, the validity and an OWNED posting only", async () => {
    const w = wallet();
    const own = await posting(w);
    const foreign = await posting(randomUUID());
    const mine = await svc.createCreditOrder(w, "pack_starter", CTX, 999, {
      origin: "posting_flow",
      jobPostingId: own,
    });
    expect(mine).toMatchObject({
      amountInr: 1179,
      amountPaise: 117900,
      credits: 20,
      validityDays: 30,
    });
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ amountInr: 1179 }));
    expect(await orderRow(mine!.providerOrderId)).toMatchObject({
      id: mine!.orderRowId, // the row id IS the provider receipt
      status: "created",
      amount_inr: 1179,
      total_paise: 117900,
      credit_validity_days: 30,
      origin: "posting_flow",
      origin_job_posting_id: own,
    });
    expect(createOrder.mock.calls[0]?.[0]).toMatchObject({ receipt: mine!.orderRowId });

    // Another company's posting: dropped silently, the order still made.
    const other = await svc.createCreditOrder(w, "pack_starter", CTX, undefined, {
      origin: "unlock_prompt",
      jobPostingId: foreign,
    });
    expect(await orderRow(other!.providerOrderId)).toMatchObject({
      origin: "unlock_prompt",
      origin_job_posting_id: null,
    });
  });

  it("(b) two CONCURRENT order calls under one Idempotency-Key create ONE provider order and ONE row; a retry replays it", async () => {
    const w = wallet();
    const payer: AuthenticatedPayer = { id: w, sid: `sid-${TAG}`, role: "employer" };
    const req = withKey(`checkout-${TAG}`);
    const dto = { pack_code: "pack_starter", expected_price_inr: 999 };
    const both = await Promise.allSettled([
      ctrl.createOrder(dto, payer, req, CTX),
      ctrl.createOrder(dto, payer, req, CTX),
    ]);
    const won = both.filter((r) => r.status === "fulfilled");
    const lost = both.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(createOrder).toHaveBeenCalledTimes(1);

    const handoff = (won[0] as PromiseFulfilledResult<{ order_id: string; amount: number }>).value;
    expect(handoff.amount).toBe(117900);
    const replay = await ctrl.createOrder(dto, payer, req, CTX);
    expect(replay).toEqual(handoff);
    expect(createOrder).toHaveBeenCalledTimes(1);
    const [rows] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_orders WHERE payer_id = ${w}::uuid`;
    expect(Number(rows!.n)).toBe(1);

    // A NEW key is a new purchase.
    await ctrl.createOrder(dto, payer, withKey(`checkout-${TAG}-2`), CTX);
    expect(createOrder).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------------------------
  // (c) settle: one grant, a replay adds nothing, the lot expires from the stamped validity
  // -------------------------------------------------------------------------------------------

  it("(c) a matching webhook settles ONCE; the lot expires credit_validity_days after the settle, on the DB clock; a replay adds nothing", async () => {
    const w = wallet();
    const order = await svc.createCreditOrder(w, "pack_starter", CTX);
    const pay = `pay_${TAG}_c`;
    expect(
      await svc.handleRazorpayEvent(capture(order!.providerOrderId, 117900, pay), CTX),
    ).toEqual({
      result: "granted",
    });
    for (let i = 0; i < 3; i += 1) {
      expect(
        await svc.handleRazorpayEvent(capture(order!.providerOrderId, 117900, pay), CTX),
      ).toEqual({ result: "no_op" });
    }
    expect(await countWhere("credit_lots", order!.orderRowId)).toBe(1);
    expect(await countWhere("credit_ledger", order!.orderRowId)).toBe(1);
    const [lot] = await client.sql<{ exact: boolean; credits_granted: number; source: string }[]>`
      SELECT (expires_at - created_at) = interval '30 days' AS exact, credits_granted, source
        FROM credit_lots WHERE payment_order_id = ${order!.orderRowId}::uuid`;
    expect(lot).toMatchObject({ exact: true, source: "pack" });
    expect(Number(lot!.credits_granted)).toBe(20);
    const [line] = await client.sql<{ price_inr: number }[]>`
      SELECT price_inr FROM credit_ledger WHERE idempotency_key = ${`payment_order:${order!.orderRowId}`}`;
    expect(Number(line!.price_inr)).toBe(1179); // the total charged
    const [captured] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM events WHERE event_name = 'payment.captured'
         AND idempotency_key = ${`payment.captured:order:${order!.orderRowId}`}`;
    expect(Number(captured!.n)).toBe(1);
  });

  it("(c) an order stamped with NO validity (a default pack, or a pre-0176 row) grants a lot that never expires", async () => {
    const w = wallet();
    const order = await svc.createCreditOrder(w, "pack_50", CTX);
    expect(order).toMatchObject({ amountInr: 2360, validityDays: null });
    await svc.handleRazorpayEvent(capture(order!.providerOrderId, 236000, `pay_${TAG}_n`), CTX);
    const [lot] = await client.sql<{ expires_at: Date | null }[]>`
      SELECT expires_at FROM credit_lots WHERE payment_order_id = ${order!.orderRowId}::uuid`;
    expect(lot).toEqual({ expires_at: null });
  });

  it("(c) the MOCK purchase stamps the LIST price (unchanged) and gives its lot the pack's validity from the grant", async () => {
    const w = wallet();
    await svc.purchaseCredits(w, "pack_starter", CTX, 999);
    const [lot] = await client.sql<{ exact: boolean; pack_code: string }[]>`
      SELECT (expires_at - created_at) = interval '30 days' AS exact, pack_code
        FROM credit_lots WHERE payer_id = ${w}::uuid`;
    expect(lot).toEqual({ exact: true, pack_code: "pack_starter" });
    const [line] = await client.sql<{ price_inr: number }[]>`
      SELECT price_inr FROM credit_ledger WHERE payer_id = ${w}::uuid`;
    // The live mock route takes no money and is retired at switch-on: it keeps the list price.
    expect(Number(line!.price_inr)).toBe(999);
  });

  // -------------------------------------------------------------------------------------------
  // (d) the amount check: held, never settled
  // -------------------------------------------------------------------------------------------

  it("(d) a mismatched capture HOLDS the order with ONE payment.held, grants nothing, and nothing can settle it after", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const w = wallet();
    const order = await svc.createCreditOrder(w, "pack_starter", CTX);
    const pay = `pay_${TAG}_h`;

    // Two concurrent mismatched deliveries: one hold, one event.
    const results = await Promise.all([
      svc.handleRazorpayEvent(capture(order!.providerOrderId, 99900, pay), CTX),
      svc.handleRazorpayEvent(capture(order!.providerOrderId, 99900, pay), CTX),
    ]);
    expect(results.map((r) => r.result).sort()).toEqual(["held", "no_op"]);
    expect(await orderRow(order!.providerOrderId)).toMatchObject({
      status: "held",
      provider_payment_ref: pay,
    });
    expect(await heldEvents(order!.orderRowId)).toEqual([
      {
        payment_order_id: order!.orderRowId,
        payer_id: w,
        pack_code: "pack_starter",
        expected_paise: 117900,
        captured_paise: 99900,
        reason: "amount_mismatch",
        order_status: "held",
        real_call: true,
      },
    ]);

    // A matching capture, a payment.failed and a signed browser verify (whose read-back reports
    // the RIGHT amount, so it reaches the settle): none of them moves it.
    payments.set(pay, { orderId: order!.providerOrderId, amountPaise: 117900, currency: "INR" });
    expect(
      await svc.handleRazorpayEvent(capture(order!.providerOrderId, 117900, pay), CTX),
    ).toEqual({
      result: "no_op",
    });
    expect(
      await svc.handleRazorpayEvent(
        { ...capture(order!.providerOrderId, 117900, pay), eventName: "payment.failed" },
        CTX,
      ),
    ).toEqual({ result: "no_op" });
    expect(
      await svc.verifyCheckoutPayment(
        w,
        {
          orderId: order!.providerOrderId,
          paymentId: pay,
          signature: signCheckoutForTest(order!.providerOrderId, pay, KEY_SECRET),
        },
        CTX,
      ),
    ).toEqual({ verified: false });

    expect((await orderRow(order!.providerOrderId)).status).toBe("held");
    expect(await countWhere("credit_lots", order!.orderRowId)).toBe(0);
    expect(await countWhere("credit_ledger", order!.orderRowId)).toBe(0);
    const [balance] = await client.sql<{ n: number }[]>`
      SELECT coalesce(sum(balance), 0)::int AS n FROM payer_credits WHERE payer_id = ${w}::uuid`;
    expect(Number(balance!.n)).toBe(0);
    expect(await heldEvents(order!.orderRowId)).toHaveLength(1);
  });

  it("(d) the held CAS: never over a PAID order (the grant stands), and a settle racing a hold has one winner", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const w = wallet();
    const paid = await svc.createCreditOrder(w, "pack_starter", CTX);
    await svc.handleRazorpayEvent(capture(paid!.providerOrderId, 117900, `pay_${TAG}_p`), CTX);
    expect(
      await repo.holdPaymentOrder({
        providerOrderId: paid!.providerOrderId,
        providerPaymentRef: `pay_${TAG}_p2`,
      }),
    ).toBeUndefined();
    expect((await orderRow(paid!.providerOrderId)).status).toBe("paid");

    // A matching capture and a mismatched one, at once, on a fresh order: exactly one wins.
    const raced = await svc.createCreditOrder(w, "pack_starter", CTX);
    const out = await Promise.all([
      svc.handleRazorpayEvent(capture(raced!.providerOrderId, 117900, `pay_${TAG}_r1`), CTX),
      svc.handleRazorpayEvent(capture(raced!.providerOrderId, 1, `pay_${TAG}_r2`), CTX),
    ]);
    const status = (await orderRow(raced!.providerOrderId)).status;
    if (status === "paid") {
      expect(out.map((r) => r.result)).toEqual(["granted", "no_op"]);
      expect(await countWhere("credit_lots", raced!.orderRowId)).toBe(1);
      expect(await heldEvents(raced!.orderRowId)).toHaveLength(0);
    } else {
      expect(status).toBe("held");
      expect(out.map((r) => r.result)).toEqual(["no_op", "held"]);
      expect(await countWhere("credit_lots", raced!.orderRowId)).toBe(0);
      expect(await heldEvents(raced!.orderRowId)).toHaveLength(1);
    }
  });
  // -------------------------------------------------------------------------------------------
  // (e) Razorpay's own numbers: the order echo, the verify read-back, a late mismatch
  // -------------------------------------------------------------------------------------------

  it("(e) an order Razorpay echoes for another amount is refused (503) and NOTHING is stored", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const w = wallet();
    createOrder.mockImplementationOnce(async () => ({
      orderId: `order_${TAG}_echo`,
      amountPaise: 99900, // the list price, not the ₹1,179 total
      currency: "INR",
    }));
    await expect(svc.createCreditOrder(w, "pack_starter", CTX)).rejects.toMatchObject({
      status: 503,
    });
    const [rows] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_orders WHERE payer_id = ${w}::uuid`;
    expect(Number(rows!.n)).toBe(0);
  });

  it("(e) the verify reads the payment back: a matching one settles, with the lot's validity", async () => {
    const w = wallet();
    const order = await svc.createCreditOrder(w, "pack_starter", CTX);
    const pay = `pay_${TAG}_vm`;
    payments.set(pay, { orderId: order!.providerOrderId, amountPaise: 117900, currency: "INR" });
    const out = await svc.verifyCheckoutPayment(
      w,
      {
        orderId: order!.providerOrderId,
        paymentId: pay,
        signature: signCheckoutForTest(order!.providerOrderId, pay, KEY_SECRET),
      },
      CTX,
    );
    expect(out).toMatchObject({ verified: true, balance: 20, credits: 20 });
    expect(fetchPayment).toHaveBeenCalledWith(pay);
    expect((await orderRow(order!.providerOrderId)).status).toBe("paid");
    expect(await countWhere("credit_lots", order!.orderRowId)).toBe(1);
  });

  it("(e) the verify of a MISMATCHED payment holds the order (payment.held, order_status held) and grants nothing", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const w = wallet();
    const order = await svc.createCreditOrder(w, "pack_starter", CTX);
    const pay = `pay_${TAG}_vx`;
    payments.set(pay, { orderId: order!.providerOrderId, amountPaise: 99900, currency: "INR" });
    const out = await svc.verifyCheckoutPayment(
      w,
      {
        orderId: order!.providerOrderId,
        paymentId: pay,
        signature: signCheckoutForTest(order!.providerOrderId, pay, KEY_SECRET),
      },
      CTX,
    );
    expect(out).toEqual({ verified: false });
    expect(await orderRow(order!.providerOrderId)).toMatchObject({
      status: "held",
      provider_payment_ref: pay,
    });
    expect(await countWhere("credit_lots", order!.orderRowId)).toBe(0);
    expect(await heldEvents(order!.orderRowId)).toEqual([
      expect.objectContaining({
        expected_paise: 117900,
        captured_paise: 99900,
        reason: "amount_mismatch",
        order_status: "held",
      }),
    ]);
  });

  it("(e) a verify whose payment CANNOT be read settles nothing; the webhook still can", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const w = wallet();
    const order = await svc.createCreditOrder(w, "pack_starter", CTX);
    const pay = `pay_${TAG}_vf`; // not in `payments`: the fetch fails
    const out = await svc.verifyCheckoutPayment(
      w,
      {
        orderId: order!.providerOrderId,
        paymentId: pay,
        signature: signCheckoutForTest(order!.providerOrderId, pay, KEY_SECRET),
      },
      CTX,
    );
    expect(out).toEqual({ verified: false });
    expect((await orderRow(order!.providerOrderId)).status).toBe("created");
    expect(await countWhere("credit_lots", order!.orderRowId)).toBe(0);
    expect(
      await svc.handleRazorpayEvent(capture(order!.providerOrderId, 117900, pay), CTX),
    ).toEqual({
      result: "granted",
    });
  });

  it("(e) a mismatched capture on an order ALREADY PAID records ONE payment.held (order_status paid); the grant stands", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const w = wallet();
    const order = await svc.createCreditOrder(w, "pack_starter", CTX);
    const pay = `pay_${TAG}_late`;
    await svc.handleRazorpayEvent(capture(order!.providerOrderId, 117900, pay), CTX);
    for (let i = 0; i < 2; i += 1) {
      expect(await svc.handleRazorpayEvent(capture(order!.providerOrderId, 1, pay), CTX)).toEqual({
        result: "no_op",
      });
    }
    expect((await orderRow(order!.providerOrderId)).status).toBe("paid");
    expect(await countWhere("credit_lots", order!.orderRowId)).toBe(1);
    expect(await heldEvents(order!.orderRowId)).toEqual([
      expect.objectContaining({ captured_paise: 1, order_status: "paid" }),
    ]);
  });
});
