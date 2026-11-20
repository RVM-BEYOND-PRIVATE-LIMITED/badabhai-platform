"use client";

import { useState } from "react";
import { GST_STATES } from "@badabhai/pricing";
import { saveBillingDetailsAction } from "./invoice-actions";
import { Button, Input, Select, Textarea } from "../../../components/ds";
import type { BillingDetails } from "../../../lib/invoices";

const STATE_CODES = Object.keys(GST_STATES).sort();

/**
 * #2749 part 4 — the company's saved GST billing details. Saved once per company and reused on
 * every invoice. A GSTIN requires the legal name and address.
 */
export function BillingDetailsForm({
  initial,
  open: initiallyOpen = false,
}: {
  initial: BillingDetails;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen || !initial.saved);
  const [stateCode, setStateCode] = useState(initial.state_code ?? "");
  const [gstin, setGstin] = useState(initial.gstin ?? "");
  const [legalName, setLegalName] = useState(initial.legal_name ?? "");
  const [address, setAddress] = useState(initial.address ?? "");
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const hasGstin = gstin.trim().length > 0;

  async function save(): Promise<void> {
    setBusy(true);
    const res = await saveBillingDetailsAction({
      stateCode,
      gstin: hasGstin ? gstin.trim() : null,
      legalName: hasGstin ? legalName.trim() : legalName.trim() || null,
      address: hasGstin ? address.trim() : address.trim() || null,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSaved(res.details);
    setError(null);
    setMessage("Billing details saved.");
    setOpen(false);
  }

  return (
    <section className="cred-panel">
      <div className="cred-panel__head">
        <div>
          <h2 className="cred-panel__title">Billing details</h2>
          <p className="cred-panel__sub">
            Saved once per company and used on every invoice. GST is charged by the place of supply.
          </p>
        </div>
        <button className="bb-btn bb-btn--ghost bb-btn--sm" type="button" onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : saved.saved ? "Edit" : "Add details"}
        </button>
      </div>
      <div className="cred-panel__body">
        {!open ? (
          <p className="cred-panel__sub">
            {saved.saved
              ? `${saved.state_code ? GST_STATES[saved.state_code] ?? saved.state_code : ""}${
                  saved.gstin ? ` · GSTIN ${saved.gstin}` : " · no GSTIN"
                }${saved.legal_name ? ` · ${saved.legal_name}` : ""}`
              : "No billing details saved yet."}
          </p>
        ) : (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Select
              label="State / UT"
              value={stateCode}
              onChange={(e) => setStateCode(e.target.value)}
            >
              <option value="">Choose…</option>
              {STATE_CODES.map((code) => (
                <option key={code} value={code}>
                  {code} — {GST_STATES[code]}
                </option>
              ))}
            </Select>
            <Input
              label="GSTIN (optional)"
              value={gstin}
              maxLength={15}
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
              hint="15 characters; its first two digits are the state code"
            />
            {hasGstin ? (
              <>
                <Input
                  label="Legal name"
                  value={legalName}
                  maxLength={200}
                  onChange={(e) => setLegalName(e.target.value)}
                />
                <Textarea
                  label="Billing address"
                  rows={3}
                  maxLength={500}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </>
            ) : null}
            <Button type="submit" disabled={busy || !stateCode} loading={busy}>
              {busy ? "Saving…" : "Save billing details"}
            </Button>
            {error ? <p className="applicant__error">{error}</p> : null}
            {message ? <p className="panel__sub" role="status">{message}</p> : null}
          </form>
        )}
      </div>
    </section>
  );
}
