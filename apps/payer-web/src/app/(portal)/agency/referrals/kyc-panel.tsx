"use client";

import { useState, useTransition } from "react";
import { agencyKycInputSchema, type AgencyKyc } from "../../../../lib/contracts";
import { maskLast4 } from "../../../../lib/masking";
import { Badge, Button, Input } from "../../../../components/ds";
import { submitKycAction } from "./supply-actions";

/**
 * AGENCY KYC panel (ADR-0022 Amendment 2, LIVE) — collect the agency's OWN payout KYC and
 * show its MASKED status. Runs in the BROWSER and sees NO secret.
 *
 * PII: the raw PAN / bank / IFSC are typed here and submitted to the server (write-only,
 * over the payer-authed seam) — they are NEVER read back. The status view shows ONLY the
 * masked last-4 the API returns (`••••234F`), the sibling of the masked-initials motif.
 * Client validation MIRRORS the backend DTO (the server re-validates + uppercases PAN/IFSC
 * and is the authority); it only gives inline UX before the round-trip.
 *
 * The form shows while status is `not_submitted` or `rejected` (resubmit); `pending` and
 * `verified` show a read-only masked status (green on verified). A neutral submit failure
 * (or a "not enabled" gated 404) surfaces in an aria-live region — never a fake success.
 */
export function KycPanel({ kyc }: { kyc: AgencyKyc }) {
  const [current, setCurrent] = useState<AgencyKyc>(kyc);
  const [form, setForm] = useState({ pan: "", bankAccount: "", ifsc: "", accountHolderName: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const status = current.status;
  const showForm = status === "not_submitted" || status === "rejected";

  function setField(key: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: "" }));
    if (submitError) setSubmitError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const parsed = agencyKycInputSchema.safeParse(form);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (key && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    startTransition(async () => {
      const res = await submitKycAction(parsed.data);
      if (res.ok) {
        setCurrent(res.kyc);
        setForm({ pan: "", bankAccount: "", ifsc: "", accountHolderName: "" });
      } else {
        setSubmitError(res.error);
      }
    });
  }

  return (
    // A bordered `.panel`: the body is a form + a masked status list, neither of which carries a
    // surface of its own, so the panel is what frames them.
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Payout details (KYC)</h2>
      </div>
      <div className="panel__body">
        {statusBanner(status, current.rejectReason ?? undefined)}

        {status !== "not_submitted" ? (
          <dl className="kv">
            <dt className="kv__k">PAN</dt>
            <dd className="kv__v bb-mono">{maskLast4(current.panLast4)}</dd>
            <dt className="kv__k">Bank account</dt>
            <dd className="kv__v bb-mono">{maskLast4(current.bankLast4)}</dd>
          </dl>
        ) : null}

        {/* A bare `.form` (no `.form__section`): four related fields under one heading are one
            group, and the panel's own h2 already names it — a legend here would repeat it.
            This note sits OUTSIDE the ternary on purpose: a branch must be a single
            expression, so a brace-comment placed as a sibling before the form element is
            parsed as an object literal and the file stops compiling. */}
        {showForm ? (
          <form className="form" onSubmit={handleSubmit} noValidate>
            <Input
              id="kyc-pan"
              label="PAN"
              value={form.pan}
              error={errors.pan || undefined}
              aria-invalid={errors.pan ? true : undefined}
              placeholder="ABCDE1234F"
              autoComplete="off"
              hint="Your agency's PAN. We store it encrypted and only ever show the last 4."
              onChange={(e) => setField("pan", e.target.value)}
            />
            <Input
              id="kyc-account-holder"
              label="Account holder name"
              value={form.accountHolderName}
              error={errors.accountHolderName || undefined}
              aria-invalid={errors.accountHolderName ? true : undefined}
              placeholder="As per bank records"
              autoComplete="off"
              onChange={(e) => setField("accountHolderName", e.target.value)}
            />
            <Input
              id="kyc-bank-account"
              label="Bank account number"
              value={form.bankAccount}
              error={errors.bankAccount || undefined}
              aria-invalid={errors.bankAccount ? true : undefined}
              placeholder="9–18 digits"
              inputMode="numeric"
              autoComplete="off"
              hint="Stored encrypted; only the last 4 are ever shown back."
              onChange={(e) => setField("bankAccount", e.target.value)}
            />
            <Input
              id="kyc-ifsc"
              label="IFSC"
              value={form.ifsc}
              error={errors.ifsc || undefined}
              aria-invalid={errors.ifsc ? true : undefined}
              placeholder="HDFC0001234"
              autoComplete="off"
              onChange={(e) => setField("ifsc", e.target.value)}
            />

            <div className="form-actions">
              <Button type="submit" disabled={pending} loading={pending}>
                {pending
                  ? "Submitting…"
                  : status === "rejected"
                    ? "Resubmit details"
                    : "Submit details"}
              </Button>
              <Badge tone="neutral" upper>
                Mock verification
              </Badge>
            </div>
            {/* `.form-status:empty` collapses, so an idle form carries no stray gap. */}
            <div aria-live="polite" className="form-status">
              {submitError ? (
                <div className="alert alert--danger">
                  <i className="ph ph-warning-circle alert__icon" aria-hidden="true" />
                  <div className="alert__text">
                    <p className="alert__title">We couldn&rsquo;t save your payout details</p>
                    <p className="alert__body">{submitError}</p>
                  </div>
                </div>
              ) : null}
            </div>
          </form>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The status headline — a green verified state, a review-pending note, or a reject reason.
 * A plain function (called inline, not a nested component) so it renders as part of the
 * parent tree.
 *
 * All four states are the SAME primitive (`.alert`) in four tones, replacing the previous
 * "flat Card + uppercase Badge + trailing sentence" pattern. The status word that used to be
 * the Badge is now the alert TITLE, so it is still the first thing read.
 */
function statusBanner(status: AgencyKyc["status"], rejectReason?: string) {
  if (status === "verified") {
    return (
      <div className="alert alert--success">
        <i className="ph ph-seal-check alert__icon" aria-hidden="true" />
        <div className="alert__text">
          <p className="alert__title">Verified</p>
          <p className="alert__body">
            Your payout details are verified. You can request payouts once you clear the
            threshold.
          </p>
        </div>
      </div>
    );
  }
  if (status === "pending") {
    return (
      <div className="alert alert--warning">
        <i className="ph ph-hourglass-medium alert__icon" aria-hidden="true" />
        <div className="alert__text">
          <p className="alert__title">Under review</p>
          <p className="alert__body">
            Your details are being reviewed. Payouts unlock once they&rsquo;re verified.
          </p>
        </div>
      </div>
    );
  }
  if (status === "rejected") {
    return (
      <div className="alert alert--danger">
        <i className="ph ph-warning-circle alert__icon" aria-hidden="true" />
        <div className="alert__text">
          <p className="alert__title">Rejected</p>
          <p className="alert__body">
            {rejectReason ? rejectReason : "Your details couldn't be verified. Please resubmit."}
          </p>
        </div>
      </div>
    );
  }
  // not_submitted
  return (
    <div className="alert alert--info">
      <i className="ph ph-info alert__icon" aria-hidden="true" />
      <div className="alert__text">
        <p className="alert__title">Add your payout details</p>
        <p className="alert__body">
          Add your payout details to receive referral earnings. We store them encrypted and
          only ever show the last 4 digits.
        </p>
      </div>
    </div>
  );
}
