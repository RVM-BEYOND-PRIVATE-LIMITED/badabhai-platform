"use server";

import { requirePayer } from "../../../lib/auth";
import { isPayerStatus } from "../../../lib/payer-errors";
import {
  downloadCreditNote,
  downloadInvoice,
  putBillingDetails,
  type BillingDetails,
} from "../../../lib/invoices";

export type BillingDetailsResult = { ok: true; details: BillingDetails } | { ok: false; error: string };

function fieldError(e: unknown): string | null {
  if (!(e instanceof Error)) return null;
  const msg = e.message.toLowerCase();
  if (msg.includes("gstin")) return "Check the GSTIN — its format, check digit and state code.";
  if (msg.includes("legal_name") || msg.includes("legal name"))
    return "Enter the legal name printed on the GSTIN.";
  if (msg.includes("address")) return "Enter the billing address.";
  if (msg.includes("state_code") || msg.includes("state"))
    return "Choose the GST state or UT.";
  return null;
}

export async function saveBillingDetailsAction(input: {
  stateCode: string;
  gstin?: string | null;
  legalName?: string | null;
  address?: string | null;
}): Promise<BillingDetailsResult> {
  await requirePayer();
  if (!input.stateCode) return { ok: false, error: "Choose the GST state or UT." };
  try {
    return { ok: true, details: await putBillingDetails(input) };
  } catch (e) {
    return {
      ok: false,
      error: fieldError(e) ?? "Could not save the billing details. Please retry.",
    };
  }
}

export type DownloadResult =
  | { ok: true; url: string }
  | { ok: false; preparing: boolean; error: string };

export async function getInvoiceDownloadAction(
  kind: "invoice" | "credit_note",
  id: string,
): Promise<DownloadResult> {
  await requirePayer();
  try {
    const link = kind === "invoice" ? await downloadInvoice(id) : await downloadCreditNote(id);
    return { ok: true, url: link.url };
  } catch (e) {
    if (isPayerStatus(e, 503)) {
      return { ok: false, preparing: true, error: "Invoice is being prepared, try again shortly" };
    }
    return { ok: false, preparing: false, error: "This document is unavailable right now." };
  }
}
