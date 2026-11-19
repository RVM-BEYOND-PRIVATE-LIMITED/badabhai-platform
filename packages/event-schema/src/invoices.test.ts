import { describe, expect, it } from "vitest";

import { EVENT_DOMAINS } from "./enums";
import { EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";
const UUID_E = "55555555-5555-4555-8555-555555555555";

/**
 * #2749 part 4 — `invoice.issued`, `credit_note.issued`, `payment.invoice_not_issued` and
 * `payer.billing_details_updated`. Ids, the financial year, closed codes and paise, `.strict()`:
 * no invoice number, GSTIN, legal name or address can ride along.
 */
function envelope(name: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: name,
    event_version: 1,
    occurred_at: "2026-11-18T10:00:00.000Z",
    actor: { actor_type: "system", actor_id: null },
    subject: { subject_type: "payer", subject_id: UUID_C },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  };
}

const invoice = (over: Record<string, unknown> = {}) =>
  envelope("invoice.issued", {
    invoice_id: UUID_E,
    payment_order_id: UUID_A,
    payer_id: UUID_C,
    financial_year: "2026-27",
    supply_type: "intra",
    total_paise: 117_900,
    is_test: false,
    ...over,
  });

const creditNote = (over: Record<string, unknown> = {}) =>
  envelope("credit_note.issued", {
    credit_note_id: UUID_B,
    invoice_id: UUID_E,
    payment_refund_id: UUID_A,
    payer_id: UUID_C,
    financial_year: "2026-27",
    total_paise: 117_900,
    ...over,
  });

const notIssued = (over: Record<string, unknown> = {}) =>
  envelope("payment.invoice_not_issued", {
    payment_order_id: UUID_A,
    payer_id: UUID_C,
    reason: "seller_not_configured",
    ...over,
  });

const billing = (over: Record<string, unknown> = {}) =>
  envelope("payer.billing_details_updated", {
    payer_id: UUID_C,
    state_code: "06",
    has_gstin: true,
    ...over,
  });

describe("registration", () => {
  it("registers the four as v1, two of them in their own new domains", () => {
    expect(EVENT_DOMAINS).toContain("invoice");
    expect(EVENT_DOMAINS).toContain("credit_note");
    expect(EVENT_REGISTRY["invoice.issued"]).toMatchObject({ version: 1, domain: "invoice" });
    expect(EVENT_REGISTRY["credit_note.issued"]).toMatchObject({ version: 1, domain: "credit_note" });
    expect(EVENT_REGISTRY["payment.invoice_not_issued"]).toMatchObject({
      version: 1,
      domain: "payment",
    });
    expect(EVENT_REGISTRY["payer.billing_details_updated"]).toMatchObject({
      version: 1,
      domain: "payer",
    });
    for (const n of ["invoice.issued", "credit_note.issued", "payment.invoice_not_issued", "payer.billing_details_updated"]) {
      expect(isEventName(n)).toBe(true);
    }
  });
});

describe("invoice.issued", () => {
  it("accepts both supply types and a test invoice", () => {
    expect(validateEvent(invoice()).success).toBe(true);
    expect(validateEvent(invoice({ supply_type: "inter", is_test: true })).success).toBe(true);
  });

  it("refuses another supply type, a bad financial year and a negative total", () => {
    expect(validateEvent(invoice({ supply_type: "export" })).success).toBe(false);
    expect(validateEvent(invoice({ financial_year: "2026" })).success).toBe(false);
    expect(validateEvent(invoice({ total_paise: -1 })).success).toBe(false);
  });

  it("is strict: no number, GSTIN, name or address rides along", () => {
    expect(validateEvent(invoice({ invoice_number: "BB/2026-27/0001" })).success).toBe(false);
    expect(validateEvent(invoice({ buyer_gstin: "x" })).success).toBe(false);
    expect(validateEvent(invoice({ buyer_legal_name: "x" })).success).toBe(false);
  });
});

describe("credit_note.issued", () => {
  it("accepts a credit note and is strict", () => {
    expect(validateEvent(creditNote()).success).toBe(true);
    expect(validateEvent(creditNote({ credit_note_number: "CN/2026-27/0001" })).success).toBe(false);
    expect(validateEvent(creditNote({ total_paise: 1.5 })).success).toBe(false);
  });
});

describe("payment.invoice_not_issued", () => {
  it("accepts the five closed reasons only", () => {
    for (const reason of ["seller_not_configured", "seller_config_invalid", "price_line_missing", "test_mode", "issue_failed"]) {
      expect(validateEvent(notIssued({ reason })).success).toBe(true);
    }
    expect(validateEvent(notIssued({ reason: "database_down" })).success).toBe(false);
    expect(validateEvent(notIssued({ error: "relation does not exist" })).success).toBe(false);
  });
});

describe("payer.billing_details_updated", () => {
  it("carries the state and whether a GSTIN is on file, never the values", () => {
    expect(validateEvent(billing()).success).toBe(true);
    expect(validateEvent(billing({ has_gstin: false })).success).toBe(true);
    expect(validateEvent(billing({ state_code: "6" })).success).toBe(false);
    expect(validateEvent(billing({ gstin: "x" })).success).toBe(false);
    expect(validateEvent(billing({ legal_name: "x" })).success).toBe(false);
    expect(validateEvent(billing({ address: "x" })).success).toBe(false);
  });
});
