"use client";

import { useState } from "react";
import { getInvoiceDownloadAction } from "./invoice-actions";
import { paiseToInr } from "../../../lib/invoice-format";
import type { Invoice } from "../../../lib/invoices";

function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

/**
 * #2749 part 4 — the company's invoices, newest first, with the tax lines and a fresh short-lived
 * download link per click. A refunded order shows its credit note with its own download.
 */
export function InvoicesList({ invoices }: { invoices: Invoice[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(kind: "invoice" | "credit_note", id: string): Promise<void> {
    const key = `${kind}:${id}`;
    setBusy(key);
    const res = await getInvoiceDownloadAction(kind, id);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    window.open(res.url, "_blank", "noopener,noreferrer");
  }

  return (
    <section className="cred-panel">
      <div className="cred-panel__head">
        <div>
          <h2 className="cred-panel__title">Invoices</h2>
          <p className="cred-panel__sub">GST invoices for your credit purchases, newest first.</p>
        </div>
      </div>
      <div className="cred-panel__body">
        {invoices.length === 0 ? (
          <div className="cred-empty">
            <h3 className="cred-empty__title">No invoices yet</h3>
            <p className="cred-empty__body">
              Your first invoice appears here after a real pack purchase.
            </p>
          </div>
        ) : (
          <div className="tablewrap" tabIndex={0} role="region" aria-label="Invoices">
            <table className="table table--nowrap">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="num">Taxable</th>
                  <th className="num">Tax</th>
                  <th className="num">Total</th>
                  <th>Document</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td className="mono">{inv.invoice_number}</td>
                    <td className="mono">{day(inv.issued_at)}</td>
                    <td>{inv.description}</td>
                    <td className="num">{paiseToInr(inv.taxable_paise)}</td>
                    <td className="num">
                      {inv.supply_type === "intra"
                        ? `CGST ${paiseToInr(inv.cgst_paise)} + SGST ${paiseToInr(inv.sgst_paise)}`
                        : `IGST ${paiseToInr(inv.igst_paise)}`}
                    </td>
                    <td className="num">{paiseToInr(inv.total_paise)}</td>
                    <td>
                      <button
                        className="bb-btn bb-btn--ghost bb-btn--sm"
                        type="button"
                        disabled={busy === `invoice:${inv.id}`}
                        onClick={() => void download("invoice", inv.id)}
                      >
                        {busy === `invoice:${inv.id}` ? "Preparing…" : "Download"}
                      </button>
                      {inv.credit_note ? (
                        <button
                          className="bb-btn bb-btn--ghost bb-btn--sm"
                          type="button"
                          disabled={busy === `credit_note:${inv.credit_note.id}`}
                          onClick={() => void download("credit_note", inv.credit_note!.id)}
                        >
                          {busy === `credit_note:${inv.credit_note.id}`
                            ? "Preparing…"
                            : `Credit note ${inv.credit_note.credit_note_number}`}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {error ? <p className="applicant__error">{error}</p> : null}
      </div>
    </section>
  );
}
