import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import { createDbClient, type DbClient, type Database, type PaymentOrder } from "@badabhai/db";
import { DEFAULT_CREDIT_RULES } from "@badabhai/pricing";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { PaymentRefundsRepository } from "../payment-refunds/payment-refunds.repository";
import { PaymentRefundsService } from "../payment-refunds/payment-refunds.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { PaymentGateway } from "../unlocks/payment-gateway";
import { UnlocksRepository } from "../unlocks/unlocks.repository";
import { InvoiceCreditNotes } from "./invoice-credit-notes.service";
import { InvoiceDocumentsService } from "./invoice-documents.service";
import { InvoiceIssuer } from "./invoice-issuer.service";
import { InvoicesRepository } from "./invoices.repository";
import { InvoicesService } from "./invoices.service";
import { financialYearOf } from "@badabhai/pricing";
import { issueMissingInvoice } from "./issue-missing-invoice";
import { InvoiceIssuer as Issuer, usableSeller } from "./invoice-issuer.service";

/**
 * #2749 part 4 — GST invoices and credit notes against real Postgres (migration 0188).
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api test invoices.db
 *
 * What only a real database proves, through the REAL gateway settle, issuer, repository, events
 * and refund service (Razorpay faked):
 *  - the invoice number is GAP-FREE: two settles at once take consecutive numbers, and a rolled
 *    back issue releases its number;
 *  - the financial year turns at 1 April 00:00 IST and the series restarts at 1;
 *  - the savepoint: with no active seller row a settle still grants the credits, issues nothing
 *    and records `payment.invoice_not_issued` on the settle's transaction;
 *  - a replayed settle issues nothing new;
 *  - a refund writes its credit note in its own transaction, and an order with no invoice is
 *    refused before anything is written;
 *  - the CHECKs refuse a wrong split, a wrong sum and a second active seller row.
 *
 * Every seller and buyer value is a FAKE fixture (fake GSTINs with a computed check character).
 * The seller row is the test's own: any active row is set aside first and restored after. Rows
 * are deleted afterwards, except numbers in the CURRENT year's series (a counter is never wound
 * back) and the test's own far-future years' counters, which are deleted.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const FAKE_SELLER_GSTIN = "06AAAAA0000A1Z6";
const FAKE_BUYER_GSTIN = "27AAAAA0000A1Z2";
/** Far-future years only this file numbers in, so their counters start at 1 and are cleaned up. */
const TEST_YEARS = ["2097-98", "2098-99", "2099-00"];

describe.skipIf(!RUN)("GST invoices and credit notes (#2749 part 4) — against real Postgres", () => {
  let client: DbClient;
  let unlocks: UnlocksRepository;
  let gateway: PaymentGateway;
  let invoicesRepo: InvoicesRepository;
  let issuer: InvoiceIssuer;
  let testIssuer: InvoiceIssuer;
  let invoicesService: InvoicesService;
  let documents: InvoiceDocumentsService;
  let refunds: PaymentRefundsService;
  let sellerId: string;
  let setAside: string[] = [];
  const T = randomUUID().slice(0, 8);
  const CTX = { correlationId: randomUUID(), requestId: `invoices-db-${T}` };
  const companies: string[] = [];
  const ADMIN_ID = randomUUID();
  const razorpay = {
    isLive: true,
    findRefundForRow: vi.fn(async () => null),
    refundPayment: vi.fn(async () => ({
      id: `rfnd_${randomUUID().slice(0, 8)}`,
      status: "pending",
      amountPaise: 117_900,
    })),
  };

  /** A company (a `payers` row, so `is_test` has something to read). */
  const company = async (isTest = false): Promise<string> => {
    const id = randomUUID();
    companies.push(id);
    await client.sql`
      INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status, is_test_account)
      VALUES (${id}::uuid, 'employer', ${`enc:2749i-${T}-${id}`}, ${`hash:2749i-${T}-${id}`},
              ${`enc:co-${T}`}, 'active', ${isTest})`;
    return id;
  };

  /** A real order for Starter (₹999 + ₹180 GST = ₹1,179, 20 credits, 30 days), not yet settled. */
  const order = async (payerId: string): Promise<{ providerOrderId: string; id: string }> => {
    const providerOrderId = `order_${T}_${randomUUID().slice(0, 12)}`;
    const row = await unlocks.createPaymentOrder({
      payerId: payerId as TenantKey,
      packCode: "pack_starter",
      amountInr: 1179,
      creditsGranted: 20,
      providerOrderId,
      money: { taxablePaise: 99_900, gstPaise: 18_000, roundOffPaise: 0, totalPaise: 117_900, gstRateBps: 1800 },
      creditValidityDays: 30,
    });
    return { providerOrderId, id: row.id };
  };

  /** Settle through the REAL gateway, with the invoice issued in the settle (the service's hook). */
  const settle = (providerOrderId: string, withInvoice: boolean | "test_mode" = true) =>
    gateway.settleOrder(
      { providerOrderId, providerPaymentRef: `pay_${T}_${randomUUID().slice(0, 8)}` },
      withInvoice
        ? {
            onGranted: async (tx, o) => {
              await (withInvoice === "test_mode" ? testIssuer : issuer).issueForSettledOrderWithinTx(
                tx as unknown as Database,
                o,
                CTX,
              );
            },
          }
        : {},
    );

  const invoicesOf = (orderId: string) =>
    client.sql<{ id: string; invoice_number: string; financial_year: string; issued_at: Date; supply_type: string; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number; is_test: boolean; buyer_gstin_enc: string | null; buyer_state_code: string }[]>`
      SELECT id, invoice_number, financial_year, issued_at, supply_type, cgst_paise, sgst_paise, igst_paise,
             total_paise, is_test, buyer_gstin_enc, buyer_state_code
      FROM invoices WHERE payment_order_id = ${orderId}::uuid`;

  const eventsOf = (name: string, orderId: string) =>
    client.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM events
      WHERE event_name = ${name} AND payload->>'payment_order_id' = ${orderId}`;

  const serialOf = (num: string): number => Number(num.split("/")[2]);

  const balance = async (payerId: string): Promise<number> => {
    const [row] = await client.sql<{ balance: number }[]>`
      SELECT balance FROM payer_credits WHERE payer_id = ${payerId}::uuid`;
    return Number(row?.balance ?? 0);
  };

  /** A raw invoice for an order, for the CHECK cases; `over` replaces any column. */
  const rawInvoice = async (over: Record<string, unknown>) => {
    const payer = await company();
    const o = await order(payer);
    const row: Record<string, unknown> = {
      payment_order_id: o.id,
      payer_id: payer,
      invoice_number: `ZZ/2099-00/${randomUUID().slice(0, 4)}`,
      financial_year: "2099-00",
      issued_at: new Date().toISOString(),
      seller_legal_name: "Fake Seller Private Limited",
      seller_gstin: FAKE_SELLER_GSTIN,
      seller_pan: "AAAAA0000A",
      seller_state_code: "06",
      seller_address: "1 Test Road",
      sac_code: "998512",
      buyer_state_code: "06",
      supply_type: "intra",
      description: "Credit pack — Starter, 20 contact credits, valid 30 days",
      taxable_paise: 99_900,
      cgst_paise: 9000,
      sgst_paise: 9000,
      igst_paise: 0,
      total_paise: 117_900,
      gst_rate_bps: 1800,
      ...over,
    };
    return client.sql`INSERT INTO invoices ${client.sql(row)}`;
  };

  const checkError = async (work: () => Promise<unknown>) => {
    try {
      await work();
      return null;
    } catch (err) {
      const e = err as { code?: string; constraint_name?: string };
      return { code: e.code, constraint: e.constraint_name };
    }
  };

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 8 });
    const config = {
      ...loadServerConfig({ NODE_ENV: "test" }),
      PAYMENTS_ENABLE_REAL: true,
      PAYMENTS_PROVIDER_KEY: "rzp_test_dbgate",
      PAYMENTS_PROVIDER_SECRET: "rzp_dbgate_key_secret",
      RAZORPAY_WEBHOOK_SECRET: "rzp_dbgate_webhook_secret",
    } as ServerConfig;
    const pii = new PiiCryptoService(config);
    const events = new EventsService(new EventsRepository(client.db), config);
    unlocks = new UnlocksRepository(client.db);
    // A catalogue read that fails: the settle's drift check swallows it (the grant never reads it).
    const pricing = { getActiveCatalog: async () => Promise.reject(new Error("no catalogue")) };
    gateway = new PaymentGateway(unlocks, config, pricing as never, { isLive: true } as never);
    invoicesRepo = new InvoicesRepository(client.db);
    // The settle's issuer on a LIVE key; a second one on a TEST key (the rehearsal).
    issuer = new InvoiceIssuer(invoicesRepo, events, { PAYMENTS_PROVIDER_KEY: "rzp_live_dbgate" });
    testIssuer = new Issuer(invoicesRepo, events, { PAYMENTS_PROVIDER_KEY: "rzp_test_dbgate" });
    const tenancy = { resolve: async (id: string) => ({ actorPayerId: id, tenantKey: id }) };
    documents = new InvoiceDocumentsService(invoicesRepo, {} as never, {} as never, pii, config);
    invoicesService = new InvoicesService(invoicesRepo, tenancy as never, pii, events, documents, {
      PAYMENTS_PROVIDER_KEY: "rzp_live_dbgate",
    });
    refunds = new PaymentRefundsService(
      new PaymentRefundsRepository(client.db),
      { get: vi.fn(async () => ({ ...DEFAULT_CREDIT_RULES })) } as never,
      razorpay as never,
      events,
      new InvoiceCreditNotes(invoicesRepo, events),
    );

    // The test's own seller row: any active one is set aside first (restored in afterAll).
    const active = await client.sql<{ id: string }[]>`
      UPDATE seller_tax_config SET is_active = false WHERE is_active RETURNING id`;
    setAside = active.map((r) => r.id);
    const [seller] = await client.sql<{ id: string }[]>`
      INSERT INTO seller_tax_config
        (legal_name, gstin, pan, state_code, address, sac_code, invoice_prefix, credit_note_prefix)
      VALUES ('Fake Seller Private Limited', ${FAKE_SELLER_GSTIN}, 'AAAAA0000A', '06',
              '1 Test Road, Testpur', '998512', 'BB', 'CN')
      RETURNING id`;
    sellerId = seller!.id;
    await client.sql`DELETE FROM invoice_number_series WHERE financial_year IN ${client.sql(TEST_YEARS)}`;
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const { sql } = client;
      await sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      for (const id of companies) {
        await sql`DELETE FROM credit_notes WHERE invoice_id IN (SELECT id FROM invoices WHERE payer_id = ${id}::uuid)`;
        await sql`DELETE FROM audit_logs WHERE entity_type = 'payment_refund' AND actor_id = ${ADMIN_ID}::uuid`;
        await sql`DELETE FROM payment_refunds WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM invoices WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM payer_billing_details WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM credit_ledger WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM credit_lots WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM payment_orders WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM payer_credits WHERE payer_id = ${id}::uuid`;
        await sql`DELETE FROM payers WHERE id = ${id}::uuid`;
      }
      await sql`DELETE FROM invoice_number_series WHERE financial_year IN ${sql(TEST_YEARS)}`;
      await sql`DELETE FROM seller_tax_config WHERE id = ${sellerId}::uuid`;
      if (setAside.length > 0) {
        await sql`UPDATE seller_tax_config SET is_active = true WHERE id = ${setAside[0]!}::uuid`;
      }
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("a settle issues one invoice with the saved billing details: another state is IGST, the buyer snapshot decrypts", { timeout: 30_000 }, async () => {
    const payer = await company(true);
    await invoicesService.putBillingDetails(
      payer,
      { state_code: "27", gstin: FAKE_BUYER_GSTIN, legal_name: "Fake Buyer Pvt Ltd", address: "2 Test Lane" },
      CTX,
    );
    const o = await order(payer);
    const result = await settle(o.providerOrderId);
    expect(result.outcome).toBe("granted");
    expect(await balance(payer)).toBe(20);

    const [inv] = await invoicesOf(o.id);
    expect(inv).toMatchObject({
      financial_year: expect.stringMatching(/^[0-9]{4}-[0-9]{2}$/),
      supply_type: "inter",
      buyer_state_code: "27",
      cgst_paise: 0,
      sgst_paise: 0,
      igst_paise: 18_000,
      total_paise: 117_900,
      is_test: true,
    });
    expect(inv!.invoice_number).toMatch(/^BB\/[0-9]{4}-[0-9]{2}\/[0-9]{4,}$/);
    // The ciphertext is the billing row's, and decrypts to what the company saved.
    const row = await invoicesRepo.findInvoice(inv!.id);
    expect(documents.view(row!, null).buyer).toEqual({
      legalName: "Fake Buyer Pvt Ltd",
      address: "2 Test Lane",
      gstin: FAKE_BUYER_GSTIN,
      stateCode: "27",
    });
    const issued = await eventsOf("invoice.issued", o.id);
    expect(issued).toHaveLength(1);
    expect(issued[0]!.payload).toMatchObject({ supply_type: "inter", total_paise: 117_900, is_test: true });
    expect(JSON.stringify(issued[0]!.payload)).not.toContain("AAAAA0000A");

    // The company's list shows it.
    const list = await invoicesService.listInvoices(payer);
    expect(list.invoices.map((i) => i.id)).toEqual([inv!.id]);
  });

  it("a replayed settle (webhook redelivery, or verify after the webhook) issues nothing new", { timeout: 30_000 }, async () => {
    const payer = await company();
    const o = await order(payer);
    expect((await settle(o.providerOrderId)).outcome).toBe("granted");
    expect((await settle(o.providerOrderId)).outcome).toBe("already_settled");
    expect(await invoicesOf(o.id)).toHaveLength(1);
    // Even the issuer asked again directly, on the paid order, writes nothing.
    const [paid] = await client.sql<PaymentOrder[]>`SELECT id FROM payment_orders WHERE id = ${o.id}::uuid`;
    expect(paid).toBeDefined();
    const again = await client.db.transaction(async (tx) => {
      const row = await unlocks.findPaymentOrder(o.providerOrderId);
      return issuer.issueForSettledOrderWithinTx(tx as unknown as Database, row!, CTX);
    });
    expect(again).toBeNull();
    expect(await invoicesOf(o.id)).toHaveLength(1);
    expect(await eventsOf("invoice.issued", o.id)).toHaveLength(1);
  });

  it("two settles at once take consecutive numbers, and the later number never carries the earlier date", { timeout: 30_000 }, async () => {
    const [a, b] = [await company(), await company()];
    const [oa, ob] = [await order(a), await order(b)];
    const results = await Promise.all([settle(oa.providerOrderId), settle(ob.providerOrderId)]);
    expect(results.map((r) => r.outcome)).toEqual(["granted", "granted"]);
    const [ia] = await invoicesOf(oa.id);
    const [ib] = await invoicesOf(ob.id);
    const [lo, hi] = [ia!, ib!].sort((x, y) => serialOf(x.invoice_number) - serialOf(y.invoice_number));
    expect(serialOf(hi!.invoice_number) - serialOf(lo!.invoice_number)).toBe(1);
    // The date is read under the series row lock: the higher number is never dated earlier.
    expect(new Date(hi!.issued_at).getTime()).toBeGreaterThanOrEqual(new Date(lo!.issued_at).getTime());
    // And each invoice's year is the year of its own date (IST).
    for (const inv of [lo!, hi!]) expect(financialYearOf(new Date(inv.issued_at))).toBe(inv.financial_year);
    const [series] = await client.sql<{ last_number: number }[]>`
      SELECT last_number FROM invoice_number_series
      WHERE series = 'invoice' AND financial_year = ${ia!.financial_year}`;
    expect(Number(series!.last_number)).toBeGreaterThanOrEqual(serialOf(hi!.invoice_number));
  });

  it("a rolled-back issue releases its number (the next one reuses it)", { timeout: 30_000 }, async () => {
    const at = new Date("2097-11-01T10:00:00+05:30"); // the 2097-98 year, this file's own
    const take = (series: "invoice" | "credit_note") =>
      client.db.transaction((tx) => invoicesRepo.nextNumber(tx as unknown as Database, series, at));
    const first = await take("invoice");
    await expect(
      client.db.transaction(async (tx) => {
        await invoicesRepo.nextNumber(tx as unknown as Database, "invoice", at);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    const next = await take("invoice");
    expect([first.serial, next.serial]).toEqual([1, 2]);
    expect(first).toMatchObject({ financialYear: "2097-98", issuedAt: at });
    // The two series are separate counters.
    expect((await take("credit_note")).serial).toBe(1);
  });

  it("the year turns at 1 April 00:00 IST and the series restarts at 1 (the database's year agrees with the code's)", { timeout: 30_000 }, async () => {
    const take = (iso: string) =>
      client.db.transaction((tx) => invoicesRepo.nextNumber(tx as unknown as Database, "invoice", new Date(iso)));
    const lastOfYear = await take("2099-03-31T23:59:59.999+05:30");
    const firstOfNext = await take("2099-04-01T00:00:00+05:30");
    const secondOfNext = await take("2099-04-01T00:01:00+05:30");
    expect(lastOfYear).toMatchObject({ serial: 1, financialYear: "2098-99" });
    expect(firstOfNext).toMatchObject({ serial: 1, financialYear: "2099-00" });
    expect(secondOfNext).toMatchObject({ serial: 2, financialYear: "2099-00" });
    expect(firstOfNext.issuedAt.toISOString()).toBe(new Date("2099-04-01T00:00:00+05:30").toISOString());

    // The SQL year and financialYearOf agree on both sides of every boundary, IST and UTC.
    const instants: Date[] = [];
    for (let y = 2025; y <= 2101; y += 1) {
      for (const iso of [
        `${y}-03-31T23:59:59.999+05:30`,
        `${y}-04-01T00:00:00+05:30`,
        `${y}-03-31T18:29:59.999Z`,
        `${y}-03-31T18:30:00Z`,
        `${y}-12-31T23:59:59+05:30`,
        `${y}-01-01T00:00:00+05:30`,
      ]) {
        instants.push(new Date(iso));
      }
    }
    const disagree: string[] = [];
    for (const at of instants) {
      const db = await invoicesRepo.financialYearInDb(at);
      if (db !== financialYearOf(at)) disagree.push(`${at.toISOString()}: db=${db} code=${financialYearOf(at)}`);
    }
    expect(disagree).toEqual([]);
  });

  it("TEST MODE: the settle grants the credits, takes no number, issues nothing; its refund takes no credit-note number", { timeout: 30_000 }, async () => {
    const payer = await company();
    const o = await order(payer);
    const seriesNow = async (series: string) => {
      const rows = await client.sql<{ n: number }[]>`
        SELECT coalesce(sum(last_number), 0)::int AS n FROM invoice_number_series WHERE series = ${series}`;
      return Number(rows[0]!.n);
    };
    const [invoicesBefore, notesBefore] = [await seriesNow("invoice"), await seriesNow("credit_note")];
    expect((await settle(o.providerOrderId, "test_mode")).outcome).toBe("granted");
    expect(await balance(payer)).toBe(20);
    expect(await invoicesOf(o.id)).toHaveLength(0);
    expect((await eventsOf("payment.invoice_not_issued", o.id)).map((e) => e.payload.reason)).toEqual(["test_mode"]);
    await expect(
      refunds.refund(ADMIN_ID, o.id, { rule: "unused", reason_text: "Company bought the wrong pack by mistake" }, CTX),
    ).rejects.toMatchObject({ response: { code: "NO_INVOICE_FOR_ORDER" } });
    expect(await balance(payer)).toBe(20);
    expect([await seriesNow("invoice"), await seriesNow("credit_note")]).toEqual([invoicesBefore, notesBefore]);
  });

  it("a seller GSTIN that fails its check character is not used: nothing issued, seller_config_invalid", { timeout: 30_000 }, async () => {
    const payer = await company();
    const o = await order(payer);
    // Passes the row's CHECK (shape, state, PAN) but not the check character.
    await client.sql`UPDATE seller_tax_config SET gstin = '06AAAAA0000A1Z5' WHERE id = ${sellerId}::uuid`;
    try {
      expect((await settle(o.providerOrderId)).outcome).toBe("granted");
      await expect(invoicesService.assertCheckoutInvoiceable(payer)).rejects.toMatchObject({
        response: { code: "INVOICES_UNAVAILABLE" },
      });
    } finally {
      await client.sql`UPDATE seller_tax_config SET gstin = ${FAKE_SELLER_GSTIN} WHERE id = ${sellerId}::uuid`;
    }
    expect(await invoicesOf(o.id)).toHaveLength(0);
    expect((await eventsOf("payment.invoice_not_issued", o.id)).map((e) => e.payload.reason)).toEqual([
      "seller_config_invalid",
    ]);
  });

  it("the savepoint: no active seller row → credits granted, no invoice, payment.invoice_not_issued", { timeout: 30_000 }, async () => {
    const payer = await company();
    const o = await order(payer);
    await client.sql`UPDATE seller_tax_config SET is_active = false WHERE id = ${sellerId}::uuid`;
    try {
      const result = await settle(o.providerOrderId);
      expect(result.outcome).toBe("granted");
    } finally {
      await client.sql`UPDATE seller_tax_config SET is_active = true WHERE id = ${sellerId}::uuid`;
    }
    expect(await balance(payer)).toBe(20);
    expect(await invoicesOf(o.id)).toHaveLength(0);
    const [paid] = await client.sql<{ status: string }[]>`SELECT status FROM payment_orders WHERE id = ${o.id}::uuid`;
    expect(paid!.status).toBe("paid");
    const notIssued = await eventsOf("payment.invoice_not_issued", o.id);
    expect(notIssued.map((e) => e.payload)).toEqual([
      { payment_order_id: o.id, payer_id: payer, reason: "seller_not_configured" },
    ]);
    // The captured event's sibling: no invoice.issued for it.
    expect(await eventsOf("invoice.issued", o.id)).toHaveLength(0);

    // The repair (issue-missing-invoice.cli's logic, with the real issuer and repository): a dry
    // run writes nothing; --apply issues it dated now; a second run refuses.
    const deps = {
      findOrder: (id: string) => invoicesRepo.findPaymentOrder(id),
      hasInvoice: async (id: string) => (await invoicesRepo.findInvoiceByOrder(invoicesRepo.reader, id)) !== undefined,
      sellerCheck: async () => {
        const usable = usableSeller(await invoicesRepo.activeSeller());
        return usable.ok ? ("ok" as const) : usable.reason;
      },
      issue: (ord: PaymentOrder) => invoicesRepo.withTransaction((tx) => issuer.issueWithinTx(tx, ord, CTX)),
    };
    expect(await issueMissingInvoice(deps, { orderId: o.id, apply: false, testMode: false })).toEqual({
      outcome: "would_issue",
    });
    expect(await invoicesOf(o.id)).toHaveLength(0);
    const before = Date.now();
    const done = await issueMissingInvoice(deps, { orderId: o.id, apply: true, testMode: false });
    expect(done.outcome).toBe("issued");
    const [repaired] = await invoicesOf(o.id);
    expect(new Date(repaired!.issued_at).getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(await eventsOf("invoice.issued", o.id)).toHaveLength(1);
    expect(await issueMissingInvoice(deps, { orderId: o.id, apply: true, testMode: false })).toEqual({
      outcome: "refused",
      reason: "already_invoiced",
    });
    expect(await invoicesOf(o.id)).toHaveLength(1);
  });

  it("a refund writes its credit note in the refund's transaction; the refund row carries its number", { timeout: 30_000 }, async () => {
    const payer = await company();
    const o = await order(payer);
    expect((await settle(o.providerOrderId)).outcome).toBe("granted");
    const [inv] = await invoicesOf(o.id);

    const view = await refunds.refund(
      ADMIN_ID,
      o.id,
      { rule: "unused", reason_text: "Company bought the wrong pack by mistake" },
      CTX,
    );
    expect(view.credit_note_number).toMatch(/^CN\/[0-9]{4}-[0-9]{2}\/[0-9]{4,}$/);
    expect(await balance(payer)).toBe(0);
    const notes = await client.sql<{ id: string; credit_note_number: string; total_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; payment_refund_id: string }[]>`
      SELECT id, credit_note_number, total_paise, cgst_paise, sgst_paise, igst_paise, payment_refund_id
      FROM credit_notes WHERE invoice_id = ${inv!.id}::uuid`;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      credit_note_number: view.credit_note_number,
      payment_refund_id: view.id,
      total_paise: inv!.total_paise,
      cgst_paise: inv!.cgst_paise,
      sgst_paise: inv!.sgst_paise,
      igst_paise: inv!.igst_paise,
    });
    const [stamped] = await client.sql<{ credit_note_number: string }[]>`
      SELECT credit_note_number FROM payment_refunds WHERE id = ${view.id}::uuid`;
    expect(stamped!.credit_note_number).toBe(view.credit_note_number);
    const issued = await client.sql`
      SELECT 1 FROM events WHERE event_name = 'credit_note.issued' AND payload->>'payment_refund_id' = ${view.id}`;
    expect(issued).toHaveLength(1);
    // The company's list carries it.
    const list = await invoicesService.listInvoices(payer);
    expect(list.invoices[0]!.credit_note).toMatchObject({ id: notes[0]!.id, credit_note_number: view.credit_note_number });
  });

  it("a refund of an order with no invoice is refused (409 NO_INVOICE_FOR_ORDER) with nothing written", { timeout: 30_000 }, async () => {
    const payer = await company();
    const o = await order(payer);
    expect((await settle(o.providerOrderId, false)).outcome).toBe("granted");
    await expect(
      refunds.refund(ADMIN_ID, o.id, { rule: "unused", reason_text: "Company bought the wrong pack by mistake" }, CTX),
    ).rejects.toMatchObject({ response: { code: "NO_INVOICE_FOR_ORDER" } });
    expect(await balance(payer)).toBe(20);
    const [n] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_refunds WHERE payment_order_id = ${o.id}::uuid`;
    expect(Number(n!.n)).toBe(0);
    expect(razorpay.refundPayment).toHaveBeenCalledTimes(1); // only the earlier case's refund
  });

  it("the CHECKs refuse a wrong split, a wrong sum, an over-long number and a second active seller", { timeout: 30_000 }, async () => {
    expect(await checkError(() => rawInvoice({ igst_paise: 100, total_paise: 118_000 }))).toEqual({
      code: "23514",
      constraint: "invoices_split_chk",
    });
    expect(
      await checkError(() => rawInvoice({ supply_type: "inter", buyer_state_code: "27", igst_paise: 18_000 })),
    ).toEqual({ code: "23514", constraint: "invoices_split_chk" });
    expect(await checkError(() => rawInvoice({ cgst_paise: 9100 }))).toEqual({
      code: "23514",
      constraint: "invoices_sum_chk",
    });
    expect(await checkError(() => rawInvoice({ supply_type: "intra", buyer_state_code: "27" }))).toEqual({
      code: "23514",
      constraint: "invoices_place_chk",
    });
    expect(await checkError(() => rawInvoice({ invoice_number: "BBB/2099-00/00001" }))).toEqual({
      code: "23514",
      constraint: "invoices_number_chk",
    });
    expect(
      await checkError(
        () => client.sql`
          INSERT INTO seller_tax_config
            (legal_name, gstin, pan, state_code, address, sac_code, invoice_prefix, credit_note_prefix)
          VALUES ('Second Fake Seller', ${FAKE_SELLER_GSTIN}, 'AAAAA0000A', '06', '2 Road', '998512', 'BX', 'CX')`,
      ),
    ).toEqual({ code: "23505", constraint: "seller_tax_config_one_active_uq" });
    expect(
      await checkError(
        () => client.sql`
          INSERT INTO seller_tax_config
            (legal_name, gstin, pan, state_code, address, sac_code, invoice_prefix, credit_note_prefix, is_active)
          VALUES ('Fake', ${FAKE_SELLER_GSTIN}, 'AAAAA0000A', '07', '2 Road', '998512', 'BX', 'CX', false)`,
      ),
    ).toEqual({ code: "23514", constraint: "seller_tax_config_gstin_chk" });
    expect(
      await checkError(
        () => client.sql`
          INSERT INTO seller_tax_config
            (legal_name, gstin, pan, state_code, address, sac_code, invoice_prefix, credit_note_prefix, is_active)
          VALUES ('Fake', ${FAKE_SELLER_GSTIN}, 'AAAAA0000A', '06', '2 Road', '998512', 'BBBB', 'CX', false)`,
      ),
    ).toEqual({ code: "23514", constraint: "seller_tax_config_prefix_chk" });
    expect(
      await checkError(
        () => client.sql`
          INSERT INTO payer_billing_details (payer_id, state_code, gstin_enc, updated_by)
          VALUES (${randomUUID()}::uuid, '06', 'v1.cipher', ${randomUUID()}::uuid)`,
      ),
    ).toEqual({ code: "23514", constraint: "payer_billing_details_gstin_chk" });
  });
});
