import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { InvoiceRow, PaymentOrder } from "@badabhai/db";
import { InvoicesService } from "./invoices.service";
import { InvoiceCreditNotes } from "./invoice-credit-notes.service";

/**
 * #2749 part 4 — the company side (billing details, list, downloads, the checkout gate) and the
 * credit-note issuer's refusals. Every value is a FAKE fixture; the "cipher" is a reversible tag.
 */
const ACTOR = "aaaaaaaa-0000-4000-8000-000000000001";
const TENANT = "bbbbbbbb-0000-4000-8000-000000000002";
const CTX = { correlationId: "cccccccc-0000-4000-8000-000000000003", requestId: "req-1" };
const FAKE_GSTIN = "06AAAAA0000A1Z6";

function make(key = "rzp_live_fake") {
  const tx = { tx: true };
  const repo = {
    withTransaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)),
    billingDetails: vi.fn(async () => undefined as unknown),
    upsertBillingDetails: vi.fn(async (_tx: unknown, v: Record<string, unknown>) => ({ ...v })),
    activeSeller: vi.fn(async () => ({ id: "seller", gstin: FAKE_GSTIN }) as unknown),
    listForPayer: vi.fn(async () => [] as unknown[]),
    findInvoiceForPayer: vi.fn(async () => undefined as unknown),
    findCreditNoteForPayer: vi.fn(async () => undefined as unknown),
  };
  const tenancy = { resolve: vi.fn(async () => ({ actorPayerId: ACTOR, tenantKey: TENANT })) };
  const pii = {
    encrypt: vi.fn((v: string) => `enc(${v})`),
    decrypt: vi.fn((v: string) => v.replace(/^enc\((.*)\)$/s, "$1")),
  };
  const events = { emit: vi.fn(async (_p: unknown) => undefined) };
  const documents = {
    signInvoice: vi.fn(async () => ({ url: "https://signed", expires_in_seconds: 300 })),
    signCreditNote: vi.fn(async () => ({ url: "https://signed", expires_in_seconds: 300 })),
  };
  const service = new InvoicesService(
    repo as never,
    tenancy as never,
    pii as never,
    events as never,
    documents as never,
    { PAYMENTS_PROVIDER_KEY: key },
  );
  return { service, repo, tenancy, pii, events, documents, tx };
}

describe("billing details", () => {
  it("nothing saved: all nulls", async () => {
    const t = make();
    expect(await t.service.getBillingDetails(ACTOR)).toEqual({
      saved: false,
      state_code: null,
      gstin: null,
      legal_name: null,
      address: null,
    });
    expect(t.repo.billingDetails).toHaveBeenCalledWith(TENANT);
  });

  it("saves under the TENANT key, encrypts the three values, and the event carries only the state and has_gstin", async () => {
    const t = make();
    const out = await t.service.putBillingDetails(
      ACTOR,
      { state_code: "06", gstin: FAKE_GSTIN, legal_name: "Fake Buyer", address: "1 Road" },
      CTX,
    );
    expect(t.repo.upsertBillingDetails).toHaveBeenCalledWith(t.tx, {
      payerId: TENANT,
      stateCode: "06",
      gstinEnc: `enc(${FAKE_GSTIN})`,
      legalNameEnc: "enc(Fake Buyer)",
      addressEnc: "enc(1 Road)",
      updatedBy: ACTOR,
    });
    expect(out).toEqual({
      saved: true,
      state_code: "06",
      gstin: FAKE_GSTIN,
      legal_name: "Fake Buyer",
      address: "1 Road",
    });
    const event = t.events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(event).toMatchObject({
      event_name: "payer.billing_details_updated",
      actor: { actor_type: "payer", actor_id: ACTOR },
      payload: { payer_id: TENANT, state_code: "06", has_gstin: true },
      tx: t.tx,
    });
    expect(JSON.stringify(event)).not.toMatch(/AAAAA0000A|Fake Buyer|1 Road/);
  });

  it("a state alone clears the other three (a full replace)", async () => {
    const t = make();
    await t.service.putBillingDetails(ACTOR, { state_code: "27" }, CTX);
    expect(t.repo.upsertBillingDetails.mock.calls[0]![1]).toMatchObject({
      gstinEnc: null,
      legalNameEnc: null,
      addressEnc: null,
    });
    expect((t.events.emit.mock.calls[0]![0] as { payload: unknown }).payload).toEqual({
      payer_id: TENANT,
      state_code: "27",
      has_gstin: false,
    });
  });
});

describe("the real checkout's invoice gate", () => {
  it("passes with a seller row and saved details", async () => {
    const t = make();
    t.repo.billingDetails.mockResolvedValueOnce({ payerId: TENANT });
    await expect(t.service.assertCheckoutInvoiceable(ACTOR)).resolves.toBeUndefined();
    expect(t.repo.billingDetails).toHaveBeenCalledWith(TENANT);
  });

  it("503 INVOICES_UNAVAILABLE with no active seller row", async () => {
    const t = make();
    t.repo.activeSeller.mockResolvedValueOnce(undefined);
    await expect(t.service.assertCheckoutInvoiceable(ACTOR)).rejects.toMatchObject({
      status: 503,
      response: { code: "INVOICES_UNAVAILABLE" },
    });
  });

  it("503 INVOICES_UNAVAILABLE when the seller row's GSTIN fails its check character", async () => {
    const t = make();
    t.repo.billingDetails.mockResolvedValueOnce({ payerId: TENANT });
    t.repo.activeSeller.mockResolvedValueOnce({ id: "seller", gstin: "06AAAAA0000A1Z5" });
    await expect(t.service.assertCheckoutInvoiceable(ACTOR)).rejects.toMatchObject({
      status: 503,
      response: { code: "INVOICES_UNAVAILABLE" },
    });
  });

  it("TEST MODE (a rzp_test_ key): never refuses — no seller row or billing details needed, nothing read", async () => {
    const t = make("rzp_test_fake");
    t.repo.activeSeller.mockResolvedValue(undefined);
    await expect(t.service.assertCheckoutInvoiceable(ACTOR)).resolves.toBeUndefined();
    expect(t.repo.activeSeller).not.toHaveBeenCalled();
    expect(t.repo.billingDetails).not.toHaveBeenCalled();
  });

  it("409 BILLING_DETAILS_REQUIRED while the company has saved none", async () => {
    const t = make();
    await expect(t.service.assertCheckoutInvoiceable(ACTOR)).rejects.toMatchObject({
      status: 409,
      response: { code: "BILLING_DETAILS_REQUIRED" },
    });
  });

  it("fails closed (503) when the tables are missing", async () => {
    const t = make();
    t.repo.activeSeller.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "42P01" }));
    await expect(t.service.assertCheckoutInvoiceable(ACTOR)).rejects.toMatchObject({
      status: 503,
      response: { code: "INVOICES_UNAVAILABLE" },
    });
  });
});

describe("list and downloads", () => {
  it("lists the tenant's invoices with their credit note, in the documented shape", async () => {
    const t = make();
    const issued = new Date("2026-11-18T06:30:00Z");
    t.repo.listForPayer.mockResolvedValueOnce([
      {
        invoice: {
          id: "inv-1",
          invoiceNumber: "BB/2026-27/0001",
          issuedAt: issued,
          description: "Credit pack — Starter, 20 contact credits, valid 30 days",
          supplyType: "intra",
          taxablePaise: 99_900,
          cgstPaise: 9000,
          sgstPaise: 9000,
          igstPaise: 0,
          totalPaise: 117_900,
        },
        creditNote: { id: "cn-1", creditNoteNumber: "CN/2026-27/0001", issuedAt: issued, totalPaise: 117_900 },
      },
    ]);
    expect(await t.service.listInvoices(ACTOR)).toEqual({
      invoices: [
        {
          id: "inv-1",
          invoice_number: "BB/2026-27/0001",
          issued_at: issued.toISOString(),
          description: "Credit pack — Starter, 20 contact credits, valid 30 days",
          supply_type: "intra",
          taxable_paise: 99_900,
          cgst_paise: 9000,
          sgst_paise: 9000,
          igst_paise: 0,
          total_paise: 117_900,
          credit_note: {
            id: "cn-1",
            credit_note_number: "CN/2026-27/0001",
            issued_at: issued.toISOString(),
            total_paise: 117_900,
          },
        },
      ],
    });
    expect(t.repo.listForPayer).toHaveBeenCalledWith(TENANT);
  });

  it("another company's (or an unknown) invoice or credit note is the same neutral 404", async () => {
    const t = make();
    await expect(t.service.downloadInvoice(ACTOR, "inv-x")).rejects.toBeInstanceOf(NotFoundException);
    await expect(t.service.downloadCreditNote(ACTOR, "cn-x")).rejects.toBeInstanceOf(NotFoundException);
    expect(t.repo.findInvoiceForPayer).toHaveBeenCalledWith("inv-x", TENANT);
    expect(t.repo.findCreditNoteForPayer).toHaveBeenCalledWith("cn-x", TENANT);
    expect(t.documents.signInvoice).not.toHaveBeenCalled();
  });

  it("an own invoice is signed", async () => {
    const t = make();
    t.repo.findInvoiceForPayer.mockResolvedValueOnce({ id: "inv-1" });
    expect(await t.service.downloadInvoice(ACTOR, "inv-1")).toEqual({
      url: "https://signed",
      expires_in_seconds: 300,
    });
  });
});

describe("InvoiceCreditNotes.prepare — refusals before any write", () => {
  const order = { id: "order-1" } as PaymentOrder;
  const invoice = { id: "inv-1", totalPaise: 117_900, payerId: TENANT } as InvoiceRow;
  const issuer = (
    found: InvoiceRow | undefined,
    seller: unknown = { creditNotePrefix: "CN", gstin: FAKE_GSTIN },
  ) =>
    new InvoiceCreditNotes(
      {
        findInvoiceByOrder: vi.fn(async () => found),
        activeSeller: vi.fn(async () => (seller === null ? undefined : seller)),
      } as never,
      { emit: vi.fn() } as never,
    );

  it("is available", () => {
    expect(issuer(invoice).available).toBe(true);
  });

  it("409 NO_INVOICE_FOR_ORDER", async () => {
    await expect(issuer(undefined).prepare({} as never, order, 117_900)).rejects.toMatchObject({
      status: 409,
      response: { code: "NO_INVOICE_FOR_ORDER" },
    });
  });

  it("409 CREDIT_NOTE_AMOUNT_MISMATCH", async () => {
    await expect(issuer(invoice).prepare({} as never, order, 99_900)).rejects.toMatchObject({
      status: 409,
      response: { code: "CREDIT_NOTE_AMOUNT_MISMATCH" },
    });
  });

  it("503 INVOICES_UNAVAILABLE with no seller row", async () => {
    await expect(issuer(invoice, null).prepare({} as never, order, 117_900)).rejects.toMatchObject({
      status: 503,
      response: { code: "INVOICES_UNAVAILABLE" },
    });
  });

  it("503 INVOICES_UNAVAILABLE when the seller GSTIN fails its check character", async () => {
    await expect(
      issuer(invoice, { creditNotePrefix: "CN", gstin: "06AAAAA0000A1Z5" }).prepare({} as never, order, 117_900),
    ).rejects.toMatchObject({ status: 503, response: { code: "INVOICES_UNAVAILABLE" } });
  });

  it("a test-mode order (no invoice) is refused NO_INVOICE_FOR_ORDER even with no seller row: no number taken", async () => {
    const nextNumber = vi.fn();
    const cn = new InvoiceCreditNotes(
      {
        findInvoiceByOrder: vi.fn(async () => undefined),
        activeSeller: vi.fn(async () => undefined),
        nextNumber,
      } as never,
      { emit: vi.fn() } as never,
    );
    await expect(cn.prepare({} as never, order, 117_900)).rejects.toMatchObject({
      response: { code: "NO_INVOICE_FOR_ORDER" },
    });
    expect(nextNumber).not.toHaveBeenCalled();
  });

  it("prepared: the invoice and the credit-note prefix", async () => {
    await expect(issuer(invoice).prepare({} as never, order, 117_900)).resolves.toMatchObject({
      invoiceId: "inv-1",
      prefix: "CN",
    });
  });
});
