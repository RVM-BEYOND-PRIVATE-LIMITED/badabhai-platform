import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { PaymentOrder, SellerTaxConfigRow } from "@badabhai/db";
import { InvoiceIssuer, invoiceAmountsOf } from "./invoice-issuer.service";
import { invoiceDescription, packName } from "./invoice-description";

/**
 * #2749 part 4 — the invoice issued in the settle's transaction. The savepoint is modelled by a
 * fake `tx.transaction` that runs the callback and rethrows its error (as drizzle does after
 * `ROLLBACK TO SAVEPOINT`). All seller values are FAKE fixtures.
 */
const ORDER = "aaaaaaaa-0000-4000-8000-000000000001";
const WALLET = "bbbbbbbb-0000-4000-8000-000000000002";
const CTX = { correlationId: "cccccccc-0000-4000-8000-000000000003", requestId: "req-1" };
const SETTLED = new Date("2026-11-18T06:30:00.000Z");

const order = (over: Partial<PaymentOrder> = {}): PaymentOrder =>
  ({
    id: ORDER,
    payerId: WALLET,
    productKind: "credit_pack",
    packCode: "pack_starter",
    amountInr: 1179,
    creditsGranted: 20,
    provider: "razorpay",
    providerOrderId: "order_1",
    status: "paid",
    providerPaymentRef: "pay_1",
    taxablePaise: 99_900,
    gstPaise: 18_000,
    roundOffPaise: 0,
    totalPaise: 117_900,
    gstRateBps: 1800,
    creditValidityDays: 30,
    origin: null,
    originJobPostingId: null,
    createdAt: SETTLED,
    updatedAt: SETTLED,
    ...over,
  }) as PaymentOrder;

const seller = (over: Partial<SellerTaxConfigRow> = {}): SellerTaxConfigRow =>
  ({
    id: "dddddddd-0000-4000-8000-000000000004",
    legalName: "Fake Seller Private Limited",
    gstin: "06AAAAA0000A1Z6",
    pan: "AAAAA0000A",
    stateCode: "06",
    address: "1 Test Road, Testpur",
    sacCode: "998512",
    invoicePrefix: "BB",
    creditNotePrefix: "CN",
    isActive: true,
    createdAt: SETTLED,
    ...over,
  }) as SellerTaxConfigRow;

/** The instant the series hands out with a number (the DB clock under its row lock). */
const TAKEN_AT = new Date("2026-11-18T07:00:00.000Z");

function make(
  opts: { seller?: SellerTaxConfigRow | null; billingState?: string | null; key?: string } = {},
) {
  const sp = { savepoint: true };
  const tx = {
    transaction: vi.fn(async (cb: (s: unknown) => Promise<unknown>) => cb(sp)),
  };
  const repo = {
    findInvoiceByOrder: vi.fn(async () => undefined as unknown),
    activeSeller: vi.fn(async () => (opts.seller === undefined ? seller() : (opts.seller ?? undefined))),
    billingDetails: vi.fn(async () =>
      opts.billingState === undefined || opts.billingState === null
        ? undefined
        : {
            payerId: WALLET,
            stateCode: opts.billingState,
            gstinEnc: "v1.cipher-gstin",
            legalNameEnc: "v1.cipher-name",
            addressEnc: "v1.cipher-address",
          },
    ),
    nextNumber: vi.fn(async () => ({ serial: 7, financialYear: "2026-27", issuedAt: TAKEN_AT })),
    isTestPayer: vi.fn(async () => false),
    insertInvoice: vi.fn(async (_tx: unknown, v: Record<string, unknown>) => ({ id: "inv-1", ...v })),
  };
  const events = { emit: vi.fn(async (_p: unknown) => undefined) };
  const issuer = new InvoiceIssuer(repo as never, events as never, {
    PAYMENTS_PROVIDER_KEY: opts.key ?? "rzp_live_fake",
  });
  return { issuer, repo, events, tx, sp };
}

const emitted = (events: { emit: { mock: { calls: unknown[][] } } }) =>
  events.emit.mock.calls.map((c) => c[0] as { event_name: string; payload: Record<string, unknown> });

describe("InvoiceIssuer — one invoice per captured order, in a savepoint", () => {
  it("issues inside the seller's state: CGST + SGST, the year's next number, invoice.issued on the savepoint", async () => {
    const t = make({ billingState: "06" });
    const id = await t.issuer.issueForSettledOrderWithinTx(t.tx as never, order(), CTX);
    expect(id).toBe("inv-1");
    expect(t.repo.nextNumber).toHaveBeenCalledWith(t.sp, "invoice");
    const values = t.repo.insertInvoice.mock.calls[0]![1];
    expect(values).toMatchObject({
      paymentOrderId: ORDER,
      payerId: WALLET,
      invoiceNumber: "BB/2026-27/0007",
      financialYear: "2026-27",
      issuedAt: TAKEN_AT,
      supplyType: "intra",
      buyerStateCode: "06",
      buyerGstinEnc: "v1.cipher-gstin",
      taxablePaise: 99_900,
      cgstPaise: 9000,
      sgstPaise: 9000,
      igstPaise: 0,
      totalPaise: 117_900,
      gstRateBps: 1800,
      isTest: false,
      sellerPan: "AAAAA0000A",
      description: "Credit pack — Starter, 20 contact credits, valid 30 days",
    });
    const [event] = emitted(t.events);
    expect(event).toMatchObject({
      event_name: "invoice.issued",
      payload: {
        invoice_id: "inv-1",
        payment_order_id: ORDER,
        payer_id: WALLET,
        financial_year: "2026-27",
        supply_type: "intra",
        total_paise: 117_900,
        is_test: false,
      },
      idempotencyKey: `invoice.issued:order:${ORDER}`,
      tx: t.sp,
    });
  });

  it("another state is IGST; an odd number of GST rupees inside the state gives CGST the extra rupee", async () => {
    const inter = make({ billingState: "27" });
    await inter.issuer.issueForSettledOrderWithinTx(inter.tx as never, order(), CTX);
    expect(inter.repo.insertInvoice.mock.calls[0]![1]).toMatchObject({
      supplyType: "inter",
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 18_000,
    });

    const odd = make({ billingState: "06" });
    // ₹1,005: GST ₹180.90 → ₹181 → CGST ₹91 + SGST ₹90.
    await odd.issuer.issueForSettledOrderWithinTx(
      odd.tx as never,
      order({ taxablePaise: 100_500, gstPaise: 18_100, totalPaise: 118_600, amountInr: 1186 }),
      CTX,
    );
    expect(odd.repo.insertInvoice.mock.calls[0]![1]).toMatchObject({ cgstPaise: 9100, sgstPaise: 9000 });
  });

  it("no saved billing details: the place of supply is the seller's state (IGST Act s12(2)(b)), no buyer snapshot", async () => {
    const t = make({ billingState: null });
    await t.issuer.issueForSettledOrderWithinTx(t.tx as never, order(), CTX);
    expect(t.repo.insertInvoice.mock.calls[0]![1]).toMatchObject({
      buyerStateCode: "06",
      supplyType: "intra",
      buyerGstinEnc: null,
      buyerLegalNameEnc: null,
      buyerAddressEnc: null,
    });
  });

  it("an order stamped under the earlier round-off rule invoices GST = total − taxable (₹180, a whole rupee)", async () => {
    const t = make({ billingState: "06" });
    await t.issuer.issueForSettledOrderWithinTx(
      t.tx as never,
      order({ gstPaise: 17_982, roundOffPaise: 18 }),
      CTX,
    );
    expect(t.repo.insertInvoice.mock.calls[0]![1]).toMatchObject({ cgstPaise: 9000, sgstPaise: 9000 });
  });

  it("the number, the date and the year all come from the series (the DB clock under its lock), not the order", async () => {
    const t = make();
    t.repo.nextNumber.mockResolvedValueOnce({
      serial: 1,
      financialYear: "2027-28",
      issuedAt: new Date("2027-04-01T00:00:00+05:30"),
    });
    await t.issuer.issueForSettledOrderWithinTx(
      t.tx as never,
      order({ updatedAt: new Date("2027-03-31T23:59:59+05:30") }),
      CTX,
    );
    expect(t.repo.insertInvoice.mock.calls[0]![1]).toMatchObject({
      invoiceNumber: "BB/2027-28/0001",
      financialYear: "2027-28",
      issuedAt: new Date("2027-04-01T00:00:00+05:30"),
    });
    expect(emitted(t.events)[0]!.payload).toMatchObject({ financial_year: "2027-28" });
  });

  it("a test company's invoice is marked is_test", async () => {
    const t = make();
    t.repo.isTestPayer.mockResolvedValueOnce(true);
    await t.issuer.issueForSettledOrderWithinTx(t.tx as never, order(), CTX);
    expect(t.repo.insertInvoice.mock.calls[0]![1]).toMatchObject({ isTest: true });
    expect(emitted(t.events)[0]!.payload).toMatchObject({ is_test: true });
  });

  it("a replay (an invoice already on the order) issues nothing and records nothing", async () => {
    const t = make();
    t.repo.findInvoiceByOrder.mockResolvedValueOnce({ id: "inv-0" });
    expect(await t.issuer.issueForSettledOrderWithinTx(t.tx as never, order(), CTX)).toBeNull();
    expect(t.repo.insertInvoice).not.toHaveBeenCalled();
    expect(t.events.emit).not.toHaveBeenCalled();
  });

  it("not a real Razorpay order (no provider payment): nothing at all", async () => {
    const t = make();
    expect(
      await t.issuer.issueForSettledOrderWithinTx(t.tx as never, order({ providerPaymentRef: null }), CTX),
    ).toBeNull();
    expect(t.tx.transaction).not.toHaveBeenCalled();
  });
});

describe("InvoiceIssuer — money taken is never refused", () => {
  it.each([
    ["no active seller row", { seller: null }, {}, "seller_not_configured"],
    ["a seller GSTIN that fails its check character", { seller: seller({ gstin: "06AAAAA0000A1Z5" }) }, {}, "seller_config_invalid"],
    ["a pre-0176 order", {}, { taxablePaise: null, gstPaise: null, roundOffPaise: null, totalPaise: null, gstRateBps: null }, "price_line_missing"],
  ] as const)("%s: no invoice, no throw, payment.invoice_not_issued with the reason", async (_n, opts, over, reason) => {
    const t = make(opts as never);
    const id = await t.issuer.issueForSettledOrderWithinTx(t.tx as never, order(over as never), CTX);
    expect(id).toBeNull();
    expect(t.repo.insertInvoice).not.toHaveBeenCalled();
    expect(emitted(t.events)).toEqual([
      expect.objectContaining({
        event_name: "payment.invoice_not_issued",
        payload: { payment_order_id: ORDER, payer_id: WALLET, reason },
        idempotencyKey: `payment.invoice_not_issued:order:${ORDER}`,
      }),
    ]);
  });

  it("TEST MODE (a rzp_test_ key): no invoice, no number, no savepoint; payment.invoice_not_issued test_mode", async () => {
    const t = make({ key: "rzp_test_fake" });
    expect(t.issuer.testMode).toBe(true);
    expect(await t.issuer.issueForSettledOrderWithinTx(t.tx as never, order(), CTX)).toBeNull();
    expect(t.repo.nextNumber).not.toHaveBeenCalled();
    expect(t.repo.insertInvoice).not.toHaveBeenCalled();
    expect(t.repo.activeSeller).not.toHaveBeenCalled();
    expect(emitted(t.events).map((e) => e.payload.reason)).toEqual(["test_mode"]);
  });

  it("issueWithinTx (the repair CLI's path) THROWS instead of recording", async () => {
    const t = make({ seller: null });
    await expect(t.issuer.issueWithinTx(t.tx as never, order(), CTX)).rejects.toMatchObject({
      name: "SellerNotConfiguredError",
      reason: "seller_not_configured",
    });
    expect(t.events.emit).not.toHaveBeenCalled();
  });

  it("any other failure (a missing table) is issue_failed, logged without values, and never thrown", async () => {
    const t = make();
    t.repo.nextNumber.mockRejectedValueOnce(
      Object.assign(new Error('relation "invoice_number_series" does not exist'), { code: "42P01" }),
    );
    expect(await t.issuer.issueForSettledOrderWithinTx(t.tx as never, order(), CTX)).toBeNull();
    expect(emitted(t.events).map((e) => e.payload.reason)).toEqual(["issue_failed"]);
  });

  it("even a failure to record payment.invoice_not_issued does not throw (the credits still commit)", async () => {
    const t = make({ seller: null });
    t.events.emit.mockRejectedValue(new Error("events table down"));
    await expect(
      t.issuer.issueForSettledOrderWithinTx(t.tx as never, order(), CTX),
    ).resolves.toBeNull();
  });
});

describe("invoice amounts and description (pure)", () => {
  it("reads the stamped paise; null for a pre-0176 order", () => {
    expect(invoiceAmountsOf(order())).toEqual({
      taxablePaise: 99_900,
      gstPaise: 18_000,
      totalPaise: 117_900,
      gstRateBps: 1800,
    });
    expect(invoiceAmountsOf(order({ taxablePaise: null, totalPaise: null, gstRateBps: null }))).toBeNull();
  });

  it("names the product, never a person; a pack with no validity says nothing about it", () => {
    expect(invoiceDescription(order())).toBe("Credit pack — Starter, 20 contact credits, valid 30 days");
    expect(invoiceDescription(order({ packCode: "pack_big", creditsGranted: 100, creditValidityDays: null }))).toBe(
      "Credit pack — Big, 100 contact credits",
    );
    expect(packName(null)).toBe("Pack");
    expect(packName("pack_annual")).toBe("Annual");
  });
});
