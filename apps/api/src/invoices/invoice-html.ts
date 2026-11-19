import { gstStateName, rupeesInWords } from "@badabhai/pricing";
import { PdfRenderer } from "../common/pdf/pdf-renderer.service";

/**
 * ONE HTML template for a GST tax invoice and a credit note (#2749 part 4). PURE: it takes the
 * decrypted values and returns markup; `InvoiceDocumentsService` renders it through WeasyPrint.
 *
 * EVERY value is output-encoded ({@link PdfRenderer.escapeHtml}): the buyer's legal name and
 * address are typed by a company, and even the seller row is typed by hand. No round-off line
 * (owner ruling 2026-11-18: GST is rounded to the rupee). The HTML is never logged.
 */
export interface TaxDocumentView {
  readonly kind: "invoice" | "credit_note";
  readonly number: string;
  readonly issuedAt: Date;
  /** A credit note prints the invoice it reverses. */
  readonly originalInvoice: { readonly number: string; readonly issuedAt: Date } | null;
  readonly seller: {
    readonly legalName: string;
    readonly address: string;
    readonly gstin: string;
    readonly pan: string;
    readonly stateCode: string;
  };
  readonly buyer: {
    readonly legalName: string | null;
    readonly address: string | null;
    readonly gstin: string | null;
    /** The place of supply. */
    readonly stateCode: string;
  };
  readonly sacCode: string;
  readonly description: string;
  readonly supplyType: "intra" | "inter";
  readonly gstRateBps: number;
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly totalPaise: number;
}

/** India has no daylight saving: IST is UTC+05:30 all year. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `18 Nov 2026`, on the IST calendar. */
export function istDate(at: Date): string {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Paise as `₹1,179.00` (en-IN grouping, two decimals). Integer arithmetic only. */
export function formatPaise(paise: number): string {
  const rupees = Math.floor(paise / 100);
  return `₹${rupees.toLocaleString("en-IN")}.${String(paise % 100).padStart(2, "0")}`;
}

/** A rate in basis points as a percentage: 1800 → `18%`, 900 → `9%`, 450 → `4.5%`. */
export function formatRate(bps: number): string {
  return `${bps / 100}%`;
}

function stateLine(code: string): string {
  const name = gstStateName(code);
  return name === null ? code : `${name} (${code})`;
}

export function buildTaxDocumentHtml(v: TaxDocumentView): string {
  const e = PdfRenderer.escapeHtml;
  const title = v.kind === "invoice" ? "Tax Invoice" : "Credit Note";
  const lines = (text: string): string =>
    text
      .split(/\r?\n/)
      .map((l) => e(l))
      .join("<br />");
  const half = v.gstRateBps / 2;
  const taxRows =
    v.supplyType === "intra"
      ? `<tr><td>CGST @ ${e(formatRate(half))}</td><td class="num">${e(formatPaise(v.cgstPaise))}</td></tr>
         <tr><td>SGST @ ${e(formatRate(half))}</td><td class="num">${e(formatPaise(v.sgstPaise))}</td></tr>`
      : `<tr><td>IGST @ ${e(formatRate(v.gstRateBps))}</td><td class="num">${e(formatPaise(v.igstPaise))}</td></tr>`;
  const buyerName = v.buyer.legalName !== null ? `<div class="strong">${e(v.buyer.legalName)}</div>` : "";
  const buyerAddress = v.buyer.address !== null ? `<div>${lines(v.buyer.address)}</div>` : "";
  const buyerGstin =
    v.buyer.gstin !== null ? `<div>GSTIN: ${e(v.buyer.gstin)}</div>` : `<div>GSTIN: Unregistered</div>`;
  const original =
    v.originalInvoice !== null
      ? `<div>Original invoice no.: ${e(v.originalInvoice.number)} dated ${e(istDate(v.originalInvoice.issuedAt))}</div>`
      : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${e(title)} ${e(v.number)}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: "Segoe UI", Arial, sans-serif; color: #1a1a1a; margin: 0; font-size: 12px; line-height: 1.45; }
      .page { padding: 28px 36px; }
      h1 { font-size: 20px; margin: 0 0 4px; }
      .meta div { margin: 1px 0; }
      .parties { display: table; width: 100%; margin: 16px 0; border-collapse: collapse; }
      .party { display: table-cell; width: 50%; vertical-align: top; border: 1px solid #ccc; padding: 10px; }
      .label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #555; margin-bottom: 4px; }
      .strong { font-weight: 700; }
      table.lines { width: 100%; border-collapse: collapse; margin-top: 8px; }
      table.lines th, table.lines td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
      table.lines td.num, table.lines th.num { text-align: right; }
      tr.total td { font-weight: 700; }
      .words { margin-top: 10px; }
      @page { size: A4; margin: 12mm; }
    </style>
  </head>
  <body>
    <main class="page">
      <h1>${e(title)}</h1>
      <div class="meta">
        <div>${v.kind === "invoice" ? "Invoice" : "Credit note"} no.: <span class="strong">${e(v.number)}</span></div>
        <div>Date: ${e(istDate(v.issuedAt))}</div>
        ${original}
      </div>
      <div class="parties">
        <div class="party">
          <div class="label">Supplier</div>
          <div class="strong">${e(v.seller.legalName)}</div>
          <div>${lines(v.seller.address)}</div>
          <div>GSTIN: ${e(v.seller.gstin)}</div>
          <div>PAN: ${e(v.seller.pan)}</div>
          <div>State: ${e(stateLine(v.seller.stateCode))}</div>
        </div>
        <div class="party">
          <div class="label">Recipient</div>
          ${buyerName}
          ${buyerAddress}
          ${buyerGstin}
          <div>Place of supply: ${e(stateLine(v.buyer.stateCode))}</div>
        </div>
      </div>
      <table class="lines">
        <thead>
          <tr><th>Description</th><th class="num">Amount</th></tr>
        </thead>
        <tbody>
          <tr><td>${e(v.description)}<br />SAC ${e(v.sacCode)}</td><td class="num"></td></tr>
          <tr><td>Taxable value</td><td class="num">${e(formatPaise(v.taxablePaise))}</td></tr>
          ${taxRows}
          <tr class="total"><td>Total</td><td class="num">${e(formatPaise(v.totalPaise))}</td></tr>
        </tbody>
      </table>
      <div class="words">Amount in words: ${e(rupeesInWords(v.totalPaise))}</div>
    </main>
  </body>
</html>`;
}
