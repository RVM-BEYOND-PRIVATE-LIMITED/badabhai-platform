"use client";

import { useState, useTransition } from "react";
import { agencyKycInputSchema, type AgencyKyc } from "../../../../lib/contracts";
import { maskLast4 } from "../../../../lib/masking";
import { Badge, Button, Card, Input } from "../../../../components/ds";
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
    <section className="agency-section">
      <h2 className="agency-section__title">Payout details (KYC)</h2>

      {statusBanner(status, current.rejectReason ?? undefined)}

      {status !== "not_submitted" ? (
        <dl className="agency-kyc__status">
          <dt>PAN</dt>
          <dd className="bb-mono">{maskLast4(current.panLast4)}</dd>
          <dt>Bank account</dt>
          <dd className="bb-mono">{maskLast4(current.bankLast4)}</dd>
        </dl>
      ) : null}

      {showForm ? (
        <form className="agency-invite__form" onSubmit={handleSubmit} noValidate>
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

          <div className="agency-invite__actions">
            <Button type="submit" disabled={pending} loading={pending}>
              {pending ? "Submitting…" : status === "rejected" ? "Resubmit details" : "Submit details"}
            </Button>
            <Badge tone="neutral" upper>
              Mock verification
            </Badge>
          </div>
          <div aria-live="polite" className="agency-invite__status">
            {submitError ? <p className="agency-invite__error">{submitError}</p> : null}
          </div>
        </form>
      ) : null}
    </section>
  );
}

/**
 * The status headline — a green verified state, a review-pending note, or a reject reason.
 * A plain function (called inline, not a nested component) so it renders as part of the
 * parent tree.
 */
function statusBanner(status: AgencyKyc["status"], rejectReason?: string) {
  if (status === "verified") {
    return (
      <Card variant="flat" className="agency-invite__note">
        <Badge tone="success" upper icon="seal-check">
          Verified
        </Badge>{" "}
        Your payout details are verified. You can request payouts once you clear the
        threshold.
      </Card>
    );
  }
  if (status === "pending") {
    return (
      <Card variant="flat" className="agency-invite__note">
        <Badge tone="warning" upper>
          Under review
        </Badge>{" "}
        Your details are being reviewed. Payouts unlock once they&rsquo;re verified.
      </Card>
    );
  }
  if (status === "rejected") {
    return (
      <Card variant="flat" className="agency-invite__note">
        <Badge tone="danger" upper>
          Rejected
        </Badge>{" "}
        {rejectReason ? rejectReason : "Your details couldn't be verified. Please resubmit."}
      </Card>
    );
  }
  // not_submitted
  return (
    <p className="agency-section__sub">
      Add your payout details to receive referral earnings. We store them encrypted and only
      ever show the last 4 digits.
    </p>
  );
}
