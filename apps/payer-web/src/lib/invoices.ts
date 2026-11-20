import "server-only";
import { z } from "zod";
import { payerFetch } from "./payer-http";
import { paiseToInr } from "./invoice-format";

export { paiseToInr };

/**
 * #2749 part 4 — GST invoices, credit notes and a company's billing details.
 *
 * Mirrors `apps/api/src/invoices/*`. Every call is payer-authed (any org role). Amounts are
 * integer paise. The download routes answer a SHORT-LIVED signed URL (about 5 minutes), so a
 * fresh one is fetched on every click and never stored.
 */

export const billingDetailsSchema = z.object({
  saved: z.boolean(),
  state_code: z.string().nullable(),
  gstin: z.string().nullable(),
  legal_name: z.string().nullable(),
  address: z.string().nullable(),
});
export type BillingDetails = z.infer<typeof billingDetailsSchema>;

const creditNoteSchema = z.object({
  id: z.string(),
  credit_note_number: z.string(),
  issued_at: z.string(),
  total_paise: z.number(),
});

export const invoiceSchema = z.object({
  id: z.string(),
  invoice_number: z.string(),
  issued_at: z.string(),
  description: z.string(),
  supply_type: z.enum(["intra", "inter"]),
  taxable_paise: z.number(),
  cgst_paise: z.number(),
  sgst_paise: z.number(),
  igst_paise: z.number(),
  total_paise: z.number(),
  credit_note: creditNoteSchema.nullable(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

export const invoiceListSchema = z.array(invoiceSchema);
export type InvoiceList = z.infer<typeof invoiceListSchema>;

export function getBillingDetails(): Promise<BillingDetails> {
  return payerFetch("/payer/billing-details", { schema: billingDetailsSchema });
}

export function putBillingDetails(input: {
  stateCode: string;
  gstin?: string | null;
  legalName?: string | null;
  address?: string | null;
}): Promise<BillingDetails> {
  return payerFetch("/payer/billing-details", {
    method: "PUT",
    body: {
      state_code: input.stateCode,
      gstin: input.gstin ?? null,
      legal_name: input.legalName ?? null,
      address: input.address ?? null,
    },
    schema: billingDetailsSchema,
  });
}

export function listInvoices(): Promise<InvoiceList> {
  return payerFetch("/payer/invoices", { schema: invoiceListSchema });
}

const downloadSchema = z.object({ url: z.string(), expires_in_seconds: z.number() });
export type DownloadLink = z.infer<typeof downloadSchema>;

export function downloadInvoice(invoiceId: string): Promise<DownloadLink> {
  return payerFetch(`/payer/invoices/${encodeURIComponent(invoiceId)}/download`, {
    schema: downloadSchema,
  });
}

export function downloadCreditNote(creditNoteId: string): Promise<DownloadLink> {
  return payerFetch(`/payer/credit-notes/${encodeURIComponent(creditNoteId)}/download`, {
    schema: downloadSchema,
  });
}

